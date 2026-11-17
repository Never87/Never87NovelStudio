import type { CSSProperties, ReactNode } from 'react';
import type { EditorAppearance, EditorTypography } from '@/stores/story-editor-store';
import { cn } from '@/utils/cn';

/**
 * Applies the persisted Story Editor typography to the writing surface.
 *
 * The concrete styling lives in CSS (`.n87-prose-editor`); this component only
 * maps the `EditorTypography` preset onto the matching CSS custom properties via
 * an inline `style`. That keeps the wrap rules in one place (CSS) while letting
 * the author tune font family / size / leading / indent / measure at runtime.
 *
 * Separation of concerns:
 *   - Typography = how the text LOOKS (this component).
 *   - Document structure = what the editor STORES (never touched here).
 */
const FONT_STACKS: Record<EditorTypography['fontFamily'], string> = {
  serif: 'var(--font-serif)',
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',
};

const LINE_HEIGHTS: Record<EditorTypography['lineHeight'], number> = {
  compact: 1.5,
  normal: 1.7,
  relaxed: 1.95,
};

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
    ['--n87-editor-leading' as string]: String(LINE_HEIGHTS[typography.lineHeight]),
    ['--n87-editor-indent' as string]: typography.indent === 'first' ? '2em' : '0px',
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
