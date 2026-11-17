import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Extension, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { matchCommands, type CommandMatch } from './editor-commands';

/**
 * Story Editor slash (`/`) command plugin.
 *
 * A deliberately small ProseMirror plugin — NOT a second command system. It only
 * detects when the author is typing a `/` query at the cursor, tracks the typed
 * query, and exposes the current matches to the React menu. Executing a command
 * is done by the SAME `editor-commands` registry the toolbar uses.
 *
 * ## Detection contract
 *
 * The trigger is a `/` that begins a word (start of a textblock, or preceded by
 * whitespace). This lets a slash live inside ordinary prose — a URL like
 * `https://…` or a fraction `1/2` never opens the menu, because their `/` is not
 * preceded by whitespace/start. After `/`, the query runs until a newline, the
 * cursor leaves the trigger paragraph, or the run gets implausibly long;
 * single spaces ARE allowed so multi-word commands (`/bullet list`) match.
 *
 * ## Keyboard
 *
 * Arrow Up/Down, Enter and Escape are consumed ONLY while the menu is open
 * (see `handleSlashKeyDown`, wired by the React layer). When closed, every key
 * is untouched, so normal typing is unaffected.
 *
 * State lives in ProseMirror plugin state and is surfaced to React through the
 * `onChange` adapter the React menu registers on the editor (in its storage).
 */

export interface SlashState {
  /** Doc position of the `/`. */
  from: number;
  /** Doc position just past the typed query (the current cursor). */
  to: number;
  /** Text typed after `/` (no slash). */
  query: string;
  matches: CommandMatch[];
  open: boolean;
}

export const EMPTY_SLASH_STATE: SlashState = { from: 0, to: 0, query: '', matches: [], open: false };

export const slashPluginKey = new PluginKey<SlashState>('n87-slash-menu');

/** Adapter the React menu registers so the plugin can push state changes. */
export interface SlashListener {
  onChange: (state: SlashState, view: EditorView) => void;
}

/** Whether the character just before `pos` allows a `/` to start a command. */
function isWordStart(doc: PMNode, pos: number): boolean {
  // Resolve the position BEFORE the slash (a boundary point at the slash) so we
  // can read the preceding character. Resolving AT the slash yields parentOffset
  // == `pos` relative to the block start, which we then index generously below.
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.name === 'codeBlock') return false;

  const blockStart = $pos.start();
  const offsetInBlock = pos - blockStart;
  if (offsetInBlock <= 0) return true;

  // Plain text of the block, indexed by character offset. `textBetween(a, b)`
  // clamps a boundary-less sub-range to the whole block, so we slice the full
  // text ourselves (exact).
  const blockText = $pos.parent.textBetween(0, $pos.parent.content.size, '\n', '\0');
  const before = blockText.charAt(offsetInBlock - 1);
  return before === '' || /\s/.test(before);
}

/** Computes slash state purely from an editor state (no view needed). */
export function computeSlashState(state: EditorState): SlashState {
  const { selection } = state;
  if (!selection.empty) return EMPTY_SLASH_STATE;

  const $cursor = selection.$from;
  if (!$cursor.parent.isTextblock || $cursor.parent.type.name === 'codeBlock') return EMPTY_SLASH_STATE;

  // Exact plain text of the block up to the caret (see `isWordStart` for why
  // `textBetween(0, parentOffset)` is unreliable here).
  const textBefore = $cursor.parent.textBetween(0, $cursor.parent.content.size, '\n', '\0').slice(
    0,
    $cursor.parentOffset,
  );
  const slashIndex = textBefore.lastIndexOf('/');
  if (slashIndex === -1) return EMPTY_SLASH_STATE;

  const query = textBefore.slice(slashIndex + 1);
  // Keep the menu open through single spaces (`/bullet list`) but abandon absurd
  // runs or double spaces, which are almost certainly prose.
  if (query.length > 32 || /\s{2,}/.test(query) || query.includes('\n')) return EMPTY_SLASH_STATE;

  const from = $cursor.start() + slashIndex;
  if (!isWordStart(state.doc, from)) return EMPTY_SLASH_STATE;

  const matches = matchCommands(query);
  return { from, to: selection.from, query, matches, open: matches.length > 0 };
}

/** Plugin storage that the React layer uses to subscribe. */
interface SlashStorage {
  listener: SlashListener | null;
}

/**
 * Creates the TipTap extension. The React layer pushes a `listener` into
 * `editor.storage.n87SlashMenu` and re-renders from it.
 */
export const SlashMenuExtension = Extension.create<Record<string, never>, SlashStorage>({
  name: 'n87SlashMenu',

  addStorage(): SlashStorage {
    return { listener: null };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin<SlashState>({
        key: slashPluginKey,
        state: {
          init: () => EMPTY_SLASH_STATE,
          apply(tr, _prev, _old, newState) {
            if (tr.getMeta('n87-slash-close')) return EMPTY_SLASH_STATE;
            // NOTE: do NOT short-circuit while the menu is closed. The transaction
            // that OPENS the menu is exactly the `docChanged` one that must be
            // evaluated here — skipping it kept the menu permanently closed.
            return computeSlashState(newState);
          },
        },
        view() {
          return {
            update(view, prevState) {
              const next = slashPluginKey.getState(view.state) ?? EMPTY_SLASH_STATE;
              const before = slashPluginKey.getState(prevState) ?? EMPTY_SLASH_STATE;
              const changed =
                before.open !== next.open ||
                before.from !== next.from ||
                before.to !== next.to ||
                before.query !== next.query;
              if (changed) storage.listener?.onChange(next, view);
            },
            destroy() {
              storage.listener = null;
            },
          };
        },
      }),
    ];
  },
});

/** Forces the menu closed (e.g. on Escape or after executing a command). */
export function closeSlashMenu(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta('n87-slash-close', true));
}

/**
 * Removes the typed `/query` AND closes the menu in a SINGLE transaction.
 *
 * Why this exists (bug 2): the React menu used to read the plugin's `from`/`to`
 * via `getSlashState(editor)` at execution time and then call `deleteRange`.
 * Those positions are only valid for the document they were computed against; a
 * headless focus/selection round-trip or a keypress between opening the menu and
 * pressing Enter could make them stale, deleting the wrong span (or nothing), so
 * the command acted on the wrong block or left the `/query` in the prose.
 *
 * Here the range is passed explicitly from the state the menu was RENDERED with,
 * and the deletion + close happen atomically. The range is clamped to the live
 * document so an out-of-date value can never throw. Returns the positions the
 * caret should land on (i.e. the slash position) so a caller can place the caret
 * deterministically before running the command.
 */
export function removeSlashQuery(view: EditorView, from: number, to: number): number {
  const size = view.state.doc.content.size;
  const safeFrom = Math.min(Math.max(from, 0), size);
  const safeTo = Math.min(Math.max(to, safeFrom), size);
  const tr = view.state.tr;
  if (safeTo > safeFrom) tr.delete(safeFrom, safeTo);
  tr.setMeta('n87-slash-close', true);
  view.dispatch(tr);
  return safeFrom;
}

/** Reads the current slash state from an editor (or the empty state). */
export function getSlashState(editor: Editor): SlashState {
  return slashPluginKey.getState(editor.state) ?? EMPTY_SLASH_STATE;
}

/** Registers the React listener and returns an unsubscribe function. */
export function subscribeSlashMenu(editor: Editor, listener: SlashListener): () => void {
  // `n87SlashMenu` is declared through `addStorage` on the extension; TipTap's
  // generated `Storage` type does not know about it, so read it through a cast.
  const storage = (editor.storage as unknown as Record<string, SlashStorage | undefined>).n87SlashMenu;
  if (storage) storage.listener = listener;
  return () => {
    if (storage && storage.listener === listener) storage.listener = null;
  };
}
