import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Small kicker above the title, e.g. the parent section name. */
  eyebrow?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Tabs, filters or secondary row rendered under the title block. */
  toolbar?: ReactNode;
  className?: string;
}

/**
 * Standard page title block. Every module page must use this so headings,
 * spacing and action placement stay identical across the product.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  icon,
  actions,
  toolbar,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <span className="bg-accent-soft text-accent-soft-text mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg">
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-subtle text-2xs font-medium uppercase tracking-wider">{eyebrow}</p>
            ) : null}
            <h1 className="text-ink truncate text-lg font-semibold sm:text-xl">{title}</h1>
            {description ? (
              <p className="text-muted mt-1 max-w-2xl text-sm">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {toolbar ? <div className="border-line flex flex-wrap items-center gap-2 border-b pb-2">{toolbar}</div> : null}
    </header>
  );
}
