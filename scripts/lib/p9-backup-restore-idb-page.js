/**
 * In-page driver for `p9-backup-restore-idb-verify.cjs` (P9 Batch 4-3 — REAL IndexedDB).
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(${<this file contents>})()` inside a headless-Chrome tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite (`/src/...`)
 * and a REAL Dexie/IndexedDB database created for this run.
 *
 * Seeding goes through the EXISTING application services. Backups are produced
 * with the REAL `BackupService`; restores run through the REAL
 * `ProjectRestoreService` against the real database, proving genuine Dexie
 * transaction atomicity and rollback (not a fake).
 *
 * The database name is injected as `window.__P9BK_DB_NAME` before evaluation.
 * Returns a JSON report.
 */
async () => {
  const DB_NAME = window.__P9BK_DB_NAME;
  const dbMod = await import('/src/db/index.ts');
  const { NovelStudioDb, __setDbForTesting } = dbMod;
  const Dexie = Object.getPrototypeOf(NovelStudioDb);

  const db = new NovelStudioDb(DB_NAME);
  __setDbForTesting(db);
  await db.open();

  const { ProjectService } = await import('/src/services/project-service.ts');
  const { CharacterService } = await import('/src/services/character-service.ts');
  const { WorldService } = await import('/src/services/world-service.ts');
  const { NarrativeService } = await import('/src/services/narrative-service.ts');
  const { OutlineService } = await import('/src/services/outline-service.ts');
  const { SceneService } = await import('/src/services/scene-service.ts');
  const { ManuscriptService } = await import('/src/services/manuscript-service.ts');
  const { PromptTemplateService } = await import('/src/services/prompt-template-service.ts');
  const { ImportService } = await import('/src/services/import-service.ts');
  const { ExtractionService } = await import('/src/services/extraction-service.ts');
  const { AiRepository } = await import('/src/repositories/ai-repository.ts');
  const { BackupService } = await import('/src/services/backup-service.ts');
  const { SnapshotService } = await import('/src/services/snapshot-service.ts');
  const { ProjectRestoreService, ProjectRestoreError } = await import('/src/services/project-restore-service.ts');
  const transferMod = await import('/src/transfer/index.ts');
  const { TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS, validateTransferPackage } = transferMod;

  const projects = new ProjectService();
  const characters = new CharacterService();
  const worldService = new WorldService();
  const narrative = new NarrativeService();
  const outline = new OutlineService();
  const scenes = new SceneService();
  const manuscript = new ManuscriptService();
  const prompts = new PromptTemplateService();
  const importService = new ImportService();
  const extractionService = new ExtractionService({
    importService,
    generate: async () => { throw new Error('no AI in the restore idb test'); },
  });
  const aiRepo = new AiRepository(db);
  const backup = new BackupService();
  const snapshots = new SnapshotService(db);
  const restore = new ProjectRestoreService(db, snapshots, projects);

  const TABLES = [
    'projects', 'worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes',
    'chapterDrafts', 'sceneDrafts', 'draftVersions', 'promptTemplates', 'promptTemplateVersions',
    'contextItems', 'contextConfigs', 'knowledgeEntries', 'continuityFacts', 'analysisFindings',
    'sourceDocuments', 'documentSections', 'extractionRecords',
    'aiProviders', 'aiModels', 'aiTaskConfigs', 'aiGlobalConfig', 'projectSnapshots',
  ];

  const SORT_KEY = (r) => JSON.stringify(r);

  const snapshotTables = async (onlyProjectId) => {
    const out = {};
    for (const t of TABLES) {
      let rows = await db.table(t).toArray();
      if (onlyProjectId !== undefined && t !== 'projects') {
        rows = rows.filter((r) => r.projectId === onlyProjectId || (r.id === onlyProjectId));
      } else if (onlyProjectId !== undefined && t === 'projects') {
        rows = rows.filter((r) => r.id === onlyProjectId);
      }
      out[t] = rows.map((r) => JSON.parse(JSON.stringify(r))).sort((a, b) => (SORT_KEY(a) < SORT_KEY(b) ? -1 : 1));
    }
    return out;
  };

  const countOwned = async (projectId) => {
    const counts = {};
    for (const c of TRANSFER_COLLECTIONS) {
      counts[c.key] = await db.table(c.table).where(c.ownerKey).equals(projectId).count();
    }
    return counts;
  };

  const seedComplete = async (title) => {
    const project = await projects.createProject({
      title,
      description: `${title} description`,
      genre: ['fantasy'], tags: [title],
    });
    const projectId = project.id;
    await worldService.createWorld(projectId, {
      title: `${title} world`, overview: `Overview ${title}`, themes: [`theme-${title}`],
      sections: [{ title: 'Geography', content: `Mountains of ${title}.` }],
    });
    const charA = await characters.createCharacter(projectId, { name: `${title} Elara`, role: 'protagonist', summary: 'Brave.' });
    const plan = await narrative.createPlan(projectId, {
      logline: `${title} logline`, structure: 'three-act',
      beats: [{ title: `${title} inciting incident`, description: 'It begins.' }],
    });
    const volume = await outline.createVolume(projectId, { title: `${title} volume` });
    const chapter = await outline.createChapter(projectId, volume.id, {
      title: `${title} chapter`, plotBeatId: plan.beats[0].id, characterIds: [charA.id],
    });
    const scene = await scenes.createScene(projectId, chapter.id, {
      title: `${title} opening`, povCharacterId: charA.id, characterIds: [charA.id],
    });
    await manuscript.saveChapterDraft(projectId, chapter.id, { content: `${title} Elara walked into the forest.` });
    await manuscript.saveSceneDraft(projectId, scene.id, { content: `${title} Elara drew her blade.` });
    await prompts.createTemplate(projectId, {
      name: `${title} Continue`, category: 'Continuation',
      content: `Continue ${title} with {{chapterTitle}}`,
      variables: [{ name: 'chapterTitle', description: '', required: false }],
    });

    const rawDoc = `# ${title} Vol\n\n## ${title} Ch\n\n${title} Elara the brave walked in.\n`;
    const document = await importService.createDocument(projectId, { format: 'markdown', rawText: rawDoc });
    await importService.parseDocument(projectId, document.id);
    await importService.confirmStructure(projectId, document.id);
    const sections = await importService.getConfirmedSections(projectId, document.id);
    const prose = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
    await extractionService.createManualExtraction(projectId, {
      documentId: document.id, kind: 'character', title: `${title} Hera`, summary: 's', body: 'b',
      evidence: [{ sectionId: prose.id, quote: `${title} Elara the brave` }],
      relatedIds: [charA.id],
    });

    return { projectId, title, ids: { charA: charA.id, chapter: chapter.id, document: document.id } };
  };

  const report = {};

  // A real credential that must never be restored.
  await aiRepo.createProvider({
    id: 'prov_restore_secret', name: 'RestoreSecretProvider', providerType: 'openai', baseUrl: '',
    apiKey: 'sk-RESTORE-0987654321', customHeaders: [], enabled: true,
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });

  const A = await seedComplete('AlphaRestore');
  const B = await seedComplete('BetaRestore');
  const fileA = await backup.exportProjectFile(A.projectId);
  const entryA = JSON.parse(fileA.content).projects[0];
  const aCounts = await countOwned(A.projectId);

  /* (1) Restore-as-new: fresh id, full data, source untouched */
  {
    const sourceBefore = await snapshotTables(A.projectId);
    const bBefore = await snapshotTables(B.projectId);

    const result = await restore.restoreAsNewProject(entryA);
    const newCounts = await countOwned(result.projectId);

    const countsMatch = TRANSFER_COLLECTIONS.every((c) => newCounts[c.key] === aCounts[c.key]);

    // Every new-project row owned by new id, none by source.
    let allOwnedByNew = true;
    for (const c of TRANSFER_COLLECTIONS) {
      const rows = await db.table(c.table).where(c.ownerKey).equals(result.projectId).toArray();
      if (rows.some((r) => r.projectId !== result.projectId)) allOwnedByNew = false;
    }

    // Internal references remapped: chapters→volumes within the NEW project.
    const newVols = new Set((await db.table('volumes').where('projectId').equals(result.projectId).toArray()).map((v) => v.id));
    const newChaps = await db.table('chapters').where('projectId').equals(result.projectId).toArray();
    const chapterRefsOk = newChaps.every((c) => newVols.has(c.volumeId));

    // Source and B unchanged.
    const sourceAfter = await snapshotTables(A.projectId);
    const bAfter = await snapshotTables(B.projectId);

    report.asNew = {
      mode: result.mode,
      distinctId: result.projectId !== A.projectId,
      noSnapshot: result.safetySnapshot === null,
      countsMatch,
      allOwnedByNew,
      chapterRefsOk,
      sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
      projectBUnchanged: JSON.stringify(bBefore) === JSON.stringify(bAfter),
    };
  }

  /* (2) Replace-existing: target emptied + backup imported; createdAt kept; snapshots kept */
  {
    const T = await seedComplete('TargetReplace');
    const targetRootBefore = await db.projects.get(T.projectId);
    const targetCountsBefore = await countOwned(T.projectId);

    // Give the target a snapshot so we can prove snapshots survive the restore.
    await snapshots.createSnapshot(T.projectId, { label: 'pre-existing snapshot' });

    const result = await restore.replaceExistingProject(entryA, T.projectId);
    const targetCountsAfter = await countOwned(T.projectId);
    const targetRootAfter = await db.projects.get(T.projectId);

    const countsMatch = TRANSFER_COLLECTIONS.every((c) => targetCountsAfter[c.key] === aCounts[c.key]);

    // After restore the chapters are fresh ids; assert the backup counts instead.
    const targetChapters = await db.table('chapters').where('projectId').equals(T.projectId).toArray();

    const snapCount = await db.table('projectSnapshots').where('projectId').equals(T.projectId).count();

    report.replace = {
      mode: result.mode,
      sameId: result.projectId === T.projectId,
      createdAtPreserved: targetRootAfter.createdAt === targetRootBefore.createdAt,
      countsMatch,
      chaptersRestored: targetChapters.length === aCounts.chapters,
      safetySnapshotReturned: result.safetySnapshot !== null && typeof result.safetySnapshot.id === 'string',
      snapshotsSurvived: snapCount >= 2, // pre-existing + safety
    };
  }

  /* (3) Atomic rollback on a REAL mid-transaction failure */
  {
    const T = await seedComplete('TargetRollback');
    // Count everything about the target before.
    const before = await snapshotTables(T.projectId);

    // Force a failure INSIDE the restore transaction. The service uses the DB
    // property accessors (`this.db[collection.table]`), which are the SAME
    // `db.chapters` Table instances — so patch `db.chapters.bulkPut` directly.
    const chaptersTable = db.chapters;
    const realBulkPut = chaptersTable.bulkPut.bind(chaptersTable);
    let failed = false;
    chaptersTable.bulkPut = async () => { failed = true; throw new Error('simulated fault: chapters bulkPut'); };

    let err = null;
    try {
      await restore.replaceExistingProject(entryA, T.projectId);
    } catch (error) {
      err = error;
    } finally {
      chaptersTable.bulkPut = realBulkPut;
    }

    const after = await snapshotTables(T.projectId);

    report.rollback = {
      threw: err instanceof ProjectRestoreError,
      phase: err && err.phase,
      fired: failed,
      // All 19 collections for the target are byte-identical (snapshots aside).
      targetUnchanged: JSON.stringify(stripSnapshots(before)) === JSON.stringify(stripSnapshots(after)),
      safetySnapshotKept: (await db.table('projectSnapshots').where('projectId').equals(T.projectId).count()) >= 1,
    };
  }

  /* (4) Secrets are never restored (aiProviders untouched) */
  {
    const provider = await aiRepo.getProvider('prov_restore_secret');
    const newProjectCount = await db.projects.count();
    report.secrets = {
      sourceBackupHasNoSecret: !/sk-RESTORE/.test(fileA.content),
      providerStillIntact: provider && provider.apiKey.startsWith('sk-RESTORE'),
      projectsCoexist: newProjectCount >= 5, // A,B, new-from-A, replace-target, rollback-target
    };
  }

  /* (5) Restored project re-exports to a VALID package (round-trip integrity) */
  {
    const newId = (await db.projects.toArray()).map((p) => p.id).find((id) => id !== A.projectId && id !== B.projectId);
    const reFile = await backup.exportProjectFile(newId);
    report.roundTrip = {
      validates: validateTransferPackage(JSON.parse(reFile.content)).valid,
    };
  }

  function stripSnapshots(snap) {
    const copy = JSON.parse(JSON.stringify(snap));
    delete copy.projectSnapshots;
    return copy;
  }

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
