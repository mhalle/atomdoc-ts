/**
 * Patch applier — updates the NodeStore from wire operations.
 */

import type { NodeStore } from "./store.js";
import type { WireOperations } from "./types.js";

export function applyPatch(
  store: NodeStore,
  operations: WireOperations,
): void {
  store.batch(() => {
    // Apply ordered operations first
    for (const op of operations.ordered) {
      switch (op[0]) {
        case 0:
          applyInsert(store, op);
          break;
        case 1:
          applyDelete(store, op);
          break;
        case 2:
          applyMove(store, op);
          break;
      }
    }

    // Apply state patches (values are native JSON — no parsing needed)
    for (const [nodeId, patches] of Object.entries(operations.state)) {
      for (const [field, value] of Object.entries(patches)) {
        store._updateState(nodeId, field, value);
      }
    }
  });
}

function resolveId(id: string | 0): string | null {
  return id === 0 ? null : id;
}

function applyInsert(
  store: NodeStore,
  op: [0, [string, string][], string | 0, string, string | 0, string | 0],
): void {
  const [, nodePairs, parentIdRaw, slotName, prevIdRaw, nextIdRaw] = op;
  const parentId = resolveId(parentIdRaw) ?? store.getRootId();
  const prevId = resolveId(prevIdRaw);
  const nextId = resolveId(nextIdRaw);

  const parent = store.getNode(parentId);
  if (!parent) return;

  // Create new nodes
  const newIds: string[] = [];
  for (const [id, type] of nodePairs) {
    if (!store.getNode(id)) {
      store._setNode(id, {
        id,
        type,
        state: {},
        slots: {},
        parentId,
        slotName,
      });
    }
    newIds.push(id);
  }

  // Insert into parent's slot at the right position
  const children = [...(parent.slots[slotName] ?? [])];

  if (nextId) {
    const idx = children.indexOf(nextId);
    if (idx >= 0) {
      children.splice(idx, 0, ...newIds);
    } else {
      children.push(...newIds);
    }
  } else if (prevId) {
    const idx = children.indexOf(prevId);
    if (idx >= 0) {
      children.splice(idx + 1, 0, ...newIds);
    } else {
      children.push(...newIds);
    }
  } else {
    children.push(...newIds);
  }

  store._setChildren(parentId, slotName, children);
}

function applyDelete(
  store: NodeStore,
  op: [1, string, string | 0],
): void {
  const [, startId, endIdRaw] = op;
  const endId = resolveId(endIdRaw) ?? startId;

  const startNode = store.getNode(startId);
  if (!startNode || !startNode.parentId || !startNode.slotName) return;

  const parentId = startNode.parentId;
  const slotName = startNode.slotName;
  const children = store.getChildren(parentId, slotName);

  // Find the range of IDs to delete
  const startIdx = children.indexOf(startId);
  const endIdx = children.indexOf(endId);
  if (startIdx < 0 || endIdx < 0) return;

  const toRemove = children.slice(startIdx, endIdx + 1);
  const remaining = [
    ...children.slice(0, startIdx),
    ...children.slice(endIdx + 1),
  ];

  store._setChildren(parentId, slotName, remaining);

  // Remove nodes and their descendants
  for (const id of toRemove) {
    removeRecursive(store, id);
  }
}

function removeRecursive(store: NodeStore, nodeId: string): void {
  const node = store.getNode(nodeId);
  if (!node) return;
  for (const childIds of Object.values(node.slots)) {
    for (const childId of childIds) {
      removeRecursive(store, childId);
    }
  }
  store._removeNode(nodeId);
}

function applyMove(
  store: NodeStore,
  op: [
    2,
    string,
    string | 0,
    string | 0,
    string,
    string | 0,
    string | 0,
  ],
): void {
  const [, startId, endIdRaw, newParentIdRaw, slotName, prevIdRaw, nextIdRaw] =
    op;
  const endId = resolveId(endIdRaw) ?? startId;
  const newParentId = resolveId(newParentIdRaw) ?? store.getRootId();
  const prevId = resolveId(prevIdRaw);
  const nextId = resolveId(nextIdRaw);

  const startNode = store.getNode(startId);
  if (!startNode || !startNode.parentId || !startNode.slotName) return;

  // Remove from old parent
  const oldParentId = startNode.parentId;
  const oldSlot = startNode.slotName;
  const oldChildren = store.getChildren(oldParentId, oldSlot);
  const startIdx = oldChildren.indexOf(startId);
  const endIdx = oldChildren.indexOf(endId);
  if (startIdx < 0 || endIdx < 0) return;

  const movedIds = oldChildren.slice(startIdx, endIdx + 1);
  const remaining = [
    ...oldChildren.slice(0, startIdx),
    ...oldChildren.slice(endIdx + 1),
  ];
  store._setChildren(oldParentId, oldSlot, remaining);

  // Update parent/slot on moved nodes (immutable update so reactive
  // subscribers see a new object reference — see NodeStore contract).
  for (const id of movedIds) {
    const node = store.getNode(id);
    if (node) {
      store._setNode(id, { ...node, parentId: newParentId, slotName });
    }
  }

  // Insert into new parent
  const newChildren = [...store.getChildren(newParentId, slotName)];
  if (nextId) {
    const idx = newChildren.indexOf(nextId);
    if (idx >= 0) {
      newChildren.splice(idx, 0, ...movedIds);
    } else {
      newChildren.push(...movedIds);
    }
  } else if (prevId) {
    const idx = newChildren.indexOf(prevId);
    if (idx >= 0) {
      newChildren.splice(idx + 1, 0, ...movedIds);
    } else {
      newChildren.push(...movedIds);
    }
  } else {
    newChildren.push(...movedIds);
  }

  store._setChildren(newParentId, slotName, newChildren);
}
