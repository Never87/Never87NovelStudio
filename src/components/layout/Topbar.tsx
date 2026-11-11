import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bell, PanelLeft, Plus, Search, Settings, ChevronRight } from 'lucide-react';
import { useUiStore } from '@/stores/ui-store';
import { NAV_GROUPS, NAV_ITEMS_BY_PATH, findGroupByPath } from '@/config/navigation';
import { Badge, Button } from '@/components/ui';
import { ThemeToggle } from './ThemeToggle';
import { cn } from '@/utils/cn';

/** Resolve the current navigation entry from the URL, or `undefined` for 404s. */
function useCurrentNavItem() {
  const { pathname } = useLocation();
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return NAV_ITEMS_BY_PATH[normalized];
}

interface SearchResult {
  id: string;
  label: string;
  group: string;
  path: string;
  description: string;
}

const SEARCH_INDEX: SearchResult[] = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({
    id: item.id,
    label: item.label,
    group: group.label,
    path: item.path,
    description: item.description,
  })),
);

/**
 * Global search entry point.
 * P0 searches navigation labels and module descriptions (no manuscript
 * content index yet). Every result is a real route.
 */
function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const q = query.trim().toLowerCase();
  const results = q
    ? SEARCH_INDEX.filter(
        (r) =>
          r.label.toLowerCase().includes(q) ||
          r.group.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      ).slice(0, 6)
    : [];

  const go = (path: string) => {
    setOpen(false);
    setQuery('');
    navigate(path);
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <label className="sr-only" htmlFor="global-search">
        Search
      </label>
      <div className="relative">
        <Search
          className="text-subtle pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2"
          aria-hidden
        />
        <input
          id="global-search"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) go(results[0].path);
            if (event.key === 'Escape') setOpen(false);
          }}
          placeholder="Search modules…"
          className="bg-surface-muted text-ink placeholder:text-subtle focus:border-accent-ring h-8 w-full rounded-md border border-line pl-8 pr-3 text-xs outline-none transition-colors"
        />
      </div>

      {open && q ? (
        <div className="bg-surface absolute left-0 right-0 top-9 z-30 overflow-hidden rounded-lg border border-line shadow-[var(--n87-shadow-popover)]">
          {results.length > 0 ? (
            <ul className="max-h-64 overflow-y-auto py-1">
              {results.map((result) => (
                <li key={result.id}>
                  <button
                    type="button"
                    onClick={() => go(result.path)}
                    className="hover:bg-surface-muted flex w-full items-center gap-2 px-3 py-1.5 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-ink truncate text-xs font-medium">{result.label}</p>
                      <p className="text-subtle truncate text-2xs">{result.group}</p>
                    </div>
                    <Badge tone="neutral">Soon</Badge>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-subtle px-3 py-3 text-xs">No modules match “{query}”.</p>
          )}
          <p className="text-subtle border-t border-line px-3 py-1.5 text-2xs">
            Manuscript content search arrives with the Knowledge Base module.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function Topbar() {
  const { mobileNavOpen, setMobileNavOpen } = useUiStore();
  const current = useCurrentNavItem();
  const group = current ? findGroupByPath(current.path) : undefined;
  const currentLabel = current?.label ?? 'Page not found';
  const navigate = useNavigate();

  /**
   * Opens the project-creation dialog that lives on `/projects`.
   *
   * The Topbar deliberately does NOT render its own `ProjectFormDialog`: that
   * would need a second `useProjects()` instance (the Topbar is mounted on
   * every page) and would duplicate the create flow. Instead the intent is
   * handed to ProjectsPage through router state; ProjectsPage owns the real
   * dialog and clears the flag once it has been consumed.
   *
   * A fresh `state` object is sent on every click so that clicking again while
   * already on `/projects` still produces a new navigation that re-opens the
   * dialog.
   */
  const openCreateProject = () => {
    navigate('/projects', { state: { create: true } });
  };

  return (
    <header className="bg-surface flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
      {/* Mobile nav toggle */}
      <button
        type="button"
        onClick={() => setMobileNavOpen(!mobileNavOpen)}
        aria-label="Open navigation"
        className="text-muted hover:bg-surface-muted hover:text-ink grid size-8 shrink-0 place-items-center rounded-md lg:hidden"
      >
        <PanelLeft className="size-4" />
      </button>

      {/* Breadcrumb: group / current module */}
      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 md:flex">
        <span className="text-subtle shrink-0 text-xs">Workspace</span>
        {group && group.label !== 'Workspace' ? (
          <>
            <ChevronRight className="text-subtle size-3 shrink-0" aria-hidden />
            <span className="text-subtle truncate text-xs">{group.label}</span>
          </>
        ) : null}
        <ChevronRight className="text-subtle size-3 shrink-0" aria-hidden />
        <span className="text-ink truncate text-xs font-medium">{currentLabel}</span>
      </nav>

      <div className="md:hidden">
        <span className="text-ink text-xs font-medium">{currentLabel}</span>
      </div>

      <div className="flex flex-1 justify-end md:justify-center">
        <div className="hidden w-full max-w-sm sm:block">
          <GlobalSearch />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled
          aria-label="Notifications (coming soon)"
          title="Notifications — coming soon"
          className="text-muted relative grid size-8 cursor-default place-items-center rounded-md opacity-70"
        >
          <Bell className="size-4" />
          <span className="bg-accent absolute right-1.5 top-1.5 size-1.5 rounded-full" aria-hidden />
        </button>

        <ThemeToggle />

        <Link
          to="/settings/general"
          aria-label="Settings"
          title="Settings"
          className="text-muted hover:bg-surface-muted hover:text-ink hidden size-8 place-items-center rounded-md sm:grid"
        >
          <Settings className="size-4" />
        </Link>

        <Button
          variant="primary"
          size="sm"
          onClick={openCreateProject}
          iconLeft={<Plus className="size-3.5" />}
          className={cn('ml-0.5')}
        >
          New Project
        </Button>
      </div>
    </header>
  );
}
