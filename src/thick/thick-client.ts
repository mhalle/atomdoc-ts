/**
 * ThickAtomDocClient — local document model + WebSocket sync + offline buffer.
 *
 * Operations apply locally first for instant UI feedback. Forward ops
 * are sent to the server. Server echoes are skipped (already applied).
 * Remote patches from other clients are applied to the local doc.
 * Offline: ops buffer until reconnect, then rebased.
 */

import { SchemaRegistry } from "../schema.js";
import { NodeStore } from "../store.js";
import type {
  AtomDocSchema,
  ClientMsg,
  ErrorMsg,
  JsonDoc,
  PatchMsg,
  ServerMsg,
  WireOperations,
} from "../types.js";
import { LocalDoc, type ChangeEvent } from "./local-doc.js";
import { bridgeDocToStore } from "./store-bridge.js";
import { UndoManager } from "./undo-manager.js";

export interface ThickClientOptions {
  url: string;
  /** Undo steps to keep; 0 disables undo. Default 100. */
  maxUndoSteps?: number;
  /** Merge consecutive local transactions within this many ms into one undo step. Default 0. */
  mergeInterval?: number;
}

export class ThickAtomDocClient {
  private ws: WebSocket | null = null;
  private store = new NodeStore();
  private schema: SchemaRegistry | null = null;
  private rawSchema: AtomDocSchema | null = null;
  private doc: LocalDoc | null = null;
  private undoMgr: UndoManager | null = null;
  private version = 0;
  private url: string;
  private maxUndoSteps: number;
  private mergeInterval: number;
  private clientId: string = crypto.randomUUID();

  private bridgeUnsub: (() => void) | null = null;
  private docUnsub: (() => void) | null = null;
  private online = false;
  private pendingOps: WireOperations[] = [];
  private bufferedOps: WireOperations[] = [];
  private applyingRemote = false;

  private connectedCallbacks = new Set<() => void>();
  private resyncCallbacks = new Set<() => void>();
  private errorCallbacks = new Set<(err: ErrorMsg) => void>();
  private patchCallbacks = new Set<(version: number) => void>();
  private offlineCallbacks = new Set<() => void>();
  private onlineCallbacks = new Set<() => void>();

  constructor(options: ThickClientOptions) {
    this.url = options.url;
    this.maxUndoSteps = options.maxUndoSteps ?? 100;
    this.mergeInterval = options.mergeInterval ?? 0;
  }

  // --- Lifecycle ---

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        const wasOffline = !this.online && this.doc !== null;
        this.online = true;
        if (wasOffline) {
          for (const cb of this.onlineCallbacks) cb();
        }
        resolve();
      };

      ws.onerror = (event) => {
        reject(event);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : event.data.toString(),
        ) as ServerMsg;
        this._handleMessage(msg);
      };

      ws.onclose = () => {
        const wasOnline = this.online;
        this.online = false;
        this.ws = null;
        if (wasOnline) {
          for (const cb of this.offlineCallbacks) cb();
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.online = false;
  }

  // --- State access ---

  getStore(): NodeStore {
    return this.store;
  }

  getSchema(): SchemaRegistry | null {
    return this.schema;
  }

  getDoc(): LocalDoc | null {
    return this.doc;
  }

  getUndoManager(): UndoManager | null {
    return this.undoMgr;
  }

  getVersion(): number {
    return this.version;
  }

  isOnline(): boolean {
    return this.online;
  }

  // --- Mutations (local first, then send) ---

  setField(nodeId: string, field: string, value: unknown): void {
    if (!this.doc) throw new Error("Not connected");
    this.doc.setNodeState(nodeId, field, value);
  }

  createNode(
    type: string,
    state: Record<string, unknown>,
    parentId: string,
    slot: string,
    position: string = "append",
  ): string {
    if (!this.doc) throw new Error("Not connected");
    const node = this.doc.createNode(type, state);
    const parent = this.doc.getNode(parentId) ?? this.doc.root;
    this.doc.insertIntoSlot(parent, slot, position, [node]);
    return node.id;
  }

  deleteNode(nodeId: string): void {
    if (!this.doc) throw new Error("Not connected");
    this.doc.deleteRange(nodeId);
  }

  moveNode(
    nodeId: string,
    parentId: string,
    slot: string,
  ): void {
    if (!this.doc) throw new Error("Not connected");
    this.doc.moveRange(nodeId, undefined, parentId, slot);
  }

  /** Move a node so it sits immediately before or after sibling `targetId`. */
  moveNodeRelative(
    nodeId: string,
    targetId: string,
    position: "before" | "after",
  ): void {
    if (!this.doc) throw new Error("Not connected");
    this.doc.moveRangeRelative(nodeId, undefined, targetId, position);
  }

  undo(steps = 1): void {
    if (!this.undoMgr) return;
    for (let i = 0; i < steps; i++) {
      if (!this.undoMgr.canUndo) break;
      this.undoMgr.undo();
    }
  }

  redo(steps = 1): void {
    if (!this.undoMgr) return;
    for (let i = 0; i < steps; i++) {
      if (!this.undoMgr.canRedo) break;
      this.undoMgr.redo();
    }
  }

  // --- Events ---

  onConnected(cb: () => void): () => void {
    this.connectedCallbacks.add(cb);
    return () => this.connectedCallbacks.delete(cb);
  }

  onError(cb: (err: ErrorMsg) => void): () => void {
    this.errorCallbacks.add(cb);
    return () => this.errorCallbacks.delete(cb);
  }

  /**
   * Fires when the server replaces the local document with a fresh
   * snapshot after connecting — because it rejected one of this client's
   * operations (error code `rejected`) or on reconnect. The local doc, store,
   * and undo history are rebuilt from the snapshot; pending operations are
   * dropped. UI that caches DocNode references must re-read them.
   */
  onResync(cb: () => void): () => void {
    this.resyncCallbacks.add(cb);
    return () => this.resyncCallbacks.delete(cb);
  }

  onPatch(cb: (version: number) => void): () => void {
    this.patchCallbacks.add(cb);
    return () => this.patchCallbacks.delete(cb);
  }

  onOffline(cb: () => void): () => void {
    this.offlineCallbacks.add(cb);
    return () => this.offlineCallbacks.delete(cb);
  }

  onOnline(cb: () => void): () => void {
    this.onlineCallbacks.add(cb);
    return () => this.onlineCallbacks.delete(cb);
  }

  // --- Internal ---

  private _handleMessage(msg: ServerMsg): void {
    switch (msg.type) {
      case "schema":
        this.rawSchema = msg.schema;
        this.schema = new SchemaRegistry(msg.schema);
        break;

      case "snapshot":
        if (msg.client_id) this.clientId = msg.client_id;
        this._initDoc(msg.data, msg.version);
        break;

      case "patch":
        this._handlePatch(msg);
        break;

      case "error":
        for (const cb of this.errorCallbacks) cb(msg);
        break;
    }
  }

  private _initDoc(snapshot: JsonDoc, version: number): void {
    if (!this.rawSchema) return;

    const isResync = this.doc !== null;

    // Clean up previous doc. Anything in flight was either acknowledged
    // (and is in the snapshot) or rejected (and is not).
    if (this.bridgeUnsub) this.bridgeUnsub();
    if (this.docUnsub) this.docUnsub();
    if (this.undoMgr) this.undoMgr.dispose();
    this.pendingOps = [];
    this.applyingRemote = false;

    this.version = version;
    this.doc = new LocalDoc(this.rawSchema, snapshot);
    this.undoMgr = new UndoManager(this.doc, this.maxUndoSteps, {
      mergeInterval: this.mergeInterval,
    });
    this.bridgeUnsub = bridgeDocToStore(this.doc, this.store);

    // Forward local changes to server (skip if we're applying a remote patch)
    this.docUnsub = this.doc.onChange((event) => {
      if (!this.applyingRemote) {
        this._sendOps(event.operations);
      }
    });

    // Edits made while offline were applied to the old local doc and are
    // not in the snapshot: replay them as fresh local transactions, which
    // sends them. One the server rejects comes back as a resync.
    const replay = this.bufferedOps;
    this.bufferedOps = [];
    for (const ops of replay) {
      this.doc.applyOperations(ops);
    }

    for (const cb of this.connectedCallbacks) cb();
    if (isResync) {
      for (const cb of this.resyncCallbacks) cb();
    }
  }

  private _handlePatch(msg: PatchMsg): void {
    this.version = msg.version;

    if (msg.source_client === this.clientId && this.pendingOps.length > 0) {
      // Self-echo of an op we applied locally: just update version.
      this.pendingOps.shift();
    } else {
      // Remote change — or our own op echoed after a resync dropped the
      // pending list (the snapshot predates it), which must be applied.
      // Remote change: apply to local doc (flag to prevent re-sending,
      // skipUndo so another user's edits never enter local undo history)
      if (this.doc) {
        this.applyingRemote = true;
        try {
          this.doc.applyOperations(msg.operations, { skipUndo: true });
        } finally {
          this.applyingRemote = false;
        }
      }
    }

    for (const cb of this.patchCallbacks) cb(msg.version);
  }

  private _sendOps(ops: WireOperations): void {
    if (this.online && this.ws) {
      this.pendingOps.push(ops);
      this._send({
        type: "op",
        operations: ops,
      });
    } else {
      this.bufferedOps.push(ops);
    }
  }

  private _send(msg: ClientMsg): void {
    if (this.ws) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Handle a raw message object (for testing without WebSocket).
   * @internal
   */
  _injectMessage(msg: ServerMsg): void {
    this._handleMessage(msg);
  }
}
