import { lazy, Suspense, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Suspense fallback for lazily loaded route chunks.
 * Kept minimal and layout-stable so the switch is not jarring.
 */
export function RouteFallback() {
  return (
    <div className="text-subtle flex items-center justify-center gap-2 py-16 text-xs" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Loading module…
    </div>
  );
}

export function withRouteSuspense(node: ReactNode): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{node}</Suspense>;
}

/**
 * Creates a lazily loaded module page for a given navigation id.
 *
 * Each module gets its own chunk, so opening the app only downloads the
 * Dashboard and the shell; other modules load on first visit.
 */
export function createModulePage(moduleId: string) {
  return lazy(async () => {
    const { ModulePlaceholder } = await import('@/modules/shared/ModulePlaceholder');
    return {
      default: () => <ModulePlaceholder moduleId={moduleId} />,
    };
  });
}
