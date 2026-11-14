/**
 * In-page driver for `p9-snapshot-idb-verify.cjs` (P9 Batch 3-1 — REAL IDB).
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(${<this file contents>})()` inside a headless-Chrome tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite (`/src/...`)
 * and the browser's REAL IndexedDB.
 *
 * Two phases, each on its own throw-away database:
 *
 *   A. REAL v12 → v13 MIGRATION
 *      1. Build a database at schema v12 using the app's OWN v12 store strings
 *         (read from `NovelStudioDb._versions`), via a plain `Dexie`.
 *      2. Seed it (a project row + a world + a chapter) at v12.
 *      3. Close it, then OPEN the same database with `NovelStudioDb` (v13) so
 *         IndexedDB performs the REAL upgrade.
 *      4. Assert: schema version advanced to 13, every pre-v13 row SURVIVES
 *         byte-for-byte, and the new `projectSnapshots` store exists & is empty.
 *
 *   B. SNAPSHOT REPOSITORY + PROJECT CASCADE (real Dexie/IDB)
 *      (fresh isolated DB installed as the singleton)
 *      1. create / getById round-trip (payload intact).
 *      2. add() of a duplicate id fails loudly (immutability).
 *      3. listByProject: newest-first, strict project scoping.
 *      4. countByProject.
 *      5. deleteById is scoped + idempotent; never affects project data.
 *      6. deleteByProjectId removes only that project's snapshots.
 *      7. ProjectService.deleteProject cascades snapshots (and other children)
 *         for the deleted project only, leaving another project intact.
 *
 * The database name for phase B is injected as `window.__P9SNAP_DB_NAME`. Phase
 * A creates its own uniquely-named database.
 *
 * Returns a plain JSON-serialisable report object.
 */
async () => {
  const dbMod = await import('/src/db/index.ts');
  const { NovelStudioDb, __setDbForTesting } = dbMod;

  const report = {};

  /* ================================================================== */
  /* Helpers                                                            */
  /* ================================================================== */
  const T0 = 1_700_000_000_000;

  /** Deterministic, structurally-valid TransferProject payload for `projectId`. */
  const buildPayload = (project) => ({
    project,
    data: {
      worlds: [
        {
          id: `world_${project.id}`,
          projectId: project.id,
          title: 'Snapshot World',
          overview: 'A captured world.',
          sections: [],
          themes: [],
          settings: {},
          createdAt: T0,
          updatedAt: T0,
        },
      ],
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
    integrity: { algorithm: 'sha256', digest: 'a'.repeat(64) },
  });

  const makeProject = (id, title) => ({
    id,
    title,
    description: 'Project for a snapshot test.',
    status: 'writing',
    genre: ['fantasy'],
    tags: ['snap'],
    settings: {},
    createdAt: T0,
    updatedAt: T0 + 1000,
  });

  /* ================================================================== */
  /* PHASE A — REAL v12 → v13 MIGRATION                                  */
  /* ================================================================== */
  {
    // Use the ALREADY-CONSTRUCTED singleton from `/src/db/index.ts`. A fresh
    // sub-import of `/src/db/database.ts` can resolve to a separate module
    // instance whose class has an empty `_versions`; the live singleton always
    // has every version block installed, and its `constructor` IS the real
    // v13 `NovelStudioDb` class. We only READ its declarative definitions here
    // and build our own throw-away database with the Dexie base class.
    const Fresh = dbMod.db.constructor; // the real NovelStudioDb
    const Dexie = Object.getPrototypeOf(Fresh);

    // Read the app's OWN declarative store strings for v12.
    const versions = dbMod.db._versions || [];
    const v12cfg = versions.find((v) => v._cfg && v._cfg.version === 12);
    const v12Stores = v12cfg && v12cfg._cfg ? v12cfg._cfg.storesSource : null;

    if (!v12Stores) {
      report.migration = { ok: false, reason: 'v12 storesSource unavailable' };
    } else {
      const MIG_DB = `p9-snap-mig-${Date.now()}`;

      // 1+2. Create & seed at v12 using the app's own v12 schema strings.
      const v12db = new Dexie(MIG_DB);
      v12db.version(12).stores(v12Stores);
      await v12db.open();

      const projectRow = makeProject('proj_mig_1', 'Migrated Project');
      await v12db.table('projects').add(projectRow);
      await v12db.table('worlds').add({
        id: 'world_proj_mig_1', projectId: 'proj_mig_1', title: 'Old World',
        overview: 'Pre-v13 world.', sections: [], themes: [], settings: {},
        createdAt: T0, updatedAt: T0,
      });
      await v12db.table('volumes').add({ id: 'vol_mig_1', projectId: 'proj_mig_1', title: 'Old Volume', createdAt: T0, updatedAt: T0 });
      await v12db.table('chapters').add({
        id: 'chap_mig_1', projectId: 'proj_mig_1', volumeId: 'vol_mig_1', title: 'Old Chapter',
        order: 0, summary: '', goal: '', keyEvents: '', endingHook: '', status: 'draft',
        plotBeatId: null, characterIds: [], tags: [], createdAt: T0, updatedAt: T0,
      });
      const versionBefore = v12db.verno;
      const projBefore = await v12db.table('projects').get('proj_mig_1');
      const chapBefore = await v12db.table('chapters').get('chap_mig_1');
      // There must be NO projectSnapshots table at v12.
      const hadSnapshotsTableAtV12 = v12db.tables.some((t) => t.name === 'projectSnapshots');
      v12db.close();

      // 3. Open the SAME database with the real (v13) class → real upgrade.
      const fresh = new Fresh(MIG_DB);
      await fresh.open();

      const versionAfter = fresh.verno;
      const projAfter = await fresh.table('projects').get('proj_mig_1');
      const chapAfter = await fresh.table('chapters').get('chap_mig_1');
      const hasSnapshotsStore = fresh.tables.some((t) => t.name === 'projectSnapshots');
      const snapCount = await fresh.table('projectSnapshots').count();

      // Write a snapshot into the NEW store to prove it is fully usable post-upgrade.
      const payload = buildPayload(makeProject('proj_mig_1', 'Migrated Project'));
      const snapRow = {
        id: 'snap_postmig_1',
        projectId: 'proj_mig_1',
        label: 'after upgrade',
        reason: 'manual',
        createdAt: T0 + 2000,
        schemaVersion: 13,
        formatVersion: 1,
        projectTitle: 'Migrated Project',
        counts: { worlds: 1 },
        wordCount: 0,
        integrity: { algorithm: 'sha256', digest: payload.integrity.digest },
        payload,
      };
      await fresh.table('projectSnapshots').add(snapRow);
      const snapAfterWrite = await fresh.table('projectSnapshots').get('snap_postmig_1');

      // Data integrity: rows unchanged across the upgrade (ignore nothing —
      // the migration must be a pure no-op on existing rows).
      const stable = (a, b) => JSON.stringify(a) === JSON.stringify(b);

      report.migration = {
        ok: true,
        versionBefore,
        versionAfter,
        advanced: versionBefore === 12 && versionAfter === 13,
        hadSnapshotsTableAtV12,
        hasSnapshotsStore,
        snapshotsEmptyAfterUpgrade: snapCount === 0,
        projectSurvived: stable(projBefore, projAfter),
        chapterSurvived: stable(chapBefore, chapAfter),
        projectIntact: stable(projAfter, projectRow),
        snapshotWritableAfterUpgrade: Boolean(snapAfterWrite) && snapAfterWrite.projectTitle === 'Migrated Project',
      };

      fresh.close();
      await Dexie.delete(MIG_DB);
    }
  }

  /* ================================================================== */
  /* PHASE B — SNAPSHOT REPOSITORY + PROJECT CASCADE                     */
  /* ================================================================== */
  const DB_NAME = window.__P9SNAP_DB_NAME;
  const Dexie = Object.getPrototypeOf(NovelStudioDb);
  const db = new NovelStudioDb(DB_NAME);
  __setDbForTesting(db); // install BEFORE constructing any service
  await db.open();

  const { SnapshotRepository } = await import('/src/repositories/snapshot-repository.ts');
  const { ProjectService } = await import('/src/services/project-service.ts');
  const { WorldService } = await import('/src/services/world-service.ts');
  const { OutlineService } = await import('/src/services/outline-service.ts');

  const repo = new SnapshotRepository(db);
  const projects = new ProjectService();
  const worlds = new WorldService();
  const outline = new OutlineService();

  const snap = (projectId, seq, createdAt, overrides = {}) => {
    const project = makeProject(projectId, `Title ${projectId}`);
    const payload = buildPayload(project);
    return {
      id: `snap_${projectId}_${seq}`,
      projectId,
      label: `capture ${seq}`,
      reason: overrides.reason ?? 'manual',
      createdAt,
      schemaVersion: 13,
      formatVersion: 1,
      projectTitle: project.title,
      counts: { worlds: 1 },
      wordCount: overrides.wordCount ?? 0,
      integrity: { algorithm: 'sha256', digest: payload.integrity.digest },
      payload,
      ...('countsOverride' in overrides ? { counts: overrides.countsOverride } : {}),
    };
  };

  // Create two real projects A and B via the service, with a child each.
  const projA = await projects.createProject({ title: 'Snapshot A' });
  const projB = await projects.createProject({ title: 'Snapshot B' });
  await worlds.createWorld(projA.id, { title: 'A world', overview: 'A.' });
  const volA = await outline.createVolume(projA.id, { title: 'A volume' });
  const chapA = await outline.createChapter(projA.id, volA.id, { title: 'A chapter' });
  await worlds.createWorld(projB.id, { title: 'B world', overview: 'B.' });

  /* ---- (1) create + getById round-trip ---- */
  const s1 = await repo.create(snap(projA.id, 1, T0 + 100));
  const got1 = await repo.getById(s1.id);
  const roundTripOk =
    got1 !== null &&
    got1.id === s1.id &&
    got1.label === 'capture 1' &&
    JSON.stringify(got1.payload) === JSON.stringify(s1.payload) &&
    got1.integrity.digest === s1.integrity.digest;
  report.createGet = { roundTripOk, missingReturnsNull: (await repo.getById('snap_nope')) === null };

  /* ---- (2) duplicate id fails loudly ---- */
  let dupThrew = false;
  try {
    await repo.create(snap(projA.id, 1, T0 + 200)); // same id as s1
  } catch {
    dupThrew = true;
  }
  // The original must be untouched after the failed add.
  const afterDup = await repo.getById(s1.id);
  report.immutability = { duplicateAddThrew: dupThrew, originalUnchanged: JSON.stringify(afterDup) === JSON.stringify(s1) };

  /* ---- (3) invalid snapshot rejected before write ---- */
  let invalidThrew = false;
  try {
    const bad = snap(projA.id, 99, T0 + 300);
    bad.reason = 'auto'; // invalid enum
    await repo.create(bad);
  } catch {
    invalidThrew = true;
  }
  report.validation = { invalidRejectedBeforeWrite: invalidThrew, invalidNotStored: (await repo.getById(`snap_${projA.id}_99`)) === null };

  /* ---- (4) listByProject: newest-first, strict scoping ---- */
  // Add more snapshots to A with interleaved timestamps, plus B's snapshots.
  await repo.create(snap(projA.id, 2, T0 + 300));
  await repo.create(snap(projA.id, 3, T0 + 200)); // older than seq 2 but newer than seq 1
  await repo.create(snap(projB.id, 1, T0 + 150));
  await repo.create(snap(projB.id, 2, T0 + 250));

  const listA = await repo.listByProject(projA.id);
  const listB = await repo.listByProject(projB.id);
  const aIds = listA.map((s) => s.id);
  const bIds = listB.map((s) => s.id);
  const aOnlyA = listA.every((s) => s.projectId === projA.id);
  const bOnlyB = listB.every((s) => s.projectId === projB.id);
  const aOrderedDesc = listA.every((s, i) => i === 0 || listA[i - 1].createdAt >= s.createdAt);
  // Expected A order by createdAt desc: seq2(300), seq3(200), seq1(100).
  const aExpected = [`snap_${projA.id}_2`, `snap_${projA.id}_3`, `snap_${projA.id}_1`];
  report.list = {
    aCount: listA.length,
    bCount: listB.length,
    aOnlyA,
    bOnlyB,
    aOrderedDesc,
    aOrderMatches: JSON.stringify(aIds) === JSON.stringify(aExpected),
    aIds,
    bIds,
    countA: await repo.countByProject(projA.id),
  };

  /* ---- (5) deleteById: scoped + idempotent, never touches project data ---- */
  const projABefore = await projects.getProject(projA.id);
  const chapABefore = await outline.getChapter(chapA.id).catch(() => null);
  await repo.deleteById(`snap_${projA.id}_3`);
  const afterDeleteOne = await repo.listByProject(projA.id);
  // Deleting again (missing) must be a no-op, not a throw.
  let idempotentOk = true;
  try {
    await repo.deleteById(`snap_${projA.id}_3`);
  } catch {
    idempotentOk = false;
  }
  const projAAfter = await projects.getProject(projA.id);
  const snapsBUnaffected = (await repo.listByProject(projB.id)).length === 2;
  report.deleteById = {
    removed: afterDeleteOne.length === 2 && !afterDeleteOne.some((s) => s.id === `snap_${projA.id}_3`),
    idempotent: idempotentOk,
    projectDataUntouched: JSON.stringify(projABefore) === JSON.stringify(projAAfter),
    otherProjectSnapshotsUntouched: snapsBUnaffected,
  };

  /* ---- (6) deleteByProjectId: removes only that project's snapshots ---- */
  // Re-add a snapshot to A so it has two, then delete all of A's snapshots.
  await repo.create(snap(projA.id, 4, T0 + 400));
  const aCountBefore = await repo.countByProject(projA.id);
  const removed = await repo.deleteByProjectId(projA.id);
  const aAfter = await repo.countByProject(projA.id);
  const bAfterCountByProject = await repo.countByProject(projB.id);
  const aProjectStillExists = (await projects.getProject(projA.id)) !== null; // deleting snapshots must not delete the project
  report.deleteByProjectId = {
    aCountBefore,
    removed,
    aAfter,
    bStillTwo: bAfterCountByProject === 2,
    projectRowStillExists: aProjectStillExists,
  };

  /* ---- (7) ProjectService.deleteProject cascades snapshots ---- */
  // Give both projects fresh snapshots, then delete project B entirely.
  await repo.create(snap(projA.id, 10, T0 + 500));
  await repo.create(snap(projB.id, 10, T0 + 500));
  const aSnapsBefore = await repo.countByProject(projA.id);
  const bSnapsBefore = await repo.countByProject(projB.id);
  await projects.deleteProject(projB.id);

  const bProjectGone = (await projects.getProject(projB.id)) === null;
  const bWorldGone = await db.worlds.where('projectId').equals(projB.id).count() === 0;
  const bSnapsGone = await repo.countByProject(projB.id) === 0;
  // Direct table check too (not via the repository, to prove physical removal).
  const bSnapsPhysical = await db.projectSnapshots.where('projectId').equals(projB.id).count() === 0;

  const aSnapsAfter = await repo.countByProject(projA.id);
  const aProjectStillThere = (await projects.getProject(projA.id)) !== null;
  const aWorldStillThere = (await db.worlds.where('projectId').equals(projA.id).count()) === 1;

  report.cascade = {
    bProjectGone,
    bWorldGone,
    bSnapsGone,
    bSnapsPhysical,
    bSnapsBefore,
    aProjectStillThere,
    aWorldStillThere,
    aSnapsBefore,
    aSnapsAfter,
    aSnapsUnchanged: aSnapsBefore === aSnapsAfter,
  };

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
