import type { CSSProperties, ReactNode } from 'react';
import type { EditorAppearance, EditorTypography } from '@/stores/story-editor-store';
import { DEFAULT_LINE_SPACING } from '@/stores/story-editor-store';
import { cn } from '@/utils/cn';

/**
 * Applies the persisted Story Editor typography to the writing surface.
 *
 * The concrete styling lives in CSS (`.n87-prose-editor`); this component only
 * maps the `EditorTypography` onto the matching CSS custom properties via an
 * inline `style`. That keeps the wrap rules in one place (CSS) while letting
 * the author tune font family / size / leading / measure at runtime.
 *
 * Separation of concerns:
 *   - Typography = how the text LOOKS (this component).
 *   - Document structure = what the editor STORES (never touched here).
 *
 * These are CSS variables only, so changing them re-styles the SAME editor
 * instance — the editor is never remounted (no `key`, no document mutation).
 */
const FONT_STACKS: Record<EditorTypography['fontFamily'], string> = {
  serif: 'var(--font-serif)',
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
};

/** Legacy named presets are mapped in the store; here we only fall back safely. */
function resolveLineHeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LINE_SPACING;
}
export interface EditorSurfaceProps {
  typography: EditorTypography;
  /** Writing-surface appearance; drives the scoped Warm Paper token remap. */
  appearance?: EditorAppearance;
  children: ReactNode;
  className?: string;
}

export function EditorSurface({ typography, appearance = 'default', children, className }: EditorSurfaceProps) {
  const style: CSSProperties = {
    // Cast: CSS custom properties are not in React's typed CSSProperties.
    ['--n87-editor-font' as string]: FONT_STACKS[typography.fontFamily],
    ['--n87-editor-size' as string]: `${typography.fontSize}px`,
    ['--n87-editor-leading' as string]: String(resolveLineHeight(typography.lineHeight)),
    ['--n87-editor-measure' as string]: typography.maxWidth > 0 ? `${typography.maxWidth}px` : 'none',
  };

  return (
    <div
      data-editor-appearance={appearance}
      style={style}
      className={cn('n87-editor-surface flex min-h-0 flex-col', className)}
    >
      {children}
    </div>
  );
}

