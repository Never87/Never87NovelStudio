import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useUiStore } from '@/stores/ui-store';
import { useStoryEditorStore } from '@/stores/story-editor-store';
import { cn } from '@/utils/cn';

/**
 * Application shell.
 *
 * Layout: fixed-width sidebar (collapsible rail on desktop, overlay drawer
 * below `lg`) + topbar + independently scrolling main region.
 * The sidebar owns its own scroll; only the content area scrolls.
 *
 * Story Editor Focus Mode: while the editor store reports `focusMode`, the
 * global sidebar and topbar are hidden and the main region drops its padding /
 * max-width so the writing surface fills the whole viewport. The SAME editor
 * instance is reused — nothing is re-mounted (see `WritingPanel`). Leaving the
 * editor route automatically clears focus mode, so the shell never gets "stuck".
 */
export function AppShell() {
  const { mobileNavOpen, setMobileNavOpen } = useUiStore();
  const focusMode = useStoryEditorStore((state) => state.focusMode);
  const setFocusMode = useStoryEditorStore((state) => state.setFocusMode);
  const { pathname } = useLocation();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname, setMobileNavOpen]);

  // Focus Mode only makes sense on a writing surface. If the user navigates
  // away (sidebar route, deep-link, back button) focus mode must be released,
  // otherwise the shell would stay chromeless on an unrelated page. Writing
  // surfaces are the Story Editor module and the project "Writing" tab.
  useEffect(() => {
    if (!focusMode) return;
    const onWritingSurface =
      pathname.includes('/novel/story-editor') || pathname.startsWith('/projects/');
    if (!onWritingSurface) setFocusMode(false);
  }, [pathname, focusMode, setFocusMode]);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileNavOpen]);

  // Allow Escape to dismiss the drawer.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen, setMobileNavOpen]);

  return (
    <div className="bg-bg text-ink flex h-dvh overflow-hidden">
      {/* Desktop sidebar (hidden in Focus Mode) */}
      {!focusMode ? (
        <div className="hidden lg:block">
          <Sidebar />
        </div>
      ) : null}

      {/* Mobile drawer (hidden in Focus Mode) */}
      {!focusMode ? (
        <div
          className={cn(
            'fixed inset-0 z-40 lg:hidden',
            mobileNavOpen ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          aria-hidden={!mobileNavOpen}
        >
          <div
            onClick={() => setMobileNavOpen(false)}
            className={cn(
              'absolute inset-0 bg-[#0b1220]/50 transition-opacity duration-200',
              mobileNavOpen ? 'opacity-100' : 'opacity-0',
            )}
          />
          <div
            className={cn(
              'absolute inset-y-0 left-0 shadow-[var(--n87-shadow-popover)] transition-transform duration-200 ease-out',
              mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
            )}
          >
            <Sidebar mobile />
          </div>
        </div>
      ) : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!focusMode ? <Topbar /> : null}
        <main className={cn('min-w-0 flex-1', focusMode ? 'overflow-hidden' : 'overflow-y-auto')}>
          {/* Keep <Outlet/> at a STABLE tree position across modes: only the
              wrapper's classes change, never its nesting. Re-parenting the
              Outlet would remount the route (and the editor) whenever Focus
              Mode toggles, which would also fire its unmount cleanup and
              immediately reset focus mode. */}
          <div
            className={cn(
              focusMode
                ? 'h-full min-h-0'
                : 'mx-auto w-full max-w-[1400px] px-3 py-4 sm:px-5 sm:py-6',
            )}
          >
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
