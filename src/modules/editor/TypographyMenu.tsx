import { useEffect, useRef, useState } from 'react';
import { Check, Type } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import {
  useStoryEditorStore,
  type EditorFontFamily,
  type EditorIndent,
  type EditorLineHeight,
} from '@/stores/story-editor-store';
import { cn } from '@/utils/cn';

/**
 * Story Editor typography controls.
 *
 * A small popover (no external dependency) that adjusts the writing surface's
 * font family, size, line spacing, indentation and measure. Every change writes
 * straight to the persisted `story-editor-store`, so the choice survives a
 * reload and applies to the SAME editor instance immediately (the CSS variables
 * are read by `.n87-prose-editor`).
 */
const FONT_OPTIONS: Array<{ id: EditorFontFamily; label: string }> = [
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans' },
  { id: 'mono', label: 'Mono' },
];

const LINE_OPTIONS: Array<{ id: EditorLineHeight; label: string }> = [
  { id: 'compact', label: 'Compact' },
  { id: 'normal', label: 'Normal' },
  { id: 'relaxed', label: 'Relaxed' },
];

const INDENT_OPTIONS: Array<{ id: EditorIndent; label: string }> = [
  { id: 'none', label: 'Flush' },
  { id: 'first', label: 'First-line' },
];

export function TypographyMenu() {
  const typography = useStoryEditorStore((state) => state.typography);
  const updateTypography = useStoryEditorStore((state) => state.updateTypography);
  const resetTypography = useStoryEditorStore((state) => state.resetTypography);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <IconButton
        label="Editor typography"
        icon={<Type className="size-3.5" aria-hidden />}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div
          role="dialog"
          aria-label="Editor typography"
          className="bg-surface shadow-[var(--n87-shadow-popover)] absolute right-0 top-9 z-40 w-64 space-y-3 rounded-lg border border-line p-3"
        >
          <Segmented
            label="Font"
            options={FONT_OPTIONS}
            value={typography.fontFamily}
            onChange={(fontFamily) => updateTypography({ fontFamily })}
          />

          <div>
            <div className="flex items-center justify-between">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Size</span>
              <span className="text-muted text-2xs tabular-nums">{typography.fontSize}px</span>
            </div>
            <input
              type="range"
              min={13}
              max={24}
              step={1}
              value={typography.fontSize}
              onChange={(event) => updateTypography({ fontSize: Number(event.target.value) })}
              aria-label="Font size"
              className="accent-accent mt-1 w-full"
            />
          </div>

          <Segmented
            label="Line spacing"
            options={LINE_OPTIONS}
            value={typography.lineHeight}
            onChange={(lineHeight) => updateTypography({ lineHeight })}
          />
          <Segmented
            label="Indent"
            options={INDENT_OPTIONS}
            value={typography.indent}
            onChange={(indent) => updateTypography({ indent })}
          />

          <div>
            <div className="flex items-center justify-between">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Text width
              </span>
              <span className="text-muted text-2xs tabular-nums">
                {typography.maxWidth > 0 ? `${typography.maxWidth}px` : 'Full'}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1000}
              step={20}
              value={typography.maxWidth}
              onChange={(event) => updateTypography({ maxWidth: Number(event.target.value) })}
              aria-label="Text width"
              className="accent-accent mt-1 w-full"
            />
          </div>

          <div className="border-line flex justify-end border-t pt-2">
            <Button variant="ghost" size="sm" onClick={resetTypography}>
              Reset
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <span className="text-subtle text-2xs font-medium uppercase tracking-wide">{label}</span>
      <div className="mt-1 flex gap-1" role="group" aria-label={label}>
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              aria-pressed={selected}
              className={cn(
                'inline-flex flex-1 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-2xs transition-colors',
                selected
                  ? 'border-accent-ring bg-accent-soft text-accent-soft-text'
                  : 'border-line text-muted hover:bg-surface-muted hover:text-ink',
              )}
            >
              {selected ? <Check className="size-3" aria-hidden /> : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
