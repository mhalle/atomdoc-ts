/**
 * Reactive node store — a flat map of nodes with subscriptions.
 */

import type { JsonDoc, StoreNode } from "./types.js";

export class NodeStore {
  private nodes = new Map<string, StoreNode>();
  private rootId = "";
  private listeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<() => void>();
  private batching = false;
  private dirty = new Set<string>();
  private globalDirty = false;

  // --- Read ---

  getNode(id: string): StoreNode | undefined {
    return this.nodes.get(id);
  }

  getRootId(): string {
    return this.rootId;
  }

  getRoot(): StoreNode | undefined {
    return this.nodes.get(this.rootId);
  }

  getChildren(nodeId: string, slotName: string): string[] {
    const node = this.nodes.get(nodeId);
    if (!node) return [];
    return node.slots[slotName] ?? [];
  }

  getAllNodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  // --- Write (called by patch applier) ---

  _setNode(id: string, node: StoreNode): void {
    this.nodes.set(id, node);
    this._notify(id);
  }

  _removeNode(id: string): void {
    this.nodes.delete(id);
    this.listeners.delete(id);
    this._notify(id);
  }

  _updateState(id: string, field: string, value: unknown): void {
    const node = this.nodes.get(id);
    if (!node) return;
    // Replace with new object so reference equality detects the change
    this.nodes.set(id, {
      ...node,
      state: { ...node.state, [field]: value },
    });
    this._notify(id);
  }

  _setChildren(nodeId: string, slotName: string, childIds: string[]): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.set(nodeId, {
      ...node,
      slots: { ...node.slots, [slotName]: childIds },
    });
    this._notify(nodeId);
  }

  // --- Snapshot loading ---

  loadSnapshot(data: JsonDoc): void {
    this.batch(() => {
      this.nodes.clear();
      this.rootId = data[0];
      this._loadNode(data, null, null);
    });
  }

  private _loadNode(
    data: JsonDoc,
    parentId: string | null,
    slotName: string | null,
  ): void {
    const [id, type, state, slotsData] = data;
    const slots: Record<string, string[]> = {};

    if (slotsData) {
      for (const [name, children] of Object.entries(slotsData)) {
        slots[name] = children.map((child) => child[0]);
      }
    }

    this.nodes.set(id, {
      id,
      type,
      state: { ...state },
      slots,
      parentId,
      slotName,
    });

    if (slotsData) {
      for (const [name, children] of Object.entries(slotsData)) {
        for (const child of children) {
          this._loadNode(child, id, name);
        }
      }
    }
  }

  // --- Subscriptions ---

  subscribe(nodeId: string, callback: () => void): () => void {
    let set = this.listeners.get(nodeId);
    if (!set) {
      set = new Set();
      this.listeners.set(nodeId, set);
    }
    set.add(callback);
    return () => set!.delete(callback);
  }

  subscribeAll(callback: () => void): () => void {
    this.globalListeners.add(callback);
    return () => this.globalListeners.delete(callback);
  }

  // --- Batching ---

  batch(fn: () => void): void {
    if (this.batching) {
      fn();
      return;
    }
    this.batching = true;
    this.dirty.clear();
    this.globalDirty = false;
    try {
      fn();
    } finally {
      this.batching = false;
      this._flush();
    }
  }

  private _notify(nodeId: string): void {
    if (this.batching) {
      this.dirty.add(nodeId);
      this.globalDirty = true;
      return;
    }
    const set = this.listeners.get(nodeId);
    if (set) {
      for (const cb of set) cb();
    }
    for (const cb of this.globalListeners) cb();
  }

  private _flush(): void {
    for (const nodeId of this.dirty) {
      const set = this.listeners.get(nodeId);
      if (set) {
        for (const cb of set) cb();
      }
    }
    if (this.globalDirty) {
      for (const cb of this.globalListeners) cb();
    }
    this.dirty.clear();
    this.globalDirty = false;
  }
}
