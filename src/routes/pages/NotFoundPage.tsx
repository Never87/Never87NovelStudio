import { ArrowLeft, Compass, LayoutDashboard } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, ButtonLink, Card, EmptyState } from '@/components/ui';
import { useUiStore } from '@/stores/ui-store';

/**
 * Route-level 404 for unknown paths.
 *
 * Rendered INSIDE the AppShell, so the sidebar and topbar stay usable — the
 * user can navigate straight back to a real module instead of a dead end.
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const openMobileNav = useUiStore((state) => state.setMobileNavOpen);

  return (
    <div className="mx-auto max-w-2xl py-6">
      <Card padding="lg">
        <EmptyState
          variant="plain"
          icon={<Compass className="size-6" />}
          title="Page not found"
          description="The page you are looking for does not exist, or it may have been moved. Every module in the sidebar is reachable — pick one to continue."
          className="py-10"
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(-1)}
                iconLeft={<ArrowLeft className="size-3.5" />}
              >
                Go back
              </Button>
              <ButtonLink
                to="/dashboard"
                variant="primary"
                size="sm"
                iconLeft={<LayoutDashboard className="size-3.5" />}
              >
                Back to Dashboard
              </ButtonLink>
            </div>
          }
        />

        <div className="mt-2 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => openMobileNav(true)} className="lg:hidden">
            Browse all modules
          </Button>
        </div>
      </Card>
    </div>
  );
}
