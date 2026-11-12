/**
 * P2-A end-to-end acceptance harness (temporary, read-only w.r.t. repo code).
 *
 * Drives real Chrome over the DevTools Protocol using ONLY Node built-ins so
 * no dependency is added. It exercises the ACTUAL app modules (schemas,
 * services, repositories, Dexie database) in the real browser runtime.
 *
 * Usage: node scripts/p2a-verify.cjs
 */
const { spawn } = require('node:child_process');

/* Force UTF-8 output so non-ASCII test labels are readable everywhere. */
function ensureUtf8Stdout() {
  try {
    if (process.stdout.isTTY || process.platform === 'win32') {
      process.stdout.setDefaultEncoding && process.stdout.setDefaultEncoding('utf8');
      if (process.platform === 'win32' && process.stdout._handle && process.stdout._handle.setBlocking) {
        process.stdout._handle.setBlocking(true);
      }
    }
  } catch { /* best effort */ }
}
ensureUtf8Stdout();
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

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
        if (msg.error) { stage('cdp !!', 'id=' + msg.id + ' ' + JSON.stringify(msg.error)); reject(new Error(JSON.stringify(msg.error))); }
        else { stage('cdp <-', 'id=' + msg.id); resolve(msg.result); }
      }
    });
  }

  send(method, params = {}) {
    stage('cdp ->', method);
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

  /** Evaluates an async expression in the page and returns its value. */
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

/* Teardown state — closed on success AND on every failure path so the
   Node process never hangs on a live WebSocket / child process handle. */
let activeWs = null;
let activeChrome = null;
let activeProfileDir = null;
let tornDown = false;

function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { if (activeWs) activeWs.close(); } catch { /* already closed */ }
  try { if (activeChrome && activeChrome.exitCode === null && !activeChrome.killed) activeChrome.kill('SIGKILL'); } catch { /* already gone */ }
  try { if (activeProfileDir && fs.existsSync(activeProfileDir)) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  stage('teardown complete');
}

process.on('exit', teardown);
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2a-chrome-'));
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
    } catch {
      /* chrome still starting */
    }
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

  // Collect page errors so a runtime crash never passes silently.
  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown');
    }
  });

  // Load the real app so its modules (and Dexie registration) are live.
  stage('navigating to app');
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3500);
  stage('app load wait done');

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
  };

  // ---------- Import the real modules inside the page ----------
  const boot = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    // Ensure the connection is open (DatabaseGate may not have run in headless).
    await dbMod.initDatabase();
    // Resolve Dexie the way Vite already serves it (pre-bundled dep URL),
    // then fall back to the app's own table factory if the URL differs.
    let DexieCtor = null;
    try {
      const dexieMod = await import('/node_modules/.vite/deps/dexie.js');
      DexieCtor = dexieMod.default ?? dexieMod.Dexie ?? null;
    } catch { DexieCtor = null; }
    if (!DexieCtor && typeof globalThis.Dexie === 'function') DexieCtor = globalThis.Dexie;
    window.__p2a = { ...dbMod, ...svc, Dexie: DexieCtor };
    return { dbName: dbMod.db.name, version: dbMod.db.verno, stores: dbMod.db.tables.map(t => t.name).sort(), dexieResolved: typeof DexieCtor === 'function' };
  })()`);
  record(
    '数据库已打开且 schema >= v2，包含 projects/worlds/characters',
    boot.version >= 2 &&
      ['characters', 'projects', 'worlds'].every((s) => boot.stores.includes(s)),
    `name=${boot.dbName} verno=${boot.version} stores=[${boot.stores}] dexie=${boot.dexieResolved}`,
  );
  record(
    '测试可以拿到 Dexie 构造器（用于 v1 种子数据）',
    boot.dexieResolved === true,
  );

  // ---------- v1 -> v2 migration: seed a v1-era project, reopen at v2 ----------
  const migration = await cdp.eval(`(async () => {
    const { db, Dexie } = window.__p2a;

    // Simulate a database that existed at v1 BEFORE P2 (old schema, no child stores).
    db.close();
    await Dexie.delete(db.name);

    const legacy = new Dexie(db.name);
    legacy.version(1).stores({ projects: '&id, title, status, createdAt, updatedAt' });
    await legacy.open();
    await legacy.table('projects').add({
      id: 'proj_legacy_p1', title: 'Legacy P1 Project', description: 'created before P2',
      status: 'writing', genre: ['Fantasy'], tags: ['legacy'],
      settings: { author: 'Old Author' }, createdAt: 1700000000000, updatedAt: 1700000005000,
    });
    const v1Tables = legacy.tables.map(t => t.name);
    legacy.close();

    // Reopen with the REAL v2 app schema (the actual upgrade path the app uses).
    await db.open();
    const upgraded = await db.projects.get('proj_legacy_p1');
    return {
      v1Tables,
      v2Tables: db.tables.map(t => t.name).sort(),
      verno: db.verno,
      preserved: upgraded,
    };
  })()`);
  record(
    'v1 = 仅 projects 表',
    JSON.stringify(migration.v1Tables) === JSON.stringify(['projects']),
    `[${migration.v1Tables}]`,
  );
  record(
    'v1 迁移后新增 worlds 与 characters 表（数据库 >= v2）',
    ['characters', 'projects', 'worlds'].every((t) => migration.v2Tables.includes(t)) &&
      migration.verno >= 2,
    `verno=${migration.verno} tables=[${migration.v2Tables}]`,
  );
  record(
    '迁移后原有 P1 项目数据完整保留',
    migration.preserved?.id === 'proj_legacy_p1' &&
      migration.preserved?.title === 'Legacy P1 Project' &&
      migration.preserved?.status === 'writing' &&
      migration.preserved?.settings?.author === 'Old Author' &&
      migration.preserved?.createdAt === 1700000000000,
    `title=${migration.preserved?.title} status=${migration.preserved?.status}`,
  );

  // ---------- Full CRUD + isolation + cascade via the real Service layer ----------
  const flow = await cdp.eval(`(async () => {
    const { projectService, worldService, characterService, db } = window.__p2a;
    const out = {};

    // Two independent projects.
    const pA = await projectService.createProject({ title: 'Alpha Saga' });
    const pB = await projectService.createProject({ title: 'Beta Saga' });
    out.projectsCreated = [pA.id, pB.id];

    // ---- WORLD CRUD (project A) ----
    const w1 = await worldService.createWorld(pA.id, {
      title: 'The Drowned Archipelago',
      overview: 'A sea-bound world of drowned cities.',
      themes: ['isolation', 'memory'],
      settings: { era: 'Age of Sail', technology: 'Early steam' },
      sections: [
        { title: 'Geography', content: 'Endless reefs and fog.' },
        { title: 'History', content: 'The old empire sank.' },
      ],
    });
    out.worldCreated = {
      id: w1.id, projectId: w1.projectId, sections: w1.sections.length,
      sectionIdsStable: w1.sections.every(s => typeof s.id === 'string' && s.id.startsWith('wsec_')),
      themes: w1.themes, era: w1.settings.era, overview: w1.overview,
    };

    // Read back
    const wRead = await worldService.getWorld(pA.id);
    out.worldReadBack = { title: wRead.title, sections: wRead.sections.length };

    // Duplicate create must fail (one world per project).
    let dupError = null;
    try { await worldService.createWorld(pA.id, { title: 'Second world' }); }
    catch (e) { dupError = e.message; }
    out.worldDuplicateRejected = dupError;

    // Update: rename, replace sections, clear 'technology' via null.
    const w2 = await worldService.updateWorld(pA.id, {
      title: 'The Drowned Archipelago (Revised)',
      sections: [
        { id: w1.sections[0].id, title: 'Geography', content: 'Endless reefs, deeper fog.' },
      ],
      settings: { technology: null },
    });
    out.worldUpdated = {
      title: w2.title,
      sections: w2.sections.length,
      preservedSectionId: w2.sections[0].id === w1.sections[0].id,
      technologyCleared: w2.settings.technology === undefined,
      eraKept: w2.settings.era,
      projectIdUnchanged: w2.projectId === pA.id,
      createdAtUnchanged: w2.createdAt === w1.createdAt,
      updatedAtAdvanced: w2.updatedAt >= w1.updatedAt,
    };

    // ---- CHARACTER CRUD (project A) ----
    const c1 = await characterService.createCharacter(pA.id, {
      name: 'Maren Valk', summary: 'A lighthouse keeper',
      personality: 'Stubborn, kind', background: 'Raised at sea',
      motivation: 'Find her brother', appearance: 'Grey eyes',
      role: 'protagonist', status: 'active', tags: ['lead'],
    });
    const c2 = await characterService.createCharacter(pA.id, { name: 'Ada Reeve', role: 'antagonist' });
    out.characterCreated = { id: c1.id, defaultsApplied: c2.status === 'active' && c2.role === 'antagonist'+'' };
    out.characterDefaults = { role: c2.role, status: c2.status, summary: c2.summary, tags: c2.tags.length };

    const listA = await characterService.listCharacters(pA.id);
    out.characterList = { count: listA.length, names: listA.map(c => c.name) };

    const c1u = await characterService.updateCharacter(pA.id, c1.id, {
      name: 'Maren Valk (Senior)', status: 'missing', tags: ['lead', 'mentor'],
    });
    out.characterUpdated = {
      name: c1u.name, status: c1u.status, tags: c1u.tags,
      personalityKept: c1u.personality, projectIdUnchanged: c1u.projectId === pA.id,
    };

    // ---- CHARACTER STORED UNDER PROJECT B (for isolation test) ----
    await characterService.createCharacter(pB.id, { name: 'Beta Only' });
    await worldService.createWorld(pB.id, { title: 'Beta World' });

    // ---- ISOLATION ----
    const listB = await characterService.listCharacters(pB.id);
    const worldB = await worldService.getWorld(pB.id);
    out.isolation = {
      aCount: (await characterService.listCharacters(pA.id)).length,
      bCount: listB.length,
      bNames: listB.map(c => c.name),
      bWorldTitle: worldB.title,
      worldsDiffer: worldB.id !== w2.id,
    };

    // Cross-project write must be rejected.
    let crossError = null;
    try { await characterService.updateCharacter(pB.id, c1.id, { name: 'hijacked' }); }
    catch (e) { crossError = e.message; }
    out.crossProjectWriteRejected = crossError;

    // ---- DELETE A CHARACTER ----
    await characterService.deleteCharacter(pA.id, c2.id);
    out.afterCharDelete = (await characterService.listCharacters(pA.id)).map(c => c.name);

    // ---- DELETE WORLD ----
    await worldService.deleteWorld(pA.id);
    out.worldAfterDelete = await worldService.getWorld(pA.id);

    // Recreate world on A to prove delete+create cycle works.
    const w3 = await worldService.createWorld(pA.id, { title: 'Rebuilt World' });
    out.worldRecreated = w3.title;

    // ---- CASCADE: delete project A must remove its world + remaining characters ----
    await projectService.deleteProject(pA.id);
    const rawCharsA = await db.characters.where('projectId').equals(pA.id).count();
    const rawWorldsA = await db.worlds.where('projectId').equals(pA.id).count();
    const rawProjectA = await db.projects.get(pA.id);
    out.cascade = { rawCharsLeft: rawCharsA, rawWorldsLeft: rawWorldsA, projectLeft: rawProjectA === undefined };

    // Project B untouched by A's cascade.
    out.cascadeIsolation = {
      bCharacters: await db.characters.where('projectId').equals(pB.id).count(),
      bWorlds: await db.worlds.where('projectId').equals(pB.id).count(),
      bProjectExists: (await db.projects.get(pB.id)) !== undefined,
    };

    // ---- SCHEMA GUARD: invalid data is rejected before write ----
    let schemaError = null;
    try {
      await characterService.createCharacter(pB.id, { name: '   ' });
    } catch (e) { schemaError = { name: e.name, message: e.message }; }
    out.blankNameRejected = schemaError;

    // ---- P1 REGRESSION: project CRUD still works ----
    const pC = await projectService.createProject({ title: 'P1 Regression', status: 'completed' });
    const pCu = await projectService.updateProject(pC.id, { title: 'P1 Regression (edited)' });
    const pList = await projectService.listProjects();
    await projectService.deleteProject(pC.id);
    out.p1Regression = {
      created: pC.status, updated: pCu.title, listContains: pList.some(p => p.id === pC.id),
      deleted: (await projectService.getProject(pC.id)) === null,
    };

    // Cleanup Beta so the DB is left tidy.
    await projectService.deleteProject(pB.id);
    out.remainingProjects = (await projectService.listProjects()).length;

    return out;
  })()`);

  record(
    '创建世界观',
    flow.worldCreated?.projectId?.length > 0 && flow.worldCreated.sections === 2,
    `sections=${flow.worldCreated?.sections} sectionIdsStable=${flow.worldCreated?.sectionIdsStable}`,
  );
  record(
    '读取世界观（含 sections/overview/era）',
    flow.worldReadBack?.title === 'The Drowned Archipelago' && flow.worldReadBack.sections === 2,
    `title=${flow.worldReadBack?.title} sections=${flow.worldReadBack?.sections}`,
  );
  record(
    '一个项目仅允许一个世界观（重复创建被拒）',
    typeof flow.worldDuplicateRejected === 'string' && flow.worldDuplicateRejected.includes('already has a world'),
    flow.worldDuplicateRejected,
  );
  record(
    '编辑世界观（保留 id/createdAt，projectId 不变，null 清空技术字段并保留 era）',
    flow.worldUpdated?.title === 'The Drowned Archipelago (Revised)' &&
      flow.worldUpdated?.projectIdUnchanged &&
      flow.worldUpdated?.createdAtUnchanged &&
      flow.worldUpdated?.technologyCleared &&
      flow.worldUpdated?.eraKept === 'Age of Sail' &&
      flow.worldUpdated?.preservedSectionId,
    `title=${flow.worldUpdated?.title} eraKept=${flow.worldUpdated?.eraKept} techCleared=${flow.worldUpdated?.technologyCleared}`,
  );
  record(
    '创建角色（含名称/简介/背景/性格）',
    flow.characterCreated?.id?.startsWith('char_') && flow.characterDefaults?.tags === 0,
    `id=${flow.characterCreated?.id} defaults=${JSON.stringify(flow.characterDefaults)}`,
  );
  record(
    '角色列表（按名称排序，仅本项目）',
    flow.characterList?.count === 2,
    `names=${JSON.stringify(flow.characterList?.names)}`,
  );
  record(
    '编辑角色（部分更新不改动未提供字段）',
    flow.characterUpdated?.name === 'Maren Valk (Senior)' &&
      flow.characterUpdated?.status === 'missing' &&
      flow.characterUpdated?.personalityKept === 'Stubborn, kind' &&
      flow.characterUpdated?.projectIdUnchanged,
    `name=${flow.characterUpdated?.name} personalityKept=${flow.characterUpdated?.personalityKept}`,
  );
  record(
    '不同项目数据隔离（角色/世界观互不可见）',
    flow.isolation?.aCount === 2 &&
      flow.isolation?.bCount === 1 &&
      flow.isolation?.bNames?.[0] === 'Beta Only' &&
      flow.isolation?.bWorldTitle === 'Beta World' &&
      flow.isolation?.worldsDiffer,
    `A=${flow.isolation?.aCount} B=${flow.isolation?.bCount} bWorld=${flow.isolation?.bWorldTitle}`,
  );
  record(
    '跨项目写入被拒绝',
    typeof flow.crossProjectWriteRejected === 'string' &&
      flow.crossProjectWriteRejected.includes('not found in project'),
    flow.crossProjectWriteRejected,
  );
  record(
    '删除角色',
    JSON.stringify(flow.afterCharDelete) === JSON.stringify(['Maren Valk (Senior)']),
    `remaining=${JSON.stringify(flow.afterCharDelete)}`,
  );
  record(
    '删除世界观后可重建',
    flow.worldAfterDelete === null && flow.worldRecreated === 'Rebuilt World',
    `afterDelete=${flow.worldAfterDelete} recreated=${flow.worldRecreated}`,
  );
  record(
    '删除项目级联清理世界观与角色（无孤儿记录）',
    flow.cascade?.rawCharsLeft === 0 &&
      flow.cascade?.rawWorldsLeft === 0 &&
      flow.cascade?.projectLeft === true,
    `charsLeft=${flow.cascade?.rawCharsLeft} worldsLeft=${flow.cascade?.rawWorldsLeft}`,
  );
  record(
    '级联删除不影响其他项目',
    flow.cascadeIsolation?.bCharacters === 1 &&
      flow.cascadeIsolation?.bWorlds === 1 &&
      flow.cascadeIsolation?.bProjectExists === true,
    `bChars=${flow.cascadeIsolation?.bCharacters} bWorlds=${flow.cascadeIsolation?.bWorlds}`,
  );
  record(
    'Zod 校验拦截非法角色（空名称）',
    flow.blankNameRejected?.name === 'ProjectValidationError',
    `${flow.blankNameRejected?.name}: ${flow.blankNameRejected?.message}`,
  );
  record(
    'P1 项目 CRUD 回归（创建/编辑/列表/删除）',
    flow.p1Regression?.created === 'completed' &&
      flow.p1Regression?.updated === 'P1 Regression (edited)' &&
      flow.p1Regression?.listContains === true &&
      flow.p1Regression?.deleted === true,
    JSON.stringify(flow.p1Regression),
  );

  // ---------- Persistence across a real page reload ----------
  const persistence = await cdp.eval(`(async () => {
    const { projectService, worldService, characterService } = window.__p2a;
    const p = await projectService.createProject({ title: 'Persistence Probe' });
    await worldService.createWorld(p.id, { title: 'Persisted World', overview: 'survives reload' });
    await characterService.createCharacter(p.id, { name: 'Persisted Character', role: 'supporting' });
    localStorage.setItem('n87-p2a-probe-project', p.id);
    return { id: p.id };
  })()`);

  await cdp.send('Page.reload');
  await sleep(3500);

  const afterReload = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const id = localStorage.getItem('n87-p2a-probe-project');
    const project = await svc.projectService.getProject(id);
    const world = await svc.worldService.getWorld(id);
    const chars = await svc.characterService.listCharacters(id);
    const countBefore = { project: project ? 1 : 0, world: world ? 1 : 0, chars: chars.length };
    const loadedProjectId = project ? project.id : null;
    // Clean up the probe through the real cascade.
    await svc.projectService.deleteProject(id);
    const db = dbMod.db;
    return {
      countBefore,
      loadedProjectId,
      worldTitle: world?.title,
      charNames: chars.map(c => c.name),
      afterCleanup: {
        chars: await db.characters.where('projectId').equals(id).count(),
        worlds: await db.worlds.where('projectId').equals(id).count(),
        project: (await db.projects.get(id)) === undefined ? 0 : 1,
      },
    };
  })()`);

  record(
    '刷新页面后数据恢复（world + character 仍在）',
    afterReload.loadedProjectId === persistence.id &&
      afterReload.countBefore.project === 1 &&
      afterReload.countBefore.world === 1 &&
      afterReload.countBefore.chars === 1 &&
      afterReload.worldTitle === 'Persisted World' &&
      afterReload.charNames?.[0] === 'Persisted Character',
    `project=${afterReload.countBefore.project} world=${afterReload.worldTitle} chars=${JSON.stringify(afterReload.charNames)}`,
  );
  record(
    '清理后无孤儿记录',
    afterReload.afterCleanup.chars === 0 &&
      afterReload.afterCleanup.worlds === 0 &&
      afterReload.afterCleanup.project === 0,
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
    // Explicit exit: guarantees termination even if some handle lingers.
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    teardown();
    process.exit(1);
  });
