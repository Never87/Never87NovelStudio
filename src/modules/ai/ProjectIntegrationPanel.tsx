import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Merge,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader } from '@/components/ui';
import type { ConflictStrategy, ExtractionKind, ExtractionRecord } from '@/types';
import type {
  ApplyIntegrationInput,
  IntegrationItemResult,
  IntegrationPreview,
  PreviewFieldMapping,
} from '@/services';
import { useIntegration, useProjects } from '@/hooks';
import { Select, TextInput } from './components/fields';
import { ProjectPicker } from './components/ProjectPicker';
import {
  EXTRACTION_KINDS,
  KIND_LABELS,
  ORIGIN_META,
  formatConfidence,
} from './extraction-review-meta';
import { STRATEGY_META, TARGET_TYPE_META, fieldLabel } from './integration-meta';

type StrategyMap = Record<string, ConflictStrategy>;

/**
 * Project Integration page (P8 Batch 5).
 *
 * Turns CONFIRMED extraction records into real project entities (Character /
 * World section / Knowledge entry). The flow is deliberately two-phase and
 * explicit:
 *
 *   1. Build a READ-ONLY preview (`previewIntegration`) - this NEVER writes and
 *      NEVER applies. It shows the routing decision, an existing-target match
 *      and every field-level conflict with a default strategy.
 *   2. The user chooses a strategy per conflict (never defaulted to overwrite),
 *      then EXPLICITLY clicks Apply. Apply carries the preview FINGERPRINT; the
 *      service re-validates everything transactionally and refuses a stale
 *      preview, so a changed record/target/choice can never silently apply.
 *
 * Because the preview fingerprint folds in the chosen field strategies, a
 * strategy change regenerates the preview so its fingerprint always matches the
 * choices that will be applied. Apply then uses that fingerprint directly, so a
 * `stale-preview` refusal can only ever mean the record/target changed OUTSIDE
 * the UI - never a silent mismatch from a UI-side choice.
 *
 * All business logic lives in `IntegrationService` (via the `useIntegration`
 * hook); this component only renders state and forwards user intent. Opening a
 * preview performs no write - Apply is the only mutating action.
 */
export function ProjectIntegrationPanel() {
  const { projects, initialLoading: projectsLoading } = useProjects();
  const [projectId, setProjectId] = useState('');
  const effectiveProjectId = projectId || projects[0]?.id || '';

  const integration = useIntegration(effectiveProjectId);

  const [kindFilter, setKindFilter] = useState<ExtractionKind | ''>('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<IntegrationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [strategies, setStrategies] = useState<StrategyMap>({});
  const [applyResult, setApplyResult] = useState<IntegrationItemResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Client-side filtering of the pending list (the service lists all pending;
  // kind/search are pure view concerns and never re-fetch or re-query the DB).
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return integration.pending.filter((record) => {
      if (kindFilter && record.kind !== kindFilter) return false;
      if (!needle) return true;
      return (
        record.title.toLowerCase().includes(needle) ||
        record.summary.toLowerCase().includes(needle)
      );
    });
  }, [integration.pending, kindFilter, search]);

  const resetDetail = useCallback(() => {
    setSelectedId(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setStrategies({});
    setApplyResult(null);
    setApplyError(null);
  }, []);

  /**
   * Builds a READ-ONLY preview for a record. This performs NO write: the
   * service's `previewIntegration` is query-only. Selecting a record can never
   * apply it.
   */
  const openPreview = useCallback(
    async (extractionId: string) => {
      setSelectedId(extractionId);
      setPreview(null);
      setPreviewError(null);
      setApplyResult(null);
      setApplyError(null);
      setPreviewLoading(true);
      try {
        // First fetch to discover the field set + each field's default strategy,
        // then RE-FETCH with those defaults folded into the fingerprint. The
        // preview's fingerprint must always equal the strategies we will apply
        // (otherwise apply would see a spurious mismatch and report stale).
        const initial = await integration.getPreview(extractionId);
        const seed: StrategyMap = {};
        for (const field of initial.plan.fields) seed[field.field] = field.defaultStrategy;
        const next =
          initial.plan.fields.length > 0
            ? await integration.getPreview(extractionId, seed)
            : initial;
        setPreview(next);
        setStrategies(seed);
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewLoading(false);
      }
    },
    [integration],
  );

  /**
   * Regenerates the current preview with a given strategy map so the preview's
   * fingerprint always equals the choices the user will apply. Used after a
   * strategy change (keeps apply honest: a mismatch can only ever come from the
   * record/target changing OUTSIDE the UI, which is exactly the stale case).
   */
  const regenerateWithStrategies = useCallback(
    async (extractionId: string, next: StrategyMap) => {
      try {
        const fresh = await integration.getPreview(extractionId, next);
        setPreview(fresh);
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : String(error));
      }
    },
    [integration],
  );

  /**
   * Explicit Apply. Uses the preview's OWN fingerprint and the strategy choices
   * it was generated with. Because a strategy change regenerates the preview
   * (see `regenerateWithStrategies`), the fingerprint and choices always agree;
   * a mismatch therefore means the record/target changed OUTSIDE the UI, which
   * the service refuses as `stale-preview` and we report here.
   */
  const doApply = useCallback(async () => {
    if (!preview) return;
    const extractionId = preview.extractionId;
    setApplyError(null);
    setApplyResult(null);
    const input: ApplyIntegrationInput = {
      previewFingerprint: preview.fingerprint,
      fieldStrategies: strategies,
    };
    try {
      const result = await integration.apply(extractionId, input);
      // Keep the preview mounted so the success panel (target id) stays visible;
      // the applied record simply disappears from the pending queue.
      setApplyResult(result);
    } catch (error) {
      const reason = (error as { reason?: string })?.reason;
      const message = error instanceof Error ? error.message : String(error);
      setApplyError(
        reason === 'stale-preview'
          ? `This preview is stale - the record, its evidence, the target entity or your choices changed since the preview was generated. Regenerate the preview and apply again.`
          : message,
      );
    }
  }, [integration, preview, strategies]);

  const setStrategy = (field: string, strategy: ConflictStrategy) => {
    const next = { ...strategies, [field]: strategy };
    setStrategies(next);
    // Re-fold the choice into the preview so its fingerprint matches on apply.
    if (preview) void regenerateWithStrategies(preview.extractionId, next);
  };

  const selectProject = (next: string) => {
    setProjectId(next);
    resetDetail();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Project Integration"
        description="Merge confirmed extractions into your project. A preview is read-only - nothing is written until you explicitly apply it, and conflicts are never overwritten without your choice."
        actions={<ProjectPicker projects={projects} value={effectiveProjectId} onChange={selectProject} />}
      />

      {projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects...
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<Merge className="size-5" aria-hidden />}
          title="No projects yet"
          description="Integration is per project. Create a project and confirm some extractions first."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
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
                    placeholder="Search title or summary..."
                    className="pl-7"
                    aria-label="Search pending extractions"
                  />
                </div>
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
              {integration.status === 'success' ? (
                <p className="text-subtle text-2xs" role="status">
                  {integration.pending.length} confirmed record{integration.pending.length === 1 ? '' : 's'} awaiting
                  integration
                  {kindFilter || search ? ` (${filtered.length} shown after filters)` : ''}.
                </p>
              ) : null}
            </Card>

            {integration.loading && integration.pending.length === 0 ? (
              <Card padding="lg">
                <p className="text-subtle text-xs" role="status">
                  Loading pending extractions...
                </p>
              </Card>
            ) : integration.status === 'error' ? (
              <Card padding="lg" className="space-y-2">
                <p className="text-danger text-xs" role="alert">
                  {integration.error instanceof Error ? integration.error.message : String(integration.error)}
                </p>
                <Button variant="secondary" size="sm" onClick={() => void integration.refresh()}>
                  Retry
                </Button>
              </Card>
            ) : integration.pending.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck className="size-5" aria-hidden />}
                title="Nothing awaiting integration"
                description="Confirm extractions in the Extraction Review Center and they will appear here for integration."
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Search className="size-5" aria-hidden />}
                title="No records match the filters"
                description="Adjust the search or kind filter to see pending extractions."
              />
            ) : (
              <ul className="space-y-2">
                {filtered.map((record) => (
                  <li key={record.id}>
                    <QueueCard
                      record={record}
                      selected={record.id === selectedId}
                      onOpen={() => void openPreview(record.id)}
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
                  Select a record to generate a read-only integration preview. Nothing is applied until you choose to.
                </p>
              </Card>
            ) : previewError ? (
              <Card padding="lg" className="space-y-2">
                <p className="text-danger text-xs" role="alert">
                  {previewError}
                </p>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void openPreview(selectedId)}>
                    Retry preview
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetDetail}>
                    Close
                  </Button>
                </div>
              </Card>
            ) : previewLoading || !preview ? (
              <Card padding="lg">
                <p className="text-subtle text-xs" role="status">
                  Generating read-only preview...
                </p>
              </Card>
            ) : (
              <PreviewView
                preview={preview}
                strategies={strategies}
                applying={integration.applying}
                applyResult={applyResult}
                applyError={applyError}
                onStrategy={setStrategy}
                onApply={() => void doApply()}
                onRegenerate={() => {
                  setApplyError(null);
                  void regenerateWithStrategies(preview.extractionId, strategies);
                }}
                onClose={resetDetail}
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
  selected,
  onOpen,
}: {
  record: ExtractionRecord;
  selected: boolean;
  onOpen: () => void;
}) {
  const target = TARGET_TYPE_META[kindToTargetType(record.kind)];
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
            <Badge tone="info" size="sm">
              {'→ '}
              {target.label}
            </Badge>
            <Badge tone={origin.tone} size="sm">
              {origin.label}
            </Badge>
          </div>
          <h3 className="text-ink mt-1 truncate text-sm font-semibold">{record.title}</h3>
          {record.summary ? <p className="text-muted line-clamp-2 text-2xs">{record.summary}</p> : null}
        </div>
        <span className="text-subtle shrink-0 text-2xs tabular-nums">{formatConfidence(record.confidence)}</span>
      </div>
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function PreviewView({
  preview,
  strategies,
  applying,
  applyResult,
  applyError,
  onStrategy,
  onApply,
  onRegenerate,
  onClose,
}: {
  preview: IntegrationPreview;
  strategies: StrategyMap;
  applying: boolean;
  applyResult: IntegrationItemResult | null;
  applyError: string | null;
  onStrategy: (field: string, strategy: ConflictStrategy) => void;
  onApply: () => void;
  onRegenerate: () => void;
  onClose: () => void;
}) {
  const record = preview.record;
  const plan = preview.plan;
  const target = TARGET_TYPE_META[plan.targetType];

  // An apply can only proceed when the preview is still applicable: the record
  // is not already integrated, at least one evidence locator is valid, and it
  // has not already been applied in this session.
  const conflictFields = plan.fields.filter((f) => f.conflict);

  return (
    <Card padding="md" className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="accent" size="sm">
              {KIND_LABELS[record.kind]}
            </Badge>
            <Badge tone="info" size="sm">
              {target.label}
            </Badge>
            <Badge tone={plan.expectedAction === 'update' ? 'warning' : 'success'} size="sm">
              {plan.expectedAction === 'update' ? 'Update existing' : 'Create new'}
            </Badge>
            {preview.alreadyIntegrated ? (
              <Badge tone="success" size="sm">
                Already integrated
              </Badge>
            ) : null}
          </div>
          <h2 className="text-ink mt-1 text-base font-semibold">{record.title}</h2>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close preview"
          icon={<X className="size-4" aria-hidden />}
          onClick={onClose}
        />
      </div>

      {/* Routing decision + existing match */}
      <div className="bg-surface-muted/60 rounded-md border border-line p-2.5 text-2xs">
        <p className="text-subtle font-medium tracking-wide uppercase">Routing</p>
        <p className="text-ink mt-1">
          {plan.expectedAction === 'create' ? 'Will create a new ' : 'Will update the existing '}
          <span className="font-semibold">{target.label.toLowerCase()}</span>
          {plan.existingMatch ? (
            <>
              {' '}
              <span className="font-mono">{plan.existingMatch.label}</span>
            </>
          ) : null}
          . {target.description}
        </p>
        <p className="text-subtle mt-1">
          {preview.evidenceValid ? (
            <span className="text-success inline-flex items-center gap-1">
              <ShieldCheck className="size-3" aria-hidden /> Evidence verified against the current text.
            </span>
          ) : (
            <span className="text-danger inline-flex items-center gap-1">
              <AlertTriangle className="size-3" aria-hidden /> No evidence locator still resolves - apply will be
              refused.
            </span>
          )}
        </p>
      </div>

      {/* Evidence */}
      <div className="space-y-1.5">
        <h3 className="text-subtle text-2xs font-medium tracking-wide uppercase">Source evidence</h3>
        {preview.evidence.length === 0 ? (
          <p className="text-subtle text-2xs">No evidence locations.</p>
        ) : (
          <ul className="space-y-1.5">
            {preview.evidence.map((ev, index) => (
              <li
                key={`${ev.sectionId}:${ev.start}:${ev.end}:${index}`}
                className={
                  'rounded-md border p-2 text-2xs ' +
                  (ev.valid ? 'border-line bg-surface-muted' : 'border-danger/40 bg-danger/5')
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-subtle truncate font-mono">
                    {ev.sectionTitle || ev.sectionId} [{ev.start}, {ev.end})
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
                {ev.slice !== null ? <q className="text-ink mt-1 block whitespace-pre-wrap">{ev.slice}</q> : null}
                {!ev.valid && ev.problem ? <p className="text-danger mt-1">{ev.problem}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Field-level conflicts / mappings */}
      <div className="space-y-1.5">
        <h3 className="text-subtle text-2xs font-medium tracking-wide uppercase">
          Fields {conflictFields.length > 0 ? `(${conflictFields.length} conflict${conflictFields.length === 1 ? '' : 's'})` : '(no conflicts)'}
        </h3>
        {plan.fields.length === 0 ? (
          <p className="text-subtle text-2xs">No mapped fields.</p>
        ) : (
          <ul className="space-y-2">
            {plan.fields.map((field) => (
              <FieldMappingRow
                key={field.field}
                field={field}
                strategy={strategies[field.field] ?? field.defaultStrategy}
                unsupported={plan.unsupportedFields.includes(field.field)}
                disabled={applying || plan.unsupportedFields.includes(field.field)}
                onChange={(strategy) => onStrategy(field.field, strategy)}
              />
            ))}
          </ul>
        )}
      </div>

      {applyError ? (
        <div className="border-danger/40 bg-danger/5 rounded-md border p-2 text-2xs" role="alert">
          <p className="text-danger">{applyError}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            iconLeft={<RefreshCw className="size-3.5" />}
            onClick={onRegenerate}
          >
            Regenerate preview
          </Button>
        </div>
      ) : null}

      {applyResult ? (
        <div className="border-success/40 bg-success-soft/40 rounded-md border p-2.5 text-2xs" role="status">
          <p className="text-success inline-flex items-center gap-1 font-medium">
            <CheckCircle2 className="size-3.5" aria-hidden />
            {applyResult.applied === 'created' ? 'Created' : 'Updated'} {TARGET_TYPE_META[applyResult.target.type].label.toLowerCase()} - integration complete.
          </p>
          <p className="text-subtle mt-1">
            Target id: <span className="text-ink font-mono">{applyResult.target.id}</span>
          </p>
          {applyResult.conflicts.length > 0 ? (
            <p className="text-subtle mt-1">
              Resolved {applyResult.conflicts.length} conflict{applyResult.conflicts.length === 1 ? '' : 's'}.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          variant="primary"
          size="sm"
          iconLeft={<Merge className="size-3.5" />}
          onClick={onApply}
          loading={applying}
          disabled={applying || !preview.evidenceValid || preview.alreadyIntegrated || Boolean(applyResult)}
        >
          Apply integration
        </Button>
        <span className="text-subtle inline-flex items-center gap-1 text-2xs">
          <Eye className="size-3.5" aria-hidden /> Preview only - nothing is written until you apply.
        </span>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function FieldMappingRow({
  field,
  strategy,
  unsupported,
  disabled,
  onChange,
}: {
  field: PreviewFieldMapping;
  strategy: ConflictStrategy;
  unsupported: boolean;
  disabled: boolean;
  onChange: (strategy: ConflictStrategy) => void;
}) {
  return (
    <li className="rounded-md border border-line p-2 text-2xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink font-medium">{fieldLabel(field.field)}</span>
        {field.conflict ? (
          <Badge tone="warning" size="sm">
            Conflict
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            No conflict
          </Badge>
        )}
      </div>
      <div className="mt-1 grid gap-1 sm:grid-cols-2">
        <div>
          <p className="text-subtle">Existing</p>
          <p className="text-muted line-clamp-3 whitespace-pre-wrap">{field.existing.trim() || '- (empty)'}</p>
        </div>
        <div>
          <p className="text-subtle">Extracted</p>
          <p className="text-ink line-clamp-3 whitespace-pre-wrap">{field.incoming.trim() || '- (empty)'}</p>
        </div>
      </div>
      <div className="mt-2">
        <Select
          value={strategy}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as ConflictStrategy)}
          aria-label={`Strategy for ${fieldLabel(field.field)}`}
        >
          {(['keep-existing', 'use-extracted', 'fill-empty-only'] as const).map((choice) => (
            <option key={choice} value={choice} disabled={unsupported && choice === 'use-extracted'}>
              {STRATEGY_META[choice].label}
            </option>
          ))}
        </Select>
        <p className="text-subtle mt-1">
          {unsupported
            ? 'This field cannot be safely updated from an extraction - only keep-existing is allowed.'
            : STRATEGY_META[strategy].help}
        </p>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */

/** Maps an extraction kind to the target entity type the service routes it to. */
function kindToTargetType(kind: ExtractionKind): 'character' | 'world-section' | 'knowledge-entry' {
  if (kind === 'character') return 'character';
  if (kind === 'location' || kind === 'faction' || kind === 'rule') return 'world-section';
  return 'knowledge-entry';
}
