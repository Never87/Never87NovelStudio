import type { InsertAnchor } from '@/services';

/**
 * How many characters of preceding context are stored to validate an anchor.
 *
 * Kept in sync with `ANCHOR_CONTEXT_CHARS` in the assistance service (the value
 * is re-exported from `@/services`); importing the constant keeps them equal.
 */
import { ANCHOR_CONTEXT_CHARS } from '@/services';

/** The minimal slice of a ProseMirror document this module needs. */
export interface AnchorDoc {
  content: { size: number };
  textContent: string;
  /** Text between two document positions, joining block boundaries with `blockSep`. */
  textBetween: (from: number, to: number, blockSep: string, leafText: string) => string;
}

/** Captures the deterministic insertion anchor for the current position. */
export function captureInsertAnchor(doc: AnchorDoc, pos: number): InsertAnchor {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const from = Math.max(0, clamped - ANCHOR_CONTEXT_CHARS);
  return {
    pos: clamped,
    docSize: doc.content.size,
    contextBefore: doc.textBetween(from, clamped, '\n', '\n'),
  };
}

export type AnchorValidation = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether applying at `anchor` is still safe for the CURRENT document.
 *
 * A continuation is generated against a snapshot. Inserting it at a stale
 * offset after the document changed would insert text in a place the user did
 * not preview. So we refuse unless BOTH hold:
 *   1. the document size is unchanged (nothing added/removed anywhere), and
 *   2. the text immediately before the anchor is unchanged.
 *
 * Refusal is recoverable: the caller shows a message and the user regenerates.
 */
export function validateAnchor(doc: AnchorDoc, anchor: InsertAnchor): AnchorValidation {
  if (doc.content.size !== anchor.docSize) {
    return { ok: false, reason: 'size-changed' };
  }
  const from = Math.max(0, anchor.pos - ANCHOR_CONTEXT_CHARS);
  const contextNow = doc.textBetween(from, anchor.pos, '\n', '\n');
  if (contextNow !== anchor.contextBefore) {
    return { ok: false, reason: 'context-changed' };
  }
  return { ok: true };
}
