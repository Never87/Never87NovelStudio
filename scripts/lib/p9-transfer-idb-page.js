/**
 * In-page driver for `p9-transfer-idb-verify.cjs` (P9 Batch 1 — REAL IndexedDB).
 *
 * NOT executed by Node. The harness reads this text and evaluates
 * `(${<this file contents>})()` inside a headless-Chrome tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite (`/src/...`)
 * and a REAL Dexie/IndexedDB database created for this run.
 *
 * Everything is seeded through the EXISTING application services (Project,
 * Character, World, Narrative, Outline, Scene, Manuscript, Prompt, Context,
 * Knowledge, Continuity, Analysis, Import/Extraction) — never by hand-built
 * rows — so the transfer layer is exercised against data the application
 * itself produces.
 *
 * The run installs its throw-away database as the process-wide DB singleton so
 * every default-dependency service shares one database (and the user's real
 * `never87-novel-studio` store is never touched).
 *
 * Real AI credentials are written ONLY to `aiProviders` (the secret-bearing
 * table) to prove the exporter never carries them.
 *
 * The database name is injected as `window.__P9_DB_NAME` before evaluation.
 * Returns a plain JSON-serialisable report object with one section per check.
 */
async () => {
  const DB_NAME = window.__P9_DB_NAME;
  const dbMod = await import('/src/db/index.ts');
  const { NovelStudioDb, __setDbForTesting } = dbMod;
  const Dexie = Object.getPrototypeOf(NovelStudioDb);

  // Isolated, throw-away database installed as the singleton BEFORE any service
  // is constructed, so every default-dependency service talks to THIS database.
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
  const { ContextRepository } = await import('/src/repositories/context-repository.ts');
  const { KnowledgeRepository } = await import('/src/repositories/knowledge-repository.ts');
  const { ContinuityRepository } = await import('/src/repositories/continuity-repository.ts');
  const { AnalysisRepository } = await import('/src/repositories/analysis-repository.ts');
  const { AiRepository } = await import('/src/repositories/ai-repository.ts');
  const { ImportService } = await import('/src/services/import-service.ts');
  const { ExtractionService } = await import('/src/services/extraction-service.ts');

  const transferMod = await import('/src/transfer/index.ts');
  const { TransferService, TransferRepositoryAdapter, TRANSFER_COLLECTIONS } = transferMod;
  const { validateTransferPackage } = await import('/src/transfer/validation.ts');

  // Services built with their DEFAULT dependencies — they now resolve to `db`.
  const projects = new ProjectService();
  const characters = new CharacterService();
  const worldService = new WorldService();
  const narrative = new NarrativeService();
  const outline = new OutlineService();
  const scenes = new SceneService();
  const manuscript = new ManuscriptService();
  const prompts = new PromptTemplateService();
  const contextRepo = new ContextRepository(db);
  const knowledgeRepo = new KnowledgeRepository(db);
  const continuityRepo = new ContinuityRepository(db);
  const analysisRepo = new AnalysisRepository(db);
  const aiRepo = new AiRepository(db);
  const importService = new ImportService();
  const extractionService = new ExtractionService({
    importService,
    generate: async () => { throw new Error('no AI in the transfer idb test'); },
  });

  const ts = 1_700_000_000_000;
  const report = {};

  const TABLES = [
    'projects', 'worlds', 'characters', 'narrativePlans', 'volumes', 'chapters', 'scenes',
    'chapterDrafts', 'sceneDrafts', 'draftVersions', 'promptTemplates', 'promptTemplateVersions',
    'contextItems', 'contextConfigs', 'knowledgeEntries', 'continuityFacts', 'analysisFindings',
    'sourceDocuments', 'documentSections', 'extractionRecords',
    'aiProviders', 'aiModels', 'aiTaskConfigs', 'aiGlobalConfig',
  ];

  /** A structural fingerprint of every table, ignoring volatile columns. */
  const snapshotObjectStore = async (table) => {
    const rows = await db.table(table).toArray();
    const strip = (row) => {
      const copy = JSON.parse(JSON.stringify(row));
      delete copy.updatedAt;
      return copy;
    };
    return rows.map(strip).sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  };
  const snapshotDb = async () => {
    const out = {};
    for (const t of TABLES) out[t] = await snapshotObjectStore(t);
    return out;
  };

  /**
   * Builds a COMPLETE project exercising all 19 project-owned collections.
   * `tag` is embedded into every human-readable field so a test can prove that
   * no record from one project leaks into another project's export.
   */
  const seedCompleteProject = async (title) => {
    const tag = `${title}-N87`;

    const project = await projects.createProject({
      title,
      description: `${tag} description with a secret-sounding phrase: sk-LEAKCANARY`,
      genre: ['fantasy'],
      tags: [tag],
    });
    const projectId = project.id;

    // A world is NOT created by createProject; create it via the World service.
    await worldService.createWorld(projectId, {
      title: `${tag} world`,
      overview: `Overview of ${tag}`,
      themes: [`theme-${tag}`],
      sections: [{ title: 'Geography', content: `Mountains of ${tag}.` }],
    });

    // Characters (2) — chapter & scene reference them.
    const charA = await characters.createCharacter(projectId, { name: `${tag} Elara`, role: 'protagonist', summary: 'Brave.' });
    const charB = await characters.createCharacter(projectId, { name: `${tag} Aria`, role: 'supporting' });

    // Narrative plan with a beat (chapter.plotBeatId references it).
    const plan = await narrative.createPlan(projectId, {
      logline: `${tag} logline`,
      structure: 'three-act',
      beats: [{ title: `${tag} inciting incident`, description: 'It begins.' }],
    });
    const beatId = plan.beats[0].id;

    // Outline: volume → chapter → scene.
    const volume = await outline.createVolume(projectId, { title: `${tag} volume` });
    const chapter = await outline.createChapter(projectId, volume.id, {
      title: `${tag} chapter`,
      plotBeatId: beatId,
      characterIds: [charA.id, charB.id],
    });
    const scene = await scenes.createScene(projectId, chapter.id, {
      title: `${tag} opening scene`,
      povCharacterId: charA.id,
      characterIds: [charA.id],
    });

    // Manuscripts: chapter draft, scene draft, and a version snapshot each.
    await manuscript.saveChapterDraft(projectId, chapter.id, { content: `${tag} Elara walked into the forest.` });
    await manuscript.saveSceneDraft(projectId, scene.id, { content: `${tag} Elara drew her blade; Aria followed.` });
    const chapterVersion = await manuscript.createManualVersion('chapter', chapter.id, 'first');
    const sceneVersion = await manuscript.createManualVersion('scene', scene.id, 'first');

    // Prompt template + its initial version.
    const template = await prompts.createTemplate(projectId, {
      name: `${tag} Continue`,
      category: 'Continuation',
      content: `Continue the scene for ${tag} with {{chapterTitle}}`,
      variables: [{ name: 'chapterTitle', description: '', required: false }],
    });

    // Context item + config.
    const contextItem = await contextRepo.putItem({
      id: `ctx_${projectId}_1`,
      projectId,
      layer: 'instructions',
      sourceType: 'instruction',
      sourceId: null,
      sourceLabel: `${tag} instruction`,
      content: `Write with restraint for ${tag}.`,
      priority: 'normal',
      enabled: true,
      persistent: true,
      createdAt: ts,
      updatedAt: ts,
    });
    await contextRepo.putConfig({
      id: `ctxcfg_${projectId}_1`,
      projectId,
      budgetEnabled: true,
      inputBudgetTokens: 8000,
      contextWindowOverrideTokens: null,
      requestedOutputTokens: 2048,
      enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
      persistentInstructions: `${tag} instructions`,
      createdAt: ts,
      updatedAt: ts,
    });

    // P8: document → parsed sections → confirmed, then one manual extraction.
    const rawDoc = `# ${tag} Volume\n\n## ${tag} Chapter\n\n${tag} Elara the brave walked into the forest.\n`;
    const document = await importService.createDocument(projectId, { format: 'markdown', rawText: rawDoc });
    await importService.parseDocument(projectId, document.id);
    await importService.confirmStructure(projectId, document.id);
    const sections = await importService.getConfirmedSections(projectId, document.id);
    const proseSection = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];

    const extraction = await extractionService.createManualExtraction(projectId, {
      documentId: document.id,
      kind: 'character',
      title: `${tag} Extracted Hera`,
      summary: `${tag} summary`,
      body: `${tag} body`,
      evidence: [{ sectionId: proseSection.id, quote: `${tag} Elara the brave` }],
      relatedIds: [charA.id],
    });

    // Knowledge entry whose evidence ALSO carries a P8 `source` locator.
    const knowledge = await knowledgeRepo.create({
      id: `know_${projectId}_1`,
      projectId,
      kind: 'character',
      title: `${tag} knowledge`,
      summary: `${tag} summary`,
      body: '',
      tags: [tag],
      source: 'manual',
      sourceRef: { entityType: 'manual', entityId: null, key: null },
      sourceKey: null,
      evidence: [
        {
          chapterId: chapter.id,
          sceneId: scene.id,
          quote: '',
          offset: null,
          note: '',
          source: {
            documentId: document.id,
            sectionId: proseSection.id,
            start: 0,
            end: Math.min(5, proseSection.text.length),
          },
        },
      ],
      searchText: `${tag}`.toLowerCase(),
      createdAt: ts,
      updatedAt: ts,
    });

    // Continuity fact anchored to chapter + scene.
    const continuity = await continuityRepo.create({
      id: `cont_${projectId}_1`,
      projectId,
      subjectType: 'character',
      subjectId: charA.id,
      subjectLabel: `${tag} Elara`,
      predicate: 'position',
      value: `${tag} forest`,
      relatedLabel: '',
      anchorChapterId: chapter.id,
      anchorSceneId: scene.id,
      anchorRank: 0,
      evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: '' }],
      createdAt: ts,
      updatedAt: ts,
    });

    // Analysis finding referencing the knowledge entry + continuity fact.
    const finding = await analysisRepo.create({
      id: `find_${projectId}_1`,
      projectId,
      category: 'continuity',
      severity: 'warning',
      status: 'open',
      origin: 'deterministic',
      title: `${tag} finding`,
      description: `${tag} description`,
      evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: '' }],
      relatedFactIds: [continuity.id],
      relatedEntryIds: [knowledge.id],
      createdAt: ts,
      updatedAt: ts,
    });

    return {
      projectId,
      tag,
      ids: {
        charA: charA.id, charB: charB.id, plan: plan.id, beatId, volume: volume.id,
        chapter: chapter.id, scene: scene.id, chapterVersion: chapterVersion.id, sceneVersion: sceneVersion.id,
        template: template.id, templateVersion: template.currentVersionId, contextItem: contextItem.id,
        knowledge: knowledge.id, continuity: continuity.id, finding: finding.id,
        document: document.id, proseSection: proseSection.id, extraction: extraction.id,
      },
    };
  };

  /** Collects every id in one project's package data, keyed by collection. */
  const idsOf = (entry) => {
    const out = {};
    for (const c of TRANSFER_COLLECTIONS) out[c.key] = entry.data[c.key].map((r) => r.id);
    return out;
  };
  /** Scans a package for any id belonging to `otherIds` (a leak detector). */
  const leakedIds = (entry, otherIds) => {
    const present = new Set();
    for (const c of TRANSFER_COLLECTIONS) for (const r of entry.data[c.key]) present.add(r.id);
    const leaks = [];
    for (const [key, list] of Object.entries(otherIds)) {
      for (const id of list) if (present.has(id)) leaks.push(`${key}:${id}`);
    }
    return leaks;
  };

  /* ------------------------------------------------------------------ */
  /* Real credentials in aiProviders (must NEVER be exported)            */
  /* ------------------------------------------------------------------ */
  {
    await aiRepo.createProvider({
      id: 'prov_secret_1',
      name: 'SecretProvider',
      providerType: 'openai',
      baseUrl: '',
      apiKey: 'sk-REALSECRET-0123456789',
      customHeaders: [{ name: 'X-Secret', value: 'bearer TOPSECRETVALUE' }],
      enabled: true,
      createdAt: ts,
      updatedAt: ts,
    });
    const providers = await aiRepo.listProviders();
    report.credentialsSeeded = providers.length >= 1 && providers[0].apiKey.startsWith('sk-REALSECRET');
  }

  /* ------------------------------------------------------------------ */
  /* Seed A (complete) + B (complete) + C (world only)                   */
  /* ------------------------------------------------------------------ */
  const A = await seedCompleteProject('ProjectAlpha');
  const B = await seedCompleteProject('ProjectBeta');
  const C = await projects.createProject({ title: 'ProjectGamma' });
  await worldService.createWorld(C.id, { title: 'ProjectGamma world' });
  report.seededProjects = [A.projectId, B.projectId, C.id];

  const adapter = new TransferRepositoryAdapter(db);
  const service = new TransferService(adapter);

  /* ------------------------------------------------------------------ */
  /* (1) All 19 collections present, populated, exported (project A)     */
  /* ------------------------------------------------------------------ */
  {
    const pkg = await service.exportProject(A.projectId, { now: ts + 1000 });
    const entry = pkg.projects[0];
    const keys = Object.keys(entry.data);
    const counts = {};
    for (const c of TRANSFER_COLLECTIONS) counts[c.key] = entry.data[c.key].length;

    const direct = {};
    for (const c of TRANSFER_COLLECTIONS) {
      direct[c.key] = c.ownerKey === 'projectId'
        ? await db.table(c.table).where('projectId').equals(A.projectId).count()
        : await db.table(c.table).filter((r) => r.id === A.projectId).count();
    }

    report.complete = {
      collectionCount: keys.length,
      expectedCount: TRANSFER_COLLECTIONS.length,
      keysMatchRegistry: TRANSFER_COLLECTIONS.every((c) => keys.includes(c.key)),
      counts,
      direct,
      everyCollectionPopulated: TRANSFER_COLLECTIONS.every((c) => counts[c.key] > 0),
      valid: validateTransferPackage(pkg).valid,
    };
  }

  /* ------------------------------------------------------------------ */
  /* (2) Multi-project isolation                                         */
  /* ------------------------------------------------------------------ */
  {
    const entryA = (await service.exportProject(A.projectId, { now: ts + 1000 })).projects[0];
    const entryB = (await service.exportProject(B.projectId, { now: ts + 1000 })).projects[0];
    const idsA = idsOf(entryA);
    const idsB = idsOf(entryB);
    report.isolation = {
      projectIdA: entryA.project.id,
      projectIdB: entryB.project.id,
      distinctProjectIds: entryA.project.id !== entryB.project.id,
      aLeaksBIds: leakedIds(entryA, idsB),
      bLeaksAIds: leakedIds(entryB, idsA),
      aAllOwnedByA: TRANSFER_COLLECTIONS.every((c) => entryA.data[c.key].every((r) => r.projectId === entryA.project.id)),
      bAllOwnedByB: TRANSFER_COLLECTIONS.every((c) => entryB.data[c.key].every((r) => r.projectId === entryB.project.id)),
      idsDisjoint: Object.keys(idsA).every((k) => !idsA[k].some((id) => idsB[k].includes(id))),
    };
  }

  /* ------------------------------------------------------------------ */
  /* (3) Empty collections export as []                                  */
  /* ------------------------------------------------------------------ */
  {
    const pkg = await service.exportProject(C.id, { now: ts + 1000 });
    const entry = pkg.projects[0];
    const counts = {};
    for (const c of TRANSFER_COLLECTIONS) counts[c.key] = entry.data[c.key].length;
    report.empty = {
      worlds: counts.worlds,
      nonWorldEmpty: TRANSFER_COLLECTIONS.filter((c) => c.key !== 'worlds').every((c) => counts[c.key] === 0 && Array.isArray(entry.data[c.key])),
      keysPresent: TRANSFER_COLLECTIONS.every((c) => Array.isArray(entry.data[c.key])),
      valid: validateTransferPackage(pkg).valid,
    };
  }

  /* ------------------------------------------------------------------ */
  /* (4) P8 relationships & offsets                                      */
  /* ------------------------------------------------------------------ */
  {
    const pkg = await service.exportProject(A.projectId, { now: ts + 1000 });
    const data = pkg.projects[0].data;
    const doc = data.sourceDocuments.find((d) => d.id === A.ids.document);
    const sections = data.documentSections.filter((s) => s.documentId === A.ids.document);
    const extraction = data.extractionRecords.find((r) => r.id === A.ids.extraction);
    const ev = extraction.evidence[0];
    const section = data.documentSections.find((s) => s.id === ev.sectionId);

    const sectionSlicesOk = sections.every((s) => doc.rawText.slice(s.start, s.end) === s.text);
    const evidenceSlice = section.text.slice(ev.start, ev.end);
    const parent = sections.find((s) => s.id === section.parentId);
    const knowledge = data.knowledgeEntries.find((e) => e.id === A.ids.knowledge);
    const knowSource = knowledge.evidence[0].source;

    report.p8Relations = {
      singleDocument: data.sourceDocuments.length === 1,
      allSectionSlicesMatchRaw: sectionSlicesOk,
      extractionDocumentMatches: extraction.documentId === doc.id,
      evidenceInSameDocument: ev.documentId === doc.id && section.documentId === doc.id,
      evidenceQuoteMatchesSlice: evidenceSlice === ev.quote && ev.quote === `${A.tag} Elara the brave`,
      paragraphHasChapterParent: Boolean(parent) && parent.level === 'chapter',
      extractionRelatedIds: extraction.relatedIds.includes(A.ids.charA),
      knowledgeSourceSameDocument: Boolean(knowSource) && knowSource.documentId === doc.id && knowSource.sectionId === ev.sectionId,
      valid: validateTransferPackage(pkg).valid,
    };
  }

  /* ------------------------------------------------------------------ */
  /* (5) Self-validation                                                 */
  /* ------------------------------------------------------------------ */
  {
    const pkgA = await service.exportProject(A.projectId, { now: ts + 1000 });
    const pkgW = await service.exportWorkspace({ now: ts + 1000 });
    const resA = validateTransferPackage(pkgA);
    const resW = validateTransferPackage(pkgW);
    const json = service.serialize(pkgA);
    const parsed = service.parse(json);
    report.selfValidation = {
      singleValid: resA.valid,
      singleErrors: resA.errors.map((e) => `${e.code}@${e.path}`),
      workspaceValid: resW.valid,
      workspaceErrors: resW.errors.map((e) => `${e.code}@${e.path}`),
      workspaceProjectCount: pkgW.projects.length,
      workspaceMetadata: pkgW.metadata.projectCount,
      roundTripParses: parsed.valid && parsed.package !== null,
      roundTripByteIdentical: parsed.package ? service.serialize(parsed.package) === json : false,
    };
  }

  /* ------------------------------------------------------------------ */
  /* (6) Dangling & broken relationships are reported                    */
  /* ------------------------------------------------------------------ */
  {
    const cloned = async () => JSON.parse(service.serialize(await service.exportProject(A.projectId, { now: ts + 1000 })));
    const firstErr = (r) => (r.errors.length > 0 ? r.errors[0].code : null);

    const d1 = await cloned();
    d1.projects[0].data.chapters[0].volumeId = 'vol_DOES_NOT_EXIST';
    const d2 = await cloned();
    d2.projects[0].data.extractionRecords[0].evidence[0].sectionId = 'dsec_DOES_NOT_EXIST';
    const d3 = await cloned();
    d3.projects[0].data.continuityFacts[0].anchorSceneId = 'scene_DOES_NOT_EXIST';
    const d4 = await cloned();
    const sec = d4.projects[0].data.documentSections[1];
    sec.text = sec.text.replace('Elara', 'XXXXX');
    const d5 = await cloned();
    d5.projects[0].data.characters[0].projectId = 'other_project';
    const d6 = await cloned();
    d6.projects[0].data.characters[0].name = 'Tampered Name';

    const r = [d1, d2, d3, d4, d5, d6].map((p) => validateTransferPackage(p));
    report.dangling = {
      chapterVolume: firstErr(r[0]),
      evidenceSection: firstErr(r[1]),
      continuityScene: firstErr(r[2]),
      sectionQuote: firstErr(r[3]),
      ownership: firstErr(r[4]),
      integrity: firstErr(r[5]),
      allReported: r.every((res) => !res.valid),
      evidenceHasPath: r[1].errors.some((e) => e.path.includes('extractionRecords[0]') && e.path.includes('evidence[0]')),
    };
  }

  /* ------------------------------------------------------------------ */
  /* (7) Secrets never exported                                          */
  /* ------------------------------------------------------------------ */
  {
    const jsonA = service.serialize(await service.exportProject(A.projectId, { now: ts + 1000 }));
    const jsonW = service.serialize(await service.exportWorkspace({ now: ts + 1000 }));
    const has = (s, t) => s.toLowerCase().includes(t.toLowerCase());
    // Credential material that lives ONLY in the secret-bearing aiProviders table
    // (API key, custom header value, provider id and name). NONE of it may appear
    // in an export. `sk-LEAKCANARY` is deliberately EXCLUDED here: it is planted
    // in the project description as user prose (asserted present below), which is
    // exactly why the scan needs real secret tokens rather than a shared one.
    const tokens = ['sk-REALSECRET', 'TOPSECRETVALUE', 'prov_secret_1', 'SecretProvider'];
    report.secrets = {
      dbHasSecret: (await aiRepo.getProvider('prov_secret_1')).apiKey.startsWith('sk-REALSECRET'),
      projectLeaks: tokens.filter((t) => has(jsonA, t)),
      workspaceLeaks: tokens.filter((t) => has(jsonW, t)),
      mentionsAiProviders: has(jsonA, 'aiProviders') || has(jsonW, 'aiProviders'),
      mentionsApiKey: has(jsonA, 'apiKey') || has(jsonW, 'apiKey'),
      // The project DESCRIPTION intentionally contains "sk-LEAKCANARY": user
      // prose in a project field, not credential material. Confirm it survived
      // verbatim so the (empty) leak scan above is meaningful.
      descriptionRetained: jsonA.includes('sk-LEAKCANARY'),
    };
  }

  /* ------------------------------------------------------------------ */
  /* (8) Export is read-only                                             */
  /* ------------------------------------------------------------------ */
  {
    const before = await snapshotDb();
    await service.exportProject(A.projectId, { now: ts + 2000 });
    await service.exportProject(B.projectId, { now: ts + 2000 });
    await service.exportWorkspace({ now: ts + 2000 });
    await service.parse(service.serialize(await service.exportProject(A.projectId, { now: ts + 3000 })));
    const after = await snapshotDb();
    const changed = [];
    for (const t of TABLES) {
      if (JSON.stringify(before[t]) !== JSON.stringify(after[t])) changed.push(t);
    }
    report.readOnly = { changedTables: changed, unchanged: changed.length === 0 };
  }

  /* ------------------------------------------------------------------ */
  /* (9) Consecutive exports of different projects never cross-contaminate */
  /* ------------------------------------------------------------------ */
  {
    const runs = [];
    for (let i = 0; i < 4; i += 1) {
      runs.push(await service.exportProject(A.projectId, { now: ts + 10000 + i }));
      runs.push(await service.exportProject(B.projectId, { now: ts + 10000 + i }));
    }
    const idsA = idsOf(runs[0].projects[0]);
    const idsB = idsOf(runs[1].projects[0]);
    const aRuns = runs.filter((_, i) => i % 2 === 0);
    const bRuns = runs.filter((_, i) => i % 2 === 1);
    const aConsistent = aRuns.every((p) => leakedIds(p.projects[0], idsB).length === 0 && p.projects[0].project.id === A.projectId);
    const bConsistent = bRuns.every((p) => leakedIds(p.projects[0], idsA).length === 0 && p.projects[0].project.id === B.projectId);
    report.consecutive = {
      aConsistent,
      bConsistent,
      stableAcrossRuns: JSON.stringify(aRuns[0].projects[0].data) === JSON.stringify(aRuns[3].projects[0].data),
      aProjectIds: aRuns.map((p) => p.projects[0].project.id),
      bProjectIds: bRuns.map((p) => p.projects[0].project.id),
    };
  }

  /* ------------------------------------------------------------------ */
  /* (10) Dangling-index / .first() audit                                */
  /* ------------------------------------------------------------------ */
  {
    const indexInfo = {};
    for (const t of TABLES) {
      const schema = db.table(t).schema;
      indexInfo[t] = schema.indexes.map((idx) => ({ keyPath: idx.keyPath, unique: idx.unique === true, multi: idx.multi === true }));
    }

    // Dexie silently SKIPS rows whose indexed component is undefined, so a
    // compound `where([...]).equals([...])` query could drop rows silently.
    const missingIndexedValue = {};
    for (const c of TRANSFER_COLLECTIONS) {
      const indexes = db.table(c.table).schema.indexes;
      const rows = await db.table(c.table).where('projectId').equals(A.projectId).toArray();
      const offenders = [];
      for (const s of rows) {
        for (const idx of indexes) {
          const paths = Array.isArray(idx.keyPath) ? idx.keyPath : [idx.keyPath];
          for (const p of paths) {
            if (p === 'id') continue;
            if (s[p] === undefined) offenders.push(`${s.id}.${p}`);
          }
        }
      }
      if (offenders.length > 0) missingIndexedValue[c.key] = offenders.slice(0, 5);
    }

    const knowledgeNullKey = (await db.table('knowledgeEntries').where('projectId').equals(A.projectId).toArray()).filter((r) => r.sourceKey === null).length;
    report.indexAudit = { indexInfo, missingIndexedValue, knowledgeNullKeyRows: knowledgeNullKey };
  }

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
