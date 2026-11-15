/**
 * P9 Batch 4-3 �?Project Backup RESTORE: PURE logic tests.
 *
 * Exercises the REAL `ProjectRestoreService` (bundled from source) against an
 * in-memory fake database behind the REAL `TransferService` and a REAL
 * `ProjectService`/`SnapshotService` bound to the SAME fake db. Real backup
 * payloads are produced with the REAL `BackupService.exportProjectFile`.
 *
 * The fake DB implements just enough Dexie surface (bulkGet / bulkPut /
 * where().delete() / a rollback-capable `transaction`) to exercise the PURE
 * logic of the restore service. Real IndexedDB atomicity/rollback is proven by
 * the separate IDB test, not here.
 *
 * Usage: npm run verify:backup:restore
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

const ALL_STORES = [
  'projects', 'worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes',
  'chapterDrafts', 'sceneDrafts', 'draftVersions', 'promptTemplates', 'promptTemplateVersions',
  'contextItems', 'contextConfigs', 'knowledgeEntries', 'continuityFacts', 'analysisFindings',
  'sourceDocuments', 'documentSections', 'extractionRecords', 'projectSnapshots',
];

function createFakeDb() {
  const map = {};
  for (const name of ALL_STORES) map[name] = new Map();

  const rowsOf = (name) => [...map[name].values()];

  function tableApi(name) {
    return {
      get: async (id) => map[name].get(id),
      bulkGet: async (ids) => ids.map((id) => map[name].get(id)),
      toArray: async () => rowsOf(name),
      put: async (row) => {
        map[name].set(row.id, row);
        return row.id;
      },
      add: async (row) => {
        map[name].set(row.id, row);
        return row.id;
      },
      bulkPut: async (rows) => {
        for (const r of rows) map[name].set(r.id, r);
        return rows.map((r) => r.id);
      },
      bulkDelete: async (ids) => {
        for (const id of ids) map[name].delete(id);
      },
      delete: async (id) => {
        map[name].delete(id);
      },
      where: (col) => ({
        equals: (value) => ({
          toArray: async () => rowsOf(name).filter((r) => r[col] === value),
          count: async () => rowsOf(name).filter((r) => r[col] === value).length,
          first: async () => rowsOf(name).find((r) => r[col] === value),
          delete: async () => {
            let n = 0;
            for (const [id, r] of map[name]) {
              if (r[col] === value) {
                map[name].delete(id);
                n += 1;
              }
            }
            return n;
          },
        }),
        anyOf: (values) => ({ toArray: async () => rowsOf(name).filter((r) => values.includes(r[col])) }),
      }),
    };
  }

  const db = { _map: map };
  for (const name of ALL_STORES) db[name] = tableApi(name);

  // Rollback-capable transaction (real atomicity is covered by the IDB test).
  db.transaction = async (_mode, _tables, fn) => {
    const snapshot = {};
    for (const name of ALL_STORES) snapshot[name] = new Map(map[name]);
    try {
      return await fn();
    } catch (error) {
      for (const name of ALL_STORES) {
        map[name].clear();
        for (const [k, v] of snapshot[name]) map[name].set(k, v);
      }
      throw error;
    }
  };

  return db;
}

const T0 = 1_700_000_000_000;

function buildFixture(projectId, title = 'Fixture') {
  const project = {
    id: projectId, title, description: 'Fixture.', status: 'writing',
    genre: ['fantasy'], tags: ['test'], settings: { language: 'en' }, createdAt: T0, updatedAt: T0 + 1000,
  };
  const world = {
    id: 'world_1', projectId, title: 'The Setting', overview: 'A world.',
    sections: [{ id: 'wsec_1', title: 'Geography', content: 'Mountains.' }],
    themes: ['hope'], settings: {}, createdAt: T0, updatedAt: T0,
  };
  const charA = {
    id: 'char_A', projectId, name: 'Elara', summary: 'Brave.', background: '', personality: '',
    motivation: '', appearance: '', role: 'protagonist', status: 'active', tags: [], createdAt: T0, updatedAt: T0,
  };
  const charB = { ...charA, id: 'char_B', name: 'Aria' };
  const narrativePlan = {
    id: 'narr_1', projectId, logline: '', theme: '', premise: '', centralConflict: '', stakes: '', ending: '',
    structure: 'three-act', status: 'draft',
    beats: [{ id: 'beat_1', title: 'Inciting incident', description: 'It begins.', position: 10 }],
    motifs: [], createdAt: T0, updatedAt: T0,
  };
  const volume = { id: 'vol_1', projectId, title: 'Volume One', summary: '', createdAt: T0, updatedAt: T0 };
  const chapter = {
    id: 'chap_1', volumeId: 'vol_1', projectId, title: 'Chapter One', order: 0, summary: '', goal: '',
    keyEvents: '', endingHook: '', status: 'drafted', plotBeatId: 'beat_1', characterIds: ['char_A', 'char_B'],
    tags: [], createdAt: T0, updatedAt: T0,
  };
  const scene = {
    id: 'scene_1', chapterId: 'chap_1', projectId, title: 'Opening', order: 0, summary: '', location: '',
    timeOfDay: '', povCharacterId: 'char_A', characterIds: ['char_A'], goal: '', conflict: '', turningPoint: '',
    outcome: '', purpose: 'setup', status: 'drafted', tags: [], createdAt: T0, updatedAt: T0,
  };
  const chapterDraft = {
    id: 'cdraft_1', projectId, ownerId: 'chap_1', kind: 'chapter',
    content: 'Elara walked into the forest.', plainText: 'Elara walked into the forest.',
    wordCount: 6, characterCount: 29, revision: 2, createdAt: T0, updatedAt: T0,
  };
  const sceneDraft = {
    id: 'sdraft_1', projectId, ownerId: 'scene_1', kind: 'scene',
    content: 'Elara drew her blade.', plainText: 'Elara drew her blade.',
    wordCount: 5, characterCount: 22, revision: 3, createdAt: T0, updatedAt: T0,
  };
  const versionChapter = {
    id: 'dver_1', draftId: 'cdraft_1', projectId, kind: 'chapter', revision: 1,
    content: 'Elara walked.', wordCount: 2, reason: 'auto', label: '', createdAt: T0,
  };
  const versionScene = {
    id: 'dver_2', draftId: 'sdraft_1', projectId, kind: 'scene', revision: 2,
    content: 'Elara drew.', wordCount: 2, reason: 'manual', label: '', createdAt: T0,
  };
  const variable = { name: 'chapterTitle', description: '', required: false };
  const template = {
    id: 'ptpl_1', projectId, name: 'Continue', description: '', category: 'Continuation',
    content: 'Continue from {{chapterTitle}}', variables: [variable], taskKind: 'continue',
    providerId: null, modelId: null, isDefault: true, enabled: true, currentVersionId: 'ptv_1', version: 1,
    createdAt: T0, updatedAt: T0,
  };
  const templateVersion = {
    id: 'ptv_1', templateId: 'ptpl_1', projectId, version: 1, name: 'Continue', description: '',
    category: 'Continuation', content: 'Continue from {{chapterTitle}}', variables: [variable],
    taskKind: 'continue', reason: 'created', label: '', createdAt: T0,
  };
  const contextItem = {
    id: 'ctx_1', projectId, layer: 'instructions', sourceType: 'instruction', sourceId: null,
    sourceLabel: '', content: 'Write with restraint.', priority: 'normal', enabled: true, persistent: true,
    createdAt: T0, updatedAt: T0,
  };
  const contextConfig = {
    id: 'ctxcfg_1', projectId, budgetEnabled: true, inputBudgetTokens: 8000, contextWindowOverrideTokens: null,
    requestedOutputTokens: 2048, enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
    persistentInstructions: '', createdAt: T0, updatedAt: T0,
  };
  const knowledgeEntry = {
    id: 'know_1', projectId, kind: 'character', title: 'Elara', summary: '', body: '', tags: [],
    source: 'manual', sourceRef: { entityType: 'manual', entityId: null, key: null }, sourceKey: null,
    evidence: [{ chapterId: 'chap_1', sceneId: 'scene_1', quote: '', offset: null, note: '' }],
    searchText: 'elara', createdAt: T0, updatedAt: T0,
  };
  const continuityFact = {
    id: 'cont_1', projectId, subjectType: 'character', subjectId: 'char_A', subjectLabel: 'Elara',
    predicate: 'position', value: 'the forest', relatedLabel: '', anchorChapterId: 'chap_1',
    anchorSceneId: 'scene_1', anchorRank: 0,
    evidence: [{ chapterId: 'chap_1', sceneId: null, quote: '', offset: null, note: '' }],
    createdAt: T0, updatedAt: T0,
  };
  const analysisFinding = {
    id: 'find_1', projectId, category: 'continuity', severity: 'warning', status: 'open',
    origin: 'deterministic', title: 'Possible issue', description: 'Looks inconsistent.',
    evidence: [{ chapterId: 'chap_1', sceneId: null, quote: '', offset: null, note: '' }],
    relatedFactIds: ['cont_1'], relatedEntryIds: ['know_1'], createdAt: T0, updatedAt: T0,
  };
  const rawText = '# Chapter\n\nElara walked into the forest.\n';
  const sourceDocument = {
    id: 'doc_1', projectId, fileName: null, format: 'markdown', rawText,
    characterCount: rawText.length, wordCount: 5, status: 'extracted', parsedAt: T0,
    parsedTextHash: 'sha256:abc', structureConfirmedAt: T0, createdAt: T0, updatedAt: T0,
  };
  const proseStart = rawText.indexOf('Elara');
  const proseEnd = rawText.length - 1;
  const sectionRoot = {
    id: 'dsec_root', projectId, documentId: 'doc_1', parentId: null, level: 'chapter', title: 'Chapter',
    order: 0, start: 0, end: rawText.length, text: rawText, createdAt: T0, updatedAt: T0,
  };
  const sectionProse = {
    id: 'dsec_prose', projectId, documentId: 'doc_1', parentId: 'dsec_root', level: 'paragraph', title: '',
    order: 1, start: proseStart, end: proseEnd, text: rawText.slice(proseStart, proseEnd),
    createdAt: T0, updatedAt: T0,
  };
  const extraction = {
    id: 'ext_1', projectId, documentId: 'doc_1', kind: 'character', title: 'Elara', summary: '', body: '',
    tags: [], origin: 'manual', confidence: null,
    evidence: [{ documentId: 'doc_1', sectionId: 'dsec_prose', start: 0, end: 5, quote: 'Elara' }],
    dedupeKey: 'doc_1|character|elara|dsec_prose', reviewStatus: 'confirmed', relatedIds: ['char_A'],
    integration: { status: 'applied', appliedEntityType: 'character', appliedEntityId: 'char_A', appliedAt: T0 },
    integrationAudit: {
      previewFingerprint: 'pf', recordFingerprint: 'rf', documentHash: 'sha256:abc',
      fieldStrategies: {}, resolutions: [], appliedAt: T0,
    },
    createdAt: T0, updatedAt: T0,
  };

  return {
    project,
    data: {
      worlds: [world], characters: [charA, charB], narrativePlans: [narrativePlan], volumes: [volume],
      chapters: [chapter], scenes: [scene], chapterDrafts: [chapterDraft], sceneDrafts: [sceneDraft],
      draftVersions: [versionChapter, versionScene], promptTemplates: [template],
      promptTemplateVersions: [templateVersion], contextItems: [contextItem], contextConfigs: [contextConfig],
      knowledgeEntries: [knowledgeEntry], continuityFacts: [continuityFact], analysisFindings: [analysisFinding],
      sourceDocuments: [sourceDocument], documentSections: [sectionRoot, sectionProse],
      extractionRecords: [extraction],
    },
  };
}

function seed(db, fixture) {
  db._map.projects.set(fixture.project.id, fixture.project);
  for (const [key, rows] of Object.entries(fixture.data)) {
    for (const r of rows) db._map[key].set(r.id, r);
  }
}

function reown(fixture, projectId) {
  fixture.project.id = projectId;
  for (const rows of Object.values(fixture.data)) rows.forEach((r) => { r.projectId = projectId; });
  return fixture;
}

function dumpStore(db, name, projectId) {
  return [...db._map[name].values()].filter((r) => r.projectId === projectId).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function dumpAll(db, exclude = []) {
  const out = {};
  for (const name of ALL_STORES) {
    if (exclude.includes(name)) continue;
    out[name] = [...db._map[name].values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  return JSON.stringify(out);
}

(async () => {
  let restoreMod, backupMod, transferMod, snapshotMod, projectMod, projectRepoMod;
  try {
    restoreMod = await importBundled('src/services/project-restore-service.ts', 'p9-restore', { alias: ALIAS });
    backupMod = await importBundled('src/services/backup-service.ts', 'p9-restore-export', { alias: ALIAS });
    transferMod = await importBundled('src/transfer/index.ts', 'p9-restore-transfer', { alias: ALIAS });
    snapshotMod = await importBundled('src/services/snapshot-service.ts', 'p9-restore-snapshot', { alias: ALIAS });
    projectMod = await importBundled('src/services/project-service.ts', 'p9-restore-project', { alias: ALIAS });
    projectRepoMod = await importBundled('src/repositories/project-repository.ts', 'p9-restore-projrepo', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle the restore service:\n', error);
    process.exit(1);
  }

  const { ProjectRestoreService, ProjectRestoreError } = restoreMod;
  const { BackupService } = backupMod;
  const { TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS } = transferMod;
  const { SnapshotService } = snapshotMod;
  const { ProjectService } = projectMod;
  const { ProjectRepository } = projectRepoMod;

  const makeEnv = (projectId = 'proj_src', title = 'Source Project') => {
    const db = createFakeDb();
    const fixture = buildFixture(projectId, title);
    seed(db, fixture);
    const adapter = () => new TransferRepositoryAdapter(db);
    const exporter = new BackupService(new TransferService(adapter()));
    const snapshots = new SnapshotService(db);
    const projects = new ProjectService(new ProjectRepository(db));
    let seq = 1;
    const restore = new ProjectRestoreService(db, snapshots, projects, () => `proj_new_${seq++}`);
    return { db, fixture, exporter, snapshots, projects, restore };
  };

  try {
    /* 1. Restore-as-new: fresh root id + full remap */
    {
      const { db, fixture, exporter, snapshots, projects } = makeEnv('proj_src', 'Source Project');
      const file = await exporter.exportProjectFile('proj_src');
      const entry = JSON.parse(file.content).projects[0];
      const entryBefore = JSON.stringify(entry);
      const srcRowsBefore = JSON.stringify(dumpStore(db, 'chapters', 'proj_src'));

      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_fresh_1');
      const result = await restore.restoreAsNewProject(entry, { now: T0 + 5000 });

      eq('as-new: mode is new', result.mode, 'new');
      eq('as-new: fresh project id', result.projectId, 'proj_fresh_1');
      check('as-new: fresh id differs from source', result.projectId !== 'proj_src');
      eq('as-new: result project id matches', result.project.id, 'proj_fresh_1');
      eq('as-new: root createdAt is injected clock', result.project.createdAt, T0 + 5000);
      eq('as-new: no safety snapshot', result.safetySnapshot, null);

      for (const c of TRANSFER_COLLECTIONS) {
        eq(`as-new: ${c.key} count matches source`, dumpStore(db, c.key, 'proj_fresh_1').length, fixture.data[c.key].length);
      }

      const newVols = new Set(dumpStore(db, 'volumes', 'proj_fresh_1').map((v) => v.id));
      const newChaps = dumpStore(db, 'chapters', 'proj_fresh_1');
      check('as-new: chapter references a new volume', newChaps.every((c) => newVols.has(c.volumeId)));
      const newChars = new Set(dumpStore(db, 'characters', 'proj_fresh_1').map((c) => c.id));
      check('as-new: chapter.characterIds reference new characters', newChaps.every((c) => c.characterIds.every((id) => newChars.has(id))));
      const newPlans = dumpStore(db, 'narrativePlans', 'proj_fresh_1');
      const beatIds = new Set(newPlans.flatMap((p) => p.beats.map((b) => b.id)));
      check('as-new: chapter.plotBeatId references a new beat', newChaps.every((c) => !c.plotBeatId || beatIds.has(c.plotBeatId)));
      const newDocs = new Set(dumpStore(db, 'sourceDocuments', 'proj_fresh_1').map((d) => d.id));
      const newExt = dumpStore(db, 'extractionRecords', 'proj_fresh_1');
      check('as-new: extraction.documentId references a new document', newExt.every((e) => newDocs.has(e.documentId)));

      // No restored row retains a source-owned id for the new project.
      let anySourceId = false;
      const srcIds = new Set(fixture.data.chapters.map((c) => c.id));
      for (const c of newChaps) if (srcIds.has(c.id)) anySourceId = true;
      check('as-new: no chapter kept a source chapter id', !anySourceId);

      // Source project remains byte-identical.
      eq('as-new: source chapters unchanged', JSON.stringify(dumpStore(db, 'chapters', 'proj_src')), srcRowsBefore);
      eq('as-new: source root unchanged', JSON.stringify(db._map.projects.get('proj_src')), JSON.stringify(fixture.project));
      eq('as-new: imported entry NOT mutated', JSON.stringify(entry), entryBefore);
    }

    /* 2. Restore-as-new does not disturb other projects */
    {
      const { db, exporter, snapshots, projects } = makeEnv('proj_a', 'A');
      const f2 = reown(buildFixture('proj_b', 'B'), 'proj_b');
      seed(db, f2);
      const bBefore = JSON.stringify(dumpStore(db, 'characters', 'proj_b'));
      const file = await exporter.exportProjectFile('proj_a');
      const entry = JSON.parse(file.content).projects[0];
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_a_new');
      await restore.restoreAsNewProject(entry);
      eq('as-new: unrelated project B unchanged', JSON.stringify(dumpStore(db, 'characters', 'proj_b')), bBefore);
      eq('as-new: project A still present', db._map.projects.has('proj_a'), true);
    }

    /* 3. Replace-existing: root→target, createdAt preserved, rows replaced */
    {
      const { db, snapshots, projects } = makeEnv('proj_src2', 'Backup Source');
      const adapter = () => new TransferRepositoryAdapter(db);
      const exporter = new BackupService(new TransferService(adapter()));
      const file = await exporter.exportProjectFile('proj_src2');
      const entry = JSON.parse(file.content).projects[0];
      const srcFixture = buildFixture('proj_src2');
      const srcCounts = Object.fromEntries(TRANSFER_COLLECTIONS.map((c) => [c.key, srcFixture.data[c.key].length]));

      const targetId = 'proj_target';
      db._map.projects.set(targetId, {
        id: targetId, title: 'Old Target', description: 'old', status: 'planning',
        genre: [], tags: [], settings: {}, createdAt: T0 - 99999, updatedAt: T0 - 5000,
      });
      db._map.characters.set('char_target_1', { ...srcFixture.data.characters[0], id: 'char_target_1', projectId: targetId, name: 'Target Character' });
      db._map.volumes.set('vol_target_1', { ...srcFixture.data.volumes[0], id: 'vol_target_1', projectId: targetId, title: 'Target Volume' });

      let seq = 1;
      const restore = new ProjectRestoreService(db, snapshots, projects, () => `proj_unused_${seq++}`);
      const result = await restore.replaceExistingProject(entry, targetId, { now: T0 + 7000 });

      eq('replace: mode is replace', result.mode, 'replace');
      eq('replace: projectId is target', result.projectId, targetId);
      check('replace: safety snapshot created', result.safetySnapshot && typeof result.safetySnapshot.id === 'string');
      const root = db._map.projects.get(targetId);
      eq('replace: root id preserved', root.id, targetId);
      eq('replace: root createdAt preserved', root.createdAt, T0 - 99999);
      eq('replace: root updatedAt = injected clock', root.updatedAt, T0 + 7000);
      eq('replace: root title from backup', root.title, 'Backup Source');

      check('replace: target-only character removed', !db._map.characters.has('char_target_1'));
      check('replace: target-only volume removed', !db._map.volumes.has('vol_target_1'));

      for (const c of TRANSFER_COLLECTIONS) {
        eq(`replace: ${c.key} owned count equals backup`, dumpStore(db, c.key, targetId).length, srcCounts[c.key]);
      }
      const tgtVols = new Set(dumpStore(db, 'volumes', targetId).map((v) => v.id));
      const tgtChaps = dumpStore(db, 'chapters', targetId);
      check('replace: chapter references target-owned volume', tgtChaps.every((c) => tgtVols.has(c.volumeId)));

      // Snapshot preserved outside the transaction (still in projectSnapshots).
      eq('replace: safety snapshot remains in projectSnapshots', [...db._map.projectSnapshots.values()].length, 1);
    }

    /* 4. Replace preserves other projects byte-identically */
    {
      const { db, snapshots, projects } = makeEnv('proj_src3', 'Backup Source 3');
      const other = reown(buildFixture('proj_other', 'Other'), 'proj_other');
      seed(db, other);
      const targetId = 'proj_tgt3';
      db._map.projects.set(targetId, { id: targetId, title: 'Old', description: '', status: 'planning', genre: [], tags: [], settings: {}, createdAt: T0 - 1, updatedAt: T0 - 1 });
      const otherBefore = JSON.stringify(dumpStore(db, 'characters', 'proj_other'));
      const adapter = () => new TransferRepositoryAdapter(db);
      const exporter = new BackupService(new TransferService(adapter()));
      const entry = JSON.parse((await exporter.exportProjectFile('proj_src3')).content).projects[0];
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_tgt3b');
      await restore.replaceExistingProject(entry, targetId);
      eq('replace: unrelated project rows unchanged', JSON.stringify(dumpStore(db, 'characters', 'proj_other')), otherBefore);
    }

    /* 5. Tampered payload rejected before writes */
    {
      const { db, snapshots, projects } = makeEnv('proj_bad', 'Bad');
      const adapter = () => new TransferRepositoryAdapter(db);
      const file = await new BackupService(new TransferService(adapter())).exportProjectFile('proj_bad');
      const pkg = JSON.parse(file.content);
      pkg.projects[0].data.characters[0].name = 'Tampered';
      const before = dumpAll(db);
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_x');
      let err = null;
      try { await restore.restoreAsNewProject(pkg.projects[0]); } catch (e) { err = e; }
      check('tampered: throws ProjectRestoreError', err instanceof ProjectRestoreError);
      eq('tampered: precheck phase', err && err.phase, 'precheck');
      check('tampered: code is integrity-failed or invalid-payload', err && (err.code === 'integrity-failed' || err.code === 'invalid-payload'), err && err.code);
      eq('tampered: DB unchanged', dumpAll(db), before);
    }

    /* 6. Stale target rejected */
    {
      const { db, snapshots, projects } = makeEnv('proj_st', 'Stale');
      const adapter = () => new TransferRepositoryAdapter(db);
      const entry = JSON.parse((await new BackupService(new TransferService(adapter())).exportProjectFile('proj_st')).content).projects[0];
      const before = dumpAll(db);
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_y');
      let err = null;
      try { await restore.replaceExistingProject(entry, 'proj_does_not_exist'); } catch (e) { err = e; }
      check('stale-target: throws ProjectRestoreError', err instanceof ProjectRestoreError);
      eq('stale-target: code is target-not-found', err && err.code, 'target-not-found');
      eq('stale-target: DB unchanged', dumpAll(db), before);
    }

    /* 7. Empty target id rejected */
    {
      const { db, snapshots, projects } = makeEnv('proj_et', 'EmptyTarget');
      const adapter = () => new TransferRepositoryAdapter(db);
      const entry = JSON.parse((await new BackupService(new TransferService(adapter())).exportProjectFile('proj_et')).content).projects[0];
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_z');
      let err = null;
      try { await restore.replaceExistingProject(entry, '   '); } catch (e) { err = e; }
      check('empty-target: rejected', err instanceof ProjectRestoreError);
      eq('empty-target: code is target-not-found', err && err.code, 'target-not-found');
    }

    /* 8. Secrets excluded */
    {
      const { db, snapshots, projects } = makeEnv('proj_sec', 'Secrets');
      const adapter = () => new TransferRepositoryAdapter(db);
      const file = await new BackupService(new TransferService(adapter())).exportProjectFile('proj_sec');
      check('secrets: exported file has no aiProviders', !/"aiProviders"/.test(file.content));
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_sec_new');
      await restore.restoreAsNewProject(JSON.parse(file.content).projects[0]);
      check('secrets: no aiProviders introduced by restore', !/apiKey/i.test(dumpAll(db)));
    }

    /* 9. Typed safety-snapshot failure preserves cause, writes nothing */
    {
      const { db, projects } = makeEnv('proj_cause', 'Cause');
      const failingSnapshots = {
        async createSnapshot() {
          const e = new Error('quota blown');
          e.name = 'QuotaExceededError';
          throw e;
        },
      };
      const adapter = () => new TransferRepositoryAdapter(db);
      const entry = JSON.parse((await new BackupService(new TransferService(adapter())).exportProjectFile('proj_cause')).content).projects[0];
      const restore = new ProjectRestoreService(db, failingSnapshots, projects, () => 'proj_cause_new');
      const before = dumpAll(db);
      let err = null;
      try { await restore.replaceExistingProject(entry, 'proj_cause'); } catch (e) { err = e; }
      check('safety-fail: throws ProjectRestoreError', err instanceof ProjectRestoreError);
      eq('safety-fail: code is safety-snapshot-failed', err && err.code, 'safety-snapshot-failed');
      eq('safety-fail: phase is safety-snapshot', err && err.phase, 'safety-snapshot');
      check('safety-fail: original cause preserved', err && err.cause && err.cause.name === 'QuotaExceededError');
      eq('safety-fail: nothing written', dumpAll(db), before);
    }

    /* 10. Transaction failure rolls back (fake tx) �?target unchanged */
    {
      const { db, snapshots, projects } = makeEnv('proj_rb', 'Rollback');
      // Second project used as the target.
      const targetId = 'proj_rb_target';
      db._map.projects.set(targetId, { id: targetId, title: 'Tgt', description: '', status: 'planning', genre: [], tags: [], settings: {}, createdAt: T0 - 2, updatedAt: T0 - 2 });
      db._map.characters.set('char_rb_keep', { ...buildFixture('x').data.characters[0], id: 'char_rb_keep', projectId: targetId });
      const adapter = () => new TransferRepositoryAdapter(db);
      const entry = JSON.parse((await new BackupService(new TransferService(adapter())).exportProjectFile('proj_rb')).content).projects[0];
      // Make the transaction throw AFTER the safety snapshot by failing bulkPut.
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_rb_new');
            const realBulkPut = db.characters.bulkPut;
      db.characters.bulkPut = async () => { throw new Error('simulated mid-tx failure'); };
      // Exclude snapshots: the safety snapshot is written BEFORE the tx and MUST
      // survive a rollback (that is the whole point of taking it first).
      const before = dumpAll(db, ['projectSnapshots']);
      let err = null;
      try { await restore.replaceExistingProject(entry, targetId); } catch (e) { err = e; }
      db.characters.bulkPut = realBulkPut;
      check('tx-fail: throws ProjectRestoreError', err instanceof ProjectRestoreError);
      eq('tx-fail: phase is transaction', err && err.phase, 'transaction');
            eq('tx-fail: all project data rolled back to pre-write state', dumpAll(db, ['projectSnapshots']), before);
      check('tx-fail: safety snapshot survived the rollback', [...db._map.projectSnapshots.values()].length === 1);
    }

    /* 11. Replace mode: the synthetic unchanged-root reference marker is
     *     benignly filtered (root id UNCHANGED legitimately yields a
     *     `projectId` "unresolved" marker that must NOT reject the restore). */
    {
      const { db, snapshots, projects } = makeEnv('proj_marker', 'Marker Source');
      const adapter = () => new TransferRepositoryAdapter(db);
      const entry = JSON.parse((await new BackupService(new TransferService(adapter())).exportProjectFile('proj_marker')).content).projects[0];
      const targetId = 'proj_marker'; // SAME id as source root → root id unchanged
      // The source project already exists (seeded by makeEnv under proj_marker),
      // so replacing it keeps the root id identical — this is exactly the case
      // that produces the synthetic `projectId` unresolved marker.
            let err = null;
      let result = null;
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'unused');
      try {
        result = await restore.replaceExistingProject(entry, targetId, { now: T0 + 9000 });
      } catch (e) { err = e; }
      check('marker: replace with UNCHANGED root id succeeds (synthetic projectId marker filtered, no throw)', err === null, err ? String(err) : '');
      check('marker: no dangling-reference problem surfaced', !(err && err.problems && err.problems.some((p) => p.code === 'dangling-reference')), err && JSON.stringify(err.problems || []));
      check('marker: result is a replace of the same id', result && result.mode === 'replace' && result.projectId === targetId, result && result.mode);
    }

    /* 12. A GENUINE dangling reference is rejected (not silently dropped). */
    {
      const { db, snapshots, projects } = makeEnv('proj_dangle', 'Dangle Source');
      const adapter = () => new TransferRepositoryAdapter(db);
      const pkg = JSON.parse((await new BackupService(new TransferService(adapter())).exportProjectFile('proj_dangle')).content);
      const entry = pkg.projects[0];
      // Point a chapter at a NON-EXISTENT volume and RECOMPUTE integrity so the
      // ONLY defect is the genuine dangling reference (not an integrity mismatch).
      entry.data.chapters[0].volumeId = 'vol_does_not_exist';
      const { computeIntegrity } = transferMod;
      entry.integrity = computeIntegrity({ project: entry.project, data: entry.data });
      // Integrity now passes, so the rejection MUST come from reference validation.
      const before = dumpAll(db);
      const restore = new ProjectRestoreService(db, snapshots, projects, () => 'proj_dangle_new');
      let err = null;
      try { await restore.restoreAsNewProject(entry); } catch (e) { err = e; }
      check('dangling: genuine dangling reference is rejected', err instanceof ProjectRestoreError, err ? String(err) : 'did not throw');
      eq('dangling: code is invalid-payload', err && err.code, 'invalid-payload');
      eq('dangling: rejected in precheck (nothing written)', err && err.phase, 'precheck');
      eq('dangling: DB unchanged', dumpAll(db), before);
    }
  } finally {
    cleanupTemp();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exit(1);
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
