import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { ALL_NAV_ITEMS, assertNavigationIntegrity } from '@/config/navigation';
import { NotFoundPage } from './pages/NotFoundPage';
import { createModulePage, withRouteSuspense } from './lazy';

/**
 * Router definition.
 *
 * Routes are GENERATED from `config/navigation.ts`, which is the single
 * source of truth. Adding a nav item automatically adds its route; a nav item
 * can never point at a missing page, and a page can never be orphaned.
 *
 * `basename` is derived from Vite's `BASE_URL` so the same build works at the
 * domain root (https://never87.github.io/) and under a repository path
 * (https://never87.github.io/<repo>/) without code changes. It must stay
 * identical to the `base` in `vite.config.ts` and the `start_url`/`scope` used
 * by the GitHub Pages fallback.
 */
export const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

// Fail fast (dev only) if navigation and routing could ever drift apart.
if (import.meta.env.DEV) {
  assertNavigationIntegrity();
}

/** Dashboard is the landing page and is code-split like every other module. */
const DashboardPage = lazy(async () => {
  const mod = await import('./pages/DashboardPage');
  return { default: mod.DashboardPage };
});

/** Build one route per navigation item, skipping the dashboard (declared above). */
const moduleRoutes = ALL_NAV_ITEMS.filter((item) => item.id !== 'dashboard').map((item) => {
  const Page = createModulePage(item.id);
  return {
    path: item.path.replace(/^\//, ''),
    element: withRouteSuspense(<Page />),
  };
});

export const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <AppShell />,
      children: [
        // Landing page: `/` redirects to the canonical dashboard URL.
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: 'dashboard', element: withRouteSuspense(<DashboardPage />) },
        ...moduleRoutes,
        // Unknown paths render a real 404 inside the shell (not a blank page).
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: ROUTER_BASENAME === '/' ? undefined : ROUTER_BASENAME },
);
