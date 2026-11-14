import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Info,
  ListTree,
  RefreshCw,
  ScanText,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '@/components/ui';
import type { DocumentSection } from '@/types';
import { ImportWorkflowShell } from './ImportWorkflowShell';
import { useImportWorkflow } from './ImportWorkflowProvider';
import { SectionTreeEditor } from './SectionTreeEditor';
import {
  countSectionsByLevel,
  describeExtractionReadiness,
  getStageMeta,
} from './import-workflow-stages';

/**
 * Structure Recognition page (P8 Batch 6).
 *
 * Stage 3 of the import pipeline. It shows the hierarchy that the parser
 * detected and lets the user CORRECT it before confirming:
 *   - rename sections (structure metadata only —never the raw text),
 *   - change level / parent,
 *   - reorder siblings.
 *
 * The confirmation (`ImportService.confirmStructure`) is the GATE extraction
 * relies on: `ExtractionService` refuses to run on an unconfirmed document. The
 * page therefore:
 *   - shows the current confirmation state prominently,
 *   - disables "Confirm" when there are no sections,
 *   - re-reads the document after every edit so the UI reflects the fact that
 *     ANY structural edit clears the confirmation (you must re-confirm).
 *
 * All writes go through `useImportDocuments()` —`ImportService`; the page holds
 * no business rules of its own.
 */
export function StructureRecognitionPage() {
  return (
    <ImportWorkflowShell
      stage="structure"
      title="Structure Recognition"
      description="Correct the detected hierarchy, then confirm it. Confirmed structure is exactly what extraction is allowed to read."
    >
      <StructureRecognitionContent />
    </ImportWorkflowShell>
  );
}

function StructureRecognitionContent() {
  const workflow = useImportWorkflow();
  const navigate = useNavigate();
  const document = workflow.document;

  const [sections, setSections] = useState<DocumentSection[]>([]);
  const [loadingSections, setLoadingSections] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadSections = useCallback(async () => {
    if (!document) {
      setSections([]);
      return;
    }
    setLoadingSections(true);
    try {
      setSections(await workflow.importDocs.getSections(document.id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not load sections.');
      setSections([]);
    } finally {
      setLoadingSections(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.id]);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const counts = useMemo(() => countSectionsByLevel(sections), [sections]);
  const readiness = document ? describeExtractionReadiness(document, sections.length) : null;
  const structureConfirmed = Boolean(document?.structureConfirmedAt);

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

  const confirm = async () => {
    setActionError(null);
    setMessage(null);
    try {
      await workflow.importDocs.confirmStructure(document.id);
      setMessage('Structure confirmed. Extraction can now run on this document.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not confirm the structure.');
    }
  };

  const saveSection = async (sectionId: string, input: Parameters<typeof workflow.importDocs.updateSection>[1]) => {
    setActionError(null);
    setMessage(null);
    setSavingId(sectionId);
    try {
      await workflow.importDocs.updateSection(sectionId, input);
      // Any structural edit clears confirmation (the service enforces this); make
      // that explicit instead of silently leaving a stale "Confirmed" badge.
      if (structureConfirmed) {
        setMessage('Structure edited —confirmation was cleared. Review the changes, then confirm again.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not update the section.');
      throw err;
    } finally {
      setSavingId(null);
    }
  };

  const reorder = async (orderedIds: string[]) => {
    setActionError(null);
    try {
      await workflow.importDocs.reorderSections(document.id, orderedIds);
      if (structureConfirmed) {
        setMessage('Order changed —confirmation was cleared. Confirm again to enable extraction.');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not reorder the sections.');
      throw err;
    }
  };

  const canConfirm = sections.length > 0 && !structureConfirmed && !workflow.importDocs.mutating;

  return (
    <div className="space-y-4">
      {/* --------------------------- Status card -------------------------- */}
      <Card padding="md" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-ink truncate text-sm font-semibold">{document.fileName ?? 'Untitled document'}</h2>
            {sections.length === 0 ? (
              <p className="text-warning mt-0.5 text-2xs">
                This document has not been parsed yet. Parse it on the Document Parser stage first.
              </p>
            ) : (
              <p className="text-subtle text-2xs">
                {sections.length} section(s): {counts.volume} volume(s) · {counts.chapter} chapter(s) ·{' '}
                {counts.scene} scene(s) · {counts.paragraph} paragraph(s)
              </p>
            )}
          </div>
          <Badge tone={structureConfirmed ? 'success' : sections.length === 0 ? 'neutral' : 'warning'} size="sm">
            {structureConfirmed ? 'Structure confirmed' : sections.length === 0 ? 'Not parsed' : 'Not confirmed'}
          </Badge>
        </div>

        {readiness && !readiness.ready ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2">
            <Info className="text-warning mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p className="text-warning text-2xs">{readiness.reason}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {sections.length === 0 ? (
            <Button
              variant="secondary"
              size="sm"
              iconRight={<ArrowRight className="size-3.5" />}
              onClick={() => navigate(getStageMeta('parser').path)}
            >
              Go to Document Parser
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                iconLeft={<ShieldCheck className="size-3.5" />}
                onClick={() => void confirm()}
                disabled={!canConfirm}
                loading={workflow.importDocs.mutating && !savingId}
              >
                {structureConfirmed ? 'Confirmed' : 'Confirm structure'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconLeft={<RefreshCw className="size-3.5" />}
                onClick={() => void loadSections()}
                disabled={loadingSections || workflow.importDocs.mutating}
              >
                Reload
              </Button>
              {structureConfirmed ? (
                <Button
                  variant="secondary"
                  size="sm"
                  iconRight={<ArrowRight className="size-3.5" />}
                  onClick={() => navigate(getStageMeta('extraction').path)}
                  className="ml-auto"
                >
                  Continue to Extraction
                </Button>
              ) : null}
            </>
          )}
        </div>

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
      </Card>

      {/* ---------------------------- Editor ----------------------------- */}
      <Card padding="md">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ink flex items-center gap-1.5 text-sm font-semibold">
            <ListTree className="size-4" aria-hidden />
            Hierarchy
          </h2>
          <span className="text-subtle text-2xs">
            Edits change structure metadata only —the raw text is never modified.
          </span>
        </div>

        {loadingSections ? (
          <p className="text-subtle mt-3 text-xs" role="status">
            Loading sections—          </p>
        ) : sections.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<ScanText className="size-5" aria-hidden />}
              title="Nothing to structure yet"
              description="Parse the document to create sections you can review and correct."
            />
          </div>
        ) : (
          <div className="mt-3 overflow-hidden rounded-md border border-line">
            <SectionTreeEditor
              sections={sections}
              busy={workflow.importDocs.mutating}
              savingId={savingId}
              onUpdate={saveSection}
              onReorder={reorder}
              onReload={loadSections}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
