/**
 * P9 Batch 1 鈥?transfer foundation: PURE unit tests (no browser, no IndexedDB).
 *
 * Covers the parts that are deliberately database-agnostic:
 *
 *   1. Collection inventory: matches the project-ownership model, excludes every
 *      credential-bearing table, and `schemaVersion` matches the DB.
 *   2. Canonical JSON: deterministic, construction-order independent.
 *   3. Integrity: detects tampering; stable through JSON round-trips.
 *   4. Validation: every documented failure mode yields a structured problem
 *      with the right code; a well-formed package passes clean.
 *   5. ID mapping: rewrites ids AND every reference; never mutates the input;
 *      reports unresolved references; produces a self-consistent package.
 *   6. Serialisation: export 鈫?JSON 鈫?parse round-trips byte-identically and no
 *      secret-bearing table is ever serialised.
 *
 * The TypeScript under test is bundled with the project's own Vite/esbuild
 * pipeline (`scripts/lib/p4-bundler.cjs`), so the code exercised is what ships.
 * The `@/` alias is supplied explicitly because the bundler disables the config.
 *
 * Usage: npm run verify:transfer
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

/** Validation helper: the first error's code, or null. */
function firstCode(result) {
  return result.errors.length > 0 ? result.errors[0].code : null;
}
function mutate(pkg, fn) {
  const copy = JSON.parse(JSON.stringify(pkg));
  fn(copy);
  return copy;
}

/* ------------------------------------------------------------- fake DB ---- */

/**
 * A minimal in-memory stand-in for `NovelStudioDb`.
 *
 * Implements only what `TransferRepositoryAdapter` (and the repositories it
 * delegates to) use: `projects.get` plus each store's `where(col).equals(v)`
 * and `.toArray()`. Rows are stored already-valid, so read-time validation
 * passes. This proves the service is database-agnostic without a browser.
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
function buildFixture(projectId) {
  const project = {
    id: projectId, title: 'Transfer Fixture', description: 'Fixture.', status: 'writing',
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
  const proseEnd = rawText.length - 1; // exclude trailing newline
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

/** A deterministic id factory so remap assertions are stable. */
function counterFactory() {
  const counts = new Map();
  return (prefix) => {
    const n = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, n);
    return `NEW_${prefix}_${n}`;
  };
}

/* ------------------------------------------------------------------ main -- */

(async () => {
  let mod;
  try {
    mod = await importBundled('src/transfer/index.ts', 'p9-transfer', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle the transfer module:\n', error);
    process.exit(1);
  }

  const {
    TransferService, TransferRepositoryAdapter, validateTransferPackage, canonicalStringify,
    computeIntegrity, verifyIntegrity, buildIdMap, remapProject,
    TRANSFER_COLLECTIONS, EXCLUDED_TABLES, SECRET_BEARING_TABLES, TRANSFER_SCHEMA_VERSION,
    TRANSFER_FORMAT_VERSION,
  } = mod;

  try {
    /* ========================================================= */ 
    /* (1) Inventory                                             */ 
    /* ========================================================= */ 
    {
      const keys = TRANSFER_COLLECTIONS.map((c) => c.key);
      eq('inventory: 19 project-owned collections', keys.length, 19);

      const inventoried = new Set(TRANSFER_COLLECTIONS.map((c) => c.table));
      eq('inventory: no secret-bearing table is exported', SECRET_BEARING_TABLES.filter((t) => inventoried.has(t)), []);

      const excludedTables = EXCLUDED_TABLES.map((e) => e.table);
      for (const t of ['aiProviders', 'aiModels', 'aiTaskConfigs', 'aiGlobalConfig', 'projects']) {
        check(`inventory: ${t} is documented as excluded`, excludedTables.includes(t));
      }
      eq('inventory: schemaVersion matches the DB', TRANSFER_SCHEMA_VERSION, 13);
      check(
        'inventory: every collection documents its relationship',
        TRANSFER_COLLECTIONS.every((c) => typeof c.relationship === 'string' && c.relationship.length > 0),
      );
    }

    /* ========================================================= */ 
    /* (2) Canonical JSON                                        */ 
    /* ========================================================= */ 
    {
      eq('canonical: key order independent of construction order', canonicalStringify({ b: 1, a: 2 }), canonicalStringify({ a: 2, b: 1 }));
      eq('canonical: nested objects are sorted too', canonicalStringify({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
      eq('canonical: array order is preserved', canonicalStringify([3, 1, 2]), '[3,1,2]');
      eq('canonical: undefined object props are dropped', canonicalStringify({ a: 1, b: undefined }), '{"a":1}');
      eq('canonical: undefined array slots become null', canonicalStringify([1, undefined, 3]), '[1,null,3]');

      let threw = false;
      try { canonicalStringify({ a: Number.POSITIVE_INFINITY }); } catch { threw = true; }
      check('canonical: non-finite numbers are rejected', threw);
    }

    /* ========================================================= */ 
    /* (3) Integrity                                             */ 
    /* ========================================================= */ 
    {
      const fixture = buildFixture('proj_fix');
      const value = { project: fixture.project, data: fixture.data };
      const h1 = computeIntegrity(value);
      const h2 = computeIntegrity(JSON.parse(JSON.stringify(value)));
      eq('integrity: stable across JSON round-trip', h1.digest, h2.digest);
      check('integrity: verifies a matching digest', verifyIntegrity(value, h1));

      const tampered = JSON.parse(JSON.stringify(value));
      tampered.data.characters[0].name = 'Mallory';
      check('integrity: detects tampering', !verifyIntegrity(tampered, h1));
      check('integrity: digest is 64 lowercase hex', /^[0-9a-f]{64}$/.test(h1.digest) && h1.algorithm === 'sha256');
    }

    /* ========================================================= */ 
    /* (4) Validation                                            */ 
    /* ========================================================= */ 
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_valid'));
      const service = new TransferService(new TransferRepositoryAdapter(db));

      const pkg = await service.exportProject('proj_valid', { now: T0 + 5000 });
      const good = validateTransferPackage(pkg);
      check('validation: a freshly exported package is valid', good.valid,
        JSON.stringify(good.errors.map((e) => `${e.code}@${e.path}: ${e.message}`)));
      eq('validation: a clean package has no errors', firstCode(good), null);

      eq('validation: wrong format rejected', firstCode(validateTransferPackage(mutate(pkg, (p) => { p.format = 'other'; }))), 'wrong-format');
      eq('validation: unsupported format version rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.formatVersion = TRANSFER_FORMAT_VERSION + 1; }))), 'unsupported-format-version');
      check('validation: mismatched schemaVersion is a WARNING',
        validateTransferPackage(mutate(pkg, (p) => { p.schemaVersion = TRANSFER_SCHEMA_VERSION - 1; }))
          .warnings.some((w) => w.code === 'unsupported-schema-version'));

      eq('validation: dangling chapter.volumeId rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.chapters[0].volumeId = 'vol_missing'; }))), 'dangling-reference');
      eq('validation: dangling scene.chapterId rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.scenes[0].chapterId = 'x'; }))), 'dangling-reference');
      eq('validation: dangling draftVersion.draftId rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.draftVersions[0].draftId = 'no_such'; }))), 'dangling-reference');
      eq('validation: dangling template version rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.promptTemplateVersions[0].templateId = 'missing'; }))), 'dangling-reference');
      eq('validation: emptied volume list caught by chapter reference',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.volumes = []; }))), 'dangling-reference');
      eq('validation: duplicate ids across collections rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.scenes[0].id = p.projects[0].data.chapters[0].id; }))), 'duplicate-id');
      eq('validation: ownership mismatch rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.characters[0].projectId = 'other'; }))), 'ownership-mismatch');
      eq('validation: two worlds is rejected (schema cardinality guard)',
        firstCode(validateTransferPackage(mutate(pkg, (p) => {
          const w = JSON.parse(JSON.stringify(p.projects[0].data.worlds[0])); w.id = 'world_dup';
          p.projects[0].data.worlds.push(w);
        }))), 'schema-invalid');
      eq('validation: section end past rawText is an offset error',
        firstCode(validateTransferPackage(mutate(pkg, (p) => {
          const doc = p.projects[0].data.sourceDocuments[0];
          const sec = p.projects[0].data.documentSections[1];
          sec.end = doc.rawText.length + 5;
          sec.text = doc.rawText.slice(sec.start, sec.end) + 'xxxxx';
        }))), 'offset-out-of-range');
      eq('validation: section text disagreeing with rawText is a quote mismatch',
        firstCode(validateTransferPackage(mutate(pkg, (p) => {
          const sec = p.projects[0].data.documentSections[1];
          sec.text = sec.text.replace('Elara', 'Maya_');
        }))), 'quote-mismatch');
      eq('validation: evidence section missing rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.extractionRecords[0].evidence[0].sectionId = 'missing'; }))), 'dangling-reference');
      eq('validation: evidence quote mismatch rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.extractionRecords[0].evidence[0].quote = 'Wrong'; }))), 'quote-mismatch');
      eq('validation: self-parent is a cyclic parent',
        firstCode(validateTransferPackage(mutate(pkg, (p) => {
          const s = p.projects[0].data.documentSections[0]; s.parentId = s.id;
        }))), 'cyclic-parent');
      eq('validation: parent in another document rejected',
        firstCode(validateTransferPackage(mutate(pkg, (p) => {
          const data = p.projects[0].data;
          const doc2 = JSON.parse(JSON.stringify(data.sourceDocuments[0])); doc2.id = 'doc_2';
          data.sourceDocuments.push(doc2);
          data.documentSections[1].documentId = 'doc_2';
        }))), 'dangling-reference');
      eq('validation: tampered digest is an integrity mismatch',
        firstCode(validateTransferPackage(mutate(pkg, (p) => { p.projects[0].integrity.digest = '0'.repeat(64); }))), 'integrity-mismatch');

      // A schema-level violation (bad enum) is reported with a located path.
      const badResult = validateTransferPackage(mutate(pkg, (p) => { p.projects[0].data.characters[0].role = 'wizard'; }));
      eq('validation: schema violations are reported as schema-invalid', firstCode(badResult), 'schema-invalid');
      check('validation: a schema problem carries a located path',
        badResult.errors.some((e) => e.path.includes('characters[0]') && e.path.includes('role')),
        JSON.stringify(badResult.errors.map((e) => e.path)));

      eq('validation: a non-object is not-an-object', firstCode(validateTransferPackage(42)), 'not-an-object');
      eq('parse: invalid JSON is reported, not thrown', firstCode(service.parse('{not json')), 'invalid-json');
    }

    /* ========================================================= */ 
    /* (5) ID mapping                                            */ 
    /* ========================================================= */ 
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_map'));
      const service = new TransferService(new TransferRepositoryAdapter(db));
      const pkg = await service.exportProject('proj_map', { now: T0 });
      const entry = pkg.projects[0];

      const before = JSON.stringify(entry);
      const result = remapProject(entry, buildIdMap(entry, counterFactory()));
      check('remap: never mutates the source package', JSON.stringify(entry) === before);
      check('remap: the root project id changes', result.project.project.id !== entry.project.id);
      check('remap: collection rows adopt a NEW id', result.project.data.characters[0].id.startsWith('NEW_char_'));

      eq('remap: chapter.volumeId rewritten', result.project.data.chapters[0].volumeId, result.project.data.volumes[0].id);
      eq('remap: scene.chapterId rewritten', result.project.data.scenes[0].chapterId, result.project.data.chapters[0].id);
      eq('remap: chapter.characterIds rewritten', result.project.data.chapters[0].characterIds, result.project.data.characters.map((c) => c.id));
      eq('remap: scene.povCharacterId rewritten', result.project.data.scenes[0].povCharacterId, result.project.data.characters[0].id);
      eq('remap: chapterDraft.ownerId rewritten', result.project.data.chapterDrafts[0].ownerId, result.project.data.chapters[0].id);
      eq('remap: sceneDraft.ownerId rewritten', result.project.data.sceneDrafts[0].ownerId, result.project.data.scenes[0].id);

      const cv = result.project.data.draftVersions.find((v) => v.kind === 'chapter');
      const sv = result.project.data.draftVersions.find((v) => v.kind === 'scene');
      eq('remap: chapter version follows the chapter draft', cv.draftId, result.project.data.chapterDrafts[0].id);
      eq('remap: scene version follows the scene draft', sv.draftId, result.project.data.sceneDrafts[0].id);

      eq('remap: template version follows its template', result.project.data.promptTemplateVersions[0].templateId, result.project.data.promptTemplates[0].id);
      eq('remap: section follows its document', result.project.data.documentSections[0].documentId, result.project.data.sourceDocuments[0].id);
      eq('remap: section parentId rewritten in the section namespace', result.project.data.documentSections[1].parentId, result.project.data.documentSections[0].id);
      eq('remap: evidence follows the new section id', result.project.data.extractionRecords[0].evidence[0].sectionId, result.project.data.documentSections[1].id);
      eq('remap: extraction relatedIds follow the character namespace', result.project.data.extractionRecords[0].relatedIds, [result.project.data.characters[0].id]);
      eq('remap: continuity anchors follow their targets',
        [result.project.data.continuityFacts[0].anchorChapterId, result.project.data.continuityFacts[0].anchorSceneId],
        [result.project.data.chapters[0].id, result.project.data.scenes[0].id]);
      eq('remap: extraction integration target follows the character',
        result.project.data.extractionRecords[0].integration.appliedEntityId, result.project.data.characters[0].id);
      eq('remap: all ownership columns follow the new project id',
        result.project.data.characters.every((c) => c.projectId === result.project.project.id), true);

      const remappedCheck = validateTransferPackage({
        format: pkg.format, formatVersion: pkg.formatVersion, schemaVersion: pkg.schemaVersion, kind: 'project',
        metadata: { ...pkg.metadata, projectCount: 1 }, projects: [result.project],
      });
      check('remap: the remapped package passes validation', remappedCheck.valid,
        JSON.stringify(remappedCheck.errors.map((e) => `${e.code}@${e.path}: ${e.message}`)));
      eq('remap: a complete fixture has no unresolved references', result.unresolvedReferences, []);

      // An unmappable reference is reported AND left intact.
      // (Once remapped, the row lives in the SCENES collection under its new id,
      //  so the report identifies it by its new record id and the `chapterId` field.)
      const brokenEntry = JSON.parse(JSON.stringify(entry));
      brokenEntry.data.scenes[0].chapterId = 'chap_not_in_package';
      const broken = remapProject(brokenEntry, buildIdMap(brokenEntry, counterFactory()));
      check('remap: an unmappable reference is reported', broken.unresolvedReferences.some((r) => r.field === 'chapterId' && r.missingId === 'chap_not_in_package'));
      eq('remap: an unmappable reference keeps its original value', broken.project.data.scenes[0].chapterId, 'chap_not_in_package');

      // The plot beat is remapped and the chapter follows it.
      eq('remap: chapter.plotBeatId follows the remapped beat',
        result.project.data.chapters[0].plotBeatId, result.project.data.narrativePlans[0].beats[0].id);
      check('remap: beat ids are rewritten (not left from the source)',
        result.project.data.narrativePlans[0].beats[0].id !== entry.data.narrativePlans[0].beats[0].id);
    }

    /* ========================================================= */ 
    /* (6) Serialisation round-trip & secret exclusion           */ 
    /* ========================================================= */ 
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_rt'));
      const service = new TransferService(new TransferRepositoryAdapter(db));

      const pkg = await service.exportProject('proj_rt', { now: T0, appVersion: '9.0.0' });
      const json = service.serialize(pkg);

      const parsed = service.parse(json);
      check('round-trip: a serialised package parses successfully', parsed.valid && parsed.package !== null);
      eq('round-trip: re-serialising yields identical bytes', service.serialize(parsed.package), json);
      eq('round-trip: the parsed package validates clean', firstCode(parsed), null);
      eq('round-trip: integrity preserved through JSON',
        parsed.package.projects[0].integrity.digest, pkg.projects[0].integrity.digest);

      // NO credential material may appear anywhere in the serialised output.
      const lower = json.toLowerCase();
      const forbidden = ['apikey', 'aiproviders', 'customheaders', 'sk-', 'bearer '];
      for (const token of forbidden) {
        check(`secrets: serialised package never contains "${token}"`, !lower.includes(token));
      }

      // Excluded tables are absent from the format description too.
      const desc = service.getFormatDescription();
      check('secrets: the format description reports secretsExcluded', desc.secretsExcluded === true);
      check('secrets: format description lists provider tables as excluded',
        desc.excludedTables.some((e) => e.table === 'aiProviders'));
    }

    /* ========================================================= */ 
    /* (7) Workspace export                                      */ 
    /* ========================================================= */ 
    {
      const db = createFakeDb();
      seed(db, buildFixture('proj_ws_a'));
      seed(db, buildFixture('proj_ws_b'));
      const service = new TransferService(new TransferRepositoryAdapter(db));

      const workspace = await service.exportWorkspace({ now: T0 });
      eq('workspace: both projects are exported', workspace.projects.length, 2);
      eq('workspace: kind is "workspace"', workspace.kind, 'workspace');
      eq('workspace: projectCount matches', workspace.metadata.projectCount, 2);
      check('workspace: a workspace package validates', validateTransferPackage(workspace).valid);

      const single = await service.exportProject('proj_ws_a', { now: T0 });
      eq('workspace: single export kind is "project"', single.kind, 'project');

      // Exporting a missing project fails loudly.
      let threw = false;
      try { await service.exportProject('does_not_exist', { now: T0 }); } catch { threw = true; }
      check('export: a missing project throws rather than exporting nothing', threw);
    }

    /* ========================================================= */ 
    /* Summary                                                   */ 
    /* ========================================================= */ 
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

