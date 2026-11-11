import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Card } from '@/components/ui';

/** Minimal, layout-stable loading block shared by the project lists. */
export function ProjectsLoading({ label = 'Loading projects…' }: { label?: string }) {
  return (
    <div
      className="text-subtle flex items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-14 text-xs"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export interface ProjectsErrorProps {
  error: unknown;
  onRetry: () => void;
}

/**
 * Shared error panel for the project lists.
 *
 * Shows a diagnostic detail line (error name + message) so failures are
 * actionable, and a Retry button wired to the hook's `refresh()`.
 */
export function ProjectsError({ error, onRetry }: ProjectsErrorProps) {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);

  return (
    <Card padding="lg" className="flex flex-col items-center text-center" role="alert">
      <span className="bg-danger-soft text-danger grid size-10 place-items-center rounded-lg">
        <TriangleAlert className="size-5" aria-hidden />
      </span>
      <h3 className="text-ink mt-3 text-sm font-semibold">Couldn’t load projects</h3>
      <p className="text-muted mt-1 max-w-md text-xs">
        Something went wrong while reading your projects. Your data has not been changed.
      </p>
      <pre className="bg-surface-muted text-subtle mt-3 max-h-24 w-full max-w-md overflow-auto rounded-md p-2 text-2xs whitespace-pre-wrap break-words">
        {name}: {message}
      </pre>
      <Button
        variant="primary"
        size="sm"
        className="mt-4"
        iconLeft={<RefreshCw className="size-3.5" />}
        onClick={onRetry}
      >
        Retry
      </Button>
    </Card>
  );
}
