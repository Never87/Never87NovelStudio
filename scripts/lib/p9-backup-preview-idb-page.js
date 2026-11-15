/**
 * In-page driver for `p9-backup-preview-idb-verify.cjs` (P9 Batch 4-2 — REAL IndexedDB).
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(${<this file contents>})()` inside a headless-Chrome tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite (`/src/...`)
 * and a REAL Dexie/IndexedDB database created for this run.
 *
 * Seeds go through the EXISTING application services; the backup is produced by
 * the REAL `BackupService` and previewed by the REAL `BackupPreviewService`.
 * The database name is injected as `window.__P9BP_DB_NAME` before evaluation.
 * Returns a JSON report.
 */
async () => {
  const DB_NAME = window.__P9BP_DB_NAME;
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
  const { BackupPreviewService } = await import('/src/services/backup-preview-service.ts');
  const transferMod = await import('/src/transfer/index.ts');
  const { TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS } = transferMod;

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
    generate: async () => { throw new Error('no AI in the backup preview idb test'); },
  });
  const aiRepo = new AiRepository(db);

  const backup = new BackupService(new TransferService(new TransferRepositoryAdapter(db)));
  // The preview service uses the REAL ProjectService existence probe by default,
  // which reads exactly the DB we seeded via __setDbForTesting.
  const preview = new BackupPreviewService(new TransferService(new TransferRepositoryAdapter(db)));
  const report = {};

  const TABLES = [
    'projects', 'worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes',
    'chapterDrafts', 'sceneDrafts', 'draftVersions', 'promptTemplates', 'promptTemplateVersions',
    'contextItems', 'contextConfigs', 'knowledgeEntries', 'continuityFacts', 'analysisFindings',
    'sourceDocuments', 'documentSections', 'extractionRecords',
    'aiProviders', 'aiModels', 'aiTaskConfigs', 'aiGlobalConfig',
  ];

  // Byte-identical fingerprint (no volatile columns stripped — parsing must not
  // touch ANY row at all).
  const fingerprint = async () => {
    const out = {};
    for (const t of TABLES) {
      const rows = await db.table(t).toArray();
      out[t] = rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    }
    return JSON.stringify(out);
  };
  const countsByTable = async () => {
    const out = {};
    for (const t of TABLES) out[t] = await db.table(t).count();
    return out;
  };

  const seedComplete = async (title) => {
    const project = await projects.createProject({
      title,
      description: `${title} description with a secret-sounding phrase: sk-LEAKCANARY`,
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

    return { projectId, title };
  };

  // Credentials that must NEVER be exported or appear in a preview.
  await aiRepo.createProvider({
    id: 'prov_bp_secret', name: 'BpSecretProvider', providerType: 'openai', baseUrl: '',
    apiKey: 'sk-REALBP-0987654321', customHeaders: [{ name: 'X', value: 'bearer BPTOPSECRET' }],
    enabled: true, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });

  const A = await seedComplete('PreviewAlpha');
  const B = await seedComplete('PreviewBeta');

  /* (1) Export from a real project → preview it */
  {
    const file = await backup.exportProjectFile(A.projectId);
    const p = await preview.previewBackupFile({ text: file.content, name: file.fileName });
    report.valid = {
      projectId: p.projectId,
      projectTitle: p.projectTitle,
      kind: p.kind,
      exportedAt: p.exportedAt,
      fileExportedAt: file.exportedAt,
      digest: p.integrityDigest,
      fileDigest: file.integrityDigest,
      collectionCount: p.collections.length,
      totalRecords: p.totalRecords,
      fileTotal: file.totalRecords,
      counts: Object.fromEntries(p.collections.map((c) => [c.key, c.count])),
      fileCounts: file.counts,
    };
  }

  /* (2) Existing-project detection (source project IS local) */
  {
    const file = await backup.exportProjectFile(A.projectId);
    const p = await preview.previewBackupFile(file.content);
    report.existingLocal = { exists: p.sourceProjectExistsLocally, projectId: p.projectId };
  }

  /* (3) A backup for a NONEXISTENT local project still parses, and reports absent */
  {
    const file = await backup.exportProjectFile(B.projectId);
    // Rewrite the project id + digest so it is a valid package for an id that
    // does not exist locally. Nothing is written to the DB.
    const pkg = JSON.parse(file.content);
    const transfer = new TransferService(new TransferRepositoryAdapter(db));
    const { computeIntegrity } = transferMod;
    const NEW_ID = 'proj_not_local_xyz';
    pkg.projects[0].project.id = NEW_ID;
    for (const key of Object.keys(pkg.projects[0].data)) {
      for (const row of pkg.projects[0].data[key]) if (row.projectId) row.projectId = NEW_ID;
    }
    pkg.projects[0].integrity = computeIntegrity({ project: pkg.projects[0].project, data: pkg.projects[0].data });
    const p = await preview.previewBackupFile(JSON.stringify(pkg));
    report.nonexistent = {
      parsed: p.kind === 'project',
      exists: p.sourceProjectExistsLocally,
      projectId: p.projectId,
      newId: NEW_ID,
    };
  }

  /* (4) Read-only: DB fingerprint byte-identical before/after previews */
  {
    const fileA = await backup.exportProjectFile(A.projectId);
    const badJson = '{ bad json';
    const before = await fingerprint();
    const beforeCounts = await countsByTable();
    await preview.previewBackupFile(fileA.content);
    await preview.previewBackupFile(fileA.content);
    try { await preview.previewBackupFile(badJson); } catch { /* expected */ }
    // A tampered (invalid) file too.
    const tampered = JSON.parse(fileA.content);
    tampered.projects[0].data.characters[0].name = 'TAMPER';
    try { await preview.previewBackupFile(JSON.stringify(tampered)); } catch { /* expected */ }
    const after = await fingerprint();
    const afterCounts = await countsByTable();
    const changed = [];
    for (const t of TABLES) if (beforeCounts[t] !== afterCounts[t]) changed.push(t);
    report.readOnly = {
      fingerprintIdentical: before === after,
      countChanged: changed,
    };
  }

  /* (5) Another project's data is untouched (preview B while A exists) */
  {
    const fileB = await backup.exportProjectFile(B.projectId);
    const beforeB = await db.table('characters').where('projectId').equals(B.projectId).toArray();
    const beforeBStr = JSON.stringify(beforeB.sort((a, b) => (a.id < b.id ? -1 : 1)));
    const p = await preview.previewBackupFile(fileB.content);
    const afterB = await db.table('characters').where('projectId').equals(B.projectId).toArray();
    const afterBStr = JSON.stringify(afterB.sort((a, b) => (a.id < b.id ? -1 : 1)));
    report.isolation = {
      previewId: p.projectId,
      expectedB: B.projectId,
      bUnchanged: beforeBStr === afterBStr,
    };
  }

  // Reuse the preview's returned data to check it never contains B ids.
  {
    const fileA = await backup.exportProjectFile(A.projectId);
    const p = await preview.previewBackupFile(fileA.content);
    const pkg = JSON.parse(fileA.content);
    const bIds = new Set();
    for (const t of TABLES) {
      const rows = await db.table(t).where('projectId').equals(B.projectId).toArray().catch(() => []);
      for (const r of rows) if (r.id) bIds.add(r.id);
    }
    const previewIds = new Set();
    for (const key of Object.keys(pkg.projects[0].data)) {
      for (const r of pkg.projects[0].data[key]) if (r.id) previewIds.add(r.id);
    }
    const leak = [...bIds].filter((id) => previewIds.has(id));
    report.crossProject = { bLeaksIntoA: leak, previewProjectId: p.projectId };
  }

  /* (6) Secrets excluded from the previewed file */
  {
    const file = await backup.exportProjectFile(A.projectId);
    const lower = file.content.toLowerCase();
    report.secrets = {
      dbHasSecret: (await aiRepo.getProvider('prov_bp_secret')).apiKey.startsWith('sk-REALBP'),
      leaks: ['sk-realbp', 'bptopsecret', 'prov_bp_secret', 'bpsecretprovider'].filter((t) => lower.includes(t)),
      mentionsAiProviders: lower.includes('aiproviders'),
    };
  }

  /* (7) Repeated parsing is stable */
  {
    const file = await backup.exportProjectFile(A.projectId);
    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await preview.previewBackupFile(file.content));
    const stable =
      runs.every((r) => r.totalRecords === runs[0].totalRecords) &&
      runs.every((r) => JSON.stringify(r.collections) === JSON.stringify(runs[0].collections)) &&
      runs.every((r) => r.integrityDigest === runs[0].integrityDigest);
    report.stable = { stable };
  }

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
