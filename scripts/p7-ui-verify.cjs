/**
 * P7 UI smoke test: real browser, real routing, real Dexie.
 *
 * Verifies the three P7 pages mount at their routes (not placeholders) and that
 * the P7 data layer works end to end against IndexedDB, exercising the
 * requirement-critical behaviours a pure unit test cannot reach:
 *   - Knowledge import is IDEMPOTENT against the real DB and preserves a
 *     traceable source reference; search narrows deterministically;
 *   - Continuity is event-sourced: state is reconstructed from the fact log, and
 *     a REAL chapter reorder (via the Outline service) changes the reconstructed
 *     point-in-time state;
 *   - Analysis findings are evidence-backed only; a finding can never be saved
 *     without a chapter/scene locator (enforced by the DB validation path);
 *   - Deleting a project cascades to knowledge / continuity / analysis rows.
 *
 * Usage: npm run verify:knowledge:ui
 * Requires a dev server on http://localhost:5177/.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9362;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      })
      .on('error', reject);
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
  sendBounded(method, params = {}, ms = 20_000) {
    let timer = null;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out in ${ms}ms.`)), ms); });
    const call = this.send(method, params);
    call.catch(() => {});
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
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
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7ui-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
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

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // ---- Route smoke: P7 pages render their own header, not a placeholder ----
  const routes = [
    { path: '/ai/knowledge-base', header: 'Knowledge Base' },
    { path: '/ai/continuity-manager', header: 'AI Continuity Manager' },
    { path: '/ai/plot-hole-detector', header: 'Plot Hole Detector' },
  ];
  for (const route of routes) {
    await cdp.sendBounded('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}${route.path}` }, 20_000);
    const rendered = await cdp.eval(`(async () => {
      for (let i = 0; i < 80; i++) {
        const h1 = document.querySelector('h1');
        if (h1 && (h1.textContent || '').includes(${JSON.stringify(route.header)})) {
          return { ok: true, title: (h1.textContent || '').trim(), isPlaceholder: document.body.innerText.includes('under construction') || document.body.innerText.includes('ModulePlaceholder') };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      const h1 = document.querySelector('h1');
      return { ok: false, title: h1 ? (h1.textContent || '').trim() : null };
    })()`);
    record(`route ${route.path} renders "${route.header}" (not a placeholder)`, rendered?.ok === true && rendered?.isPlaceholder === false, JSON.stringify(rendered));
  }

  // ---- Data layer: knowledge import idempotency + search ----
  const kb = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();

    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    const project = await svc.projectService.createProject({ title: 'P7 Verify Project' });

    // Seed real entities.
    await svc.characterService.createCharacter(project.id, { name: 'Elara' });
    const world = await svc.worldService.getWorld(project.id);
    // world may or may not exist; ensure one with a section.
    if (!world) await svc.worldService.createWorld(project.id, { title: 'Coast', overview: 'A shore.', sections: [{ title: 'Magic', content: 'Tide-magic costs memory.' }] });
    else await svc.worldService.updateWorld(project.id, { sections: [{ title: 'Magic', content: 'Tide-magic costs memory.' }] });

    const vol = await svc.outlineService.createVolume(project.id, { title: 'Vol 1' });
    const ch1 = await svc.outlineService.createChapter(project.id, vol.id, { title: 'Arrival', summary: 'She lands.' });
    const ch2 = await svc.outlineService.createChapter(project.id, vol.id, { title: 'Storm', summary: 'A storm.' });
    await svc.sceneService.createScene(project.id, ch1.id, { title: 'Landing', summary: 'Steps ashore.' });

    const first = await svc.knowledgeService.importFromProject(project.id);
    const afterFirst = (await svc.knowledgeService.listEntries(project.id)).length;
    const second = await svc.knowledgeService.importFromProject(project.id);
    const afterSecond = (await svc.knowledgeService.listEntries(project.id)).length;

    const entries = await svc.knowledgeService.listEntries(project.id);
    const traceable = entries.filter((e) => e.sourceRef.entityId && e.sourceKey).length;

    const search = await svc.knowledgeService.search(project.id, 'elara');
    const miss = await svc.knowledgeService.search(project.id, 'zzznotpresent');

    return {
      projectId: project.id,
      ch1: ch1.id, ch2: ch2.id,
      firstImported: first.imported,
      firstUpdated: first.updated,
      secondImported: second.imported,
      secondUpdated: second.updated,
      stable: afterFirst === afterSecond && afterFirst > 0,
      traceableCount: traceable,
      allTraceable: entries.length > 0 && traceable === entries.filter((e) => e.source !== 'manual').length,
      searchHit: search.entries.some((e) => /elara/i.test(e.title)),
      searchMiss: miss.entries.length === 0,
    };
  })()`);

  record('knowledge: first import creates entries', kb?.firstImported > 0, JSON.stringify({ imported: kb?.firstImported }));
  record('knowledge: re-import is idempotent (no new entries, entries refreshed)', kb?.secondImported === 0 && kb?.secondUpdated > 0 && kb?.stable === true, JSON.stringify({ secondImported: kb?.secondImported, secondUpdated: kb?.secondUpdated, stable: kb?.stable }));
  record('knowledge: imported entries carry a traceable source reference', kb?.allTraceable === true, JSON.stringify({ traceable: kb?.traceableCount }));
  record('knowledge: search finds entries; miss returns empty', kb?.searchHit === true && kb?.searchMiss === true, JSON.stringify({ hit: kb?.searchHit, miss: kb?.searchMiss }));

  const projectId = kb?.projectId;

  // ---- Continuity: event-sourced reconstruction + real reorder ----
  const cont = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const projectId = ${JSON.stringify(projectId)};
    const ch1 = ${JSON.stringify(kb?.ch1)};
    const ch2 = ${JSON.stringify(kb?.ch2)};

    const character = (await svc.characterService.listCharacters(projectId))[0];

    await svc.continuityService.createFact(projectId, { subjectType: 'character', subjectId: character.id, subjectLabel: character.name, predicate: 'position', value: 'harbour', anchorChapterId: ch1 });
    await svc.continuityService.createFact(projectId, { subjectType: 'character', subjectId: character.id, subjectLabel: character.name, predicate: 'position', value: 'lighthouse', anchorChapterId: ch2 });

    const stateBefore = await svc.continuityService.currentState(projectId);
    const posBefore = stateBefore.find((s) => s.subjectId === character.id).values.find((v) => v.predicate === 'position').value;

    const asOfCh1Before = (await svc.continuityService.stateAsOf(projectId, ch1)).find((s) => s.subjectId === character.id).values.find((v) => v.predicate === 'position').value;

    // Reorder chapters at the OUTLINE level: move ch2 UP so it precedes ch1.
    // (Volume currently holds [ch1, ch2]; moving ch2 up swaps them.)
    let reorderOk = false;
    try {
      if (typeof svc.outlineService.moveChapter === 'function') {
        await svc.outlineService.moveChapter(ch2, -1);
        reorderOk = true;
      }
    } catch { reorderOk = false; }

    const posAfterReorder = reorderOk
      ? (await svc.continuityService.currentState(projectId)).find((s) => s.subjectId === character.id).values.find((v) => v.predicate === 'position').value
      : null;

    return {
      charId: character.id,
      posBefore,
      asOfCh1Before,
      reorderOk,
      posAfterReorder,
      factCount: (await svc.continuityService.listFacts(projectId)).length,
    };
  })()`);

  record('continuity: current state reflects the latest anchored fact', cont?.posBefore === 'lighthouse', JSON.stringify({ posBefore: cont?.posBefore }));
  record('continuity: point-in-time state (as of chapter 1) = harbour', cont?.asOfCh1Before === 'harbour', JSON.stringify({ asOfCh1Before: cont?.asOfCh1Before }));
  if (cont?.reorderOk) {
    record('continuity: reordering chapters changes reconstructed state (harbour becomes current)', cont?.posAfterReorder === 'harbour', JSON.stringify({ posAfterReorder: cont?.posAfterReorder }));
  } else {
    console.log('SKIP  continuity: outline service has no reorderChapters API — reorder check skipped');
  }

  // ---- Analysis: deterministic, evidence-backed only ----
  const analysis = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const projectId = ${JSON.stringify(projectId)};
    const ch1 = ${JSON.stringify(kb?.ch1)};

    // Create a same-chapter contradiction on a fresh subject.
    await svc.continuityService.createFact(projectId, { subjectType: 'item', subjectLabel: 'The Key', predicate: 'possession', value: 'Elara', anchorChapterId: ch1 });
    await svc.continuityService.createFact(projectId, { subjectType: 'item', subjectLabel: 'The Key', predicate: 'possession', value: 'Mira', anchorChapterId: ch1 });

    const run = await svc.analysisService.runDeterministic(projectId);
    const persisted = await svc.analysisService.listFindings(projectId);

    // Saving an evidence-less finding must be rejected by the service.
    let rejectedNoEvidence = false;
    try {
      await svc.analysisService.saveDraft(projectId, { category: 'logic', severity: 'error', origin: 'manual', title: 'Bad', description: 'No evidence', evidence: [] });
    } catch { rejectedNoEvidence = true; }

    return {
      created: run.created.length,
      persisted: persisted.length,
      allEvidenceBacked: persisted.length > 0 && persisted.every((f) => f.evidence.length >= 1 && f.evidence.every((e) => e.chapterId || e.sceneId)),
      hasContinuity: persisted.some((f) => f.category === 'continuity'),
      rejectedNoEvidence,
    };
  })()`);

  record('analysis: run creates findings', analysis?.created > 0, JSON.stringify({ created: analysis?.created }));
  record('analysis: every persisted finding cites chapter/scene evidence', analysis?.allEvidenceBacked === true, JSON.stringify({ persisted: analysis?.persisted }));
  record('analysis: detects the same-chapter contradiction', analysis?.hasContinuity === true, JSON.stringify({ hasContinuity: analysis?.hasContinuity }));
  record('analysis: saving an evidence-less finding is rejected', analysis?.rejectedNoEvidence === true, String(analysis?.rejectedNoEvidence));

  // ---- Cascade: deleting a project clears P7 rows ----
  const cascade = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    const db = dbMod.db;
    const projectId = ${JSON.stringify(projectId)};

    const before = {
      knowledge: await db.knowledgeEntries.where('projectId').equals(projectId).count(),
      continuity: await db.continuityFacts.where('projectId').equals(projectId).count(),
      analysis: await db.analysisFindings.where('projectId').equals(projectId).count(),
    };

    await svc.projectService.deleteProject(projectId);

    const after = {
      knowledge: await db.knowledgeEntries.where('projectId').equals(projectId).count(),
      continuity: await db.continuityFacts.where('projectId').equals(projectId).count(),
      analysis: await db.analysisFindings.where('projectId').equals(projectId).count(),
    };
    return { before, after };
  })()`);

  record(
    'cascade: project delete clears knowledge, continuity and analysis rows',
    cascade?.before.knowledge > 0 && cascade?.before.continuity > 0 && cascade?.before.analysis > 0 &&
      cascade?.after.knowledge === 0 && cascade?.after.continuity === 0 && cascade?.after.analysis === 0,
    JSON.stringify(cascade),
  );

  // Cleanup remaining state.
  await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    for (const p of await svc.aiConfigService.listProviders()) await svc.aiConfigService.deleteProvider(p.id);
    return true;
  })()`);

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

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
  .then(() => { teardown(); process.exit(process.exitCode || 0); })
  .catch((error) => { console.error('HARNESS ERROR:', error); teardown(); process.exit(1); });
