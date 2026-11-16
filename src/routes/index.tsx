import { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { ALL_NAV_ITEMS, assertNavigationIntegrity } from '@/config/navigation';
import { NotFoundPage } from './pages/NotFoundPage';
import { RouteErrorPage } from './pages/RouteErrorPage';
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

/**
 * Modules whose real pages have shipped (P1-C2-A).
 *
 * They are excluded from the generated placeholder routes below and declared
 * explicitly so they render actual data instead of `ModulePlaceholder`. Every
 * other navigation item keeps its auto-generated placeholder unchanged.
 */
const PROJECTS_NAV_ID = 'projects';
const RECENT_NAV_ID = 'recent';

const ProjectsPage = lazy(async () => {
  const mod = await import('@/modules/projects/ProjectsPage');
  return { default: mod.ProjectsPage };
});

const RecentProjectsPage = lazy(async () => {
  const mod = await import('@/modules/projects/RecentProjectsPage');
  return { default: mod.RecentProjectsPage };
});

/** Project detail page (P1-C2-B2-A) — `/projects/:projectId`. */
const ProjectDetailPage = lazy(async () => {
  const mod = await import('@/modules/projects/ProjectDetailPage');
  return { default: mod.ProjectDetailPage };
});

/**
 * AI configuration & assistance pages (P5).
 *
 * Real pages that replace their ModulePlaceholder. They are excluded from the
 * generated placeholder routes below and declared explicitly.
 */
const ApiSettingsPage = lazy(async () => {
  const mod = await import('@/modules/ai/ApiSettingsPanel');
  return { default: mod.ApiSettingsPanel };
});

const ProviderManagementPage = lazy(async () => {
  const mod = await import('@/modules/ai/ProviderManagementPanel');
  return { default: mod.ProviderManagementPanel };
});

const ModelConfigurationPage = lazy(async () => {
  const mod = await import('@/modules/ai/ModelConfigurationPanel');
  return { default: mod.ModelConfigurationPanel };
});

const AiAssistancePage = lazy(async () => {
  const mod = await import('@/modules/ai/AiAssistancePanel');
  return { default: mod.AiAssistancePanel };
});

/** Prompt Engineering Center & Context Manager (P6) — real pages. */
const PromptTemplatesPage = lazy(async () => {
  const mod = await import('@/modules/ai/PromptTemplatesPanel');
  return { default: mod.PromptTemplatesPanel };
});

const ContextManagerPage = lazy(async () => {
  const mod = await import('@/modules/ai/ContextManagerPanel');
  return { default: mod.ContextManagerPanel };
});

/** Knowledge Base, Continuity & Story Analysis (P7) — real pages. */
const KnowledgeBasePage = lazy(async () => {
  const mod = await import('@/modules/ai/KnowledgeBasePanel');
  return { default: mod.KnowledgeBasePanel };
});

const ContinuityManagerPage = lazy(async () => {
  const mod = await import('@/modules/ai/ContinuityManagerPanel');
  return { default: mod.ContinuityManagerPanel };
});

const PlotHoleDetectorPage = lazy(async () => {
  const mod = await import('@/modules/ai/PlotHoleDetectorPanel');
  return { default: mod.PlotHoleDetectorPanel };
});

/** Extraction Review Center (P8 Batch 4). */
const ExtractionReviewPage = lazy(async () => {
  const mod = await import('@/modules/ai/ExtractionReviewPanel');
  return { default: mod.ExtractionReviewPanel };
});

/** Project Integration (P8 Batch 5). */
const ProjectIntegrationPage = lazy(async () => {
  const mod = await import('@/modules/ai/ProjectIntegrationPanel');
  return { default: mod.ProjectIntegrationPanel };
});

/**
 * Import workflow stages (P8 Batch 6) — real pages.
 *
 * These four routes replace their `ModulePlaceholder`s. Each page mounts the
 * shared `ImportWorkflowProvider` through the workflow shell, and the document
 * selection is persisted in `sessionStorage`, so it survives the navigation
 * BETWEEN these routes. The remaining two stages (Review Center, Integration)
 * keep their existing P8 Batch 4 / 5 pages — this batch does not duplicate them.
 */
const ManuscriptImportPage = lazy(async () => {
  const mod = await import('@/modules/import/workflow/ManuscriptImportPage');
  return { default: mod.ManuscriptImportPage };
});

const DocumentParserPage = lazy(async () => {
  const mod = await import('@/modules/import/workflow/DocumentParserPage');
  return { default: mod.DocumentParserPage };
});

const StructureRecognitionPage = lazy(async () => {
  const mod = await import('@/modules/import/workflow/StructureRecognitionPage');
  return { default: mod.StructureRecognitionPage };
});

const InformationExtractionPage = lazy(async () => {
  const mod = await import('@/modules/import/workflow/InformationExtractionPage');
  return { default: mod.InformationExtractionPage };
});

/** Version & Data Management (P9 Batch 2) — real pages. */
const VersionHistoryPage = lazy(async () => {
  const mod = await import('@/modules/data/VersionHistoryPage');
  return { default: mod.VersionHistoryPage };
});

const DiffViewerPage = lazy(async () => {
  const mod = await import('@/modules/data/DiffViewerPage');
  return { default: mod.DiffViewerPage };
});

/** Project Snapshots (P9 Batch 3-3) — real page. */
const ProjectSnapshotsPage = lazy(async () => {
  const mod = await import('@/modules/data/ProjectSnapshotsPage');
  return { default: mod.ProjectSnapshotsPage };
});

/** Backup & Restore (P9 Batch 4-1) — real page (single-project backup export). */
const BackupRestorePage = lazy(async () => {
  const mod = await import('@/modules/data/BackupRestorePage');
  return { default: mod.BackupRestorePage };
});

/** Publishing Presets & Chapter Export (P9 Batch B) — real pages. */
const PublishingPresetsPage = lazy(async () => {
  const mod = await import('@/modules/publishing/PublishingPresetsPage');
  return { default: mod.PublishingPresetsPage };
});

const ChapterExportPage = lazy(async () => {
  const mod = await import('@/modules/publishing/ChapterExportPage');
  return { default: mod.ChapterExportPage };
});

/** Full-book Export Manager (P9 Batch C) — real page. */
const ExportManagerPage = lazy(async () => {
  const mod = await import('@/modules/publishing/ExportManagerPage');
  return { default: mod.ExportManagerPage };
});

/** Book Covers (P9 Batch D) — real page. */
const BookCoversPage = lazy(async () => {
  const mod = await import('@/modules/publishing/BookCoversPage');
  return { default: mod.BookCoversPage };
});

/** Blurb Generator (P9 Batch D) — real page. */
const BlurbGeneratorPage = lazy(async () => {
  const mod = await import('@/modules/publishing/BlurbGeneratorPage');
  return { default: mod.BlurbGeneratorPage };
});

/** Portfolio (P9 Batch E) — real page. */
const PortfolioPage = lazy(async () => {
  const mod = await import('@/modules/publishing/PortfolioPage');
  return { default: mod.PortfolioPage };
});

/** Royalty Calculator (P9 Batch E) — real page. */
const RoyaltyCalculatorPage = lazy(async () => {
  const mod = await import('@/modules/publishing/RoyaltyCalculatorPage');
  return { default: mod.RoyaltyCalculatorPage };
});

/** Writing Statistics & Writing Goals (Round 1 — Workspace) — real pages. */
const StatisticsPage = lazy(async () => {
  const mod = await import('@/modules/stats/StatisticsPage');
  return { default: mod.StatisticsPage };
});

const GoalsPage = lazy(async () => {
  const mod = await import('@/modules/goals/GoalsPage');
  return { default: mod.GoalsPage };
});

/** Standalone Novel Creation modules (Round 1) — share the project tab panels. */
const WorldBuildingPage = lazy(async () => {
  const mod = await import('@/modules/creation/CreationPages');
  return { default: mod.WorldBuildingPage };
});
const CharactersPage = lazy(async () => {
  const mod = await import('@/modules/creation/CreationPages');
  return { default: mod.CharactersPage };
});
const NarrativePlanningPage = lazy(async () => {
  const mod = await import('@/modules/creation/CreationPages');
  return { default: mod.NarrativePlanningPage };
});
const OutlinePage = lazy(async () => {
  const mod = await import('@/modules/creation/CreationPages');
  return { default: mod.OutlinePage };
});
const SceneBuilderPage = lazy(async () => {
  const mod = await import('@/modules/creation/CreationPages');
  return { default: mod.SceneBuilderPage };
});
const StoryEditorPage = lazy(async () => {
  const mod = await import('@/modules/creation/CreationPages');
  return { default: mod.StoryEditorPage };
});

/** Timeline (Round 1) — derived from outline + continuity facts. */
const TimelinePage = lazy(async () => {
  const mod = await import('@/modules/creation/TimelinePage');
  return { default: mod.TimelinePage };
});

/** AI Toolbox (Round 1) — Idea Generator, Model Playground, Style Analyzer. */
const IdeaGeneratorPage = lazy(async () => {
  const mod = await import('@/modules/ai-toolbox/IdeaGeneratorPage');
  return { default: mod.IdeaGeneratorPage };
});

const ModelPlaygroundPage = lazy(async () => {
  const mod = await import('@/modules/ai-toolbox/ModelPlaygroundPage');
  return { default: mod.ModelPlaygroundPage };
});

const StyleAnalyzerPage = lazy(async () => {
  const mod = await import('@/modules/ai-toolbox/StyleAnalyzerPage');
  return { default: mod.StyleAnalyzerPage };
});

/** System settings & Project I/O (Round 1) — real pages. */
const GeneralSettingsPage = lazy(async () => {
  const mod = await import('@/modules/system/GeneralSettingsPage');
  return { default: mod.GeneralSettingsPage };
});
const EditorSettingsPage = lazy(async () => {
  const mod = await import('@/modules/system/EditorSettingsPage');
  return { default: mod.EditorSettingsPage };
});
const HelpPage = lazy(async () => {
  const mod = await import('@/modules/system/HelpPage');
  return { default: mod.HelpPage };
});
const ProjectIOPage = lazy(async () => {
  const mod = await import('@/modules/data/ProjectIOPage');
  return { default: mod.ProjectIOPage };
});

/** Nav ids that have real pages and must be excluded from placeholders. */
const REAL_PAGE_NAV_IDS = new Set([
  'dashboard',
  PROJECTS_NAV_ID,
  RECENT_NAV_ID,
  'api-settings',
  'provider-management',
  'model-config',
  'ai-assistance',
  'prompt-templates',
  'context-manager',
  'knowledge-base',
  'continuity',
  'plot-hole',
  'extraction-review',
  'project-integration',
  'manuscript-import',
  'document-parser',
  'structure-recognition',
  'information-extraction',
  'version-history',
  'diff-viewer',
  'snapshots',
  'backup',
  'publishing-presets',
  'chapter-export',
  'export-manager',
  'book-covers',
  'blurb-generator',
  'portfolio',
  'royalty-calculator',
  'stats',
  'goals',
  'world-building',
  'characters',
  'narrative',
  'outline',
  'scenes',
  'story-editor',
  'timeline',
  'idea-generator',
  'model-playground',
  'style-analyzer',
]);

/** Build one route per navigation item, skipping pages declared above. */
const moduleRoutes = ALL_NAV_ITEMS.filter((item) => !REAL_PAGE_NAV_IDS.has(item.id)).map((item) => {
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
      // Route-level fallback: any render/commit error inside a page shows a
      // recoverable error page instead of React Router's dev error screen.
      // This is only a safety net — it does not mask or paper over any bug.
      errorElement: <RouteErrorPage />,
      children: [
        // Landing page: `/` redirects to the canonical dashboard URL.
        { index: true, element: <Navigate to="/dashboard" replace /> },
        { path: 'dashboard', element: withRouteSuspense(<DashboardPage />) },
        // Real pages (P1-C2-A) — must stay above `moduleRoutes`.
        { path: 'projects', element: withRouteSuspense(<ProjectsPage />) },
        { path: 'recent-projects', element: withRouteSuspense(<RecentProjectsPage />) },
        // Project detail (P1-C2-B2-A): a child path under the real `/projects` route.
        { path: 'projects/:projectId', element: withRouteSuspense(<ProjectDetailPage />) },
        // AI configuration & assistance (P5) — real pages.
        { path: 'settings/api', element: withRouteSuspense(<ApiSettingsPage />) },
        { path: 'settings/providers', element: withRouteSuspense(<ProviderManagementPage />) },
        { path: 'settings/models', element: withRouteSuspense(<ModelConfigurationPage />) },
        { path: 'ai/assistance', element: withRouteSuspense(<AiAssistancePage />) },
        // Prompt Engineering Center & Context Manager (P6).
        { path: 'ai/prompt-templates', element: withRouteSuspense(<PromptTemplatesPage />) },
        { path: 'ai/context-manager', element: withRouteSuspense(<ContextManagerPage />) },
        // Knowledge Base, Continuity & Story Analysis (P7).
        { path: 'ai/knowledge-base', element: withRouteSuspense(<KnowledgeBasePage />) },
        { path: 'ai/continuity-manager', element: withRouteSuspense(<ContinuityManagerPage />) },
        { path: 'ai/plot-hole-detector', element: withRouteSuspense(<PlotHoleDetectorPage />) },
        // Extraction Review Center (P8 Batch 4) — unchanged, still the review surface.
        { path: 'import/review-center', element: withRouteSuspense(<ExtractionReviewPage />) },
        // Project Integration (P8 Batch 5) — unchanged, still the integration surface.
        { path: 'import/project-integration', element: withRouteSuspense(<ProjectIntegrationPage />) },
        // Import workflow stages (P8 Batch 6) — must stay above `moduleRoutes`.
        { path: 'import/manuscript', element: withRouteSuspense(<ManuscriptImportPage />) },
        { path: 'import/document-parser', element: withRouteSuspense(<DocumentParserPage />) },
        { path: 'import/structure-recognition', element: withRouteSuspense(<StructureRecognitionPage />) },
        { path: 'import/information-extraction', element: withRouteSuspense(<InformationExtractionPage />) },
        // Version & Data Management (P9 Batch 2) — real pages.
        { path: 'data/version-history', element: withRouteSuspense(<VersionHistoryPage />) },
        { path: 'data/diff-viewer', element: withRouteSuspense(<DiffViewerPage />) },
        // Project Snapshots (P9 Batch 3-3) — real page.
        { path: 'data/snapshots', element: withRouteSuspense(<ProjectSnapshotsPage />) },
        // Backup & Restore (P9 Batch 4-1) — real page (single-project export).
        { path: 'data/backup-restore', element: withRouteSuspense(<BackupRestorePage />) },
        // Publishing Presets, Chapter Export & Full-book Export (P9 Batch B/C).
        { path: 'publishing/presets', element: withRouteSuspense(<PublishingPresetsPage />) },
        { path: 'publishing/chapter-export', element: withRouteSuspense(<ChapterExportPage />) },
        { path: 'publishing/export-manager', element: withRouteSuspense(<ExportManagerPage />) },
        // Book Covers (P9 Batch D).
        { path: 'publishing/book-covers', element: withRouteSuspense(<BookCoversPage />) },
        // Blurb Generator (P9 Batch D).
        { path: 'publishing/blurb-generator', element: withRouteSuspense(<BlurbGeneratorPage />) },
        // Portfolio & Royalty Calculator (P9 Batch E).
        { path: 'publishing/portfolio', element: withRouteSuspense(<PortfolioPage />) },
        { path: 'publishing/royalty-calculator', element: withRouteSuspense(<RoyaltyCalculatorPage />) },
        // Writing Statistics & Writing Goals (Round 1 — Workspace) — real pages.
        { path: 'statistics', element: withRouteSuspense(<StatisticsPage />) },
        { path: 'goals', element: withRouteSuspense(<GoalsPage />) },
        // Standalone Novel Creation modules (Round 1) — reuse project tab panels.
        { path: 'novel/world-building', element: withRouteSuspense(<WorldBuildingPage />) },
        { path: 'novel/characters', element: withRouteSuspense(<CharactersPage />) },
        { path: 'novel/narrative-planning', element: withRouteSuspense(<NarrativePlanningPage />) },
        { path: 'novel/outline', element: withRouteSuspense(<OutlinePage />) },
        { path: 'novel/scene-builder', element: withRouteSuspense(<SceneBuilderPage />) },
        { path: 'novel/story-editor', element: withRouteSuspense(<StoryEditorPage />) },
        { path: 'novel/timeline', element: withRouteSuspense(<TimelinePage />) },
        // AI Toolbox (Round 1) — real pages.
        { path: 'ai/idea-generator', element: withRouteSuspense(<IdeaGeneratorPage />) },
        { path: 'ai/model-playground', element: withRouteSuspense(<ModelPlaygroundPage />) },
        { path: 'ai/style-analyzer', element: withRouteSuspense(<StyleAnalyzerPage />) },
        // System settings & Project I/O (Round 1) — real pages.
        { path: 'settings/general', element: withRouteSuspense(<GeneralSettingsPage />) },
        { path: 'settings/editor', element: withRouteSuspense(<EditorSettingsPage />) },
        { path: 'settings/help', element: withRouteSuspense(<HelpPage />) },
        { path: 'data/project-import-export', element: withRouteSuspense(<ProjectIOPage />) },
        ...moduleRoutes,
        // Unknown paths render a real 404 inside the shell (not a blank page).
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: ROUTER_BASENAME === '/' ? undefined : ROUTER_BASENAME },
);
