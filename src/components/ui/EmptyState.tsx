import type { ButtonSize, ButtonVariant } from './Button';
import { buttonClassName } from './Button';
import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Primary call to action (Button / ButtonLink). */
  action?: ReactNode;
  /** Secondary hint list, e.g. "what this page will do". */
  hints?: string[];
  /** `bordered` draws a dashed container; `plain` sits on any surface. */
  variant?: 'bordered' | 'plain';
  className?: string;
}

/**
 * Shared empty state. Used both by genuinely empty data views and by
 * "coming soon" placeholders so the product feels consistent before every
 * module ships.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  hints,
  variant = 'bordered',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-10 text-center',
        variant === 'bordered' && 'bg-surface-muted/50 rounded-lg border border-dashed border-line-strong',
        className,
      )}
    >
      {icon ? (
        <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
          {icon}
        </span>
      ) : null}
      <h3 className="text-ink text-sm font-semibold">{title}</h3>
      {description ? <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">{description}</p> : null}
      {hints && hints.length > 0 ? (
        <ul className="text-subtle mt-3 space-y-1 text-left text-xs">
          {hints.map((hint) => (
            <li key={hint} className="flex items-start gap-1.5">
              <span aria-hidden className="bg-line-strong mt-1.5 size-1 shrink-0 rounded-full" />
              <span>{hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export interface IconButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  label: string;
  icon: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
}

/** Square, icon-only button. `label` is required for accessibility. */
export function IconButton({ variant = 'ghost', size = 'md', label, icon, className, disabled, onClick }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={buttonClassName({ variant, size, className: cn('w-auto shrink-0 px-0', size === 'sm' ? 'size-8' : size === 'lg' ? 'size-10' : 'size-9', className) })}
    >
      {icon}
    </button>
  );
}
