# Changelog

## 0.4.0

Thick-client parity with atomdoc (Python) 0.4.0, which ports the DocNode v0.4
undo and lifecycle improvements from DocuKit. No wire protocol changes; works
with atomdoc >= 0.3.0.

### Fixed

- **Remote patches polluted local undo.** `ThickAtomDocClient` applied patches
  from other clients through the same path as local edits, so undo could
  revert another user's change. Remote patches are now applied with
  `{ skipUndo: true }`.
- **Move replay lost position.** Applying a move operation (from undo/redo or
  a remote patch) ignored the recorded `prev`/`next` siblings and always
  appended to the target slot. Moves now land where they were recorded.
- **Undo stack eviction was inverted.** A full stack discarded the new entry
  instead of the oldest one.

### Added

- **Node ID sessions carry 5 random characters instead of 3**, matching
  atomdoc 0.4.0. Same-millisecond session collisions drop from 1 in
  262,144 to 1 in ~1.07 billion; IDs grow by two characters.
- **References.** Field type `"ref"` in `defineNode` (`target`, `many`),
  exported as tier `"ref"` plus a `refs` block, matching atomdoc 0.4.0's
  `Ref[T]`. `SchemaRegistry.getRefs()` / `getRef()`. `LocalDoc` keeps a
  reverse index (`referrers(nodeId, field?)`, rebuilt from the snapshot) and
  checks referential integrity at commit: references must resolve to a node
  of the declared type, and a referenced node cannot be deleted (policy
  `restrict`). Violations throw `RefIntegrityError` and roll the
  transaction back. Moving a node is not a delete.
- **Handles.** `defineHandle(name, strength)`; node types export a
  `handles` block and value types a `handle.strength`;
  `SchemaRegistry.getHandles()`; `LocalDoc.handles(strength?)` lists the
  document's dependencies without resolving them.
- **Tagged unions.** `SchemaRegistry` builds `z.union` for `anyOf` /
  `oneOf` properties (Python unions of frozen value types, Optionals).
- **Resync after rejection.** The server now answers a request that is
  invalid against the current document with error code `rejected` followed
  by a fresh `snapshot`. `ThickAtomDocClient` rebuilds the local doc, store,
  and undo history from any snapshot received after the first, drops pending
  ops, and fires `onResync`.
- **Transaction flags.** `ChangeEvent.flags` (`TransactionFlags`);
  `LocalDoc.applyOperations(ops, { skipUndo: true })` runs operations in a
  transaction the undo manager ignores (any open transaction is committed
  first).
- **Merge interval.** `new UndoManager(doc, maxSteps, { mergeInterval })` and
  `ThickClientOptions.mergeInterval` (ms) collapse consecutive local
  transactions into one undo step. Off by default.
- **Undo history transfer.** `undoManager.exportHistory()` /
  `importHistory()` move undo and redo state between documents with the same
  ID and root type — for example when a newer snapshot replaces the document.
- `LocalDoc.moveRangeRelative(startId, endId, targetId, "before" | "after")`
  and `ThickAtomDocClient.moveNodeRelative(nodeId, targetId, position)`.
- `mergeOperations(...ops)`, `UndoManager.clear()`, `UndoManager.isEnabled`
  (`maxSteps: 0` disables undo).

### Changed

- `LocalDoc.moveRange` is a no-op (no change event) when the range is
  already at the end of the target slot, and validates that the slot exists.

## 0.3.0

### Breaking Changes

- **Wire protocol**: state values in `op` and `patch` messages are now native
  JSON rather than JSON-stringified strings. `op`/`patch` now match the
  encoding already used by `snapshot` and `create`. Opaque/bytes fields
  continue to travel as base64-encoded JSON strings; receivers decode based
  on the field's schema tier. Requires atomdoc (Python) >= 0.3.0.
- `WireOperations.state` typed as `Record<string, Record<string, unknown>>`.
- Fixed move-op reactivity bug in `applyPatch`: the thin-client patch applier
  now creates a new node object when updating `parentId`/`slotName` during a
  move, instead of mutating in place. Reactive subscribers using reference
  equality will now detect the change.

### Migration

If you hand-build state patches in tests or tooling, drop the `JSON.stringify`
wrapping of values. Receivers that were calling `JSON.parse` on values can
remove the call.

## 0.2.0

### Breaking Changes

- Package renamed from `atomdoc-client` to `atomdoc-ts`. Update your imports accordingly.

### Added

- **Schema definition system:** `defineNode()`, `defineValue()`, and `buildSchema()` let you define document schemas directly in TypeScript. The output uses the same wire format as Python's `@node` decorator and `doc.atomdoc_schema()`, so schemas defined in TS are fully compatible with the Python server.
- **Thick client:** `ThickAtomDocClient` -- offline-capable client with local-first operations, local undo/redo, and automatic sync on reconnect.
  - `LocalDoc` -- linked-list tree model with O(1) insert/delete.
  - `DocNode` -- tree node with parent/sibling pointers.
  - Local operations with forward/inverse tracking for undo.
  - Local transactions with commit/abort.
  - `UndoManager` -- per-client undo/redo stack.
  - `bridgeDocToStore()` -- projects `LocalDoc` changes into `NodeStore`.
  - `createNodeIdFactory()` -- Lamport timestamp ID generation for offline node creation.
- **Full test suite:** 175+ tests covering thin client, thick client, schema definition, integration tests against the Python server, and schema compatibility tests between TS and Python.

### Existing (from 0.1.0)

- **Thin client:** `AtomDocClient` (WebSocket), `NodeStore`, `applyPatch`, operation constructors (`setField`, `deleteNode`, `moveNode`, `createNode`, `undo`, `redo`), `SchemaRegistry` (Zod validators), `Transaction`.

## 0.1.0

- Initial release as `atomdoc-client`.
- Thin client: `AtomDocClient`, `NodeStore`, `SchemaRegistry`, `Transaction`, patch applier, operation constructors.
