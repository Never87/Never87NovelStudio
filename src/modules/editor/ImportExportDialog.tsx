import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { useOutline } from '@/hooks';
import { manuscriptTransferService, type ImportPreviewChapter } from '@/services';
import { cn } from '@/utils/cn';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';

export interface ImportExportDialogProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
}

/**
 * Markdown import / export (P4).
 *
 * Import is preview-first: the parsed chapters (titles, word counts, excerpts)
 * and any duplicate titles are shown BEFORE anything is written, so a bulk
 * import can never silently create junk chapters or overwrite prose.
 */
export function ImportExportDialog({ open, projectId, onClose }: ImportExportDialogProps) {
  const { outline } = useOutline(projectId);
  const volumes = outline;
  const chaptersOf = (volumeId: string) =>
    outline.find((entry) => entry.volume.id === volumeId)?.chapters ?? [];

  const [tab, setTab] = useState<'import' | 'export'>('import');
  const [volumeId, setVolumeId] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'overwrite'>('skip');
  const [preview, setPreview] = useState<ImportPreviewChapter[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeVolumeId = volumeId || volumes[0]?.volume.id || '';

  const reset = () => {
    setPreview(null);
    setMessage(null);
    setError(null);
  };

  const handlePreview = () => {
    reset();
    if (!markdown.trim()) {
      setError('Paste or choose a Markdown file first.');
      return;
    }
    setPreview(
      manuscriptTransferService.previewImport(markdown, chaptersOf(activeVolumeId)),
    );
  };

  const handleImport = async () => {
    if (!activeVolumeId) {
      setError('Create a volume in the Outline tab first.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await manuscriptTransferService.importMarkdown(
        projectId,
        activeVolumeId,
        markdown,
        { volumeId: activeVolumeId, onDuplicate },
      );
      setMessage(
        `Imported ${result.createdChapterIds.length} chapter(s), ` +
          `${result.importedWords.toLocaleString()} words` +
          (result.skippedTitles.length > 0
            ? `; skipped ${result.skippedTitles.length} existing title(s).`
            : '.'),
      );
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const md = await manuscriptTransferService.exportVolume(projectId, activeVolumeId);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const title = volumes.find((entry) => entry.volume.id === activeVolumeId)?.volume.title;
      anchor.href = url;
      anchor.download = `${(title ?? 'manuscript').replace(/[^\w\u4e00-\u9fff -]+/g, '_')}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage('Exported as a Markdown file.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setMarkdown(content);
    reset();
  };

  return (
    <ProjectDialog
      open={open}
      title="Import / export manuscript"
      description="Markdown in, Markdown out — the same format the editor stores, so exports round-trip cleanly."
      onClose={onClose}
      dismissible={!busy}
      footer={
        tab === 'import' ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={handlePreview} disabled={busy}>
              Preview
            </Button>
            <Button variant="primary" size="sm" onClick={() => void handleImport()} disabled={busy || !preview}>
              Import
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleExport()}
              disabled={busy || !activeVolumeId}
            >
              Export volume
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-1" role="tablist" aria-label="Transfer mode">
          {(['import', 'export'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                reset();
              }}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize',
                tab === id ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink',
              )}
            >
              {id}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Volume</span>
          <select
            value={activeVolumeId}
            onChange={(event) => {
              setVolumeId(event.target.value);
              reset();
            }}
            className="bg-surface border-line-strong text-ink mt-1 h-9 w-full rounded-md border px-2 text-sm"
          >
            {volumes.length === 0 ? <option value="">No volumes yet</option> : null}
            {volumes.map((entry) => (
              <option key={entry.volume.id} value={entry.volume.id}>
                {entry.volume.title}
              </option>
            ))}
          </select>
        </label>

        {tab === 'import' ? (
          <>
            <div>
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Markdown file
              </span>
              <label className="border-line-strong hover:bg-surface-muted mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs">
                <Upload className="size-4" aria-hidden />
                Choose a .md / .txt file
                <input
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain"
                  className="sr-only"
                  onChange={(event) => void handleFile(event.target.files?.[0])}
                />
              </label>
            </div>

            <label className="block">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                or paste Markdown
              </span>
              <textarea
                value={markdown}
                onChange={(event) => {
                  setMarkdown(event.target.value);
                  reset();
                }}
                rows={6}
                className="bg-surface border-line-strong text-ink mt-1 w-full rounded-md border px-2.5 py-2 font-mono text-xs"
                placeholder={'## Chapter One\n\nIt began to rain…'}
              />
            </label>

            <label className="block">
              <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                Existing chapter title
              </span>
              <select
                value={onDuplicate}
                onChange={(event) => setOnDuplicate(event.target.value as 'skip' | 'overwrite')}
                className="bg-surface border-line-strong text-ink mt-1 h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="skip">Skip — never touch existing prose</option>
                <option value="overwrite">Overwrite — replace its prose (keeps a snapshot)</option>
              </select>
            </label>

            {preview ? (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-subtle text-2xs font-medium uppercase tracking-wide">
                    Preview
                  </span>
                  <span className="text-subtle text-2xs">{preview.length} chapter(s)</span>
                </div>
                <ul className="divide-line max-h-48 divide-y overflow-y-auto rounded-md border border-line">
                  {preview.map((chapter) => (
                    <li key={chapter.index} className="px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-ink truncate text-xs font-medium">{chapter.title}</span>
                        <span className="text-subtle shrink-0 text-2xs tabular-nums">
                          {chapter.wordCount.toLocaleString()} words
                        </span>
                      </div>
                      <p className="text-subtle mt-0.5 line-clamp-1 text-2xs">
                        {chapter.excerpt || 'Empty'}
                      </p>
                      {chapter.existingChapterId ? (
                        <Badge tone="warning" size="sm">
                          Existing — {onDuplicate === 'skip' ? 'will be skipped' : 'will be overwritten'}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-muted flex items-start gap-2 text-xs">
            <Download className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            The volume is exported as one Markdown document with each chapter as a{' '}
            <code className="bg-surface-muted rounded px-1">##</code> heading — exactly what the
            importer reads back.
          </p>
        )}

        {message ? (
          <p className="text-success text-xs" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ProjectDialog>
  );
}
