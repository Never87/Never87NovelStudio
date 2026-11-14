import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Plus,
  ScanText,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton } from '@/components/ui';
import type { ExtractionKind } from '@/types';
import type { GenerateAiExtractionsResult } from '@/services';
import { cn } from '@/utils/cn';
import { useAiConfig, useExtraction } from '@/hooks';
import { ImportWorkflowShell } from './ImportWorkflowShell';
import { useImportWorkflow } from './ImportWorkflowProvider';
import {
  AI_EXTRACTION_KINDS,
  DEFAULT_AI_SECTION_LIMIT,
  describeExtractionReadiness,
  getStageMeta,
  quoteAppearsInSection,
  validateManualExtractionDraft,
  type ManualExtractionDraft,
} from './import-workflow-stages';

/**
 * Information Extraction page (P8 Batch 6).
 *
 * Stage 4 of the pipeline. It produces REVIEW-PENDING `ExtractionRecord`
 * candidates for the selected document, two ways:
 *
 *   1. MANUAL —the user supplies a title, an optional summary/body and at least
 *      one verbatim evidence quote from a confirmed section. `ExtractionService`
 *      resolves the quote against the stored raw text and rejects anything
 *      fabricated or ambiguous.
 *   2. AI —the user picks a model (from the P5 model registry) and asks the
 *      pipeline to propose candidates, grounded in confirmed sections.
 *
 * Extraction is BLOCKED until the document's structure is confirmed —that is
 * enforced by the service and mirrored here by disabling the actions with the
 * reason shown. Absence of a confirmation must never be papered over by the UI.
 *
 * This page produces candidates only. It never writes to project entities
 * (characters/world/knowledge) and never bypasses review: every candidate is
 * `reviewStatus: 'pending'`. Review and integration live on their own pages.
 */
export function InformationExtractionPage() {
  return (
    <ImportWorkflowShell
      stage="extraction"
      title="Information Extraction"
      description="Produce review-pending candidates from confirmed sections. Every candidate is grounded in a verbatim quote —nothing is written to project data."
    >
      <InformationExtractionContent />
    </ImportWorkflowShell>
  );
}

type ExtractionKindValue = ExtractionKind;

function InformationExtractionContent() {
  const workflow = useImportWorkflow();
  const navigate = useNavigate();
  const document = workflow.document;

  const [sections, setSections] = useState<Awaited<ReturnType<typeof workflow.importDocs.getSections>>>([]);
  const [loadingSections, setLoadingSections] = useState(false);

  const extraction = useExtraction(workflow.projectId, document?.id);

  const [sectionLoadError, setSectionLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastAiRun, setLastAiRun] = useState<GenerateAiExtractionsResult | null>(null);

  const aiConfig = useAiConfig();

  const loadSections = useCallback(async () => {
    if (!document) {
      setSections([]);
      return;
    }
    setLoadingSections(true);
    try {
      setSections(await workflow.importDocs.getSections(document.id));
    } catch (err) {
      setSectionLoadError(err instanceof Error ? err.message : 'Could not load sections.');
      setSections([]);
    } finally {
      setLoadingSections(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.id]);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const readiness = document ? describeExtractionReadiness(document, sections.length) : null;

  const enabledModels = useMemo(() => aiConfig.models.filter((model) => model.enabled), [aiConfig.models]);

  const pendingCount = useMemo(
    () => extraction.records.filter((record) => record.reviewStatus === 'pending').length,
    [extraction.records],
  );
  const confirmedCount = useMemo(
    () => extraction.records.filter((record) => record.reviewStatus === 'confirmed').length,
    [extraction.records],
  );

  if (!document) {
    return (
      <EmptyState
        icon={<FileText className="size-5" aria-hidden />}
        title="No document selected"
        description="Choose a document above, or import one first."
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate(getStageMeta('import').path)}>
            Go to Manuscript Import
          </Button>
        }
      />
    );
  }

  const sectionText = (sectionId: string) => {
    const found = sections.find((candidate) => candidate.id === sectionId);
    if (!found) return '';
    return document.rawText.slice(found.start, found.end);
  };

  return (
    <div className="space-y-4">
      {/* --------------------------- Status card -------------------------- */}
      <Card padding="md" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-ink truncate text-sm font-semibold">{document.fileName ?? 'Untitled document'}</h2>
            <p className="text-subtle text-2xs">
              {sections.length} section(s) · {extraction.records.length} candidate(s) ·{' '}
              {pendingCount} pending · {confirmedCount} confirmed
            </p>
          </div>
          <Badge
            tone={readiness?.ready ? 'success' : 'warning'}
            size="sm"
            icon={readiness?.ready ? <CheckCircle2 className="size-3" aria-hidden /> : <AlertTriangle className="size-3" aria-hidden />}
          >
            {readiness?.ready ? 'Ready to extract' : 'Blocked'}
          </Badge>
        </div>

        {readiness && !readiness.ready ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2">
            <AlertTriangle className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
            <div className="text-warning text-2xs">
              <p className="font-medium">Extraction is unavailable.</p>
              <p className="mt-0.5">{readiness.reason}</p>
            </div>
          </div>
        ) : null}

        {loadingSections ? (
          <p className="text-subtle text-2xs" role="status">
            Loading sections—          </p>
        ) : null}
        {sectionLoadError ? (
          <p className="text-danger text-2xs" role="alert">
            {sectionLoadError}
          </p>
        ) : null}

        {message ? (
          <p className="text-success flex items-start gap-1.5 text-2xs" role="status">
            <CheckCircle2 className="mt-0.5 size-3 shrink-0" aria-hidden />
            {message}
          </p>
        ) : null}
        {actionError ? (
          <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            {actionError}
          </p>
        ) : null}

        {readiness?.ready ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              variant="secondary"
              size="sm"
              iconRight={<ArrowRight className="size-3.5" />}
              onClick={() => navigate(getStageMeta('review').path)}
              className="ml-auto"
            >
              Go to Review Center ({pendingCount} pending)
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<ScanText className="size-3.5" />}
              onClick={() => navigate(getStageMeta('structure').path)}
            >
              Go to Structure Recognition
            </Button>
          </div>
        )}
      </Card>

      {/* ------------------------------ AI run ---------------------------- */}
      <AiExtractionCard
        disabled={!readiness?.ready}
        busy={extraction.mutating}
        models={enabledModels}
        configLoading={aiConfig.loading}
        sectionCount={sections.length}
        lastRun={lastAiRun}
        onRun={async (input) => {
          setActionError(null);
          setMessage(null);
          setLastAiRun(null);
          try {
            const result = await extraction.generateAi({
              documentId: document.id,
              modelId: input.modelId,
              kinds: input.kinds,
              instruction: input.instruction || undefined,
              maxSections: input.maxSections,
            });
            setLastAiRun(result);
            setMessage(
              `AI run finished: ${result.created.length} created, ${result.updated.length} updated, ${result.rejected} rejected.`,
            );
          } catch (err) {
            setActionError(err instanceof Error ? err.message : 'AI extraction failed.');
          }
        }}
      />

      {/* --------------------------- Manual form -------------------------- */}
      <ManualExtractionCard
        disabled={!readiness?.ready}
        busy={extraction.mutating}
        sections={sections.map((section) => ({
          id: section.id,
          title: section.title,
          level: section.level,
          text: document.rawText.slice(section.start, section.end),
        }))}
        onSubmit={async (draft) => {
          setActionError(null);
          setMessage(null);
          try {
            const created = await extraction.createManual({
              documentId: document.id,
              kind: draft.kind as ExtractionKindValue,
              title: draft.title.trim(),
              summary: draft.summary.trim() || undefined,
              body: draft.body.trim() || undefined,
              evidence: [{ sectionId: draft.sectionId, quote: draft.quote }],
            });
            setMessage(
              `Created pending candidate "${created.title}". It appears below and in the Review Center - nothing is applied to project data until it is integrated.`,
            );
            return true;
          } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Could not create the candidate.');
            return false;
          }
        }}
        quoteAppears={(sectionId, quote) => quoteAppearsInSection(quote, sectionText(sectionId))}
      />

      {/* --------------------------- Candidates --------------------------- */}
      <Card padding="md">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ink text-sm font-semibold">Candidates for this document</h2>
          <span className="text-subtle text-2xs tabular-nums">{extraction.records.length} total</span>
        </div>

        {extraction.loading && extraction.records.length === 0 ? (
          <p className="text-subtle mt-3 text-xs" role="status">
            Loading candidates—          </p>
        ) : extraction.error && extraction.records.length === 0 ? (
          <p className="text-danger mt-3 text-xs" role="alert">
            {extraction.error instanceof Error ? extraction.error.message : 'Failed to load candidates.'}
          </p>
        ) : extraction.records.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<Sparkles className="size-5" aria-hidden />}
              title="No candidates yet"
              description="Run AI extraction or add a manual candidate above. Everything stays pending until you review it."
            />
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {extraction.records.map((record) => (
              <li key={record.id} className="flex items-start gap-2 rounded-lg border border-line bg-surface p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral" size="sm" className="capitalize">
                      {record.kind}
                    </Badge>
                    <Badge tone={reviewStatusTone(record.reviewStatus)} size="sm">
                      {record.reviewStatus}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      {record.origin}
                    </Badge>
                    {record.confidence != null ? (
                      <span className="text-subtle text-2xs tabular-nums">
                        confidence {Math.round(record.confidence * 100)}%
                      </span>
                    ) : null}
                  </div>
                  <p className="text-ink mt-1 truncate text-xs font-medium">{record.title}</p>
                  {record.summary ? (
                    <p className="text-muted mt-0.5 line-clamp-2 text-2xs">{record.summary}</p>
                  ) : null}
                  <p className="text-subtle mt-1 text-2xs">
                    {record.evidence.length} evidence quote(s) · created{' '}
                    {new Date(record.createdAt).toLocaleString()}
                  </p>
                </div>
                <IconButton
                  size="sm"
                  label="Delete candidate"
                  disabled={extraction.mutating}
                  icon={<Trash2 className="size-3" aria-hidden />}
                  onClick={async () => {
                    if (!window.confirm(`Delete the candidate —{record.title}— This cannot be undone.`)) return;
                    setActionError(null);
                    try {
                      await extraction.deleteRecord(record.id);
                      setMessage(`Deleted candidate —{record.title}—`);
                    } catch (err) {
                      setActionError(err instanceof Error ? err.message : 'Delete failed.');
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        {extraction.records.length > 0 ? (
          <p className="text-subtle mt-3 text-2xs">
            <ClipboardCheck className="mr-1 inline size-3" aria-hidden />
            Candidates are review-pending. Nothing reaches project data until it is confirmed and integrated.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

function reviewStatusTone(status: string) {
  switch (status) {
    case 'confirmed':
      return 'success' as const;
    case 'rejected':
      return 'danger' as const;
    case 'merged':
      return 'info' as const;
    default:
      return 'warning' as const;
  }
}

/* -------------------------------------------------------------------------- */
/* AI run card                                                                */
/* -------------------------------------------------------------------------- */

function AiExtractionCard({
  disabled,
  busy,
  models,
  configLoading,
  sectionCount,
  lastRun,
  onRun,
}: {
  disabled: boolean;
  busy: boolean;
  /** Enabled models —`id` is the AiModel primary key, which is what `modelId` expects. */
  models: Array<{ id: string; displayName: string; modelId: string }>;
  configLoading: boolean;
  sectionCount: number;
  lastRun: GenerateAiExtractionsResult | null;
  onRun: (input: { modelId: string; kinds: ExtractionKindValue[]; instruction: string; maxSections: number }) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [modelId, setModelId] = useState('');
  const [kinds, setKinds] = useState<ExtractionKindValue[]>(['character', 'location', 'faction', 'item', 'concept']);
  const [instruction, setInstruction] = useState('');
  const [maxSections, setMaxSections] = useState(DEFAULT_AI_SECTION_LIMIT);

  // Default to the first enabled model once models have loaded.
  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(models[0].id);
  }, [modelId, models]);

  const toggleKind = (kind: ExtractionKindValue) => {
    setKinds((previous) =>
      previous.includes(kind) ? previous.filter((candidate) => candidate !== kind) : [...previous, kind],
    );
  };

  const canRun = !disabled && !busy && Boolean(modelId) && kinds.length > 0;
  const reason = disabled
    ? 'Confirm the structure first.'
    : models.length === 0
      ? 'No enabled AI model configured.'
      : kinds.length === 0
        ? 'Select at least one kind.'
        : null;

  return (
    <Card padding="md" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ink flex items-center gap-1.5 text-sm font-semibold">
            <Wand2 className="text-accent size-4" aria-hidden />
            AI extraction
          </h2>
          <p className="text-muted mt-0.5 text-xs">
            Asks the selected model for candidate entities/terms grounded in confirmed sections. Output is
            validated and de-duplicated before it is stored.
          </p>
        </div>
        <Badge tone="accent" size="sm">
          Stage 4 · Extract
        </Badge>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Model</span>
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            disabled={disabled || busy || configLoading}
            aria-label="AI model"
            className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs disabled:opacity-60"
          >
            {models.length === 0 ? <option value="">No enabled models</option> : null}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName} ({model.modelId})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
            Max sections ({sectionCount} available)
          </span>
          <input
            type="number"
            min={1}
            max={Math.max(1, sectionCount)}
            value={maxSections}
            onChange={(event) => setMaxSections(Math.max(1, Number(event.target.value) || 1))}
            disabled={disabled || busy}
            className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs tabular-nums disabled:opacity-60"
          />
        </label>
      </div>

      <fieldset disabled={disabled || busy} className="space-y-1">
        <legend className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">Kinds to request</legend>
        <div className="flex flex-wrap gap-1.5">
          {AI_EXTRACTION_KINDS.map((kind) => {
            const active = kinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={active}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-2xs capitalize transition-colors disabled:opacity-60',
                  active
                    ? 'border-accent bg-accent-soft text-accent-soft-text font-medium'
                    : 'border-line text-muted hover:border-line-strong hover:text-ink',
                )}
              >
                {kind}
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Focus instruction (optional)</span>
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={2}
          disabled={disabled || busy}
          placeholder="e.g. focus on characters and factions introduced in chapter 2"
          className="bg-surface border-line-strong text-ink w-full rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          iconLeft={<Sparkles className="size-3.5" />}
          loading={busy}
          disabled={!canRun}
          onClick={() => void onRun({ modelId, kinds, instruction, maxSections })}
        >
          Run AI extraction
        </Button>
        {reason ? (
          <span className="text-subtle text-2xs">{reason}</span>
        ) : null}
        {models.length === 0 && !configLoading ? (
          <button
            type="button"
            onClick={() => navigate('/settings/models')}
            className="text-accent text-2xs font-medium underline underline-offset-2"
          >
            Configure models
          </button>
        ) : null}
      </div>

      {lastRun ? (
        <div className="bg-surface-muted rounded-md border border-line px-3 py-2 text-2xs">
          <p className="text-muted">
            Model <span className="text-ink font-medium">{lastRun.target.modelName}</span> (
            {lastRun.target.providerName}) · {lastRun.created.length} created · {lastRun.updated.length} updated ·{' '}
            {lastRun.rejected} rejected (evidence could not be grounded).
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Manual extraction card                                                     */
/* -------------------------------------------------------------------------- */

interface ManualSectionOption {
  id: string;
  title: string;
  level: string;
  text: string;
}

function ManualExtractionCard({
  disabled,
  busy,
  sections,
  onSubmit,
  quoteAppears,
}: {
  disabled: boolean;
  busy: boolean;
  sections: ManualSectionOption[];
  onSubmit: (draft: ManualExtractionDraft) => Promise<boolean>;
  quoteAppears: (sectionId: string, quote: string) => boolean;
}) {
  const [draft, setDraft] = useState<ManualExtractionDraft>({
    kind: 'character',
    title: '',
    summary: '',
    body: '',
    sectionId: '',
    quote: '',
  });
  const [problems, setProblems] = useState<string[]>([]);

  const update = <K extends keyof ManualExtractionDraft>(key: K, value: ManualExtractionDraft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const chosenSection = sections.find((section) => section.id === draft.sectionId) ?? null;
  const appears = chosenSection && draft.quote.trim() ? quoteAppears(draft.sectionId, draft.quote) : null;

  const submit = async () => {
    const found = validateManualExtractionDraft(draft);
    setProblems(found);
    if (found.length > 0) return;
    const ok = await onSubmit(draft);
    if (ok) {
      setDraft({ kind: draft.kind, title: '', summary: '', body: '', sectionId: draft.sectionId, quote: '' });
      setProblems([]);
    }
  };

  return (
    <Card padding="md" className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ink flex items-center gap-1.5 text-sm font-semibold">
            <Plus className="text-accent size-4" aria-hidden />
            Manual candidate
          </h2>
          <p className="text-muted mt-0.5 text-xs">
            Add a single candidate by hand. It must quote the text verbatim —the service rejects quotes it cannot
            locate exactly once in the chosen section.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <label className="flex flex-col gap-1">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Kind</span>
          <select
            value={draft.kind}
            onChange={(event) => update('kind', event.target.value)}
            disabled={disabled || busy}
            aria-label="Candidate kind"
            className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs capitalize disabled:opacity-60"
          >
            {AI_EXTRACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Title</span>
          <input
            value={draft.title}
            onChange={(event) => update('title', event.target.value)}
            disabled={disabled || busy}
            placeholder="e.g. Mara Vell"
            aria-label="Candidate title"
            className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs disabled:opacity-60"
          />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Summary (optional)</span>
          <input
            value={draft.summary}
            onChange={(event) => update('summary', event.target.value)}
            disabled={disabled || busy}
            className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Body (optional)</span>
          <input
            value={draft.body}
            onChange={(event) => update('body', event.target.value)}
            disabled={disabled || busy}
            className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs disabled:opacity-60"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Evidence section</span>
        <select
          value={draft.sectionId}
          onChange={(event) => update('sectionId', event.target.value)}
          disabled={disabled || busy}
          aria-label="Evidence section"
          className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs disabled:opacity-60"
        >
          <option value="">Select a confirmed section&hellip;</option>
          {sections.map((section) => (
            <option key={section.id} value={section.id}>
              {section.title} ({section.level})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Verbatim evidence quote</span>
        <textarea
          value={draft.quote}
          onChange={(event) => update('quote', event.target.value)}
          rows={3}
          disabled={disabled || busy || !draft.sectionId}
          placeholder={chosenSection ? chosenSection.text.slice(0, 80) + '&hellip;' : 'Choose a section first'}
          aria-label="Evidence quote"
          className="bg-surface border-line-strong text-ink w-full rounded-md border px-2 py-1.5 font-mono text-2xs disabled:opacity-60"
        />
        {appears === false ? (
          <span className="text-warning text-2xs">
            This quote does not appear verbatim in the selected section. The service will reject it.
          </span>
        ) : appears === true ? (
          <span className="text-success text-2xs">Quote found in the selected section.</span>
        ) : null}
      </label>

      {problems.length > 0 ? (
        <ul className="text-danger space-y-0.5 text-2xs" role="alert">
          {problems.map((problem) => (
            <li key={problem}>· {problem}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Button
          variant="primary"
          size="sm"
          iconLeft={<Plus className="size-3.5" />}
          loading={busy}
          disabled={disabled}
          onClick={() => void submit()}
        >
          Add candidate
        </Button>
        {disabled ? <span className="text-subtle text-2xs">Confirm the structure first.</span> : null}
      </div>
    </Card>
  );
}
