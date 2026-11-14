import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Eye,
  FileText,
  ListTree,
  RefreshCw,
  ScanText,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '@/components/ui';
import type { DocumentSection } from '@/types';
import type { ParseDocumentResult } from '@/services';
import { cn } from '@/utils/cn';
import { ImportWorkflowShell } from './ImportWorkflowShell';
import { useImportWorkflow } from './ImportWorkflowProvider';
import {
  buildSectionTree,
  countSectionsByLevel,
  describeDocumentLifecycle,
  getStageMeta,
  type SectionTreeNode,
} from './import-workflow-stages';

/**
 * Document Parser page (P8 Batch 6).
 *
 * Stage 2 of the import pipeline. It turns the selected document's raw text
 * into addressable sections by calling `ImportService.parseDocument`, then lets
 * the user INSPECT the result:
 *   - a summary (counts per level, whether real structure was detected),
 *   - the section tree with each section's verbatim text and exact source
 *     offsets, so it is obvious that parsing never rewrites the manuscript,
 *   - a "re-parse" action (guarded by the service, which detects when the raw
 *     text has not changed and returns a no-op instead of duplicating work).
 *
 * Parsing does NOT confirm structure. Confirmation is a separate, explicit step
 * on the Structure Recognition page, because extraction is gated on it.
 *
 * The write path is `useImportDocuments().parseDocument` → `ImportService`.
 * This page never touches Dexie.
 */
export function DocumentParserPage() {
  return (
    <ImportWorkflowShell
      stage="parser"
      title="Document Parser"
      description="Break the document into sections. The raw text is never rewritten — each section points back to its exact source offsets."
    >
      <DocumentParserContent />
    </ImportWorkflowShell>
  );
}

function DocumentParserContent() {
  const workflow = useImportWorkflow();
  const navigate = useNavigate();
  const document = workflow.document;

  const [sections, setSections] = useState<DocumentSection[]>([]);
  const [loadingSections, setLoadingSections] = useState(false);
  const [lastParse, setLastParse] = useState<ParseDocumentResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

  const loadSections = useCallback(async () => {
    if (!document) {
      setSections([]);
      return;
    }
    setLoadingSections(true);
    setActionError(null);
    try {
      const next = await workflow.importDocs.getSections(document.id);
      setSections(next);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not load sections.');
      setSections([]);
    } finally {
      setLoadingSections(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.id]);

  // Load sections whenever the selected document changes, and after a parse.
  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const counts = useMemo(() => countSectionsByLevel(sections), [sections]);
  const tree = useMemo(() => buildSectionTree(sections), [sections]);
  const lifecycle = document ? describeDocumentLifecycle(document, sections.length) : null;
  const selectedSection = sections.find((section) => section.id === selectedSectionId) ?? null;

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

  const parse = async (options?: { force?: boolean }) => {
    setActionError(null);
    setMessage(null);
    setLastParse(null);
    try {
      const result = options?.force
        ? await workflow.importDocs.reparseDocument(document.id, { force: true })
        : await workflow.importDocs.parseDocument(document.id);
      setLastParse(result);
      await loadSections();
      const total = result.sectionCount;
      // `ParseDocumentResult` carries no "hasStructure" flag; the meaningful
      // signal is whether re-parsing actually regenerated the sections.
      const regenerated = result.parsed;
      setMessage(
        total === 0
          ? 'Parsing completed but produced no sections. Check the document text.'
          : regenerated
            ? `Parsed into ${total} section(s), each pointing at its exact source offsets.`
            : `No change — the raw text is unchanged since the last parse, so the existing ${total} section(s) were kept.`,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Parsing failed.');
    }
  };

  const continueToStructure = () => navigate(getStageMeta('structure').path);

  return (
    <div className="space-y-4">
      {/* ---------------------------- Document ---------------------------- */}
      <Card padding="md" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-ink truncate text-sm font-semibold">{document.fileName ?? 'Untitled document'}</h2>
            <p className="text-subtle text-2xs">
              {document.format === 'markdown' ? 'Markdown' : 'Plain text'} ·{' '}
              {document.rawText.length.toLocaleString()} chars · {document.wordCount.toLocaleString()} words
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {lifecycle ? (
              <Badge tone={lifecycle.structureConfirmed ? 'success' : document.status === 'imported' ? 'neutral' : 'warning'} size="sm">
                {lifecycle.label}
              </Badge>
            ) : null}
            {document.parsedAt ? (
              <Badge tone="neutral" size="sm">
                Parsed {new Date(document.parsedAt).toLocaleString()}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            variant="primary"
            size="sm"
            iconLeft={<ScanText className="size-3.5" />}
            onClick={() => void parse()}
            loading={workflow.importDocs.mutating}
          >
            {sections.length > 0 ? 'Parse again' : 'Parse document'}
          </Button>
          {sections.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<RefreshCw className="size-3.5" />}
              onClick={() => void parse({ force: true })}
              disabled={workflow.importDocs.mutating}
              title="Re-parse even if the raw text is unchanged"
            >
              Force re-parse
            </Button>
          ) : null}
          {sections.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              iconRight={<ArrowRight className="size-3.5" />}
              onClick={continueToStructure}
              className="ml-auto"
            >
              Continue to Structure Recognition
            </Button>
          ) : null}
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

      {/* ---------------------------- Summary ----------------------------- */}
      {sections.length > 0 ? (
        <Card padding="md">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-ink text-sm font-semibold">Parse summary</h2>
            {lastParse ? (


              <Badge tone={lastParse.parsed ? 'success' : 'neutral'} size="sm">
                {lastParse.parsed ? 'Structure regenerated' : 'Structure unchanged'}
              </Badge>
            ) : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['volume', 'Volumes'],
                ['chapter', 'Chapters'],
                ['scene', 'Scenes'],
                ['paragraph', 'Paragraphs'],
              ] as const
            ).map(([level, label]) => (
              <div key={level} className="bg-surface-muted rounded-md border border-line px-3 py-2">
                <dt className="text-subtle text-2xs font-medium uppercase tracking-wide">{label}</dt>
                <dd className="text-ink mt-0.5 text-lg font-semibold tabular-nums">{counts[level]}</dd>
              </div>
            ))}
          </dl>
          {!document.structureConfirmedAt ? (
            <p className="text-muted mt-3 text-2xs">
              These sections are a PROPOSAL. Confirm the structure on the Structure Recognition page before
              extraction can use them.
            </p>
          ) : (
            <p className="text-success mt-3 text-2xs">
              This structure is already confirmed. Editing it later will require re-confirmation.
            </p>
          )}
        </Card>
      ) : null}

      {/* ----------------------------- Sections --------------------------- */}
      <Card padding="md">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ink flex items-center gap-1.5 text-sm font-semibold">
            <ListTree className="size-4" aria-hidden />
            Sections
          </h2>
          <span className="text-subtle text-2xs tabular-nums">{sections.length} total</span>
        </div>

        {loadingSections ? (
          <p className="text-subtle mt-3 text-xs" role="status">
            Loading sections…
          </p>
        ) : sections.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<ScanText className="size-5" aria-hidden />}
              title="Not parsed yet"
              description="Click “Parse document” to break the raw text into sections. Nothing is written until you do."
            />
          </div>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="max-h-[28rem] overflow-y-auto rounded-md border border-line">
              <ul className="divide-line divide-y">
                {flatten(tree).map((node) => {
                  const isSelected = node.section.id === selectedSectionId;
                  return (
                    <li key={node.section.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedSectionId(node.section.id)}
                        aria-pressed={isSelected}
                        style={{ paddingLeft: `${0.75 + node.depth * 0.9}rem` }}
                        className={cn(
                          'flex w-full items-center gap-2 py-1.5 pr-2 text-left',
                          isSelected ? 'bg-accent-soft/50' : 'hover:bg-surface-muted',
                        )}
                      >
                        <Badge tone={levelTone(node.section.level)} size="sm" className="shrink-0 capitalize">
                          {node.section.level}
                        </Badge>
                        <span className="text-subtle shrink-0 text-2xs tabular-nums">
                          {node.section.text.length.toLocaleString()} ch
                        </span>
                        <Eye className="text-subtle size-3 shrink-0" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <SectionPreview section={selectedSection} />
          </div>
        )}
      </Card>
    </div>
  );
}

function levelTone(level: DocumentSection['level']) {
  switch (level) {
    case 'volume':
      return 'accent' as const;
    case 'chapter':
      return 'info' as const;
    case 'scene':
      return 'warning' as const;
    default:
      return 'neutral' as const;
  }
}

/** Depth-first list of every node (document order). */
function flatten(nodes: ReadonlyArray<SectionTreeNode>): SectionTreeNode[] {
  const out: SectionTreeNode[] = [];
  const walk = (list: ReadonlyArray<SectionTreeNode>) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Read-only preview of one section.
 *
 * The text shown is EXACTLY `document.rawText.slice(start, end)` — the page reads
 * it from the loaded document rather than trusting a cached copy, so what the
 * user sees is provably the stored source.
 */
function SectionPreview({ section }: { section: DocumentSection | null }) {
  const workflow = useImportWorkflow();
  const document = workflow.document;

  if (!section || !document) {
    return (
      <div className="text-subtle bg-surface-muted/50 grid min-h-40 place-items-center rounded-md border border-dashed border-line-strong px-4 text-center text-2xs">
        Select a section to see its exact source text and offsets.
      </div>
    );
  }

  const slice = document.rawText.slice(section.start, section.end);
  // Derived for DISPLAY only — never stored, so it can never drift from the
  // source text. `slice.length` equals `end - start` (schema-enforced).
  const wordCount = countWords(slice);

  return (
    <div className="flex min-h-40 flex-col rounded-md border border-line">
      <div className="border-line flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <Badge tone={levelTone(section.level)} size="sm" className="capitalize">
          {section.level}
        </Badge>
        <span className="text-ink min-w-0 flex-1 truncate text-xs font-medium">{section.title}</span>
        <span className="text-subtle text-2xs tabular-nums">
          [{section.start}, {section.end}) · order {section.order}
        </span>
      </div>
      <pre className="text-muted max-h-72 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-2xs leading-relaxed">
        {slice.length > 0 ? slice : '(empty section)'}
      </pre>
      <p className="text-subtle border-line border-t px-3 py-1.5 text-2xs">
        {slice.length.toLocaleString()} characters · {wordCount.toLocaleString()} words
      </p>
    </div>
  );
}

/**
 * Whitespace-delimited word count of a string (display helper).
 *
 * Deliberately local and pure: the parser summary only needs a rough size, and
 * `DocumentSection` stores no word count, so deriving it here keeps the page
 * from displaying a value that could drift from the stored text.
 */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
