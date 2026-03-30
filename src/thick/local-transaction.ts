/**
 * Transaction lifecycle for LocalDoc — port of _transaction.py (simplified).
 *
 * No normalize or strict mode stages.
 */

import type { LocalDoc } from "./local-doc.js";

export type LifecycleStage = "idle" | "update" | "change";

export function withTransaction(
  doc: LocalDoc,
  fn: () => void,
  isApplyOperations = false,
): void {
  const stage = doc._lifecycleStage;

  if (stage === "change") {
    throw new Error("Cannot trigger an update during the 'change' stage");
  }

  const isNewTx = stage === "idle";
  if (isNewTx) {
    doc._lifecycleStage = "update";
  }

  try {
    fn();
  } catch (e) {
    try {
      doc.abort();
    } catch {
      // Abort failed, suppress
    }
    if (!isApplyOperations) throw e;
    return;
  }

  if (isNewTx) {
    try {
      doc.forceCommit();
    } catch (e) {
      try {
        doc.abort();
      } catch {
        // Abort failed, suppress
      }
      if (!isApplyOperations) throw e;
    }
  }
}
