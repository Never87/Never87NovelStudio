import { useEffect, useState, type ReactNode } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Check, Flame, Target, TrendingUp, X } from 'lucide-react';
import { Badge, Button, Card, CardHeader, PageHeader } from '@/components/ui';
import { useWorkspaceStats, useWritingGoal } from '@/hooks';
import { MAX_DAILY_WORD_TARGET, MIN_DAILY_WORD_TARGET } from '@/schemas/writing-goal';

/**
 * Writing Goals (Round 1 - Workspace, was PLACEHOLDER).
 *
 * Real goal CRUD (create / edit / clear) over the SAME persisted singleton the
 * Dashboard reads (`WritingGoalService`), so the two never disagree. Progress is
 * computed from the real writing-activity ledger via `useWorkspaceStats`.
 */
export function GoalsPage() {
  const { goal, loading, setGoal, clearGoal } = useWritingGoal();
  const { stats, refresh } = useWorkspaceStats();

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(goal ? String(goal.dailyWordTarget) : '500');
  }, [goal]);

  const save = async () => {
    setError(null);
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setError('Enter a whole number of words.');
      return;
    }
    if (parsed < MIN_DAILY_WORD_TARGET || parsed > MAX_DAILY_WORD_TARGET) {
      setError(
        `Target must be between ${MIN_DAILY_WORD_TARGET.toLocaleString()} and ${MAX_DAILY_WORD_TARGET.toLocaleString()}.`,
      );
      return;
    }
    setSaving(true);
    try {
      await setGoal(parsed);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the goal.');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      await clearGoal();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear the goal.');
    } finally {
      setSaving(false);
    }
  };

  const dailyTarget = goal?.dailyWordTarget ?? 0;
  const todayWords = stats?.totals.todayWords ?? 0;
  const weekWords = stats?.totals.weekWords ?? 0;
  const weekTarget = dailyTarget * 7;
  const dailyPercent = dailyTarget > 0 ? Math.min(100, Math.round((todayWords / dailyTarget) * 100)) : 0;
  const weekPercent = weekTarget > 0 ? Math.min(100, Math.round((weekWords / weekTarget) * 100)) : 0;
  const streak = stats?.totals.writingStreak ?? 0;
  const bestStreak = stats?.totals.bestStreak ?? 0;
  const weekSeries = stats?.weekSeries ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Target className="size-4" />}
        eyebrow="Workspace"
        title="Writing Goals"
        description="Set a daily word target, track your streak and see real progress from your writing."
        actions={
          goal ? (
            <Badge tone="accent" dot>
              {dailyTarget.toLocaleString()} words / day
            </Badge>
          ) : (
            <Badge tone="warning" dot>
              No goal set
            </Badge>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        {/* Goal editor */}
        <Card padding="md">
          <CardHeader
            title={goal ? 'Edit daily goal' : 'Set a daily goal'}
            description="Shared with the Dashboard goal card"
            icon={<Target className="size-4" />}
          />
          <div className="mt-4 space-y-2">
            <label htmlFor="goal-input" className="text-muted block text-xs">
              Daily word target
            </label>
            <div className="flex items-center gap-2">
              <input
                id="goal-input"
                type="number"
                inputMode="numeric"
                min={MIN_DAILY_WORD_TARGET}
                max={MAX_DAILY_WORD_TARGET}
                step={50}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
                className="border-line bg-surface text-ink focus:border-accent w-32 rounded-md border px-2 py-1.5 text-sm"
              />
              <Button variant="primary" size="sm" onClick={() => void save()} loading={saving || loading} iconLeft={<Check className="size-3.5" />}>
                Save goal
              </Button>
              {goal ? (
                <Button variant="ghost" size="sm" onClick={() => void clear()} disabled={saving} iconLeft={<X className="size-3.5" />}>
                  Clear
                </Button>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="text-danger text-2xs">
                {error}
              </p>
            ) : (
              <p className="text-subtle text-2xs">
                A realistic daily target builds a sustainable writing habit. You can change or clear it
                at any time.
              </p>
            )}
          </div>

          <div className="border-line mt-4 grid grid-cols-2 gap-3 border-t pt-3">
            <Stat label="Current streak" value={`${streak} ${streak === 1 ? 'day' : 'days'}`} icon={<Flame className="text-warning size-3.5" />} />
            <Stat label="Best streak" value={`${bestStreak} ${bestStreak === 1 ? 'day' : 'days'}`} icon={<TrendingUp className="size-3.5" />} />
          </div>
        </Card>

        {/* Progress */}
        <Card padding="md">
          <CardHeader title="Progress" description="Real output against your targets" icon={<TrendingUp className="size-4" />} />
          {goal ? (
            <>
              <div className="mt-4 space-y-3">
                <Progress label="Today" current={todayWords} target={dailyTarget} percent={dailyPercent} />
                <Progress label="This week" current={weekWords} target={weekTarget} percent={weekPercent} />
              </div>
              <div className="mt-4 h-28 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weekSeries} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <XAxis
                      dataKey="label"
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
            </>
          ) : (
            <p className="text-muted mt-4 text-sm">
              Set a daily goal to start tracking progress. Your real word output will be measured against
              it automatically as you write.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

function Progress({ label, current, target, percent }: { label: string; current: number; target: number; percent: number }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-muted text-xs">{label}</span>
        <span className="text-2xs text-subtle">
          <span className="text-ink font-semibold">{current.toLocaleString()}</span>
          {' / '}
          {target.toLocaleString()} words
        </span>
      </div>
      <div className="bg-surface-muted h-2 w-full overflow-hidden rounded-full">
        <div className="bg-accent h-full rounded-full" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div>
      <div className="text-subtle flex items-center gap-1 text-2xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-ink mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}
