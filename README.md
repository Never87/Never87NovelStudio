# Never87 Novel Studio

A browser-based, AI-assisted novel writing workbench. Organise a novel as a project —
world, characters, narrative plan, outline, scenes and manuscript — and bring AI in where it
helps, always with a human in the loop.

**Live site:** <https://never87.github.io/>

> **Status: P0 (preview).** The application shell, design system, navigation and routing are
> complete. Every business module is a routed placeholder — no project data, no AI calls and
> no file imports are implemented yet. The dashboard uses clearly-labelled demo data.

## Tech stack

| Concern | Choice |
| --- | --- |
| Build | Vite 8 |
| UI | React 19 + TypeScript (strict) |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Routing | React Router 7 (`createBrowserRouter`) |
| State | Zustand (with `persist`) |
| Icons | Lucide React |
| Charts | Recharts |

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check then produce a production build in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Type-check only |
| `npm run lint` | Alias of `typecheck` |

## Architecture notes

### Navigation is data

`src/config/navigation.ts` is the **single source of truth** for the sidebar, the topbar
breadcrumb, the router and each page's copy (title, description, empty state, planned
features). The router is generated from it, so:

- every navigation item always has a working route;
- a route can never exist without a navigation entry;
- adding a module means adding one config object — nothing else.

`assertNavigationIntegrity()` runs in development and throws on duplicate ids, duplicate
paths or missing page metadata.

### Code splitting

The dashboard (the Recharts-heavy page) and every placeholder module are lazily loaded, so
the initial download stays small. The shell (`AppShell`, `Sidebar`, `Topbar`) is always
eager.

### Theming

`src/core/theme/theme.ts` owns light / dark / system mode. The choice is persisted to
`localStorage` under the key `n87-theme`. The inline script in `index.html` reads that key and
applies the correct class **before first paint**, so there is no theme flash. The switcher in
the topbar reuses this exact store — there is no second theme system.

## Deployment (GitHub Pages)

This repository is intended to be published as a **GitHub Pages user site** at
`https://never87.github.io/`, so the default `base` is `/`.

### Deep links and refresh

GitHub Pages is a static host with no server-side rewrites, so a direct request for
`/novel/characters` would normally return 404. The SPA fallback works like this:

1. GitHub Pages serves `public/404.html` for any unmatched path.
2. That file rewrites the URL to `<root>?p=<original-path>` (preserving the query and hash).
3. The small inline script in `index.html` calls `history.replaceState` to restore the
   original path before React Router boots.

The result: `createBrowserRouter` keeps working with real URLs — no `HashRouter`, no `#/`
URLs, and no loss of the requested address. The theme boot script still runs normally.

### Automatic deployment

`.github/workflows/deploy.yml` runs on every push to `main`:

1. `npm ci`
2. `npm run typecheck`
3. `npm run build`
4. Upload `dist/` and deploy via `actions/deploy-pages`

**One-time setup:** in the repository, open **Settings → Pages** and set **Source** to
**GitHub Actions**.

### Deploying to a project site instead

`vite.config.ts` reads `VITE_BASE_PATH` (default `/`). For a project site such as
`https://never87.github.io/never87-novel-studio/`, set a repository *variable*:

| Setting | Value |
| --- | --- |
| Repository variable `VITE_BASE_PATH` | `/never87-novel-studio/` |

The router basename is derived from Vite's `BASE_URL`, so routing and the 404 fallback follow
automatically — no code change needed.

> Local verification only: deployment has been validated by building locally and exercising
> the fallback logic. Live GitHub Pages hosting requires the workflow above to run on GitHub.

## Project structure

```
src/
  components/
    layout/     AppShell, Sidebar, Topbar, ThemeToggle
    ui/         Button, Card, Badge, PageHeader, EmptyState (design system)
  config/       navigation.ts — routes + page metadata (single source of truth)
  core/theme/   light / dark / system theme store
  modules/      feature modules (dashboard, shared placeholder)
  routes/       router, lazy-loading helpers, page components
  stores/       global UI state (sidebar collapse, mobile drawer)
  styles/       index.css — design tokens
  utils/        small helpers
public/
  404.html      GitHub Pages SPA fallback
```

## Roadmap

| Phase | Scope |
| --- | --- |
| **P0** | Shell, design system, routing, theme, deployment ✅ |
| P1 | IndexedDB, project CRUD |
| P2 | World building & characters |
| P3 | Outline & scene planning |
| P4 | Story editor |
| P5 | AI providers & assistance |
| P6 | Import & analysis pipeline |
| P7 | Knowledge base & continuity |
| P8 | Publishing & export |
| P9 | Versioning & backup |

## License

MIT © Never87
