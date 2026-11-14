import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, GitCompare, Loader2, RefreshCw, SplitSquareHorizontal } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { ProjectPicker } from '@/modules/ai/components/ProjectPicker';
import { Select } from '@/modules/ai/components/fields';
import { diffWords, manuscriptHistoryService, type ManuscriptHistoryEntry } from '@/services';
import type { DiffToken } from '@/services';
import { useProjects } from '@/hooks';
import { formatRelative } from '@/utils/date';

/**
 * Sentinel version id for "the live draft", which is NOT a stored version.
 * Chosen so it can never collide with a real `dver_…` id.
 */
const CURRENT = '__current__';

interface VersionOption {
  id: string;
  label: string;
  content: string;
  wordCount: number;
  revision: number | null;
  createdAt: number | null;
}

/**
 * Diff Viewer (P9 B2).
 *
 * Compares two states of ONE manuscript — the live draft and/or any two stored
 * versions — using the same word-level `diffWords` engine the AI preview uses,
 * so what you see here matches how changes are presented everywhere else.
 *
 * Safety:
 *   - Both sides always come from the SAME draft (a single history entry), so an
 *     incompatible (cross-chapter / cross-project) comparison is impossible by
 *     construction.
 *   - The diff is rendered as React text nodes, never `dangerouslySetInnerHTML`,
 *     so manuscript content cannot inject markup.
 */
export function DiffViewerPage() {
  const { projects, initialLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const [entries, setEntries] = useState<ManuscriptHistoryEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'empty' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState('');
  const [leftId, setLeftId] = useState<string>(CURRENT);
  const [rightId, setRightId] = useState<string>(CURRENT);

  const load = useCallback(async () => {
    if (!effectiveProjectId) {
      setEntries([]);
      setStatus('idle');
      setSelectedDraftId('');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const history = await manuscriptHistoryService.listProjectHistory(effectiveProjectId);
      setEntries(history.entries);
      setStatus(history.entries.length > 0 ? 'success' : 'empty');
      setSelectedDraftId((current) =>
        history.entries.some((entry) => entry.draftId === current)
          ? current
          : (history.entries[0]?.draftId ?? ''),
      );
    } catch (err) {
      setEntries([]);
      setStatus('error');
      setError(err instanceof Error ? err.message : 'The manuscript could not be loaded.');
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => entries.find((entry) => entry.draftId === selectedDraftId) ?? null,
    [entries, selectedDraftId],
  );

  const options = useMemo<VersionOption[]>(() => {
    if (!selected) return [];
    return [
      {
        id: CURRENT,
        label: `Current draft (r${selected.currentRevision ?? 0})`,
        content: selected.currentContent,
        wordCount: selected.currentWordCount,
        revision: selected.currentRevision,
        createdAt: null,
      },
      ...selected.versions.map((version) => ({
        id: version.id,
        label: `r${version.revision} · ${version.reason}${version.label ? ` · ${version.label}` : ''} · ${formatRelative(version.createdAt)}`,
        content: version.content,
        wordCount: version.wordCount,
        revision: version.revision,
        createdAt: version.createdAt,
      })),
    ];
  }, [selected]);

  // When the manuscript changes, default to comparing the two NEWEST snapshots
  // (current vs. the latest historical version) — the most useful default.
  useEffect(() => {
    const latestVersion = selected?.versions[0];
    setLeftId(latestVersion ? latestVersion.id : CURRENT);
    setRightId(CURRENT);
  }, [selected]);

  const left = options.find((option) => option.id === leftId) ?? options[0] ?? null;
  const right = options.find((option) => option.id === rightId) ?? options[0] ?? null;

  const identical = left && right && left.content === right.content;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Diff Viewer"
        description="Compare the current draft with any saved version — or two versions with each other — at word level."
        icon={<GitCompare className="size-4" aria-hidden />}
        actions={
          <ProjectPicker projects={projects} value={effectiveProjectId} onChange={setProjectId} id="dv-project-picker" />
        }
      />

      {initialLoading ? (
        <Card padding="lg">
          <p className="text-subtle flex items-center gap-2 text-xs" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<GitCompare className="size-5" aria-hidden />}
          title="No projects yet"
          description="The Diff Viewer compares versions of a manuscript inside one project. Create a project first."
        />
      ) : (
        <Card padding="md" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="dv-manuscript" className="text-subtle text-2xs font-medium uppercase tracking-wide">
              Manuscript
            </label>
            <Select
              id="dv-manuscript"
              value={selectedDraftId}
              onChange={(event) => setSelectedDraftId(event.target.value)}
              className="min-w-56"
              disabled={entries.length === 0}
            >
              {entries.length === 0 ? <option value="">No manuscripts</option> : null}
              {entries.map((entry) => (
                <option key={entry.draftId} value={entry.draftId}>
                  {entry.kind === 'chapter' ? 'Chapter · ' : 'Scene · '}
                  {entry.ownerTitle}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<RefreshCw className="size-3.5" />}
              onClick={() => void load()}
              disabled={status === 'loading'}
            >
              Refresh
            </Button>
          </div>

          {status === 'error' ? (
            <p className="text-danger flex items-center gap-1.5 text-xs" role="alert">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          ) : status === 'loading' && entries.length === 0 ? (
            <p className="text-subtle flex items-center gap-2 text-xs" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading manuscript…
            </p>
          ) : status === 'empty' ? (
            <EmptyState
              icon={<GitCompare className="size-5" aria-hidden />}
              title="Nothing to compare"
              description="No chapter or scene prose exists in this project yet. Write some first."
            />
          ) : selected && left && right ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <VersionSelect label="Compare" value={leftId} options={options} onChange={setLeftId} id="dv-left" />
                <VersionSelect label="With" value={rightId} options={options} onChange={setRightId} id="dv-right" />
              </div>

              <div className="border-line flex flex-wrap items-center justify-between gap-2 rounded-md border bg-surface-muted/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-ink text-sm font-semibold">{selected.ownerTitle}</span>
                  <Badge tone={selected.kind === 'chapter' ? 'accent' : 'info'} size="sm">
                    {selected.kind}
                  </Badge>
                </div>
                {identical ? (
                  <Badge tone="success" size="sm">
                    Identical
                  </Badge>
                ) : (
                  <DiffSummary left={left} right={right} />
                )}
              </div>

              {identical ? (
                <p className="text-subtle text-xs italic">
                  These two selections contain exactly the same text.
                </p>
              ) : (
                <DiffBody key={`${selected.draftId}:${left.id}:${right.id}`} left={left} right={right} />
              )}
            </>
          ) : null}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function VersionSelect({
  label,
  value,
  options,
  onChange,
  id,
}: {
  label: string;
  value: string;
  options: VersionOption[];
  onChange: (id: string) => void;
  id: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-subtle text-2xs font-medium uppercase tracking-wide">
        {label}
      </label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Counts inserted/deleted words for the summary badge row. */
function DiffSummary({ left, right }: { left: VersionOption; right: VersionOption }) {
  const tokens = useMemo(() => diffWords(left.content, right.content), [left.content, right.content]);
  let inserted = 0;
  let deleted = 0;
  for (const token of tokens) {
    const words = token.text.trim() ? token.text.trim().split(/\s+/).length : 0;
    if (token.op === 'insert') inserted += words;
    else if (token.op === 'delete') deleted += words;
  }
  return (
    <span className="flex items-center gap-2 text-2xs tabular-nums">
      <span className="text-success">+{inserted}</span>
      <span className="text-danger">−{deleted}</span>
    </span>
  );
}

/** Renders the two sides with word-level highlighting. */
function DiffBody({ left, right }: { left: VersionOption; right: VersionOption }) {
  // `diffWords(left, right)`: equal = unchanged, delete = only in LEFT,
  // insert = only in RIGHT. We render two aligned columns from one diff so the
  // change relationships stay obvious.
  const tokens = useMemo(() => diffWords(left.content, right.content), [left.content, right.content]);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <DiffColumn
          heading={`${left.label}`}
          side="left"
          tokens={tokens}
        />
        <DiffColumn
          heading={`${right.label}`}
          side="right"
          tokens={tokens}
        />
      </div>
      <p className="text-subtle flex items-center gap-1.5 text-2xs">
        <SplitSquareHorizontal className="size-3" aria-hidden />
        <span className="text-danger">Red</span> = only in the left version ·{' '}
        <span className="text-success">Green</span> = only in the right version.
      </p>
    </div>
  );
}

function DiffColumn({
  heading,
  side,
  tokens,
}: {
  heading: string;
  side: 'left' | 'right';
  tokens: DiffToken[];
}) {
  // LEFT shows equal + delete; RIGHT shows equal + insert. A token that belongs
  // to the other side is simply omitted here, so each column shows only its own
  // text: the left column reconstructs the left version, the right the right.
  return (
    <div className="border-line rounded-md border">
      <div className="border-line bg-surface-muted/50 text-subtle truncate border-b px-3 py-1.5 text-2xs font-medium">
        {heading}
      </div>
      <div className="max-h-[480px] overflow-auto p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {tokens.map((token, index) => {
          if (token.op === 'equal') {
            return <span key={index}>{token.text}</span>;
          }
          if (side === 'left' && token.op === 'delete') {
            return (
              <span
                key={index}
                className="bg-danger-soft text-danger rounded-sm line-through decoration-danger/60"
              >
                {token.text}
              </span>
            );
          }
          if (side === 'right' && token.op === 'insert') {
            return (
              <span key={index} className="bg-success-soft text-success rounded-sm">
                {token.text}
              </span>
            );
          }
          // This side does not contain the token (it is the other side's change).
          return null;
        })}
      </div>
    </div>
  );
}
