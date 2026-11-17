import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Redo2,
  Slash,
  Undo2,
} from 'lucide-react';
import { useStoryEditorStore, type EditorFontFamily } from '@/stores/story-editor-store';
import { getCommand } from './editor-commands';
import { cn } from '@/utils/cn';

/**
 * Minimal Story Editor formatting toolbar.
 *
 * Lives in the existing Chapter header row (left: title, middle: toolbar,
 * right: save status/actions) and works identically in Normal and Focus Mode
 * because it is rendered by the same editor surface in both. It is a FIXED row
 * element — no dragging, floating or free placement.
 *
 * Every control calls the SAME `editor-commands` registry the slash menu uses,
 * so the two surfaces can never diverge. Formatting acts on the current
 * selection/cursor:
 *
 *   - Controls use `onMouseDown={preventDefault}` and `onClick`, so clicking a
 *     button does NOT steal focus from the editor — the selection is preserved
 *     and `editor.chain().focus()` re-applies it before running the command.
 *   - Active states (H1–H3 / Bold / Italic) come from TipTap's `isActive`, and
 *     Undo/Redo are disabled when `can().undo()/redo()` is false.
 *
 * States derived from the selection are recomputed on `selectionUpdate` and
 * `transaction`, so the toolbar reflects the cursor without a full re-render of
 * the app shell (it is a tiny leaf component).
 */
export interface EditorToolbarProps {
  editor: Editor | null;
  /** Requests the slash menu at the cursor (same flow as typing `/`). */
  onOpenSlashMenu: () => void;
  /** Read-only chapters disable every control. */
  disabled?: boolean;
  className?: string;
}

const FONT_OPTIONS: Array<{ id: EditorFontFamily; label: string }> = [
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans' },
  { id: 'mono', label: 'Mono' },
];

const FONT_SIZES = [13, 14, 15, 16, 17, 18, 19, 20, 22, 24];

export function EditorToolbar({ editor, onOpenSlashMenu, disabled = false, className }: EditorToolbarProps) {
  const typography = useStoryEditorStore((s) => s.typography);
  const updateTypography = useStoryEditorStore((s) => s.updateTypography);

  // Bumped on every selection/transaction change so the active-state buttons
  // re-read `editor.isActive(...)` and the undo/redo availability.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const tick = () => forceTick((n) => n + 1);
    editor.on('selectionUpdate', tick);
    editor.on('transaction', tick);
    return () => {
      editor.off('selectionUpdate', tick);
      editor.off('transaction', tick);
    };
  }, [editor]);

  const run = (id: Parameters<typeof getCommand>[0]) => {
    if (!editor || disabled) return;
    getCommand(id).run(editor);
  };

  // Selection-preserving native-select handlers. Formatting BUTTONS prevent
  // their own mousedown (so the caret stays in the editor), but a native
  // `<select>` must NOT — preventing it is exactly what stops the dropdown from
  // opening (bug 1). Instead we snapshot the selection on `focus`/`mousedown`
  // (before the browser moves DOM focus) and re-apply it after the value change
  // so the command acts on the same range.
  const selectionRef = useRef<{ from: number; to: number } | null>(null);
  const captureSelection = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    selectionRef.current = { from, to };
  };
  const restoreSelection = () => {
    if (!editor || !selectionRef.current) return;
    const { from, to } = selectionRef.current;
    const size = editor.state.doc.content.size;
    // Clamp defensively: the doc cannot change while the native picker is open,
    // but a defensive clamp keeps this safe against any future listeners.
    editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
  };
  const applyTypographyFromSelect = (patch: Parameters<typeof updateTypography>[0]) => {
    restoreSelection();
    updateTypography(patch);
  };

  const canUndo = !disabled && !!editor?.can().undo();
  const canRedo = !disabled && !!editor?.can().redo();
  const headingActive = (level: 1 | 2 | 3) =>
    !disabled && !!editor?.isActive('heading', { level });

  return (
    <div
      className={cn(
        // Width stability (bug 4): the toolbar never shrinks or changes width
        // because of an active/disabled state. `shrink-0` keeps it from being
        // squeezed by the flex row; `whitespace-nowrap` prevents an inner wrap
        // from altering the row height mid-click. The children keep fixed box
        // sizes (the active state only changes background colour).
        'flex flex-nowrap items-center gap-0.5 whitespace-nowrap',
        className,
      )}
      role="toolbar"
      aria-label="Formatting"
    >
      {/* Font family — native <select>. We deliberately do NOT prevent its
          mousedown: doing so blocked the native dropdown (bug 1). The editor
          selection is snapshotted on focus and re-applied on change instead. */}
      <select
        aria-label="Font family"
        value={typography.fontFamily}
        disabled={disabled}
        onFocus={captureSelection}
        onMouseDown={captureSelection}
        onChange={(event) => applyTypographyFromSelect({ fontFamily: event.target.value as EditorFontFamily })}
        className="border-line bg-surface text-ink hover:bg-surface-muted focus-visible:border-accent h-7 w-20 shrink-0 rounded border px-1 text-2xs"
      >
        {FONT_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>

      {/* Font size — same native behaviour as the family select. Fixed width so
          the number of digits (13 vs 24) cannot reflow the toolbar. */}
      <select
        aria-label="Font size"
        value={typography.fontSize}
        disabled={disabled}
        onFocus={captureSelection}
        onMouseDown={captureSelection}
        onChange={(event) => applyTypographyFromSelect({ fontSize: Number(event.target.value) })}
        className="border-line bg-surface text-ink hover:bg-surface-muted focus-visible:border-accent h-7 w-14 shrink-0 rounded border px-1 text-2xs tabular-nums"
      >
        {FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>

      <Divider />

      <ToolbarButton
        label="Heading 1"
        active={headingActive(1)}
        disabled={disabled}
        onClick={() => run('heading-1')}
        icon={<Heading1 className="size-3.5" aria-hidden />}
        text="H1"
      />
      <ToolbarButton
        label="Heading 2"
        active={headingActive(2)}
        disabled={disabled}
        onClick={() => run('heading-2')}
        icon={<Heading2 className="size-3.5" aria-hidden />}
        text="H2"
      />
      <ToolbarButton
        label="Heading 3"
        active={headingActive(3)}
        disabled={disabled}
        onClick={() => run('heading-3')}
        icon={<Heading3 className="size-3.5" aria-hidden />}
        text="H3"
      />

      <Divider />

      <ToolbarButton
        label="Bold"
        active={!!editor?.isActive('bold')}
        disabled={disabled}
        onClick={() => run('bold')}
        icon={<Bold className="size-3.5" aria-hidden />}
      />
      <ToolbarButton
        label="Italic"
        active={!!editor?.isActive('italic')}
        disabled={disabled}
        onClick={() => run('italic')}
        icon={<Italic className="size-3.5" aria-hidden />}
      />

      <Divider />

      <ToolbarButton
        label="Undo"
        disabled={!canUndo}
        onClick={() => run('undo')}
        icon={<Undo2 className="size-3.5" aria-hidden />}
      />
      <ToolbarButton
        label="Redo"
        disabled={!canRedo}
        onClick={() => run('redo')}
        icon={<Redo2 className="size-3.5" aria-hidden />}
      />

      <Divider />

      {/* Slash — opens the SAME menu as typing `/` at the cursor. */}
      <ToolbarButton
        label="Insert command"
        hint="Type / for commands"
        disabled={disabled}
        onClick={onOpenSlashMenu}
        icon={<Slash className="size-3.5" aria-hidden />}
      />
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="bg-line mx-0.5 h-4 w-px shrink-0" />;
}

function ToolbarButton({
  label,
  hint,
  icon,
  text,
  active,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  icon: React.ReactNode;
  text?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={hint ? `${label} — ${hint}` : label}
      disabled={disabled}
      // Keep the editor focused: prevent the button from taking the caret so the
      // current selection survives the click and the command applies to it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        // Fixed box, identical in every state. The active/inactive classes below
        // only change colour — never width, padding, border or font — so toggling
        // a heading/bold state cannot resize the button or reflow the row (bug 4).
        // `shrink-0` stops the row's flex layout from compressing buttons.
        'inline-flex h-7 shrink-0 items-center justify-center gap-0.5 rounded px-1 text-2xs tabular-nums transition-colors',
        text ? 'min-w-9' : 'w-7',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'bg-accent-soft text-accent-soft-text'
          : 'text-muted hover:bg-surface-muted hover:text-ink',
      )}
    >
      {icon}
      {text ? <span className="tabular-nums">{text}</span> : null}
    </button>
  );
}
