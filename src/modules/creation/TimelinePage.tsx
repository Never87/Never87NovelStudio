import { useMemo } from 'react';
import { GitBranch } from 'lucide-react';
import { Badge, Card, EmptyState } from '@/components/ui';
import { ButtonLink } from '@/components/ui';
import { useContinuity, useOutline } from '@/hooks';
import { ProjectScopedPage } from '@/modules/creation/ProjectScopedPage';
import type { Chapter } from '@/types';
import type { ContinuityFact } from '@/schemas/continuity';

/**
 * Timeline (Round 1 — Novel Creation, was PLACEHOLDER).
 *
 * The story timeline is DERIVED from real, already-persisted data — no new
 * timeline table is introduced:
 *   - chapters come from the project outline (the canonical story ORDER),
 *   - events come from the continuity fact log, each anchored to a chapter
 *     (optionally a scene) and already ordered by story rank.
 *
 * So the Timeline is a faithful, read-only projection of what the author has
 * actually recorded, grouped by chapter in reading order. Editing facts happens
 * in the Continuity Manager (the single write path); the Timeline only reads.
 */
export function TimelinePage() {
  return (
    <ProjectScopedPage
      icon={<GitBranch className="size-4" />}
      eyebrow="Novel Creation"
      title="Timeline"
      description="Story events in reading order, derived from your outline and continuity facts."
    >
      {(projectId) => <TimelineView projectId={projectId} />}
    </ProjectScopedPage>
  );
}

function TimelineView({ projectId }: { projectId: string }) {
  const { outline, status: outlineStatus } = useOutline(projectId);
  const { facts, loading: factsLoading } = useContinuity(projectId);

  // Chapters in canonical order (volumes → chapters), carrying their volume title.
  const orderedChapters = useMemo(() => {
    const list: Array<{ chapter: Chapter; volumeTitle: string; index: number }> = [];
    let index = 0;
    for (const entry of outline) {
      for (const chapter of entry.chapters) {
        list.push({ chapter, volumeTitle: entry.volume.title, index: index++ });
      }
    }
    return list;
  }, [outline]);

  // Group facts by their anchor chapter.
  const factsByChapter = useMemo(() => {
    const map = new Map<string, ContinuityFact[]>();
    for (const fact of facts) {
      const list = map.get(fact.anchorChapterId) ?? [];
      list.push(fact);
      map.set(fact.anchorChapterId, list);
    }
    return map;
  }, [facts]);

  if (outlineStatus === 'loading' || factsLoading) {
    return (
      <Card padding="lg">
        <p className="text-subtle text-xs" role="status">
          Loading timeline…
        </p>
      </Card>
    );
  }

  if (orderedChapters.length === 0) {
    return (
      <EmptyState
        icon={<GitBranch className="size-5" aria-hidden />}
        title="No chapters yet"
        description="The timeline is built from your outline. Add volumes and chapters, then record continuity facts to see events appear in story order."
        action={
          <ButtonLink variant="primary" size="sm" to={`/novel/outline?project=${projectId}`}>
            Build the outline
          </ButtonLink>
        }
      />
    );
  }

  const totalEvents = facts.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral" size="md">
          {orderedChapters.length} {orderedChapters.length === 1 ? 'chapter' : 'chapters'}
        </Badge>
        <Badge tone={totalEvents > 0 ? 'accent' : 'neutral'} size="md">
          {totalEvents} {totalEvents === 1 ? 'event' : 'events'}
        </Badge>
        <span className="text-subtle text-2xs">
          Events are continuity facts anchored to chapters. Manage them in the{' '}
          <ButtonLink variant="ghost" size="sm" to={`/ai/continuity-manager?project=${projectId}`}>
            Continuity Manager
          </ButtonLink>
          .
        </span>
      </div>

      <ol className="relative space-y-3 border-l border-line pl-5">
        {orderedChapters.map(({ chapter, volumeTitle, index }) => {
          const chapterFacts = factsByChapter.get(chapter.id) ?? [];
          return (
            <li key={chapter.id} className="relative">
              <span
                className="bg-accent absolute -left-[27px] top-1.5 size-2.5 rounded-full ring-4 ring-surface"
                aria-hidden
              />
              <Card padding="sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-ink truncate text-sm font-semibold">
                      <span className="text-subtle mr-1 tabular-nums">{index + 1}.</span>
                      {chapter.title}
                    </h3>
                    <p className="text-subtle text-2xs">{volumeTitle}</p>
                  </div>
                  {chapterFacts.length > 0 ? (
                    <Badge tone="accent" size="sm" dot>
                      {chapterFacts.length} {chapterFacts.length === 1 ? 'event' : 'events'}
                    </Badge>
                  ) : (
                    <span className="text-subtle text-2xs italic">No recorded events</span>
                  )}
                </div>

                {chapterFacts.length > 0 ? (
                  <ul className="border-line mt-2 space-y-1.5 border-t pt-2">
                    {chapterFacts.map((fact) => (
                      <li key={fact.id} className="flex items-start gap-2 text-xs">
                        <span className="bg-line-strong mt-1.5 size-1 shrink-0 rounded-full" aria-hidden />
                        <span className="text-muted">
                          <FactText fact={fact} />
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Human-readable one-line description of a continuity fact. */
function FactText({ fact }: { fact: ContinuityFact }) {
  const subject = fact.subjectLabel || fact.subjectId || 'A subject';
  switch (fact.predicate) {
    case 'position':
      return (
        <>
          <strong className="text-ink">{subject}</strong> is at {fact.value}
        </>
      );
    case 'possession':
      return (
        <>
          <strong className="text-ink">{subject}</strong> holds {fact.value}
        </>
      );
    case 'knowledge':
      return (
        <>
          <strong className="text-ink">{subject}</strong> learns {fact.value}
        </>
      );
    case 'relationship':
      return (
        <>
          <strong className="text-ink">{subject}</strong> {fact.value}
          {fact.relatedLabel ? <> with {fact.relatedLabel}</> : null}
        </>
      );
    case 'status':
      return (
        <>
          <strong className="text-ink">{subject}</strong> is {fact.value}
        </>
      );
    case 'attribute':
      return (
        <>
          <strong className="text-ink">{subject}</strong>: {fact.value}
        </>
      );
    default:
      return (
        <>
          <strong className="text-ink">{subject}</strong>: {fact.value}
        </>
      );
  }
}
