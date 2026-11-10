/**
 * Dashboard demo data.
 *
 * Everything here is FABRICATED for the P0 preview. It is intentionally
 * centralised in one module so that deleting it in favour of real IndexedDB
 * repositories (P1) is a single-import change.
 */
export const DEMO_NOTICE =
  'All figures on this page are demo data. No project has been created and no real files are stored yet.';

export interface DemoProject {
  id: string;
  title: string;
  series: string;
  chapters: number;
  words: number;
  progress: number;
  updatedAt: string;
  status: 'drafting' | 'revising' | 'outlining';
  accent: string;
}

export const DEMO_PROJECTS: DemoProject[] = [
  {
    id: 'p1',
    title: 'The Drowned Bell',
    series: 'Tidecaller · Book I',
    chapters: 24,
    words: 61420,
    progress: 68,
    updatedAt: '2 hours ago',
    status: 'drafting',
    accent: 'Tidecaller · Book I',
  },
  {
    id: 'p2',
    title: 'Glass Orchard',
    series: 'Standalone',
    chapters: 9,
    words: 28150,
    progress: 34,
    updatedAt: 'Yesterday',
    status: 'outlining',
    accent: 'Standalone',
  },
  {
    id: 'p3',
    title: 'Iron Lanterns',
    series: 'The Ashen Coast · Book II',
    chapters: 31,
    words: 38860,
    progress: 91,
    updatedAt: '3 days ago',
    status: 'revising',
    accent: 'The Ashen Coast · Book II',
  },
];

export const DEMO_STATS = {
  totalProjects: 3,
  wordsWritten: 128430,
  writingStreakDays: 12,
  completedChapters: 47,
};

export interface DemoActivity {
  id: string;
  type: 'edit' | 'character' | 'import' | 'goal';
  text: string;
  meta: string;
  time: string;
}

export const DEMO_ACTIVITY: DemoActivity[] = [
  { id: 'a1', type: 'edit', text: 'Edited “Chapter 12 — The Drowned Bell”', meta: '1,240 words', time: '2h ago' },
  { id: 'a2', type: 'character', text: 'Updated character “Marshal Iven Rook”', meta: 'Motivation', time: 'Yesterday' },
  { id: 'a3', type: 'import', text: 'Parsed draft from “iron_lanterns_v3.docx”', meta: '31 chapters', time: '3 days ago' },
  { id: 'a4', type: 'goal', text: 'Hit daily goal of 1,500 words', meta: '3 day streak', time: '3 days ago' },
];

export const DEMO_GOAL = {
  dailyTarget: 1500,
  todayWritten: 980,
  weekWritten: 6420,
  weekTarget: 10500,
  streakDays: 12,
  bestStreak: 21,
};

/** Last 7 days of word output, used by the goal chart. */
export const DEMO_WEEK_OUTPUT = [
  { day: 'Mon', words: 1240 },
  { day: 'Tue', words: 860 },
  { day: 'Wed', words: 1620 },
  { day: 'Thu', words: 410 },
  { day: 'Fri', words: 1180 },
  { day: 'Sat', words: 1110 },
  { day: 'Sun', words: 980 },
];

export const DEMO_AI_STATUS = {
  configured: false,
  provider: 'Not configured',
  note: 'Provider adapters ship in P5. No API key is stored and no network request is made.',
};

export const COMPLETED_CHAPTERS_LABEL = `${DEMO_STATS.completedChapters} chapters`;
