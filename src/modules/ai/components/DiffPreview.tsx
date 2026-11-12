import { useMemo } from 'react';
import { diffWords, isIdentical } from '@/services';
import { cn } from '@/utils/cn';

/**
 * Side-by-side comparison of original vs generated text.
 *
 * Presentation only: it highlights word-level changes so the user can judge a
 * proposal before applying it. It decides nothing — applying is a separate,
 * explicit action in the editor.
 */
export interface DiffPreviewProps {
  original: string;
  revised: string;
  /** When true, show only the generated text (insert tasks have no "original"). */
  insertionOnly?: boolean;
  className?: string;
}

export function DiffPreview({ original, revised, insertionOnly, className }: DiffPreviewProps) {
  const identical = useMemo(() => isIdentical(original, revised), [original, revised]);
  const tokens = useMemo(() => (insertionOnly ? [] : diffWords(original, revised)), [original, revised, insertionOnly]);

  if (identical && !insertionOnly) {
    return (
      <p className={cn('text-subtle text-xs italic', className)}>The generated text is identical to the original.</p>
    );
  }

  if (insertionOnly) {
    return (
      <div className={cn('text-ink text-sm leading-7 whitespace-pre-wrap', className)}>
        <span className="bg-success-soft/70 rounded-sm">{revised}</span>
      </div>
    );
  }

  return (
    <div className={cn('text-ink text-sm leading-7 whitespace-pre-wrap', className)}>
      {tokens.map((token, index) => {
        if (token.op === 'equal') {
          return <span key={index}>{token.text}</span>;
        }
        if (token.op === 'insert') {
          return (
            <span key={index} className="bg-success-soft text-success rounded-sm">
              {token.text}
            </span>
          );
        }
        return (
          <span key={index} className="bg-danger-soft text-danger rounded-sm line-through">
            {token.text}
          </span>
        );
      })}
    </div>
  );
}
