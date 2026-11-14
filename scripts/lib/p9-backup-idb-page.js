/**
 * In-page driver for `p9-backup-idb-verify.cjs` (P9 Batch 4-1 — REAL IndexedDB).
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(${<this file contents>})()` inside a headless-Chrome tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite (`/src/...`)
 * and a REAL Dexie/IndexedDB database created for this run.
 *
 * Seeding goes through the EXISTING application services so the BackupService
 * reads data the application itself produces. The database name is injected as
 * `window.__P9BK_DB_NAME` before evaluation. Returns a JSON report.
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
    generate: async () => { throw new Error('no AI in the backup idb test'); },
  });
  const aiRepo = new AiRepository(db);
  const parser = new TransferService(new TransferRepositoryAdapter(db));

  const backup = new BackupService();
  const report = {};

  const TABLES = [
    'projects', 'worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes',
    'chapterDrafts', 'sceneDrafts', 'draftVersions', 'promptTemplates', 'promptTemplateVersions',
    'contextItems', 'contextConfigs', 'knowledgeEntries', 'continuityFacts', 'analysisFindings',
    'sourceDocuments', 'documentSections', 'extractionRecords',
    'aiProviders', 'aiModels', 'aiTaskConfigs', 'aiGlobalConfig',
  ];

  const snapshotDb = async () => {
    const out = {};
    for (const t of TABLES) {
      const rows = await db.table(t).toArray();
      out[t] = rows
        .map((r) => { const c = JSON.parse(JSON.stringify(r)); delete c.updatedAt; return c; })
        .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    }
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

    // P8: document → confirmed sections → one manual extraction.
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

  const idsOfEntry = (entry) => {
    const out = {};
    for (const c of TRANSFER_COLLECTIONS) out[c.key] = entry.data[c.key].map((r) => r.id);
    return out;
  };

  /* Credentials that must NEVER be exported. */
  await aiRepo.createProvider({
    id: 'prov_bk_secret', name: 'BkSecretProvider', providerType: 'openai', baseUrl: '',
    apiKey: 'sk-REALBK-0987654321', customHeaders: [{ name: 'X', value: 'bearer BKTOPSECRET' }],
    enabled: true, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  });

  const A = await seedComplete('ProjectAlpha');
  const B = await seedComplete('ProjectBeta');
  const empty = await projects.createProject({ title: 'ProjectEmpty' });
  await worldService.createWorld(empty.id, { title: 'ProjectEmpty world' });

  /* (1) Export from real IndexedDB → parse + validate + all 19 present */
  {
    const file = await backup.exportProjectFile(A.projectId);
    const parsed = parser.parse(file.content);
    const raw = JSON.parse(file.content);
    const counts = raw.projects[0].data;
    report.export = {
      isProject: raw.kind === 'project' && raw.projects.length === 1,
      parses: parsed.valid && parsed.package !== null,
      validates: validateTransferPackage(raw).valid,
      fileName: file.fileName,
      collectionCount: Object.keys(counts).length,
      allPresent: TRANSFER_COLLECTIONS.every((c) => Array.isArray(counts[c.key])),
      totalRecords: file.totalRecords,
      digestLen: file.integrityDigest.length,
    };
  }

  /* (2) Read-only: DB unchanged after export */
  {
    const before = await snapshotDb();
    await backup.exportProjectFile(A.projectId);
    await backup.exportProjectFile(B.projectId);
    const after = await snapshotDb();
    const changed = [];
    for (const t of TABLES) if (JSON.stringify(before[t]) !== JSON.stringify(after[t])) changed.push(t);
    report.readOnly = { changedTables: changed, unchanged: changed.length === 0 };
  }

  /* (3) Isolation: A backup contains no B ids, and vice versa */
  {
    const fileA = await backup.exportProjectFile(A.projectId);
    const fileB = await backup.exportProjectFile(B.projectId);
    const entryA = JSON.parse(fileA.content).projects[0];
    const entryB = JSON.parse(fileB.content).projects[0];
    const idsA = idsOfEntry(entryA);
    const idsB = idsOfEntry(entryB);
    const presentA = new Set(Object.values(entryA.data).flat().map((r) => r.id));
    const presentB = new Set(Object.values(entryB.data).flat().map((r) => r.id));
    const aLeaksB = [];
    for (const list of Object.values(idsB)) for (const id of list) if (presentA.has(id)) aLeaksB.push(id);
    const bLeaksA = [];
    for (const list of Object.values(idsA)) for (const id of list) if (presentB.has(id)) bLeaksA.push(id);
    report.isolation = {
      distinct: entryA.project.id !== entryB.project.id,
      aLeaksB,
      bLeaksA,
      aAllOwnedByA: TRANSFER_COLLECTIONS.every((c) => entryA.data[c.key].every((r) => r.projectId === entryA.project.id)),
    };
  }

  /* (4) Empty collections preserved as [], project still valid */
  {
    const file = await backup.exportProjectFile(empty.id);
    const entry = JSON.parse(file.content).projects[0];
    const counts = {};
    for (const c of TRANSFER_COLLECTIONS) counts[c.key] = entry.data[c.key].length;
    report.empty = {
      worlds: counts.worlds,
      othersEmpty: TRANSFER_COLLECTIONS.filter((c) => c.key !== 'worlds').every((c) => counts[c.key] === 0 && Array.isArray(entry.data[c.key])),
      validates: validateTransferPackage(JSON.parse(file.content)).valid,
    };
  }

  /* (5) P8 document/evidence data preserved in the backup */
  {
    const file = await backup.exportProjectFile(A.projectId);
    const data = JSON.parse(file.content).projects[0].data;
    const doc = data.sourceDocuments.find((d) => d.id === A.ids.document);
    const sections = data.documentSections.filter((s) => s.documentId === A.ids.document);
    const ext = data.extractionRecords[0];
    const ev = ext.evidence[0];
    const sec = data.documentSections.find((s) => s.id === ev.sectionId);
    report.p8 = {
      singleDocument: data.sourceDocuments.length === 1,
      sectionsMatchRaw: sections.every((s) => doc.rawText.slice(s.start, s.end) === s.text),
      evidenceQuoteMatches: sec.text.slice(ev.start, ev.end) === ev.quote,
      extractionDocumentMatches: ext.documentId === doc.id,
    };
  }

  /* (6) Secrets never in the backup file */
  {
    const fileA = await backup.exportProjectFile(A.projectId);
    const lower = fileA.content.toLowerCase();
    const tokens = ['sk-realbk', 'bktopsecret', 'prov_bk_secret', 'bksecretprovider'];
    report.secrets = {
      dbHasSecret: (await aiRepo.getProvider('prov_bk_secret')).apiKey.startsWith('sk-REALBK'),
      leaks: tokens.filter((t) => lower.includes(t)),
      mentionsAiProviders: lower.includes('aiproviders'),
      mentionsApiKey: lower.includes('apikey'),
      descriptionRetained: fileA.content.includes('sk-LEAKCANARY'),
    };
  }

  /* (7) Consecutive exports stay legal and side-effect free */
  {
    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await backup.exportProjectFile(A.projectId));
    const allValid = runs.every((f) => validateTransferPackage(JSON.parse(f.content)).valid);
    const sameName = runs.every((f) => f.fileName === runs[0].fileName);
    const strip = (s) => { const o = JSON.parse(s); delete o.metadata.exportedAt; return JSON.stringify(o); };
    const stable = runs.every((f) => strip(f.content) === strip(runs[0].content));
    report.consecutive = { allValid, sameName, stable };
  }

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
