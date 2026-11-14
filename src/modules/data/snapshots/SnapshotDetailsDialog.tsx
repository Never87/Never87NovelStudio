import { useState } from 'react';
import { Check, Copy, FileClock, History } from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { TRANSFER_COLLECTIONS } from '@/transfer/collection-registry';
import type { ProjectSnapshot } from '@/types';
import { formatRelative } from '@/utils/date';

export interface SnapshotDetailsDialogProps {
  open: boolean;
  snapshot: ProjectSnapshot | null;
  onClose: () => void;
}

/** Shown heading for a collection key, e.g. `chapterDrafts` -> "Chapter Drafts". */
function collectionLabel(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Read-only snapshot details (P9 B3-3).
 *
 * Every value shown here comes from the ACTUAL captured `ProjectSnapshot`
 * record — never a hardcoded statistic. It surfaces the identifying metadata
 * (full id, reason, project, versions, integrity digest) and a structured
 * per-collection record-count view derived from `snapshot.counts` (the
 * denormalised counts computed by the service at capture time). The full raw
 * payload JSON is deliberately NOT dumped; the collection table is the useful,
 * stable summary.
 */
export function SnapshotDetailsDialog({ open, snapshot, onClose }: SnapshotDetailsDialogProps) {
  const [copied, setCopied] = useState<string | null>(null);

  if (!snapshot) return null;

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
    } catch {
      // Clipboard may be unavailable (permissions / insecure context); the value
      // is still visible and selectable in the UI, so this is non-fatal.
      setCopied(null);
    }
  };

  const counts = snapshot.counts;
  const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const digest = snapshot.integrity.digest;
  const shortDigest = `${digest.slice(0, 16)}…${digest.slice(-8)}`;

  return (
    <ProjectDialog
      open={open}
      title="Snapshot details"
      description={snapshot.projectTitle || 'Untitled project'}
      onClose={onClose}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-4 text-xs">
        {/* Identity & metadata */}
        <dl className="grid gap-2">
          <MetaRow label="Snapshot ID">
            <span className="text-ink font-mono break-all tabular-nums">{snapshot.id}</span>
            <CopyButton
              label="snapshot-id"
              active={copied === 'snapshot-id'}
              onCopy={() => void copy('snapshot-id', snapshot.id)}
            />
          </MetaRow>
          <MetaRow label="Reason">
            <Badge tone={snapshot.reason === 'pre-restore' ? 'warning' : 'info'} size="sm">
              {snapshot.reason}
            </Badge>
          </MetaRow>
          <MetaRow label="Created">
            <span className="text-ink">{formatRelative(snapshot.createdAt)}</span>
            <span className="text-subtle font-mono text-2xs">
              {new Date(snapshot.createdAt).toLocaleString()}
            </span>
          </MetaRow>
          <MetaRow label="Project">
            <span className="text-ink">{snapshot.projectTitle || 'Untitled project'}</span>
            <span className="text-subtle font-mono text-2xs">{snapshot.projectId}</span>
          </MetaRow>
          <MetaRow label="Schema / format">
            <span className="text-ink tabular-nums">
              schema v{snapshot.schemaVersion} · format v{snapshot.formatVersion}
            </span>
          </MetaRow>
          <MetaRow label="Words">
            <span className="text-ink tabular-nums">{snapshot.wordCount.toLocaleString()} words</span>
          </MetaRow>
          <MetaRow label="Integrity">
            <span className="text-ink font-mono tabular-nums" title={digest}>
              {shortDigest}
            </span>
            <CopyButton
              label="digest"
              active={copied === 'digest'}
              onCopy={() => void copy('digest', digest)}
            />
          </MetaRow>
        </dl>

        {/* Structured per-collection record counts (never raw JSON). */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-subtle text-2xs font-medium uppercase tracking-wide">
              Captured collections
            </p>
            <span className="text-subtle text-2xs tabular-nums">
              {TRANSFER_COLLECTIONS.length} collections · {totalRows.toLocaleString()} records
            </span>
          </div>
          <div className="border-line overflow-hidden rounded-md border">
            <table className="w-full">
              <thead>
                <tr className="border-line bg-surface-muted/50 text-subtle border-b text-left text-2xs">
                  <th className="px-2.5 py-1.5 font-medium">Collection</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">Records</th>
                </tr>
              </thead>
              <tbody>
                {TRANSFER_COLLECTIONS.map((collection) => {
                  const value = counts[collection.key] ?? 0;
                  return (
                    <tr key={collection.key} className="border-line/60 border-b last:border-0">
                      <td className="text-muted px-2.5 py-1">{collectionLabel(collection.key)}</td>
                      <td
                        className={
                          'px-2.5 py-1 text-right tabular-nums ' +
                          (value > 0 ? 'text-ink' : 'text-subtle')
                        }
                      >
                        {value.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-subtle flex items-center gap-1.5 text-2xs">
          <History className="size-3" aria-hidden />
          <FileClock className="size-3" aria-hidden />
          Snapshots are immutable point-in-time captures; this view reflects the stored data as-is.
        </p>
      </div>
    </ProjectDialog>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
      <dt className="text-subtle text-2xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

function CopyButton({ label, active, onCopy }: { label: string; active: boolean; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="text-subtle hover:text-ink hover:bg-surface-muted grid size-6 shrink-0 place-items-center rounded"
    >
      {active ? <Check className="text-success size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}
