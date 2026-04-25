# Changelog

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
