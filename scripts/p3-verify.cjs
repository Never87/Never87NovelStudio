/**
 * P3 (narrative planning) end-to-end acceptance harness.
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
const PORT = 9336;

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-chrome-'));
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

  // ---------- Boot ----------
  const boot = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    let DexieCtor = null;
    try {
      const m = await import('/node_modules/.vite/deps/dexie.js');
      DexieCtor = m.default ?? m.Dexie ?? null;
    } catch { DexieCtor = null; }
    window.__p3 = { ...dbMod, ...svc, Dexie: DexieCtor };
    return {
      verno: dbMod.db.verno,
      stores: dbMod.db.tables.map(t => t.name).sort(),
      dexieResolved: typeof DexieCtor === 'function',
      hasOutline: typeof svc.outlineService?.createVolume === 'function',
      hasScene: typeof svc.sceneService?.createScene === 'function',
    };
  })()`);

  const EXPECTED = ['chapters', 'characters', 'narrativePlans', 'projects', 'scenes', 'volumes', 'worlds'];

  record(
    '数据库升级到 v4 并新增 volumes/chapters/scenes 表',
    boot.verno === 4 && JSON.stringify(boot.stores) === JSON.stringify(EXPECTED),
    `verno=${boot.verno} stores=[${boot.stores}]`,
  );
  record(
    'outlineService / sceneService 已导出且可调用',
    boot.hasOutline && boot.hasScene && boot.dexieResolved,
    `outline=${boot.hasOutline} scene=${boot.hasScene}`,
  );

  // ---------- v3 -> v4 migration preserves ALL earlier data ----------
  const migration = await cdp.eval(`(async () => {
    const { db, Dexie } = window.__p3;
    db.close();
    await Dexie.delete(db.name);

    // Recreate the exact P2-B schema state (v1..v3).
    const legacy = new Dexie(db.name);
    legacy.version(1).stores({ projects: '&id, title, status, createdAt, updatedAt' });
    legacy.version(2).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
    });
    legacy.version(3).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
    });
    await legacy.open();

    await legacy.table('projects').add({
      id: 'proj_v3', title: 'V3 Project', description: 'pre P3', status: 'writing',
      genre: ['Mystery'], tags: [], settings: {}, createdAt: 1700000000000, updatedAt: 1700000001000,
    });
    await legacy.table('worlds').add({
      id: 'world_v3', projectId: 'proj_v3', title: 'V3 World', overview: 'x', sections: [],
      themes: [], settings: {}, createdAt: 1700000000000, updatedAt: 1700000000000,
    });
    await legacy.table('characters').add({
      id: 'char_v3', projectId: 'proj_v3', name: 'V3 Character', summary: '', background: '',
      personality: '', motivation: '', appearance: '', role: 'supporting', status: 'active',
      tags: [], createdAt: 1700000000000, updatedAt: 1700000000000,
    });
    await legacy.table('narrativePlans').add({
      id: 'narr_v3', projectId: 'proj_v3', logline: 'V3 logline', theme: '', premise: '',
      centralConflict: '', stakes: '', ending: '', structure: 'three-act', status: 'in-progress',
      beats: [{ id: 'beat_v3', title: 'V3 Beat', description: '', position: 50 }],
      motifs: [], createdAt: 1700000000000, updatedAt: 1700000000000,
    });
    const v3Tables = legacy.tables.map(t => t.name).sort();
    legacy.close();

    // Reopen with the REAL v4 schema.
    await db.open();
    return {
      v3Tables,
      v4Tables: db.tables.map(t => t.name).sort(),
      verno: db.verno,
      project: await db.projects.get('proj_v3'),
      world: await db.worlds.get('world_v3'),
      character: await db.characters.get('char_v3'),
      plan: await db.narrativePlans.get('narr_v3'),
    };
  })()`);

  record(
    'v3 基线不含 outline 表',
    JSON.stringify(migration.v3Tables) === JSON.stringify(['characters', 'narrativePlans', 'projects', 'worlds']),
    `[${migration.v3Tables}]`,
  );
  record(
    'v3 → v4 迁移后新增 volumes/chapters/scenes，旧表仍在',
    migration.verno === 4 && JSON.stringify(migration.v4Tables) === JSON.stringify(EXPECTED),
    `verno=${migration.verno} tables=[${migration.v4Tables}]`,
  );
  record(
    'v3 → v4 迁移后 P1/P2 数据零丢失',
    migration.project?.title === 'V3 Project' &&
      migration.project?.status === 'writing' &&
      migration.world?.title === 'V3 World' &&
      migration.character?.name === 'V3 Character' &&
      migration.plan?.logline === 'V3 logline' &&
      migration.plan?.beats?.[0]?.id === 'beat_v3',
    `project=${migration.project?.title} plan=${migration.plan?.logline} beat=${migration.plan?.beats?.[0]?.title}`,
  );

  // ---------- Outline + scene lifecycle ----------
  const flow = await cdp.eval(`(async () => {
    const { projectService, narrativeService, outlineService, sceneService, db } = window.__p3;
    const out = {};

    const pA = await projectService.createProject({ title: 'Outline A' });
    const pB = await projectService.createProject({ title: 'Outline B' });
    out.projects = [pA.id, pB.id];

    out.initialOutline = (await outlineService.getOutline(pA.id)).length;

    // Volumes
    const v1 = await outlineService.createVolume(pA.id, { title: 'Book One', summary: 'Opening arc' });
    const v2 = await outlineService.createVolume(pA.id, { title: 'Book Two' });
    out.volumes = { ids: [v1.id, v2.id], prefixed: v1.id.startsWith('vol_') && v2.id.startsWith('vol_'), projectId: v1.projectId === pA.id };

    // Chapters keep insertion order, compacted to 0..n-1
    const c1 = await outlineService.createChapter(pA.id, v1.id, { title: 'Ch One', summary: 's1' });
    const c2 = await outlineService.createChapter(pA.id, v1.id, { title: 'Ch Two' });
    const c3 = await outlineService.createChapter(pA.id, v1.id, { title: 'Ch Three' });
    out.chapters = {
      orders: [c1.order, c2.order, c3.order],
      prefixed: c1.id.startsWith('chap_'),
      defaults: { status: c1.status, goal: c1.goal, chars: c1.characterIds.length, tags: c1.tags.length },
      hasNoBeat: c1.plotBeatId === undefined,
    };

    // Move chapter down -> order compaction keeps 0..n-1
    await outlineService.moveChapter(c1.id, 1);
    const afterMove = await outlineService.listChapters(v1.id);
    out.moveDown = afterMove.map(c => c.title);

    // Move up twice -> back to top; the first item cannot move above index 0
    await outlineService.moveChapter(c1.id, -1);
    await outlineService.moveChapter(c1.id, -1);
    out.moveUp = (await outlineService.listChapters(v1.id)).map(c => c.title);

    // Reorder via explicit order field
    await outlineService.updateChapter(c3.id, { order: 0 });
    out.reordered = (await outlineService.listChapters(v1.id)).map(c => ({ t: c.title, o: c.order }));

    // ---- PlotBeat link integrity ----
    const plan = await narrativeService.createPlan(pA.id, {
      beats: [
        { title: 'Inciting Incident', description: 'The call.', position: 20 },
        { title: 'Midpoint', description: 'The reversal.', position: 50 },
      ],
    });
    const beatId = plan.beats[0].id;

    const linked = await outlineService.updateChapter(c1.id, { plotBeatId: beatId });
    out.link = { set: linked.plotBeatId === beatId };

    // Linking a beat that does not exist is rejected.
    let badBeat = null;
    try { await outlineService.updateChapter(c1.id, { plotBeatId: 'beat_does_not_exist' }); }
    catch (e) { badBeat = { name: e.name, message: e.message }; }
    out.badBeat = badBeat;

    // Another project's beat is NOT linkable (isolation of references).
    const planB = await narrativeService.createPlan(pB.id, { beats: [{ title: 'B Beat', description: '', position: 10 }] });
    let crossBeat = null;
    try { await outlineService.updateChapter(c1.id, { plotBeatId: planB.beats[0].id }); }
    catch (e) { crossBeat = { name: e.name }; }
    out.crossBeat = crossBeat;

    // The rejected writes did not change the stored link.
    out.linkUnchanged = (await outlineService.getChapter(c1.id)).plotBeatId === beatId;

    // Clearing the link with null.
    const cleared = await outlineService.updateChapter(c1.id, { plotBeatId: null });
    out.linkCleared = cleared.plotBeatId === undefined;
    await outlineService.updateChapter(c1.id, { plotBeatId: beatId });

    // Partial update: omitted fields untouched.
    const partial = await outlineService.updateChapter(c1.id, { goal: 'Reach the lighthouse.' });
    out.partial = {
      goal: partial.goal,
      summaryKept: partial.summary === 's1',
      beatKept: partial.plotBeatId === beatId,
      titleKept: partial.title === 'Ch One',
    };

    // ---- Scenes ----
    const s1 = await sceneService.createScene(pA.id, c1.id, { title: 'S1', goal: 'g', outcome: 'o', targetWords: 1200 });
    const s2 = await sceneService.createScene(pA.id, c1.id, { title: 'S2', purpose: 'conflict', status: 'drafted' });
    const s3 = await sceneService.createScene(pA.id, c1.id, { title: 'S3' });
    out.scenes = {
      ids: [s1.id, s2.id, s3.id],
      prefixed: s1.id.startsWith('scene_'),
      orders: [s1.order, s2.order, s3.order],
      chapterId: s1.chapterId === c1.id,
      projectId: s1.projectId === pA.id,
      defaults: { purpose: s1.purpose, status: s1.status, chars: s1.characterIds.length },
      targetWords: s1.targetWords,
      purposeSet: s2.purpose,
    };

    await sceneService.moveScene(s3.id, -1);
    out.sceneMove = (await sceneService.listScenes(c1.id)).map(s => s.title);

    const sUpd = await sceneService.updateScene(s1.id, { status: 'final', targetWords: null, povCharacterId: null });
    out.sceneUpdate = { status: sUpd.status, targetCleared: sUpd.targetWords === undefined, povCleared: sUpd.povCharacterId === undefined, titleKept: sUpd.title === 'S1' };

    // Scene into a chapter of ANOTHER project is rejected.
    const vB = await outlineService.createVolume(pB.id, { title: 'B Vol' });
    const cB = await outlineService.createChapter(pB.id, vB.id, { title: 'B Ch' });
    let crossScene = null;
    try { await sceneService.createScene(pA.id, cB.id, { title: 'Should Fail' }); }
    catch (e) { crossScene = { name: e.name, message: e.message }; }
    out.crossScene = crossScene;

    // Counts per chapter for outline badges.
    out.counts = await sceneService.countByProject(pA.id);

    // ---- Isolation ----
    const outlineB = await outlineService.getOutline(pB.id);
    out.isolation = {
      aVolumes: (await outlineService.getOutline(pA.id)).length,
      bVolumes: outlineB.length,
      bChapters: outlineB[0]?.chapters.length ?? 0,
      bScenes: (await sceneService.listScenes(cB.id)).length,
      aScenes: (await sceneService.listScenes(c1.id)).length,
    };

    // ---- Cascades ----
    // Deleting a scene compacts order.
    await sceneService.deleteScene(s1.id);
    out.afterSceneDelete = (await sceneService.listScenes(c1.id)).map(s => ({ t: s.title, o: s.order }));

    // Deleting a volume removes its chapters AND their scenes.
    const vTmp = await outlineService.createVolume(pA.id, { title: 'Temp Volume' });
    const cTmp = await outlineService.createChapter(pA.id, vTmp.id, { title: 'Temp Chapter' });
    await sceneService.createScene(pA.id, cTmp.id, { title: 'Temp Scene' });
    await outlineService.deleteVolume(vTmp.id);
    out.volumeCascade = {
      volumes: await db.volumes.where('projectId').equals(pA.id).filter(v => v.id === vTmp.id).count(),
      chapters: await db.chapters.where('volumeId').equals(vTmp.id).count(),
      scenes: await db.scenes.where('chapterId').equals(cTmp.id).count(),
    };
    // Idempotent volume delete.
    await outlineService.deleteVolume(vTmp.id);
    out.volumeDeleteIdempotent = true;

    // Deleting a chapter removes its scenes.
    const cDel = await outlineService.createChapter(pA.id, v1.id, { title: 'To Delete' });
    await sceneService.createScene(pA.id, cDel.id, { title: 'Doomed' });
    await outlineService.deleteChapter(cDel.id);
    out.chapterCascade = {
      chapter: await db.chapters.where('volumeId').equals(v1.id).filter(c => c.id === cDel.id).count(),
      scenes: await db.scenes.where('chapterId').equals(cDel.id).count(),
    };

    // ---- Project cascade wipes EVERYTHING ----
    await projectService.deleteProject(pA.id);
    out.projectCascade = {
      plans: await db.narrativePlans.where('projectId').equals(pA.id).count(),
      volumes: await db.volumes.where('projectId').equals(pA.id).count(),
      chapters: await db.chapters.where('projectId').equals(pA.id).count(),
      scenes: await db.scenes.where('projectId').equals(pA.id).count(),
      project: (await db.projects.get(pA.id)) === undefined,
    };
    out.cascadeIsolation = {
      bVolumes: await db.volumes.where('projectId').equals(pB.id).count(),
      bChapters: await db.chapters.where('projectId').equals(pB.id).count(),
      bProject: (await db.projects.get(pB.id)) !== undefined,
      bPlan: (await db.narrativePlans.where('projectId').equals(pB.id).count()) === 1,
    };

    // ---- Schema guards ----
    const vG = await outlineService.createVolume(pB.id, { title: 'Guard Vol' });
    let badStatus = null;
    try { await outlineService.createChapter(pB.id, vG.id, { title: 'X', status: 'nope' }); }
    catch (e) { badStatus = { name: e.name }; }
    let emptyTitle = null;
    try { await outlineService.createChapter(pB.id, vG.id, { title: '   ' }); }
    catch (e) { emptyTitle = { name: e.name }; }
    let badScenePurpose = null;
    const cG = await outlineService.createChapter(pB.id, vG.id, { title: 'Guard Ch' });
    try { await sceneService.createScene(pB.id, cG.id, { title: 'S', purpose: 'nope' }); }
    catch (e) { badScenePurpose = { name: e.name }; }
    let negativeTarget = null;
    try { await sceneService.createScene(pB.id, cG.id, { title: 'S', targetWords: -5 }); }
    catch (e) { negativeTarget = { name: e.name }; }
    out.guards = {
      badStatus, emptyTitle, badScenePurpose, negativeTarget,
      // Nothing rejected leaked into the store.
      chaptersInGuardVolume: (await outlineService.listChapters(vG.id)).length,
      scenesInGuardChapter: (await sceneService.listScenes(cG.id)).length,
    };

    await projectService.deleteProject(pB.id);
    out.remainingProjects = (await projectService.listProjects()).length;
    return out;
  })()`);

  record(
    '新项目大纲为空',
    flow.initialOutline === 0,
    `volumes=${flow.initialOutline}`,
  );
  record(
    '创建卷（id 前缀 / 归属项目）',
    flow.volumes?.prefixed === true && flow.volumes?.projectId === true,
    JSON.stringify(flow.volumes),
  );
  record(
    '创建章节（顺序 0..n-1、默认 planned、空字段、默认无节拍链接）',
    JSON.stringify(flow.chapters?.orders) === JSON.stringify([0, 1, 2]) &&
      flow.chapters?.prefixed === true &&
      flow.chapters?.defaults?.status === 'planned' &&
      flow.chapters?.defaults?.goal === '' &&
      flow.chapters?.hasNoBeat === true,
    JSON.stringify(flow.chapters),
  );
  record(
    '章节上下移动与显式排序（顺序始终稠密 0..n-1）',
    flow.moveDown?.join('|') === 'Ch Two|Ch One|Ch Three' &&
      flow.moveUp?.join('|') === 'Ch One|Ch Two|Ch Three' &&
      flow.reordered?.[0]?.t === 'Ch Three' &&
      flow.reordered?.map((c) => c.o).join(',') === '0,1,2',
    `down=${flow.moveDown} up=${flow.moveUp} reordered=${JSON.stringify(flow.reordered)}`,
  );
  record(
    '章节关联 Narrative PlotBeat（仅存 id）',
    flow.link?.set === true && flow.partial?.beatKept === true,
    `set=${flow.link?.set} kept=${flow.partial?.beatKept}`,
  );
  record(
    '关联不存在的节拍被拒（OutlineNotFoundError）',
    flow.badBeat?.name === 'OutlineNotFoundError' && flow.badBeat?.message?.includes('was not found'),
    `${flow.badBeat?.name}: ${flow.badBeat?.message}`,
  );
  record(
    '不能关联其他项目的节拍（引用隔离），且失败不改变原链接',
    flow.crossBeat?.name === 'OutlineNotFoundError' && flow.linkUnchanged === true,
    `crossBeat=${flow.crossBeat?.name} unchanged=${flow.linkUnchanged}`,
  );
  record(
    '取消节拍关联（null 清除）',
    flow.linkCleared === true,
    `cleared=${flow.linkCleared}`,
  );
  record(
    '章节部分更新：未提供的字段保持不变',
    flow.partial?.goal === 'Reach the lighthouse.' &&
      flow.partial?.summaryKept === true &&
      flow.partial?.titleKept === true,
    JSON.stringify(flow.partial),
  );
  record(
    '创建场景（id 前缀 / 归属章节与项目 / 顺序 / 默认值）',
    flow.scenes?.prefixed === true &&
      JSON.stringify(flow.scenes?.orders) === JSON.stringify([0, 1, 2]) &&
      flow.scenes?.chapterId === true &&
      flow.scenes?.projectId === true &&
      flow.scenes?.defaults?.purpose === 'setup' &&
      flow.scenes?.defaults?.status === 'planned' &&
      flow.scenes?.purposeSet === 'conflict',
    JSON.stringify(flow.scenes),
  );
  record(
    '场景排序 + 部分更新 + null 清空可选项',
    flow.sceneMove?.join('|') === 'S1|S3|S2' &&
      flow.sceneUpdate?.status === 'final' &&
      flow.sceneUpdate?.targetCleared === true &&
      flow.sceneUpdate?.povCleared === true &&
      flow.sceneUpdate?.titleKept === true,
    `move=${flow.sceneMove} update=${JSON.stringify(flow.sceneUpdate)}`,
  );
  record(
    '跨项目创建场景被拒（章节→项目一致性）',
    flow.crossScene?.name === 'OutlineNotFoundError' && flow.crossScene?.message?.includes('does not belong'),
    `${flow.crossScene?.name}: ${flow.crossScene?.message}`,
  );
  record(
    '章节场景计数（供大纲徽章）',
    flow.counts && Object.values(flow.counts).reduce((a, b) => a + b, 0) === 3,
    JSON.stringify(flow.counts),
  );
  record(
    '不同项目的大纲/章节/场景互相隔离',
    flow.isolation?.aVolumes === 2 &&
      flow.isolation?.bVolumes === 1 &&
      flow.isolation?.bChapters === 1 &&
      flow.isolation?.bScenes === 0 &&
      flow.isolation?.aScenes === 3,
    JSON.stringify(flow.isolation),
  );
  record(
    '删除场景后顺序重新稠密',
    JSON.stringify(flow.afterSceneDelete) === JSON.stringify([{ t: 'S3', o: 0 }, { t: 'S2', o: 1 }]),
    JSON.stringify(flow.afterSceneDelete),
  );
  record(
    '删除卷级联删除章节与场景（幂等）',
    flow.volumeCascade?.volumes === 0 &&
      flow.volumeCascade?.chapters === 0 &&
      flow.volumeCascade?.scenes === 0 &&
      flow.volumeDeleteIdempotent === true,
    JSON.stringify(flow.volumeCascade),
  );
  record(
    '删除章节级联删除其场景',
    flow.chapterCascade?.chapter === 0 && flow.chapterCascade?.scenes === 0,
    JSON.stringify(flow.chapterCascade),
  );
  record(
    '删除项目级联清理规划/卷/章节/场景（无孤儿）',
    flow.projectCascade?.plans === 0 &&
      flow.projectCascade?.volumes === 0 &&
      flow.projectCascade?.chapters === 0 &&
      flow.projectCascade?.scenes === 0 &&
      flow.projectCascade?.project === true,
    JSON.stringify(flow.projectCascade),
  );
  record(
    '项目级联删除不影响其他项目',
    flow.cascadeIsolation?.bVolumes === 1 &&
      flow.cascadeIsolation?.bChapters === 1 &&
      flow.cascadeIsolation?.bProject === true &&
      flow.cascadeIsolation?.bPlan === true,
    JSON.stringify(flow.cascadeIsolation),
  );
  record(
    'Zod 拦截非法章节状态/空标题/非法场景用途/负目标字数，且不落库',
    flow.guards?.badStatus?.name === 'ProjectValidationError' &&
      flow.guards?.emptyTitle?.name === 'ProjectValidationError' &&
      flow.guards?.badScenePurpose?.name === 'ProjectValidationError' &&
      flow.guards?.negativeTarget?.name === 'ProjectValidationError' &&
      flow.guards?.chaptersInGuardVolume === 1 &&
      flow.guards?.scenesInGuardChapter === 0,
    JSON.stringify(flow.guards),
  );

  // ---------- Persistence across a real page reload ----------
  const seeded = await cdp.eval(`(async () => {
    const { projectService, narrativeService, outlineService, sceneService } = window.__p3;
    const p = await projectService.createProject({ title: 'Outline Persistence Probe' });
    const plan = await narrativeService.createPlan(p.id, { beats: [{ title: 'Hook', description: '', position: 0 }] });
    const v = await outlineService.createVolume(p.id, { title: 'Persisted Volume' });
    const c = await outlineService.createChapter(p.id, v.id, { title: 'Persisted Chapter', plotBeatId: plan.beats[0].id, status: 'drafting' });
    await sceneService.createScene(p.id, c.id, { title: 'Persisted Scene', goal: 'g', targetWords: 900 });
    localStorage.setItem('n87-p3-probe-project', p.id);
    localStorage.setItem('n87-p3-probe-chapter', c.id);
    return { projectId: p.id };
  })()`);

  await cdp.send('Page.reload');
  await sleep(3500);

  const afterReload = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const projectId = localStorage.getItem('n87-p3-probe-project');
    const chapterId = localStorage.getItem('n87-p3-probe-chapter');
    const outline = await svc.outlineService.getOutline(projectId);
    const scenes = await svc.sceneService.listScenes(chapterId);
    const snapshot = {
      volumes: outline.length,
      volumeTitle: outline[0]?.volume.title,
      chapters: outline[0]?.chapters.length,
      chapterTitle: outline[0]?.chapters[0]?.title,
      chapterStatus: outline[0]?.chapters[0]?.status,
      beatLinked: typeof outline[0]?.chapters[0]?.plotBeatId === 'string',
      scenes: scenes.length,
      sceneTitle: scenes[0]?.title,
      sceneTarget: scenes[0]?.targetWords,
    };
    await svc.projectService.deleteProject(projectId);
    const db = dbMod.db;
    return {
      snapshot,
      afterCleanup: {
        volumes: await db.volumes.where('projectId').equals(projectId).count(),
        chapters: await db.chapters.where('projectId').equals(projectId).count(),
        scenes: await db.scenes.where('projectId').equals(projectId).count(),
        project: (await db.projects.get(projectId)) === undefined ? 0 : 1,
      },
    };
  })()`);

  record(
    '刷新页面后大纲与场景恢复（卷/章/状态/节拍链接/场景目标字数）',
    afterReload.snapshot?.volumes === 1 &&
      afterReload.snapshot?.volumeTitle === 'Persisted Volume' &&
      afterReload.snapshot?.chapters === 1 &&
      afterReload.snapshot?.chapterTitle === 'Persisted Chapter' &&
      afterReload.snapshot?.chapterStatus === 'drafting' &&
      afterReload.snapshot?.beatLinked === true &&
      afterReload.snapshot?.scenes === 1 &&
      afterReload.snapshot?.sceneTitle === 'Persisted Scene' &&
      afterReload.snapshot?.sceneTarget === 900,
    JSON.stringify(afterReload.snapshot),
  );
  record(
    '清理后无孤儿记录（卷/章/场景/项目）',
    Object.values(afterReload.afterCleanup).every((v) => v === 0),
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
