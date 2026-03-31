# Changelog

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
