/**
 * In-page driver for `p9-snapshot-service-idb-verify.cjs` (P9 Batch 3-2).
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(${<this file contents>})()` inside a headless-Chrome tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite (`/src/...`)
 * and a REAL IndexedDB.
 *
 * Everything is seeded through the EXISTING application services (never
 * hand-built rows used as the source of truth), so SnapshotService is exercised
 * against data the application itself produces, across all 19 project-owned
 * collections — including P7 (knowledge/continuity/analysis), P8
 * (documents/sections/extractions) and B2 (immutable draftVersions).
 *
 * Database isolation: each scenario runs on its OWN throw-away database
 * installed as the process-wide singleton before any service is built, so
 * scenarios never interfere and the user's real store is never touched.
 *
 * Returns a plain JSON-serialisable report object.
 */
async () => {
  const dbMod = await import('/src/db/index.ts');
  const { NovelStudioDb, __setDbForTesting } = dbMod;
  const Dexie = Object.getPrototypeOf(NovelStudioDb);

  const { ProjectService } = await import('/src/services/project-service.ts');
  const { CharacterService } = await import('/src/services/character-service.ts');
  const { WorldService } = await import('/src/services/world-service.ts');
  const { NarrativeService } = await import('/src/services/narrative-service.ts');
  const { OutlineService } = await import('/src/services/outline-service.ts');
  const { SceneService } = await import('/src/services/scene-service.ts');
  const { ManuscriptService } = await import('/src/services/manuscript-service.ts');
  const { SnapshotService, SnapshotServiceError } = await import('/src/services/snapshot-service.ts');
  const { SnapshotRepository } = await import('/src/repositories/snapshot-repository.ts');
  const { ProjectRepository } = await import('/src/repositories/project-repository.ts');
  const { PromptTemplateService } = await import('/src/services/prompt-template-service.ts');
  const { ContextRepository } = await import('/src/repositories/context-repository.ts');
  const { KnowledgeRepository } = await import('/src/repositories/knowledge-repository.ts');
  const { ContinuityRepository } = await import('/src/repositories/continuity-repository.ts');
  const { AnalysisRepository } = await import('/src/repositories/analysis-repository.ts');
  const { AiRepository } = await import('/src/repositories/ai-repository.ts');
  const { ImportService } = await import('/src/services/import-service.ts');
  const { ExtractionService } = await import('/src/services/extraction-service.ts');
  const { TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS } = await import('/src/transfer/index.ts');
  const { computeIntegrity } = await import('/src/transfer/canonical-json.ts');

  const ts = 1_700_000_000_000;
  const report = {};

  /* ------------------------------------------------------------------ */
  /* Fresh isolated database installed as the singleton                  */
  /* ------------------------------------------------------------------ */
  const freshDb = async (suffix) => {
    const name = `${window.__P9SNAP_DB_NAME}-${suffix}`;
    const db = new NovelStudioDb(name);
    __setDbForTesting(db);
    await db.open();
    const importService = new ImportService();
    return {
      db,
      name,
      projects: new ProjectService(),
      worldService: new WorldService(),
      characters: new CharacterService(),
      narrative: new NarrativeService(),
      outline: new OutlineService(),
      scenes: new SceneService(),
      manuscript: new ManuscriptService(),
      prompts: new PromptTemplateService(),
      contextRepo: new ContextRepository(db),
      knowledgeRepo: new KnowledgeRepository(db),
      continuityRepo: new ContinuityRepository(db),
      analysisRepo: new AnalysisRepository(db),
      aiRepo: new AiRepository(db),
      importService,
      extractionService: new ExtractionService({
        importService,
        generate: async () => { throw new Error('no AI in the snapshot service idb test'); },
      }),
      snapshots: new SnapshotService(
        db,
        new SnapshotRepository(db),
        new ProjectRepository(db),
        new TransferService(new TransferRepositoryAdapter(db)),
      ),
    };
  };

  const dropDb = async (db, name) => {
    db.close();
    await Dexie.delete(name);
  };

  /* ------------------------------------------------------------------ */
  /* Seeder: a COMPLETE project across all 19 collections                */
  /* ------------------------------------------------------------------ */
  const seedCompleteProject = async (ctx, title) => {
    const tag = `${title}-N87`;
    const project = await ctx.projects.createProject({
      title,
      description: `${tag} description with a secret-sounding phrase: sk-LEAKCANARY`,
      genre: ['fantasy'], tags: [tag],
    });
    const projectId = project.id;

    await ctx.worldService.createWorld(projectId, {
      title: `${tag} world`, overview: `Overview of ${tag}`,
      themes: [`theme-${tag}`], sections: [{ title: 'Geography', content: `Mountains of ${tag}.` }],
    });

    const charA = await ctx.characters.createCharacter(projectId, { name: `${tag} Elara`, role: 'protagonist', summary: 'Brave.' });
    const charB = await ctx.characters.createCharacter(projectId, { name: `${tag} Aria`, role: 'supporting' });

    const plan = await ctx.narrative.createPlan(projectId, {
      logline: `${tag} logline`, structure: 'three-act',
      beats: [{ title: `${tag} inciting incident`, description: 'It begins.' }],
    });
    const beatId = plan.beats[0].id;

    const volume = await ctx.outline.createVolume(projectId, { title: `${tag} volume` });
    const chapter = await ctx.outline.createChapter(projectId, volume.id, {
      title: `${tag} chapter`, plotBeatId: beatId, characterIds: [charA.id, charB.id],
    });
    const scene = await ctx.scenes.createScene(projectId, chapter.id, {
      title: `${tag} opening scene`, povCharacterId: charA.id, characterIds: [charA.id],
    });

    await ctx.manuscript.saveChapterDraft(projectId, chapter.id, { content: `${tag} Elara walked into the forest.` });
    await ctx.manuscript.saveSceneDraft(projectId, scene.id, { content: `${tag} Elara drew her blade; Aria followed.` });
    await ctx.manuscript.createManualVersion('chapter', chapter.id, 'first');
    await ctx.manuscript.createManualVersion('scene', scene.id, 'first');

    const template = await ctx.prompts.createTemplate(projectId, {
      name: `${tag} Continue`, category: 'Continuation',
      content: `Continue the scene for ${tag} with {{chapterTitle}}`,
      variables: [{ name: 'chapterTitle', description: '', required: false }],
    });

    const contextItem = await ctx.contextRepo.putItem({
      id: `ctx_${projectId}_1`, projectId, layer: 'instructions', sourceType: 'instruction',
      sourceId: null, sourceLabel: `${tag} instruction`, content: `Write with restraint for ${tag}.`,
      priority: 'normal', enabled: true, persistent: true, createdAt: ts, updatedAt: ts,
    });
    await ctx.contextRepo.putConfig({
      id: `ctxcfg_${projectId}_1`, projectId, budgetEnabled: true, inputBudgetTokens: 8000,
      contextWindowOverrideTokens: null, requestedOutputTokens: 2048,
      enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
      persistentInstructions: `${tag} instructions`, createdAt: ts, updatedAt: ts,
    });

    const rawDoc = `# ${tag} Volume\n\n## ${tag} Chapter\n\n${tag} Elara the brave walked into the forest.\n`;
    const document = await ctx.importService.createDocument(projectId, { format: 'markdown', rawText: rawDoc });
    await ctx.importService.parseDocument(projectId, document.id);
    await ctx.importService.confirmStructure(projectId, document.id);
    const sections = await ctx.importService.getConfirmedSections(projectId, document.id);
    const proseSection = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];

    await ctx.extractionService.createManualExtraction(projectId, {
      documentId: document.id, kind: 'character', title: `${tag} Extracted Hera`, summary: `${tag} summary`,
      body: `${tag} body`, evidence: [{ sectionId: proseSection.id, quote: `${tag} Elara the brave` }],
      relatedIds: [charA.id],
    });

    const knowledge = await ctx.knowledgeRepo.create({
      id: `know_${projectId}_1`, projectId, kind: 'character', title: `${tag} knowledge`,
      summary: `${tag} summary`, body: '', tags: [tag], source: 'manual',
      sourceRef: { entityType: 'manual', entityId: null, key: null }, sourceKey: null,
      evidence: [{ chapterId: chapter.id, sceneId: scene.id, quote: '', offset: null, note: '',
        source: { documentId: document.id, sectionId: proseSection.id, start: 0, end: Math.min(5, proseSection.text.length) } }],
      searchText: `${tag}`.toLowerCase(), createdAt: ts, updatedAt: ts,
    });

    const continuity = await ctx.continuityRepo.create({
      id: `cont_${projectId}_1`, projectId, subjectType: 'character', subjectId: charA.id,
      subjectLabel: `${tag} Elara`, predicate: 'position', value: `${tag} forest`, relatedLabel: '',
      anchorChapterId: chapter.id, anchorSceneId: scene.id, anchorRank: 0,
      evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: '' }],
      createdAt: ts, updatedAt: ts,
    });

    await ctx.analysisRepo.create({
      id: `find_${projectId}_1`, projectId, category: 'continuity', severity: 'warning', status: 'open',
      origin: 'deterministic', title: `${tag} finding`, description: `${tag} description`,
      evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: '' }],
      relatedFactIds: [continuity.id], relatedEntryIds: [knowledge.id], createdAt: ts, updatedAt: ts,
    });

    return {
      projectId, tag,
      ids: {
        charA: charA.id, chapter: chapter.id, scene: scene.id, volume: volume.id, plan: plan.id,
        template: template.id, contextItem: contextItem.id, knowledge: knowledge.id,
        continuity: continuity.id, document: document.id, proseSection: proseSection.id,
      },
    };
  };

  /* ------------------------------------------------------------------ */
  /* Fingerprinting helpers (for rollback proof)                         */
  /* ------------------------------------------------------------------ */
  const readOwnedRows = async (db, c, projectId) =>
    c.ownerKey === 'projectId'
      ? db.table(c.table).where('projectId').equals(projectId).toArray()
      : db.table(c.table).filter((r) => r.id === projectId).toArray();

  const projectFingerprint = async (db, projectId) => {
    const out = {};
    out.projects = JSON.stringify(await db.projects.get(projectId));
    for (const c of TRANSFER_COLLECTIONS) {
      const rows = await readOwnedRows(db, c, projectId);
      rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
      out[c.key] = JSON.stringify(rows);
    }
    return out;
  };
  const fingerprintsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const dbCounts = async (db, projectId) => {
    const counts = {};
    for (const c of TRANSFER_COLLECTIONS) counts[c.key] = (await readOwnedRows(db, c, projectId)).length;
    return counts;
  };

  const dbIdSets = async (db, projectId) => {
    const out = {};
    for (const c of TRANSFER_COLLECTIONS) out[c.key] = (await readOwnedRows(db, c, projectId)).map((r) => r.id).sort();
    return out;
  };

  /* ================================================================== */
  /* SCENARIO 1 — CAPTURE                                                */
  /* ================================================================== */
  {
    const ctx = await freshDb('capture');
    const { db, snapshots } = ctx;
    try {
      const A = await seedCompleteProject(ctx, 'CapAlpha');
      const empty = await ctx.projects.createProject({ title: 'CapEmpty' });
      await ctx.worldService.createWorld(empty.id, { title: 'CapEmpty world' });

      // A real credential in the secret-bearing table (must never be captured).
      await ctx.aiRepo.createProvider({
        id: 'prov_secret_1', name: 'SecretProvider', providerType: 'openai', baseUrl: '',
        apiKey: 'sk-REALSECRET-0123456789',
        customHeaders: [{ name: 'X-Secret', value: 'bearer TOPSECRETVALUE' }], enabled: true, createdAt: ts, updatedAt: ts,
      });

      const snapA = await snapshots.createSnapshot(A.projectId, { label: 'first capture', now: ts + 500 });

      const payloadCounts = {};
      for (const c of TRANSFER_COLLECTIONS) payloadCounts[c.key] = snapA.payload.data[c.key].length;
      const directCounts = await dbCounts(db, A.projectId);
      const keysComplete = TRANSFER_COLLECTIONS.every((c) => Object.prototype.hasOwnProperty.call(snapA.payload.data, c.key));

      const metadataConsistent =
        snapA.projectId === A.projectId &&
        snapA.payload.project.id === A.projectId &&
        snapA.projectTitle === snapA.payload.project.title &&
        snapA.integrity.digest === snapA.payload.integrity.digest &&
        JSON.stringify(snapA.counts) === JSON.stringify(payloadCounts) &&
        snapA.schemaVersion === 13 && snapA.formatVersion === 1;

      const recomputed = computeIntegrity({ project: snapA.payload.project, data: snapA.payload.data });
      const integrityOk = recomputed.digest === snapA.integrity.digest;

      const expectedWordCount =
        snapA.payload.data.chapterDrafts.reduce((s, d) => s + d.wordCount, 0) +
        snapA.payload.data.sceneDrafts.reduce((s, d) => s + d.wordCount, 0);

      const json = JSON.stringify(snapA.payload);
      const secretTokens = ['sk-realsecret', 'topsecretvalue', 'prov_secret_1', 'secretprovider', 'aiproviders', 'apikey'];
      const leaked = secretTokens.filter((t) => json.toLowerCase().includes(t));
      const notNested = !Object.prototype.hasOwnProperty.call(snapA.payload.data, 'projectSnapshots')
        && !Object.keys(snapA.payload).some((k) => k === 'snapshots');

      const snapEmpty = await snapshots.createSnapshot(empty.id, { now: ts + 600 });
      const emptyCounts = {};
      for (const c of TRANSFER_COLLECTIONS) emptyCounts[c.key] = snapEmpty.payload.data[c.key].length;
      const emptyOk =
        emptyCounts.worlds === 1 &&
        TRANSFER_COLLECTIONS.filter((c) => c.key !== 'worlds').every((c) => emptyCounts[c.key] === 0) &&
        TRANSFER_COLLECTIONS.every((c) => Array.isArray(snapEmpty.payload.data[c.key]));

      const snapA2 = await snapshots.createSnapshot(A.projectId, { now: ts + 700 });
      const listA = await snapshots.listSnapshots(A.projectId);
      const consecutiveOk = listA.length === 2 && snapA2.id !== snapA.id && listA.every((s) => s.projectId === A.projectId);

      const listEmpty = await snapshots.listSnapshots(empty.id);
      const isolationOk = listEmpty.length === 1 && listEmpty[0].projectId === empty.id &&
        listA.every((s) => s.projectId === A.projectId);

      let missingProjectCode = null;
      try { await snapshots.createSnapshot('proj_does_not_exist'); }
      catch (e) { missingProjectCode = e instanceof SnapshotServiceError ? e.code : '?'; }
      const noHalfRecord = (await snapshots.listSnapshots('proj_does_not_exist')).length === 0;

      report.capture = {
        completeAllNineteen: TRANSFER_COLLECTIONS.length === 19 && keysComplete &&
          TRANSFER_COLLECTIONS.every((c) => payloadCounts[c.key] === directCounts[c.key]),
        everyCollectionPopulated: TRANSFER_COLLECTIONS.every((c) => payloadCounts[c.key] > 0),
        payloadCounts, directCounts,
        metadataConsistent, integrityOk,
        wordCountMatches: snapA.wordCount === expectedWordCount,
        secretsExcluded: leaked.length === 0, leaked,
        snapshotNotNested: notNested,
        emptyCaptureOk: emptyOk, emptyCounts,
        consecutiveOk, isolationOk,
        missingProjectCode, noHalfRecord,
      };
    } finally {
      await dropDb(db, ctx.name);
    }
  }

  /* ================================================================== */
  /* SCENARIO 2 — GET / DELETE isolation & ordering                      */
  /* ================================================================== */
  {
    const ctx = await freshDb('manage');
    const { db, snapshots } = ctx;
    try {
      const A = await seedCompleteProject(ctx, 'MgAlpha');
      const B = await seedCompleteProject(ctx, 'MgBeta');
      const snapA = await snapshots.createSnapshot(A.projectId, { now: ts + 100 });
      const snapB = await snapshots.createSnapshot(B.projectId, { now: ts + 200 });
      const repo = new SnapshotRepository(db);

      const gotA = await snapshots.getSnapshot(snapA.id, A.projectId);
      const getOwnOk = gotA.id === snapA.id;

      let getWrongCode = null;
      try { await snapshots.getSnapshot(snapA.id, B.projectId); } catch (e) { getWrongCode = e instanceof SnapshotServiceError ? e.code : '?'; }

      let getMissingCode = null;
      try { await snapshots.getSnapshot('snap_nope', A.projectId); } catch (e) { getMissingCode = e instanceof SnapshotServiceError ? e.code : '?'; }

      let delWrongCode = null;
      try { await snapshots.deleteSnapshot(snapA.id, B.projectId); } catch (e) { delWrongCode = e instanceof SnapshotServiceError ? e.code : '?'; }
      const survivesWrongDelete = (await repo.getById(snapA.id)) !== null;

      let delMissingCode = null;
      try { await snapshots.deleteSnapshot('snap_nope', A.projectId); } catch (e) { delMissingCode = e instanceof SnapshotServiceError ? e.code : '?'; }

      const projABefore = await projectFingerprint(db, A.projectId);
      await snapshots.deleteSnapshot(snapA.id, A.projectId);
      const afterDelete = await snapshots.listSnapshots(A.projectId);
      const projAAfter = await projectFingerprint(db, A.projectId);
      const bStillThere = (await repo.getById(snapB.id)) !== null;

      await snapshots.createSnapshot(A.projectId, { now: ts + 300 });
      await snapshots.createSnapshot(A.projectId, { now: ts + 250 });
      await snapshots.createSnapshot(A.projectId, { now: ts + 350 });
      const ordered = await snapshots.listSnapshots(A.projectId);
      const orderedDesc = ordered.every((s, i) => i === 0 || ordered[i - 1].createdAt >= s.createdAt);

      report.manage = {
        getOwnOk, getWrongCode, getMissingCode,
        delWrongCode, survivesWrongDelete, delMissingCode,
        deleteRemovedOne: afterDelete.length === 0,
        projectDataUntouched: fingerprintsEqual(projABefore, projAAfter),
        otherProjectSnapshotUntouched: bStillThere,
        orderedDesc, orderedCreatedAts: ordered.map((s) => s.createdAt),
      };
    } finally {
      await dropDb(db, ctx.name);
    }
  }

  /* ================================================================== */
  /* SCENARIO 3 — FULL RESTORE (replace, delete-extra, preserve ids)    */
  /* ================================================================== */
  {
    const ctx = await freshDb('restore');
    const { db, snapshots } = ctx;
    try {
      const A = await seedCompleteProject(ctx, 'ReAlpha');
      const B = await seedCompleteProject(ctx, 'ReBeta');
      const BBefore = await projectFingerprint(db, B.projectId);
      const repo = new SnapshotRepository(db);

      const snapshot = await snapshots.createSnapshot(A.projectId, { label: 'baseline', now: ts + 100 });
      const snapshotJsonBefore = JSON.stringify(await repo.getById(snapshot.id));
      const snapshotCounts = {};
      for (const c of TRANSFER_COLLECTIONS) snapshotCounts[c.key] = snapshot.payload.data[c.key].length;

      // Mutate A: extra volume + extra chapter + extra character + edited draft.
      const vol2 = await ctx.outline.createVolume(A.projectId, { title: 'ReAlpha extra volume' });
      const extraChapter = await ctx.outline.createChapter(A.projectId, vol2.id, { title: 'ReAlpha extra chapter' });
      await ctx.characters.createCharacter(A.projectId, { name: 'ReAlpha Extra', role: 'minor' });
      await ctx.manuscript.saveChapterDraft(A.projectId, A.ids.chapter, { content: 'MUTATED CONTENT AFTER SNAPSHOT' });

      const mutatedCounts = await dbCounts(db, A.projectId);

      const result = await snapshots.restoreSnapshot(snapshot.id, A.projectId);

      const afterCounts = await dbCounts(db, A.projectId);
      const countsMatchAll = TRANSFER_COLLECTIONS.every((c) => afterCounts[c.key] === snapshotCounts[c.key]);

      const afterIds = await dbIdSets(db, A.projectId);
      const idsMatchSnapshot = TRANSFER_COLLECTIONS.every((c) => {
        const expect = snapshot.payload.data[c.key].map((r) => r.id).sort();
        return JSON.stringify(afterIds[c.key]) === JSON.stringify(expect);
      });

      const chapterDraft = await db.chapterDrafts.where('projectId').equals(A.projectId).first();
      const restoredDraft = snapshot.payload.data.chapterDrafts.find((d) => d.id === chapterDraft.id);
      const contentReverted = Boolean(restoredDraft) && chapterDraft.content === restoredDraft.content &&
        !chapterDraft.content.includes('MUTATED');

      const rootAfter = await db.projects.get(A.projectId);
      const rootOk = rootAfter.id === A.projectId &&
        rootAfter.title === snapshot.payload.project.title &&
        rootAfter.createdAt === snapshot.payload.project.createdAt;

      const BAfter = await projectFingerprint(db, B.projectId);

      const snapshotJsonAfter = JSON.stringify(await repo.getById(snapshot.id));
      const listAfter = await snapshots.listSnapshots(A.projectId);
      const safety = listAfter.find((s) => s.reason === 'pre-restore');
      const safetyMatchesMutated = safety
        ? safety.counts.chapters === mutatedCounts.chapters && safety.payload.data.chapters.length === mutatedCounts.chapters
        : false;

      const resultOk = result.snapshot.id === snapshot.id &&
        result.safetySnapshot.reason === 'pre-restore' && result.project.id === A.projectId;

      const documentSections = await db.documentSections.where('projectId').equals(A.projectId).toArray();
      const extractionRecords = await db.extractionRecords.where('projectId').equals(A.projectId).toArray();
      const knowledgeEntries = await db.knowledgeEntries.where('projectId').equals(A.projectId).toArray();
      const draftVersions = await db.draftVersions.where('projectId').equals(A.projectId).toArray();
      const chapterDrafts = await db.chapterDrafts.where('projectId').equals(A.projectId).toArray();
      const sceneDrafts = await db.sceneDrafts.where('projectId').equals(A.projectId).toArray();
      const sceneRows = await db.scenes.where('projectId').equals(A.projectId).toArray();
      const sectionById = new Map(documentSections.map((s) => [s.id, s]));
      const extractionEvidenceOk = extractionRecords.every((r) => r.evidence.every((e) => sectionById.has(e.sectionId)));
      const allDraftIds = new Set([...chapterDrafts.map((d) => d.id), ...sceneDrafts.map((d) => d.id)]);
      const draftVersionRefsOk = draftVersions.length > 0 && draftVersions.every((v) => allDraftIds.has(v.draftId));
      const knowledgeSourceOk = knowledgeEntries.every((k) => k.evidence.every((e) => !e.source || sectionById.has(e.source.sectionId)));

      const extraChapterGone = (await db.chapters.get(extraChapter.id)) === undefined;
      const extraCharGone = !(await db.characters.where('projectId').equals(A.projectId).toArray()).some((c) => c.name.includes('Extra'));
      const sceneRestored = sceneRows.some((s) => s.id === A.ids.scene);

      report.restore = {
        countsMatchAll, idsMatchSnapshot, contentReverted, rootOk,
        otherProjectUntouched: fingerprintsEqual(BBefore, BAfter),
        snapshotUnmodified: snapshotJsonBefore === snapshotJsonAfter,
        safetySnapshotCreated: Boolean(safety), safetyMatchesMutated,
        resultOk,
        mutatedChapterCount: mutatedCounts.chapters, snapshotChapterCount: snapshotCounts.chapters,
        extractionEvidenceOk, draftVersionRefsOk, knowledgeSourceOk,
        extraCharGone, extraChapterGone, sceneRestored,
        afterCounts, snapshotCounts,
      };
    } finally {
      await dropDb(db, ctx.name);
    }
  }

  /* ================================================================== */
  /* SCENARIO 4 — ATOMICITY via REAL FAULT INJECTION                    */
  /* ================================================================== */
  {
    const ctx = await freshDb('atomic');
    const { db, snapshots } = ctx;
    try {
      const repo = new SnapshotRepository(db);
      const A = await seedCompleteProject(ctx, 'AtAlpha');
      const snapshot = await snapshots.createSnapshot(A.projectId, { label: 'baseline', now: ts + 100 });
      const snapshotCounts = {};
      for (const c of TRANSFER_COLLECTIONS) snapshotCounts[c.key] = snapshot.payload.data[c.key].length;

      // Mutate A so a restore WOULD change it; on rollback the PRE-RESTORE state must remain.
      await ctx.characters.createCharacter(A.projectId, { name: 'AtAlpha Extra', role: 'minor' });
      await ctx.manuscript.saveChapterDraft(A.projectId, A.ids.chapter, { content: 'PRE-RESTORE CONTENT' });

      const before = await projectFingerprint(db, A.projectId);
      const listBefore = await snapshots.listSnapshots(A.projectId);

      // Inject a failure on a LATE collection so the root + early collections
      // (already written) must be rolled back by the real Dexie transaction.
      const poisonTable = 'extractionRecords';
      const originalBulkPut = db[poisonTable].bulkPut.bind(db[poisonTable]);
      let chaptersWrittenBeforePoison = 0;
      const origChaptersBulkPut = db.chapters.bulkPut.bind(db.chapters);
      db.chapters.bulkPut = async (...args) => { const r = await origChaptersBulkPut(...args); chaptersWrittenBeforePoison += args[0].length; return r; };
      db[poisonTable].bulkPut = async () => { throw new Error('INJECTED mid-transaction failure'); };

      let restoreError = null;
      try {
        await snapshots.restoreSnapshot(snapshot.id, A.projectId);
      } catch (e) {
        restoreError = e instanceof SnapshotServiceError
          ? { code: e.code, phase: e.phase, causeMessage: e.cause ? String(e.cause.message || e.cause) : null }
          : { code: 'non-snapshot', message: e && e.message };
      } finally {
        db[poisonTable].bulkPut = originalBulkPut;
        db.chapters.bulkPut = origChaptersBulkPut;
      }

      const after = await projectFingerprint(db, A.projectId);
      const listAfter = await snapshots.listSnapshots(A.projectId);
      const targetIntact = (await repo.getById(snapshot.id)) !== null;
      const safety = listAfter.find((s) => s.reason === 'pre-restore');

      // A subsequent NORMAL restore (no injection) must succeed.
      let followUpOk = false;
      let followUpError = null;
      try {
        const r2 = await snapshots.restoreSnapshot(snapshot.id, A.projectId);
        followUpOk = r2.project.id === A.projectId;
      } catch (e) {
        followUpError = e instanceof Error ? e.message : String(e);
      }
      const afterFollowUp = await dbCounts(db, A.projectId);
      const followUpMatches = TRANSFER_COLLECTIONS.every((c) => afterFollowUp[c.key] === snapshotCounts[c.key]);

      report.atomic = {
        restoreError,
        chaptersWrittenBeforePoison,
        fullyRolledBack: fingerprintsEqual(before, after),
        targetSnapshotIntact: targetIntact,
        safetySnapshotExists: Boolean(safety),
        snapshotCountBefore: listBefore.length,
        snapshotCountAfterFailure: listAfter.length,
        followUpOk, followUpError, followUpMatches,
        afterFollowUp,
      };
    } finally {
      await dropDb(db, ctx.name);
    }
  }

  /* ================================================================== */
  /* SCENARIO 5 — PRECHECK REJECTIONS (no writes)                       */
  /* ================================================================== */
  {
    const ctx = await freshDb('precheck');
    const { db, snapshots } = ctx;
    try {
      const A = await seedCompleteProject(ctx, 'PcAlpha');
      const snapshot = await snapshots.createSnapshot(A.projectId, { now: ts + 100 });

      // (a) Tamper the integrity in the DB -> integrity-failed @ precheck, no write.
      const beforeFp = await projectFingerprint(db, A.projectId);
      await db.projectSnapshots.update(snapshot.id, {
        'payload.integrity.digest': 'b'.repeat(64),
        'integrity.digest': 'b'.repeat(64),
      });
      let tamperCode = null; let tamperPhase = null;
      try { await snapshots.restoreSnapshot(snapshot.id, A.projectId); }
      catch (e) { if (e instanceof SnapshotServiceError) { tamperCode = e.code; tamperPhase = e.phase; } }
      const afterTamper = await projectFingerprint(db, A.projectId);

      // (b) Project mismatch: restore an A snapshot against a foreign project id.
      let mismatchCode = null;
      try { await snapshots.restoreSnapshot(snapshot.id, 'proj_ghost_snapshot_test'); }
      catch (e) { mismatchCode = e instanceof SnapshotServiceError ? e.code : '?'; }

      // (c) Snapshot not found.
      let notFoundCode = null;
      try { await snapshots.restoreSnapshot('snap_nope', A.projectId); }
      catch (e) { notFoundCode = e instanceof SnapshotServiceError ? e.code : '?'; }

      report.precheck = {
        tamperCode, tamperPhase,
        tamperNoWrite: fingerprintsEqual(beforeFp, afterTamper),
        mismatchCode, notFoundCode,
      };
    } finally {
      await dropDb(db, ctx.name);
    }
  }

  /* ================================================================== */
  /* SCENARIO 6 — PROJECT-NOT-FOUND & SAFETY-SNAPSHOT FAILURE           */
  /* ================================================================== */
  {
    const ctx = await freshDb('safety');
    const { db, snapshots } = ctx;
    try {
      const repo = new SnapshotRepository(db);

      // (a) project-not-found: capture, then delete the project row directly.
      const A = await seedCompleteProject(ctx, 'SfAlpha');
      const snapshot = await snapshots.createSnapshot(A.projectId, { now: ts + 100 });
      const projectRow = await db.projects.get(A.projectId);
      await db.projects.delete(A.projectId);
      let pnfCode = null; let pnfPhase = null;
      try { await snapshots.restoreSnapshot(snapshot.id, A.projectId); }
      catch (e) { if (e instanceof SnapshotServiceError) { pnfCode = e.code; pnfPhase = e.phase; } }
      // Restore the project row so later checks in this scenario have data.
      await db.projects.put(projectRow);

      // (b) SAFETY-snapshot failure aborts the restore and leaves project untouched.
      await ctx.manuscript.saveChapterDraft(A.projectId, A.ids.chapter, { content: 'SAFETY-TEST CURRENT' });
      const beforeSafety = await projectFingerprint(db, A.projectId);
      const listBefore = await snapshots.listSnapshots(A.projectId);

      const origSnapAdd = db.projectSnapshots.add.bind(db.projectSnapshots);
      let safetyInjectionActive = true;
      db.projectSnapshots.add = async (...args) => {
        if (safetyInjectionActive) throw new Error('INJECTED safety-snapshot write failure');
        return origSnapAdd(...args);
      };
      let safetyCode = null; let safetyPhase = null; let safetyCauseOk = false;
      try { await snapshots.restoreSnapshot(snapshot.id, A.projectId); }
      catch (e) {
        if (e instanceof SnapshotServiceError) { safetyCode = e.code; safetyPhase = e.phase; safetyCauseOk = e.cause !== undefined; }
      } finally { safetyInjectionActive = false; db.projectSnapshots.add = origSnapAdd; }

      const afterSafety = await projectFingerprint(db, A.projectId);
      const listAfter = await snapshots.listSnapshots(A.projectId);

      // After removing the injection, a normal restore must succeed.
      let recoveryOk = false;
      try { const r = await snapshots.restoreSnapshot(snapshot.id, A.projectId); recoveryOk = r.project.id === A.projectId; }
      catch { recoveryOk = false; }

      report.safety = {
        pnfCode, pnfPhase,
        safetyCode, safetyPhase, safetyCauseOk,
        safetyAborted: safetyCode === 'capture-failed' && safetyPhase === 'safety-snapshot',
        projectUntouchedAfterSafetyFailure: fingerprintsEqual(beforeSafety, afterSafety),
        snapshotListUnchangedBySafetyFailure: listBefore.length === listAfter.length,
        targetSnapshotStillPresent: (await repo.getById(snapshot.id)) !== null,
        recoveryOk,
      };
    } finally {
      await dropDb(db, ctx.name);
    }
  }

  return report;
}
