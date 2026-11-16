import { useEffect, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Check, Flame, Pencil, Target, X } from 'lucide-react';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import type { DailyOutput } from '@/modules/dashboard/stats';
import type { WritingGoal } from '@/schemas/writing-goal';
import { MAX_DAILY_WORD_TARGET, MIN_DAILY_WORD_TARGET } from '@/schemas/writing-goal';

export interface WritingGoalCardProps {
  /** The persisted goal, or null when the author has not set one. */
  goal: WritingGoal | null;
  /** Words written today across all projects (real). */
  todayWords: number;
  /** Words written in the last 7 days across all projects (real). */
  weekWords: number;
  /** Last-7-days output series (real; zeros for days with no writing). */
  weekSeries: DailyOutput[];
  /** Longest recorded streak (real; 0 when none). */
  bestStreak: number;
  /** Current consecutive-day streak (real; 0 when none). */
  streak: number;
  /** True when any activity history exists (so we can label empty honestly). */
  hasActivityHistory: boolean;
  /** Persists a new daily target. */
  onSetGoal: (dailyWordTarget: number) => Promise<void>;
  /** True while a goal save is in flight. */
  saving?: boolean;
}

/**
 * Writing Goal card — REAL data only.
 *
 * - The daily target comes from the persisted workspace goal (`WritingGoal`),
 *   the SAME row the future Writing Goals page will read/write (shared source).
 * - "Today" / "This week" progress is computed from the real writing-activity
 *   ledger, not fabricated.
 * - When no goal exists, an inline editor invites the author to set one.
 * - When the author HAS a goal but no writing history exists yet, the bars show
 *   a genuine 0 with a clear "no writing recorded yet" note — never fake output.
 */
export function WritingGoalCard({
  goal,
  todayWords,
  weekWords,
  weekSeries,
  bestStreak,
  streak,
  hasActivityHistory,
  onSetGoal,
  saving = false,
}: WritingGoalCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Seed the editor input whenever we begin editing.
  useEffect(() => {
    if (editing) {
      setDraft(goal ? String(goal.dailyWordTarget) : '500');
      setLocalError(null);
    }
  }, [editing, goal]);

  const startEdit = () => setEditing(true);
  const cancelEdit = () => {
    setEditing(false);
    setLocalError(null);
  };

  const submit = async () => {
    const parsed = Number(draft.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      setLocalError('Enter a whole number of words.');
      return;
    }
    if (parsed < MIN_DAILY_WORD_TARGET || parsed > MAX_DAILY_WORD_TARGET) {
      setLocalError(
        `Target must be between ${MIN_DAILY_WORD_TARGET.toLocaleString()} and ${MAX_DAILY_WORD_TARGET.toLocaleString()}.`,
      );
      return;
    }
    try {
      await onSetGoal(parsed);
      setEditing(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not save the goal.');
    }
  };

  const dailyTarget = goal?.dailyWordTarget ?? 0;
  const dailyPercent = dailyTarget > 0 ? Math.min(100, Math.round((todayWords / dailyTarget) * 100)) : 0;
  // Weekly target = 7 × daily target (a derived, transparent figure).
  const weekTarget = dailyTarget * 7;
  const weekPercent = weekTarget > 0 ? Math.min(100, Math.round((weekWords / weekTarget) * 100)) : 0;

  return (
    <Card padding="md">
      <CardHeader
        title="Writing Goal"
        description={goal ? 'Daily and weekly progress' : 'No goal set yet'}
        icon={<Target className="size-4" />}
        action={
          goal && streak > 0 ? (
            <Badge tone="accent" dot>
              {streak}-day streak
            </Badge>
          ) : goal ? (
            <button
              type="button"
              onClick={startEdit}
              className="text-subtle hover:text-ink inline-flex items-center gap-1 text-2xs"
            >
              <Pencil className="size-3" aria-hidden />
              Edit target
            </button>
          ) : null
        }
      />

      {editing || !goal ? (
        <div className="mt-4 space-y-2">
          <label htmlFor="daily-word-target" className="text-muted block text-xs">
            Daily word target
          </label>
          <div className="flex items-center gap-2">
            <input
              id="daily-word-target"
              type="number"
              inputMode="numeric"
              min={MIN_DAILY_WORD_TARGET}
              max={MAX_DAILY_WORD_TARGET}
              step={50}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
                if (event.key === 'Escape') cancelEdit();
              }}
              className="border-line bg-surface text-ink focus:border-accent w-32 rounded-md border px-2 py-1 text-sm"
              aria-describedby={localError ? 'goal-error' : undefined}
            />
            <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving} iconLeft={<Check className="size-3.5" />}>
              {saving ? 'Saving…' : 'Save goal'}
            </Button>
            {goal ? (
              <Button variant="ghost" size="sm" onClick={cancelEdit} iconLeft={<X className="size-3.5" />}>
                Cancel
              </Button>
            ) : null}
          </div>
          {localError ? (
            <p id="goal-error" role="alert" className="text-danger text-2xs">
              {localError}
            </p>
          ) : (
            <p className="text-subtle text-2xs">
              Set a target and your real word output is tracked against it. Shared with the Writing
              Goals page.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-muted text-xs">Today</span>
                <span className="text-2xs text-subtle">
                  <span className="text-ink font-semibold">{todayWords.toLocaleString()}</span>
                  {' / '}
                  {dailyTarget.toLocaleString()} words
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
                  <span className="text-ink font-semibold">{weekWords.toLocaleString()}</span>
                  {' / '}
                  {weekTarget.toLocaleString()} words
                </span>
              </div>
              <div className="bg-surface-muted h-2 w-full overflow-hidden rounded-full">
                <div className="bg-accent-soft-text h-full rounded-full" style={{ width: `${weekPercent}%` }} />
              </div>
            </div>
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

          <div className="text-muted mt-3 flex items-center justify-between gap-1.5 border-t border-line pt-2.5 text-2xs">
            <span className="inline-flex items-center gap-1.5">
              <Flame className="text-warning size-3.5" aria-hidden />
              Best streak {bestStreak} {bestStreak === 1 ? 'day' : 'days'}
            </span>
            {!hasActivityHistory ? (
              <span className="text-subtle italic">No writing recorded yet</span>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}
