import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui';
import type { PromptTemplate, PromptTemplateVersion } from '@/types';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';

export interface VersionHistoryDialogProps {
  open: boolean;
  template: PromptTemplate | null;
  loadVersions: (templateId: string) => Promise<PromptTemplateVersion[]>;
  onRestore: (templateId: string, versionId: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Read-only version history for a prompt template (P6 / R1).
 *
 * Shows every snapshot newest-first. Restoring APPENDS a new version (history is
 * never rewritten); this dialog just triggers that and reloads.
 */
export function VersionHistoryDialog({ open, template, loadVersions, onRestore, onClose }: VersionHistoryDialogProps) {
  const [versions, setVersions] = useState<PromptTemplateVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !template) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadVersions(template.id)
      .then((result) => {
        if (!cancelled) setVersions(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load versions.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, template, loadVersions]);

  const restore = async (versionId: string) => {
    if (!template) return;
    setBusyId(versionId);
    setError(null);
    try {
      await onRestore(template.id, versionId);
      const refreshed = await loadVersions(template.id);
      setVersions(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ProjectDialog
      open={open}
      title={template ? `History — ${template.name}` : 'Version history'}
      description="Every save creates an immutable snapshot. Restoring appends a new version."
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      {loading ? (
        <p className="text-subtle text-xs" role="status">
          Loading versions…
        </p>
      ) : error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : versions.length === 0 ? (
        <p className="text-subtle text-xs italic">No versions recorded.</p>
      ) : (
        <ul className="space-y-2">
          {versions.map((version) => (
            <li key={version.id} className="border-line rounded-md border p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-ink text-xs font-medium">
                    v{version.version}
                    {version.reason ? ` · ${version.reason}` : ''}
                    {version.label ? ` · ${version.label}` : ''}
                  </p>
                  <p className="text-subtle text-2xs">{new Date(version.createdAt).toLocaleString()}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  iconLeft={<RotateCcw className="size-3" />}
                  onClick={() => void restore(version.id)}
                  loading={busyId === version.id}
                  disabled={busyId !== null}
                >
                  Restore
                </Button>
              </div>
              <pre className="text-muted bg-surface-muted mt-2 max-h-32 overflow-auto rounded p-2 font-mono text-2xs whitespace-pre-wrap">
                {version.content}
              </pre>
            </li>
          ))}
        </ul>
      )}
    </ProjectDialog>
  );
}
