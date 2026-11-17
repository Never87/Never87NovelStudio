/**
 * Story Editor — the SINGLE source of truth for editor formatting commands.
 *
 * Both the minimal toolbar and the slash (`/`) menu invoke the commands defined
 * here, so the two surfaces can never drift apart. Every entry ultimately calls
 * an ordinary TipTap command on the live editor (`editor.chain()...run()`), or
 * performs one small, well-defined DOM/URL step (Link/Image) and then inserts a
 * standard Markdown-safe node/mark. There is no second, parallel command system.
 *
 * The registry is plain data plus tiny `run(editor)` functions, so it can be
 * unit-tested with a real headless TipTap editor (no React, no browser chrome).
 */
import type { Editor } from '@tiptap/core';
import type { Level } from '@tiptap/extension-heading';
import { normaliseHref, normaliseImageSrc } from './editor-link';

/** Stable command identifier (also used as the run signature). */
export type EditorCommandId =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'bold'
  | 'italic'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'link'
  | 'image'
  | 'undo'
  | 'redo';

/** Grouping for the slash menu (display order within a kind). */
export type EditorCommandGroup = 'headings' | 'inline' | 'lists' | 'blocks' | 'insert' | 'history';

export interface EditorCommand {
  id: EditorCommandId;
  /** Human-readable label shown in the menu. */
  label: string;
  group: EditorCommandGroup;
  /**
   * Every searchable name for this command, lower-cased. Includes Markdown-ish
   * aliases so `/h1`, `/#`, `/bold`, `/b`, `/**`, `/quote`, `/>` all resolve.
   */
  aliases: string[];
  /** Whether the command is currently available on the editor. */
  isEnabled: (editor: Editor) => boolean;
  /** Executes the command on the current selection/cursor. */
  run: (editor: Editor) => void;
}

/**
 * Extra inputs the caller supplies for commands that need one (a URL). They are
 * passed by the toolbar/menu so this module stays free of React/DOM prompts.
 */
export interface CommandInput {
  href?: string;
  /** Optional label for a Link (defaults to the URL). */
  label?: string;
  alt?: string;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Sets heading `level`, or toggles back to a paragraph when already that level. */
function applyHeading(editor: Editor, level: Level): void {
  editor.chain().focus().toggleHeading({ level }).run();
}

/**
 * Runs a boolean-returning chain and swallows an exception from a missing
 * extension: a missing node/mark must never crash the editor (it no-ops).
 */
function guard(fn: () => boolean): void {
  try {
    fn();
  } catch {
    /* Missing extension — the action is a safe no-op. */
  }
}

/** Builds a heading command for `level`, with Markdown-ish aliases (`h1`, `#`). */
function heading(id: EditorCommandId, level: Level, label: string, aliases: string[]): EditorCommand {
  return {
    id,
    label,
    group: 'headings',
    aliases,
    isEnabled: (editor) => editor.can().chain().focus().toggleHeading({ level }).run(),
    run: (editor) => applyHeading(editor, level),
  };
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * All editor commands, in menu display order.
 *
 * Aliases are listed WITHOUT a leading `/`; the slash menu compares the typed
 * query (after `/`) against them after normalising case and collapsing spaces.
 */
export const EDITOR_COMMANDS: EditorCommand[] = [
  heading('heading-1', 1, 'Heading 1', ['heading 1', 'h1', '#']),
  heading('heading-2', 2, 'Heading 2', ['heading 2', 'h2', '##']),
  heading('heading-3', 3, 'Heading 3', ['heading 3', 'h3', '###']),
  heading('heading-4', 4, 'Heading 4', ['heading 4', 'h4', '####']),
  heading('heading-5', 5, 'Heading 5', ['heading 5', 'h5', '#####']),
  heading('heading-6', 6, 'Heading 6', ['heading 6', 'h6', '######']),

  {
    id: 'bold',
    label: 'Bold',
    group: 'inline',
    aliases: ['bold', 'b', '**'],
    isEnabled: (editor) => editor.can().chain().focus().toggleBold().run(),
    run: (editor) => {
      editor.chain().focus().toggleBold().run();
    },
  },
  {
    id: 'italic',
    label: 'Italic',
    group: 'inline',
    aliases: ['italic', 'i', '*', '_'],
    isEnabled: (editor) => editor.can().chain().focus().toggleItalic().run(),
    run: (editor) => {
      editor.chain().focus().toggleItalic().run();
    },
  },

  {
    id: 'bullet-list',
    label: 'Bullet List',
    group: 'lists',
    // `-` and `*` are the Markdown bullet markers. They intentionally collide
    // with Italic's `*`; `matchCommands` surfaces BOTH, so the author
    // disambiguates explicitly instead of the wrong command firing.
    aliases: ['bullet list', 'unordered list', 'bulleted list', '-', '*'],
    isEnabled: (editor) => editor.can().chain().focus().toggleBulletList().run(),
    run: (editor) => {
      guard(() => editor.chain().focus().toggleBulletList().run());
    },
  },
  {
    id: 'ordered-list',
    label: 'Ordered List',
    group: 'lists',
    aliases: ['ordered list', 'numbered list', '1.'],
    isEnabled: (editor) => editor.can().chain().focus().toggleOrderedList().run(),
    run: (editor) => {
      guard(() => editor.chain().focus().toggleOrderedList().run());
    },
  },
  {
    id: 'blockquote',
    label: 'Blockquote',
    group: 'blocks',
    aliases: ['blockquote', 'quote', '>'],
    isEnabled: (editor) => editor.can().chain().focus().toggleBlockquote().run(),
    run: (editor) => {
      guard(() => editor.chain().focus().toggleBlockquote().run());
    },
  },

  {
    id: 'link',
    label: 'Link',
    group: 'insert',
    aliases: ['link', 'url'],
    // Link needs a URL, which the caller collects; it is always "enabled". The
    // bare `run` only UNLINKS (a safe toggle); supplying an href goes through
    // `applyLinkCommand` below.
    isEnabled: () => true,
    run: (editor) => {
      if (editor.isActive('link')) unlinkCommand(editor);
    },
  },
  {
    id: 'image',
    label: 'Image',
    group: 'insert',
    aliases: ['image', 'img', 'picture', '!'],
    // Image needs a URL/alt; the React layer collects them and calls
    // `applyImageCommand` below. A bare run is intentionally a no-op.
    isEnabled: () => true,
    run: () => {},
  },

  {
    id: 'undo',
    label: 'Undo',
    group: 'history',
    aliases: ['undo'],
    isEnabled: (editor) => editor.can().undo(),
    run: (editor) => {
      editor.chain().focus().undo().run();
    },
  },
  {
    id: 'redo',
    label: 'Redo',
    group: 'history',
    aliases: ['redo'],
    isEnabled: (editor) => editor.can().redo(),
    run: (editor) => {
      editor.chain().focus().redo().run();
    },
  },
];

/** Fast lookup by id. */
const BY_ID = new Map<string, EditorCommand>(EDITOR_COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: EditorCommandId): EditorCommand {
  const command = BY_ID.get(id);
  if (!command) throw new Error(`Unknown editor command: ${id}`);
  return command;
}

/* -------------------------------------------------------------------------- */
/* Commands that need caller-provided input (Link / Image)                    */
/* -------------------------------------------------------------------------- */

/**
 * Sets (or replaces) a link on the current selection using a validated href.
 * Returns an error message string when the URL is rejected, otherwise null.
 */
export function applyLinkCommand(editor: Editor, input: CommandInput): string | null {
  const result = normaliseHref(input.href ?? '');
  if (!result.ok) return result.reason;

  const href = result.value;
  const { empty, from, to } = editor.state.selection;

  if (empty) {
    // Insert the label (or URL) as linked text at the cursor.
    const text = (input.label?.trim() || href).slice(0, 500);
    editor
      .chain()
      .focus()
      .insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
      .run();
    return null;
  }

  // Apply the link over the selected text, replacing any existing link mark.
  editor.chain().focus().setTextSelection({ from, to }).extendMarkRange('link').setLink({ href }).run();
  return null;
}

/** Removes any link mark at the current selection/cursor. */
export function unlinkCommand(editor: Editor): void {
  editor.chain().focus().extendMarkRange('link').unsetLink().run();
}

/**
 * Inserts an image block from a validated src. Returns an error message string
 * when rejected, otherwise null. The src becomes a stable URL in the Markdown
 * (`![alt](src)`) — no blob/object URL is ever persisted.
 */
export function applyImageCommand(editor: Editor, input: CommandInput): string | null {
  const result = normaliseImageSrc(input.href ?? '');
  if (!result.ok) return result.reason;
  const alt = (input.alt ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  editor.chain().focus().insertContent({ type: 'image', attrs: { src: result.value, alt } }).run();
  return null;
}

/* -------------------------------------------------------------------------- */
/* Slash menu matching                                                        */
/* -------------------------------------------------------------------------- */

/** Normalises a query/label for comparison: lower-case, trim, collapse spaces. */
export function normaliseQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A scored match: the command plus why it matched (for ordering + display). */
export interface CommandMatch {
  command: EditorCommand;
  /** 'exact' if the query equals an alias; 'prefix' / 'substring' otherwise. */
  kind: 'exact' | 'prefix' | 'substring';
  /** The alias that produced the match (displayed as a hint). */
  matchedAlias: string;
}

function rankKind(kind: CommandMatch['kind']): number {
  return kind === 'exact' ? 0 : kind === 'prefix' ? 1 : 2;
}

/**
 * Ranks commands for a slash query.
 *
 * Matching rules (deliberately simple and predictable):
 *   - empty query → every command, in registry order (the full menu);
 *   - 'exact'    → the query equals an alias (e.g. `h1`, `#`, `bold`);
 *   - 'prefix'   → an alias starts with the query (e.g. `hea` → Heading…);
 *   - 'substring'→ the query appears inside an alias or the label.
 *
 * Aliases that are ALSO other commands (the `*` collision between Italic and
 * Bullet List) are all returned, so the menu shows both. De-duplicated to one
 * entry per command, keeping the best match kind.
 */
export function matchCommands(query: string): CommandMatch[] {
  const q = normaliseQuery(query);
  if (q === '') {
    return EDITOR_COMMANDS.map((command) => ({
      command,
      kind: 'prefix',
      matchedAlias: command.label,
    }));
  }

  const best = new Map<EditorCommandId, CommandMatch>();
  const consider = (command: EditorCommand, alias: string, kind: CommandMatch['kind']) => {
    const current = best.get(command.id);
    if (!current || rankKind(kind) < rankKind(current.kind)) {
      best.set(command.id, { command, kind, matchedAlias: alias });
    }
  };

  for (const command of EDITOR_COMMANDS) {
    for (const alias of command.aliases) {
      const a = alias.toLowerCase();
      if (a === q) {
        consider(command, alias, 'exact');
      } else if (a.startsWith(q)) {
        consider(command, alias, 'prefix');
      } else if (a.includes(q) || command.label.toLowerCase().includes(q)) {
        consider(command, alias, 'substring');
      }
    }
  }

  // Order: exact matches first, then prefix, then substring; stable within a
  // kind by registry order (headings before inline before lists …).
  const order = new Map<EditorCommandId, number>(EDITOR_COMMANDS.map((c, i) => [c.id, i]));
  return [...best.values()].sort((x, y) => {
    const d = rankKind(x.kind) - rankKind(y.kind);
    if (d !== 0) return d;
    return (order.get(x.command.id) ?? 0) - (order.get(y.command.id) ?? 0);
  });
}
