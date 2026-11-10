import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-muted border-line',
  accent: 'bg-accent-soft text-accent-soft-text border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export type BadgeVariant = 'soft' | 'outline';

export interface BadgeProps {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  dot?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
  title?: string;
}

/** Compact status / metadata label. */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'sm',
  dot,
  icon,
  className,
  children,
  title,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0.5 text-2xs' : 'px-2 py-0.5 text-xs',
        variant === 'outline' ? 'border-line-strong bg-transparent text-muted' : TONE_CLASSES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full',
            tone === 'success' && 'bg-success',
            tone === 'warning' && 'bg-warning',
            tone === 'danger' && 'bg-danger',
            tone === 'info' && 'bg-info',
            tone === 'accent' && 'bg-accent',
            tone === 'neutral' && 'bg-subtle',
          )}
        />
      ) : null}
      {icon}
      {children}
    </span>
  );
}
