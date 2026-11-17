import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { cn } from '@/utils/cn';
import { EditorImage } from './extensions/editor-image';
import { SlashMenuExtension } from './editor-slash-extension';
import { MarkdownShortcutRules } from './editor-input-rules';
import { markdownToEditorHtml } from './editor-loader';
import { placeCaretViaCoordinates } from './editor-click-to-edit';

/**
 * Story Editor TipTap surface configuration.
 *
 * The editor is a **Markdown**-backed surface: content enters as Markdown (via
 * `setContent` with the commonmark-ish default), changes leave as Markdown.
 *
 * Extensions:
 *   - StarterKit — bold/italic/strike/code, headings 1–6, lists, blockquote,
 *     code block, horizontal rule, HARD BREAK, LINK (configured so a click edits
 *     the text instead of navigating), and history (undo/redo).
 *   - `EditorImage`          — a home for `![alt](src)` so images round-trip.
 *   - `MarkdownShortcutRules` — the `![alt](url)` typing shortcut (the rest of
 *     the Markdown shortcuts come from StarterKit).
 *   - `SlashMenuExtension`    — detects a `/` query and drives the slash menu.
 *
 * The editor is NEVER remounted for a typography/appearance change or a
 * Normal↔Focus switch: tools that change the look write CSS variables elsewhere.
 * It is only rebuilt when the DOCUMENT identity (`editorKey`) or its accessible
 * name changes.
 */
export interface MarkdownEditorProps {
  /** Initial Markdown. Later changes are pushed through `editorKey`. */
  value: string;
  /**
   * Identity of the document being edited. When it changes the editor is
   * rebuilt with the new content — never mutated in place, which is what keeps
   * an in-flight save from writing text into the wrong chapter.
   */
  editorKey: string;
  /** Called on every user edit with the current Markdown. */
  onChange: (markdown: string) => void;
  /** Accessible name of the editing surface (scenes override the chapter default). */
  ariaLabel?: string;
  /** Read-only (locked chapter or while a save is failing). */
  editable?: boolean;
  /** Autofocus on mount (new documents). */
  autoFocus?: boolean;
  /** Ctrl/Cmd+S handler. */
  onSaveShortcut?: () => void;
  className?: string;
  /** Exposed for tests and toolbar buttons living outside this component. */
  onEditorReady?: (editor: Editor | null) => void;
}

export function MarkdownEditor({
  value,
  editorKey,
  onChange,
  ariaLabel = 'Chapter manuscript',
  editable = true,
  autoFocus = false,
  onSaveShortcut,
  className,
  onEditorReady,
}: MarkdownEditorProps) {
  // Keep the latest callbacks out of the editor's closure so the editor is not
  // recreated on every parent render (which would lose the cursor).
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSaveShortcut);
  onChangeRef.current = onChange;
  onSaveRef.current = onSaveShortcut;

  // The last Markdown value we PROGRAMMATICALLY set into the editor. Guards the
  // external-update effect against re-setting a value the editor cannot
  // serialise identically (which would otherwise loop). See that effect.
  const lastPushed = useRef<string | null>(null);

  // Stable extension array: identity must not change between renders or TipTap
  // would treat it as a config change. Kept in a ref-like memo.
  const extensions = useMemo(
    () => [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      EditorImage,
      MarkdownShortcutRules,
      SlashMenuExtension,
    ],
    [],
  );

  const editor = useEditor(
    {
      extensions,
      // The stored document is Markdown; ProseMirror parses HTML. Convert it to
      // schema-matching HTML so headings/marks/lists/images render structurally
      // instead of as literal Markdown syntax. `getMarkdown` is the inverse.
      content: markdownToEditorHtml(value),
      editable,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          // `n87-prose-editor` owns the writing-surface styles: always-on
          // visual word wrap, typography driven by CSS variables and long-word
          // safety. It never alters the ProseMirror document (wrap is visual).
          class: cn('n87-prose-editor text-ink focus:outline-none'),
          'aria-label': ariaLabel,
          spellcheck: 'true',
        },
        handleDOMEvents: {
          // FULL-SURFACE CLICK-TO-EDIT see `editor-click-to-edit`.
          mousedown: (view, event) => placeCaretViaCoordinates(view, event),
        },
      },
      onUpdate: ({ editor: current }: { editor: Editor }) => {
        // Markdown keeps the stored format tool-independent and diff-friendly.
        onChangeRef.current(getMarkdown(current));
      },
    },
    // Rebuild the editor when the document identity OR its accessible name
    // changes (chapter and scene surfaces must never be reused silently).
    [editorKey, ariaLabel],
  );

  // Push content updates that did not come from typing (e.g. version restore
  // or an external reload) without resetting the selection on normal edits.
  //
  // Comparison is MD-to-MD (the editor's serialised Markdown vs. the incoming
  // `value`) and DOUBLE-GUARDED:
  //  - During normal typing the parent echoes our own `onChange` value straight
  //    back; it equals `getMarkdown(editor)`, so this is a cheap no-op and the
  //    cursor is never disturbed.
  //  - If a stored value uses Markdown the editor cannot represent identically
  //    (rare), re-setting would immediately re-serialise to something different
  //    and loop. To prevent that, we only push a value we have not just pushed
  //    (`lastPushed`), and only when the editor is not focused on that equal
  //    content — a genuine external restore still replaces content.
  useEffect(() => {
    if (!editor) return;
    if (getMarkdown(editor) === value) return;
    if (lastPushed.current === value) return; // we already tried; avoid a loop
    lastPushed.current = value;
    editor.commands.setContent(markdownToEditorHtml(value), { emitUpdate: false });
  }, [editor, value, editorKey]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    onEditorReady?.(editor ?? null);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // Ctrl/Cmd+S → flush immediately instead of letting the browser save the page.
  useEffect(() => {
    if (!editor) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSaveRef.current?.();
      }
    };
    const dom = editor.view.dom;
    dom.addEventListener('keydown', handler);
    return () => dom.removeEventListener('keydown', handler);
  }, [editor]);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {/* `h-full` lets the ProseMirror column fill the scroll area so its empty
          space below the last paragraph is part of the clickable canvas (the
          `.n87-prose-editor` min-height in CSS + click-to-edit do the rest). */}
      <EditorContent
        editor={editor}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8 sm:py-6 [&_.ProseMirror]:min-h-full"
      />
    </div>
  );
}

/**
 * Extracts Markdown from a TipTap editor.
 *
 * StarterKit does not ship a Markdown serialiser, and P4 deliberately avoids
 * adding one: the manuscript is stored as Markdown, and the editor is rebuilt
 * from that Markdown on open. `getText()` with block separators preserves the
 * paragraph structure users rely on while remaining plain, portable text —
 * matching what the word counter and export pipelines consume.
 */
export function getMarkdown(editor: Editor): string {
  return editorToMarkdown(editor.getJSON() as unknown as PMNode);
}

/** Public for the loader/serialiser unit tests. */
export const editorToMarkdown = serializeNode;

/* ------------------------------------------------------------------------ */
/* Minimal, deterministic ProseMirror-JSON → Markdown serialiser.           */
/* ------------------------------------------------------------------------ */

interface PMNode {
  type?: string;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

/** Serialises a ProseMirror document node to Markdown. */
function serializeNode(node: PMNode): string {
  if (!node) return '';
  if (node.type === 'doc') {
    return (node.content ?? [])
      .map((child) => serializeBlock(child))
      .filter((block) => block !== null)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }
  return serializeBlock(node) ?? '';
}

/** Serialises one block node, returning `null` for empty paragraphs. */
function serializeBlock(node: PMNode): string | null {
  switch (node.type) {
    case 'paragraph': {
      const text = serializeInline(node.content ?? []);
      return text.trim() === '' ? null : text;
    }
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6));
      return `${hashes} ${serializeInline(node.content ?? [])}`.trimEnd();
    }
    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((child) => serializeBlock(child))
        .filter((block): block is string => block !== null)
        .join('\n\n');
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'bulletList':
      return serializeList(node, () => '- ');
    case 'orderedList': {
      let index = Number(node.attrs?.start ?? 1);
      return serializeList(node, () => `${index++}. `);
    }
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      return `\`\`\`${language}\n${collectText(node)}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'hardBreak':
      return '\n';
    case 'image':
      return serializeImage(node);
    default: {
      // Unknown block: fall back to its text so nothing is ever dropped.
      const text = collectText(node);
      return text.trim() === '' ? null : text;
    }
  }
}

function serializeList(node: PMNode, bullet: () => string): string {
  return (node.content ?? [])
    .map((item) => {
      const inner = (item.content ?? [])
        .map((child) => serializeBlock(child))
        .filter((block): block is string => block !== null)
        .join('\n');
      const lines = inner.split('\n');
      return lines
        .map((line, i) => (i === 0 ? `${bullet()}${line}` : `  ${line}`))
        .join('\n');
    })
    .join('\n');
}

/** Serialises inline content, applying marks. */
function serializeInline(nodes: PMNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n';
      if (node.type === 'image') return serializeImage(node);
      if (node.type !== 'text') return collectText(node);
      let text = node.text ?? '';
      for (const mark of node.marks ?? []) {
        text = applyMark(text, mark);
      }
      return text;
    })
    .join('');
}

/**
 * Serialises an image node to the canonical Markdown `![alt](src)`.
 *
 * `alt` is escaped only for the characters that would otherwise break the
 * `[...]` label (`]`, `[`) or the `(...)` target (`(`, `)`), so a URL with
 * parentheses (e.g. a query string) still round-trips. The `src` is the exact
 * stable URL that was validated and inserted — never a blob/object URL.
 */
function serializeImage(node: PMNode): string {
  const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
  const rawAlt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
  const alt = rawAlt.replace(/([[\]])/g, '\\$1');
  const safeSrc = src.replace(/([()])/g, '\\$1');
  return `![${alt}](${safeSrc})`;
}

function applyMark(text: string, mark: { type: string; attrs?: Record<string, unknown> }): string {
  switch (mark.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'strike':
      return `~~${text}~~`;
    case 'code':
      return `\`${text}\``;
    case 'link': {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
      return href ? `[${text}](${href})` : text;
    }
    case 'underline':
      // Markdown has no underline; keep the text rather than inventing syntax.
      return text;
    default:
      return text;
  }
}

/** Concatenates all text inside a node (used for code blocks and fallbacks). */
function collectText(node: PMNode): string {
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(collectText).join('\n');
}
