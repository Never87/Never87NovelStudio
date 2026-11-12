import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { cn } from '@/utils/cn';

/**
 * TipTap surface configuration.
 *
 * The editor is a **Markdown**-backed surface: content enters as Markdown (via
 * `setContent` with the commonmark-ish default), changes leave as Markdown.
 * No custom nodes are registered in P4 — volatile ContentEditable behaviour is
 * the main source of data loss, so the schema stays fixed and small.
 *
 * StarterKit ships the extensions used below (bold, italic, strike, headings,
 * lists, blockquote, code, code block, history/undo-redo, hard break).
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

  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: value,
      editable,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: cn(
            'prose-editor focus:outline-none',
            'max-w-none text-[15px] leading-7 text-ink',
          ),
          'aria-label': 'Chapter manuscript',
          spellcheck: 'true',
        },
      },
      onUpdate: ({ editor: current }: { editor: Editor }) => {
        // Markdown keeps the stored format tool-independent and diff-friendly.
        onChangeRef.current(getMarkdown(current));
      },
    },
    // Rebuild the editor when the document identity changes.
    [editorKey],
  );

  // Push content updates that did not come from typing (e.g. version restore
  // or an external reload) without resetting the selection on normal edits.
  useEffect(() => {
    if (!editor) return;
    if (getMarkdown(editor) === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
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
      <EditorContent
        editor={editor}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8 sm:py-6"
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
  const json = editor.getJSON();
  return serializeNode(json);
}

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
      if (node.type !== 'text') return collectText(node);
      let text = node.text ?? '';
      for (const mark of node.marks ?? []) {
        text = applyMark(text, mark);
      }
      return text;
    })
    .join('');
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
