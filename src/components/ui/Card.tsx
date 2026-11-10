import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/utils/cn';

type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5 sm:p-6',
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  /** Adds hover affordance for clickable cards. */
  interactive?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Neutral surface container — flat, 1px border, small radius, minimal shadow.
 * This is the only component that should own the card surface treatment.
 */
export function Card({ padding = 'md', interactive, className, children, ref, ...rest }: CardProps) {
  return (
    <div
      ref={ref}
      className={cn(
        'bg-surface rounded-lg border border-line',
        interactive &&
          'transition-colors duration-150 hover:border-line-strong hover:bg-surface-muted/60 focus-within:border-accent-ring',
        PADDING_CLASSES[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, action, icon, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="text-accent mt-0.5 shrink-0">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-ink truncate text-sm font-semibold">{title}</h2>
          {description ? <p className="text-muted mt-0.5 text-xs">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mt-3', className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mt-4 flex items-center justify-between gap-3 border-t border-line pt-3', className)}>
      {children}
    </div>
  );
}
