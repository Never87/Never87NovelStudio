import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  FolderKanban,
  History,
  BarChart3,
  Target,
  Globe2,
  Users,
  Compass,
  ListTree,
  Clapperboard,
  PenLine,
  GitBranch,
  Upload,
  FileText,
  ScanText,
  Sparkles,
  ClipboardCheck,
  Merge,
  Bot,
  Lightbulb,
  MessageSquareCode,
  FlaskConical,
  Layers,
  BookOpen,
  Activity,
  Bug,
  Palette,
  Package,
  BookMarked,
  Files,
  Image,
  Quote,
  Briefcase,
  Coins,
  FileClock,
  GitCompare,
  Camera,
  DatabaseBackup,
  Import,
  Plug,
  Boxes,
  SlidersHorizontal,
  Settings,
  Type,
  HelpCircle,
} from 'lucide-react';

/**
 * Navigation is data, not markup.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   - the Sidebar (label, icon, ordering, grouping)
 *   - the Topbar breadcrumb
 *   - the router (every item's `path` becomes a route)
 *   - each page's title, description and empty-state copy
 *
 * Because `path`, `description` and `emptyTitle` are required, an item can
 * never exist without a route, and a route can never exist without a page.
 * `assertNavigationIntegrity()` below enforces that at startup in dev.
 */
export interface NavItem {
  /** Stable key, also used as the i18n key later. */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Canonical URL. Must be unique across all items. */
  path: string;
  /** Purpose-specific description rendered under the page title. */
  description: string;
  /** Empty-state headline tailored to the module. */
  emptyTitle: string;
  /** Supporting sentence shown under the empty-state headline. */
  emptyDescription: string;
  /** Planned capabilities, listed in the empty state. */
  plannedFeatures?: string[];
  /** Extra search hints. */
  keywords?: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: LayoutDashboard,
        path: '/dashboard',
        description: 'Global overview of projects, word count, streaks and writing goals.',
        emptyTitle: 'Dashboard',
        emptyDescription: 'Your workspace overview.',
      },
      {
        id: 'projects',
        label: 'My Projects',
        icon: FolderKanban,
        path: '/projects',
        description:
          'Create, organise and manage every novel project in your workspace.',
        emptyTitle: 'No projects yet',
        emptyDescription:
          'Projects are the root of every novel: outline, characters, world and drafts all live inside one.',
        plannedFeatures: [
          'Create a project from scratch or from a template',
          'Filter and sort by genre, status and last edit',
          'Archive, duplicate and delete projects',
        ],
      },
      {
        id: 'recent',
        label: 'Recent Projects',
        icon: History,
        path: '/recent-projects',
        description: 'Jump straight back into the projects you edited most recently.',
        emptyTitle: 'Nothing edited recently',
        emptyDescription:
          'Once you start writing, the projects you touched most recently will appear here.',
        plannedFeatures: [
          'Ordered by last edit time',
          'Resume the exact chapter and scene',
          'Pin favourites to the top',
        ],
      },
      {
        id: 'stats',
        label: 'Writing Statistics',
        icon: BarChart3,
        path: '/statistics',
        description:
          'Track word counts, daily output and progress charts across all your projects over time.',
        emptyTitle: 'No statistics recorded',
        emptyDescription:
          'Statistics are derived from your writing sessions. Write or import a manuscript to begin tracking.',
        plannedFeatures: [
          'Daily, weekly and monthly word output',
          'Per-project and per-chapter breakdowns',
          'Writing speed and session heatmaps',
        ],
      },
      {
        id: 'goals',
        label: 'Writing Goals',
        icon: Target,
        path: '/goals',
        description:
          'Set daily and project-level word targets, and follow your writing streaks.',
        emptyTitle: 'No goals set',
        emptyDescription:
          'Define a daily word target to build a streak and measure progress towards a finished draft.',
        plannedFeatures: [
          'Daily word targets and reminders',
          'Project deadlines and milestone tracking',
          'Streak history and achievements',
        ],
      },
    ],
  },
  {
    id: 'creation',
    label: 'Novel Creation',
    items: [
      {
        id: 'world-building',
        label: 'World Building',
        icon: Globe2,
        path: '/novel/world-building',
        description:
          'Build and maintain the world, geography, history, factions and rules of your novel.',
        emptyTitle: 'Your world is waiting to be built',
        emptyDescription:
          'Define the setting once and reference it everywhere — from the editor sidebar to AI context.',
        plannedFeatures: [
          'World overview, geography and history',
          'Factions, culture, technology and magic systems',
          'World rules with automatic consistency checks',
        ],
        keywords: ['geography', 'magic', 'culture', 'rules'],
      },
      {
        id: 'characters',
        label: 'Characters',
        icon: Users,
        path: '/novel/characters',
        description:
          "Create and manage your novel's characters, personalities, motivations and relationships.",
        emptyTitle: 'No characters yet',
        emptyDescription:
          'Add your cast to track motivations, arcs, relationships and when each character appears.',
        plannedFeatures: [
          'Profiles: appearance, personality, background, motivation',
          'Relationship graph and character arcs',
          'Appearance tracking and consistency checking',
        ],
        keywords: ['relationships', 'arc', 'simulator'],
      },
      {
        id: 'narrative',
        label: 'Narrative Planning',
        icon: Compass,
        path: '/novel/narrative-planning',
        description:
          'Shape the theme, premise, central conflict, narrative structure, stakes and pacing.',
        emptyTitle: 'No narrative plan yet',
        emptyDescription:
          'Capture the story you intend to tell before drafting, and keep the plan in sync as it evolves.',
        plannedFeatures: [
          'Theme, premise and central conflict',
          'Narrative structure and plot arcs',
          'Stakes, foreshadowing, pacing and ending',
        ],
      },
      {
        id: 'outline',
        label: 'Outline',
        icon: ListTree,
        path: '/novel/outline',
        description:
          'Plan your novel from Volume to Chapter to Section, with goals, key events and hooks.',
        emptyTitle: 'Your outline is empty',
        emptyDescription:
          'Structure the novel as Volumes, Chapters and Sections so every scene has a purpose.',
        plannedFeatures: [
          'Novel → Volume → Chapter → Section hierarchy',
          'Chapter goals, key events and ending hooks',
          'Writing status per chapter',
        ],
      },
      {
        id: 'scenes',
        label: 'Scene Builder',
        icon: Clapperboard,
        path: '/novel/scene-builder',
        description:
          'Design structured scenes with location, time, characters, goal, conflict and outcome.',
        emptyTitle: 'No scenes designed',
        emptyDescription:
          'A scene is the smallest unit of story. Define its goal, conflict and turning point before writing.',
        plannedFeatures: [
          'Location, time and POV character',
          'Goal, conflict, turning point and outcome',
          'Emotional beat and word target',
        ],
      },
      {
        id: 'story-editor',
        label: 'Story Editor',
        icon: PenLine,
        path: '/novel/story-editor',
        description:
          'Write in a three-pane workspace with rich text editing, autosave, version history and AI assistance.',
        emptyTitle: 'No chapter open',
        emptyDescription:
          'Select a chapter to start writing. The editor brings the manuscript, references and AI tools together.',
        plannedFeatures: [
          'Rich text editing with autosave and word counts',
          'Chapter locking and version history',
          'AI continue / expand / shorten / polish with diff preview',
        ],
      },
      {
        id: 'timeline',
        label: 'Timeline',
        icon: GitBranch,
        path: '/novel/timeline',
        description:
          'View story events, chapters and character movements in chronological order.',
        emptyTitle: 'No timeline events yet',
        emptyDescription:
          'Timeline events help you keep chronology straight across chapters, flashbacks and subplots.',
        plannedFeatures: [
          'Chronological and narrative-order views',
          'Character movement and presence tracking',
          'Conflict warnings for impossible orderings',
        ],
      },
    ],
  },
  {
    id: 'import-analysis',
    label: 'Import & Analysis',
    items: [
      {
        id: 'manuscript-import',
        label: 'Manuscript Import',
        icon: Upload,
        path: '/import/manuscript',
        description:
          'Import existing manuscripts from TXT, DOCX and Markdown to extract their structure and lore.',
        emptyTitle: 'No manuscripts imported',
        emptyDescription:
          'Drop in a finished or partial draft and Novel Studio will help you reconstruct its structure.',
        plannedFeatures: [
          'TXT, DOCX and Markdown in the first release',
          'Batch upload with progress and retry',
          'Long-document chunked parsing with resumable jobs',
        ],
      },
      {
        id: 'document-parser',
        label: 'Document Parser',
        icon: FileText,
        path: '/import/document-parser',
        description:
          'Break imported documents into paragraphs, chapters and scenes with source positions preserved.',
        emptyTitle: 'No document parsed',
        emptyDescription:
          'Parsing turns raw text into addressable paragraphs so every extracted fact keeps its evidence.',
        plannedFeatures: [
          'Paragraph-level source offsets',
          'Chapter and scene boundary detection',
          'Parser diagnostics for malformed input',
        ],
      },
      {
        id: 'structure-recognition',
        label: 'Structure Recognition',
        icon: ScanText,
        path: '/import/structure-recognition',
        description:
          'Automatically detect chapter and scene structure, headings and section breaks in raw text.',
        emptyTitle: 'No structure detected',
        emptyDescription:
          'Structure recognition proposes a chapter tree that you can review and correct before integrating.',
        plannedFeatures: [
          'Heading and numbering pattern detection',
          'Volume / chapter / scene hierarchy proposal',
          'Manual correction before integration',
        ],
      },
      {
        id: 'information-extraction',
        label: 'Information Extraction',
        icon: Sparkles,
        path: '/import/information-extraction',
        description:
          'Extract characters, relationships, locations, rules, events, foreshadowing and style traits.',
        emptyTitle: 'Nothing extracted yet',
        emptyDescription:
          'Extraction reads your manuscript and proposes structured records — each one tied to its source paragraph.',
        plannedFeatures: [
          'Characters and relationships',
          'Locations, factions and world rules',
          'Plot arcs, timeline events and foreshadowing',
        ],
      },
      {
        id: 'extraction-review',
        label: 'Extraction Review Center',
        icon: ClipboardCheck,
        path: '/import/review-center',
        description:
          'Review each extracted record together with its original evidence, confidence and review status.',
        emptyTitle: 'No records awaiting review',
        emptyDescription:
          'Extracted information is never applied automatically. You confirm, edit, reject or merge each record.',
        plannedFeatures: [
          'Original evidence and source chapter / paragraph',
          'Explicit fact vs. AI inference vs. user supplement',
          'Confirm, edit, reject or merge with existing entries',
        ],
      },
      {
        id: 'project-integration',
        label: 'Project Integration',
        icon: Merge,
        path: '/import/project-integration',
        description:
          'Merge confirmed extractions into your project data model without creating duplicate entries.',
        emptyTitle: 'No integration pending',
        emptyDescription:
          'Approved records are merged into the project here, with conflict detection against existing data.',
        plannedFeatures: [
          'Field-level merge conflict resolution',
          'Duplicate detection against existing entities',
          'Full audit trail of what was integrated',
        ],
      },
    ],
  },
  {
    id: 'ai-toolbox',
    label: 'AI Toolbox',
    items: [
      {
        id: 'ai-assistance',
        label: 'AI Assistance',
        icon: Bot,
        path: '/ai/assistance',
        description:
          'Continue, expand, shorten, polish or rewrite prose — always previewed before it is applied.',
        emptyTitle: 'AI is not configured',
        emptyDescription:
          'Connect a provider and model to generate suggestions. Every AI change is previewed and confirmed by you first.',
        plannedFeatures: [
          'Continue, expand, shorten, polish and rewrite',
          'Selection-aware operations inside the editor',
          'Diff preview with explicit apply / discard',
        ],
      },
      {
        id: 'idea-generator',
        label: 'Story Idea Generator',
        icon: Lightbulb,
        path: '/ai/idea-generator',
        description: 'Brainstorm premises, twists, conflicts and character hooks for your story.',
        emptyTitle: 'No ideas generated',
        emptyDescription:
          'Describe your genre and constraints, then generate and save promising directions.',
        plannedFeatures: [
          'Premise and logline generation',
          'Twist and complication brainstorming',
          'Save accepted ideas to the knowledge base',
        ],
      },
      {
        id: 'prompt-templates',
        label: 'Prompt Templates',
        icon: MessageSquareCode,
        path: '/ai/prompt-templates',
        description:
          'Create, version and test reusable prompts with variable placeholders per model.',
        emptyTitle: 'No prompt templates',
        emptyDescription:
          'Templates keep your best instructions reusable and consistent across tasks and models.',
        plannedFeatures: [
          'Variables and default values',
          'Prompt version history',
          'Per-provider / per-model variants and test runs',
        ],
      },
      {
        id: 'model-playground',
        label: 'AI Model Playground',
        icon: FlaskConical,
        path: '/ai/model-playground',
        description:
          'Compare models and parameters on the same prompt to find the best setup for each task.',
        emptyTitle: 'No playground runs',
        emptyDescription:
          'Run one prompt against several models or parameter sets and compare the outputs side by side.',
        plannedFeatures: [
          'Side-by-side responses',
          'Temperature and max-token sweeps',
          'Save the winning configuration as a task default',
        ],
      },
      {
        id: 'context-manager',
        label: 'AI Context Manager',
        icon: Layers,
        path: '/ai/context-manager',
        description:
          'Assemble base, dynamic, retrieved context and user instructions within a token budget.',
        emptyTitle: 'No context assembled',
        emptyDescription:
          'Control exactly what the model sees: project background, current scene, retrieved lore and your instructions.',
        plannedFeatures: [
          'Priority ordering and de-duplication',
          'Token budget preview',
          'Full preview of the actual outgoing request',
        ],
      },
      {
        id: 'knowledge-base',
        label: 'Knowledge Base',
        icon: BookOpen,
        path: '/ai/knowledge-base',
        description: 'Search and organise the structured knowledge of your novel.',
        emptyTitle: 'Your knowledge base is empty',
        emptyDescription:
          'Everything you define about characters, places, rules and events becomes searchable reference material.',
        plannedFeatures: [
          'Keyword search across characters, locations and rules',
          'Retrieval for AI context (vector search later)',
          'Traceable sources for every entry',
        ],
      },
      {
        id: 'continuity',
        label: 'Continuity Manager',
        icon: Activity,
        path: '/ai/continuity-manager',
        description:
          'Track character positions, possessions, knowledge and relationship changes across the story.',
        emptyTitle: 'No continuity data',
        emptyDescription:
          'Continuity tracking catches the small contradictions that break a reader’s trust.',
        plannedFeatures: [
          'Who is where, holding what, knowing what',
          'Relationship change history',
          'Current timeline state at any point in the story',
        ],
      },
      {
        id: 'plot-hole',
        label: 'Plot Hole Detector',
        icon: Bug,
        path: '/ai/plot-hole-detector',
        description:
          'Detect timeline conflicts, logic gaps, world-rule violations and unresolved foreshadowing.',
        emptyTitle: 'No issues detected',
        emptyDescription:
          'Every finding must cite evidence and a location in the manuscript — no unsupported conclusions.',
        plannedFeatures: [
          'Timeline and causality conflicts',
          'Character behaviour and world-rule contradictions',
          'Unresolved foreshadowing and unexplained events',
        ],
      },
      {
        id: 'style-analyzer',
        label: 'Style Analyzer',
        icon: Palette,
        path: '/ai/style-analyzer',
        description:
          'Analyse prose style, sentence rhythm, vocabulary and consistency with your intended voice.',
        emptyTitle: 'No style analysis yet',
        emptyDescription:
          'Style analysis helps keep a long manuscript sounding like one author wrote it.',
        plannedFeatures: [
          'Sentence length and rhythm distribution',
          'Vocabulary richness and repetition spotting',
          'Voice drift detection across chapters',
        ],
      },
    ],
  },
  {
    id: 'publishing',
    label: 'Publishing & Export',
    items: [
      {
        id: 'export-manager',
        label: 'Export Manager',
        icon: Package,
        path: '/publishing/export-manager',
        description: 'Export your manuscript to TXT, DOCX, Markdown, EPUB, PDF and HTML.',
        emptyTitle: 'No exports yet',
        emptyDescription:
          'Prepare a finished draft for readers or publishers in the format you need.',
        plannedFeatures: [
          'Whole-book and per-chapter export',
          'TXT, DOCX, Markdown, EPUB, PDF and HTML',
          'Layout preview before download',
        ],
      },
      {
        id: 'publishing-presets',
        label: 'Publishing Presets',
        icon: BookMarked,
        path: '/publishing/presets',
        description:
          'Platform presets for Qidian, Jinjiang, Fanqie, Wattpad, Royal Road, Amazon KDP and generic EPUB.',
        emptyTitle: 'No presets applied',
        emptyDescription:
          'Presets bundle the formatting rules each platform expects, so you do not hand-format uploads.',
        plannedFeatures: [
          'Qidian, Jinjiang, Fanqie presets',
          'Wattpad, Royal Road and Amazon KDP presets',
          'Custom format builder',
        ],
      },
      {
        id: 'chapter-export',
        label: 'Chapter Export',
        icon: Files,
        path: '/publishing/chapter-export',
        description: 'Select chapters and export them individually with a layout preview.',
        emptyTitle: 'No chapters selected',
        emptyDescription:
          'Export a chapter for feedback, a competition entry or a serialised release.',
        plannedFeatures: [
          'Chapter multi-select',
          'Layout and typography preview',
          'Copy chapter body to clipboard',
        ],
      },
      {
        id: 'book-covers',
        label: 'Book Covers',
        icon: Image,
        path: '/publishing/book-covers',
        description: 'Store and manage cover images and cover variants for each project.',
        emptyTitle: 'No cover uploaded',
        emptyDescription:
          'Keep full-resolution cover art and alternate designs alongside the project that uses them.',
        plannedFeatures: [
          'Upload full-resolution cover art',
          'Multiple variants per project',
          'Size and aspect-ratio checks for platforms',
        ],
      },
      {
        id: 'blurb-generator',
        label: 'Blurb Generator',
        icon: Quote,
        path: '/publishing/blurb-generator',
        description: 'Draft and iterate on back-cover blurbs, taglines and short synopses.',
        emptyTitle: 'No blurb drafted',
        emptyDescription:
          'Generate and refine marketing copy from your premise, characters and hooks.',
        plannedFeatures: [
          'Blurb drafts from project data',
          'Tagline and short-synopsis variants',
          'Length presets per platform',
        ],
      },
      {
        id: 'portfolio',
        label: 'Portfolio',
        icon: Briefcase,
        path: '/publishing/portfolio',
        description: 'A curated overview of your finished works, series and publishing status.',
        emptyTitle: 'Your portfolio is empty',
        emptyDescription:
          'Once a project is marked complete it appears here as part of your body of work.',
        plannedFeatures: [
          'Finished and in-progress works',
          'Series and reading order',
          'Shareable summary of your catalogue',
        ],
      },
      {
        id: 'royalty-calculator',
        label: 'Royalty Calculator',
        icon: Coins,
        path: '/publishing/royalty-calculator',
        description: 'Estimate platform royalties based on word count, price and payout terms.',
        emptyTitle: 'Nothing calculated yet',
        emptyDescription:
          'Compare expected earnings across platforms before you decide where to publish.',
        plannedFeatures: [
          'Per-platform rate assumptions',
          'Price and word-count inputs',
          'Comparison table across platforms',
        ],
      },
    ],
  },
  {
    id: 'version-data',
    label: 'Version & Data Management',
    items: [
      {
        id: 'version-history',
        label: 'Version History',
        icon: FileClock,
        path: '/data/version-history',
        description:
          'Browse every saved version of a chapter and restore any of them safely.',
        emptyTitle: 'No versions recorded',
        emptyDescription:
          'Versions are captured as you write. Once chapters exist, their history appears here.',
        plannedFeatures: [
          'Automatic and manual version snapshots',
          'Restore any version without losing work',
          'Per-chapter history with timestamps',
        ],
      },
      {
        id: 'diff-viewer',
        label: 'Diff Viewer',
        icon: GitCompare,
        path: '/data/diff-viewer',
        description: 'Compare two versions of a text side by side with word-level highlighting.',
        emptyTitle: 'Nothing to compare',
        emptyDescription:
          'Pick two versions of a chapter to see exactly what changed between them.',
        plannedFeatures: [
          'Side-by-side and inline diff modes',
          'Word-level change highlighting',
          'Accept individual changes',
        ],
      },
      {
        id: 'snapshots',
        label: 'Project Snapshots',
        icon: Camera,
        path: '/data/snapshots',
        description: 'Capture point-in-time snapshots of an entire project and restore them later.',
        emptyTitle: 'No snapshots taken',
        emptyDescription:
          'A snapshot freezes the whole project — outline, characters, world and drafts — at one moment.',
        plannedFeatures: [
          'Full-project point-in-time capture',
          'Restore replaces current data safely',
          'Named snapshots with notes',
        ],
      },
      {
        id: 'backup',
        label: 'Backup & Restore',
        icon: DatabaseBackup,
        path: '/data/backup-restore',
        description: 'Back up your entire workspace and restore it on any device.',
        emptyTitle: 'No backups yet',
        emptyDescription:
          'Because your work lives in the browser, regular backups are the safest way to protect it.',
        plannedFeatures: [
          'Full workspace backup file',
          'Restore with overwrite or merge',
          'Reminders to back up regularly',
        ],
      },
      {
        id: 'project-io',
        label: 'Import / Export Project',
        icon: Import,
        path: '/data/project-import-export',
        description:
          'Move a single project in or out of Novel Studio using the portable .n87novel format.',
        emptyTitle: 'No project transfers',
        emptyDescription:
          'Use the .n87novel format to share a project or move it between browsers and devices.',
        plannedFeatures: [
          'Export one project as .n87novel',
          'Import with version compatibility checks',
          'Id-based merge on re-import',
        ],
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        id: 'api-settings',
        label: 'API Settings',
        icon: Plug,
        path: '/settings/api',
        description:
          'Configure API base URLs, keys and the default model used across the workspace.',
        emptyTitle: 'No API configured',
        emptyDescription:
          'Add a provider and API key to unlock AI features. Keys are stored locally in your browser only.',
        plannedFeatures: [
          'Base URL and API key per provider',
          'Connection test without using your quota',
          'Default model selection',
        ],
      },
      {
        id: 'provider-management',
        label: 'Provider Management',
        icon: Boxes,
        path: '/settings/providers',
        description:
          'Manage OpenAI-compatible, Anthropic, Gemini and custom providers in one place.',
        emptyTitle: 'No providers added',
        emptyDescription:
          'Add the services you use; Novel Studio speaks the OpenAI-compatible dialect and adapts the rest.',
        plannedFeatures: [
          'OpenAI-compatible, Anthropic and Gemini presets',
          'Custom endpoints and headers',
          'Enable / disable per provider',
        ],
      },
      {
        id: 'model-config',
        label: 'Model Configuration',
        icon: SlidersHorizontal,
        path: '/settings/models',
        description:
          'Choose models and parameters per task, with token and timeout limits.',
        emptyTitle: 'No models configured',
        emptyDescription:
          'Assign a model to each AI task so generation, extraction and analysis use the right engine.',
        plannedFeatures: [
          'Per-task model selection',
          'Temperature, max tokens and timeouts',
          'Capability detection and fallbacks',
        ],
      },
      {
        id: 'general-settings',
        label: 'General Settings',
        icon: Settings,
        path: '/settings/general',
        description: 'Configure interface language, theme and general workspace defaults.',
        emptyTitle: 'General settings',
        emptyDescription:
          'Language, theme and default project behaviour will be configurable here.',
        plannedFeatures: [
          'Interface language',
          'Theme: light, dark or follow system',
          'Default new-project options',
        ],
      },
      {
        id: 'editor-settings',
        label: 'Editor Settings',
        icon: Type,
        path: '/settings/editor',
        description:
          'Tune editor typography, line spacing, autosave interval and writing behaviour.',
        emptyTitle: 'Editor preferences',
        emptyDescription:
          'Adjust the writing surface to your taste — font, size, spacing and autosave timing.',
        plannedFeatures: [
          'Font family and size',
          'Line height and paragraph spacing',
          'Autosave interval and focus mode defaults',
        ],
      },
      {
        id: 'help',
        label: 'Help & About',
        icon: HelpCircle,
        path: '/settings/help',
        description:
          'Documentation, keyboard shortcuts, changelog and build information.',
        emptyTitle: 'Help & About',
        emptyDescription:
          'Find guides, shortcut references and release notes for this build.',
        plannedFeatures: [
          'Getting-started documentation',
          'Keyboard shortcut reference',
          'Version, changelog and issue reporting',
        ],
      },
    ],
  },
];

/** Flat lookup of every known item, keyed by id. */
export const NAV_ITEMS_BY_ID: Record<string, NavItem> = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item])),
);

/** Every item in declaration order (the order used by the router). */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Flat lookup keyed by canonical path. */
export const NAV_ITEMS_BY_PATH: Record<string, NavItem> = Object.fromEntries(
  ALL_NAV_ITEMS.map((item) => [item.path, item]),
);

/** Group that owns a given item id. */
export function findGroupByItemId(itemId: string): NavGroup | undefined {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.id === itemId));
}

/** Group that owns a given path. */
export function findGroupByPath(path: string): NavGroup | undefined {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.path === path));
}

/**
 * Dev-only consistency check. Throws when navigation and routing could drift:
 * duplicate ids, duplicate paths, or empty required page metadata.
 * Called once from the router module so problems surface immediately.
 */
export function assertNavigationIntegrity(): void {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const problems: string[] = [];

  for (const item of ALL_NAV_ITEMS) {
    if (seenIds.has(item.id)) problems.push(`duplicate id "${item.id}"`);
    seenIds.add(item.id);

    if (!item.path.startsWith('/')) problems.push(`path for "${item.id}" must start with "/"`);
    if (seenPaths.has(item.path)) problems.push(`duplicate path "${item.path}" (${item.id})`);
    seenPaths.add(item.path);

    if (!item.description.trim()) problems.push(`"${item.id}" is missing a description`);
    if (!item.emptyTitle.trim()) problems.push(`"${item.id}" is missing an emptyTitle`);
    if (!item.emptyDescription.trim()) problems.push(`"${item.id}" is missing an emptyDescription`);
  }

  if (problems.length > 0) {
    throw new Error(`[navigation] integrity check failed:\n  - ${problems.join('\n  - ')}`);
  }
}

