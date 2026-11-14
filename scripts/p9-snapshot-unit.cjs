/**
 * P9 Batch 3-1 — Project Snapshots FOUNDATION: pure unit tests.
 *
 * Runs in plain Node (no browser). Covers the parts that do not need a live
 * IndexedDB:
 *
 *   1. ID utility: the `snap_` prefix + `createProjectSnapshotId()`.
 *   2. Schema: a valid snapshot validates; illegal data is rejected with located
 *      paths (missing payload, integrity/projectId mismatch, bad reason, bad
 *      counts, negative timestamps, extra keys).
 *   3. Integrity linkage: the denormalised `integrity` MUST equal
 *      `payload.integrity` — a single source of truth.
 *   4. Migration (STRUCTURAL): the v13 version block is present, restates every
 *      v12 store byte-identically, and adds exactly the `projectSnapshots` store
 *      with the documented schema. (The REAL v12→v13 upgrade on a live database
 *      is exercised by `p9-snapshot-idb-verify.cjs`.)
 *   5. Transfer contract: `TRANSFER_SCHEMA_VERSION` == 13 and
 *      `projectSnapshots` is documented as an EXCLUDED transfer table.
 *
 * The TypeScript under test is bundled with the project's own Vite/esbuild
 * pipeline (`scripts/lib/p4-bundler.cjs`), so the code exercised is what ships.
 * The `@/` alias is supplied explicitly because the bundler disables the config.
 *
 * Usage: npm run verify:snapshot
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

/**
 * A minimal but COMPLETE `TransferProject` payload — the smallest project the
 * transfer data schema accepts (one world, everything else empty is NOT enough
 * here because a project needs a matching world id; we include a world).
 */
function buildPayload(projectId) {
  const T0 = 1_700_000_000_000;
  const project = {
    id: projectId,
    title: `Snapshot ${projectId}`,
    description: 'A captured project.',
    status: 'writing',
    genre: ['fantasy'],
    tags: ['snap'],
    settings: {},
    createdAt: T0,
    updatedAt: T0 + 1000,
  };
  const world = {
    id: `world_${projectId}`,
    projectId,
    title: 'The World',
    overview: 'Overview.',
    sections: [],
    themes: [],
    settings: {},
    createdAt: T0,
    updatedAt: T0,
  };
  return {
    project,
    data: {
      worlds: [world],
      characters: [],
      narrativePlans: [],
      volumes: [],
      chapters: [],
      scenes: [],
      chapterDrafts: [],
      sceneDrafts: [],
      draftVersions: [],
      promptTemplates: [],
      promptTemplateVersions: [],
      contextItems: [],
      contextConfigs: [],
      knowledgeEntries: [],
      continuityFacts: [],
      analysisFindings: [],
      sourceDocuments: [],
      documentSections: [],
      extractionRecords: [],
    },
    // A structurally valid digest (content correctness is B1's concern; here we
    // only need the two copies to MATCH).
    integrity: { algorithm: 'sha256', digest: 'a'.repeat(64) },
  };
}

/** A fully-formed snapshot built from the payload. */
function buildSnapshot(projectId, overrides = {}) {
  const payload = buildPayload(projectId);
  const T0 = 1_700_000_000_000;
  const base = {
    id: `snap_${projectId}_1`,
    projectId,
    label: 'First capture',
    reason: 'manual',
    createdAt: T0 + 5000,
    schemaVersion: 13,
    formatVersion: 1,
    projectTitle: payload.project.title,
    counts: { worlds: 1, characters: 0, chapters: 0 },
    wordCount: 0,
    integrity: { algorithm: 'sha256', digest: payload.integrity.digest },
    payload,
  };
  return { ...base, ...overrides, payload: overrides.payload ?? payload };
}

/** First issue path of a Zod parse, dotted, or null. */
function firstIssuePath(result) {
  if (result.success) return null;
  const issue = result.error.issues[0];
  return issue ? issue.path.join('.') : '<no-path>';
}

/* ------------------------------------------------------------------ main -- */

(async () => {
  let snapshotMod;
  let idMod;
  let dbMod;
  let transferMod;
  let registryMod;
  try {
    snapshotMod = await importBundled('src/schemas/snapshot.ts', 'p9-snapshot-schema', { alias: ALIAS });
    idMod = await importBundled('src/utils/id.ts', 'p9-id', { alias: ALIAS });
    dbMod = await importBundled('src/db/database.ts', 'p9-db', { alias: ALIAS });
    transferMod = await importBundled('src/schemas/transfer.ts', 'p9-transfer-schema', { alias: ALIAS });
    registryMod = await importBundled('src/transfer/collection-registry.ts', 'p9-registry', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle modules:\n', error);
    process.exit(1);
  }

  const { ProjectSnapshotSchema, SNAPSHOT_REASONS, MAX_SNAPSHOT_LABEL_CHARS } = snapshotMod;
  const { ID_PREFIX, createProjectSnapshotId } = idMod;
  const { NovelStudioDb } = dbMod;
  const { TRANSFER_SCHEMA_VERSION, TRANSFER_FORMAT_VERSION } = transferMod;
  const { EXCLUDED_TABLES } = registryMod;

  try {
    /* ========================================================= */
    /* (1) ID utility                                            */
    /* ========================================================= */
    {
      eq('id: prefix is "snap"', ID_PREFIX.projectSnapshot, 'snap');
      const id = createProjectSnapshotId();
      check('id: createProjectSnapshotId returns a snap_ id', typeof id === 'string' && id.startsWith('snap_'));
      check('id: two generated ids differ', createProjectSnapshotId() !== createProjectSnapshotId());
    }

    /* ========================================================= */
    /* (2) Schema validity                                       */
    /* ========================================================= */
    {
      const good = buildSnapshot('proj_snap_ok');
      const res = ProjectSnapshotSchema.safeParse(good);
      check('schema: a well-formed snapshot validates', res.success,
        res.success ? '' : JSON.stringify(res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)));

      eq('schema: reasons are exactly manual + pre-restore', SNAPSHOT_REASONS, ['manual', 'pre-restore']);
      check('schema: pre-restore reason accepted',
        ProjectSnapshotSchema.safeParse(buildSnapshot('p', { reason: 'pre-restore' })).success);
      eq('schema: unknown reason rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { reason: 'auto' }))), 'reason');

      // Missing payload is rejected.
      const noPayload = buildSnapshot('p');
      delete noPayload.payload;
      eq('schema: missing payload rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(noPayload)), 'payload');

      // Integrity MUST match payload.integrity.
      const mismatchedIntegrity = buildSnapshot('p', { integrity: { algorithm: 'sha256', digest: 'b'.repeat(64) } });
      eq('schema: integrity differing from payload.integrity rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(mismatchedIntegrity)), 'integrity');

      // projectId MUST match payload.project.id.
      const badProjectId = buildSnapshot('p');
      badProjectId.payload = buildPayload('OTHER');
      badProjectId.integrity = { algorithm: 'sha256', digest: badProjectId.payload.integrity.digest };
      eq('schema: projectId differing from payload.project.id rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(badProjectId)), 'projectId');

      // Counts must be non-negative integers.
      eq('schema: negative count rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { counts: { chapters: -1 } }))), 'counts.chapters');
      eq('schema: non-integer count rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { counts: { chapters: 1.5 } }))), 'counts.chapters');

      // Timestamps.
      eq('schema: negative createdAt rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { createdAt: -1 }))), 'createdAt');
      eq('schema: non-integer schemaVersion rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { schemaVersion: 13.5 }))), 'schemaVersion');
      eq('schema: zero schemaVersion rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { schemaVersion: 0 }))), 'schemaVersion');

      // Label length bound.
      eq('schema: over-long label rejected',
        firstIssuePath(ProjectSnapshotSchema.safeParse(buildSnapshot('p', { label: 'x'.repeat(MAX_SNAPSHOT_LABEL_CHARS + 1) }))), 'label');

      // Strict: no unknown keys.
      const withExtra = buildSnapshot('p');
      withExtra.extra = true;
      check('schema: unknown top-level key rejected (strict)',
        (() => {
          const r = ProjectSnapshotSchema.safeParse(withExtra);
          return !r.success && r.error.issues.some((i) => i.code === 'unrecognized_keys');
        })());

      // Payload must be a COMPLETE TransferProject: a missing collection fails.
      const incomplete = buildSnapshot('p');
      delete incomplete.payload.data.chapters;
      check('schema: payload missing a collection is rejected',
        !ProjectSnapshotSchema.safeParse(incomplete).success);

      // The empty (but complete) payload accepts an empty label.
      check('schema: empty label is allowed',
        ProjectSnapshotSchema.safeParse(buildSnapshot('p', { label: '' })).success);
    }

    /* ========================================================= */
    /* (3) Migration — STRUCTURAL contract (v12 → v13)           */
    /* ========================================================= */
    {
      const db = new NovelStudioDb(`p9-snapshot-unit-${Date.now()}`);
      const versions = db._versions || [];
      const v12 = versions.find((v) => v._cfg && v._cfg.version === 12);
      const v13 = versions.find((v) => v._cfg && v._cfg.version === 13);

      check('migration: v12 version block present', Boolean(v12));
      check('migration: v13 version block present', Boolean(v13));

      if (v12 && v13) {
        const s12 = v12._cfg.storesSource; // { tableName: 'schema-string' }
        const s13 = v13._cfg.storesSource;

        // Every v12 store must be restated byte-identically in v13.
        const diffs = [];
        for (const name of Object.keys(s12)) {
          if (s13[name] !== s12[name]) diffs.push(name);
        }
        check('migration: every v12 store restated byte-identically in v13', diffs.length === 0, diffs.join(','));

        // Exactly one store added.
        const added = Object.keys(s13).filter((n) => !(n in s12)).sort();
        eq('migration: exactly one store added', added, ['projectSnapshots']);

        // The new schema string is exactly as specified.
        eq('migration: projectSnapshots schema',
          s13.projectSnapshots, '&id, projectId, [projectId+createdAt], createdAt');

        // The instance exposes the table (fresh DB → empty, but present).
        check('migration: projectSnapshots table exists on the instance',
          Boolean(db.projectSnapshots) && typeof db.projectSnapshots.get === 'function');
      }
    }

    /* ========================================================= */
    /* (4) Transfer contract                                     */
    /* ========================================================= */
    {
      eq('transfer: TRANSFER_SCHEMA_VERSION tracks the v13 DB', TRANSFER_SCHEMA_VERSION, 13);
      eq('transfer: TRANSFER_FORMAT_VERSION unchanged', TRANSFER_FORMAT_VERSION, 1);
      check('transfer: projectSnapshots is an EXCLUDED transfer table',
        EXCLUDED_TABLES.some((e) => e.table === 'projectSnapshots'));
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
