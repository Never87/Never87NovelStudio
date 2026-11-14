import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Circle, FolderKanban, FileText, AlertTriangle } from 'lucide-react';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { cn } from '@/utils/cn';
import { ImportWorkflowProvider, useImportWorkflow } from './ImportWorkflowProvider';
import {
  IMPORT_WORKFLOW_STAGES,
  describeDocumentLifecycle,
  getStageMeta,
  type ImportWorkflowStage,
} from './import-workflow-stages';
import { STAGE_ICONS } from './stage-icons';

/**
 * Shell shared by every "Import & Analysis" workflow page (P8 Batch 6).
 *
 * Renders, above each stage's own content:
 *   1. the stage stepper (Import → Parser → Structure → Extraction → Review →
 *      Integration), with the current stage highlighted,
 *   2. the project picker (the pipeline is strictly per-project),
 *   3. the document picker + a one-line lifecycle summary of the selected
 *      document, so the user always knows which document the stage acts on.
 *
 * The document selection is shared across stages through `ImportWorkflowProvider`
 * (mounted here, so it wraps ALL workflow routes and survives navigation between
 * them). Pages receive the current stage + their content; they still load their
 * own stage-specific data from the services.
 *
 * IMPORTANT: this component never mutates data. Every action here only changes
 * the SELECTION or navigates; writes happen in the page content, through the
 * hooks/services, behind an explicit user action.
 */
export interface ImportWorkflowPageProps {
  stage: ImportWorkflowStage;
  /** Page headline; defaults to the stage's title. */
  title?: string;
  description?: ReactNode;
  /** Stage-specific actions rendered on the right of the page header. */
  actions?: ReactNode;
  /**
   * Content of the stage. It is rendered inside the shell, so it can rely on the
   * shared selection through `useImportWorkflow()`.
   */
  children: ReactNode;
  /**
   * When true the stage is expected to operate on ONE document and the shell
   * shows the document picker. The Import stage sets this false (it CREATES
   * documents and shows its own list).
   */
  requiresDocument?: boolean;
}

export function ImportWorkflowShell(props: ImportWorkflowPageProps) {
  return (
    <ImportWorkflowProvider>
      <ImportWorkflowShellInner {...props} />
    </ImportWorkflowProvider>
  );
}

function ImportWorkflowShellInner({
  stage,
  title,
  description,
  actions,
  children,
  requiresDocument = true,
}: ImportWorkflowPageProps) {
  const meta = getStageMeta(stage);
  const workflow = useImportWorkflow();
  const navigate = useNavigate();

  const headerActions = (
    <>
      {workflow.projects.length > 0 ? (
        <label className="flex items-center gap-2">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Project</span>
          <select
            id="import-workflow-project-picker"
            aria-label="Workflow project"
            value={workflow.projectId}
            onChange={(event) => workflow.setProjectId(event.target.value)}
            className="bg-surface border-line-strong text-ink h-8 min-w-44 rounded-md border px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {workflow.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {actions}
    </>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={title ?? meta.title}
        description={description ?? meta.summary}
        eyebrow="Import & Analysis"
        icon={<StageIcon stage={stage} />}
        actions={headerActions}
      />

      <WorkflowStepper stage={stage} documentAvailable={Boolean(workflow.document)} />

      {workflow.projectsLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects…
          </p>
        </Card>
      ) : workflow.projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="size-5" aria-hidden />}
          title="No projects yet"
          description="Imported documents belong to a project. Create a project first, then come back to import a manuscript."
          action={
            <Link
              to="/projects"
              className="bg-accent text-white dark:text-[#12141a] hover:bg-accent-hover inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium"
            >
              Go to My Projects
            </Link>
          }
        />
      ) : (
        <>
          {requiresDocument ? (
            <DocumentPicker
              projectsExist={workflow.projects.length > 0}
              documents={workflow.documents}
              loading={workflow.documentsLoading}
              error={workflow.documentsError}
              selectedId={workflow.documentId}
              onSelect={workflow.selectDocument}
              onGoToImport={() => navigate(getStageMeta('import').path)}
            />
          ) : null}
          {children}
        </>
      )}
    </div>
  );
}

function StageIcon({ stage }: { stage: ImportWorkflowStage }) {
  const Icon = STAGE_ICONS[stage];
  return <Icon className="size-4" aria-hidden />;
}

/* -------------------------------------------------------------------------- */
/* Stepper                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ordered stage indicator.
 *
 * `import`, `parser`, `structure` and `extraction` are real pages in this batch;
 * `review` and `integration` are real pages from P8.4/P8.5 and are linked but
 * their content is NOT part of this batch. Every step is a link, so the stepper
 * doubles as navigation.
 */
function WorkflowStepper({
  stage,
  documentAvailable,
}: {
  stage: ImportWorkflowStage;
  documentAvailable: boolean;
}) {
  const currentIndex = IMPORT_WORKFLOW_STAGES.findIndex((candidate) => candidate.stage === stage);

  return (
    <nav aria-label="Import workflow" className="overflow-x-auto">
      <ol className="flex min-w-max items-center gap-1">
        {IMPORT_WORKFLOW_STAGES.map((candidate, index) => {
          const Icon = STAGE_ICONS[candidate.stage];
          const isCurrent = candidate.stage === stage;
          const isDone = index < currentIndex;
          // Review/integration depend on a selected document existing, but they
          // are always reachable so the user can inspect the queue directly.
          return (
            <li key={candidate.stage} className="flex items-center gap-1">
              <Link
                to={candidate.path}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  isCurrent
                    ? 'border-accent bg-accent-soft/50 text-ink font-medium'
                    : 'border-line text-muted hover:border-line-strong hover:bg-surface-muted hover:text-ink',
                )}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full',
                    isCurrent ? 'bg-accent text-white dark:text-[#12141a]' : isDone ? 'bg-success/15 text-success' : 'bg-surface-muted text-subtle',
                  )}
                  aria-hidden
                >
                  {isDone ? <Check className="size-3" /> : <Icon className="size-3" />}
                </span>
                <span className="whitespace-nowrap">{candidate.title}</span>
              </Link>
              {index < IMPORT_WORKFLOW_STAGES.length - 1 ? (
                <ChevronRight className="text-subtle size-3 shrink-0" aria-hidden />
              ) : null}
            </li>
          );
        })}
      </ol>
      {!documentAvailable ? (
        <p className="text-subtle mt-2 flex items-center gap-1.5 text-2xs" role="note">
          <Circle className="size-2.5" aria-hidden />
          No document selected yet — pick one below to continue through the stages.
        </p>
      ) : null}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Document picker                                                            */
/* -------------------------------------------------------------------------- */

const LIFECYCLE_TONE: Record<string, BadgeTone> = {
  imported: 'neutral',
  parsed: 'warning',
  confirmed: 'success',
  extracted: 'accent',
};

function DocumentPicker({
  projectsExist,
  documents,
  loading,
  error,
  selectedId,
  onSelect,
  onGoToImport,
}: {
  projectsExist: boolean;
  documents: Awaited<ReturnType<typeof useImportWorkflow>>['documents'];
  loading: boolean;
  error: unknown;
  selectedId: string | null;
  onSelect: (documentId: string | null) => void;
  onGoToImport: () => void;
}) {
  const workflow = useImportWorkflow();
  const selected = documents.find((doc) => doc.id === selectedId) ?? null;

  // The lifecycle badge needs the real section count, which is per-document.
  // `document-section-stats` is loaded once per selected document so the summary
  // ("Not parsed" vs "Structure unconfirmed" vs "Structure confirmed") is
  // accurate rather than inferred from the status alone.
  const [sectionCount, setSectionCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setSectionCount(null);
    if (!selected) return;
    void workflow.importDocs
      .getSections(selected.id)
      .then((sections) => {
        if (active) setSectionCount(sections.length);
      })
      .catch(() => {
        if (active) setSectionCount(0);
      });
    return () => {
      active = false;
    };
    // Re-derive when the document row changes (a parse/confirm updates its status).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status, selected?.structureConfirmedAt]);

  const lifecycle = selected
    ? describeDocumentLifecycle(selected, sectionCount ?? (selected.status === 'imported' ? 0 : 1))
    : null;

  return (
    <Card padding="md" className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <FileText className="text-subtle size-4 shrink-0" aria-hidden />
        <label htmlFor="import-workflow-document-picker" className="text-subtle text-2xs font-medium uppercase tracking-wide">
          Document
        </label>
        <select
          id="import-workflow-document-picker"
          aria-label="Workflow document"
          value={selectedId ?? ''}
          onChange={(event) => onSelect(event.target.value || null)}
          disabled={documents.length === 0}
          className="bg-surface border-line-strong text-ink h-8 min-w-56 max-w-full rounded-md border px-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60"
        >
          {documents.length === 0 ? <option value="">No documents</option> : null}
          {documents.length > 0 && !selected ? <option value="">Select a document…</option> : null}
          {documents.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.fileName ?? doc.id}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-subtle text-2xs" role="status">
          Loading documents…
        </p>
      ) : error ? (
        <p className="text-danger flex items-center gap-1.5 text-2xs" role="alert">
          <AlertTriangle className="size-3" aria-hidden />
          {error instanceof Error ? error.message : 'Failed to load documents.'}
        </p>
      ) : documents.length === 0 && projectsExist ? (
        <button
          type="button"
          onClick={onGoToImport}
          className="text-accent text-2xs font-medium underline underline-offset-2"
        >
          No documents yet — import one first
        </button>
      ) : lifecycle ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge tone={LIFECYCLE_TONE[lifecycle.phase] ?? 'neutral'} size="sm">
            {lifecycle.label}
          </Badge>
          <span className="text-subtle text-2xs">
            {selected?.format === 'markdown' ? 'Markdown' : 'Plain text'} ·{' '}
            {selected ? `${selected.rawText.length.toLocaleString()} chars` : ''}
          </span>
          {lifecycle.nextAction ? (
            <span className="text-muted hidden text-2xs sm:inline">Next: {lifecycle.nextAction}</span>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
