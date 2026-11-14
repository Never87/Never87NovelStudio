import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  FileUp,
  Info,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton } from '@/components/ui';
import type { DocumentFormat, SourceDocument } from '@/types';
import { cn } from '@/utils/cn';
import { hashRawText } from '@/utils/text-hash';
import { ImportWorkflowShell } from './ImportWorkflowShell';
import { useImportWorkflow } from './ImportWorkflowProvider';
import {
  IMPORT_ACCEPT_ATTRIBUTE,
  IMPORT_FORMAT_LIMITS,
  describeDocumentLifecycle,
  findPotentialDuplicate,
  getStageMeta,
  inferDocumentFormat,
  validateRawText,
} from './import-workflow-stages';

/**
 * Manuscript Import page (P8 Batch 6).
 *
 * Stage 1 of the pipeline. It registers documents against the selected project
 * via `useImportDocuments().createDocument` → `ImportService`. It only CREATES
 * the `SourceDocument` (immutable raw text); it never parses, confirms or
 * extracts — those are later stages.
 *
 * Duplicate protection is deliberate and layered:
 *   1. `findPotentialDuplicate` compares normalised file name and the exact raw
 *      text against the already-loaded documents (instant, no I/O).
 *   2. Before writing, the incoming text is hashed (`hashRawText`) and compared
 *      with each document's exact text and stored `parsedTextHash`, so a
 *      byte-identical re-import always asks for confirmation first.
 * Nothing is written until the user resolves that prompt — a silent overwrite or
 * silent duplicate is never possible. Import always ADDS a document; it never
 * modifies or deletes existing project data.
 *
 * This is the P8 document-import workflow and is independent of the P4 Markdown
 * manuscript import, which targets chapters/scenes and is untouched here.
 */
export function ManuscriptImportPage() {
  return (
    <ImportWorkflowShell
      stage="import"
      requiresDocument={false}
      title="Manuscript Import"
      description="Register a TXT or Markdown file (or pasted text) as a source document. The text is stored verbatim and parsed in the next stage."
    >
      <ManuscriptImportContent />
    </ImportWorkflowShell>
  );
}

type ImportSource = 'file' | 'paste';

function ManuscriptImportContent() {
  const workflow = useImportWorkflow();
  const navigate = useNavigate();

  const [source, setSource] = useState<ImportSource>('file');
  const [fileName, setFileName] = useState<string>('');
  const [format, setFormat] = useState<DocumentFormat>('txt');
  const [rawText, setRawText] = useState<string>('');
  const [pastedName, setPastedName] = useState<string>('');

  const [fileError, setFileError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<string[] | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const documents = workflow.documents;

  const effectiveName = source === 'file' ? fileName : pastedName.trim();
  const textProblem = rawText.length > 0 ? validateRawText(rawText) : null;

  /** Live, non-destructive hint about a likely duplicate. */
  const duplicateHint = useMemo(
    () =>
      rawText.trim().length > 0
        ? findPotentialDuplicate(documents, { fileName: effectiveName || null, rawText })
        : { byName: [], identical: [] },
    [documents, effectiveName, rawText],
  );

  const resetForm = () => {
    setFileName('');
    setRawText('');
    setPastedName('');
    setFormat('txt');
    setFileError(null);
    setDuplicatePrompt(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const readFile = async (file: File) => {
    setFileError(null);
    setActionError(null);
    setMessage(null);
    setDuplicatePrompt(null);

    const inferred = inferDocumentFormat(file.name);
    if (!inferred) {
      setFileError(
        `“${file.name}” is not a supported format. Import plain text (.txt) or Markdown (.md, .markdown) — export other formats first.`,
      );
      resetForm();
      return;
    }

    try {
      const text = await file.text();
      const problem = validateRawText(text);
      if (problem) {
        setFileError(problem);
        return;
      }
      setFileName(file.name);
      setFormat(inferred);
      setRawText(text);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'Could not read the file.');
    }
  };

  /**
   * Authoritative duplicate check before writing.
   *
   * Hashes the incoming text once and compares it with each loaded document's
   * exact raw text AND its stored `parsedTextHash` (so an already-parsed
   * byte-identical document is caught even if its text is not loaded here).
   * Returns the list of conflicting descriptions, or null when clear.
   */
  const findHashConflicts = (text: string): string[] | null => {
    const incomingHash = hashRawText(text);
    const conflicts: string[] = [];
    for (const doc of documents) {
      const sameText = doc.rawText === text || doc.rawText.length === text.length && doc.rawText === text;
      const sameHash = doc.parsedTextHash === incomingHash;
      if (sameText || sameHash) {
        conflicts.push(doc.fileName ?? 'Untitled document');
      }
    }
    return conflicts.length > 0 ? conflicts : null;
  };

  const createDocument = async () => {
    setActionError(null);
    setMessage(null);

    const name = effectiveName || null;
    const problem = validateRawText(rawText);
    if (problem) {
      setActionError(problem);
      return;
    }

    try {
      const created = await workflow.importDocs.createDocument({
        fileName: name,
        format,
        rawText,
      });
      setMessage(
        `Imported “${created.fileName ?? 'Untitled document'}” (${created.rawText.length.toLocaleString()} chars). Next: parse it into sections.`,
      );
      resetForm();
      workflow.selectDocument(created.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Import failed.');
    }
  };

  /** Runs the hash conflict check, then imports or asks for confirmation. */
  const submit = async () => {
    setActionError(null);
    setMessage(null);
    const problem = validateRawText(rawText);
    if (problem) {
      setActionError(problem);
      return;
    }
    const conflicts = findHashConflicts(rawText);
    if (conflicts) {
      setDuplicatePrompt(conflicts);
      return;
    }
    await createDocument();
  };

  const canSubmit =
    rawText.trim().length > 0 && !textProblem && !workflow.importDocs.mutating && duplicatePrompt === null;

  return (
    <div className="space-y-4">
      {/* ---------------------------- Import form ------------------------- */}
      <Card padding="md" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-ink text-sm font-semibold">Add a source document</h2>
            <p className="text-muted mt-0.5 text-xs">
              Documents belong to the current project. Nothing is parsed until you continue to the Document Parser.
            </p>
          </div>
          <Badge tone="accent" size="sm">
            Stage 1 · Import
          </Badge>
        </div>

        {/* Source switch */}
        <div className="inline-flex rounded-md border border-line p-0.5" role="tablist" aria-label="Import source">
          {(
            [
              ['file', 'Upload file', FileUp],
              ['paste', 'Paste text', FileText],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={source === value}
              onClick={() => setSource(value)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-2xs font-medium transition-colors',
                source === value ? 'bg-accent-soft text-accent-soft-text' : 'text-muted hover:text-ink',
              )}
            >
              <Icon className="size-3" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {source === 'file' ? (
          <div className="space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={IMPORT_ACCEPT_ATTRIBUTE}
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
            <div className="border-line-strong bg-surface-muted/40 flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-5">
              <Upload className="text-subtle size-5" aria-hidden />
              <div className="min-w-0 flex-1">
                {fileName ? (
                  <>
                    <p className="text-ink truncate text-xs font-medium">{fileName}</p>
                    <p className="text-subtle text-2xs">
                      {format === 'markdown' ? 'Markdown' : 'Plain text'} ·{' '}
                      {rawText.length.toLocaleString()} chars
                    </p>
                  </>
                ) : (
                  <p className="text-muted text-xs">Choose a .txt or .md file to import.</p>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<FileUp className="size-3.5" />}
                onClick={() => fileInputRef.current?.click()}
                disabled={workflow.importDocs.mutating}
              >
                {fileName ? 'Choose another file' : 'Choose file'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label className="flex flex-col gap-1">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Document name (optional)
              </span>
              <input
                value={pastedName}
                onChange={(event) => setPastedName(event.target.value)}
                placeholder="e.g. Draft 3 — Pasted"
                disabled={workflow.importDocs.mutating}
                className="bg-surface border-line-strong text-ink h-8 rounded-md border px-2 text-xs disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Manuscript text</span>
              <textarea
                value={rawText}
                onChange={(event) => setRawText(event.target.value)}
                rows={8}
                placeholder="Paste the full text here. It is stored verbatim and never rewritten."
                disabled={workflow.importDocs.mutating}
                className="bg-surface border-line-strong text-ink w-full rounded-md border px-2 py-1.5 font-mono text-2xs disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Format</span>
              <select
                value={format}
                onChange={(event) => setFormat(event.target.value as DocumentFormat)}
                disabled={workflow.importDocs.mutating}
                className="bg-surface border-line-strong text-ink h-8 w-40 rounded-md border px-2 text-xs disabled:opacity-60"
              >
                <option value="txt">Plain text</option>
                <option value="markdown">Markdown</option>
              </select>
            </label>
          </div>
        )}

        {/* Live size / validation */}
        {rawText.length > 0 ? (
          <p className={cn('text-2xs', textProblem ? 'text-danger' : 'text-subtle')}>
            {textProblem ?? `${rawText.length.toLocaleString()} characters ready to import.`}
          </p>
        ) : null}

        {fileError ? (
          <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            {fileError}
          </p>
        ) : null}
        {actionError ? (
          <p className="text-danger flex items-start gap-1.5 text-2xs" role="alert">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            {actionError}
          </p>
        ) : null}
        {message ? (
          <p className="text-success flex items-start gap-1.5 text-2xs" role="status">
            <CheckCircle2 className="mt-0.5 size-3 shrink-0" aria-hidden />
            {message}
          </p>
        ) : null}

        {/* Duplicate prompt — blocks the write until resolved */}
        {duplicatePrompt ? (
          <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2">
            <p className="text-warning flex items-start gap-1.5 text-2xs font-medium">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              This text is byte-identical to an already-imported document:
            </p>
            <ul className="text-warning mt-1 list-inside list-disc text-2xs">
              {duplicatePrompt.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void createDocument()}
                loading={workflow.importDocs.mutating}
              >
                Import anyway (creates a copy)
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDuplicatePrompt(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {/* Soft hint (name / exact text) — does not block */}
        {!duplicatePrompt && (duplicateHint.byName.length > 0 || duplicateHint.identical.length > 0) ? (
          <p className="text-warning flex items-start gap-1.5 text-2xs">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            {duplicateHint.identical.length > 0
              ? 'A document with exactly this text already exists in this project.'
              : `A document named “${duplicateHint.byName[0].fileName}” already exists — importing will create a second copy.`}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus className="size-3.5" />}
            onClick={() => void submit()}
            disabled={!canSubmit}
            loading={workflow.importDocs.mutating}
          >
            Import document
          </Button>
          <Button variant="ghost" size="sm" onClick={resetForm} disabled={workflow.importDocs.mutating}>
            Clear
          </Button>
        </div>

        <ul className="text-subtle space-y-0.5 border-t border-line pt-2 text-2xs">
          {IMPORT_FORMAT_LIMITS.map((line) => (
            <li key={line}>· {line}</li>
          ))}
        </ul>
      </Card>

      {/* ---------------------------- Document list ----------------------- */}
      <Card padding="md">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ink text-sm font-semibold">Documents in this project</h2>
          <span className="text-subtle text-2xs tabular-nums">{documents.length} total</span>
        </div>

        {workflow.documentsLoading && documents.length === 0 ? (
          <p className="text-subtle mt-3 text-xs" role="status">
            Loading documents…
          </p>
        ) : workflow.documentsError && documents.length === 0 ? (
          <p className="text-danger mt-3 text-xs" role="alert">
            {workflow.documentsError instanceof Error
              ? workflow.documentsError.message
              : 'Failed to load documents.'}
          </p>
        ) : documents.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              icon={<FileText className="size-5" aria-hidden />}
              title="No documents yet"
              description="Import a manuscript above to start the parse → structure → extract pipeline."
            />
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                selected={doc.id === workflow.documentId}
                busy={workflow.importDocs.mutating}
                onSelect={() => workflow.selectDocument(doc.id)}
                onContinue={() => {
                  workflow.selectDocument(doc.id);
                  navigate(getStageMeta('parser').path);
                }}
                onDelete={async () => {
                  if (
                    !window.confirm(
                      `Delete “${doc.fileName ?? 'Untitled document'}” and its parsed sections? This cannot be undone.`,
                    )
                  ) {
                    return;
                  }
                  setActionError(null);
                  try {
                    await workflow.importDocs.deleteDocument(doc.id);
                    setMessage(`Deleted “${doc.fileName ?? 'Untitled document'}”.`);
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : 'Delete failed.');
                  }
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function DocumentRow({
  doc,
  selected,
  busy,
  onSelect,
  onContinue,
  onDelete,
}: {
  doc: SourceDocument;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onContinue: () => void;
  onDelete: () => void;
}) {
  // The lifecycle label needs the section count, which the documents list does
  // not carry; `status` alone is enough to place the document on the pipeline.
  const lifecycle = describeDocumentLifecycle(doc, doc.status === 'imported' ? 0 : 1);

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border p-3',
        selected ? 'border-accent bg-accent-soft/30' : 'border-line bg-surface',
      )}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" aria-pressed={selected}>
        <p className="text-ink truncate text-xs font-medium">{doc.fileName ?? 'Untitled document'}</p>
        <p className="text-subtle mt-0.5 text-2xs">
          {doc.format === 'markdown' ? 'Markdown' : 'Plain text'} ·{' '}
          {doc.rawText.length.toLocaleString()} chars · {doc.wordCount.toLocaleString()} words
        </p>
      </button>
      <Badge tone={lifecycle.structureConfirmed ? 'success' : 'neutral'} size="sm">
        {lifecycle.label}
      </Badge>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" iconRight={<ArrowRight className="size-3.5" />} onClick={onContinue}>
          Parse
        </Button>
        <IconButton
          size="sm"
          label="Delete document"
          disabled={busy}
          icon={<Trash2 className="size-3" aria-hidden />}
          onClick={onDelete}
        />
      </div>
    </li>
  );
}
