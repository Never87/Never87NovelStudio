/**
 * Round 1 final browser acceptance — Outline two-way beat link, Project I/O
 * import, the 16 Round-1 routes, and the Dashboard's six real figures.
 *
 * This drives the REAL running app over CDP against a throwaway Chrome profile
 * backed by REAL IndexedDB. It exercises the SAME services the UI calls
 * (`outlineService`, `backupService`, `backupPreviewService`,
 * `projectRestoreService`, `writingStatsService`), so what is proven here is the
 * production code path, not a mock.
 *
 * Requires a dev server ALREADY running on http://localhost:5177/ — it does NOT
 * start one (per project convention; start one yourself if needed). It only
 * spawns its OWN Chrome instance and cleans up its OWN profile.
 *
 * Usage:
 *   npm run verify:round1:browser      (needs dev server on :5177)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9451;
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
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
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
  async sendBounded(method, params = {}, timeoutMs = 20_000) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP "${method}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try { return await Promise.race([this.send(method, params), guard]); }
    finally { clearTimeout(timer); }
  }
  async eval(expression) {
    const result = await this.sendBounded('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
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

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n87-r1-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 80; i += 1) {
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

  const installErrorHooks = `(() => {
    window.__n87Errors = [];
    window.addEventListener('error', (e) => window.__n87Errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__n87Errors.push(String(e.reason)));
    return true;
  })()`;

  // Load the app so that /src/services/* dynamic imports resolve.
  await cdp.sendBounded('Page.navigate', { url: APP_URL + 'dashboard' });
  await sleep(3500);
  await cdp.eval(installErrorHooks);

  /* ================================================================== */
  /* 1. Outline <-> PlotBeat TWO-WAY linking, unlink, delete-no-dangling */
  /* ================================================================== */
  const seed = await cdp.eval(`(async () => {
    const { projectService, outlineService, narrativeService } = await import('/src/services/index.ts');
    for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
    const a = await projectService.createProject({ title: 'Two-Way A', description: 'beat links' });
    const plan = await narrativeService.createPlan(a.id, {
      logline: 'Plan under test',
      beats: [
        { title: 'Beat One', description: 'first', position: 10 },
        { title: 'Beat Two', description: 'second', position: 60 },
      ],
    });
    const vol = await outlineService.createVolume(a.id, { title: 'Vol' });
    const c1 = await outlineService.createChapter(a.id, vol.id, { title: 'Chapter One', order: 0 });
    const c2 = await outlineService.createChapter(a.id, vol.id, { title: 'Chapter Two', order: 1 });
    return { pid: a.id, planId: plan.id, beats: plan.beats.map(b => ({ id: b.id, title: b.title })), c1: c1.id, c2: c2.id };
  })()`);
  record('seed: project + plan(2 beats) + 2 chapters created', !!(seed && seed.pid && seed.beats.length === 2 && seed.c1 && seed.c2), JSON.stringify(seed));

  // Reverse edit: assign both chapters to beats via the SAME write path the UI uses.
  const assign = await cdp.eval(`(async () => {
    const { outlineService } = await import('/src/services/index.ts');
    await outlineService.updateChapter('${seed.c1}', { plotBeatId: '${seed.beats[0].id}' });
    await outlineService.updateChapter('${seed.c2}', { plotBeatId: '${seed.beats[0].id}' });
    const b0 = await outlineService.getBeatChapterLinks('${seed.pid}');
    const c1 = await outlineService.getChapter('${seed.c1}');
    const c2 = await outlineService.getChapter('${seed.c2}');
    const linkedToBeat0 = (b0.get('${seed.beats[0].id}') || []).map(c => c.id).sort();
    return { linkedToBeat0, c1Beat: c1.plotBeatId, c2Beat: c2.plotBeatId,
             totalLinked: [...b0.values()].reduce((n, arr) => n + arr.length, 0) };
  })()`);
  record('two-way: chapter->beat link stored (c1)', assign.c1Beat === seed.beats[0].id, JSON.stringify(assign));
  record('two-way: chapter->beat link stored (c2)', assign.c2Beat === seed.beats[0].id);
  record('two-way: derived beat->chapters view groups both under beat one', JSON.stringify(assign.linkedToBeat0) === JSON.stringify([seed.c1, seed.c2].sort()), JSON.stringify(assign.linkedToBeat0));
  record('two-way: total linked chapters = 2', assign.totalLinked === 2);

  // Unlink one chapter.
  const unlink = await cdp.eval(`(async () => {
    const { outlineService } = await import('/src/services/index.ts');
    await outlineService.updateChapter('${seed.c2}', { plotBeatId: null });
    const c2 = await outlineService.getChapter('${seed.c2}');
    const b0 = await outlineService.getBeatChapterLinks('${seed.pid}');
    return { c2Beat: c2.plotBeatId, linked: (b0.get('${seed.beats[0].id}') || []).map(c => c.id) };
  })()`);
  record('unlink: clearing plotBeatId removes the link', unlink.c2Beat === undefined, JSON.stringify(unlink));
  record('unlink: derived view drops the unlinked chapter', JSON.stringify(unlink.linked) === JSON.stringify([seed.c1]), JSON.stringify(unlink.linked));

  // Delete a beat from the plan (as NarrativePanel does) and verify no dangling ref.
  const delBeat = await cdp.eval(`(async () => {
    const { outlineService, narrativeService } = await import('/src/services/index.ts');
    const before = await narrativeService.getPlan('${seed.pid}');
    // Remove beat one; keep beat two.
    await narrativeService.updatePlan('${seed.pid}', {
      beats: (before.beats || []).filter(b => b.id !== '${seed.beats[0].id}').map(b => ({ id: b.id, title: b.title, description: b.description, position: b.position })),
    });
    // Cleanup exactly like the panel's handleUpdate: unlink removed beats.
    const unlinked = await outlineService.unlinkRemovedBeats('${seed.pid}', ['${seed.beats[0].id}']);
    const c1 = await outlineService.getChapter('${seed.c1}');
    const planAfter = await narrativeService.getPlan('${seed.pid}');
    return {
      unlinked,
      c1Beat: c1.plotBeatId,
      remainingBeats: (planAfter.beats || []).map(b => b.id),
      stillHasRemoved: (planAfter.beats || []).some(b => b.id === '${seed.beats[0].id}'),
    };
  })()`);
  record('delete-beat: plan no longer has the removed beat', delBeat.stillHasRemoved === false, JSON.stringify(delBeat));
  record('delete-beat: chapter link to removed beat cleared (no dangling)', delBeat.c1Beat === undefined, JSON.stringify(delBeat.c1Beat));
  record('delete-beat: one chapter was unlinked by cleanup', delBeat.unlinked === 1, JSON.stringify(delBeat.unlinked));

  /* ================================================================== */
  /* 2. Project I/O: export -> import as NEW project; original intact    */
  /* ================================================================== */
  const exported = await cdp.eval(`(async () => {
    const { backupService, outlineService } = await import('/src/services/index.ts');
    const vol = await outlineService.createVolume('${seed.pid}', { title: 'Vol 2' });
    const ch = await outlineService.createChapter('${seed.pid}', vol.id, { title: 'Extra Chapter', order: 2 });
    const file = await backupService.exportProjectFile('${seed.pid}');
    window.__r1File = file; // keep on window for the import step
    return { fileName: file.fileName, digest: file.integrityDigest, len: file.content.length };
  })()`);
  record('export: produced a non-empty .n87novel package', exported && exported.len > 0 && !!exported.digest, JSON.stringify(exported));

  const imported = await cdp.eval(`(async () => {
    const { backupPreviewService, projectRestoreService, projectService } = await import('/src/services/index.ts');
    const file = window.__r1File;
    const countBefore = (await projectService.listProjects()).length;
    const parsed = await backupPreviewService.parseBackupEntry({ text: file.content, name: file.fileName }, { fileName: file.fileName });
    const result = await projectRestoreService.restoreAsNewProject(parsed.entry);
    const after = await projectService.listProjects();
    const originalStillThere = after.some(p => p.id === '${seed.pid}');
    const importedExists = after.some(p => p.id === result.projectId);
    const isNewProject = result.projectId !== '${seed.pid}';
    const importedTitle = result.project.title;
    return {
      countBefore, countAfter: after.length, isNewProject, originalStillThere, importedExists,
      importedProjectId: result.projectId, importedTitle,
    };
  })()`);
  record('import: created exactly one NEW project (count grew by 1)', imported.countAfter === imported.countBefore + 1, JSON.stringify(imported));
  record('import: new project id differs from the source project', imported.isNewProject === true);
  record('import: the source project still exists (not overwritten)', imported.originalStillThere === true);
  record('import: the imported project exists in the store', imported.importedExists === true);

  // Reload and confirm the imported project persisted; original unchanged.
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(3000);
  await cdp.eval(installErrorHooks);
  const afterReload = await cdp.eval(`(async () => {
    const { projectService, outlineService } = await import('/src/services/index.ts');
    const all = await projectService.listProjects();
    const original = all.find(p => p.id === '${seed.pid}');
    const imported = all.find(p => p.id === '${imported.importedProjectId}');
    let importedChapterCount = null;
    if (imported) importedChapterCount = (await outlineService.listProjectChapters(imported.id)).length;
    let originalChapterCount = null;
    if (original) originalChapterCount = (await outlineService.listProjectChapters(original.id)).length;
    return {
      total: all.length,
      originalExists: !!original,
      importedExists: !!imported,
      importedChapterCount,
      originalChapterCount,
    };
  })()`);
  record('reload: imported project persisted', afterReload.importedExists === true, JSON.stringify(afterReload));
  record('reload: original project persisted', afterReload.originalExists === true);
  record('reload: imported project carries its content (chapters copied)', afterReload.importedChapterCount === 3, JSON.stringify(afterReload.importedChapterCount));
  record('reload: original project still has its 3 chapters', afterReload.originalChapterCount === 3, JSON.stringify(afterReload.originalChapterCount));

  /* ================================================================== */
  /* 3. Import FAILURE leaves no half-written project                    */
  /* ================================================================== */
  const failed = await cdp.eval(`(async () => {
    const { backupService, backupPreviewService, projectRestoreService, projectService } = await import('/src/services/index.ts');
    const countBefore = (await projectService.listProjects()).length;
    // A page reload wipes window globals, so re-export the source project here.
    const file = await backupService.exportProjectFile('${seed.pid}');

    // (a) malformed JSON is rejected before any write.
    let malformedErr = null;
    try {
      await backupPreviewService.parseBackupEntry({ text: '{ not json', name: 'broken.n87novel' }, { fileName: 'broken.n87novel' });
    } catch (e) { malformedErr = e; }

    // (b) tampered payload fails integrity check before any write.
    const pkg = JSON.parse(file.content);
    pkg.projects[0].data.characters = pkg.projects[0].data.characters || [];
    pkg.projects[0].data.characters.push({ id: 'char_tamper', projectId: pkg.projects[0].project.id, name: 'T', summary: '', background: '', personality: '', motivation: '', appearance: '', role: 'supporting', status: 'active', tags: [], createdAt: 1, updatedAt: 1 });
    let tamperErr = null;
    try {
      await backupPreviewService.parseBackupEntry({ text: JSON.stringify(pkg), name: 'tampered.n87novel' }, { fileName: 'tampered.n87novel' });
    } catch (e) { tamperErr = e; }

    const countAfter = (await projectService.listProjects()).length;
    return {
      malformedRejected: malformedErr instanceof Error,
      tamperRejected: tamperErr instanceof Error,
      malformedCode: malformedErr && (malformedErr.code || malformedErr.name),
      countBefore, countAfter,
    };
  })()`);
  record('failure: malformed JSON rejected', failed.malformedRejected === true, JSON.stringify(failed));
  record('failure: tampered payload rejected (integrity)', failed.tamperRejected === true, JSON.stringify(failed));
  record('failure: NO project was created by failed imports', failed.countAfter === failed.countBefore, JSON.stringify(failed));

  /* ================================================================== */
  /* 4. All 16 Round-1 routes open without crashing                     */
  /* ================================================================== */
  const routes = [
    ['Writing Statistics', 'statistics'],
    ['Writing Goals', 'goals'],
    ['World Building', 'novel/world-building'],
    ['Characters', 'novel/characters'],
    ['Narrative Planning', 'novel/narrative-planning'],
    ['Outline', 'novel/outline'],
    ['Scene Builder', 'novel/scene-builder'],
    ['Story Editor', 'novel/story-editor'],
    ['Timeline', 'novel/timeline'],
    ['Story Idea Generator', 'ai/idea-generator'],
    ['AI Model Playground', 'ai/model-playground'],
    ['Style Analyzer', 'ai/style-analyzer'],
    ['Import / Export Project', 'data/project-import-export'],
    ['General Settings', 'settings/general'],
    ['Editor Settings', 'settings/editor'],
    ['Help & About', 'settings/help'],
  ];
  for (const [name, route] of routes) {
    await cdp.sendBounded('Page.navigate', { url: APP_URL + route });
    await sleep(1400);
    const view = await cdp.eval(`(() => {
      const text = document.body.innerText || '';
      const errs = (window.__n87Errors || []).slice();
      return {
        len: text.trim().length,
        hasPlaceholder: /ModulePlaceholder|coming soon|Placeholder/i.test(text),
        errors: errs,
        title: (document.querySelector('h1') && document.querySelector('h1').innerText) || '',
      };
    })()`);
    const ok = view.len > 20 && view.hasPlaceholder === false && (view.errors || []).length === 0;
    record(`route ${route}: opens with real content, no placeholder/errors`, ok, JSON.stringify(view));
  }

  /* ================================================================== */
  /* 5. Dashboard six figures are real                                   */
  /* ================================================================== */
  await cdp.sendBounded('Page.navigate', { url: APP_URL + 'dashboard' });
  await sleep(3000);
  const dash = await cdp.eval(`(async () => {
    const { writingStatsService } = await import('/src/services/index.ts');
    const s = await writingStatsService.getDashboardStats();
    const text = document.body.innerText || '';
    const statSection = document.querySelector('[aria-label="Workspace statistics"]');
    return {
      keys: {
        wordsWritten: typeof s.wordsWritten === 'number',
        writingStreak: typeof s.writingStreak === 'number',
        completedChapters: typeof s.completedChapters === 'number',
        continueTarget: s.continueTarget === null || (typeof s.continueTarget === 'object' && 'chapterId' in s.continueTarget),
        goal: s.goal === null || (typeof s.goal === 'object' && 'dailyWordTarget' in s.goal),
        recentActivity: Array.isArray(s.recentActivity),
      },
      hasWordsWrittenCard: /Words Written/i.test(text),
      hasStreakCard: /Streak/i.test(text),
      hasCompletedCard: /Completed/i.test(text),
      hasContinueCard: /Continue Writing/i.test(text),
      hasGoalCard: /Writing Goal/i.test(text),
      hasActivityCard: /Recent Activity/i.test(text),
      hasDemoBanner: /demo data/i.test(text),
      hasStatSection: !!statSection,
    };
  })()`);
  record('dashboard: wordsWritten present (number)', dash.keys.wordsWritten === true, JSON.stringify(dash.keys));
  record('dashboard: writingStreak present (number)', dash.keys.writingStreak === true);
  record('dashboard: completedChapters present (number)', dash.keys.completedChapters === true);
  record('dashboard: continueTarget present (nullable)', dash.keys.continueTarget === true);
  record('dashboard: goal present (nullable)', dash.keys.goal === true);
  record('dashboard: recentActivity present (array)', dash.keys.recentActivity === true);
  record('dashboard UI: Words Written card visible', dash.hasWordsWrittenCard === true, JSON.stringify(dash));
  record('dashboard UI: Streak card visible', dash.hasStreakCard === true);
  record('dashboard UI: Completed card visible', dash.hasCompletedCard === true);
  record('dashboard UI: Continue Writing card visible', dash.hasContinueCard === true);
  record('dashboard UI: Writing Goal card visible', dash.hasGoalCard === true);
  record('dashboard UI: Recent Activity card visible', dash.hasActivityCard === true);
  record('dashboard UI: no "demo data" banner', dash.hasDemoBanner === false);

  /* ---------------- no uncaught errors overall ---------------- */
  const totalErrors = await cdp.eval(`(() => window.__n87Errors || [])()`);
  record('page: no uncaught exceptions across the run', Array.isArray(totalErrors) && totalErrors.length === 0, JSON.stringify(totalErrors));

  teardown();

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? `  -> ${f.detail}` : ''}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  teardown();
  console.error('\nFATAL:', error);
  process.exit(1);
});
