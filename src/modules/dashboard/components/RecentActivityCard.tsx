import type { LucideIcon } from 'lucide-react';
import { Activity, FolderPlus, PenLine } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui';
import type { RecentActivityEntry } from '@/services';
import { formatRelative } from '@/utils/date';

export interface RecentActivityCardProps {
  /** Real, timestamped events (newest first), derived from existing data. */
  entries: RecentActivityEntry[];
}

const ACTIVITY_ICONS: Record<RecentActivityEntry['kind'], { icon: LucideIcon; tone: string }> = {
  'project-created': { icon: FolderPlus, tone: 'bg-info-soft text-info' },
  'chapter-edited': { icon: PenLine, tone: 'bg-accent-soft text-accent-soft-text' },
  'version-saved': { icon: Activity, tone: 'bg-success-soft text-success' },
};

/**
 * Recent activity feed — REAL events only.
 *
 * Entries are derived from timestamps that already exist (project creation,
 * chapter-draft last edit, version snapshots). There is deliberately no
 * fabricated filler: with nothing recorded, an honest empty state is shown.
 */
export function RecentActivityCard({ entries }: RecentActivityCardProps) {
  return (
    <Card padding="md">
      <CardHeader
        title="Recent Activity"
        description="Your latest changes"
        icon={<Activity className="size-4" />}
      />

      {entries.length === 0 ? (
        <p className="text-subtle mt-3 text-xs italic">
          No activity yet. Creating a project or editing a chapter will show up here.
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {entries.map((entry) => {
            const meta = ACTIVITY_ICONS[entry.kind];
            const Icon = meta.icon;
            return (
              <li key={entry.id} className="flex items-start gap-2.5">
                <span className={`grid size-6 shrink-0 place-items-center rounded-md ${meta.tone}`}>
                  <Icon className="size-3" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-ink truncate text-xs">{entry.text}</p>
                  <p className="text-subtle text-2xs">
                    {entry.meta ? `${entry.meta} · ` : ''}
                    {formatRelative(entry.at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
