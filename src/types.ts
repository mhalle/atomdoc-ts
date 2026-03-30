/**
 * Wire protocol types for the AtomDoc client.
 *
 * These types mirror the Python server's protocol exactly.
 * The "0" sentinel represents null/root in operation tuples.
 */

// ---------------------------------------------------------------------------
// Node store
// ---------------------------------------------------------------------------

/** A node as stored in the client-side flat map. */
export interface StoreNode {
  id: string;
  type: string;
  state: Record<string, unknown>;
  /** slot name → ordered child IDs */
  slots: Record<string, string[]>;
  parentId: string | null;
  slotName: string | null;
}

// ---------------------------------------------------------------------------
// Wire operations (match Python _types.py)
// ---------------------------------------------------------------------------

/** Insert: [0, [[id, type], ...], parentId|0, slotName, prevId|0, nextId|0] */
export type InsertOp = [
  0,
  [string, string][],
  string | 0,
  string,
  string | 0,
  string | 0,
];

/** Delete: [1, startId, endId|0] */
export type DeleteOp = [1, string, string | 0];

/** Move: [2, startId, endId|0, parentId|0, slotName, prevId|0, nextId|0] */
export type MoveOp = [
  2,
  string,
  string | 0,
  string | 0,
  string,
  string | 0,
  string | 0,
];

export type OrderedOp = InsertOp | DeleteOp | MoveOp;

export interface WireOperations {
  ordered: OrderedOp[];
  /** { nodeId: { field: jsonStringValue } } */
  state: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Protocol messages — server to client
// ---------------------------------------------------------------------------

export interface SchemaMsg {
  type: "schema";
  schema: AtomDocSchema;
}

export interface SnapshotMsg {
  type: "snapshot";
  doc_id: string;
  version: number;
  data: JsonDoc;
  client_id?: string;
}

export interface PatchMsg {
  type: "patch";
  version: number;
  operations: WireOperations;
  source_client: string;
}

export interface ErrorMsg {
  type: "error";
  ref?: string;
  code: string;
  message: string;
}

export type ServerMsg = SchemaMsg | SnapshotMsg | PatchMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// Protocol messages — client to server
// ---------------------------------------------------------------------------

export interface OpMsg {
  type: "op";
  ref?: string;
  operations: WireOperations;
}

export interface CreateMsg {
  type: "create";
  ref?: string;
  node_type: string;
  state: Record<string, unknown>;
  parent_id?: string;
  slot: string;
  position?: string;
  target_id?: string;
}

export interface UndoMsg {
  type: "undo";
  ref?: string;
  steps?: number;
}

export interface RedoMsg {
  type: "redo";
  ref?: string;
  steps?: number;
}

export type ClientMsg = OpMsg | CreateMsg | UndoMsg | RedoMsg;

// ---------------------------------------------------------------------------
// Schema types (from atomdoc_schema())
// ---------------------------------------------------------------------------

export interface NodeTypeDef {
  json_schema: Record<string, unknown>;
  field_tiers: Record<string, string>;
  slots: Record<string, { allowed_type: string | null }>;
  field_defaults: Record<string, unknown>;
}

export interface ValueTypeDef {
  json_schema: Record<string, unknown>;
  frozen: boolean;
}

export interface AtomDocSchema {
  version: number;
  root_type: string;
  node_types: Record<string, NodeTypeDef>;
  value_types: Record<string, ValueTypeDef>;
}

// ---------------------------------------------------------------------------
// Snapshot wire format
// ---------------------------------------------------------------------------

/** [id, type, {state}, {slotName: [children...]}?] */
export type JsonDoc = [
  string,
  string,
  Record<string, unknown>,
  Record<string, JsonDoc[]>?,
];
