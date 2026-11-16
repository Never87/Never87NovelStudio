/**
 * Dashboard fix — Round 1: PURE unit tests for dashboard statistics.
 *
 * Bundles the REAL `src/modules/dashboard/stats.ts` (no DB, no browser) and
 * exercises the pure aggregation helpers, then bundles the REAL
 * `src/services/writing-stats-service.ts` and drives it with in-memory fake
 * repositories to prove the end-to-end snapshot is derived from real data.
 *
 * Guarantees proven:
 *   1. streaks count back from today, tolerate "not written yet today", and
 *      never fabricate a history (empty ledger => streak 0);
 *   2. best-streak finds the longest consecutive run;
 *   3. the 7-day series is exactly 7 days old→new with honest zeros;
 *   4. `applyWordDelta` clamps at 0 (never negative words);
 *   5. `isCompletedChapter` counts only revised/final;
 *   6. WritingStatsService: words = sum of chapter+scene drafts; completed =
 *      revised/final chapters; today/week/streak come from the activity ledger;
 *      empty workspace => genuine zeros/nulls, no activity history;
 *   7. recordWordDelta is a per-day upsert that accumulates and clamps.
 *
 * Usage: npm run verify:dashboard
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ALIAS = { '@': projectPath('src') };

async function loadStatsModule() {
  return importBundled('src/modules/dashboard/stats.ts', 'dashboard-stats', { alias: ALIAS });
}

/* A fixed "now" = 2024-06-15 12:00 LOCAL. */
function refDate() {
  return new Date(2024, 5, 15, 12, 0, 0, 0).getTime();
}

async function pureTests() {
  const mod = await loadStatsModule();
  const {
    applyWordDelta,
    buildDailyOutputSeries,
    computeStreak,
    computeBestStreak,
    isCompletedChapter,
  } = mod;

  // localDateKeyDaysAgo — derive local keys via the same helper on a row set.
  const { localDateKeyDaysAgo } = await importBundled('src/utils/date.ts', 'date-util', { alias: ALIAS });
  const ref = refDate();
  const dayKey = (ago) => localDateKeyDaysAgo(ago, ref);

  eq('isCompletedChapter revised', isCompletedChapter('revised'), true);
  eq('isCompletedChapter final', isCompletedChapter('final'), true);
  eq('isCompletedChapter drafted', isCompletedChapter('drafted'), false);
  eq('isCompletedChapter drafting', isCompletedChapter('drafting'), false);
  eq('isCompletedChapter planned', isCompletedChapter('planned'), false);

  eq('applyWordDelta positive', applyWordDelta(100, 50), 150);
  eq('applyWordDelta negative clamps', applyWordDelta(30, -80), 0);
  eq('applyWordDelta zero', applyWordDelta(10, 0), 10);

  /* ---- streak: today + 2 previous days written => 3 ---- */
  {
    const map = new Map([
      [dayKey(0), 10],
      [dayKey(1), 20],
      [dayKey(2), 30],
      [dayKey(4), 40], // gap at day 3 breaks the streak
    ]);
    eq('streak counts today back 3', computeStreak(map, ref), 3);
  }

  /* ---- streak: nothing today, but yesterday+ before => counts from yesterday ---- */
  {
    const map = new Map([
      [dayKey(1), 20],
      [dayKey(2), 30],
    ]);
    eq('streak tolerates not-written-yet today', computeStreak(map, ref), 2);
  }

  /* ---- empty ledger => 0 ---- */
  eq('empty map streak 0', computeStreak(new Map(), ref), 0);

  /* ---- best streak ---- */
  {
    const rows = [
      { dateKey: dayKey(10), wordsWritten: 5 },
      { dateKey: dayKey(9), wordsWritten: 5 },
      { dateKey: dayKey(8), wordsWritten: 5 },
      { dateKey: dayKey(7), wordsWritten: 5 },
      { dateKey: dayKey(2), wordsWritten: 5 },
      { dateKey: dayKey(1), wordsWritten: 5 },
    ];
    eq('best streak = 4', computeBestStreak(rows), 4);
  }
  eq('best streak empty = 0', computeBestStreak([]), 0);

  /* ---- 7-day series: exactly 7, oldest first, honest zeros ---- */
  {
    const rows = [
      { projectId: 'p1', dateKey: dayKey(0), wordsWritten: 100 },
      { projectId: 'p2', dateKey: dayKey(0), wordsWritten: 50 },
      { projectId: 'p1', dateKey: dayKey(3), wordsWritten: 200 },
    ];
    const series = buildDailyOutputSeries(rows, 7, ref);
    eq('series length 7', series.length, 7);
    eq('series oldest first is day-6', series[0].dateKey, dayKey(6));
    eq('series last is today', series[6].dateKey, dayKey(0));
    eq('today sums across projects', series[6].words, 150);
    eq('day-3 value', series[3].words, 200);
    eq('empty day is 0', series[0].words, 0);
  }
}

/* ------------------------------------------------------------------------- */
/* Service-level tests with injected fake repositories                       */
/* ------------------------------------------------------------------------- */

async function serviceTests() {
  const mod = await importBundled('src/services/writing-stats-service.ts', 'writing-stats-service', {
    alias: ALIAS,
  });
  const { WritingStatsService } = mod;
  const { localDateKeyDaysAgo } = await importBundled('src/utils/date.ts', 'date-util2', { alias: ALIAS });
  const ref = Date.now();
  const dayKey = (ago) => localDateKeyDaysAgo(ago, ref);

  function makeFakes({ projects = [], chaptersByProject = {}, draftsByProject = {}, sceneDraftsByProject = {}, activityRows = [], goal = null } = {}) {
    const activityStore = new Map(activityRows.map((r) => [`${r.projectId}|${r.dateKey}`, { ...r }]));
    const activityRepository = {
      async getByProjectAndDate(projectId, dateKey) {
        return activityStore.get(`${projectId}|${dateKey}`) ?? null;
      },
      async listByProject(projectId) {
        return [...activityStore.values()].filter((r) => r.projectId === projectId);
      },
      async listByDateRange(from, to) {
        return [...activityStore.values()].filter((r) => r.dateKey >= from && r.dateKey <= to);
      },
      async getAll() {
        return [...activityStore.values()];
      },
      async create(row) {
        activityStore.set(`${row.projectId}|${row.dateKey}`, { ...row });
        return row;
      },
      async put(row) {
        activityStore.set(`${row.projectId}|${row.dateKey}`, { ...row });
        return row;
      },
    };
    const projectRepository = { async getAll() { return projects; } };
    const outlineRepository = {
      async listChaptersByProject(projectId) { return chaptersByProject[projectId] ?? []; },
    };
    const manuscriptRepository = {
      async listChapterDraftsByProject(projectId) { return draftsByProject[projectId] ?? []; },
      async listSceneDraftsByProject(projectId) { return sceneDraftsByProject[projectId] ?? []; },
    };
    const goalService = {
      async getGlobalGoal() { return goal; },
    };
    const svc = new WritingStatsService(activityRepository, projectRepository, outlineRepository, manuscriptRepository, goalService);
    return { svc, activityStore };
  }

  /* ---- empty workspace: honest zeros / nulls ---- */
  {
    const { svc } = makeFakes();
    const stats = await svc.getDashboardStats(8, ref);
    eq('empty words 0', stats.wordsWritten, 0);
    eq('empty completed 0', stats.completedChapters, 0);
    eq('empty total chapters 0', stats.totalChapters, 0);
    eq('empty streak 0', stats.writingStreak, 0);
    eq('empty hasActivityHistory false', stats.hasActivityHistory, false);
    eq('empty continueTarget null', stats.continueTarget, null);
    eq('empty recentActivity []', stats.recentActivity, []);
    eq('empty weekSeries length 7', stats.weekSeries.length, 7);
    eq('empty today 0', stats.todayWords, 0);
  }

  /* ---- real data: words, completed, continue, activity ---- */
  {
    const projects = [
      { id: 'p1', title: 'Alpha', createdAt: ref - 100000, updatedAt: ref - 1000 },
      { id: 'p2', title: 'Beta', createdAt: ref - 500000, updatedAt: ref - 900000 },
    ];
    const chaptersByProject = {
      p1: [
        { id: 'c1', title: 'Ch One', status: 'final' },
        { id: 'c2', title: 'Ch Two', status: 'drafted' },
        { id: 'c3', title: 'Ch Three', status: 'revised' },
      ],
      p2: [{ id: 'c4', title: 'Beta Ch', status: 'drafting' }],
    };
    const draftsByProject = {
      p1: [
        { id: 'd1', ownerId: 'c1', wordCount: 1000, createdAt: 1, updatedAt: 2 },
        { id: 'd2', ownerId: 'c2', wordCount: 500, createdAt: 1, updatedAt: 3 },
        { id: 'd3', ownerId: 'c3', wordCount: 800, createdAt: 1, updatedAt: 10 }, // most recent edit
      ],
      p2: [],
    };
    const sceneDraftsByProject = {
      p1: [{ id: 's1', ownerId: 'sc1', wordCount: 200 }],
      p2: [],
    };
    const activityRows = [
      { id: 'a1', projectId: 'p1', dateKey: dayKey(0), wordsWritten: 120, createdAt: 1, updatedAt: 1 },
      { id: 'a2', projectId: 'p1', dateKey: dayKey(1), wordsWritten: 80, createdAt: 1, updatedAt: 1 },
      { id: 'a3', projectId: 'p1', dateKey: dayKey(2), wordsWritten: 60, createdAt: 1, updatedAt: 1 },
    ];
    const goal = { id: 'global', scope: 'global', dailyWordTarget: 500, createdAt: 1, updatedAt: 1 };
    const { svc } = makeFakes({ projects, chaptersByProject, draftsByProject, sceneDraftsByProject, activityRows, goal });
    const stats = await svc.getDashboardStats(8, ref);

    eq('words sum chapter+scene', stats.wordsWritten, 1000 + 500 + 800 + 200);
    eq('completed = revised+final', stats.completedChapters, 2);
    eq('total chapters', stats.totalChapters, 4);
    eq('streak 3 (today,1,2)', stats.writingStreak, 3);
    eq('best streak 3', stats.bestStreak, 3);
    eq('today words 120', stats.todayWords, 120);
    eq('week words sum', stats.weekWords, 120 + 80 + 60);
    eq('hasActivityHistory true', stats.hasActivityHistory, true);
    eq('goal passed through', stats.goal.dailyWordTarget, 500);

    // Continue target = most recently updated project (p1) & its most-edited draft (c3).
    eq('continue project p1', stats.continueTarget.projectId, 'p1');
    eq('continue chapter c3', stats.continueTarget.chapterId, 'c3');
    eq('continue chapter title', stats.continueTarget.chapterTitle, 'Ch Three');

    // Recent activity includes project creations and chapter edits, newest first.
    check('recent activity non-empty', stats.recentActivity.length > 0);
    check('recent activity newest-first', stats.recentActivity.every((e, i, arr) => i === 0 || arr[i - 1].at >= e.at));
    check('recent activity has chapter-edited', stats.recentActivity.some((e) => e.kind === 'chapter-edited'));
  }

  /* ---- recordWordDelta: upsert + accumulate + clamp ---- */
  {
    const { svc, activityStore } = makeFakes({ projects: [{ id: 'p1' }] });
    await svc.recordWordDelta('p1', 100);
    await svc.recordWordDelta('p1', 50);
    const key = `p1|${dayKey(0)}`;
    check('row created today', activityStore.has(key));
    eq('accumulates 100+50', activityStore.get(key).wordsWritten, 150);
    await svc.recordWordDelta('p1', -500);
    eq('clamps at 0', activityStore.get(key).wordsWritten, 0);
    await svc.recordWordDelta('p1', 0);
    eq('zero delta no-op value unchanged', activityStore.get(key).wordsWritten, 0);
    eq('one row per project/day', activityStore.size, 1);
  }

  /* ---- continue target: no chapters => null ---- */
  {
    const { svc } = makeFakes({ projects: [{ id: 'p1', title: 'Only', createdAt: 1, updatedAt: 2 }] });
    const stats = await svc.getDashboardStats(8, ref);
    eq('no chapters => continueTarget null', stats.continueTarget, null);
  }
}

async function main() {
  await pureTests();
  await serviceTests();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (failed > 0) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail ? `(${r.detail})` : ''}`);
  }
  cleanupTemp();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
