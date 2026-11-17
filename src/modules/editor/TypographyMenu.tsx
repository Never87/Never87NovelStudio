import { useEffect, useRef, useState } from 'react';
import { Check, Palette, RotateCcw } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
import {
  LINE_SPACING_MAX,
  LINE_SPACING_MIN,
  LINE_SPACING_STEP,
  useStoryEditorStore,
  type EditorAppearance,
} from '@/stores/story-editor-store';
import { cn } from '@/utils/cn';

/**
 * Story Editor typography controls.
 *
 * A small popover (no external dependency). Font family and font size now live
 * in the editor's minimal TOOLBAR, so this popover only tunes the writing
 * surface's LOOK — appearance, line spacing and measure. Every change writes
 * straight to the persisted `story-editor-store`, so the choice survives a
 * reload and applies to the SAME editor instance immediately (the CSS variables
 * are read by `.n87-prose-editor`); the editor is never remounted.
 */
const APPEARANCE_OPTIONS: Array<{ id: EditorAppearance; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'warm-paper', label: 'Warm Paper' },
];

export function TypographyMenu() {
  const typography = useStoryEditorStore((state) => state.typography);
  const updateTypography = useStoryEditorStore((state) => state.updateTypography);
  const resetTypography = useStoryEditorStore((state) => state.resetTypography);
  const editorAppearance = useStoryEditorStore((state) => state.editorAppearance);
  const setEditorAppearance = useStoryEditorStore((state) => state.setEditorAppearance);
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
        label="Editor appearance and typography"
        icon={<Palette className="size-3.5" aria-hidden />}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div
          role="dialog"
          aria-label="Editor appearance and typography"
          className="bg-surface shadow-[var(--n87-shadow-popover)] absolute right-0 top-9 z-40 w-64 space-y-3 rounded-lg border border-line p-3"
        >
          <Segmented
            label="Appearance"
            options={APPEARANCE_OPTIONS}
            value={editorAppearance}
            onChange={setEditorAppearance}
          />

          {/* Continuous 1.0–2.5 line spacing in 0.1 steps. The numeric value is
              always displayed so the author can read the exact multiplier. */}
          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="n87-line-spacing"
                className="text-subtle text-2xs font-medium uppercase tracking-wide"
              >
                Line spacing
              </label>
              <output
                htmlFor="n87-line-spacing"
                aria-live="polite"
                className="text-muted text-2xs tabular-nums"
              >
                {typography.lineHeight.toFixed(1)}
              </output>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                aria-label="Decrease line spacing"
                onClick={() =>
                  updateTypography({ lineHeight: typography.lineHeight - LINE_SPACING_STEP })
                }
                className="border-line text-muted hover:bg-surface-muted hover:text-ink grid size-6 shrink-0 place-items-center rounded border text-xs"
              >
                −
              </button>
              <input
                id="n87-line-spacing"
                type="range"
                min={LINE_SPACING_MIN}
                max={LINE_SPACING_MAX}
                step={LINE_SPACING_STEP}
                value={typography.lineHeight}
                onChange={(event) => updateTypography({ lineHeight: Number(event.target.value) })}
                aria-valuetext={`${typography.lineHeight.toFixed(1)} times line spacing`}
                className="accent-accent w-full"
              />
              <button
                type="button"
                aria-label="Increase line spacing"
                onClick={() =>
                  updateTypography({ lineHeight: typography.lineHeight + LINE_SPACING_STEP })
                }
                className="border-line text-muted hover:bg-surface-muted hover:text-ink grid size-6 shrink-0 place-items-center rounded border text-xs"
              >
                +
              </button>
            </div>
          </div>

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
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<RotateCcw className="size-3" />}
              onClick={resetTypography}
            >
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
