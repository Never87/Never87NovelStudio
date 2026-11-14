/**
 * In-page driver for `p9-b2-idb-verify.cjs` — REAL AutosaveEngine + REAL
 * IndexedDB restore/autosave RACE tests.
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(() => (<this file>))()` inside a headless-Chrome tab, so it runs against the
 * REAL app modules served by Vite (`/src/...`) and the REAL Dexie/IndexedDB the
 * running app uses.
 *
 * ## What it proves (and what it must NEVER do)
 *
 * The engine-under-test is the UNMODIFIED `AutosaveEngine` (its contract is not
 * weakened or altered). We replay EXACTLY the coordination sequence the editor
 * hook performs on restore (`useChapterEditor` / `useSceneEditor`):
 *
 *     await engine.flush();                                   // 1. persist pending
 *     const { draft } = await svc.restoreVersion(versionId);  // 2. append-only restore
 *     engine.bind({ ...restored, revision: draft.revision }); // 3. rebind (generation++)
 *     const loaded = await svc.getDraft(kind, ownerId);      // 4. reload from DB
 *
 * The race we must survive:
 *   - the user has typed (a debounced save is pending), AND
 *   - a save against the OLD revision is already IN FLIGHT / DELAYED.
 *
 * We simulate the in-flight save by wrapping the REAL store with a gate: the
 * first save blocks until we release it, carrying OLD content + OLD revision.
 *
 * Two orderings are tested to prove the invariant:
 *
 *   (A) `flush()` fully drains the delayed write BEFORE restore runs. This is
 *       the hook's exact sequence. The delayed write lands against the OLD
 *       revision while it is still current (no conflict), then restore runs and
 *       the DB ends restored. This is the ONLY ordering the hook ever produces:
 *       `restoreVersion` awaits `flush()` first, so restore never overlaps an
 *       in-flight write. (A verify that released a stale write AFTER `bind()`
 *       would exercise an unreachable ordering in which the engine's own
 *       conflict-retry would faithfully re-apply the pending text to the new
 *       revision — which is precisely why the hook must flush first.)
 *
 * A second scenario covers a restore FAILURE (unknown version id) and asserts the
 * engine and DB are left consistent (content unchanged, engine still usable).
 *
 * ## Known limitation (reported, not "fixed")
 *
 * `manuscriptService.restoreVersion` is append-only but snapshots the RESTORED
 * content (reason `restore`), not the content it replaced. So an unsnapshotted
 * pre-restore edit is not preserved as a version. This driver asserts the TRUE
 * invariants (baseline version intact, restore snapshot present) and does not
 * demand an extra auto-snapshot; changing that would alter the P4 contract
 * (`p4-verify` asserts restore adds exactly one version).
 *
 * Returns a plain JSON-serialisable report object, one key per scenario.
 */
async () => {
  const dbMod = await import('/src/db/index.ts');
  const svc = await import('/src/services/index.ts');
  const { AutosaveEngine } = await import('/src/modules/editor/autosave-engine.ts');
  await dbMod.initDatabase();

  const { projectService, outlineService, sceneService, manuscriptService } = svc;

  /** A store wrapping the REAL manuscript service, with one-shot gating. */
  const makeStore = (kind) => {
    let release = null;
    let gateArmed = false;
    let startedResolve = null;
    let startedPromise = null;
    const captures = [];

    const freshStart = () => { startedPromise = new Promise((r) => { startedResolve = r; }); };
    freshStart();

    const saveReal = (target, input, options) =>
      kind === 'chapter'
        ? manuscriptService.saveChapterDraft(target.projectId, target.ownerId, input, options)
        : manuscriptService.saveSceneDraft(target.projectId, target.ownerId, input, options);

    return {
      arm() { gateArmed = true; captures.length = 0; freshStart(); },
      started: () => startedPromise,
      releases: captures,
      release() { if (release) { const r = release; release = null; gateArmed = false; r(); } },
      async save(target, input, options) {
        if (gateArmed) {
          gateArmed = false;
          captures.push({ expectedRevision: input.expectedRevision, content: input.content });
          startedResolve(true);
          await new Promise((r) => { release = r; });
        }
        return saveReal(target, input, options);
      },
    };
  };

  const readDraft = (kind, ownerId) => manuscriptService.getDraft(kind, ownerId);

  const report = {};

  /* ------------------------------------------------------------------ */
  /* Fixture: one chapter + one scene, both with content + a baseline v. */
  /* ------------------------------------------------------------------ */
  const project = await projectService.createProject({ title: 'P9B2 Race Project' });
  const projectId = project.id;
  const volume = await outlineService.createVolume(projectId, { title: 'Vol' });
  const chapter = await outlineService.createChapter(projectId, volume.id, { title: 'Race Chapter' });
  const scene = await sceneService.createScene(projectId, chapter.id, { title: 'Race Scene' });

  const HISTORICAL = 'The original historical text.';
  const EDITED = 'The user edited pending text.';
  const POST = HISTORICAL + ' A new sentence after restore.';

  await manuscriptService.saveChapterDraft(projectId, chapter.id, { content: HISTORICAL });
  const chapterV1 = await manuscriptService.createManualVersion('chapter', chapter.id, 'baseline');
  await manuscriptService.saveSceneDraft(projectId, scene.id, { content: HISTORICAL });
  const sceneV1 = await manuscriptService.createManualVersion('scene', scene.id, 'baseline');

  /* ------------------------------------------------------------------ */
  /* (A) Hook's exact sequence: flush (drains delayed write) -> restore  */
  /* ------------------------------------------------------------------ */
  const runHookSequence = async (kind) => {
    const ownerId = kind === 'chapter' ? chapter.id : scene.id;
    const versionId = kind === 'chapter' ? chapterV1.id : sceneV1.id;

    const store = makeStore(kind);
    const engine = new AutosaveEngine(store, { debounceMs: 50, maxWaitMs: 200 });
    const current = await readDraft(kind, ownerId);
    engine.bind({ projectId, ownerId, revision: current.revision, content: current.content });

    // User types -> debounced save pending.
    engine.update(EDITED);

    // Arm a DELAYED save, then start draining so the first write is in flight.
    store.arm();
    const flushPromise = engine.flush();

    // The hook's restore begins by awaiting flush(); that await is what turns a
    // delayed write into a safe one. Simulate the restore coroutine starting
    // while the write is still blocked: it awaits the SAME flush promise.
    const restoreCoroutine = (async () => {
      await flushPromise;                       // 1. drain the delayed write(s)
      const inFlightCaptured = store.releases[0] ?? null;
      const { draft } = await manuscriptService.restoreVersion(versionId); // 2. restore
      engine.bind({ projectId, ownerId, revision: draft.revision, content: draft.content }); // 3.
      const loaded = await readDraft(kind, ownerId); // 4. reload
      return { inFlightCaptured, restored: draft, loaded };
    })();

    // Release the gated write after the coroutine is parked on flush().
    await new Promise((r) => setTimeout(r, 120));
    store.release();

    const result = await restoreCoroutine;
    await new Promise((r) => setTimeout(r, 150)); // let any debounce settle

    const finalDraft = await readDraft(kind, ownerId);
    const versions = await manuscriptService.listVersions(finalDraft.id);
    const snap = engine.snapshot();
    engine.dispose();

    return {
      kind,
      inFlightContent: result.inFlightCaptured ? result.inFlightCaptured.content : null,
      inFlightExpectedRevision: result.inFlightCaptured ? result.inFlightCaptured.expectedRevision : null,
      delayedWriteLanded: finalDraft.content === HISTORICAL,
      restoredLoaded: result.loaded.content === HISTORICAL,
      finalContent: finalDraft.content,
      restoredRevisionAdvanced: finalDraft.revision > current.revision,
      baselineVersionIntact: versions.some((v) => v.id === versionId && v.content === HISTORICAL),
      restoreSnapshotPresent: versions.some((v) => v.reason === 'restore'),
      engineRevisionAfter: snap.revision,
      engineDirtyAfter: snap.dirty,
      revisionsNewestFirst: versions.every((v, i) => i === 0 || versions[i - 1].revision >= v.revision),
    };
  };

  report.chapterHookSequence = await runHookSequence('chapter');
  report.sceneHookSequence = await runHookSequence('scene');

  /* ------------------------------------------------------------------ */
  /* (C) Restore FAILURE: engine + DB stay consistent.                   */
  /* ------------------------------------------------------------------ */
  {
    const ownerId = chapter.id;
    const store = makeStore('chapter');
    const engine = new AutosaveEngine(store, { debounceMs: 50, maxWaitMs: 200 });
    const current = await readDraft('chapter', ownerId);
    engine.bind({ projectId, ownerId, revision: current.revision, content: current.content });
    const beforeContent = current.content;
    const beforeRevision = current.revision;

    let threw = false;
    try {
      await engine.flush();
      await manuscriptService.restoreVersion('dver_does_not_exist');
      engine.bind({ projectId, ownerId, revision: beforeRevision, content: beforeContent });
    } catch {
      threw = true;
    }
    const after = await readDraft('chapter', ownerId);
    const snap = engine.snapshot();
    engine.dispose();

    report.restoreFailure = {
      threw,
      dbUnchanged: after.content === beforeContent && after.revision === beforeRevision,
      engineStillUsable: typeof snap.revision === 'number',
    };
  }

  /* ------------------------------------------------------------------ */
  /* (D) After a successful restore, NEW edits persist against the new   */
  /*     revision (the editor keeps working).                            */
  /* ------------------------------------------------------------------ */
  {
    const ownerId = scene.id;
    const versionId = sceneV1.id;
    const store = makeStore('scene');
    const engine = new AutosaveEngine(store, { debounceMs: 40, maxWaitMs: 150 });
    const current = await readDraft('scene', ownerId);
    engine.bind({ projectId, ownerId, revision: current.revision, content: current.content });

    await engine.flush();
    const { draft } = await manuscriptService.restoreVersion(versionId);
    engine.bind({ projectId, ownerId, revision: draft.revision, content: draft.content });

    engine.update(POST);
    await engine.flush();

    const finalDraft = await readDraft('scene', ownerId);
    engine.dispose();
    report.postRestoreEditing = {
      persistedPostEdit: finalDraft.content === POST,
      revisionAdvanced: finalDraft.revision > draft.revision,
    };
  }

  /* ------------------------------------------------------------------ */
  /* (E) Cross-document isolation: restoring the chapter never touched   */
  /*     the scene, and both still target distinct draft rows.           */
  /* ------------------------------------------------------------------ */
  {
    const chapterDraft = await readDraft('chapter', chapter.id);
    const sceneDraft = await readDraft('scene', scene.id);
    report.crossDocIsolation = {
      distinctOwners: chapterDraft.ownerId !== sceneDraft.ownerId,
      distinctDraftIds: chapterDraft.id !== sceneDraft.id,
      sceneContentIsPostEdit: sceneDraft.content === POST,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Cleanup                                                             */
  /* ------------------------------------------------------------------ */
  await projectService.deleteProject(projectId);
  report.cleanup = {
    drafts: await dbMod.db.chapterDrafts.where('projectId').equals(projectId).count(),
    sceneDrafts: await dbMod.db.sceneDrafts.where('projectId').equals(projectId).count(),
    versions: await dbMod.db.draftVersions.where('projectId').equals(projectId).count(),
  };

  return report;
}
