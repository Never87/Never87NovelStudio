import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Flame, Target } from 'lucide-react';
import { Badge, Card, CardHeader } from '@/components/ui';
import { DEMO_GOAL, DEMO_WEEK_OUTPUT } from '@/modules/dashboard/demo-data';

/** Writing goal panel with a 7-day output bar chart. Demo data only. */
export function WritingGoalCard() {
  const dailyPercent = Math.min(
    100,
    Math.round((DEMO_GOAL.todayWritten / DEMO_GOAL.dailyTarget) * 100),
  );
  const weekPercent = Math.min(
    100,
    Math.round((DEMO_GOAL.weekWritten / DEMO_GOAL.weekTarget) * 100),
  );

  return (
    <Card padding="md">
      <CardHeader
        title="Writing Goal"
        description="Daily and weekly targets"
        icon={<Target className="size-4" />}
        action={
          <Badge tone="accent" dot>
            {DEMO_GOAL.streakDays}-day streak
          </Badge>
        }
      />

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-muted text-xs">Today</span>
            <span className="text-2xs text-subtle">
              <span className="text-ink font-semibold">{DEMO_GOAL.todayWritten.toLocaleString()}</span>
              {' / '}
              {DEMO_GOAL.dailyTarget.toLocaleString()} words
            </span>
          </div>
          <div className="bg-surface-muted h-2 w-full overflow-hidden rounded-full">
            <div className="bg-accent h-full rounded-full" style={{ width: `${dailyPercent}%` }} />
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-muted text-xs">This week</span>
            <span className="text-2xs text-subtle">
              <span className="text-ink font-semibold">{DEMO_GOAL.weekWritten.toLocaleString()}</span>
              {' / '}
              {DEMO_GOAL.weekTarget.toLocaleString()} words
            </span>
          </div>
          <div className="bg-surface-muted h-2 w-full overflow-hidden rounded-full">
            <div className="bg-accent-soft-text h-full rounded-full" style={{ width: `${weekPercent}%` }} />
          </div>
        </div>
      </div>

      <div className="mt-4 h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={DEMO_WEEK_OUTPUT} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: 'var(--n87-text-subtle)' }}
              dy={4}
            />
            <Tooltip
              cursor={{ fill: 'var(--n87-surface-muted)' }}
              contentStyle={{
                fontSize: 11,
                borderRadius: 8,
                border: '1px solid var(--n87-border)',
                background: 'var(--n87-surface)',
                color: 'var(--n87-text)',
              }}
              formatter={(value) => [`${Number(value ?? 0).toLocaleString()} words`, 'Output']}
            />
            <Bar dataKey="words" fill="var(--n87-accent)" radius={[3, 3, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="text-muted mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-2xs">
        <Flame className="text-warning size-3.5" aria-hidden />
        Best streak {DEMO_GOAL.bestStreak} days
      </div>
    </Card>
  );
}
