import { BookOpen, CalendarDays, PenLine, Plus, TrendingUp } from 'lucide-react';
import { ButtonLink, Card, CardHeader, EmptyState } from '@/components/ui';
import type { ContinueWritingTarget } from '@/services';
import { formatRelative } from '@/utils/date';

export interface ContinueWritingCardProps {
  /** Where to resume writing, derived from REAL data. Null when nothing to open. */
  target: ContinueWritingTarget | null;
  /** Whole-workspace words, for the "total so far" hint. */
  wordsWritten: number;
}

/**
 * Continue Writing — the primary action surface.
 *
 * Driven entirely by REAL data: it resumes the most recently edited project and
 * chapter (see `WritingStatsService.pickContinueTarget`). The action deep-links
 * to the project's Writing tab with the exact chapter pre-selected
 * (`?tab=writing&chapter=<id>`), so the editor opens the right chapter — not just
 * the project. When there is nothing to resume (no projects, or no chapters yet)
 * it shows an honest empty state instead of a fabricated novel.
 */
export function ContinueWritingCard({ target, wordsWritten }: ContinueWritingCardProps) {
  if (!target) {
    return (
      <Card padding="lg">
        <CardHeader
          title="Continue Writing"
          description="Pick up where you left off"
          icon={<PenLine className="size-4" />}
        />
        <div className="mt-4">
          <EmptyState
            variant="plain"
            icon={<BookOpen className="size-5" aria-hidden />}
            title="Nothing to resume yet"
            description="Create a project, add a chapter in its Outline, and your most recent draft will appear here ready to continue."
            action={
              <ButtonLink to="/projects" size="sm" variant="primary" iconLeft={<Plus className="size-3.5" />}>
                Go to Projects
              </ButtonLink>
            }
          />
        </div>
      </Card>
    );
  }

  // Deep link opens the Writing tab on this exact chapter. When no chapter
  // exists yet, land on the project so the author can create one.
  const href = target.chapterId
    ? `/projects/${target.projectId}?tab=writing&chapter=${encodeURIComponent(target.chapterId)}`
    : `/projects/${target.projectId}`;

  return (
    <Card padding="lg" className="relative overflow-hidden">
      <div aria-hidden className="n87-grid-bg pointer-events-none absolute inset-x-0 top-0 h-24 opacity-60" />

      <div className="relative">
        <CardHeader
          title="Continue Writing"
          description="Pick up where you left off"
          icon={<PenLine className="size-4" />}
        />

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-subtle text-2xs font-medium uppercase tracking-wider">
              {target.chapterTitle ? 'Last edited chapter' : 'Project'}
            </p>
            <h3 className="text-ink truncate text-lg font-semibold">{target.projectTitle}</h3>
            <p className="text-muted mt-0.5 text-xs">
              {target.chapterTitle
                ? `“${target.chapterTitle}” — last edited ${formatRelative(target.updatedAt)}`
                : `No chapters written yet — add one to start. Last updated ${formatRelative(target.updatedAt)}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ButtonLink variant="secondary" size="sm" to={`/projects/${target.projectId}?tab=outline`}>
              Open Outline
            </ButtonLink>
            <ButtonLink
              variant="primary"
              size="sm"
              to={href}
              iconLeft={<PenLine className="size-3.5" />}
            >
              {target.chapterTitle ? 'Resume Writing' : 'Start Writing'}
            </ButtonLink>
          </div>
        </div>

        <div className="text-muted mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <TrendingUp className="text-subtle size-3.5" aria-hidden />
            {wordsWritten.toLocaleString()} words in your workspace
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="text-subtle size-3.5" aria-hidden />
            Updated {formatRelative(target.updatedAt)}
          </span>
        </div>
      </div>
    </Card>
  );
}
