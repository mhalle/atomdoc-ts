/**
 * LocalDoc — client-side document model, port of _doc.py (simplified).
 *
 * No Pydantic validation, no normalize hooks, no strict mode.
 * Provides: tree structure, operations, inverse tracking, transactions.
 */

import type {
  AtomDocSchema,
  JsonDoc,
  WireOperations,
} from "../types.js";
import { createDocNode, type DocNode } from "./doc-node.js";
import {
  createOpsAccumulator,
  createDiff,
  onSetStateInverse,
  onSetStateForward,
  onInsertRange,
  onInsertRangeBefore,
  onDeleteRange,
  onMoveRange,
  applyOperations,
  type OpsAccumulator,
  type Diff,
} from "./local-ops.js";
import { iterRange, detachRange, descendantsInclusive } from "./local-range.js";
import { withTransaction, type LifecycleStage } from "./local-transaction.js";
import { createNodeIdFactory } from "./node-id.js";

export interface ChangeEvent {
  operations: WireOperations;
  inverseOperations: WireOperations;
  diff: Diff;
}

function opsToWire(acc: OpsAccumulator): WireOperations {
  return { ordered: acc.ordered, state: acc.state };
}

export class LocalDoc {
  readonly id: string;
  readonly root: DocNode;
  readonly nodeMap: Map<string, DocNode>;

  _lifecycleStage: LifecycleStage = "idle";
  _forwardOps: OpsAccumulator = createOpsAccumulator();
  _inverseOps: OpsAccumulator = createOpsAccumulator();
  _diff: Diff = createDiff();

  private schema: AtomDocSchema;
  private idGen: () => string;
  private changeListeners: Array<(e: ChangeEvent) => void> = [];

  constructor(schema: AtomDocSchema, snapshot: JsonDoc) {
    this.schema = schema;
    this.id = snapshot[0];
    this.nodeMap = new Map();
    this.idGen = createNodeIdFactory(this.id);

    // Build root
    const rootType = snapshot[1];
    this.root = this._createNodeFromJson(snapshot);
    this.nodeMap.set(this.root.id, this.root);

    // Recursively load children
    if (snapshot[3]) {
      this._loadSlots(this.root, snapshot[3]);
    }
  }

  // --- Read ---

  getNode(id: string): DocNode | undefined {
    return this.nodeMap.get(id);
  }

  // --- Node creation ---

  createNode(type: string, state?: Record<string, unknown>): DocNode {
    const id = this.idGen();
    const slotOrder = this._slotOrderFor(type);
    const node = createDocNode(id, type, slotOrder);
    if (state) {
      for (const [k, v] of Object.entries(state)) {
        node.state[k] = v;
      }
    }
    // Apply defaults from schema
    const defaults = this.schema.node_types[type]?.field_defaults;
    if (defaults) {
      for (const [k, v] of Object.entries(defaults)) {
        if (!(k in node.state)) {
          node.state[k] = structuredClone(v);
        }
      }
    }
    return node;
  }

  // --- Mutations (open transaction if idle) ---

  setNodeState(nodeId: string, key: string, value: unknown): void {
    const node = this.nodeMap.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    withTransaction(this, () => {
      const current = node.state[key];
      if (current === value || JSON.stringify(current) === JSON.stringify(value)) return;

      onSetStateInverse(this._diff, this._inverseOps, node, key);
      node.state[key] = value;
      onSetStateForward(this._diff, this._forwardOps, this._inverseOps, node, key);
    });
  }

  insertIntoSlot(
    parent: DocNode,
    slotName: string,
    position: string,
    nodes: DocNode[],
    target?: DocNode,
  ): void {
    if (nodes.length === 0) return;

    withTransaction(this, () => {
      // Handle position redirects
      if (position === "prepend") {
        const first = parent.slotFirst.get(slotName) ?? null;
        if (first) {
          this.insertIntoSlot(parent, slotName, "before", nodes, first);
        } else {
          this.insertIntoSlot(parent, slotName, "append", nodes);
        }
        return;
      }
      if (position === "after" && target) {
        const nxt = target.nextSibling;
        if (nxt) {
          this.insertIntoSlot(parent, slotName, "before", nodes, nxt);
        } else {
          this.insertIntoSlot(parent, slotName, "append", nodes);
        }
        return;
      }

      // Record ops
      if (position === "append") {
        if (this.nodeMap.has(parent.id)) {
          onInsertRange(
            this._diff, this._forwardOps, this._inverseOps,
            this.root, parent, slotName, "append", nodes,
          );
        }
      } else if (position === "before" && target) {
        onInsertRangeBefore(
          this._diff, this._forwardOps, this._inverseOps,
          this.root, target, slotName, nodes,
        );
      }

      // Perform tree linking
      if (position === "append") {
        let current = parent.slotLast.get(slotName) ?? null;
        for (const nd of nodes) {
          this._attachNode(nd, parent, slotName, current);
          if (current) {
            current.nextSibling = nd;
          } else {
            parent.slotFirst.set(slotName, nd);
          }
          current = nd;
        }
        parent.slotLast.set(slotName, current);
      } else if (position === "before" && target) {
        let currentTarget = target;
        for (let i = nodes.length - 1; i >= 0; i--) {
          const nd = nodes[i];
          const prevOfTarget = currentTarget.prevSibling;
          this._attachNode(nd, parent, slotName, prevOfTarget, currentTarget);
          if (prevOfTarget) {
            prevOfTarget.nextSibling = nd;
          }
          currentTarget.prevSibling = nd;
          currentTarget = nd;
        }
        if (parent.slotFirst.get(slotName) === target) {
          parent.slotFirst.set(slotName, nodes[0]);
        }
      }
    });
  }

  deleteRange(startId: string, endId?: string): void {
    const start = this.nodeMap.get(startId);
    if (!start) throw new Error(`Node not found: ${startId}`);
    const end = endId ? this.nodeMap.get(endId) : start;
    if (!end) throw new Error(`Node not found: ${endId}`);

    withTransaction(this, () => {
      onDeleteRange(
        this._diff, this._forwardOps, this._inverseOps,
        this.root, start, end,
      );

      // Remove from node map
      for (const node of iterRange(start, end)) {
        for (const desc of descendantsInclusive(node)) {
          this.nodeMap.delete(desc.id);
        }
      }
    });
  }

  moveRange(
    startId: string,
    endId: string | undefined,
    parentId: string,
    slotName: string,
  ): void {
    const start = this.nodeMap.get(startId);
    if (!start) throw new Error(`Node not found: ${startId}`);
    const end = endId ? this.nodeMap.get(endId) : start;
    if (!end) throw new Error(`Node not found: ${endId ?? startId}`);
    const newParent = parentId === "0" || !parentId ? this.root : this.nodeMap.get(parentId);
    if (!newParent) throw new Error(`Parent not found: ${parentId}`);

    withTransaction(this, () => {
      const newPrev = newParent.slotLast.get(slotName) ?? null;
      onMoveRange(
        this._diff, this._forwardOps, this._inverseOps,
        this.root, start, end, newParent, slotName, newPrev, null,
      );

      // Detach
      detachRange(start, end);

      // Re-insert (append)
      const movedNodes = iterRange(start, end);
      start.prevSibling = null;
      end.nextSibling = null;

      let current = newParent.slotLast.get(slotName) ?? null;
      for (const nd of movedNodes) {
        nd.parent = newParent;
        nd.slotName = slotName;
        nd.prevSibling = current;
        nd.nextSibling = null;
        if (current) {
          current.nextSibling = nd;
        } else {
          newParent.slotFirst.set(slotName, nd);
        }
        current = nd;
      }
      newParent.slotLast.set(slotName, current);
    });
  }

  // --- Apply remote/inverse operations ---

  applyOperations(ops: WireOperations): void {
    withTransaction(
      this,
      () => {
        // Apply ordered operations through tracked methods
        for (const op of ops.ordered) {
          try {
            if (op[0] === 0) {
              // Insert
              const nodePairs = op[1] as [string, string][];
              const parentIdRaw = op[2];
              const slotName = op[3] as string;
              const prevId = op[4];
              const nextId = op[5];

              const parent = parentIdRaw === 0
                ? this.root
                : this.nodeMap.get(String(parentIdRaw));
              if (!parent) continue;

              const nodes = nodePairs.map(([id, type]) => {
                const n = this.createNode(type);
                (n as { id: string }).id = id;
                this.nodeMap.set(id, n);
                return n;
              });

              if (prevId) {
                const prev = this.nodeMap.get(String(prevId));
                if (prev) {
                  this.insertIntoSlot(parent, slotName, "after", nodes, prev);
                  continue;
                }
              }
              if (nextId) {
                const next = this.nodeMap.get(String(nextId));
                if (next) {
                  this.insertIntoSlot(parent, slotName, "before", nodes, next);
                  continue;
                }
              }
              this.insertIntoSlot(parent, slotName, "append", nodes);

            } else if (op[0] === 1) {
              // Delete
              const startId = op[1] as string;
              const endIdRaw = op[2];
              const endId = endIdRaw === 0 ? undefined : String(endIdRaw);
              this.deleteRange(startId, endId);

            } else if (op[0] === 2) {
              // Move
              const startId = op[1] as string;
              const endIdRaw = op[2];
              const parentIdRaw = op[3];
              const slotName = op[4] as string;
              const endId = endIdRaw === 0 ? undefined : String(endIdRaw);
              const parentId = parentIdRaw === 0 ? "" : String(parentIdRaw);
              this.moveRange(startId, endId, parentId, slotName);
            }
          } catch {
            // Skip failed ops (conflict)
          }
        }

        // Apply state patches through tracking
        for (const [nodeId, patches] of Object.entries(ops.state)) {
          const node = this.nodeMap.get(nodeId);
          if (!node) continue;
          for (const [key, value] of Object.entries(patches)) {
            const isAttached = this.nodeMap.has(nodeId);
            if (isAttached) {
              onSetStateInverse(this._diff, this._inverseOps, node, key);
            }
            node.state[key] = value;
            if (isAttached) {
              onSetStateForward(this._diff, this._forwardOps, this._inverseOps, node, key);
            }
          }
        }
      },
      true, // isApplyOperations
    );
  }

  // --- Transaction lifecycle ---

  forceCommit(): void {
    if (this._lifecycleStage === "change") {
      throw new Error("Cannot trigger an update inside a change event");
    }

    this._inverseOps.ordered.reverse();
    this._lifecycleStage = "idle";

    // Fire listeners if there are changes
    const hasChanges =
      this._diff.inserted.size > 0 ||
      this._diff.deleted.size > 0 ||
      this._diff.moved.size > 0 ||
      Object.keys(this._forwardOps.state).length > 0;

    if (hasChanges) {
      this._lifecycleStage = "change";
      const event: ChangeEvent = {
        operations: opsToWire(this._forwardOps),
        inverseOperations: opsToWire(this._inverseOps),
        diff: this._diff,
      };
      for (const cb of [...this.changeListeners]) {
        cb(event);
      }
    }

    // Reset
    this._forwardOps = createOpsAccumulator();
    this._inverseOps = createOpsAccumulator();
    this._diff = createDiff();
    this._lifecycleStage = "idle";
  }

  abort(): void {
    const inverse: WireOperations = {
      ordered: [...this._inverseOps.ordered],
      state: { ...this._inverseOps.state },
    };
    applyOperations(
      this.nodeMap,
      this.root,
      inverse,
      (id, type) => {
        const node = this.createNode(type);
        (node as { id: string }).id = id;
        this.nodeMap.set(id, node);
        return node;
      },
      (parent, slot, position, nodes, target) => {
        this.insertIntoSlot(parent, slot, position, nodes, target);
      },
    );
    this._forwardOps = createOpsAccumulator();
    this._inverseOps = createOpsAccumulator();
    this._diff = createDiff();
    this._lifecycleStage = "idle";
  }

  // --- Events ---

  onChange(cb: (e: ChangeEvent) => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      const idx = this.changeListeners.indexOf(cb);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  // --- Serialization ---

  toSnapshot(): JsonDoc {
    return this._nodeToWire(this.root);
  }

  // --- Internal ---

  private _attachNode(
    node: DocNode,
    parent: DocNode,
    slotName: string,
    prev: DocNode | null = null,
    next: DocNode | null = null,
  ): void {
    node.parent = parent;
    node.slotName = slotName;
    node.prevSibling = prev;
    node.nextSibling = next;
    if (this.nodeMap.has(parent.id)) {
      for (const desc of descendantsInclusive(node)) {
        this.nodeMap.set(desc.id, desc);
      }
    }
  }

  private _slotOrderFor(type: string): string[] {
    const typeDef = this.schema.node_types[type];
    return typeDef ? Object.keys(typeDef.slots) : [];
  }

  private _createNodeFromJson(data: JsonDoc): DocNode {
    const [id, type, state] = data;
    const slotOrder = this._slotOrderFor(type);
    const node = createDocNode(id, type, slotOrder);
    for (const [k, v] of Object.entries(state)) {
      node.state[k] = v;
    }
    // Apply defaults
    const defaults = this.schema.node_types[type]?.field_defaults;
    if (defaults) {
      for (const [k, v] of Object.entries(defaults)) {
        if (!(k in node.state)) {
          node.state[k] = structuredClone(v);
        }
      }
    }
    return node;
  }

  private _loadSlots(
    parent: DocNode,
    slotsData: Record<string, JsonDoc[]>,
  ): void {
    for (const [slotName, children] of Object.entries(slotsData)) {
      if (!parent.slotFirst.has(slotName)) continue;

      let prev: DocNode | null = null;
      for (const childJson of children) {
        const child = this._createNodeFromJson(childJson);
        child.parent = parent;
        child.slotName = slotName;
        child.prevSibling = prev;
        if (prev) {
          prev.nextSibling = child;
        } else {
          parent.slotFirst.set(slotName, child);
        }
        this.nodeMap.set(child.id, child);
        prev = child;

        // Recurse
        if (childJson[3]) {
          this._loadSlots(child, childJson[3]);
        }
      }
      if (prev) {
        parent.slotLast.set(slotName, prev);
      }
    }
  }

  private _nodeToWire(node: DocNode): JsonDoc {
    const state: Record<string, unknown> = {};
    const defaults = this.schema.node_types[node.type]?.field_defaults ?? {};
    for (const [k, v] of Object.entries(node.state)) {
      if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
        state[k] = v;
      }
    }

    const result: JsonDoc = [node.id, node.type, state];

    if (node.slotOrder.length > 0) {
      const slots: Record<string, JsonDoc[]> = {};
      for (const slotName of node.slotOrder) {
        const children: JsonDoc[] = [];
        let child = node.slotFirst.get(slotName) ?? null;
        while (child !== null) {
          children.push(this._nodeToWire(child));
          child = child.nextSibling;
        }
        slots[slotName] = children;
      }
      result.push(slots);
    }

    return result;
  }
}
