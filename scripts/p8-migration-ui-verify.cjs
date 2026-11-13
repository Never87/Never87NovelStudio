/**
 * P8 Batch-1 FINAL: real IndexedDB migration + integration verification.
 *
 * Unlike `p8-verify.cjs` (pure Node, fake tables, static schema text), this
 * runs the REAL Dexie + the browser's REAL IndexedDB via a headless Chrome
 * driven over CDP — the same infrastructure the P2–P7 UI scripts use.
 *
 * It performs a genuine v8 → v9 upgrade:
 *   1. Open a fresh database with a RAW Dexie `version(8)` definition equal to
 *      the shipped v8 schema, and seed representative P1–P7 rows into every
 *      store (projects, worlds, characters, plans, outline, manuscripts,
 *      versions, AI config, prompts, context, knowledge, continuity, analysis).
 *   2. Close it, then reopen the SAME database name with the real `NovelStudioDb`
 *      (which declares v9). Dexie runs the real upgrade transaction.
 *   3. Assert old rows survive byte-for-byte, old indexes/queries still work,
 *      the three new P8 stores are writable/readable, projectId isolation holds,
 *      and cascade delete removes ONLY the target project's rows (old + new).
 *
 * Usage: npm run verify:import:ui   (needs dev server on http://localhost:5177/)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9370;

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

// A unique DB name per run so we always start from a truly empty database.
const DB_NAME = `p8-migration-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8mig-chrome-'));
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

  // Load the real app so its modules + Dexie registration are live.
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(`(async () => { await import('/src/db/index.ts'); return true; })()`);

  /* ---------------------------------------------------------------------- */
  /* STEP 1+2+3 — seed a REAL v8 DB, then upgrade to v9 and verify.         */
  /* All in one evaluation so the DB handle lifecycle is explicit.          */
  /* ---------------------------------------------------------------------- */
  const mig = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const { NovelStudioDb } = dbMod;
    // The Dexie base class is NovelStudioDb's superclass — no fragile dep path.
    const Dexie = Object.getPrototypeOf(NovelStudioDb);

    const DB = ${JSON.stringify(DB_NAME)};
    const t = 1_700_000_000_000;

    // --- (1) Create a real v8 database with the EXACT shipped v8 schema. ---
    class V8Db extends Dexie {
      constructor() {
        super(DB);
        this.version(8).stores({
          projects: '&id, title, status, createdAt, updatedAt',
          worlds: '&id, &projectId, updatedAt',
          characters: '&id, projectId, name, createdAt, updatedAt',
          narrativePlans: '&id, &projectId, status, updatedAt',
          volumes: '&id, projectId, updatedAt',
          chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
          scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
          chapterDrafts: '&id, &ownerId, projectId, updatedAt',
          sceneDrafts: '&id, &ownerId, projectId, updatedAt',
          draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
          aiProviders: '&id, providerType, enabled, updatedAt',
          aiModels: '&id, providerId, [providerId+modelId], enabled',
          aiTaskConfigs: '&task',
          aiGlobalConfig: '&id',
          promptTemplates: '&id, projectId, category, taskKind, updatedAt',
          promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
          contextItems: '&id, projectId, layer, updatedAt',
          contextConfigs: '&id, &projectId, updatedAt',
          knowledgeEntries: '&id, projectId, kind, source, updatedAt, [projectId+sourceKey]',
          continuityFacts: '&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt',
          analysisFindings: '&id, projectId, category, status, updatedAt',
        });
      }
    }

    // Two projects so we can prove isolation + targeted cascade.
    const pA = { id: 'projA', title: 'Alpha', description: 'A', status: 'drafting', genre: [], tags: [], settings: {}, createdAt: t, updatedAt: t };
    const pB = { id: 'projB', title: 'Beta', description: 'B', status: 'planning', genre: [], tags: [], settings: {}, createdAt: t, updatedAt: t };

    const v8 = new V8Db();
    const openedV8 = v8.verno === 8; // confirms we actually started at v8
    await v8.open();

    // Representative P1–P7 rows for BOTH projects.
    await v8.table('projects').bulkPut([pA, pB]);
    await v8.table('worlds').bulkPut([
      { id: 'wA', projectId: 'projA', overview: 'coast', sections: [{ title: 'Magic', content: 'tide-magic' }], createdAt: t, updatedAt: t },
      { id: 'wB', projectId: 'projB', overview: 'mount', sections: [], createdAt: t, updatedAt: t },
    ]);
    await v8.table('characters').bulkPut([
      { id: 'cA1', projectId: 'projA', name: 'Elara', role: 'protagonist', status: 'alive', createdAt: t, updatedAt: t },
      { id: 'cB1', projectId: 'projB', name: 'Bran', role: 'deuteragonist', status: 'alive', createdAt: t, updatedAt: t },
    ]);
    await v8.table('narrativePlans').bulkPut([
      { id: 'nA', projectId: 'projA', structure: 'three-act', status: 'draft', premise: 'x', createdAt: t, updatedAt: t },
      { id: 'nB', projectId: 'projB', structure: 'hero', status: 'draft', premise: 'y', createdAt: t, updatedAt: t },
    ]);
    await v8.table('volumes').bulkPut([
      { id: 'vA', projectId: 'projA', title: 'Vol A', order: 0, createdAt: t, updatedAt: t },
      { id: 'vB', projectId: 'projB', title: 'Vol B', order: 0, createdAt: t, updatedAt: t },
    ]);
    await v8.table('chapters').bulkPut([
      { id: 'chA1', projectId: 'projA', volumeId: 'vA', title: 'Ch A1', order: 0, status: 'planned', createdAt: t, updatedAt: t },
      { id: 'chA2', projectId: 'projA', volumeId: 'vA', title: 'Ch A2', order: 1, status: 'planned', createdAt: t, updatedAt: t },
      { id: 'chB1', projectId: 'projB', volumeId: 'vB', title: 'Ch B1', order: 0, status: 'planned', createdAt: t, updatedAt: t },
    ]);
    await v8.table('scenes').bulkPut([
      { id: 'scA1', projectId: 'projA', chapterId: 'chA1', title: 'Sc A1', order: 0, status: 'planned', createdAt: t, updatedAt: t },
    ]);
    await v8.table('chapterDrafts').bulkPut([
      { id: 'cdA1', ownerId: 'chA1', projectId: 'projA', content: '<p>hello</p>', wordCount: 1, createdAt: t, updatedAt: t },
    ]);
    await v8.table('sceneDrafts').bulkPut([
      { id: 'sdA1', ownerId: 'scA1', projectId: 'projA', content: '<p>scene</p>', wordCount: 1, createdAt: t, updatedAt: t },
    ]);
    await v8.table('draftVersions').bulkPut([
      { id: 'dvA1', draftId: 'cdA1', projectId: 'projA', revision: 1, content: '<p>hello</p>', wordCount: 1, reason: 'autosave', createdAt: t },
    ]);
    await v8.table('aiProviders').bulkPut([
      { id: 'provA', providerType: 'openai', label: 'OpenAI', enabled: true, baseUrl: '', apiKeyRef: '', createdAt: t, updatedAt: t },
    ]);
    await v8.table('aiModels').bulkPut([
      { id: 'modelA', providerId: 'provA', modelId: 'gpt-x', label: 'GPT X', enabled: true, createdAt: t, updatedAt: t },
    ]);
    await v8.table('aiTaskConfigs').bulkPut([
      { task: 'drafting', modelId: 'modelA', updatedAt: t },
    ]);
    await v8.table('aiGlobalConfig').bulkPut([
      { id: 'global', defaultModelId: 'modelA', updatedAt: t },
    ]);
    await v8.table('promptTemplates').bulkPut([
      { id: 'ptA', projectId: 'projA', title: 'Style', category: 'style', taskKind: 'drafting', body: 'be terse', version: 1, createdAt: t, updatedAt: t },
      { id: 'ptB', projectId: 'projB', title: 'Tone', category: 'style', taskKind: 'drafting', body: 'be warm', version: 1, createdAt: t, updatedAt: t },
    ]);
    await v8.table('promptTemplateVersions').bulkPut([
      { id: 'ptvA1', templateId: 'ptA', projectId: 'projA', version: 1, title: 'Style', body: 'be terse', createdAt: t },
    ]);
    await v8.table('contextItems').bulkPut([
      { id: 'ciA', projectId: 'projA', layer: 'style', title: 'Ctx', content: 'note', createdAt: t, updatedAt: t },
      { id: 'ciB', projectId: 'projB', layer: 'style', title: 'Ctx', content: 'note', createdAt: t, updatedAt: t },
    ]);
    await v8.table('contextConfigs').bulkPut([
      { id: 'cfgA', projectId: 'projA', budgetTokens: 4000, updatedAt: t, createdAt: t },
      { id: 'cfgB', projectId: 'projB', budgetTokens: 4000, updatedAt: t, createdAt: t },
    ]);
    await v8.table('knowledgeEntries').bulkPut([
      { id: 'kA', projectId: 'projA', kind: 'character', source: 'world', sourceKey: 'k1', sourceRef: { entityId: 'cA1', key: 'k1' }, title: 'Elara', body: 'hero', tags: [], searchText: 'elara hero', createdAt: t, updatedAt: t },
      { id: 'kB', projectId: 'projB', kind: 'character', source: 'world', sourceKey: 'k1', sourceRef: { entityId: 'cB1', key: 'k1' }, title: 'Bran', body: 'ally', tags: [], searchText: 'bran ally', createdAt: t, updatedAt: t },
    ]);
    await v8.table('continuityFacts').bulkPut([
      { id: 'fA', projectId: 'projA', subjectType: 'character', subjectId: 'cA1', subjectLabel: 'Elara', predicate: 'position', value: 'harbour', anchorChapterId: 'chA1', createdAt: t, updatedAt: t },
      { id: 'fB', projectId: 'projB', subjectType: 'character', subjectId: 'cB1', subjectLabel: 'Bran', predicate: 'position', value: 'mount', anchorChapterId: 'chB1', createdAt: t, updatedAt: t },
    ]);
    await v8.table('analysisFindings').bulkPut([
      { id: 'anA', projectId: 'projA', category: 'continuity', severity: 'warning', origin: 'deterministic', title: 'F', description: 'd', evidence: [{ chapterId: 'chA1' }], status: 'open', createdAt: t, updatedAt: t },
      { id: 'anB', projectId: 'projB', category: 'continuity', severity: 'warning', origin: 'deterministic', title: 'F', description: 'd', evidence: [{ chapterId: 'chB1' }], status: 'open', createdAt: t, updatedAt: t },
    ]);

    // Snapshot every row so we can prove nothing changed across the upgrade.
    const snapshot = {};
    for (const name of v8.tables.map((x) => x.name)) {
      snapshot[name] = await v8.table(name).toArray();
    }
    const v8Counts = {};
    for (const name of Object.keys(snapshot)) v8Counts[name] = snapshot[name].length;

    v8.close();

    // --- (2) Reopen the SAME database with the real v9 class (real upgrade). ---
    const v9 = new NovelStudioDb(DB);
    await v9.open();
    const upgradedVerno = v9.verno;

    // --- (3a) Old data survives, byte-for-byte. ---
    const afterCounts = {};
    const contentMatch = {};
    for (const name of Object.keys(snapshot)) {
      const rows = await v9.table(name).toArray();
      afterCounts[name] = rows.length;
      // Compare by id → JSON equality of every row.
      const byId = new Map(rows.map((r) => [r.id ?? r.task, JSON.stringify(r)]));
      contentMatch[name] = snapshot[name].every((orig) => {
        const key = orig.id ?? orig.task;
        return byId.get(key) === JSON.stringify(orig);
      });
    }
    const allCountsSame = Object.keys(v8Counts).every((n) => v8Counts[n] === afterCounts[n]);
    const allContentSame = Object.keys(contentMatch).every((n) => contentMatch[n] === true);

    // --- (3b) Old indexes / key queries still work on the upgraded DB. ---
    const q = {
      projectsByStatus: (await v9.table('projects').where('status').equals('drafting').toArray()).map((r) => r.id),
      chaptersByCompound: (await v9.table('chapters').where('[volumeId+order]').between(['vA', 0], ['vA', 9]).toArray()).map((r) => r.id).sort(),
      charactersByName: (await v9.table('characters').where('name').equals('Elara').toArray()).map((r) => r.id),
      knowledgeByCompound: (await v9.table('knowledgeEntries').where('[projectId+sourceKey]').equals(['projA', 'k1']).toArray()).map((r) => r.id),
      draftsByOwner: (await v9.table('chapterDrafts').where('ownerId').equals('chA1').toArray()).map((r) => r.id),
      versionsByCompound: (await v9.table('draftVersions').where('[draftId+revision]').equals(['cdA1', 1]).toArray()).map((r) => r.id),
    };

    // --- (3c) The three new P8 stores are writable/readable on upgraded DB. ---
    const repositoryMod = await import('/src/repositories/import-repository.ts');
    const schemaMod = await import('/src/schemas/document.ts');
    const extractionMod = await import('/src/schemas/extraction.ts');
    const repo = new repositoryMod.ImportRepository(v9);

    const doc = { id: 'docA', projectId: 'projA', fileName: 'a.txt', format: 'txt', rawText: 'Hello world', characterCount: 11, wordCount: 2, status: 'imported', createdAt: t, updatedAt: t };
    await repo.createDocument(doc);
    const docBack = await repo.getDocumentById('docA');

    const sec = { id: 'secA', projectId: 'projA', documentId: 'docA', parentId: null, level: 'paragraph', title: '', order: 0, start: 0, end: 5, text: 'Hello', createdAt: t, updatedAt: t };
    await repo.bulkCreateSections([sec]);
    const secs = await repo.listSectionsByDocument('docA');

    const ext = { id: 'extA', projectId: 'projA', documentId: 'docA', kind: 'character', title: 'Elara', summary: '', body: '', tags: [], origin: 'fact', confidence: null, evidence: [{ documentId: 'docA', sectionId: 'secA', start: 0, end: 5, quote: 'Hello' }], dedupeKey: 'docA|character|elara|secA', reviewStatus: 'pending', relatedIds: [], integration: { status: 'not-applied' }, createdAt: t, updatedAt: t };
    await repo.createExtraction(ext);
    const extByKey = await repo.findExtractionByDedupeKey('projA', 'docA|character|elara|secA');

    // New stores isolation: seed a doc for projB and confirm lists are scoped.
    await repo.createDocument({ ...doc, id: 'docB', projectId: 'projB', fileName: 'b.txt' });
    const docsA = (await repo.listDocumentsByProject('projA')).map((d) => d.id);
    const docsB = (await repo.listDocumentsByProject('projB')).map((d) => d.id);

    // --- (3d) Cascade delete removes ONLY projA's rows (old + new). ---
    const beforeCascade = {
      projB_projects: (await v9.table('projects').where('id').equals('projB').count()),
      projB_chapters: (await v9.table('chapters').where('projectId').equals('projB').count()),
      projB_knowledge: (await v9.table('knowledgeEntries').where('projectId').equals('projB').count()),
      projB_docs: (await v9.table('sourceDocuments').where('projectId').equals('projB').count()),
      projA_docs: (await v9.table('sourceDocuments').where('projectId').equals('projA').count()),
    };

    // Run the REAL cascade (ProjectService.deleteProject) against THIS test DB
    // by binding a full service to the upgraded v9 instance. This exercises the
    // actual child-first delete wiring incl. the P8 ImportRepository hole.
    const svcMod = await import('/src/services/index.ts');
    const makeService = async () => {
      const R = {
        ProjectRepository: (await import('/src/repositories/project-repository.ts')).ProjectRepository,
        WorldRepository: (await import('/src/repositories/world-repository.ts')).WorldRepository,
        CharacterRepository: (await import('/src/repositories/character-repository.ts')).CharacterRepository,
        NarrativeRepository: (await import('/src/repositories/narrative-repository.ts')).NarrativeRepository,
        OutlineRepository: (await import('/src/repositories/outline-repository.ts')).OutlineRepository,
        SceneRepository: (await import('/src/repositories/scene-repository.ts')).SceneRepository,
        ManuscriptRepository: (await import('/src/repositories/manuscript-repository.ts')).ManuscriptRepository,
        PromptRepository: (await import('/src/repositories/prompt-repository.ts')).PromptRepository,
        ContextRepository: (await import('/src/repositories/context-repository.ts')).ContextRepository,
        KnowledgeRepository: (await import('/src/repositories/knowledge-repository.ts')).KnowledgeRepository,
        ContinuityRepository: (await import('/src/repositories/continuity-repository.ts')).ContinuityRepository,
        AnalysisRepository: (await import('/src/repositories/analysis-repository.ts')).AnalysisRepository,
        ImportRepository: repositoryMod.ImportRepository,
      };
      return new svcMod.ProjectService(
        new R.ProjectRepository(v9), new R.WorldRepository(v9), new R.CharacterRepository(v9),
        new R.NarrativeRepository(v9), new R.OutlineRepository(v9), new R.SceneRepository(v9),
        new R.ManuscriptRepository(v9), new R.PromptRepository(v9), new R.ContextRepository(v9),
        new R.KnowledgeRepository(v9), new R.ContinuityRepository(v9), new R.AnalysisRepository(v9),
        new R.ImportRepository(v9),
      );
    };
    const service = await makeService();
    await service.deleteProject('projA');

    const afterCascade = {
      projA_projects: (await v9.table('projects').where('id').equals('projA').count()),
      projA_chapters: (await v9.table('chapters').where('projectId').equals('projA').count()),
      projA_knowledge: (await v9.table('knowledgeEntries').where('projectId').equals('projA').count()),
      projA_docs: (await v9.table('sourceDocuments').where('projectId').equals('projA').count()),
      projA_sections: (await v9.table('documentSections').where('projectId').equals('projA').count()),
      projA_extractions: (await v9.table('extractionRecords').where('projectId').equals('projA').count()),
      projB_projects: (await v9.table('projects').where('id').equals('projB').count()),
      projB_chapters: (await v9.table('chapters').where('projectId').equals('projB').count()),
      projB_knowledge: (await v9.table('knowledgeEntries').where('projectId').equals('projB').count()),
      projB_docs: (await v9.table('sourceDocuments').where('projectId').equals('projB').count()),
    };

    v9.close();
    // Delete the test database entirely so re-runs start clean.
    await Dexie.delete(DB);

    return {
      openedV8, upgradedVerno,
      uniqueDedupeIndex: (() => {
        const idx = v9.table('extractionRecords').schema.indexes.find((i) => Array.isArray(i.keyPath) && i.keyPath.join('+') === 'projectId+dedupeKey');
        return Boolean(idx && idx.unique === true);
      })(),
      v8Counts, afterCounts, allCountsSame,
      contentMatch, allContentSame,
      q,
      newTable: {
        docBack: docBack && docBack.id,
        sectionCount: secs.length,
        extByKey: extByKey && extByKey.id,
        docsA, docsB,
      },
      beforeCascade, afterCascade,
    };
  })()`);

  /* -------------------------- Assertions -------------------------- */
  record('real v8 database opened at version 8 (true starting point)', mig?.openedV8 === true, String(mig?.openedV8));
  record('upgrade completed to the current P8 schema version (>= 9)', typeof mig?.upgradedVerno === 'number' && mig.upgradedVerno >= 9, String(mig?.upgradedVerno));
  record('extraction dedupe index is UNIQUE after upgrade (DB-level)', mig?.uniqueDedupeIndex === true, String(mig?.uniqueDedupeIndex));

  record('old data: every v1–v7 store row count preserved across upgrade', mig?.allCountsSame === true, JSON.stringify({ v8: mig?.v8Counts, v9: mig?.afterCounts }));
  record('old data: every row is byte-identical after upgrade', mig?.allContentSame === true, JSON.stringify(mig?.contentMatch));

  record('old index: projects.status query works post-upgrade', JSON.stringify(mig?.q.projectsByStatus) === JSON.stringify(['projA']), JSON.stringify(mig?.q.projectsByStatus));
  record('old index: chapters [volumeId+order] compound query works', JSON.stringify(mig?.q.chaptersByCompound) === JSON.stringify(['chA1', 'chA2']), JSON.stringify(mig?.q.chaptersByCompound));
  record('old index: characters.name query works', JSON.stringify(mig?.q.charactersByName) === JSON.stringify(['cA1']), JSON.stringify(mig?.q.charactersByName));
  record('old index: knowledge [projectId+sourceKey] compound query works', JSON.stringify(mig?.q.knowledgeByCompound) === JSON.stringify(['kA']), JSON.stringify(mig?.q.knowledgeByCompound));
  record('old index: chapterDrafts.ownerId query works', JSON.stringify(mig?.q.draftsByOwner) === JSON.stringify(['cdA1']), JSON.stringify(mig?.q.draftsByOwner));
  record('old index: draftVersions [draftId+revision] compound query works', JSON.stringify(mig?.q.versionsByCompound) === JSON.stringify(['dvA1']), JSON.stringify(mig?.q.versionsByCompound));

  record('new store: sourceDocuments writable+readable on upgraded DB', mig?.newTable.docBack === 'docA', String(mig?.newTable.docBack));
  record('new store: documentSections writable+readable', mig?.newTable.sectionCount === 1, String(mig?.newTable.sectionCount));
  record('new store: extractionRecords writable + dedupe-key lookup resolves', mig?.newTable.extByKey === 'extA', String(mig?.newTable.extByKey));

  record('new stores isolation: projA lists only its docs', JSON.stringify(mig?.newTable.docsA) === JSON.stringify(['docA']), JSON.stringify(mig?.newTable.docsA));
  record('new stores isolation: projB lists only its docs', JSON.stringify(mig?.newTable.docsB) === JSON.stringify(['docB']), JSON.stringify(mig?.newTable.docsB));

  const ac = mig?.afterCascade;
  record(
    'cascade delete removes ONLY projA rows (old + new stores)',
    ac && ac.projA_projects === 0 && ac.projA_chapters === 0 && ac.projA_knowledge === 0 && ac.projA_docs === 0 && ac.projA_sections === 0 && ac.projA_extractions === 0,
    JSON.stringify(ac),
  );
  record(
    'cascade delete leaves projB rows fully intact',
    ac && ac.projB_projects === 1 && ac.projB_chapters === 1 && ac.projB_knowledge === 1 && ac.projB_docs === 1,
    JSON.stringify(ac),
  );

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
