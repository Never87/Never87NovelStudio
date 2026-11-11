import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Database, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { DatabaseInitError, initDatabase } from '@/db';

type GateState =
  | { phase: 'initializing' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: unknown };

export interface DatabaseGateProps {
  children: ReactNode;
}

/**
 * Blocks the app until IndexedDB is open.
 *
 * `initDatabase()` must resolve before any DB-backed route renders, otherwise
 * every project query would fail on a closed/unavailable database. This gate
 * shows a minimal loading screen, and on failure a diagnosable error screen
 * with a retry button — never silently continuing.
 *
 * StrictMode safety: `main.tsx` renders `<StrictMode>`, which mounts effects
 * twice in development. A monotonic `attemptRef` guards against a stale first
 * attempt committing state after a newer one, and the actual open is
 * idempotent (`db.open()` on an already-open database resolves immediately),
 * so double-mounting cannot race or corrupt the connection.
 */
export function DatabaseGate({ children }: DatabaseGateProps) {
  const [state, setState] = useState<GateState>({ phase: 'initializing' });
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runInit = useCallback(async () => {
    attemptRef.current += 1;
    const attempt = attemptRef.current;

    setState({ phase: 'initializing' });
    try {
      await initDatabase();
      // Discard the result of a superseded attempt (StrictMode / retry).
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      setState({ phase: 'ready' });
    } catch (error) {
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      setState({ phase: 'failed', error });
    }
  }, []);

  useEffect(() => {
    void runInit();
  }, [runInit]);

  if (state.phase === 'ready') {
    return <>{children}</>;
  }

  return (
    <div className="bg-bg flex min-h-dvh items-center justify-center p-6">
      {state.phase === 'initializing' ? (
        <LoadingScreen />
      ) : (
        <ErrorScreen error={state.error} onRetry={() => void runInit()} />
      )}
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
      <span className="text-accent flex items-center gap-1.5">
        <Database className="size-4" aria-hidden />
        <span className="text-ink text-sm font-semibold tracking-tight">Never87 Novel Studio</span>
      </span>
      <span className="text-muted flex items-center gap-2 text-xs">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Preparing your workspace…
      </span>
    </div>
  );
}

function ErrorScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { message, detail } = describeError(error);

  return (
    <Card padding="lg" className="w-full max-w-md" role="alert">
      <div className="flex items-start gap-3">
        <span className="bg-danger-soft text-danger flex size-9 shrink-0 items-center justify-center rounded-full">
          <TriangleAlert className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-ink text-sm font-semibold">Storage is unavailable</h1>
          <p className="text-muted mt-1 text-xs">{message}</p>
        </div>
      </div>

      {detail ? (
        <pre className="bg-surface-muted text-subtle mt-3 max-h-32 overflow-auto rounded-md p-2.5 text-2xs whitespace-pre-wrap break-words">
          {detail}
        </pre>
      ) : null}

      <div className="mt-4 flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          iconLeft={<RefreshCw className="size-3.5" />}
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </Card>
  );
}

/** Turns the raw error into a friendly message plus a diagnostic detail line. */
function describeError(error: unknown): { message: string; detail: string } {
  if (error instanceof DatabaseInitError) {
    const causeDetail =
      error.cause instanceof Error
        ? `${error.cause.name}: ${error.cause.message}`
        : error.cause !== undefined
          ? String(error.cause)
          : '';
    return {
      message:
        'The local database could not be opened. This browser may be in a private window, blocking site data, or out of storage space.',
      detail: causeDetail || error.message,
    };
  }
  if (error instanceof Error) {
    return { message: 'The local database could not be opened.', detail: `${error.name}: ${error.message}` };
  }
  return { message: 'The local database could not be opened.', detail: String(error) };
}
