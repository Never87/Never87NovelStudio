import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Full-Surface Click-to-Edit.
 *
 * The writing surface should behave like a page: clicking ANYWHERE inside it
 * places the caret there — on existing text, on a blank line, or in the empty
 * space below the last paragraph — without the author having to first click a
 * particular text node.
 *
 * ProseMirror already maps a click on text/blank lines to a caret. The gap is
 * the EMPTY AREA below the last block: a click there lands outside any
 * textblock, so nothing focuses. `placeCaretViaCoordinates` closes that gap
 * using ProseMirror's own coordinate API — no fake overlay, no fixed position.
 *
 * Why `mousedown` (capture, non-passive) and not `click`?
 *   - It runs BEFORE ProseMirror's own selection handling, so we can return
 *     `true` (handled) only when we actually moved the caret and let every other
 *     case fall through to the default behaviour.
 *   - It does NOT interfere with drag-selection: if the press is on real text
 *     or a draggable node, we let ProseMirror handle it untouched.
 *   - Toolbars, popovers and the slash menu live OUTSIDE the ProseMirror DOM, so
 *     their clicks never reach this handler (the editor does not move its caret).
 *
 * Returns `true` when the event was consumed (caret placed), `false` to let the
 * default ProseMirror behaviour run.
 */
export function placeCaretViaCoordinates(view: EditorView, event: MouseEvent): boolean {
  // Only the primary button; ignore right-click / middle-click / modified
  // clicks (Shift+click extends a selection, Cmd/Ctrl-click opens links, etc.).
  if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }

  const target = event.target as HTMLElement | null;
  // A press on an interactive element (a link, an image's own UI) is a normal
  // interaction — let ProseMirror decide.
  if (target?.closest('a, img, button, input, textarea, select, [contenteditable="false"]')) {
    return false;
  }

  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return false;

  const { state } = view;
  const { doc } = state;

  // Where did the coordinate map to?
  const $pos = doc.resolve(coords.pos);
  const insideTextblock = $pos.parent.isTextblock;

  // When the click is ON text, ProseMirror handles caret placement and drag
  // selection perfectly. We only need to intervene when the click did NOT land
  // inside a textblock (i.e. the empty area of the canvas).
  if (insideTextblock && coords.inside >= 0) return false;

  // ---- Empty-canvas click: place the caret at the nearest sensible spot. ----

  // 1) If the document's LAST block is a paragraph we can extend, add a fresh
  //    empty paragraph at the end and put the caret in it. This is the common
  //    "click below the prose to keep writing" expectation.
  const lastChild = doc.lastChild;
  let tr = state.tr;
  let caretPos: number;

  if (lastChild && lastChild.type.name === 'paragraph' && lastChild.content.size === 0) {
    // Already an empty trailing paragraph — just put the caret inside it.
    caretPos = doc.content.size - 1;
  } else if (lastChild && state.schema.nodes.paragraph) {
    // Append a new empty paragraph at the very end of the document.
    const paragraphPos = doc.content.size;
    tr = tr.insert(paragraphPos, state.schema.nodes.paragraph.create());
    caretPos = paragraphPos + 1;
  } else {
    // Empty document or no paragraph type: place the caret at doc end.
    caretPos = Math.max(1, doc.content.size - 1);
  }

  // Clamp into a valid text position and set a text selection so the caret and
  // keyboard focus behave exactly like a normal click.
  const resolved = tr.doc.resolve(clampPos(tr.doc.content.size, caretPos));
  const selection = TextSelection.near(resolved, -1);
  tr = tr.setSelection(selection);
  view.dispatch(tr);
  view.focus();
  // Mark the press as handled so the browser does not also try to collapse it.
  event.preventDefault();
  return true;
}

/** Keeps a position within `[1, size - 1]` for a text selection. */
function clampPos(size: number, pos: number): number {
  return Math.min(Math.max(pos, 1), Math.max(1, size - 1));
}
