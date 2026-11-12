/**
 * P2-B (narrative planning) end-to-end acceptance harness.
 *
 * Same philosophy as `p2a-verify.cjs`: drives real Chrome over the DevTools
 * Protocol using ONLY Node built-ins, and exercises the ACTUAL app modules
 * (schemas, services, repositories, Dexie) in the real browser runtime.
 *
 * Usage: npm run verify:narrative
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---- staged logging: prints immediately so a hang is pinpointable ---- */
const t0 = Date.now();
function stage(label, extra) {
  const elapsed = String(Date.now() - t0).padStart(6, ' ');
  console.log(`[${elapsed}ms] STAGE: ${label}${extra ? '  ' + extra : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/** Minimal CDP client over the WebSocket protocol. */
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(
        `Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}`,
      );
    }
    return result.result.value;
  }
}

/* Teardown state — closed on success AND on every failure path so the Node
   process never hangs on a live WebSocket / child process handle. */
let activeWs = null;
let activeChrome = null;
let activeProfileDir = null;
let tornDown = false;

function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { if (activeWs) activeWs.close(); } catch { /* already closed */ }
  try {
    if (activeChrome && activeChrome.exitCode === null && !activeChrome.killed) {
      activeChrome.kill('SIGKILL');
    }
  } catch { /* already gone */ }
  try {
    if (activeProfileDir && fs.existsSync(activeProfileDir)) {
      fs.rmSync(activeProfileDir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
  stage('teardown complete');
}

process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-chrome-'));
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
      '--disable-background-networking',
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
    } catch { /* chrome still starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown');
    }
  });

  stage('navigating to app');
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3500);
  stage('app load wait done');

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
  };

  // ---------- Boot: import real modules ----------
  const boot = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    let DexieCtor = null;
    try {
      const m = await import('/node_modules/.vite/deps/dexie.js');
      DexieCtor = m.default ?? m.Dexie ?? null;
    } catch { DexieCtor = null; }
    window.__p2b = { ...dbMod, ...svc, Dexie: DexieCtor };
    return {
      verno: dbMod.db.verno,
      stores: dbMod.db.tables.map(t => t.name).sort(),
      dexieResolved: typeof DexieCtor === 'function',
      hasService: typeof svc.narrativeService?.createPlan === 'function',
    };
  })()`);

  record(
    '数据库 schema 升级到 v3 并新增 narrativePlans 表',
    boot.verno >= 3 &&
      ['characters', 'narrativePlans', 'projects', 'worlds'].every((t) => boot.stores.includes(t)),
    `verno=${boot.verno} stores=[${boot.stores}]`,
  );
  record(
    'narrativeService 已从服务层导出且可调用',
    boot.hasService === true && boot.dexieResolved === true,
    `service=${boot.hasService} dexie=${boot.dexieResolved}`,
  );

  // ---------- v2 -> v3 migration: seed a v2-era DB, reopen at v3 ----------
  const migration = await cdp.eval(`(async () => {
    const { db, Dexie } = window.__p2b;

    db.close();
    await Dexie.delete(db.name);

    // Simulate the schema state shipped in P2-A (v2): projects/worlds/characters.
    const legacy = new Dexie(db.name);
    legacy.version(1).stores({ projects: '&id, title, status, createdAt, updatedAt' });
    legacy.version(2).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
    });
    await legacy.open();
    await legacy.table('projects').add({
      id: 'proj_v2_legacy', title: 'V2 Era Project', description: 'pre P2-B',
      status: 'writing', genre: ['Mystery'], tags: ['legacy'],
      settings: { author: 'V2 Author' }, createdAt: 1700000000000, updatedAt: 1700000005000,
    });
    await legacy.table('worlds').add({
      id: 'world_v2_legacy', projectId: 'proj_v2_legacy', title: 'Legacy World',
      overview: 'from v2', sections: [], themes: [], settings: {},
      createdAt: 1700000000000, updatedAt: 1700000000000,
    });
    await legacy.table('characters').add({
      id: 'char_v2_legacy', projectId: 'proj_v2_legacy', name: 'Legacy Character',
      summary: '', background: '', personality: '', motivation: '', appearance: '',
      role: 'supporting', status: 'active', tags: [],
      createdAt: 1700000000000, updatedAt: 1700000000000,
    });
    const v2Tables = legacy.tables.map(t => t.name).sort();
    legacy.close();

    // Reopen with the REAL v3 app schema.
    await db.open();
    return {
      v2Tables,
      v3Tables: db.tables.map(t => t.name).sort(),
      verno: db.verno,
      project: await db.projects.get('proj_v2_legacy'),
      world: await db.worlds.get('world_v2_legacy'),
      character: await db.characters.get('char_v2_legacy'),
    };
  })()`);

  record(
    'v2 基线仅含 projects/worlds/characters',
    JSON.stringify(migration.v2Tables) === JSON.stringify(['characters', 'projects', 'worlds']),
    `[${migration.v2Tables}]`,
  );
  record(
    'v2 → v3 迁移后新增 narrativePlans 表',
    // `v3Tables` is the table list after reopening with the CURRENT app schema.
    // P2-B introduced narrativePlans at v3; later phases only ADD tables, so we
    // assert every v3 table is present rather than that v3 is the latest.
    migration.verno >= 3 &&
      ['characters', 'narrativePlans', 'projects', 'worlds'].every((t) =>
        migration.v3Tables.includes(t),
      ),
    `verno=${migration.verno} tables=[${migration.v3Tables}]`,
  );
  record(
    '迁移后原有 P1/P2-A 数据完整保留（项目/世界观/角色）',
    migration.project?.title === 'V2 Era Project' &&
      migration.project?.createdAt === 1700000000000 &&
      migration.world?.title === 'Legacy World' &&
      migration.character?.name === 'Legacy Character',
    `project=${migration.project?.title} world=${migration.world?.title} char=${migration.character?.name}`,
  );

  // ---------- Narrative plan CRUD + isolation + cascade ----------
  const flow = await cdp.eval(`(async () => {
    const { projectService, narrativeService, worldService, characterService, db } = window.__p2b;
    const out = {};

    const pA = await projectService.createProject({ title: 'Alpha Narrative' });
    const pB = await projectService.createProject({ title: 'Beta Narrative' });
    out.projects = [pA.id, pB.id];

    // No plan yet.
    out.initialEmpty = (await narrativeService.getPlan(pA.id)) === null;
    out.hasPlanInitially = await narrativeService.hasPlan(pA.id);

    // CREATE with defaults only.
    const d = await narrativeService.createPlan(pA.id);
    out.defaults = {
      structure: d.structure, status: d.status, beats: d.beats.length,
      emptyTexts: [d.logline, d.theme, d.premise, d.centralConflict, d.stakes, d.ending].every(t => t === ''),
      idPrefixed: d.id.startsWith('narr_'),
      projectId: d.projectId === pA.id,
      timestampsEqual: d.createdAt === d.updatedAt,
    };

    // One plan per project.
    let dup = null;
    try { await narrativeService.createPlan(pA.id); }
    catch (e) { dup = { name: e.name, message: e.message }; }
    out.duplicate = dup;

    // UPDATE: text, structure, status, null-clearing, beats with kept ids + new id.
    const beatsInput = [
      { title: 'Opening Image', description: 'The world before.', position: 0 },
      { title: 'Inciting Incident', description: 'The call.', position: 25 },
    ];
    const u1 = await narrativeService.updatePlan(pA.id, {
      logline: 'A keeper hunts the sea for her lost brother.',
      theme: 'Memory and the tide.',
      premise: 'A lighthouse keeper receives a letter from the dead.',
      centralConflict: 'The sea takes more than it returns.',
      stakes: 'Her brother, then her town.',
      ending: 'She chooses the living over the ghost.',
      structure: 'save-the-cat',
      status: 'in-progress',
      beats: beatsInput,
      motifs: ['tides', 'lighthouses'],
    });
    const beatIds = u1.beats.map(b => b.id);
    out.created = {
      logline: u1.logline, structure: u1.structure, status: u1.status,
      beats: u1.beats.length,
      beatIdPrefix: beatIds.every(id => id.startsWith('beat_')),
      beatIdsStableAfterCreate: beatIds.length === 2,
      motifs: u1.motifs,
      idUnchanged: u1.id === d.id,
      createdAtUnchanged: u1.createdAt === d.createdAt,
      projectIdUnchanged: u1.projectId === pA.id,
      updatedAtAdvanced: u1.updatedAt >= d.updatedAt,
    };

    // Partly: keep existing ids, add a new beat, reorder, clear 'stakes' via null,
    // and leave 'theme' untouched (omitted).
    const u2 = await narrativeService.updatePlan(pA.id, {
      beats: [
        { id: beatIds[1], title: 'Inciting Incident', description: 'The call.', position: 20 },
        { title: 'Break into Two', description: 'Commit.', position: 55 },
        { id: beatIds[0], title: 'Opening Image', description: 'The world before.', position: 0 },
      ],
      stakes: null,
    });
    out.partial = {
      beatIds: u2.beats.map(b => b.id),
      keptIds: u2.beats[0].id === beatIds[1] && u2.beats[2].id === beatIds[0],
      newBeatGenerated: u2.beats[1].id.startsWith('beat_') && !beatIds.includes(u2.beats[1].id),
      orderTitles: u2.beats.map(b => b.title),
      stakesCleared: u2.stakes === '',
      themeKept: u2.theme === 'Memory and the tide.',
      loglineKept: u2.logline.startsWith('A keeper'),
      structureKept: u2.structure === 'save-the-cat',
    };

    // Position clamping (out of range) is normalised by the Service.
    const u3 = await narrativeService.updatePlan(pA.id, {
      beats: [{ title: 'Extreme', description: '', position: 250 }],
    });
    out.clamped = u3.beats[0].position;

    // ISOLATION: project B is independent.
    const b = await narrativeService.createPlan(pB.id, { logline: 'Beta only.' });
    out.isolation = {
      aLogline: (await narrativeService.getPlan(pA.id)).logline,
      bLogline: (await narrativeService.getPlan(pB.id)).logline,
      differ: b.id !== d.id && b.projectId === pB.id,
    };

    // Cross-project update is impossible: update targets by projectId and B's plan
    // is its own record, so A's beats never appear in B.
    out.crossIsolation = {
      bBeats: (await narrativeService.getPlan(pB.id)).beats.length,
      aBeats: (await narrativeService.getPlan(pA.id)).beats.length,
    };

    // UPDATE of a project with no plan -> NarrativeNotFoundError.
    const pC = await projectService.createProject({ title: 'No Plan Project' });
    let notFound = null;
    try { await narrativeService.updatePlan(pC.id, { status: 'locked' }); }
    catch (e) { notFound = { name: e.name, message: e.message }; }
    out.notFound = notFound;
    await projectService.deleteProject(pC.id);

    // SCHEMA GUARD: beat title too long / bad structure rejected before write.
    let badStructure = null;
    try {
      await narrativeService.updatePlan(pA.id, { structure: 'not-a-structure' });
    } catch (e) { badStructure = { name: e.name, message: e.message }; }
    out.badStructure = badStructure;

    let longBeat = null;
    try {
      await narrativeService.updatePlan(pA.id, {
        beats: [{ title: 'x'.repeat(121), description: '', position: 1 }],
      });
    } catch (e) { longBeat = { name: e.name }; }
    out.longBeat = longBeat;

    // The rejected writes must NOT have modified the stored plan.
    const afterRejects = await narrativeService.getPlan(pA.id);
    out.afterRejects = {
      structure: afterRejects.structure,
      beatTitles: afterRejects.beats.map(b => b.title),
    };

    // DELETE a plan.
    await narrativeService.deletePlan(pB.id);
    out.deletedB = await narrativeService.getPlan(pB.id);
    // Idempotent delete.
    await narrativeService.deletePlan(pB.id);
    out.idempotentDelete = (await narrativeService.getPlan(pB.id)) === null;

    // Recreate after delete.
    const b2 = await narrativeService.createPlan(pB.id, { logline: 'Rebuilt plan.' });
    out.recreated = b2.logline;

    // CASCADE: deleting a project removes its plan + world + characters.
    await worldService.createWorld(pA.id, { title: 'Will Vanish' });
    await characterService.createCharacter(pA.id, { name: 'Will Vanish Too' });
    await projectService.deleteProject(pA.id);
    out.cascade = {
      rawPlans: await db.narrativePlans.where('projectId').equals(pA.id).count(),
      rawWorlds: await db.worlds.where('projectId').equals(pA.id).count(),
      rawChars: await db.characters.where('projectId').equals(pA.id).count(),
      projectGone: (await db.projects.get(pA.id)) === undefined,
    };
    out.cascadeIsolation = {
      bPlanExists: (await db.narrativePlans.where('projectId').equals(pB.id).count()) === 1,
      bProjectExists: (await db.projects.get(pB.id)) !== undefined,
    };

    // P2-A / P1 regression while we are here.
    const pR = await projectService.createProject({ title: 'Regression P1' });
    await worldService.createWorld(pR.id, { title: 'Regression World' });
    await characterService.createCharacter(pR.id, { name: 'Regression Char' });
    out.regression = {
      world: (await worldService.getWorld(pR.id)).title,
      chars: (await characterService.listCharacters(pR.id)).length,
      planEmpty: (await narrativeService.getPlan(pR.id)) === null,
    };
    await projectService.deleteProject(pR.id);

    await projectService.deleteProject(pB.id);
    out.remaining = (await projectService.listProjects()).length;

    return out;
  })()`);

  record(
    '新建项目尚无叙事规划（isEmpty 与 hasPlan 一致）',
    flow.initialEmpty === true && flow.hasPlanInitially === false,
    `empty=${flow.initialEmpty}`,
  );
  record(
    '创建叙事规划（默认 three-act / draft / 空文本 / 0 节拍）',
    flow.defaults?.structure === 'three-act' &&
      flow.defaults?.status === 'draft' &&
      flow.defaults?.beats === 0 &&
      flow.defaults?.emptyTexts === true &&
      flow.defaults?.idPrefixed === true &&
      flow.defaults?.projectId === true &&
      flow.defaults?.timestampsEqual === true,
    JSON.stringify(flow.defaults),
  );
  record(
    '一个项目仅允许一个叙事规划（重复创建被拒）',
    flow.duplicate?.name === 'NarrativeAlreadyExistsError' &&
      flow.duplicate?.message?.includes('already has a narrative plan'),
    `${flow.duplicate?.name}: ${flow.duplicate?.message}`,
  );
  record(
    '编辑叙事规划（文本/结构/状态/节拍/母题，保留 id/createdAt/projectId）',
    flow.created?.logline === 'A keeper hunts the sea for her lost brother.' &&
      flow.created?.structure === 'save-the-cat' &&
      flow.created?.status === 'in-progress' &&
      flow.created?.beats === 2 &&
      flow.created?.beatIdPrefix === true &&
      flow.created?.motifs?.join(',') === 'tides,lighthouses' &&
      flow.created?.idUnchanged === true &&
      flow.created?.createdAtUnchanged === true &&
      flow.created?.projectIdUnchanged === true &&
      flow.created?.updatedAtAdvanced === true,
    JSON.stringify(flow.created),
  );
  record(
    '部分更新：保留既有节拍 id、为新节拍生成 id、null 清空字段、省略字段不变',
    flow.partial?.keptIds === true &&
      flow.partial?.newBeatGenerated === true &&
      flow.partial?.orderTitles?.join('|') === 'Inciting Incident|Break into Two|Opening Image' &&
      flow.partial?.stakesCleared === true &&
      flow.partial?.themeKept === true &&
      flow.partial?.loglineKept === true &&
      flow.partial?.structureKept === true,
    JSON.stringify(flow.partial),
  );
  record('节拍位置越界被规整到 0–100', flow.clamped === 100, `position=${flow.clamped}`);
  record(
    '不同项目的叙事规划互相隔离',
    flow.isolation?.aLogline?.startsWith('A keeper') &&
      flow.isolation?.bLogline === 'Beta only.' &&
      flow.isolation?.differ === true &&
      flow.crossIsolation?.aBeats === 1 &&
      flow.crossIsolation?.bBeats === 0,
    `A="${flow.isolation?.aLogline?.slice(0, 20)}…" B="${flow.isolation?.bLogline}" aBeats=${flow.crossIsolation?.aBeats} bBeats=${flow.crossIsolation?.bBeats}`,
  );
  record(
    '更新无规划的项目抛出 NarrativeNotFoundError',
    flow.notFound?.name === 'NarrativeNotFoundError' &&
      flow.notFound?.message?.includes('has no narrative plan'),
    `${flow.notFound?.name}: ${flow.notFound?.message}`,
  );
  record(
    'Zod 拦截非法枚举与超长节拍标题，且不落库',
    flow.badStructure?.name === 'ProjectValidationError' &&
      flow.longBeat?.name === 'ProjectValidationError' &&
      flow.afterRejects?.structure === 'save-the-cat' &&
      flow.afterRejects?.beatTitles?.length === 1,
    `badStructure=${flow.badStructure?.name} longBeat=${flow.longBeat?.name} stored=${flow.afterRejects?.structure}`,
  );
  record(
    '删除叙事规划（幂等），并可重新创建',
    flow.deletedB === null && flow.idempotentDelete === true && flow.recreated === 'Rebuilt plan.',
    `recreated="${flow.recreated}"`,
  );
  record(
    '删除项目级联清理叙事规划/世界观/角色（无孤儿记录）',
    flow.cascade?.rawPlans === 0 &&
      flow.cascade?.rawWorlds === 0 &&
      flow.cascade?.rawChars === 0 &&
      flow.cascade?.projectGone === true,
    JSON.stringify(flow.cascade),
  );
  record(
    '级联删除不影响其他项目',
    flow.cascadeIsolation?.bPlanExists === true && flow.cascadeIsolation?.bProjectExists === true,
    JSON.stringify(flow.cascadeIsolation),
  );
  record(
    'P1/P2-A 回归：世界观与角色 CRUD 正常，叙事规划独立为空',
    flow.regression?.world === 'Regression World' &&
      flow.regression?.chars === 1 &&
      flow.regression?.planEmpty === true,
    JSON.stringify(flow.regression),
  );

  // ---------- Persistence across a real page reload ----------
  const persistence = await cdp.eval(`(async () => {
    const { projectService, narrativeService } = window.__p2b;
    const p = await projectService.createProject({ title: 'Narrative Persistence Probe' });
    await narrativeService.createPlan(p.id, { logline: 'Survives reload.', structure: 'seven-point' });
    await narrativeService.updatePlan(p.id, {
      status: 'locked',
      beats: [{ title: 'Hook', description: 'Open strong.', position: 0 }],
    });
    localStorage.setItem('n87-p2b-probe-project', p.id);
    return { id: p.id };
  })()`);

  await cdp.send('Page.reload');
  await sleep(3500);

  const afterReload = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const id = localStorage.getItem('n87-p2b-probe-project');
    const plan = await svc.narrativeService.getPlan(id);
    const loadedPlanId = plan ? plan.id : null;
    const snapshot = plan
      ? { logline: plan.logline, structure: plan.structure, status: plan.status, beats: plan.beats.length, beatTitle: plan.beats[0]?.title }
      : null;
    await svc.projectService.deleteProject(id);
    const db = dbMod.db;
    return {
      loadedPlanId,
      snapshot,
      afterCleanup: {
        plans: await db.narrativePlans.where('projectId').equals(id).count(),
        project: (await db.projects.get(id)) === undefined ? 0 : 1,
      },
    };
  })()`);

  record(
    '刷新页面后叙事规划恢复（文本/结构/状态/节拍仍在）',
    afterReload.loadedPlanId !== null &&
      afterReload.snapshot?.logline === 'Survives reload.' &&
      afterReload.snapshot?.structure === 'seven-point' &&
      afterReload.snapshot?.status === 'locked' &&
      afterReload.snapshot?.beats === 1 &&
      afterReload.snapshot?.beatTitle === 'Hook',
    `${JSON.stringify(afterReload.snapshot)} id=${afterReload.loadedPlanId}`,
  );
  record(
    '清理后无孤儿记录',
    afterReload.afterCleanup.plans === 0 && afterReload.afterCleanup.project === 0,
    JSON.stringify(afterReload.afterCleanup),
  );

  record('运行期无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  teardown();

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ SUMMARY ================');
  console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    teardown();
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    teardown();
    process.exit(1);
  });
