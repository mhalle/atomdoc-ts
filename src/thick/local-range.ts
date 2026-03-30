/**
 * Range operations on the linked-list tree — port of _range.py.
 */

import type { DocNode } from "./doc-node.js";

/** Iterate siblings from start to end (inclusive). */
export function iterRange(start: DocNode, end: DocNode): DocNode[] {
  const result: DocNode[] = [];
  let current: DocNode | null = start;
  while (current !== null) {
    result.push(current);
    if (current === end) break;
    current = current.nextSibling;
  }
  return result;
}

/**
 * Detach a contiguous range of siblings from their parent.
 * Fixes the parent's slotFirst/slotLast and surrounding sibling pointers.
 */
export function detachRange(start: DocNode, end: DocNode): void {
  const parent = start.parent;
  const slotName = start.slotName;
  if (!parent || !slotName) return;

  const oldPrev = start.prevSibling;
  const oldNext = end.nextSibling;

  // Fix surrounding siblings
  if (oldPrev) {
    oldPrev.nextSibling = oldNext;
  } else {
    parent.slotFirst.set(slotName, oldNext);
  }

  if (oldNext) {
    oldNext.prevSibling = oldPrev;
  } else {
    parent.slotLast.set(slotName, oldPrev);
  }

  // Detach the range endpoints
  start.prevSibling = null;
  end.nextSibling = null;
}

/** Yield all descendants of a node (depth-first, excludes node). */
export function descendants(node: DocNode): DocNode[] {
  const result: DocNode[] = [];
  for (const slotName of node.slotOrder) {
    let child = node.slotFirst.get(slotName) ?? null;
    while (child !== null) {
      result.push(child);
      result.push(...descendants(child));
      child = child.nextSibling;
    }
  }
  return result;
}

/** Yield node and all its descendants (depth-first). */
export function descendantsInclusive(node: DocNode): DocNode[] {
  return [node, ...descendants(node)];
}
