import type { LucideIcon } from 'lucide-react';
import { Activity, FileUp, PenLine, Target, UserRound } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui';
import { DEMO_ACTIVITY, type DemoActivity } from '@/modules/dashboard/demo-data';

const ACTIVITY_ICONS: Record<DemoActivity['type'], { icon: LucideIcon; tone: string }> = {
  edit: { icon: PenLine, tone: 'bg-accent-soft text-accent-soft-text' },
  character: { icon: UserRound, tone: 'bg-info-soft text-info' },
  import: { icon: FileUp, tone: 'bg-warning-soft text-warning' },
  goal: { icon: Target, tone: 'bg-success-soft text-success' },
};

/** Recent activity feed (demo). */
export function RecentActivityCard() {
  return (
    <Card padding="md">
      <CardHeader
        title="Recent Activity"
        description="Your latest changes"
        icon={<Activity className="size-4" />}
      />

      <ol className="mt-3 space-y-3">
        {DEMO_ACTIVITY.map((entry) => {
          const meta = ACTIVITY_ICONS[entry.type];
          const Icon = meta.icon;
          return (
            <li key={entry.id} className="flex items-start gap-2.5">
              <span className={`grid size-6 shrink-0 place-items-center rounded-md ${meta.tone}`}>
                <Icon className="size-3" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-xs">{entry.text}</p>
                <p className="text-subtle text-2xs">
                  {entry.meta} · {entry.time}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
