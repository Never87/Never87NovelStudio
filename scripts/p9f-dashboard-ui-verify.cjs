/**
 * Dashboard fix 鈥?Round 1: REAL browser + IndexedDB verification.
 *
 * The pure unit suite (`verify:dashboard`, 49 checks) proves the maths in
 * isolation with fake repositories. This script proves the parts only a real
 * browser can prove, driving the running app over CDP against a throwaway
 * Chrome profile backed by REAL IndexedDB:
 *
 *   1. EMPTY STATE      鈥?no projects => honest zeros / nulls / empty feed,
 *                          and the Dashboard page renders without a single
 *                          fabricated figure (no "demo data" text, no banner).
 *   2. WORDS WRITTEN    鈥?writing prose into a chapter draft increases the real
 *                          workspace word count.
 *   3. RECENT ACTIVITY  鈥?creating a project + editing a chapter produces real
 *                          activity entries derived from timestamps.
 *   4. WRITING STREAK   鈥?saving prose records a REAL 'today' activity row; the
 *                          streak becomes >= 1 (never fabricated for past days).
 *   5. WRITING GOAL     鈥?a goal set via the shared source persists across a
 *                          full page reload and drives today's progress.
 *   6. COMPLETED        鈥?flipping a chapter to 'revised' increments the
 *                          completed count; creating a chapter does NOT.
 *   7. CONTINUE WRITING 鈥?target = the project/chapter that was actually
 *                          edited last, and switching projects never crosses
 *                          data.
 *   8. PERSISTENCE      鈥?after reload the stats are identical (ledger durable).
 *   9. UI RENDER        鈥?the real dashboard DOM shows the real words figure and
 *                          has no placeholder/coming-soon banner.
 *
 * Usage (dev server already running on :5177 鈥?do NOT start a second one):
 *   npm run verify:dashboard:ui
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9421;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /**
   * Bounded send: a CDP command that never resolves (e.g. a navigation blocked
   * by `beforeunload`) must FAIL LOUDLY rather than hang the whole script.
   */
  async sendBounded(method, params = {}, timeoutMs = 15_000) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP "${method}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([this.send(method, params), guard]);
    } finally {
      clearTimeout(timer);
    }
  }
  async eval(expression) {
    const result = await this.sendBounded('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}`);
    }
    return result.result.value;
  }
}

let activeWs = null;
let activeChrome = null;
let activeProfileDir = null;
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { activeWs?.close(); } catch { /* closed */ }
  try { activeChrome?.kill(); } catch { /* gone */ }
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

/** Convenience: read the dashboard stats snapshot straight from the service. */
const STATS = `(async () => {
  const { writingStatsService } = await import('/src/services/index.ts');
  return await writingStatsService.getDashboardStats();
})()`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  // Fail fast (and clearly) if the dev server is not already running.
  try {
    await httpJson(APP_URL + 'package.json').catch(() => null);
  } catch { /* the app URL isn't JSON; the real check is navigation below */ }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n87-dash-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket never opened within 10s.')), 10_000);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    ws.addEventListener('open', settle(resolve), { once: true });
    ws.addEventListener('error', settle(reject), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // Surface uncaught page errors so a broken render can't hide behind passes.
  await cdp.eval(`(() => {
    window.__n87Errors = [];
    window.addEventListener('error', (e) => window.__n87Errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__n87Errors.push(String(e.reason)));
    return true;
  })()`);

  await cdp.sendBounded('Page.navigate', { url: APP_URL + 'dashboard' });
  await sleep(3000);

  /* ---------------- (0) clean slate: real empty state ------------------ */
  const empties = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const stats = await (${STATS});
    return {
      words: stats.wordsWritten,
      streak: stats.writingStreak,
      completed: stats.completedChapters,
      total: stats.totalChapters,
      goal: stats.goal,
      activity: stats.recentActivity.length,
      continueTarget: stats.continueTarget,
      hasActivityHistory: stats.hasActivityHistory,
    };
  })()`);
  record('empty: words written = 0', empties.words === 0, JSON.stringify(empties));
  record('empty: streak = 0 (no fabricated history)', empties.streak === 0, JSON.stringify(empties.streak));
  record('empty: completed chapters = 0', empties.completed === 0);
  record('empty: no goal set', empties.goal === null);
  record('empty: recent activity feed empty', empties.activity === 0);
  record('empty: continue target null', empties.continueTarget === null);
  record('empty: hasActivityHistory false', empties.hasActivityHistory === false);

  /* -------------- (1) seed two projects via real services -------------- */
  const seeded = await cdp.eval(`(async () => {
    const { projectService, outlineService, manuscriptService } = await import('/src/services/index.ts');
    const a = await projectService.createProject({ title: 'Round One A', description: 'A' });
    const b = await projectService.createProject({ title: 'Round One B', description: 'B' });
    const volA = await outlineService.createVolume(a.id, { title: 'Vol A' });
    const chA = await outlineService.createChapter(a.id, volA.id, { title: 'Chapter A1', order: 0 });
    const volB = await outlineService.createVolume(b.id, { title: 'Vol B' });
    const chB = await outlineService.createChapter(b.id, volB.id, { title: 'Chapter B1', order: 0 });
    // Real prose writes 鈥?these are the events the ledger must record.
    await manuscriptService.openChapterDraft(a.id, chA.id);
    await manuscriptService.saveChapterDraft(a.id, chA.id, { content: 'one two three four five six seven eight nine ten' });
    await manuscriptService.openChapterDraft(b.id, chB.id);
    await manuscriptService.saveChapterDraft(b.id, chB.id, { content: 'alpha beta gamma delta epsilon' });
    return { a: a.id, b: b.id, chA: chA.id, chB: chB.id, volA: volA.id, volB: volB.id };
  })()`);
  record('seed: two projects with chapters created', !!(seeded && seeded.a && seeded.b));

  /* -------------- (2) words written reflects real prose --------------- */
  const afterWrite = await cdp.eval(`(async () => {
    const stats = await (${STATS});
    return { words: stats.wordsWritten, today: stats.todayWords, streak: stats.writingStreak, history: stats.hasActivityHistory };
  })()`);
  record('words: equals the 15 real words written', afterWrite.words === 15, JSON.stringify(afterWrite));
  record('goal-progress: todayWords = 15 (real)', afterWrite.today === 15, JSON.stringify(afterWrite.today));
  record('streak: >= 1 because today has real output', afterWrite.streak >= 1, JSON.stringify(afterWrite.streak));
  record('streak: ledger reports history present', afterWrite.history === true);

  /* -------------- (3) recent activity from real timestamps ------------ */
  const activity = await cdp.eval(`(async () => {
    const stats = await (${STATS});
    return {
      count: stats.recentActivity.length,
      kinds: stats.recentActivity.map((e) => e.kind),
      newestFirst: stats.recentActivity.every((e, i, arr) => i === 0 || arr[i - 1].at >= e.at),
      allTimestamped: stats.recentActivity.every((e) => typeof e.at === 'number' && e.at > 0),
    };
  })()`);
  record('activity: real entries exist', activity.count > 0, JSON.stringify(activity));
  record('activity: includes project-created', activity.kinds.includes('project-created'));
  record('activity: includes chapter-edited', activity.kinds.includes('chapter-edited'));
  record('activity: sorted newest-first', activity.newestFirst === true);
  record('activity: every entry has a real timestamp', activity.allTimestamped === true);

  /* -------------- (4) completed chapters = revised/final -------------- */
  const completed = await cdp.eval(`(async () => {
    const { outlineService } = await import('/src/services/index.ts');
    const before = await (${STATS});
    await outlineService.updateChapter('${seeded.chA}', { status: 'revised' });
    const after = await (${STATS});
    return { before: before.completedChapters, after: after.completedChapters, total: after.totalChapters };
  })()`);
  record('completed: creating chapters alone does not count them', completed.before === 0, JSON.stringify(completed));
  record('completed: revising a chapter increments the count', completed.after === 1, JSON.stringify(completed));
  record('completed: total chapters counts all created', completed.total === 2, JSON.stringify(completed));

  /* -------------- (5) continue writing targets the last edit ---------- */
  const continueAfterB = await cdp.eval(`(async () => {
    const stats = await (${STATS});
    return stats.continueTarget ? { projectId: stats.continueTarget.projectId, chapterId: stats.continueTarget.chapterId } : null;
  })()`);
  // B was written after A, so B should win.
  record('continue: resolves to most recently edited project', continueAfterB && continueAfterB.projectId === seeded.b, JSON.stringify(continueAfterB));
  record('continue: resolves to that project\'s last-edited chapter', continueAfterB && continueAfterB.chapterId === seeded.chB);

  const continueAfterA = await cdp.eval(`(async () => {
    const { manuscriptService } = await import('/src/services/index.ts');
    const d = await manuscriptService.openChapterDraft('${seeded.a}', '${seeded.chA}');
    await manuscriptService.saveChapterDraft('${seeded.a}', '${seeded.chA}', { content: 'one two three four five six seven eight nine ten eleven twelve' });
    const stats = await (${STATS});
    return stats.continueTarget ? { projectId: stats.continueTarget.projectId, chapterId: stats.continueTarget.chapterId } : null;
  })()`);
  record('continue: follows the newest edit (now project A)', continueAfterA && continueAfterA.projectId === seeded.a, JSON.stringify(continueAfterA));

  /* -------------- (6) goal persists via the shared source ------------- */
  const goalSet = await cdp.eval(`(async () => {
    const { writingGoalService } = await import('/src/services/index.ts');
    await writingGoalService.setGlobalGoal(1000);
    const stats = await (${STATS});
    return { target: stats.goal && stats.goal.dailyWordTarget, today: stats.todayWords, id: stats.goal && stats.goal.id };
  })()`);
  record('goal: persisted with the shared singleton id', goalSet.id === 'global', JSON.stringify(goalSet));
  record('goal: target survives into the stats snapshot', goalSet.target === 1000, JSON.stringify(goalSet.target));
  // Rewriting chapter A from 10 → 12 words is a NET +2, so today's real total
  // is 15 (first pass) + 2 (this edit) = 17. This asserts the ledger tracks NET
  // word change, not cumulative keystrokes.
  record('goal: progress uses real today output (today = 17)', goalSet.today === 17, JSON.stringify(goalSet.today));

  /* -------------- (7) persistence across a real reload ---------------- */
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  await cdp.eval(`(() => {
    window.__n87Errors = [];
    window.addEventListener('error', (e) => window.__n87Errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__n87Errors.push(String(e.reason)));
    return true;
  })()`);
  const afterReload = await cdp.eval(`(async () => {
    const stats = await (${STATS});
    return {
      words: stats.wordsWritten,
      goal: stats.goal && stats.goal.dailyWordTarget,
      today: stats.todayWords,
      completed: stats.completedChapters,
      streak: stats.writingStreak,
    };
  })()`);
  record('reload: words written persisted', afterReload.words === 17, JSON.stringify(afterReload));
  record('reload: writing goal persisted', afterReload.goal === 1000, JSON.stringify(afterReload));
  record('reload: today output persisted (ledger durable)', afterReload.today === 17, JSON.stringify(afterReload));
  record('reload: completed chapters persisted', afterReload.completed === 1, JSON.stringify(afterReload));
  record('reload: streak persisted', afterReload.streak >= 1, JSON.stringify(afterReload.streak));

  /* -------- (8) project isolation: deleting B keeps A's numbers ------- */
  const isolation = await cdp.eval(`(async () => {
    const { projectService } = await import('/src/services/index.ts');
    await projectService.deleteProject('${seeded.b}');
    const stats = await (${STATS});
    return { words: stats.wordsWritten, total: stats.totalChapters, completed: stats.completedChapters };
  })()`);
  record('isolation: deleting project B leaves A\'s 12 words', isolation.words === 12, JSON.stringify(isolation));
  record('isolation: B\'s chapter no longer counted', isolation.total === 1, JSON.stringify(isolation));
  record('isolation: A\'s completed chapter still counted', isolation.completed === 1, JSON.stringify(isolation));

  /* ------------- (9) the real Dashboard DOM renders real data --------- */
  await cdp.sendBounded('Page.navigate', { url: APP_URL + 'dashboard' });
  await sleep(3000);
  const dom = await cdp.eval(`(() => {
    const text = document.body.innerText;
    const statSection = document.querySelector('[aria-label="Workspace statistics"]');
    const cards = statSection ? Array.from(statSection.children).map((c) => c.innerText.replace(/\\s+/g, ' ').trim()) : [];
    return {
      hasStatsSection: !!statSection,
      cards,
      hasWordsWritten: /Words Written/i.test(text),
      showsRealWords: /\\b12\\b/.test(text),
      hasDemoBanner: /demo data/i.test(text),
      hasComingSoonOnDashboard: /coming soon/i.test(text),
      hasWritingGoalCard: /Writing Goal/i.test(text),
      hasRecentActivity: /Recent Activity/i.test(text),
      hasContinueWriting: /Continue Writing/i.test(text),
    };
  })()`);
  record('ui: dashboard renders the statistics section', dom.hasStatsSection === true);
  record('ui: Words Written card present', dom.hasWordsWritten === true);
  record('ui: dashboard displays the REAL word count (12)', dom.showsRealWords === true, JSON.stringify(dom.cards));
  record('ui: no "demo data" banner anywhere', dom.hasDemoBanner === false);
  record('ui: no "Coming Soon" placeholder on the dashboard', dom.hasComingSoonOnDashboard === false);
  record('ui: Writing Goal card present', dom.hasWritingGoalCard === true);
  record('ui: Recent Activity card present', dom.hasRecentActivity === true);
  record('ui: Continue Writing card present', dom.hasContinueWriting === true);

  /* -------------- (10) no uncaught page exceptions -------------------- */
  const errors = await cdp.eval(`(() => window.__n87Errors || [])()`);
  record('page: no uncaught exceptions', Array.isArray(errors) && errors.length === 0, JSON.stringify(errors));

  teardown();

  /* ------------- (11) deep link opens the exact chapter --------------- */
  // The Dashboard's "Resume Writing" links to `?tab=writing&chapter=<id>`.
  // Build a fresh project with two chapters holding DISTINCT prose, resolve
  // the continue target, open its deep link, and assert the editor shows the
  // target chapter's prose (not merely the first chapter). Uses a fresh page
  // because the teardown above closed the profile.
  await deepLinkEndToEnd();

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? `  -> ${f.detail}` : ''}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

/**
 * Fresh-profile end-to-end deep-link check. Kept separate from `main` so the
 * first verification pass can tear down its profile cleanly before this opens
 * a second Chrome instance.
 */
async function deepLinkEndToEnd() {
  tornDown = false;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n87-dash-deeplink-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT + 1}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT + 1}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Deep-link Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Deep-link CDP WebSocket never opened within 10s.')), 10_000);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    ws.addEventListener('open', settle(resolve), { once: true });
    ws.addEventListener('error', settle(reject), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.sendBounded('Page.navigate', { url: APP_URL + 'dashboard' });
  await sleep(3000);

  const seeded = await cdp.eval(`(async () => {
    const { projectService, outlineService, manuscriptService } = await import('/src/services/index.ts');
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const a = await projectService.createProject({ title: 'Deep Link' });
    const v = await outlineService.createVolume(a.id, { title: 'V' });
    const c1 = await outlineService.createChapter(a.id, v.id, { title: 'First', order: 0 });
    const c2 = await outlineService.createChapter(a.id, v.id, { title: 'Second', order: 1 });
    await manuscriptService.openChapterDraft(a.id, c1.id);
    await manuscriptService.saveChapterDraft(a.id, c1.id, { content: 'unique first chapter prose marker' });
    await new Promise((r) => setTimeout(r, 10));
    await manuscriptService.openChapterDraft(a.id, c2.id);
    await manuscriptService.saveChapterDraft(a.id, c2.id, { content: 'unique second chapter prose marker' });
    return { pid: a.id, c1: c1.id, c2: c2.id };
  })()`);

  const ct = await cdp.eval(`(async () => {
    const { writingStatsService } = await import('/src/services/index.ts');
    const s = await writingStatsService.getDashboardStats();
    return s.continueTarget ? { projectId: s.continueTarget.projectId, chapterId: s.continueTarget.chapterId } : null;
  })()`);
  record('deeplink: continue target is the last-edited chapter (c2)', ct && ct.chapterId === seeded.c2, JSON.stringify(ct));

  await cdp.sendBounded('Page.navigate', {
    url: `${APP_URL}projects/${ct.projectId}?tab=writing&chapter=${ct.chapterId}`,
  });
  await sleep(3500);
  const view = await cdp.eval(`(() => {
    const text = document.body.innerText;
    return {
      hasSecondProse: /unique second chapter prose marker/i.test(text),
      hasFirstProse: /unique first chapter prose marker/i.test(text),
    };
  })()`);
  record('deeplink: editor opens the target chapter (second prose visible)', view.hasSecondProse === true, JSON.stringify(view));
  record('deeplink: editor does NOT open the first chapter instead', view.hasFirstProse === false, JSON.stringify(view));

  teardown();
}

main().catch((error) => {
  teardown();
  console.error('\nFATAL:', error);
  process.exit(1);
});
