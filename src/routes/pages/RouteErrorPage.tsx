import { AlertTriangle, LayoutDashboard, RefreshCw } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Button, ButtonLink } from '@/components/ui';

/**
 * Route-level error boundary UI (rendered via `errorElement`).
 *
 * This is a FALLBACK, not the primary fix for any bug: it only ensures that if
 * a route component throws during render (for example when a browser
 * translation feature has mutated React-managed DOM and a later route change
 * fails in commit work), the user sees a recoverable page with a way back
 * instead of React Router's default developer error screen.
 *
 * Rendered OUTSIDE the AppShell (it replaces the failed route subtree), so it
 * must be self-contained. It reads the router error for a short message but
 * never trusts it as user-facing copy.
 */
export function RouteErrorPage() {
  const error = useRouteError();

  let detail = 'An unexpected error occurred while rendering this page.';
  if (isRouteErrorResponse(error)) {
    detail = `${error.status} ${error.statusText || ''}`.trim() || detail;
  } else if (error instanceof Error && error.message) {
    // Keep it short and non-technical; the full stack is not shown to users.
    detail = error.message.split('\n')[0];
  }

  return (
    <div className="bg-bg text-ink flex min-h-dvh items-center justify-center p-6">
      <div className="border-line bg-surface w-full max-w-lg rounded-xl border p-6 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <span className="bg-danger/10 text-danger grid size-9 place-items-center rounded-lg">
            <AlertTriangle className="size-5" aria-hidden />
          </span>
          <h1 className="text-ink text-base font-semibold">This page could not be displayed</h1>
        </div>

        <p className="text-muted text-sm leading-relaxed">
          Something went wrong while showing this page. Your saved work is not affected. You can go
          back to the dashboard, or reload to try again.
        </p>
        <p className="text-subtle mt-2 break-words text-2xs">{detail}</p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <ButtonLink
            to="/dashboard"
            variant="primary"
            size="sm"
            iconLeft={<LayoutDashboard className="size-3.5" />}
          >
            Back to Dashboard
          </ButtonLink>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<RefreshCw className="size-3.5" />}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
