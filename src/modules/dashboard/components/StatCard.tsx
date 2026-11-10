import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Card } from '@/components/ui';
import { cn } from '@/utils/cn';

export interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  /** Trend vs. previous period; omitted when there is nothing honest to show. */
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
}

const TREND_STYLES = {
  up: { Icon: ArrowUpRight, className: 'text-success' },
  down: { Icon: ArrowDownRight, className: 'text-warning' },
  flat: { Icon: Minus, className: 'text-subtle' },
} as const;

/** Compact metric tile used in the dashboard stat row. */
export function StatCard({ label, value, hint, icon: Icon, trend }: StatCardProps) {
  const trendStyle = trend ? TREND_STYLES[trend.direction] : null;

  return (
    <Card className="flex flex-col justify-between gap-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted text-xs font-medium">{label}</p>
        <span className="bg-surface-muted text-subtle grid size-7 shrink-0 place-items-center rounded-md border border-line">
          <Icon className="size-3.5" aria-hidden />
        </span>
      </div>

      <div>
        <p className="text-ink text-2xl font-semibold leading-none tracking-tight">{value}</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          {trendStyle && trend ? (
            <span className={cn('inline-flex items-center gap-0.5 text-2xs font-medium', trendStyle.className)}>
              <trendStyle.Icon className="size-3" aria-hidden />
              {trend.label}
            </span>
          ) : null}
          {hint ? <span className="text-subtle text-2xs">{hint}</span> : null}
        </div>
      </div>
    </Card>
  );
}
