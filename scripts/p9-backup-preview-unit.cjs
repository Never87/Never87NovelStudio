/**
 * P9 Batch 4-2 — Project Backup IMPORT / PARSE / PREVIEW: PURE logic tests.
 *
 * Exercises the REAL `BackupPreviewService` (bundled from source) against an
 * in-memory fake database behind the REAL `TransferService`/
 * `TransferRepositoryAdapter`. Real backups are produced with the REAL
 * `BackupService.exportProjectFile`, then fed to the preview service exactly as a
 * user-selected file would be.
 *
 * Covers: valid preview; 19 collection counts; total count; metadata & digest;
 * existing-project detection; nonexistent-project handling; malformed JSON;
 * invalid structure; missing collection; digest mismatch; unsupported version;
 * workspace rejection; dangling reference / ownership violation; file size &
 * empty input; typed errors; and that parsing never mutates the input.
 *
 * The TypeScript under test is bundled with the project's own Vite/esbuild
 * pipeline (`scripts/lib/p4-bundler.cjs`), so the code exercised is what ships.
 *
 * Usage: npm run verify:backup:preview
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

/* --------------------------------------------------------------- harness -- */

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

/* ------------------------------------------------------------- fake DB ---- */

function createFakeDb() {
  const stores = {};
  const names = [
    'projects', 'worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes',
    'chapterDrafts', 'sceneDrafts', 'draftVersions', 'promptTemplates', 'promptTemplateVersions',
    'contextItems', 'contextConfigs', 'knowledgeEntries', 'continuityFacts', 'analysisFindings',
    'sourceDocuments', 'documentSections', 'extractionRecords',
  ];
  for (const name of names) stores[name] = [];

  function tableApi(name) {
    const rows = () => stores[name];
    return {
      get: async (id) => rows().find((r) => r.id === id),
      toArray: async () => rows().slice(),
      where: (col) => ({
        equals: (value) => ({
          toArray: async () => rows().filter((r) => r[col] === value),
          count: async () => rows().filter((r) => r[col] === value).length,
          first: async () => rows().find((r) => r[col] === value),
        }),
        anyOf: (values) => ({ toArray: async () => rows().filter((r) => values.includes(r[col])) }),
      }),
      orderBy: (col) => ({
        reverse: () => ({ toArray: async () => rows().slice().sort((a, b) => (a[col] < b[col] ? 1 : -1)) }),
        toArray: async () => rows().slice().sort((a, b) => (a[col] < b[col] ? -1 : 1)),
      }),
    };
  }

  const db = { stores };
  for (const name of names) db[name] = tableApi(name);
  // Existence probe used by the preview service: read-only `get`.
  db.projects.get = async (id) => stores.projects.find((r) => r.id === id);
  return db;
}

/* ------------------------------------------------------- fixture builder -- */

const T0 = 1_700_000_000_000;

function buildFixture(projectId, title = 'Preview Fixture') {
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
  db.stores.projects.push(fixture.project);
  for (const [key, rows] of Object.entries(fixture.data)) db.stores[key].push(...rows);
}

const countOf = (fixture) =>
  Object.values(fixture.data).reduce((sum, rows) => sum + rows.length, 0);

/* ------------------------------------------------------------------ main -- */

(async () => {
  let previewMod;
  let backupMod;
  let transferMod;
  try {
    previewMod = await importBundled('src/services/backup-preview-service.ts', 'p9-preview', { alias: ALIAS });
    backupMod = await importBundled('src/services/backup-service.ts', 'p9-preview-export', { alias: ALIAS });
    transferMod = await importBundled('src/transfer/index.ts', 'p9-preview-transfer', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle the backup preview service:\n', error);
    process.exit(1);
  }

  const {
    BackupPreviewService, BackupImportError, MAX_BACKUP_FILE_BYTES,
  } = previewMod;
  const { BackupService } = backupMod;
  const { TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS } = transferMod;

  /* Build a service bound to a fresh fake DB with a seeded project. */
  const makeEnv = (projectId = 'proj_prev', title = 'Preview Project') => {
    const db = createFakeDb();
    const fixture = buildFixture(projectId, title);
    seed(db, fixture);
    const adapter = () => new TransferRepositoryAdapter(db);
    const preview = new BackupPreviewService(new TransferService(adapter()));
    const exporter = new BackupService(new TransferService(adapter()));
    return { db, fixture, preview, exporter };
  };

  try {
    /* ========================================================= */
    /* Valid preview: metadata, counts, digest                   */
    /* ========================================================= */
    {
      const { fixture, preview, exporter } = makeEnv('proj_prev', 'Preview Project');
      const file = await exporter.exportProjectFile('proj_prev');

      // Input is a plain string; snapshot it to prove no mutation.
      const inputStr = file.content;
      const before = inputStr;

      const p = await preview.previewBackupFile({ text: inputStr, name: file.fileName }, { projectExists: async () => false });

      eq('preview: source project id matches', p.projectId, 'proj_prev');
      eq('preview: source project title matches', p.projectTitle, 'Preview Project');
      eq('preview: kind is project', p.kind, 'project');
      eq('preview: formatVersion is 1', p.formatVersion, 1);
      check('preview: schemaVersion is a positive integer', Number.isInteger(p.schemaVersion) && p.schemaVersion > 0, String(p.schemaVersion));
      eq('preview: exportedAt matches the package metadata', p.exportedAt, file.exportedAt);
      eq('preview: integrity digest matches the exported file', p.integrityDigest, file.integrityDigest);
      eq('preview: integrityVerified is true', p.integrityVerified, true);
      eq('preview: integrity digest is 64 hex', /^[0-9a-f]{64}$/.test(p.integrityDigest), true);
      eq('preview: fileName is echoed', p.fileName, file.fileName);
      check('preview: fileSizeBytes is positive and equals the UTF-8 length', p.fileSizeBytes === Buffer.byteLength(before, 'utf8'), `${p.fileSizeBytes} vs ${Buffer.byteLength(before, 'utf8')}`);

      // All 19 collections, in registry order, with correct counts.
      eq('preview: 19 collection counts', p.collections.length, TRANSFER_COLLECTIONS.length);
      eq('preview: collection keys are in registry order', p.collections.map((c) => c.key), TRANSFER_COLLECTIONS.map((c) => c.key));
      const expectedCounts = {};
      for (const [k, rows] of Object.entries(fixture.data)) expectedCounts[k] = rows.length;
      eq('preview: each collection count is correct', Object.fromEntries(p.collections.map((c) => [c.key, c.count])), expectedCounts);
      eq('preview: totalRecords equals the summed counts', p.totalRecords, countOf(fixture));
      eq('preview: totalRecords equals the sum of collection counts', p.totalRecords, p.collections.reduce((s, c) => s + c.count, 0));

      // No existing project (probe returned false).
      eq('preview: sourceProjectExistsLocally is false when absent', p.sourceProjectExistsLocally, false);

      // Input not mutated by parsing.
      eq('preview: parsing does NOT mutate the input string', inputStr, before);
    }

    /* ========================================================= */
    /* Existing-project detection                                */
    /* ========================================================= */
    {
      const { preview, exporter } = makeEnv('proj_exists', 'Exists Project');
      const file = await exporter.exportProjectFile('proj_exists');
      // Probe that reports the id exists.
      const p = await preview.previewBackupFile(file.content, {
        projectExists: async (id) => id === 'proj_exists',
      });
      eq('existing: sourceProjectExistsLocally is true when the id exists', p.sourceProjectExistsLocally, true);
      // Probe that reports it is absent.
      const p2 = await preview.previewBackupFile(file.content, { projectExists: async () => false });
      eq('existing: sourceProjectExistsLocally is false when absent', p2.sourceProjectExistsLocally, false);
    }

    /* ========================================================= */
    /* Parsing does not mutate an object input                   */
    /* ========================================================= */
    {
      const { preview, exporter } = makeEnv('proj_obj', 'Obj Project');
      const file = await exporter.exportProjectFile('proj_obj');
      const inputObj = { text: file.content, name: file.fileName };
      const frozenCopy = JSON.stringify(inputObj);
      await preview.previewBackupFile(inputObj, { projectExists: async () => false });
      eq('no-mutate: object input unchanged after preview', JSON.stringify(inputObj), frozenCopy);
    }

    /* ========================================================= */
    /* Malformed JSON                                            */
    /* ========================================================= */
    {
      const { preview } = makeEnv();
      let err = null;
      try {
        await preview.previewBackupFile('{ this is not json', { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('malformed-json: throws BackupImportError', err instanceof BackupImportError);
      eq('malformed-json: code is invalid-json', err && err.code, 'invalid-json');
      check('malformed-json: carries at least one problem', err && err.problems.length > 0);
    }

    /* ========================================================= */
    /* Empty input                                               */
    /* ========================================================= */
    {
      const { preview } = makeEnv();
      let err = null;
      try {
        await preview.previewBackupFile('   ', { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('empty-input: throws BackupImportError', err instanceof BackupImportError);
      eq('empty-input: code is empty-input', err && err.code, 'empty-input');
    }

    /* ========================================================= */
    /* Invalid structure (not an object / missing header)        */
    /* ========================================================= */
    {
      const { preview } = makeEnv();
      let err = null;
      try {
        await preview.previewBackupFile('[1,2,3]', { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('invalid-structure: throws BackupImportError', err instanceof BackupImportError);
      eq('invalid-structure: code is invalid-package', err && err.code, 'invalid-package');

      let err2 = null;
      try {
        await preview.previewBackupFile('{}', { projectExists: async () => false });
      } catch (e) {
        err2 = e;
      }
      check('invalid-structure: empty object rejected', err2 instanceof BackupImportError);
    }

    /* ========================================================= */
    /* Tamper helpers on a real exported file                    */
    /* ========================================================= */
    const { exporter: realExporter } = makeEnv('proj_tamper', 'Tamper Project');
    const goodFile = await realExporter.exportProjectFile('proj_tamper');
    const goodPkg = JSON.parse(goodFile.content);

    /* Missing required collection */
    {
      const { preview } = makeEnv('proj_tamper', 'Tamper Project');
      const pkg = JSON.parse(goodFile.content);
      delete pkg.projects[0].data.chapters;
      let err = null;
      try {
        await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('missing-collection: rejected', err instanceof BackupImportError);
      eq('missing-collection: code is invalid-package', err && err.code, 'invalid-package');
      check('missing-collection: problem mentions the missing array', err && err.problems.some((pr) => /chapters/.test(pr.path) || /chapters/.test(pr.message)));
    }

    /* Digest mismatch (edit a record but keep the old digest) */
    {
      const { preview } = makeEnv('proj_tamper', 'Tamper Project');
      const pkg = JSON.parse(goodFile.content);
      pkg.projects[0].data.characters[0].name = 'Tampered Name';
      let err = null;
      try {
        await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('digest-mismatch: rejected', err instanceof BackupImportError);
      eq('digest-mismatch: code is integrity-mismatch', err && err.code, 'integrity-mismatch');
    }

    /* Unsupported format version */
    {
      const { preview } = makeEnv('proj_tamper', 'Tamper Project');
      const pkg = JSON.parse(goodFile.content);
      pkg.formatVersion = 999;
      let err = null;
      try {
        await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('unsupported-version: rejected', err instanceof BackupImportError);
      eq('unsupported-version: code is unsupported-version', err && err.code, 'unsupported-version');
    }

    /* Wrong package kind (workspace) */
    {
      const { preview } = makeEnv('proj_tamper', 'Tamper Project');
      const pkg = JSON.parse(goodFile.content);
      pkg.kind = 'workspace';
      // Recompute a valid digest so we isolate the KIND check from integrity.
      // (Use the transfer layer to recompute over the edited payload.)
      const { computeIntegrity } = transferMod;
      pkg.projects[0].integrity = computeIntegrity({ project: pkg.projects[0].project, data: pkg.projects[0].data });
      let err = null;
      try {
        await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('workspace: rejected', err instanceof BackupImportError);
      eq('workspace: code is wrong-package-kind', err && err.code, 'wrong-package-kind');
    }

    /* Dangling reference (remove a referenced chapter) */
    {
      const { preview } = makeEnv('proj_tamper', 'Tamper Project');
      const pkg = JSON.parse(goodFile.content);
      pkg.projects[0].data.chapters = [];
      pkg.projects[0].data.scenes = []; // avoid scenes dangling on chapters too
      pkg.projects[0].data.chapterDrafts = [];
      pkg.projects[0].data.sceneDrafts = [];
      pkg.projects[0].data.draftVersions = [];
      const { computeIntegrity } = transferMod;
      pkg.projects[0].integrity = computeIntegrity({ project: pkg.projects[0].project, data: pkg.projects[0].data });
      let err = null;
      try {
        await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('dangling-reference: rejected', err instanceof BackupImportError);
    }

    /* Ownership violation (a character owned by a different project) */
    {
      const { preview } = makeEnv('proj_tamper', 'Tamper Project');
      const pkg = JSON.parse(goodFile.content);
      pkg.projects[0].data.characters[0].projectId = 'some_other_project';
      const { computeIntegrity } = transferMod;
      pkg.projects[0].integrity = computeIntegrity({ project: pkg.projects[0].project, data: pkg.projects[0].data });
      let err = null;
      try {
        await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      } catch (e) {
        err = e;
      }
      check('ownership: rejected', err instanceof BackupImportError);
      eq('ownership: code is invalid-package', err && err.code, 'invalid-package');
    }

    /* ========================================================= */
    /* File size limit (explicit, documented)                    */
    /* ========================================================= */
    {
      const { preview } = makeEnv();
      let err = null;
      try {
        await preview.previewBackupFile('x'.repeat(2048), {
          projectExists: async () => false,
          maxBytes: 1024, // force the limit for the test
        });
      } catch (e) {
        err = e;
      }
      check('size-limit: rejects a file beyond the limit', err instanceof BackupImportError);
      eq('size-limit: code is file-too-large', err && err.code, 'file-too-large');
      check('size-limit: the limit is a documented positive number', Number.isInteger(MAX_BACKUP_FILE_BYTES) && MAX_BACKUP_FILE_BYTES > 0, String(MAX_BACKUP_FILE_BYTES));

      // A real (tiny) backup is well under the real limit.
      const small = await preview.previewBackupFile(goodFile.content, { projectExists: async () => false });
      check('size-limit: a real backup is accepted under the real limit', small.totalRecords > 0);
    }

    /* ========================================================= */
    /* Schema-version mismatch surfaces a warning (not a failure)*/
    /* ========================================================= */
    {
      const { preview } = makeEnv('proj_schema', 'Schema Project');
      const exp = await makeEnv('proj_schema', 'Schema Project');
      const f = await exp.exporter.exportProjectFile('proj_schema');
      const pkg = JSON.parse(f.content);
      pkg.schemaVersion = 999;
      const p = await preview.previewBackupFile(JSON.stringify(pkg), { projectExists: async () => false });
      check('schema-mismatch: preview still succeeds (records validated now)', p && p.kind === 'project');
      check('schema-mismatch: a warning is surfaced', Array.isArray(p.warnings) && p.warnings.some((w) => w.code === 'unsupported-schema-version'));
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
