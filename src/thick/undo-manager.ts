/**
 * Stack-based undo/redo manager — port of _undo.py.
 */

import type { WireOperations } from "../types.js";
import type { LocalDoc, ChangeEvent } from "./local-doc.js";

export class UndoManager {
  private doc: LocalDoc;
  private maxSteps: number;
  private undoStack: WireOperations[] = [];
  private redoStack: WireOperations[] = [];
  private txType: "update" | "undo" | "redo" = "update";
  private unsub: () => void;

  constructor(doc: LocalDoc, maxSteps = 100) {
    this.doc = doc;
    this.maxSteps = maxSteps;
    this.unsub = doc.onChange((event) => this._onChange(event));
  }

  private _onChange(event: ChangeEvent): void {
    if (this.txType === "update") {
      if (this.undoStack.length < this.maxSteps) {
        this.undoStack.push(event.inverseOperations);
      }
      this.redoStack.length = 0;
    } else if (this.txType === "undo") {
      this.redoStack.push(event.inverseOperations);
      this.txType = "update";
    } else if (this.txType === "redo") {
      this.undoStack.push(event.inverseOperations);
      this.txType = "update";
    }
  }

  undo(): void {
    this.txType = "undo";
    if (this.undoStack.length === 0) {
      this.txType = "update";
      return;
    }
    const ops = this.undoStack.pop()!;
    this.doc.applyOperations(ops);
  }

  redo(): void {
    this.txType = "redo";
    if (this.redoStack.length === 0) {
      this.txType = "update";
      return;
    }
    const ops = this.redoStack.pop()!;
    this.doc.applyOperations(ops);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  dispose(): void {
    this.unsub();
  }
}
