/**
 * P9 Batch 4-1 — Project Backup export: PURE logic tests (no browser, no IDB).
 *
 * Exercises the REAL `BackupService` (bundled from source) against an
 * in-memory fake database behind the REAL `TransferRepositoryAdapter`. Verifies
 * the file-export contract only (serialisation, validation, integrity,
 * 19-collection completeness, file-name safety, secret exclusion, failure
 * paths). No upload/parse/preview/restore is tested here — that is later work.
 *
 * The TypeScript under test is bundled with the project's own Vite/esbuild
 * pipeline (`scripts/lib/p4-bundler.cjs`), so the code exercised is what ships.
 *
 * Usage: npm run verify:backup
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

/**
 * Minimal in-memory stand-in for `NovelStudioDb` implementing exactly what
 * `TransferRepositoryAdapter` (and the repositories it uses) need:
 * `projects.get`/`toArray` + each store's `where(col).equals(v).toArray()`.
 */
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
  return db;
}

/* ------------------------------------------------------- fixture builder -- */

const T0 = 1_700_000_000_000;

/** A small but COMPLETE project exercising every collection & reference type. */
function buildFixture(projectId, title = 'Transfer Fixture') {
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

/* ------------------------------------------------------------------ main -- */

(async () => {
  let mod;
  try {
    mod = await importBundled('src/services/backup-service.ts', 'p9-backup', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle the backup service:\n', error);
    process.exit(1);
  }

  const transferMod = await importBundled('src/transfer/index.ts', 'p9-backup-transfer', { alias: ALIAS });
  const {
    BackupService, BackupServiceError,
    PROJECT_BACKUP_EXTENSION, PROJECT_BACKUP_MIME,
    sanitizeBackupFileNameSegment, buildBackupFileName,
  } = mod;
  const {
    TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS,
    validateTransferPackage, verifyIntegrity,
  } = transferMod;

  try {
    /* ========================================================= */
    /* File-name sanitisation                                    */
    /* ========================================================= */
    {
      eq('filename: normal title is preserved', sanitizeBackupFileNameSegment('My Novel'), 'My Novel');
      eq('filename: Chinese title preserved', sanitizeBackupFileNameSegment('我的小说'), '我的小说');
      eq('filename: path separators removed', sanitizeBackupFileNameSegment('a/b\\c'), 'a b c');
      eq('filename: illegal chars removed', sanitizeBackupFileNameSegment('a<b>c:d"e|f?g*h'), 'a b c d e f g h');
      eq('filename: leading dots stripped', sanitizeBackupFileNameSegment('...secret'), 'secret');
      eq('filename: control chars removed', sanitizeBackupFileNameSegment('ab\u0000\u0007cd'), 'abcd');
      eq('filename: whitespace collapsed + trimmed', sanitizeBackupFileNameSegment('  a   b  '), 'a b');
      eq('filename: empty title falls back to "project"', sanitizeBackupFileNameSegment(''), 'project');
      eq('filename: whitespace-only falls back to "project"', sanitizeBackupFileNameSegment('   '), 'project');
      eq('filename: all-illegal title falls back to "project"', sanitizeBackupFileNameSegment('///???'), 'project');
      check('filename: long title is truncated (<=80)', sanitizeBackupFileNameSegment('x'.repeat(200)).length <= 80);

      eq('filename: extension is n87novel', PROJECT_BACKUP_EXTENSION, 'n87novel');
      eq('filename: buildBackupFileName appends the extension', buildBackupFileName('My Novel'), 'My Novel.n87novel');
      eq('filename: buildBackupFileName sanitises AND appends', buildBackupFileName('a/b'), 'a b.n87novel');
      eq('filename: Chinese build keeps the extension', buildBackupFileName('我的小说'), '我的小说.n87novel');
      check('mime: JSON mime declared', /application\/json/.test(PROJECT_BACKUP_MIME));
    }

    /* ========================================================= */
    /* Export success: canonical JSON, parses, valid, integrity  */
    /* ========================================================= */
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_bk', 'My Backup Project'));
      const service = new BackupService(new TransferService(new TransferRepositoryAdapter(db)));
      const parser = new TransferService(new TransferRepositoryAdapter(db));

      const file = await service.exportProjectFile('proj_bk');

      check('export: returns file content (string)', typeof file.content === 'string' && file.content.length > 0);
      eq('export: fileName uses sanitised title + extension', file.fileName, 'My Backup Project.n87novel');
      eq('export: mimeType is the JSON mime', file.mimeType, PROJECT_BACKUP_MIME);
      eq('export: projectId is the source id', file.projectId, 'proj_bk');
      eq('export: projectTitle comes from the package', file.projectTitle, 'My Backup Project');

      // Canonical JSON: parse the raw string directly (no B1 helpers) so the
      // assertion is independent of TransferService.parse.
      let raw;
      let rawOk = true;
      try {
        raw = JSON.parse(file.content);
      } catch {
        rawOk = false;
      }
      check('export: content is valid JSON', rawOk);
      eq('export: kind is "project" (never workspace)', raw.kind, 'project');
      eq('export: package carries exactly one project', raw.projects.length, 1);
      eq('export: carries 19 collections', Object.keys(raw.projects[0].data).length, TRANSFER_COLLECTIONS.length);

      // Round-trips through the B1 parser and validates clean.
      const parsed = parser.parse(file.content);
      check('export: parses via TransferService.parse', parsed.valid && parsed.package !== null,
        JSON.stringify(parsed.errors.map((e) => `${e.code}@${e.path}`)));
      check('export: full validation passes', validateTransferPackage(raw).valid);

      // Integrity: digest present and matches the payload.
      check('export: file reports an integrity digest', typeof file.integrityDigest === 'string' && file.integrityDigest.length === 64);
      check('export: integrity verifies against the payload',
        verifyIntegrity({ project: raw.projects[0].project, data: raw.projects[0].data }, raw.projects[0].integrity));
      eq('export: reported digest equals the package digest', file.integrityDigest, raw.projects[0].integrity.digest);

      // Counts and totals are derived correctly.
      eq('export: totalRecords equals the summed counts',
        file.totalRecords, Object.values(file.counts).reduce((s, n) => s + n, 0));
      check('export: every one of the 19 collections is present in counts',
        TRANSFER_COLLECTIONS.every((c) => typeof file.counts[c.key] === 'number'));
      check('export: a fully-seeded project populates every collection',
        TRANSFER_COLLECTIONS.every((c) => file.counts[c.key] > 0));
    }

    /* ========================================================= */
    /* SECRETS: a planted key in aiProviders is never exported    */
    /* ========================================================= */
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_sec', 'Secret Project'));
      // Plant credentials in the secret-bearing table (not one of the 19).
      // The fake DB has no aiProviders store by default; add one so the scanner
      // proves the exporter never traverses it.
      db.stores.aiProviders = [
        { id: 'prov_1', name: 'SecretProvider', providerType: 'openai', baseUrl: '',
          apiKey: 'sk-REALSECRET-0123456789', customHeaders: [{ name: 'X', value: 'bearer TOPSECRET' }],
          enabled: true, createdAt: T0, updatedAt: T0 },
      ];
      const service = new BackupService(new TransferService(new TransferRepositoryAdapter(db)));
      const file = await service.exportProjectFile('proj_sec');
      const lower = file.content.toLowerCase();
      for (const token of ['sk-realsecret', 'topsecret', 'apikey', 'aiproviders', 'secretprovider']) {
        check(`secrets: backup never contains "${token}"`, !lower.includes(token));
      }
      // But user prose is retained (scan is meaningful).
      check('secrets: user-authored description is still present', file.content.includes('Fixture.'));
    }

    /* ========================================================= */
    /* Failure paths: missing project, empty id                  */
    /* ========================================================= */
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_only'));
      const service = new BackupService(new TransferService(new TransferRepositoryAdapter(db)));

      let missingError = null;
      try {
        await service.exportProjectFile('does_not_exist');
      } catch (err) {
        missingError = err;
      }
      check('failure: a missing project throws', missingError instanceof BackupServiceError);
      check('failure: the missing-project error is not a success payload', missingError !== null);
      check('failure: it preserves the underlying cause', missingError && missingError.cause !== undefined);

      let emptyError = null;
      try {
        await service.exportProjectFile('   ');
      } catch (err) {
        emptyError = err;
      }
      check('failure: an empty project id throws BackupServiceError', emptyError instanceof BackupServiceError);
    }

    /* ========================================================= */
    /* Export is side-effect free (fake DB unchanged)            */
    /* ========================================================= */
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_ro'));
      const service = new BackupService(new TransferService(new TransferRepositoryAdapter(db)));
      const before = JSON.stringify(db.stores);
      await service.exportProjectFile('proj_ro');
      const after = JSON.stringify(db.stores);
      check('read-only: exporting mutates nothing in the database', before === after);
    }

    /* ========================================================= */
    /* Consecutive exports are stable (no drift, deterministic)  */
    /* ========================================================= */
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_stable', 'Stable'));
      const service = new BackupService(new TransferService(new TransferRepositoryAdapter(db)));
      const first = await service.exportProjectFile('proj_stable');
      const second = await service.exportProjectFile('proj_stable');
      // exportedAt differs by wall clock; the DATA payload must be identical.
      const strip = (s) => {
        const o = JSON.parse(s);
        delete o.metadata.exportedAt;
        return JSON.stringify(o);
      };
      eq('consecutive: payload (minus export timestamp) is stable', strip(first.content), strip(second.content));
      eq('consecutive: same file name', first.fileName, second.fileName);
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
