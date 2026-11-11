import { useRef, useState } from 'react';
import { Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui';
import { ProjectDialog } from './ProjectDialog';

export interface DeleteProjectDialogProps {
  open: boolean;
  /** Title of the project about to be deleted — shown so the user can confirm. */
  projectTitle: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/**
 * Destructive confirmation dialog.
 *
 * Nothing is deleted until the user presses Delete — closing via Cancel,
 * Escape or the backdrop just dismisses the dialog. While the delete is in
 * flight every control is disabled so a double-click cannot fire two deletes;
 * on failure the dialog stays open with the error visible and can be retried.
 */
export function DeleteProjectDialog({
  open,
  projectTitle,
  onConfirm,
  onClose,
}: DeleteProjectDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard: state updates are async, so a very fast double click
  // could otherwise enqueue two deletes before `deleting` is applied.
  const deletingRef = useRef(false);

  const handleConfirm = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <ProjectDialog
      open={open}
      tone="danger"
      title="Delete project?"
      onClose={onClose}
      dismissible={!deleting}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleConfirm}
            loading={deleting}
            iconLeft={!deleting ? <Trash2 className="size-3.5" /> : undefined}
          >
            Delete
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <span className="bg-danger-soft text-danger grid size-9 shrink-0 place-items-center rounded-lg">
          <TriangleAlert className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 space-y-2 text-sm">
          <p className="text-ink">
            You are about to delete{' '}
            <span className="font-semibold break-words">“{projectTitle}”</span>.
          </p>
          <p className="text-muted text-xs">
            This permanently removes the project from your workspace. This action cannot be undone.
          </p>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="border-danger/30 bg-danger-soft text-danger mt-3 rounded-md border px-3 py-2 text-xs break-words whitespace-pre-wrap"
        >
          {error}
        </div>
      ) : null}
    </ProjectDialog>
  );
}
