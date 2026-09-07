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
  /** Sent, not yet echoed or rejected; matched by `ref`. */
  private pendingOps: Array<{ ref: string; ops: WireOperations }> = [];
  private bufferedOps: WireOperations[] = [];
  private applyingRemote = false;
  private nextRef = 1;
  /** Online again, but the reconnect snapshot has not arrived yet. */
  private onlinePending = false;

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
      // One live socket at a time: a previous one (a failed attempt, a
      // connection being replaced) must not report on this client.
      const previous = this.ws;
      if (previous) {
        this._detachSocket(previous);
        previous.close();
        this._wentOffline();
      }
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.online = true;
        // Online callbacks wait for the reconnect snapshot, so they see
        // the resynced document rather than the stale one.
        this.onlinePending = this.doc !== null;
        resolve();
      };

      ws.onerror = (event) => {
        if (this.ws !== ws) return;
        reject(event);
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : event.data.toString(),
        ) as ServerMsg;
        this._handleMessage(msg);
      };

      ws.onclose = () => {
        // A late close from a socket that was already replaced says
        // nothing about the live connection.
        if (this.ws !== ws) return;
        this.ws = null;
        this._wentOffline();
      };
    });
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      this._detachSocket(ws);
      ws.close();
    }
    this._wentOffline();
  }

  private _detachSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onclose = null;
  }

  private _wentOffline(): void {
    const wasOnline = this.online;
    this.online = false;
    this.onlinePending = false;
    // Operations sent but not yet echoed may never have reached the
    // server: keep them, ahead of anything buffered since, so the
    // reconnect replays them in order.
    if (this.pendingOps.length > 0) {
      this.bufferedOps = [...this.pendingOps.map((p) => p.ops), ...this.bufferedOps];
      this.pendingOps = [];
    }
    if (wasOnline) {
      for (const cb of this.offlineCallbacks) cb();
    }
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
   * and undo history are rebuilt from the snapshot. Operations still in
   * flight are dropped: the server either applied them (they are in the
   * snapshot) or rejected them. UI that caches DocNode references must
   * re-read them.
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
        if (msg.ref) this._dropPending(msg.ref);
        for (const cb of this.errorCallbacks) cb(msg);
        break;
    }
  }

  /**
   * Forget pending operations up to and including `ref`; true if found.
   * Only a ref this client minted can match: refs carry the client's ID,
   * so another client's `ref` can never retire our pending work.
   */
  private _dropPending(ref: string): boolean {
    if (!ref.startsWith(this.clientId + ":")) return false;
    const idx = this.pendingOps.findIndex((p) => p.ref === ref);
    if (idx < 0) return false;
    this.pendingOps.splice(0, idx + 1);
    return true;
  }

  private _initDoc(snapshot: JsonDoc, version: number): void {
    if (!this.rawSchema) return;

    const isResync = this.doc !== null;

    // Clean up previous doc. Anything in flight was either acknowledged
    // (and is in the snapshot) or rejected (and is not): the server
    // answered every request it received before taking this snapshot.
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
    if (this.onlinePending) {
      this.onlinePending = false;
      for (const cb of this.onlineCallbacks) cb();
    }
  }

  private _handlePatch(msg: PatchMsg): void {
    this.version = msg.version;

    // A patch carrying one of our refs answers that request (and any
    // earlier one still pending: the server handles requests in order).
    const answersOurs = typeof msg.ref === "string" && this._dropPending(msg.ref);

    if (msg.source_client === this.clientId && answersOurs) {
      // Self-echo of an op we applied locally: just update version.
    } else {
      // Remote change — or our own op echoed after a resync dropped the
      // pending list (the snapshot predates it), or a commit the server
      // normalized, either of which must be applied.
      // Apply to local doc (flag to prevent re-sending, skipUndo so
      // another user's edits never enter local undo history)
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
      // Unique across clients: the server-assigned client ID plus a
      // counter. A ref is what ties a patch back to a pending op.
      const ref = `${this.clientId}:${this.nextRef++}`;
      this.pendingOps.push({ ref, ops });
      this._send({
        type: "op",
        ref,
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
