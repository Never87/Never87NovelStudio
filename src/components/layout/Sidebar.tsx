import { NavLink, useLocation } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight, Settings, UserRound, X } from 'lucide-react';
import { NAV_GROUPS } from '@/config/navigation';
import { useUiStore } from '@/stores/ui-store';
import { ButtonLink } from '@/components/ui';
import { cn } from '@/utils/cn';

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', collapsed && 'justify-center')}>
      <span className="bg-accent-soft text-accent-soft-text grid size-8 shrink-0 place-items-center rounded-md text-2xs font-bold tracking-tight">
        N87
      </span>
      {!collapsed ? (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-white">Novel Studio</p>
          <p className="text-sidebar-muted truncate text-2xs leading-tight">AI writing workbench</p>
        </div>
      ) : null}
    </div>
  );
}

interface SidebarProps {
  /** Mobile drawer rendering: always expanded, full width. */
  mobile?: boolean;
}

/**
 * Primary navigation.
 *
 * - Grouped (never a flat list), scrollable, fixed width on desktop.
 * - Collapsible to an icon rail; labels + group headings hide.
 * - Items without a `path` are rendered disabled with a "Soon" hint so a
 *   broken link can never be produced.
 */
export function Sidebar({ mobile = false }: SidebarProps) {
  const { sidebarCollapsed, toggleSidebar, setMobileNavOpen } = useUiStore();
  const collapsed = mobile ? false : sidebarCollapsed;
  const location = useLocation();

  return (
    <aside
      className={cn(
        'bg-sidebar flex h-dvh shrink-0 flex-col text-sidebar-text',
        mobile ? 'w-[17rem]' : collapsed ? 'w-[4.25rem]' : 'w-[15.5rem]',
        'transition-[width] duration-200 ease-out',
      )}
      aria-label="Main navigation"
    >
      {/* Brand */}
      <div className={cn('flex h-14 shrink-0 items-center border-b border-white/5', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
        <Logo collapsed={collapsed} />
        {mobile ? (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="text-sidebar-muted hover:bg-sidebar-hover grid size-8 place-items-center rounded-md hover:text-white"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Scrollable navigation groups */}
      <nav className="n87-scroll-fade flex-1 space-y-5 overflow-y-auto px-2 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.id}>
            {!collapsed ? (
              <p className="text-sidebar-muted px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider">
                {group.label}
              </p>
            ) : (
              <div className="mx-2 mb-2 border-t border-white/5" aria-hidden />
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname === item.path;

                const baseClasses = cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[0.8125rem] leading-5 transition-colors',
                  collapsed && 'justify-center',
                );

                return (
                  <li key={item.id}>
                    <NavLink
                      to={item.path}
                      title={collapsed ? item.label : undefined}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={mobile ? () => setMobileNavOpen(false) : undefined}
                      className={cn(
                        baseClasses,
                        isActive
                          ? 'bg-sidebar-active font-medium text-white'
                          : 'hover:bg-sidebar-hover hover:text-white',
                      )}
                    >
                      {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
                      {!collapsed ? <span className="truncate">{item.label}</span> : null}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer: workspace identity + settings */}
      <div className="shrink-0 border-t border-white/5 p-2">
        {!collapsed ? (
          <div className="mb-2 flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <span className="bg-sidebar-active grid size-7 shrink-0 place-items-center rounded-full text-2xs font-semibold text-white">
              N87
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-white">Never87</p>
              <p className="text-sidebar-muted truncate text-2xs">Personal workspace</p>
            </div>
          </div>
        ) : (
          <span
            title="Never87 — Personal workspace"
            className="bg-sidebar-active mx-auto mb-2 grid size-7 place-items-center rounded-full text-2xs font-semibold text-white"
          >
            N87
          </span>
        )}

        <div className={cn('flex items-center gap-1', collapsed ? 'flex-col' : 'justify-between')}>
          <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
            <button
              type="button"
              disabled
              aria-label="User settings (coming soon)"
              title="User settings — coming soon"
              className="text-sidebar-muted grid size-8 cursor-default place-items-center rounded-md opacity-70"
            >
              <UserRound className="size-4" />
            </button>
            <button
              type="button"
              disabled
              aria-label="Workspace settings (coming soon)"
              title="Workspace settings — coming soon"
              className="text-sidebar-muted grid size-8 cursor-default place-items-center rounded-md opacity-70"
            >
              <Settings className="size-4" />
            </button>
          </div>

          {!mobile ? (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="text-sidebar-muted hover:bg-sidebar-hover grid size-8 place-items-center rounded-md hover:text-white"
            >
              {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/** Convenience CTA reused by the placeholder pages. */
export function SidebarNewProjectButton() {
  return (
    <ButtonLink to="/projects" variant="primary" size="sm" fullWidth>
      New Project
    </ButtonLink>
  );
}
