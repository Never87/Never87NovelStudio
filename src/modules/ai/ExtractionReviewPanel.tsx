import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ClipboardCheck, GitMerge, Pencil, RotateCcw, Search, Undo2, X } from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type {
  ExtractionKind,
  ExtractionRecord,
  ExtractionReviewStatus,
  SourceDocument,
} from '@/types';
import type { ReviewDetail, ReviewQueueFilters, UpdatePendingInput } from '@/services';
import { useExtractionReview, useProjects } from '@/hooks';
import { Field, Select, TextArea, TextInput } from './components/fields';
import { ProjectPicker } from './components/ProjectPicker';
import {
  EXTRACTION_KINDS,
  EXTRACTION_REVIEW_STATUSES,
  KIND_LABELS,
  ORIGIN_META,
  REVIEW_STATUS_META,
  formatConfidence,
} from './extraction-review-meta';

/**
 * Extraction Review Center (P8 Batch 4).
 *
 * Reviews the review-pending `ExtractionRecord`s produced by the earlier
 * extraction batch: inspect each candidate together with its ORIGINAL evidence
 * (validated against the current source text), then confirm / reject / restore /
 * edit / merge it. Every action is delegated to the singleton `reviewService`;
 * nothing here decides a record's status on its own, and every mutation reloads
 * the queue so the list always reflects the database. Confidence is shown as
 * advisory only and never drives an accept/reject decision.
 */
export function ExtractionReviewPanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const review = useExtractionReview(effectiveProjectId);

  const [statusFilter, setStatusFilter] = useState<ExtractionReviewStatus | 'all'>('pending');
  const [kindFilter, setKindFilter] = useState<ExtractionKind | ''>('');
  const [search, setSearch] = useState('');
  const [documents, setDocuments] = useState<SourceDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const filters: ReviewQueueFilters = useMemo(
    () => ({ status: statusFilter, kind: kindFilter || undefined, search: search || undefined }),
    [statusFilter, kindFilter, search],
  );

  // Reload the queue whenever the effective project or filters change.
  useEffect(() => {
    if (!effectiveProjectId) return;
    void review.refresh(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId, filters]);

  // Load the document list once per project (for source labels / emptiness hint).
  useEffect(() => {
    let active = true;
    if (!effectiveProjectId) {
      setDocuments([]);
      return;
    }
    void review
      .listDocuments()
      .then((docs) => {
        if (active) setDocuments(docs);
      })
      .catch(() => {
        if (active) setDocuments([]);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId]);

  const documentTitle = useCallback(
    (documentId: string) => documents.find((d) => d.id === documentId)?.fileName ?? documentId,
    [documents],
  );

  const openDetail = useCallback(
    async (extractionId: string) => {
      setSelectedId(extractionId);
      setDetail(null);
      setEditing(false);
      setDetailError(null);
      setActionError(null);
      setNotice(null);
      try {
        const next = await review.getDetail(extractionId);
        setDetail(next);
      } catch (error) {
        setDetailError(error instanceof Error ? error.message : String(error));
      }
    },
    [review],
  );

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setEditing(false);
    setDetailError(null);
    setActionError(null);
    setNotice(null);
  };

  /** Runs a review action, reloads the detail, and reports the outcome. */
  const runAction = async (label: string, fn: () => Promise<unknown>, reload = true) => {
    setActionError(null);
    setNotice(null);
    try {
      const result = await fn();
      const alreadyApplied =
        typeof result === 'object' && result !== null && 'alreadyApplied' in result
          ? Boolean((result as { alreadyApplied: unknown }).alreadyApplied)
          : false;
      setNotice(alreadyApplied ? `${label}: already applied.` : `${label}: done.`);
      if (reload && selectedId) await openDetail(selectedId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const isEmpty = review.status === 'success' && review.queue.length === 0 && documents.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Extraction Review Center"
        description="Review each extracted record together with its original evidence before it can be integrated. Nothing is applied automatically — review is the gate."
        actions={<ProjectPicker projects={projects} value={effectiveProjectId} onChange={setProjectId} />}
      />

      {projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="size-5" aria-hidden />}
          title="No projects yet"
          description="The review queue is per project. Create a project and import a document first."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* ----------------------------- Queue --------------------------- */}
          <div className="space-y-3">
            <Card padding="md" className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-40 flex-1">
                  <Search
                    className="text-subtle pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
                    aria-hidden
                  />
                  <TextInput
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search title or summary…"
                    className="pl-7"
                    aria-label="Search extraction records"
                  />
                </div>
                <Select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as ExtractionReviewStatus | 'all')}
                  aria-label="Filter by review status"
                  className="min-w-32"
                >
                  <option value="all">All statuses</option>
                  {EXTRACTION_REVIEW_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {REVIEW_STATUS_META[s].label}
                    </option>
                  ))}
                </Select>
                <Select
                  value={kindFilter}
                  onChange={(event) => setKindFilter(event.target.value as ExtractionKind | '')}
                  aria-label="Filter by kind"
                  className="min-w-32"
                >
                  <option value="">All kinds</option>
                  {EXTRACTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </div>
              {review.status === 'success' ? (
                <p className="text-subtle text-2xs" role="status">
                  {review.queue.length} record{review.queue.length === 1 ? '' : 's'} in queue
                  {statusFilter === 'pending' ? ' (pending review)' : ''}.
                </p>
              ) : null}
            </Card>

            {review.loading && review.queue.length === 0 ? (
              <Card padding="lg">
                <p className="text-subtle text-xs" role="status">
                  Loading review queue…
                </p>
              </Card>
            ) : review.status === 'error' ? (
              <Card padding="lg" className="space-y-2">
                <p className="text-danger text-xs" role="alert">
                  {review.error instanceof Error ? review.error.message : String(review.error)}
                </p>
                <Button variant="secondary" size="sm" onClick={() => void review.refresh(filters)}>
                  Retry
                </Button>
              </Card>
            ) : review.queue.length === 0 ? (
              <EmptyState
                icon={<ClipboardCheck className="size-5" aria-hidden />}
                title={isEmpty ? 'No documents to review' : 'Nothing to review here'}
                description={
                  isEmpty
                    ? 'Import a document and run extraction to produce review-pending records.'
                    : 'Adjust the filters, or run extraction to produce new candidates.'
                }
              />
            ) : (
              <ul className="space-y-2">
                {review.queue.map((item) => (
                  <li key={item.record.id}>
                    <QueueCard
                      record={item.record}
                      evidenceValid={item.evidenceValid}
                      documentTitle={documentTitle(item.record.documentId)}
                      selected={item.record.id === selectedId}
                      onOpen={() => void openDetail(item.record.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ----------------------------- Detail -------------------------- */}
          <div className="space-y-3">
            {!selectedId ? (
              <Card padding="lg">
                <p className="text-subtle text-xs">
                  Select a record to inspect its evidence, confidence and review status.
                </p>
              </Card>
            ) : detailError ? (
              <Card padding="lg" className="space-y-2">
                <p className="text-danger text-xs" role="alert">
                  {detailError}
                </p>
                <Button variant="secondary" size="sm" onClick={() => void openDetail(selectedId)}>
                  Retry
                </Button>
              </Card>
            ) : !detail ? (
              <Card padding="lg">
                <p className="text-subtle text-xs" role="status">
                  Loading record…
                </p>
              </Card>
            ) : (
              <DetailView
                detail={detail}
                mutating={review.mutating}
                notice={notice}
                actionError={actionError}
                editing={editing}
                getMergeCandidates={review.getMergeCandidates}
                onStartEdit={() => setEditing(true)}
                onCancelEdit={() => setEditing(false)}
                onClose={closeDetail}
                onConfirm={() => void runAction('Confirm', () => review.confirm(detail.record.id))}
                onReject={() => void runAction('Reject', () => review.reject(detail.record.id))}
                onRestore={() => void runAction('Restore', () => review.restore(detail.record.id))}
                onMerge={(targetId) => void runAction('Merge', () => review.merge(detail.record.id, targetId))}
                onSaveEdit={async (input: UpdatePendingInput) => {
                  await runAction('Save', () => review.updatePending(detail.record.id, input));
                  setEditing(false);
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function QueueCard({
  record,
  evidenceValid,
  documentTitle,
  selected,
  onOpen,
}: {
  record: ExtractionRecord;
  evidenceValid: boolean;
  documentTitle: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const status = REVIEW_STATUS_META[record.reviewStatus];
  const origin = ORIGIN_META[record.origin];
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={
        'w-full rounded-lg border p-3 text-left transition-colors ' +
        (selected ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface hover:bg-surface-muted')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent" size="sm">
              {KIND_LABELS[record.kind]}
            </Badge>
            <Badge tone={status.tone} size="sm">
              {status.label}
            </Badge>
            <Badge tone={origin.tone} size="sm">
              {origin.label}
            </Badge>
            {!evidenceValid ? (
              <Badge tone="warning" size="sm">
                Stale evidence
              </Badge>
            ) : null}
          </div>
          <h3 className="text-ink mt-1 truncate text-sm font-semibold">{record.title}</h3>
          {record.summary ? <p className="text-muted line-clamp-2 text-2xs">{record.summary}</p> : null}
        </div>
        <span className="text-subtle shrink-0 text-2xs tabular-nums">{formatConfidence(record.confidence)}</span>
      </div>
      <p className="text-subtle mt-1.5 truncate text-2xs">Source: {documentTitle}</p>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function DetailView({
  detail,
  mutating,
  notice,
  actionError,
  editing,
  getMergeCandidates,
  onStartEdit,
  onCancelEdit,
  onClose,
  onConfirm,
  onReject,
  onRestore,
  onMerge,
  onSaveEdit,
}: {
  detail: ReviewDetail;
  mutating: boolean;
  notice: string | null;
  actionError: string | null;
  editing: boolean;
  getMergeCandidates: (excludeId: string) => Promise<ExtractionRecord[]>;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onClose: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onRestore: () => void;
  onMerge: (targetId: string) => void;
  onSaveEdit: (input: UpdatePendingInput) => Promise<void>;
}) {
  const record = detail.record;
  const status = REVIEW_STATUS_META[record.reviewStatus];
  const origin = ORIGIN_META[record.origin];
  const isPending = record.reviewStatus === 'pending';
  const isRejected = record.reviewStatus === 'rejected';
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<ExtractionRecord[]>([]);

  // Load merge candidates when viewing a pending record (the only mergeable source).
  useEffect(() => {
    let active = true;
    if (!isPending) {
      setMergeCandidates([]);
      return;
    }
    void getMergeCandidates(record.id)
      .then((candidates) => {
        if (active) setMergeCandidates(candidates);
      })
      .catch(() => {
        if (active) setMergeCandidates([]);
      });
    return () => {
      active = false;
    };
  }, [getMergeCandidates, isPending, record.id]);

  return (
    <Card padding="md" className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent" size="sm">
              {KIND_LABELS[record.kind]}
            </Badge>
            <Badge tone={status.tone} size="sm">
              {status.label}
            </Badge>
            <Badge tone={origin.tone} size="sm">
              {origin.label}
            </Badge>
            {record.confidence !== null ? (
              <Badge tone="neutral" size="sm">
                Confidence {formatConfidence(record.confidence)} (advisory)
              </Badge>
            ) : null}
          </div>
          <h2 className="text-ink mt-1 text-base font-semibold">{record.title}</h2>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close detail"
          icon={<X className="size-4" aria-hidden />}
          onClick={onClose}
        />
      </div>

      {record.merge ? (
        <p className="text-subtle text-2xs">
          Merged into <span className="font-mono">{record.merge.targetId}</span> ·{' '}
          {record.merge.absorbedEvidence} evidence locator{record.merge.absorbedEvidence === 1 ? '' : 's'} absorbed.
        </p>
      ) : null}

      {editing ? (
        <EditForm record={record} saving={mutating} onCancel={onCancelEdit} onSave={onSaveEdit} />
      ) : (
        <>
          {record.summary ? (
            <p className="text-muted text-xs whitespace-pre-wrap">{record.summary}</p>
          ) : null}
          {record.body ? (
            <p className="text-ink max-h-48 overflow-auto text-xs whitespace-pre-wrap">{record.body}</p>
          ) : null}
          {record.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {record.tags.map((tag) => (
                <span key={tag} className="bg-surface-muted text-subtle rounded px-1.5 py-0.5 text-2xs">
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <h3 className="text-subtle text-2xs font-medium tracking-wide uppercase">Evidence</h3>
            {detail.evidence.length === 0 ? (
              <p className="text-subtle text-2xs">No evidence locations.</p>
            ) : (
              <ul className="space-y-1.5">
                {detail.evidence.map((ev, index) => (
                  <li
                    key={`${ev.evidence.sectionId}:${ev.evidence.start}:${ev.evidence.end}:${index}`}
                    className={
                      'rounded-md border p-2 text-2xs ' +
                      (ev.valid ? 'border-line bg-surface-muted' : 'border-danger/40 bg-danger/5')
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-subtle truncate font-mono">
                        {ev.section?.title || ev.evidence.sectionId} · [{ev.evidence.start}, {ev.evidence.end})
                      </span>
                      {ev.valid ? (
                        <Badge tone="success" size="sm">
                          Valid
                        </Badge>
                      ) : (
                        <Badge tone="danger" size="sm">
                          Invalid
                        </Badge>
                      )}
                    </div>
                    {ev.slice !== null ? (
                      <q className="text-ink mt-1 block whitespace-pre-wrap">{ev.slice}</q>
                    ) : null}
                    {!ev.valid && ev.problem ? <p className="text-danger mt-1">{ev.problem}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {notice ? (
        <p className="text-success text-2xs" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="text-danger text-2xs" role="alert">
          {actionError}
        </p>
      ) : null}

      {!editing ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {isPending ? (
            <>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<Check className="size-3.5" />}
                onClick={onConfirm}
                disabled={mutating}
              >
                Confirm
              </Button>
              <Button
                variant="danger"
                size="sm"
                iconLeft={<X className="size-3.5" />}
                onClick={onReject}
                disabled={mutating}
              >
                Reject
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<Pencil className="size-3.5" />}
                onClick={onStartEdit}
                disabled={mutating}
              >
                Edit
              </Button>
              {mergeCandidates.length > 0 ? (
                <div className="flex items-center gap-2">
                  <Select
                    value={mergeTargetId}
                    onChange={(event) => setMergeTargetId(event.target.value)}
                    aria-label="Merge into"
                    className="min-w-40"
                  >
                    <option value="">Merge into…</option>
                    {mergeCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {KIND_LABELS[candidate.kind]} · {candidate.title} (
                        {REVIEW_STATUS_META[candidate.reviewStatus].label})
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<GitMerge className="size-3.5" />}
                    disabled={mutating || !mergeTargetId}
                    onClick={() => mergeTargetId && onMerge(mergeTargetId)}
                  >
                    Merge
                  </Button>
                </div>
              ) : null}
            </>
          ) : isRejected ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<RotateCcw className="size-3.5" />}
              onClick={onRestore}
              disabled={mutating}
            >
              Restore to pending
            </Button>
          ) : (
            <p className="text-subtle inline-flex items-center gap-1.5 text-2xs">
              <Undo2 className="size-3.5" aria-hidden />
              {record.reviewStatus === 'confirmed'
                ? 'Confirmed — approved for later integration.'
                : 'Merged — folded into another record (terminal).'}
            </p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function EditForm({
  record,
  saving,
  onCancel,
  onSave,
}: {
  record: ExtractionRecord;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: UpdatePendingInput) => Promise<void>;
}) {
  const [kind, setKind] = useState<ExtractionKind>(record.kind);
  const [title, setTitle] = useState(record.title);
  const [summary, setSummary] = useState(record.summary);
  const [body, setBody] = useState(record.body);
  const [tags, setTags] = useState(record.tags.join(', '));
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    setError(null);
    try {
      await onSave({
        kind,
        title: title.trim(),
        summary: summary.trim(),
        body,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
        <Field label="Kind" htmlFor="review-kind">
          <Select id="review-kind" value={kind} onChange={(event) => setKind(event.target.value as ExtractionKind)}>
            {EXTRACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="review-title" required>
          <TextInput id="review-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
      </div>
      <Field label="Summary" htmlFor="review-summary">
        <TextInput id="review-summary" value={summary} onChange={(event) => setSummary(event.target.value)} />
      </Field>
      <Field label="Body" htmlFor="review-body">
        <TextArea
          id="review-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          className="min-h-[100px]"
        />
      </Field>
      <Field label="Tags" htmlFor="review-tags" hint="Comma-separated.">
        <TextInput id="review-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
      </Field>
      {error ? (
        <p className="text-danger text-2xs" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} loading={saving}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
