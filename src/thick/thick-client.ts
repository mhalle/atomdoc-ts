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
  maxUndoSteps?: number;
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
  private clientId: string = crypto.randomUUID();

  private bridgeUnsub: (() => void) | null = null;
  private docUnsub: (() => void) | null = null;
  private online = false;
  private pendingOps: WireOperations[] = [];
  private bufferedOps: WireOperations[] = [];
  private applyingRemote = false;

  private connectedCallbacks = new Set<() => void>();
  private errorCallbacks = new Set<(err: ErrorMsg) => void>();
  private patchCallbacks = new Set<(version: number) => void>();
  private offlineCallbacks = new Set<() => void>();
  private onlineCallbacks = new Set<() => void>();

  constructor(options: ThickClientOptions) {
    this.url = options.url;
    this.maxUndoSteps = options.maxUndoSteps ?? 100;
  }

  // --- Lifecycle ---

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        this.online = true;
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

    // Clean up previous doc
    if (this.bridgeUnsub) this.bridgeUnsub();
    if (this.docUnsub) this.docUnsub();
    if (this.undoMgr) this.undoMgr.dispose();

    this.version = version;
    this.doc = new LocalDoc(this.rawSchema, snapshot);
    this.undoMgr = new UndoManager(this.doc, this.maxUndoSteps);
    this.bridgeUnsub = bridgeDocToStore(this.doc, this.store);

    // Forward local changes to server (skip if we're applying a remote patch)
    this.docUnsub = this.doc.onChange((event) => {
      if (!this.applyingRemote) {
        this._sendOps(event.operations);
      }
    });

    for (const cb of this.connectedCallbacks) cb();
  }

  private _handlePatch(msg: PatchMsg): void {
    this.version = msg.version;

    if (msg.source_client === this.clientId) {
      // Self-echo: already applied locally, just update version
      this.pendingOps.shift();
    } else {
      // Remote change: apply to local doc (flag to prevent re-sending)
      if (this.doc) {
        this.applyingRemote = true;
        try {
          this.doc.applyOperations(msg.operations);
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
