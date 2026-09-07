/**
 * LocalDoc — client-side document model, port of _doc.py (simplified).
 *
 * No Pydantic validation, no normalize hooks, no strict mode.
 * Provides: tree structure, operations, inverse tracking, transactions.
 */

import type {
  AtomDocSchema,
  HandleDef,
  JsonDoc,
  RefDef,
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
  type OpsAccumulator,
  type Diff,
} from "./local-ops.js";
import { iterRange, detachRange, descendantsInclusive } from "./local-range.js";
import {
  withTransaction,
  type LifecycleStage,
  type TransactionFlags,
} from "./local-transaction.js";
import { createNodeIdFactory } from "./node-id.js";

export interface ChangeEvent {
  operations: WireOperations;
  inverseOperations: WireOperations;
  diff: Diff;
  /** Flags of the committed transaction (e.g. `skipUndo`). */
  flags: TransactionFlags;
}

function opsToWire(acc: OpsAccumulator): WireOperations {
  return { ordered: acc.ordered, state: acc.state };
}

/**
 * A reference does not resolve, has the wrong target type, or a referenced
 * node would be deleted. Thrown at commit; the transaction is rolled back.
 */
export class RefIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefIntegrityError";
  }
}

/** IDs held by a reference field value (a string or an array of strings). */
function refIds(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

const REF_SEP = "\u0000";

export class LocalDoc {
  readonly id: string;
  readonly root: DocNode;
  readonly nodeMap: Map<string, DocNode>;

  _lifecycleStage: LifecycleStage = "idle";
  _forwardOps: OpsAccumulator = createOpsAccumulator();
  _inverseOps: OpsAccumulator = createOpsAccumulator();
  _diff: Diff = createDiff();
  _transactionFlags: TransactionFlags = {};

  private schema: AtomDocSchema;
  private idGen: () => string;
  private changeListeners: Array<(e: ChangeEvent) => void> = [];
  /**
   * Reverse reference index: target id → set of `${referrerId}\0${field}`.
   * Derived state — never serialized, rebuilt from a snapshot.
   */
  private refIndex = new Map<string, Set<string>>();

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
    this._rebuildRefIndex();
  }

  // --- Read ---

  getNode(id: string): DocNode | undefined {
    return this.nodeMap.get(id);
  }

  // --- References ---

  /** Nodes holding a reference to `nodeId`, optionally only via `field`. */
  referrers(nodeId: string, field?: string): DocNode[] {
    const result: DocNode[] = [];
    const seen = new Set<string>();
    for (const entry of this.refIndex.get(nodeId) ?? []) {
      const [referrerId, fieldName] = entry.split(REF_SEP);
      if (field !== undefined && fieldName !== field) continue;
      if (seen.has(referrerId)) continue;
      const referrer = this.nodeMap.get(referrerId);
      if (referrer) {
        seen.add(referrerId);
        result.push(referrer);
      }
    }
    return result;
  }

  // --- Handles ---

  /**
   * Every handle held by the document. With `strength: "strong"` this is
   * the document's hard dependency list — what must resolve for it to be
   * usable. Nothing is fetched; values are read off the tree.
   */
  handles(strength?: "weak" | "strong"): Array<{
    node: DocNode;
    field: string;
    handle: Record<string, unknown>;
    strength: "weak" | "strong";
  }> {
    const result: Array<{
      node: DocNode;
      field: string;
      handle: Record<string, unknown>;
      strength: "weak" | "strong";
    }> = [];
    for (const node of this.nodeMap.values()) {
      const defs: Record<string, HandleDef> = this.schema.node_types[node.type]?.handles ?? {};
      for (const [field, def] of Object.entries(defs)) {
        if (strength !== undefined && def.strength !== strength) continue;
        const value = node.state[field];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          result.push({
            node,
            field,
            handle: value as Record<string, unknown>,
            strength: def.strength,
          });
        }
      }
    }
    return result;
  }

  private _refDefsFor(type: string): Record<string, RefDef> {
    return this.schema.node_types[type]?.refs ?? {};
  }

  private _refsAdd(node: DocNode): void {
    for (const field of Object.keys(this._refDefsFor(node.type))) {
      for (const targetId of refIds(node.state[field])) {
        this._refIndexAdd(targetId, node.id, field);
      }
    }
  }

  private _refsRemove(node: DocNode): void {
    for (const field of Object.keys(this._refDefsFor(node.type))) {
      for (const targetId of refIds(node.state[field])) {
        this._refIndexDiscard(targetId, node.id, field);
      }
    }
  }

  private _refsUpdate(node: DocNode, field: string, oldValue: unknown, newValue: unknown): void {
    const oldIds = refIds(oldValue);
    const newIds = refIds(newValue);
    for (const id of oldIds) {
      if (!newIds.includes(id)) this._refIndexDiscard(id, node.id, field);
    }
    for (const id of newIds) this._refIndexAdd(id, node.id, field);
  }

  private _refIndexAdd(targetId: string, referrerId: string, field: string): void {
    let set = this.refIndex.get(targetId);
    if (!set) {
      set = new Set();
      this.refIndex.set(targetId, set);
    }
    set.add(referrerId + REF_SEP + field);
  }

  private _refIndexDiscard(targetId: string, referrerId: string, field: string): void {
    const set = this.refIndex.get(targetId);
    if (!set) return;
    set.delete(referrerId + REF_SEP + field);
    if (set.size === 0) this.refIndex.delete(targetId);
  }

  private _rebuildRefIndex(): void {
    this.refIndex.clear();
    for (const node of this.nodeMap.values()) this._refsAdd(node);
  }

  /**
   * Commit-time referential integrity: every reference written by an
   * inserted or updated node must resolve to a node of the declared type,
   * and no deleted node may still be referenced by a live one (policy
   * "restrict").
   */
  private _checkRefIntegrity(): void {
    const diff = this._diff;
    for (const nodeId of [...diff.inserted, ...diff.updated]) {
      const node = this.nodeMap.get(nodeId);
      if (!node) continue;
      for (const [field, rdef] of Object.entries(this._refDefsFor(node.type))) {
        for (const targetId of refIds(node.state[field])) {
          const target = this.nodeMap.get(targetId);
          if (!target) {
            throw new RefIntegrityError(
              `${node.type}.${field} on node '${nodeId}' references '${targetId}', which is not in the document`,
            );
          }
          if (rdef.target_type !== null && target.type !== rdef.target_type) {
            throw new RefIntegrityError(
              `${node.type}.${field} on node '${nodeId}' references ${target.type} '${targetId}', expected ${rdef.target_type}`,
            );
          }
        }
      }
    }
    for (const deletedId of diff.deleted.keys()) {
      for (const entry of this.refIndex.get(deletedId) ?? []) {
        const [referrerId, field] = entry.split(REF_SEP);
        const referrer = this.nodeMap.get(referrerId);
        if (referrer) {
          throw new RefIntegrityError(
            `Cannot delete node '${deletedId}': still referenced by ${referrer.type}.${field} on node '${referrerId}'`,
          );
        }
      }
    }
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
      if (key in this._refDefsFor(node.type)) {
        this._refsUpdate(node, key, current, value);
      }
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
      // A node (or ID) may enter the document once: the same node twice in
      // one batch would link it to itself, an existing ID would shadow a
      // live node.
      const seen = new Set<string>();
      for (const top of nodes) {
        for (const desc of descendantsInclusive(top)) {
          if (this.nodeMap.has(desc.id) || seen.has(desc.id)) {
            throw new Error(`Node '${desc.id}' already exists in the document`);
          }
          seen.add(desc.id);
        }
      }

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

      // Remove from node map and drop the deleted nodes' own references
      for (const node of iterRange(start, end)) {
        for (const desc of descendantsInclusive(node)) {
          this.nodeMap.delete(desc.id);
          this._refsRemove(desc);
        }
      }
    });
  }

  /** Move a range to the end of `slotName` on `parentId` ("0" or "" = root). */
  moveRange(
    startId: string,
    endId: string | undefined,
    parentId: string,
    slotName: string,
  ): void {
    const { start, end } = this._resolveRange(startId, endId);
    const newParent = parentId === "0" || !parentId ? this.root : this.nodeMap.get(parentId);
    if (!newParent) throw new Error(`Parent not found: ${parentId}`);
    if (!newParent.slotFirst.has(slotName)) {
      throw new Error(`Slot '${slotName}' does not exist on ${newParent.type}`);
    }

    withTransaction(this, () => {
      const newPrev = newParent.slotLast.get(slotName) ?? null;
      if (newPrev === end) return; // already there
      this._moveRange(start, end, newParent, slotName, newPrev, null);
    });
  }

  /** Move a range so it sits immediately before or after sibling `targetId`. */
  moveRangeRelative(
    startId: string,
    endId: string | undefined,
    targetId: string,
    position: "before" | "after",
  ): void {
    const { start, end } = this._resolveRange(startId, endId);
    const target = this.nodeMap.get(targetId);
    if (!target) throw new Error(`Node not found: ${targetId}`);
    const newParent = target.parent;
    const slotName = target.slotName;
    if (!newParent || !slotName) {
      throw new Error("Cannot move before or after the root");
    }

    withTransaction(this, () => {
      if (iterRange(start, end).includes(target)) {
        throw new Error("Target is in the range");
      }
      if (position === "before") {
        if (target.prevSibling === end) return;
        this._moveRange(start, end, newParent, slotName, target.prevSibling, target);
      } else {
        if (target.nextSibling === start) return;
        this._moveRange(start, end, newParent, slotName, target, target.nextSibling);
      }
    });
  }

  private _resolveRange(startId: string, endId: string | undefined) {
    const start = this.nodeMap.get(startId);
    if (!start) throw new Error(`Node not found: ${startId}`);
    const end = endId ? this.nodeMap.get(endId) : start;
    if (!end) throw new Error(`Node not found: ${endId ?? startId}`);
    return { start, end };
  }

  private _moveRange(
    start: DocNode,
    end: DocNode,
    newParent: DocNode,
    slotName: string,
    newPrev: DocNode | null,
    newNext: DocNode | null,
  ): void {
    const range = iterRange(start, end);
    if (range.includes(newParent)) throw new Error("Target is in the range");
    for (let anc = newParent.parent; anc; anc = anc.parent) {
      if (range.includes(anc)) throw new Error("Target is descendant of the range");
    }

    onMoveRange(
      this._diff, this._forwardOps, this._inverseOps,
      this.root, start, end, newParent, slotName, newPrev, newNext,
    );

    detachRange(start, end);

    start.prevSibling = newPrev;
    if (newPrev) {
      newPrev.nextSibling = start;
    } else {
      newParent.slotFirst.set(slotName, start);
    }
    end.nextSibling = newNext;
    if (newNext) {
      newNext.prevSibling = end;
    } else {
      newParent.slotLast.set(slotName, end);
    }
    for (const nd of range) {
      nd.parent = newParent;
      nd.slotName = slotName;
    }
  }

  // --- Apply remote/inverse operations ---

  /**
   * Apply operations (remote patches or inverse ops). With
   * `flags.skipUndo` the operations run in their own transaction that the
   * undo manager ignores; any open transaction is committed first.
   */
  applyOperations(ops: WireOperations, flags?: TransactionFlags): void {
    withTransaction(this, () => this._applyOps(ops), true, flags);
    if (flags?.skipUndo && this._lifecycleStage === "update") {
      this.forceCommit();
    }
  }

  /**
   * Apply operations through the tracked mutators, inside whatever
   * transaction is open. An operation whose target is missing is skipped
   * (best effort: undo and rollback may legitimately meet a node that is
   * gone). Shared by `applyOperations` and `abort`, so the reverse
   * reference index is maintained on every path.
   */
  private _applyOps(ops: WireOperations): void {
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
          if (!this.nodeMap.has(startId)) continue;
          this.deleteRange(startId, endId);

        } else if (op[0] === 2) {
          // Move
          const startId = op[1] as string;
          const endIdRaw = op[2];
          const parentIdRaw = op[3];
          const slotName = op[4] as string;
          const prevIdRaw = op[5];
          const nextIdRaw = op[6];
          const endId = endIdRaw === 0 ? undefined : String(endIdRaw);
          const parentId = parentIdRaw === 0 ? "" : String(parentIdRaw);
          if (!this.nodeMap.has(startId)) continue;
          if (prevIdRaw && this.nodeMap.has(String(prevIdRaw))) {
            this.moveRangeRelative(startId, endId, String(prevIdRaw), "after");
          } else if (nextIdRaw && this.nodeMap.has(String(nextIdRaw))) {
            this.moveRangeRelative(startId, endId, String(nextIdRaw), "before");
          } else {
            this.moveRange(startId, endId, parentId, slotName);
          }
        }
      } catch {
        // Skip failed ops (conflict)
      }
    }

    // Apply state patches through tracking
    for (const [nodeId, patches] of Object.entries(ops.state)) {
      const node = this.nodeMap.get(nodeId);
      if (!node) continue;
      const defaults = this.schema.node_types[node.type]?.field_defaults ?? {};
      for (const [key, value] of Object.entries(patches)) {
        onSetStateInverse(this._diff, this._inverseOps, node, key);
        const oldValue = node.state[key];
        if (value === null && !(key in defaults)) {
          // null for a field without a default means "unset" (that is how
          // an unset field serializes), so restore it to unset.
          delete node.state[key];
        } else {
          node.state[key] = value;
        }
        onSetStateForward(this._diff, this._forwardOps, this._inverseOps, node, key);
        if (key in this._refDefsFor(node.type)) {
          this._refsUpdate(node, key, oldValue, value);
        }
      }
    }
  }

  // --- Transaction lifecycle ---

  forceCommit(): void {
    if (this._lifecycleStage === "change") {
      throw new Error("Cannot trigger an update inside a change event");
    }

    this._lifecycleStage = "idle";

    // Fire listeners if there are changes
    const hasChanges =
      this._diff.inserted.size > 0 ||
      this._diff.deleted.size > 0 ||
      this._diff.moved.size > 0 ||
      Object.keys(this._forwardOps.state).length > 0;

    if (hasChanges) {
      // Referential integrity is a document-level check; a failure reopens
      // the transaction so the caller (withTransaction) can roll it back.
      try {
        this._checkRefIntegrity();
      } catch (e) {
        this._lifecycleStage = "update";
        throw e;
      }

      this._lifecycleStage = "change";
      // Inverse ops are recorded in forward order; hand them out in
      // application order.
      const event: ChangeEvent = {
        operations: opsToWire(this._forwardOps),
        inverseOperations: {
          ordered: [...this._inverseOps.ordered].reverse(),
          state: this._inverseOps.state,
        },
        diff: this._diff,
        flags: this._transactionFlags,
      };
      try {
        for (const cb of [...this.changeListeners]) {
          cb(event);
        }
      } finally {
        this._reset();
      }
      return;
    }

    this._reset();
  }

  private _reset(): void {
    this._forwardOps = createOpsAccumulator();
    this._inverseOps = createOpsAccumulator();
    this._diff = createDiff();
    this._transactionFlags = {};
    this._lifecycleStage = "idle";
  }

  abort(): void {
    // Inverse ops are recorded in forward order; roll back in reverse,
    // through the tracked mutators so the reverse reference index follows.
    const inverse: WireOperations = {
      ordered: [...this._inverseOps.ordered].reverse(),
      state: { ...this._inverseOps.state },
    };
    try {
      this._applyOps(inverse);
    } finally {
      // Whatever happens, the document must not stay in the update stage.
      this._reset();
      this._rebuildRefIndex();
    }
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
        this._refsAdd(desc);
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
