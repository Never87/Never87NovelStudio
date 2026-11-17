import { useMemo, useRef, useState } from 'react';
import { History, Loader2, Sparkles, X, Check, ChevronDown, ChevronRight, Link2, Users, GitMerge, CopyCheck } from 'lucide-react';
import type { Chapter, ChapterAnalysisEntity, ChapterAnalysisRelationship, ChapterAnalysisRun } from '@/types';
import { useChapterAnalysis } from '@/hooks';
import type { CandidateIntegrationPreview, CanonicalMatch, IntegrationDecision } from '@/services';
import { Button, Badge } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { cn } from '@/utils/cn';

export interface ChapterAnalysisTabProps {
  projectId: string;
  chapter: Chapter;
  /** Current prose, shown to compute word count / a "stale" hint. */
  prose: string;
  /**
   * Save-first gate: flushes the editor's pending autosave and resolves once the
   * latest prose is PERSISTED, rejecting with an actionable error otherwise.
   * Analysis reads the persisted draft, so it MUST run only after this resolves.
   * When omitted (no live editor), analysis is disabled rather than analysing
   * stale prose.
   */
  beforeAnalyze?: () => Promise<void>;
}

/** Human label + tone for a candidate review status. */
function statusBadge(status: ChapterAnalysisEntity['status']): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'accepted':
      return { label: 'Accepted', tone: 'success' };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'danger' };
    default:
      return { label: 'Proposed', tone: 'neutral' };
  }
}

/**
 * Chapter Analysis tab (P11).
 *
 * Runs an AI entity-extraction pass over THIS chapter's prose and lets the
 * author review the candidates it proposes. Nothing here modifies the chapter or
 * any project entity — it reads prose, writes analysis RUNS, and lets the author
 * accept/dismiss/edit candidates. Candidates are grouped by kind, and
 * relationships reference entities by their stable key.
 *
 * The run is fingerprinted: re-analysing unchanged prose reuses the existing run
 * (no wasted AI calls); editing the prose and re-analysing creates a NEW run
 * while KEEPING the old ones as history (shown in the History section).
 */
export function ChapterAnalysisTab({ projectId, chapter, prose, beforeAnalyze }: ChapterAnalysisTabProps) {
  const {
    history,
    latest,
    status,
    analyzing,
    error,
    analyze,
    setCandidateStatus,
    updateRelationship,
    deleteRun,
    previewIntegration,
    applyIntegration,
  } = useChapterAnalysis(projectId, chapter.id);

  const [runError, setRunError] = useState<string | null>(null);
  const [reusedNotice, setReusedNotice] = useState(false);
  /** Per-candidate preview cache for the run currently being integrated. */
  const [previews, setPreviews] = useState<Record<string, CandidateIntegrationPreview>>({});
  /**
   * Guards against a second Analyze starting while one is in flight. The button
   * is also `disabled` while `analyzing`, but a rapid double click can land two
   * clicks before React re-renders, so a synchronous ref is the real gate.
   */
  const analyzeInFlight = useRef(false);
  /**
   * Guards against two integration decisions overlapping. Applying a decision
   * performs canonical writes; two overlapping applies for the same candidate
   * (e.g. a double click on "Create") could write twice. The ref makes the
   * second click a no-op until the first settles.
   */
  const integrateInFlight = useRef(false);

  const wordCount = useMemo(() => (prose.trim() ? prose.trim().split(/\s+/).length : 0), [prose]);

  const runAnalysis = async () => {
    if (analyzeInFlight.current) return;
    if (!beforeAnalyze) {
      setRunError('Open this chapter in the editor to analyse it — analysis needs the saved prose.');
      return;
    }
    analyzeInFlight.current = true;
    setRunError(null);
    setReusedNotice(false);
    try {
      // SAVE-FIRST: persist the latest editor content and only proceed once it
      // is durable. `analyze()` reads the PERSISTED draft, so running it before
      // the save resolves would fingerprint (and analyse) stale prose.
      await beforeAnalyze();
      const result = await analyze();
      setReusedNotice(result.reused);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Analysis failed.');
    } finally {
      analyzeInFlight.current = false;
    }
  };

  const act = async (operation: () => Promise<unknown>) => {
    setRunError(null);
    try {
      await operation();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Could not update candidate.');
    }
  };

  /** Loads integration previews for the latest run's accepted candidates. */
  const loadPreviews = async () => {
    if (!latest) return;
    setRunError(null);
    try {
      const list = await previewIntegration(latest.id);
      const map: Record<string, CandidateIntegrationPreview> = {};
      for (const preview of list) map[preview.key] = preview;
      setPreviews(map);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Could not prepare integration.');
    }
  };

  /** Applies one integration decision, then refreshes the preview map. */
  const integrate = async (decision: IntegrationDecision) => {
    if (!latest) return;
    // Serialise: ignore a second click while one decision is being applied, so a
    // double-click on "Create"/"Match" cannot write twice.
    if (integrateInFlight.current) return;
    integrateInFlight.current = true;
    try {
      await act(async () => {
        await applyIntegration(latest.id, decision);
        const list = await previewIntegration(latest.id);
        const map: Record<string, CandidateIntegrationPreview> = {};
        for (const preview of list) map[preview.key] = preview;
        setPreviews(map);
      });
    } finally {
      integrateInFlight.current = false;
    }
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="space-y-1.5">
        <p className="text-subtle text-2xs leading-relaxed">
          Extract the characters, places, factions, items and relationships this chapter contains.
          Review the proposals below — nothing is written to your story until you accept it.
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-subtle text-2xs tabular-nums">{wordCount} words</span>
          <Button
            type="button"
            size="sm"
            iconLeft={analyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            loading={analyzing}
            disabled={wordCount === 0 || analyzing || !beforeAnalyze}
            onClick={() => void runAnalysis()}
          >
            {latest ? 'Re-analyze' : 'Analyze chapter'}
          </Button>
        </div>
        {!beforeAnalyze ? (
          <p className="text-subtle text-2xs italic">
            Open this chapter in the editor to analyse it — analysis needs the saved prose.
          </p>
        ) : wordCount === 0 ? (
          <p className="text-subtle text-2xs italic">Write some prose first — there is nothing to analyse yet.</p>
        ) : null}
        {reusedNotice ? (
          <p className="text-subtle text-2xs italic">Prose unchanged — showing the existing analysis.</p>
        ) : null}
        {runError ? <p className="text-danger text-2xs">{runError}</p> : null}
        {error && !runError ? (
          <p className="text-danger text-2xs">
            {error instanceof Error ? error.message : 'Could not load chapter analysis.'}
          </p>
        ) : null}
      </div>

      {status === 'loading' && !latest ? (
        <p className="text-subtle text-2xs" role="status">Loading analysis…</p>
      ) : null}

      {latest ? (
        <RunView
          run={latest}
          previews={previews}
          onLoadPreviews={loadPreviews}
          onIntegrate={integrate}
          onAccept={(key) => act(() => setCandidateStatus(latest.id, key, 'accepted'))}
          onDismiss={(key) => act(() => setCandidateStatus(latest.id, key, 'dismissed'))}
          onReopen={(key) => act(() => setCandidateStatus(latest.id, key, 'proposed'))}
          onAcceptRelation={(key) => act(() => updateRelationship(latest.id, key, { status: 'accepted' }))}
          onDismissRelation={(key) => act(() => updateRelationship(latest.id, key, { status: 'dismissed' }))}
        />
      ) : status !== 'loading' ? (
        <div className="rounded-md border border-line p-2.5 text-center">
          <Sparkles className="text-subtle mx-auto mb-1 size-4" aria-hidden />
          <p className="text-subtle text-2xs">No analysis yet for this chapter.</p>
        </div>
      ) : null}

      {history.length > 1 ? (
        <HistorySection history={history} onDelete={(runId) => act(() => deleteRun(runId))} />
      ) : null}
    </div>
  );
}

/* -------------------------------- Run view ------------------------------- */

function RunView({
  run,
  previews,
  onLoadPreviews,
  onIntegrate,
  onAccept,
  onDismiss,
  onReopen,
  onAcceptRelation,
  onDismissRelation,
}: {
  run: ChapterAnalysisRun;
  previews: Record<string, CandidateIntegrationPreview>;
  onLoadPreviews: () => void;
  onIntegrate: (decision: IntegrationDecision) => void;
  onAccept: (key: string) => void;
  onDismiss: (key: string) => void;
  onReopen: (key: string) => void;
  onAcceptRelation: (key: string) => void;
  onDismissRelation: (key: string) => void;
}) {
  const accepted = run.entities.filter((entity) => entity.status === 'accepted').length;
  const proposed = run.entities.filter((entity) => entity.status === 'proposed').length;
  const hasPreviews = Object.keys(previews).length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone="accent" icon={<Sparkles className="size-3" aria-hidden />}>
          {run.entities.length} entities
        </Badge>
        <Badge tone="info">{run.relationships.length} relationships</Badge>
        {proposed > 0 ? <Badge tone="neutral">{proposed} to review</Badge> : null}
        {accepted > 0 ? <Badge tone="success">{accepted} accepted</Badge> : null}
      </div>

      {accepted > 0 ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5">
          <p className="text-subtle text-2xs">
            {hasPreviews ? 'Choose how each accepted item joins your story.' : 'Ready to add accepted items to your story?'}
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            iconLeft={<GitMerge className="size-3" />}
            onClick={onLoadPreviews}
          >
            {hasPreviews ? 'Refresh' : 'Integrate'}
          </Button>
        </div>
      ) : null}

      {run.entities.length === 0 ? (
        <p className="text-subtle text-2xs italic">
          The model found no clear entities. Try adding more prose or a focus instruction.
        </p>
      ) : (
        <EntityGroups
          run={run}
          previews={previews}
          onIntegrate={onIntegrate}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onReopen={onReopen}
        />
      )}

      {run.relationships.length > 0 ? (
        <RelationList run={run} onAccept={onAcceptRelation} onDismiss={onDismissRelation} />
      ) : null}
    </div>
  );
}

/* ------------------------------ Entity groups ---------------------------- */

function EntityGroups({
  run,
  previews,
  onIntegrate,
  onAccept,
  onDismiss,
  onReopen,
}: {
  run: ChapterAnalysisRun;
  previews: Record<string, CandidateIntegrationPreview>;
  onIntegrate: (decision: IntegrationDecision) => void;
  onAccept: (key: string) => void;
  onDismiss: (key: string) => void;
  onReopen: (key: string) => void;
}) {
  const groups = useMemo(() => {
    const byKind = new Map<string, ChapterAnalysisEntity[]>();
    for (const entity of run.entities) {
      const list = byKind.get(entity.kind) ?? [];
      list.push(entity);
      byKind.set(entity.kind, list);
    }
    return Array.from(byKind.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [run.entities]);

  return (
    <div className="space-y-2">
      {groups.map(([kind, entities]) => (
        <div key={kind}>
          <h4 className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">
            {kind} <span className="tabular-nums">·&nbsp;{entities.length}</span>
          </h4>
          <ul className="space-y-1">
            {entities.map((entity) => (
              <li key={entity.key}>
                <EntityRow
                  entity={entity}
                  preview={previews[entity.key]}
                  onIntegrate={onIntegrate}
                  onAccept={onAccept}
                  onDismiss={onDismiss}
                  onReopen={onReopen}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function EntityRow({
  entity,
  preview,
  onIntegrate,
  onAccept,
  onDismiss,
  onReopen,
}: {
  entity: ChapterAnalysisEntity;
  preview?: CandidateIntegrationPreview;
  onIntegrate: (decision: IntegrationDecision) => void;
  onAccept: (key: string) => void;
  onDismiss: (key: string) => void;
  onReopen: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = statusBadge(entity.status);
  const hasDetail = Boolean(entity.summary || entity.detail || entity.tags.length > 0);
  const integration = entity.integration;

  return (
    <div className="rounded-md border border-line">
      <div className="flex items-start justify-between gap-1.5 p-1.5">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((value) => !value)}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
          disabled={!hasDetail}
        >
          <span className="text-ink inline-flex items-center gap-1 text-2xs font-semibold">
            {hasDetail ? (
              expanded ? (
                <ChevronDown className="text-subtle size-3 shrink-0" aria-hidden />
              ) : (
                <ChevronRight className="text-subtle size-3 shrink-0" aria-hidden />
              )
            ) : (
              <Users className="text-subtle size-3 shrink-0" aria-hidden />
            )}
            <span className="truncate">{entity.name}</span>
          </span>
          {entity.summary ? <span className="text-subtle mt-0.5 block truncate text-2xs">{entity.summary}</span> : null}
        </button>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      {expanded && hasDetail ? (
        <div className="border-line space-y-1 border-t px-1.5 py-1.5">
          {entity.detail ? <p className="text-muted text-2xs leading-relaxed whitespace-pre-wrap">{entity.detail}</p> : null}
          {entity.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {entity.tags.map((tag) => (
                <span key={tag} className="bg-surface-muted text-subtle rounded px-1 py-0.5 text-2xs">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="border-line flex items-center justify-end gap-1 border-t px-1.5 py-1">
        {entity.status === 'proposed' ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              iconLeft={<X className="size-3" />}
              onClick={() => onDismiss(entity.key)}
            >
              Dismiss
            </Button>
            <Button
              type="button"
              size="sm"
              iconLeft={<Check className="size-3" />}
              onClick={() => onAccept(entity.key)}
            >
              Accept
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={() => onReopen(entity.key)}>
            Reopen
          </Button>
        )}
      </div>

      {/* Integration panel: only for ACCEPTED candidates, once previews loaded. */}
      {entity.status === 'accepted' ? (
        <IntegrationPanel entity={entity} preview={preview} integration={integration} onIntegrate={onIntegrate} />
      ) : null}
    </div>
  );
}

/* --------------------------- Integration panel --------------------------- */

/** Label + tone for an integration state. */
function integrationBadge(
  status: string,
  canonicalLabel: 'character' | 'knowledge-entry',
): { label: string; tone: BadgeTone } {
  const noun = canonicalLabel === 'character' ? 'Character' : 'Entry';
  switch (status) {
    case 'matched':
      return { label: `Matched ${noun}`, tone: 'success' };
    case 'created':
      return { label: `Created ${noun}`, tone: 'accent' };
    case 'deferred':
      return { label: 'Deferred', tone: 'neutral' };
    case 'uncertain':
      return { label: 'Needs review', tone: 'warning' };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'danger' };
    default:
      return { label: 'Not added', tone: 'neutral' };
  }
}

/**
 * The integration affordance for ONE accepted candidate.
 *
 * Shows the current integration state. When it has not yet been integrated (or
 * is only `uncertain`/`deferred`) it offers: match an existing canonical entity
 * (one button per suggested match), create a new entity, flag a POSSIBLE
 * DUPLICATE, defer, or dismiss. The author's explicit click is the only thing
 * that writes to the story model — detection is surfaced, never auto-applied.
 */
function IntegrationPanel({
  entity,
  preview,
  integration,
  onIntegrate,
}: {
  entity: ChapterAnalysisEntity;
  preview?: CandidateIntegrationPreview;
  integration: ChapterAnalysisEntity['integration'];
  onIntegrate: (decision: IntegrationDecision) => void;
}) {
  const isResolved = integration.status === 'matched' || integration.status === 'created';
  const badge = integrationBadge(integration.status, integration.canonicalType === 'character' ? 'character' : 'knowledge-entry');
  // The possible-duplicate the author already flagged (persisted on the run).
  const flaggedDuplicateId = integration.possibleDuplicateId;
  const flaggedDuplicateLabel = integration.possibleDuplicateLabel;

  if (isResolved) {
    return (
      <div className="border-line flex items-center justify-between gap-1 border-t px-1.5 py-1">
        <span className="text-subtle text-2xs">In your story</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
    );
  }

  // Preview not loaded yet: prompt to integrate.
  if (!preview) {
    return (
      <div className="border-line border-t px-1.5 py-1">
        <p className="text-subtle text-2xs italic">Use “Integrate” above to link or create this item.</p>
      </div>
    );
  }

  const exactMatches = preview.matches.filter((m) => m.matchedBy === 'exact');
  const aliasMatches = preview.matches.filter((m) => m.matchedBy === 'alias');
  const noun = preview.targetCanonicalType === 'character' ? 'character' : 'entry';

  return (
    <div className="border-line space-y-1.5 border-t px-1.5 py-1.5">
      {preview.unsupported ? (
        <p className="text-subtle text-2xs italic">No verbatim evidence found in this chapter — review before adding.</p>
      ) : null}

      {preview.matches.length > 0 ? (
        <div className="space-y-1">
          <p className="text-subtle text-2xs">Link to an existing {noun}:</p>
          <div className="flex flex-wrap gap-1">
            {[...exactMatches, ...aliasMatches].map((match) => (
              <Button
                key={match.id}
                type="button"
                size="sm"
                variant="secondary"
                iconLeft={<Link2 className="size-3" />}
                onClick={() => onIntegrate({ key: entity.key, action: 'match', matchId: match.id })}
              >
                {match.label}
                {match.matchedBy === 'alias' ? <span className="text-subtle"> (alias)</span> : null}
              </Button>
            ))}
          </div>
          {preview.ambiguous ? (
            <p className="text-subtle text-2xs italic">Multiple possible matches — pick the right one.</p>
          ) : null}
        </div>
      ) : null}

      <PossibleDuplicatePicker
        preview={preview}
        flaggedId={flaggedDuplicateId}
        flaggedLabel={flaggedDuplicateLabel}
        onFlag={(match) =>
          onIntegrate({
            key: entity.key,
            action: 'uncertain',
            duplicateOfId: match.id,
            duplicateOfLabel: match.label,
          })
        }
        onClear={() =>
          onIntegrate({
            key: entity.key,
            action: 'uncertain',
            duplicateOfId: null,
            duplicateOfLabel: null,
          })
        }
      />

      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          iconLeft={<Check className="size-3" />}
          onClick={() => onIntegrate({ key: entity.key, action: 'create' })}
        >
          Create new {noun}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onIntegrate({ key: entity.key, action: 'defer' })}
        >
          Defer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onIntegrate({ key: entity.key, action: 'dismiss' })}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * Explicit "this might be the same as…" affordance.
 *
 * Lists the candidate's POSSIBLE DUPLICATES (alias-colliding canonical entities
 * plus same-name candidates in sibling analysis runs) with enough identity
 * context for the author to tell them apart (label + a one-line summary). Picking
 * one persists the reference via the `uncertain` integration action — it never
 * merges, overwrites, or creates a canonical entity. When a reference has already
 * been flagged it is shown back so the decision is visible after reload.
 */
function PossibleDuplicatePicker({
  preview,
  flaggedId,
  flaggedLabel,
  onFlag,
  onClear,
}: {
  preview: CandidateIntegrationPreview;
  flaggedId: string | null;
  flaggedLabel: string;
  onFlag: (match: CanonicalMatch) => void;
  onClear: () => void;
}) {
  const duplicates = preview.possibleDuplicates;

  if (flaggedId) {
    return (
      <div className="border-warning/40 bg-warning-soft/40 space-y-1 rounded border px-1.5 py-1">
        <p className="text-2xs font-medium text-warning inline-flex items-center gap-1">
          <CopyCheck className="size-3" aria-hidden />
          Flagged as possible duplicate
        </p>
        <p className="text-muted text-2xs">
          Might be the same as <span className="text-ink font-semibold">{flaggedLabel || flaggedId}</span>. Not merged — resolve manually.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={onClear}>
          Clear flag
        </Button>
      </div>
    );
  }

  if (duplicates.length === 0) return null;

  return (
    <div className="border-line space-y-1 rounded border px-1.5 py-1">
      <p className="text-subtle text-2xs inline-flex items-center gap-1">
        <CopyCheck className="size-3" aria-hidden />
        Possible duplicate{duplicates.length > 1 ? 's' : ''} — flag one for manual review:
      </p>
      <ul className="space-y-1">
        {duplicates.map((match) => (
          <li key={`${match.canonicalType}:${match.id}`} className="flex items-start justify-between gap-1.5">
            <div className="min-w-0">
              <p className="text-ink truncate text-2xs font-semibold">
                {match.label}
                <span className="text-subtle ml-1 font-normal">
                  {match.id.startsWith('run:') ? 'prior run' : match.canonicalType === 'character' ? 'character' : match.canonicalType === 'world-section' ? 'world section' : 'entry'}
                </span>
              </p>
              {match.summary ? <p className="text-subtle truncate text-2xs">{match.summary}</p> : null}
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              iconLeft={<CopyCheck className="size-3" />}
              onClick={() => onFlag(match)}
            >
              Flag
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------- Relations ------------------------------- */

function RelationList({
  run,
  onAccept,
  onDismiss,
}: {
  run: ChapterAnalysisRun;
  onAccept: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const nameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const entity of run.entities) map.set(entity.key, entity.name);
    return map;
  }, [run.entities]);

  return (
    <div>
      <h4 className="text-subtle mb-1 flex items-center gap-1 text-2xs font-medium uppercase tracking-wide">
        <Link2 className="size-3" aria-hidden />
        Relationships <span className="tabular-nums">·&nbsp;{run.relationships.length}</span>
      </h4>
      <ul className="space-y-1">
        {run.relationships.map((rel) => (
          <RelationshipRow
            key={rel.key}
            relationship={rel}
            fromName={nameByKey.get(rel.fromKey) ?? rel.fromKey}
            toName={nameByKey.get(rel.toKey) ?? rel.toKey}
            onAccept={onAccept}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </div>
  );
}

function RelationshipRow({
  relationship,
  fromName,
  toName,
  onAccept,
  onDismiss,
}: {
  relationship: ChapterAnalysisRelationship;
  fromName: string;
  toName: string;
  onAccept: (key: string) => void;
  onDismiss: (key: string) => void;
}) {
  const badge = statusBadge(relationship.status);
  return (
    <li className="rounded-md border border-line p-1.5">
      <div className="flex items-center justify-between gap-1.5">
        <p className="text-ink min-w-0 truncate text-2xs">
          <span className="font-semibold">{fromName}</span>
          <span className="text-subtle"> {relationship.relation} </span>
          <span className="font-semibold">{toName}</span>
        </p>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {relationship.status === 'proposed' ? (
        <div className="mt-1 flex items-center justify-end gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss(relationship.key)}>
            Dismiss
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => onAccept(relationship.key)}>
            Accept
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/* -------------------------------- History -------------------------------- */

function HistorySection({ history, onDelete }: { history: ChapterAnalysisRun[]; onDelete: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-line border-t pt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-subtle hover:text-ink flex w-full items-center gap-1 text-2xs font-medium"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
        <History className="size-3" aria-hidden />
        History <span className="tabular-nums">·&nbsp;{history.length} runs</span>
      </button>
      {open ? (
        <ul className="mt-1 space-y-1">
          {history.map((run, index) => (
            <li
              key={run.id}
              className={cn(
                'border-line flex items-center justify-between gap-1 rounded border px-1.5 py-1',
                index === 0 && 'bg-surface-muted/50',
              )}
            >
              <span className="text-muted min-w-0 truncate text-2xs">
                {index === 0 ? 'Current' : new Date(run.createdAt).toLocaleString()}
                <span className="text-subtle"> · {run.entities.length} entities</span>
              </span>
              {index !== 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  iconLeft={<X className="size-3" />}
                  onClick={() => onDelete(run.id)}
                  aria-label="Delete this analysis run"
                >
                  Delete
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
