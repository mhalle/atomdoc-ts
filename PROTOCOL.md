# AtomDoc Client Protocol Guide

This document describes everything needed to build an AtomDoc client in any language or framework. It covers the wire protocol, the client architecture, and the patterns that make it work.

## Overview

An AtomDoc client connects to a Python server over WebSocket. The server is authoritative — it holds the document, validates operations, and manages undo. The client renders the document and sends user edits as operations.

There are two client architectures:

- **Thin client** — sends operations to the server, waits for patches. Simple, ~500 lines.
- **Thick client** — applies operations locally first, syncs with server. Supports offline and local undo. ~1500 lines.

Both expose the same reactive store to the UI layer.

## Connection Lifecycle

```
1. Client opens WebSocket to server
2. Server sends: schema message
3. Server sends: snapshot message (includes client_id)
4. Client is ready — UI can render

5. On user edit: client sends op/create message
6. Server broadcasts: patch message to ALL clients
7. Thin client: applies patch to store → UI updates
   Thick client: skips self-echo, applies remote patches → UI updates

8. On disconnect: thick client buffers ops locally
9. On reconnect: server sends fresh schema + snapshot
```

## Wire Protocol

All messages are JSON objects with a `type` field.

### Server → Client

#### `schema`

Sent once on connect. Contains the full document schema.

```json
{
  "type": "schema",
  "schema": {
    "version": 1,
    "root_type": "Page",
    "node_types": {
      "Page": {
        "json_schema": {
          "type": "object",
          "properties": {
            "title": { "type": "string", "default": "" }
          }
        },
        "field_tiers": { "title": "mergeable" },
        "slots": {
          "annotations": { "allowed_type": "Annotation" }
        },
        "field_defaults": { "title": "" }
      },
      "Annotation": {
        "json_schema": {
          "type": "object",
          "properties": {
            "label": { "type": "string", "default": "" },
            "color": {
              "type": "object",
              "properties": {
                "r": { "type": "integer", "default": 0 },
                "g": { "type": "integer", "default": 0 },
                "b": { "type": "integer", "default": 0 }
              }
            }
          }
        },
        "field_tiers": { "label": "mergeable", "color": "atomic" },
        "slots": {},
        "field_defaults": { "label": "", "color": { "r": 0, "g": 0, "b": 0 } }
      }
    },
    "value_types": {
      "Color": {
        "json_schema": { "type": "object", "properties": { "r": {}, "g": {}, "b": {} } },
        "frozen": true
      }
    }
  }
}
```

**Schema fields:**

- `node_types` — each node type the document can contain
  - `json_schema` — JSON Schema for the node's state fields
  - `field_tiers` — how each field behaves in merges:
    - `"mergeable"` — independent fields, concurrent edits to different fields merge cleanly
    - `"atomic"` — frozen value, replaced as a unit (e.g., Color)
    - `"opaque"` — binary data (bytes), base64 encoded
  - `slots` — named ordered child collections, with allowed child type
  - `field_defaults` — default values for fields
- `value_types` — frozen compound types (like Color) that are replaced atomically
- `root_type` — the type name of the root node

#### `snapshot`

Sent once on connect, after schema. Contains the full document state.

```json
{
  "type": "snapshot",
  "doc_id": "01jqp00000000000000000000",
  "version": 5,
  "data": [
    "01jqp00000000000000000000",
    "Page",
    { "title": "Hello" },
    {
      "annotations": [
        ["ann-1", "Annotation", { "label": "First" }, {}],
        ["ann-2", "Annotation", { "label": "Second" }]
      ]
    }
  ],
  "client_id": "e99065b8-8503-4bae-a3f8-a47205a93cbb"
}
```

**Snapshot format (JsonDoc):** `[id, type, state, slots?]`

- `id` — unique node identifier (string)
- `type` — node type name
- `state` — field values (only non-default values included)
- `slots` — optional dict of `{ slot_name: [child, child, ...] }`, each child is another JsonDoc

The root node's `id` is also the document ID.

`client_id` is the server-assigned identifier for this connection. Used by thick clients to identify self-echoed patches.

#### `patch`

Sent after every committed transaction.

```json
{
  "type": "patch",
  "version": 6,
  "operations": {
    "ordered": [
      [0, [["ann-3", "Annotation"]], 0, "annotations", "ann-2", 0]
    ],
    "state": {
      "ann-3": { "label": "Third" }
    }
  },
  "source_client": "e99065b8-8503-4bae-a3f8-a47205a93cbb"
}
```

`version` is a monotonically increasing integer. `source_client` identifies which client initiated the change.

#### `error`

Sent to the client that caused an error.

```json
{
  "type": "error",
  "ref": "msg-123",
  "code": "invalid_op",
  "message": "Unknown node type: 'Bogus'"
}
```

### Client → Server

#### `op` — Apply operations

```json
{
  "type": "op",
  "ref": "msg-123",
  "operations": {
    "ordered": [],
    "state": { "node-id": { "title": "New Title", "color": { "r": 255, "g": 0, "b": 0 } } }
  }
}
```

#### `create` — Create a new node

```json
{
  "type": "create",
  "ref": "msg-124",
  "node_type": "Annotation",
  "state": { "label": "New", "color": { "r": 255, "g": 0, "b": 0 } },
  "parent_id": "root-id",
  "slot": "annotations",
  "position": "append",
  "target_id": null
}
```

`position` is one of: `"append"`, `"prepend"`, `"before"`, `"after"`. If `"before"` or `"after"`, `target_id` specifies the reference node.

The server assigns the node ID. The client learns it from the resulting patch.

#### `undo` / `redo`

```json
{ "type": "undo", "ref": "msg-125", "steps": 1 }
{ "type": "redo", "ref": "msg-126", "steps": 3 }
```

`steps` defaults to 1 if omitted.

**Note:** `ref` is optional on all client messages. If provided, it's echoed back in error responses for correlation.

## Operations Format

Operations have two parts: ordered tree operations and state patches.

```json
{
  "ordered": [ ... ],
  "state": { ... }
}
```

### Ordered Operations

Tree structure changes. Applied in order.

**Insert:** `[0, [[id, type], ...], parent_id, slot_name, prev_id, next_id]`

- `0` — operation type (insert)
- `[[id, type], ...]` — nodes to insert (ID + type name pairs)
- `parent_id` — parent node ID, or `0` for root
- `slot_name` — which slot to insert into
- `prev_id` — insert after this node, or `0`
- `next_id` — insert before this node, or `0`
- If both `prev_id` and `next_id` are `0`, append to end

**Delete:** `[1, start_id, end_id]`

- `1` — operation type (delete)
- `start_id` — first node in the contiguous range to delete
- `end_id` — last node in range, or `0` for single node

**Move:** `[2, start_id, end_id, parent_id, slot_name, prev_id, next_id]`

- `2` — operation type (move)
- Same positioning semantics as insert

### State Patches

Field value changes. Applied after ordered operations.

```json
{
  "node-id": {
    "label": "Third",
    "count": 42,
    "color": { "r": 255, "g": 0, "b": 0 }
  }
}
```

Values are **native JSON** — strings, numbers, booleans, arrays, objects, or `null`. Same encoding used by `snapshot` and `create` messages.

**Opaque fields** (tier `"opaque"`): the value is a JSON string containing base64-encoded bytes. The receiver decodes based on the field's schema tier (not on the shape of the value).

To apply: use the value as-is for mergeable/atomic fields; `base64` decode for opaque fields.

### The `0` Sentinel

The integer `0` is used as a null marker throughout operations:

- `parent_id = 0` → the root node
- `prev_id = 0` → no previous sibling (insert at start or append)
- `next_id = 0` → no next sibling (append)
- `end_id = 0` → single node (not a range)

## Building a Thin Client

A thin client needs five components:

### 1. Node Store

A flat map of nodes with subscriptions for reactivity.

```
NodeStore:
  nodes: Map<string, StoreNode>
  rootId: string

  getNode(id) → StoreNode | null
  getRoot() → StoreNode | null
  getChildren(nodeId, slotName) → string[]

  subscribe(nodeId, callback) → unsubscribe
  subscribeAll(callback) → unsubscribe
```

Each `StoreNode` is:

```
StoreNode:
  id: string
  type: string
  state: Map<string, any>       # field values
  slots: Map<string, string[]>  # slot name → ordered child IDs
  parentId: string | null
  slotName: string | null
```

**Critical:** When updating a node's state or slots, replace the StoreNode object with a new one (immutable update). UI frameworks detect changes via reference equality. Mutating in place will break reactivity.

```
# Wrong — mutates in place, framework won't detect change
node.state["title"] = "New"

# Right — replace with new object
nodes[id] = { ...node, state: { ...node.state, title: "New" } }
```

### 2. Snapshot Loader

Parse the `snapshot` message's `data` field (JsonDoc) into the store.

```
function loadSnapshot(data: JsonDoc):
  clear the store
  rootId = data[0]
  recursively walk data:
    for each [id, type, state, slots?]:
      create StoreNode with id, type, state
      set parentId and slotName from parent context
      if slots:
        for each slot_name, children:
          node.slots[slot_name] = [child IDs]
          recurse into children
      store.set(id, node)
```

### 3. Patch Applier

Apply a `WireOperations` object to the store.

```
function applyPatch(store, operations):
  batch notifications (defer until all changes applied):

    for each ordered op:
      if op[0] == 0:  # Insert
        create new StoreNodes for each [id, type] pair
        find parent node
        insert child IDs into parent's slot at the right position:
          if next_id: insert before next_id
          elif prev_id: insert after prev_id
          else: append

      if op[0] == 1:  # Delete
        find start and end nodes
        remove their IDs from parent's slot
        recursively remove nodes and all descendants from store

      if op[0] == 2:  # Move
        remove from old parent's slot
        update parentId/slotName on moved nodes
        insert into new parent's slot at position

    for each state patch { nodeId: { field: jsonStr } }:
      node = store.get(nodeId)
      node.state[field] = JSON.parse(jsonStr)
      replace node in store (new object)

  flush notifications
```

### 4. Message Handler

Connect to WebSocket, route messages.

```
on "schema":  store the schema for later use
on "snapshot": store client_id, load snapshot into store, fire "connected"
on "patch":   apply patch to store, update version
on "error":   fire error callbacks
```

### 5. Operation Senders

Functions that build and send client messages.

```
setField(nodeId, field, value):
  send { type: "op", operations: { ordered: [], state: { nodeId: { field: value } } } }

createNode(type, state, parentId, slot, position):
  send { type: "create", node_type: type, state, parent_id: parentId, slot, position }

deleteNode(nodeId):
  send { type: "op", operations: { ordered: [[1, nodeId, 0]], state: {} } }

moveNode(nodeId, parentId, slot, prevId, nextId):
  send { type: "op", operations: { ordered: [[2, nodeId, 0, parentId, slot, prevId ?? 0, nextId ?? 0]], state: {} } }

undo(steps):
  send { type: "undo", steps }

redo(steps):
  send { type: "redo", steps }
```

## Building a Thick Client

A thick client adds a local document model between the UI and the network. Operations apply instantly to the local doc, which feeds the store.

### Additional Components

#### 6. DocNode (Linked-List Tree Node)

The thick client needs a proper tree with O(1) insert/delete. Each node has:

```
DocNode:
  id: string
  type: string
  state: Map<string, any>
  parent: DocNode | null
  slotName: string | null
  prevSibling: DocNode | null
  nextSibling: DocNode | null
  slotFirst: Map<string, DocNode | null>   # first child per slot
  slotLast: Map<string, DocNode | null>    # last child per slot
  slotOrder: string[]                       # ordered slot names from schema
```

This is a doubly-linked sibling list per slot, with parent pointers.

#### 7. Local ID Generation

For creating nodes offline. Port of the Lamport timestamp system.

Format: `{sessionId}.{clock}`

- `sessionId` = base64(elapsed_ms_since_doc_creation) + random(3 chars)
- `clock` = monotonically incrementing base64 counter, starts at `"-"` (first char of alphabet)

Base64 alphabet (RFC 4648 §5, lexicographically sorted):
```
-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz
```

The document ID is a ULID. Extract its millisecond timestamp from the first 10 Crockford base32 characters.

#### 8. Operation Tracking

When the local doc mutates, record forward operations (for sending to server) and inverse operations (for undo).

**State tracking:**

```
onSetStateInverse(node, key):
  if node was inserted this transaction: skip
  if we already recorded this key's original: skip
  save current value as the inverse

onSetStateForward(node, key):
  record the new value
  if it reverted to the original: remove from forward ops
```

**Insert/delete/move tracking:**

Each tree mutation records:
- Forward op: the operation tuple (insert/delete/move)
- Inverse op: the reverse operation (delete→insert, insert→delete, move→move-back)

These accumulate in `forwardOps` and `inverseOps` accumulators during a transaction.

#### 9. Transactions

```
withTransaction(doc, fn):
  if doc is idle:
    set stage to "update"
    run fn()
    on success: forceCommit()
    on error: abort()
  if doc is already updating:
    just run fn() (join existing transaction)
```

`forceCommit()`:
1. Reverse the ordered inverse ops (they were built in reverse order)
2. Fire `onChange` listeners with `{ operations, inverseOperations, diff }`
3. Clear accumulators

`abort()`:
1. Apply the inverse operations to undo all changes
2. Clear accumulators

#### 10. UndoManager

```
UndoManager:
  undoStack: list of WireOperations
  redoStack: list of WireOperations
  txType: "update" | "undo" | "redo"

  on doc.onChange:
    if txType == "update": push inverseOps to undoStack, clear redoStack
    if txType == "undo": push inverseOps to redoStack
    if txType == "redo": push inverseOps to undoStack

  undo():
    txType = "undo"
    pop from undoStack
    doc.applyOperations(popped)
    # onChange fires, pushes to redoStack

  redo():
    txType = "redo"
    pop from redoStack
    doc.applyOperations(popped)
    # onChange fires, pushes to undoStack
```

#### 11. Store Bridge

Projects LocalDoc changes into the NodeStore:

```
bridgeDocToStore(doc, store):
  store.loadSnapshot(doc.toSnapshot())
  doc.onChange(event => applyPatch(store, event.operations))
```

Reuses the same `applyPatch` as the thin client.

#### 12. Self-Echo Handling

The server broadcasts patches to ALL clients, including the source. The thick client must not re-apply its own changes:

```
on patch message:
  if msg.source_client == my client_id:
    skip (already applied locally)
    update version
  else:
    doc.applyOperations(msg.operations)  # apply remote change
```

The `client_id` comes from the `snapshot` message.

#### 13. Remote Echo Guard

When applying a remote patch to the local doc, the `onChange` listener must NOT send it back to the server:

```
applyingRemote = false

doc.onChange(event => {
  if (!applyingRemote):
    sendToServer(event.operations)
})

on remote patch:
  applyingRemote = true
  doc.applyOperations(patch.operations)
  applyingRemote = false
```

## UI Framework Integration

The NodeStore is framework-agnostic. Each framework needs a thin adapter.

### Pattern: Version-Counter Hook

The recommended pattern for any framework:

1. Subscribe to the node ID in the store
2. When notified, increment a local version counter
3. Return an accessor/getter that reads the version (for reactivity) then reads the store

This avoids writing to reactive state during subscription setup, which causes loops in some frameworks.

### Solid.js

```ts
function useNode(store, nodeId) {
  const [ver, setVer] = createSignal(0);
  const unsub = store.subscribe(nodeId(), () => setVer(v => v + 1));
  onCleanup(() => unsub());
  return () => { ver(); return store.getNode(nodeId()); };
}
```

### React

```ts
function useNode(store, nodeId) {
  const ref = useRef(undefined);
  return useSyncExternalStore(
    (cb) => store.subscribe(nodeId, cb),
    () => {
      const node = store.getNode(nodeId);
      if (ref.current === node) return ref.current;
      ref.current = node;
      return node;
    },
  );
}
```

Note: `useSyncExternalStore` requires the snapshot to be referentially stable when unchanged. Cache the previous result in a ref.

### Vue

```ts
function useNode(store, nodeId) {
  const node = ref(store.getNode(nodeId));
  const unsub = store.subscribe(nodeId, () => {
    node.value = store.getNode(nodeId);
  });
  onUnmounted(() => unsub());
  return node;
}
```

### Svelte

```ts
function useNode(store, nodeId) {
  const node = writable(store.getNode(nodeId));
  const unsub = store.subscribe(nodeId, () => {
    node.set(store.getNode(nodeId));
  });
  onDestroy(() => unsub());
  return node;
}
```

### Qt (Python)

```python
class NodeProxy(QObject):
    changed = Signal(str)

    def __init__(self, store, node_id):
        super().__init__()
        self._store = store
        self._node_id = node_id
        store.subscribe(node_id, lambda: self.changed.emit(node_id))
```

### Terminal / CLI

No reactivity needed. Just read the store after each patch.

```python
client.on_patch(lambda v: render(client.get_store()))
```

### LLM

No UI at all. The LLM receives snapshots or patches as context, reasons about them, and emits operations.

```
System: Here is the document schema: { ... }
System: Here is the current document: { ... }
User: Add a red annotation labeled "Important"
LLM: { "type": "create", "node_type": "Annotation", "state": { "label": "Important", "color": { "r": 255, "g": 0, "b": 0 } }, "parent_id": "root-id", "slot": "annotations", "position": "append" }
```

## Key Patterns

### Immutable Store Updates

When the store updates a node, it must produce a **new object reference**. UI frameworks use reference equality to detect changes. If you mutate in place, the framework won't re-render.

```
# On state update:
oldNode = store.get(id)
newNode = clone(oldNode)
newNode.state[field] = value
store.set(id, newNode)
notify(id)
```

### Batch Notifications

When applying a patch with multiple operations, defer notifications until all changes are applied. Otherwise, intermediate states cause unnecessary re-renders and potential inconsistencies.

```
store.batch(() => {
  applyInsert(...)
  applyInsert(...)
  updateState(...)
})
# All subscribers fire once here
```

### Draft Pattern

For form-style editing where changes should commit atomically:

```
draft = { label: node.label, color: node.color }   # local copy
# User edits draft freely (no operations sent)
# On "Apply": send all draft fields as one op
# On "Reset": restore draft from current node state
```

This gives you:
- Smooth editing (no round-trips during slider drag)
- Atomic commit (one undo step for all field changes)
- Cancel support (reset discards uncommitted changes)

### Keyed Conditional Rendering

When showing a detail view for a selected item, use keyed/conditional rendering so the component remounts when the selection changes:

```
# Solid
<Show when={selected()} keyed>
  {(id) => <Inspector nodeId={id} />}
</Show>

# React
{selected && <Inspector key={selected} nodeId={selected} />}
```

Without keying, the framework may reuse the component instance with stale hook state.

## Building a Client in Another Language

The protocol is JSON over WebSocket. Any language with a WebSocket client and JSON parser can implement a thin client. Here's what you need:

1. **WebSocket client** — connect, send JSON, receive JSON
2. **JSON parser** — parse messages
3. **Node map** — `HashMap<String, Node>` or equivalent
4. **Snapshot parser** — recursive walk of nested arrays
5. **Patch applier** — handle insert/delete/move/state ops
6. **Operation builders** — construct JSON messages
7. **Reactivity adapter** — framework-specific subscription mechanism

Languages with existing WebSocket + JSON support (effectively all modern languages):

| Language | WebSocket | Reactivity |
|----------|-----------|------------|
| Python | `websockets` | Qt signals, Tkinter `after()`, asyncio callbacks |
| Rust | `tokio-tungstenite` | Channels, signals crate |
| Swift | `URLSessionWebSocketTask` | `@Observable`, Combine |
| Kotlin | `OkHttp` | `StateFlow`, Compose state |
| Dart | `web_socket_channel` | `ChangeNotifier`, streams |
| C# | `ClientWebSocket` | `INotifyPropertyChanged`, WPF bindings |
| Go | `gorilla/websocket` | Channels |

The thin client is ~500 lines in any of these. The thick client adds ~1000 lines for the tree model, transactions, and undo.

## Troubleshooting

### UI doesn't update after operations

- Check that the store produces **new object references** on mutation (not in-place mutation)
- Check that batch notifications flush at the end of patch application
- Check that the framework adapter correctly triggers re-renders on subscription callbacks

### Infinite loops / stack overflow

- Check for remote echo: thick clients must skip patches where `source_client` matches their own `client_id`
- Check for re-send: `doc.onChange` listener must NOT send operations that came from remote patches (use `applyingRemote` flag)
- Check that subscription callbacks don't trigger store writes that trigger more callbacks

### Undo doesn't work

- Check that `applyOperations` (for undo/redo) routes through tracked methods (insert/delete/move with forward/inverse recording), not raw tree manipulation
- Check that the UndoManager's `txType` flag correctly routes inverse ops to undo vs redo stack
- Check that inverse ordered operations are reversed at commit time (they're built in reverse order)

### Selection / inspector doesn't reflect current node

- Check that the detail view remounts when selection changes (keyed rendering)
- Check that draft state resets when the target node ID changes
