import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Undo2,
} from 'lucide-react';
import {
  applyImageCommand,
  applyLinkCommand,
  getCommand,
  normaliseQuery,
  type CommandMatch,
  type EditorCommand,
  type EditorCommandId,
} from './editor-commands';
import {
  closeSlashMenu,
  EMPTY_SLASH_STATE,
  getSlashState,
  subscribeSlashMenu,
  type SlashState,
} from './editor-slash-extension';
import { cn } from '@/utils/cn';

/**
 * Story Editor slash (`/`) command menu.
 *
 * Renders a keyboard-navigable list of commands from the shared registry when
 * the user types `/` at the cursor OR presses the toolbar's `/` button. It does
 * NOT own a command system: selecting an entry calls `editor-commands`, exactly
 * like the toolbar.
 *
 * Anchoring: located at the caret using ProseMirror's `coordsAtPos`, converted
 * to a position within the scroll container. There is no Tippy/floating-ui
 * dependency; a simple absolutely-positioned div is sufficient and keeps the
 * bundle small.
 *
 * Keyboard: Up/Down move the selection, Enter runs it, Escape closes. The
 * editor keeps DOM focus during arrow navigation because the menu's items use
 * `onMouseDown={preventDefault}` — clicking an item preserves the caret.
 */
export interface SlashMenuProps {
  editor: Editor | null;
  /** Increment this to request a keyboard-less open (toolbar `/` button). */
  openSignal: number;
}

const ICONS: Record<EditorCommandId, React.ReactNode> = {
  'heading-1': <Heading1 className="size-3.5" aria-hidden />,
  'heading-2': <Heading2 className="size-3.5" aria-hidden />,
  'heading-3': <Heading3 className="size-3.5" aria-hidden />,
  'heading-4': <Heading4 className="size-3.5" aria-hidden />,
  'heading-5': <Heading5 className="size-3.5" aria-hidden />,
  'heading-6': <Heading6 className="size-3.5" aria-hidden />,
  bold: <Bold className="size-3.5" aria-hidden />,
  italic: <Italic className="size-3.5" aria-hidden />,
  'bullet-list': <List className="size-3.5" aria-hidden />,
  'ordered-list': <ListOrdered className="size-3.5" aria-hidden />,
  blockquote: <Quote className="size-3.5" aria-hidden />,
  link: <LinkIcon className="size-3.5" aria-hidden />,
  image: <ImageIcon className="size-3.5" aria-hidden />,
  undo: <Undo2 className="size-3.5" aria-hidden />,
  redo: <Redo2 className="size-3.5" aria-hidden />,
};

export function SlashMenu({ editor, openSignal }: SlashMenuProps) {
  const [state, setState] = useState<SlashState>(EMPTY_SLASH_STATE);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [urlMode, setUrlMode] = useState<{ command: 'link' | 'image' } | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Whether the menu was opened by the toolbar button (vs. typing `/`). Kept so
  // the menu can render even before any query is typed.
  const [forcedOpen, setForcedOpen] = useState(false);

  /* ---- Subscribe to plugin state ---- */
  useEffect(() => {
    if (!editor) return;
    const unsubscribe = subscribeSlashMenu(editor, {
      onChange: (next) => {
        setState(next);
        setActiveIndex(0);
        setError(null);
        if (next.open) setForcedOpen(false);
      },
    });
    return unsubscribe;
  }, [editor]);

  /* ---- Toolbar `/` button → force the menu open at the cursor ---- */
  useEffect(() => {
    if (!editor || openSignal === 0) return;
    // Insert a `/` at the cursor, then the plugin opens on the resulting
    // transaction. If the selection is not empty, insert over it.
    editor.chain().focus().insertContent('/').run();
    setForcedOpen(true);
    setUrlMode(null);
  }, [editor, openSignal]);

  const open = state.open || (forcedOpen && !!editor);

  /* ---- Position at the caret ---- */
  useEffect(() => {
    if (!open || !editor) {
      setPosition(null);
      return;
    }
    const pos = state.to || editor.state.selection.from;
    const view = editor.view;
    try {
      const coords = view.coordsAtPos(pos);
      const rect = view.dom.getBoundingClientRect();
      setPosition({
        top: coords.bottom - rect.top + view.dom.offsetTop + 4,
        left: coords.left - rect.left + view.dom.offsetLeft,
      });
    } catch {
      setPosition({ top: 8, left: 8 });
    }
  }, [open, editor, state.to, state.query]);

  const matches: CommandMatch[] = state.matches;
  const visible = urlMode ? [] : matches;
  const clampedActive = Math.min(activeIndex, Math.max(0, visible.length - 1));

  /* ---- Execute a chosen command ---- */
  const execute = useCallback(
    (match: CommandMatch) => {
      if (!editor) return;
      const { command } = match;

      // Link / Image need a URL → switch the menu into URL-entry mode rather
      // than closing it (so the same panel collects the value).
      if (command.id === 'link' || command.id === 'image') {
        // Remove the typed `/query` so it does not remain in the prose.
        stripQuery(editor);
        setUrlMode({ command: command.id });
        setUrl('');
        setError(null);
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }

      stripQuery(editor);
      getCommand(command.id).run(editor);
      closeSlashMenu(editor.view);
      setForcedOpen(false);
    },
    [editor],
  );

  /* ---- URL submit for Link / Image ---- */
  const submitUrl = useCallback(() => {
    if (!editor || !urlMode) return;
    const result =
      urlMode.command === 'link'
        ? applyLinkCommand(editor, { href: url })
        : applyImageCommand(editor, { href: url, alt: '' });
    if (result) {
      setError(result);
      return;
    }
    setUrlMode(null);
    setUrl('');
    closeSlashMenu(editor.view);
    setForcedOpen(false);
    editor.commands.focus();
  }, [editor, urlMode, url]);

  /* ---- Keyboard navigation while the menu is open ---- */
  useEffect(() => {
    if (!open || !editor) return;
    const dom = editor.view.dom;
    const handler = (event: KeyboardEvent) => {
      if (urlMode) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setUrlMode(null);
          closeSlashMenu(editor.view);
          setForcedOpen(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          submitUrl();
        }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => (visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length));
      } else if (event.key === 'Enter') {
        if (visible.length === 0) return;
        event.preventDefault();
        execute(visible[clampedActive]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeSlashMenu(editor.view);
        setForcedOpen(false);
      }
    };
    // Capture phase: intercept arrow/enter/escape BEFORE the editor's own keymap.
    dom.addEventListener('keydown', handler, true);
    return () => dom.removeEventListener('keydown', handler, true);
  }, [open, editor, visible, clampedActive, execute, urlMode, submitUrl]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label="Insert command"
      style={position ? { top: position.top, left: position.left } : { top: 8, left: 8 }}
      className="bg-surface shadow-[var(--n87-shadow-popover)] absolute z-50 w-64 overflow-hidden rounded-lg border border-line text-xs"
      // Prevent clicks inside the menu from moving the editor caret.
      onMouseDown={(event) => event.preventDefault()}
    >
      {urlMode ? (
        <div className="p-2">
          <p className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">
            {urlMode.command === 'link' ? 'Link URL' : 'Image URL'}
          </p>
          <input
            ref={inputRef}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder={urlMode.command === 'link' ? 'https://…' : 'https://… or pasted data URL'}
            className="border-line bg-surface text-ink focus:border-accent w-full rounded border px-2 py-1 text-xs outline-none"
          />
          {error ? <p className="text-danger mt-1 text-2xs">{error}</p> : null}
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => {
                setUrlMode(null);
                closeSlashMenu(editor!.view);
                setForcedOpen(false);
              }}
              className="text-muted hover:bg-surface-muted rounded px-2 py-0.5 text-2xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitUrl}
              disabled={!url.trim()}
              className="bg-accent text-white rounded px-2 py-0.5 text-2xs disabled:opacity-40"
            >
              Insert
            </button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <p className="text-subtle px-3 py-2 text-2xs">
          No commands match “{normaliseQuery(state.query)}”.
        </p>
      ) : (
        <ul className="max-h-64 overflow-y-auto py-1">
          {visible.map((match, index) => (
            <li key={match.command.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === clampedActive}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => execute(match)}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
                  index === clampedActive ? 'bg-accent-soft text-accent-soft-text' : 'text-ink hover:bg-surface-muted',
                )}
              >
                <span className="text-subtle">{ICONS[match.command.id]}</span>
                <span className="flex-1 truncate">{match.command.label}</span>
                <AliasHint command={match.command} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shows the Markdown-ish alias that produced the match (e.g. `#`, `**`). */
function AliasHint({ command }: { command: EditorCommand }) {
  const alias = command.aliases.find((a) => /^[#*>_!-]|^\d\.|^[bhi]$/.test(a));
  if (!alias) return null;
  return (
    <code className="bg-surface-muted text-subtle rounded px-1 text-2xs">{alias}</code>
  );
}

/**
 * Removes the typed `/query` before executing/routing. Uses the plugin state's
 * `from`/`to` so exactly the slash-run is deleted, leaving surrounding prose and
 * the cursor position correct. Falls back to reading the textblock when the menu
 * was force-opened by the toolbar button (state `from/to` are still valid there).
 */
function stripQuery(editor: Editor): void {
  const { from, to } = getSlashState(editor);
  if (to > from) {
    editor.chain().focus().deleteRange({ from, to }).run();
  }
}
