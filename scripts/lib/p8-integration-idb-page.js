/**
 * In-page driver for `p8-integration-idb-verify.cjs`.
 *
 * This file is NOT executed by Node. The harness reads its text and evaluates
 * `(${<this file contents>})()` inside the browser tab via the DevTools
 * Protocol, so it runs against the REAL app modules served by Vite
 * (`/src/...`) and the REAL Dexie/IndexedDB in that tab. Dynamic `import('/src/…')`
 * resolves against the document origin (localhost:5177) regardless of where this
 * source text came from.
 *
 * The database name is injected as `window.__P8B5_DB_NAME` before evaluation.
 *
 * Returns a plain JSON-serialisable report object with one section per check.
 */
async () => {
  const DB_NAME = window.__P8B5_DB_NAME;
  const dbMod = await import('/src/db/index.ts');
  const { NovelStudioDb } = dbMod;
  const Dexie = Object.getPrototypeOf(NovelStudioDb);
  const { ImportService } = await import('/src/services/import-service.ts');
  const { ExtractionService } = await import('/src/services/extraction-service.ts');
  const { ReviewService } = await import('/src/services/review-service.ts');
  const { IntegrationService } = await import('/src/services/integration-service.ts');
  const { ImportRepository } = await import('/src/repositories/import-repository.ts');
  const { KnowledgeRepository } = await import('/src/repositories/knowledge-repository.ts');
  const { CharacterRepository } = await import('/src/repositories/character-repository.ts');
  const { WorldRepository } = await import('/src/repositories/world-repository.ts');

  const db = new NovelStudioDb(DB_NAME);
  await db.open();

  const projectSet = new Set(['projA', 'projB']);
  const projectService = { async projectExists(id) { return projectSet.has(id); } };

  // Each mk() builds an INDEPENDENT set of service instances. They all share
  // the one `db` handle (one connection) — the same situation as several
  // components / hooks in one tab racing on the DB.
  const mk = ({ repoOverride } = {}) => {
    const database = db;
    const baseRepo = new ImportRepository(database);
    const repo = repoOverride ? repoOverride(baseRepo) : baseRepo;
    const importService = new ImportService({ repository: repo, projectService, db: database });
    const extractionService = new ExtractionService({
      repository: repo,
      importService,
      generate: async () => { throw new Error('no AI in idb test'); },
    });
    const reviewService = new ReviewService({ repository: repo, importService, extractionService });
    const integrationService = new IntegrationService({
      repository: repo,
      importService,
      knowledgeRepository: new KnowledgeRepository(database),
      characterRepository: new CharacterRepository(database),
      worldRepository: new WorldRepository(database),
    });
    return { database, baseRepo, repo, importService, extractionService, reviewService, integrationService };
  };

  const primary = mk();
  const report = {};
  const tsBase = 1_700_000_000_000;

  await db.table('projects').bulkPut([
    { id: 'projA', title: 'Alpha', description: '', status: 'drafting', genre: [], tags: [], settings: {}, createdAt: tsBase, updatedAt: tsBase },
    { id: 'projB', title: 'Beta', description: '', status: 'planning', genre: [], tags: [], settings: {}, createdAt: tsBase, updatedAt: tsBase },
  ]);

  const prose = 'Elara the brave walked into the forest. Aria the wise followed her.';
  const sampleDoc = (label, body) =>
    '# Volume ' + label + '\n\n## Chapter 1\n\n' + (body || prose) + '\n';

  const confirmedDoc = async (bundle, projectId, label, body) => {
    const doc = await bundle.importService.createDocument(projectId, { format: 'markdown', rawText: sampleDoc(label, body) });
    await bundle.importService.parseDocument(projectId, doc.id);
    await bundle.importService.confirmStructure(projectId, doc.id);
    const sections = await bundle.importService.getConfirmedSections(projectId, doc.id);
    const para = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
    return { doc, para, sections };
  };

  const confirmedRecord = async (bundle, projectId, info, overrides = {}) => {
    const rec = await bundle.extractionService.createManualExtraction(projectId, {
      documentId: info.doc.id,
      kind: overrides.kind || 'character',
      title: overrides.title || 'Elara',
      summary: overrides.summary,
      body: overrides.body,
      tags: overrides.tags,
      evidence: [{ sectionId: info.para.id, quote: overrides.quote || 'Elara the brave' }],
    });
    await bundle.reviewService.confirmExtraction(projectId, rec.id);
    return rec;
  };

  const countAll = async (table) => db.table(table).count();

  /* (1) Preview is READ-ONLY */
  {
    const info = await confirmedDoc(primary, 'projA', 'preview');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Preview Elara' });
    const tables = ['characters', 'worlds', 'knowledgeEntries', 'extractionRecords', 'sourceDocuments', 'documentSections'];
    const before = {};
    for (const t of tables) before[t] = await countAll(t);
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    const after = {};
    for (const t of tables) after[t] = await countAll(t);
    report.preview = {
      writesNothing: tables.every((t) => before[t] === after[t]),
      hasFingerprint: typeof preview.fingerprint === 'string' && preview.fingerprint.startsWith('prv_'),
      targetType: preview.plan.targetType,
      expectedAction: preview.plan.expectedAction,
      evidenceValid: preview.evidenceValid,
      notIntegrated: preview.alreadyIntegrated === false,
    };
  }

  /* (2) Apply persists entity + audit stamp together */
  {
    const info = await confirmedDoc(primary, 'projA', 'apply');
    const rec = await confirmedRecord(primary, 'projA', info, {
      title: 'Aria the Wise', quote: 'Aria the wise', summary: 'A wise sage.', body: 'She followed closely.',
    });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    const applied = await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    const persisted = await db.table('extractionRecords').get(rec.id);
    const chars = await db.table('characters').where('projectId').equals('projA').toArray();
    const character = chars.find((c) => c.name === 'Aria the Wise');
    report.apply = {
      applied: applied.applied,
      targetType: applied.target.type,
      recordStatus: persisted.integration.status,
      auditPresent: Boolean(persisted.integrationAudit),
      auditFingerprintMatches: persisted.integrationAudit && persisted.integrationAudit.previewFingerprint === preview.fingerprint,
      resolutionsPresent: Array.isArray(persisted.integrationAudit && persisted.integrationAudit.resolutions),
      characterCreated: Boolean(character),
      characterSummary: character && character.summary,
      characterBackground: character && character.background,
      stampMatchesEntity: Boolean(character) && persisted.integration.appliedEntityId === character.id,
    };
  }

  /* (3) One-shot: second Apply refused */
  {
    const info = await confirmedDoc(primary, 'projA', 'oneshot');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'One Shot', quote: 'Elara the brave' });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    const charsBefore = await db.table('characters').where('projectId').equals('projA').count();
    let secondReason = null;
    try {
      const p2 = await primary.integrationService.previewIntegration('projA', rec.id);
      await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: p2.fingerprint });
    } catch (e) { secondReason = e && e.reason; }
    const charsAfter = await db.table('characters').where('projectId').equals('projA').count();
    report.oneshot = { secondReason, noDuplicate: charsBefore === charsAfter };
  }

  /* (4) Concurrent Apply of the SAME preview */
  {
    const info = await confirmedDoc(primary, 'projA', 'concurrent1');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Race Elara', quote: 'Elara the brave' });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    const inst1 = mk();
    const inst2 = mk();
    const settled = await Promise.allSettled([
      inst1.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint }),
      inst2.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint }),
    ]);
    const rejected = settled.filter((s) => s.status === 'rejected');
    const chars = await db.table('characters').where('projectId').equals('projA').toArray();
    const matching = chars.filter((c) => c.name === 'Race Elara');
    const persisted = await db.table('extractionRecords').get(rec.id);
    report.concurrentSame = {
      fulfilled: settled.filter((s) => s.status === 'fulfilled').length,
      rejected: rejected.length,
      rejectedReason: rejected[0] ? rejected[0].reason && rejected[0].reason.reason : null,
      entityCount: matching.length,
      recordStatus: persisted.integration.status,
    };
  }

  /* (5) Concurrent Apply with DIFFERENT previews of the same record */
  {
    const info = await confirmedDoc(primary, 'projA', 'concurrent2');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Diff Preview', quote: 'Elara the brave' });
    const pa = await mk().integrationService.previewIntegration('projA', rec.id);
    const pb = await mk().integrationService.previewIntegration('projA', rec.id);
    const settled = await Promise.allSettled([
      mk().integrationService.applyIntegration('projA', rec.id, { previewFingerprint: pa.fingerprint }),
      mk().integrationService.applyIntegration('projA', rec.id, { previewFingerprint: pb.fingerprint }),
    ]);
    const chars = await db.table('characters').where('projectId').equals('projA').toArray();
    const matching = chars.filter((c) => c.name === 'Diff Preview');
    report.concurrentDiff = {
      fulfilled: settled.filter((s) => s.status === 'fulfilled').length,
      entityCount: matching.length,
    };
  }

  /* (6) Two DIFFERENT records -> same Character (concurrent) */
  {
    const info = await confirmedDoc(primary, 'projA', 'samechar');
    const info2 = await confirmedDoc(primary, 'projA', 'samechar2');
    const r1 = await confirmedRecord(primary, 'projA', info, { title: 'Shared Name', quote: 'Elara the brave', summary: 'first' });
    const r3 = await confirmedRecord(primary, 'projA', info2, { title: 'Shared Name', quote: 'Elara the brave', summary: 'third' });
    const p1 = await primary.integrationService.previewIntegration('projA', r1.id);
    const p3 = await primary.integrationService.previewIntegration('projA', r3.id);
    const settled = await Promise.allSettled([
      mk().integrationService.applyIntegration('projA', r1.id, { previewFingerprint: p1.fingerprint }),
      mk().integrationService.applyIntegration('projA', r3.id, { previewFingerprint: p3.fingerprint }),
    ]);
    const chars = await db.table('characters').where('projectId').equals('projA').toArray();
    const matching = chars.filter((c) => c.name === 'Shared Name');
    const rejected = settled.filter((s) => s.status === 'rejected');
    report.sameCharacter = {
      fulfilled: settled.filter((s) => s.status === 'fulfilled').length,
      rejectedReasons: rejected.map((s) => s.reason && s.reason.reason),
      entityCount: matching.length,
    };
  }

  /* (7) Multiple World sections appended concurrently */
  {
    const info = await confirmedDoc(primary, 'projA', 'world');
    const titles = ['Whispering Forest', 'Iron Mountains', 'Silver Lake'];
    const records = [];
    for (const title of titles) {
      records.push(await confirmedRecord(primary, 'projA', info, { kind: 'location', title, quote: 'walked into the forest', summary: 'A place.' }));
    }
    const previews = [];
    for (const rec of records) previews.push(await primary.integrationService.previewIntegration('projA', rec.id));
    const settled = await Promise.allSettled(
      records.map((rec, i) => mk().integrationService.applyIntegration('projA', rec.id, { previewFingerprint: previews[i].fingerprint })),
    );
    const world = await db.table('worlds').where('projectId').equals('projA').first();
    const sectionTitles = world ? world.sections.map((s) => s.title) : [];
    const rejected = settled.filter((s) => s.status === 'rejected');
    report.concurrentWorld = {
      fulfilled: settled.filter((s) => s.status === 'fulfilled').length,
      rejectedReasons: rejected.map((s) => s.reason && s.reason.reason),
      worldCount: await db.table('worlds').where('projectId').equals('projA').count(),
      sectionCount: world ? world.sections.length : 0,
      // Every fulfilled append must be a DISTINCT section that is present; a
      // stale-preview rejection is the safe outcome for appends that lost the
      // race (never a silent overwrite of another writer's section).
      allTitlesPresent: titles.every((t) => sectionTitles.includes(t)),
    };
  }

  /* (8) Duplicate KnowledgeEntry integration -> one entry */
  {
    const info = await confirmedDoc(primary, 'projA', 'knowledge');
    const rec = await confirmedRecord(primary, 'projA', info, { kind: 'event', title: 'The First Hunt', quote: 'walked into the forest', summary: 'A hunt.' });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    await primary.integrationService.integrateExtraction('projA', rec.id).catch(() => {});
    const entries = (await db.table('knowledgeEntries').where('projectId').equals('projA').toArray()).filter((e) => e.title === 'The First Hunt');
    report.knowledgeDedupe = { entryCount: entries.length };
  }

  /* (9) stale-preview: changed record refused */
  {
    const info = await confirmedDoc(primary, 'projA', 'stale');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Stale Elara', quote: 'Elara the brave', summary: 'orig' });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    const row = await db.table('extractionRecords').get(rec.id);
    await db.table('extractionRecords').put(Object.assign({}, row, { title: 'Stale Elara CHANGED', updatedAt: row.updatedAt + 1 }));
    const charsBefore = await db.table('characters').where('projectId').equals('projA').count();
    let reason = null;
    try {
      await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    } catch (e) { reason = e && e.reason; }
    const charsAfter = await db.table('characters').where('projectId').equals('projA').count();
    const after = await db.table('extractionRecords').get(rec.id);
    report.stalePreview = {
      reason,
      noEntityWritten: charsBefore === charsAfter,
      recordNotApplied: after.integration.status !== 'applied',
    };
  }

  /* (10) Evidence failure: stale locator refused */
  {
    const info = await confirmedDoc(primary, 'projA', 'evidence');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Stale Evidence', quote: 'Elara the brave' });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    const sectionRow = await db.table('documentSections').get(info.para.id);
    await db.table('documentSections').put(Object.assign({}, sectionRow, { text: sectionRow.text.replace('Elara the brave', 'Zzzzz the brave') }));
    const charsBefore = await db.table('characters').where('projectId').equals('projA').count();
    let reason = null;
    try {
      await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    } catch (e) { reason = e && e.reason; }
    const charsAfter = await db.table('characters').where('projectId').equals('projA').count();
    const after = await db.table('extractionRecords').get(rec.id);
    await db.table('documentSections').put(sectionRow);
    report.evidenceFailure = {
      reason,
      noEntityWritten: charsBefore === charsAfter,
      recordNotApplied: after.integration.status !== 'applied',
    };
  }

  /* (11) Field-strategy conflicts */
  {
    const info = await confirmedDoc(primary, 'projA', 'conflict');
    const r1 = await confirmedRecord(primary, 'projA', info, { title: 'Conflict Hero', quote: 'Elara the brave', summary: 'original', body: 'orig body' });
    const p1 = await primary.integrationService.previewIntegration('projA', r1.id);
    await primary.integrationService.applyIntegration('projA', r1.id, { previewFingerprint: p1.fingerprint });

    const info2 = await confirmedDoc(primary, 'projA', 'conflict2');
    const r2 = await confirmedRecord(primary, 'projA', info2, { title: 'Conflict Hero', quote: 'Elara the brave', summary: 'incoming summary', body: 'incoming body' });
    const p2 = await primary.integrationService.previewIntegration('projA', r2.id);
    await primary.integrationService.applyIntegration('projA', r2.id, { previewFingerprint: p2.fingerprint });
    let chars = await db.table('characters').where('projectId').equals('projA').toArray();
    let hero = chars.find((c) => c.name === 'Conflict Hero');
    const keepExistingSummary = hero ? hero.summary : null;

    const info3 = await confirmedDoc(primary, 'projA', 'conflict3');
    const r3 = await confirmedRecord(primary, 'projA', info3, { title: 'Conflict Hero', quote: 'Elara the brave', summary: 'forced summary', body: 'forced body' });
    const p3 = await primary.integrationService.previewIntegration('projA', r3.id, { summary: 'use-extracted' });
    await primary.integrationService.applyIntegration('projA', r3.id, { previewFingerprint: p3.fingerprint, fieldStrategies: { summary: 'use-extracted' } });
    chars = await db.table('characters').where('projectId').equals('projA').toArray();
    hero = chars.find((c) => c.name === 'Conflict Hero');
    const useExtractedSummary = hero ? hero.summary : null;

    const info4 = await confirmedDoc(primary, 'projA', 'conflict4');
    const r4 = await confirmedRecord(primary, 'projA', info4, { title: 'Conflict Hero', quote: 'Elara the brave', summary: 'x' });
    let unsupportedReason = null;
    try {
      const p4 = await primary.integrationService.previewIntegration('projA', r4.id, { role: 'use-extracted' });
      await primary.integrationService.applyIntegration('projA', r4.id, { previewFingerprint: p4.fingerprint, fieldStrategies: { role: 'use-extracted' } });
    } catch (e) { unsupportedReason = e && e.reason; }

    report.conflicts = {
      keepExistingSummary,
      useExtractedSummary,
      unsupportedReason,
      heroCount: (await db.table('characters').where('projectId').equals('projA').toArray()).filter((c) => c.name === 'Conflict Hero').length,
    };
  }

  /* (12) Transaction failure mid-write -> full rollback */
  {
    const info = await confirmedDoc(primary, 'projA', 'rollback');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Rollback Hero', quote: 'Elara the brave', summary: 'rb' });
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    const before = {
      chars: await db.table('characters').where('projectId').equals('projA').count(),
    };
    const failing = mk({
      repoOverride: (base) => new Proxy(base, {
        get(t, p) {
          if (p === 'updateExtraction') return async () => { throw new Error('injected stamp failure'); };
          const v = t[p];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    });
    let threw = false;
    try {
      await failing.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    } catch (e) { threw = true; }
    const after = {
      chars: await db.table('characters').where('projectId').equals('projA').count(),
      rollbackHeroCount: (await db.table('characters').where('projectId').equals('projA').toArray()).filter((c) => c.name === 'Rollback Hero').length,
      record: await db.table('extractionRecords').get(rec.id),
    };
    report.rollback = {
      threw,
      entityRolledBack: before.chars === after.chars && after.rollbackHeroCount === 0,
      stampRolledBack: after.record.integration.status !== 'applied',
      auditAbsent: !after.record.integrationAudit,
    };
  }

  /* (13) Project isolation */
  {
    const infoA = await confirmedDoc(primary, 'projA', 'isoA');
    const recA = await confirmedRecord(primary, 'projA', infoA, { title: 'Iso A', quote: 'Elara the brave' });
    const infoB = await confirmedDoc(primary, 'projB', 'isoB');
    const recB = await confirmedRecord(primary, 'projB', infoB, { title: 'Iso B', quote: 'Elara the brave' });

    let previewFromB = null, applyFromB = null;
    try { await primary.integrationService.previewIntegration('projB', recA.id); }
    catch (e) { previewFromB = e && e.name; }
    try { await primary.integrationService.applyIntegration('projB', recA.id, { previewFingerprint: 'prv_x' }); }
    catch (e) { applyFromB = e && e.name; }

    const pendA = await primary.integrationService.listPendingIntegration('projA');
    const pendB = await primary.integrationService.listPendingIntegration('projB');

    report.isolation = {
      previewFromB,
      applyFromB,
      recordAStatusUnchanged: (await db.table('extractionRecords').get(recA.id)).integration.status !== 'applied',
      pendAOnlyA: pendA.every((r) => r.projectId === 'projA'),
      pendBOnlyB: pendB.every((r) => r.projectId === 'projB'),
      bHasB: pendB.some((r) => r.id === recB.id),
      aHasB: pendA.some((r) => r.id === recB.id),
    };
  }

  /* (14) Raw-text immutability across an apply */
  {
    const info = await confirmedDoc(primary, 'projA', 'immutable');
    const rec = await confirmedRecord(primary, 'projA', info, { title: 'Immutable Hero', quote: 'Elara the brave' });
    const docBefore = await db.table('sourceDocuments').get(info.doc.id);
    const preview = await primary.integrationService.previewIntegration('projA', rec.id);
    await primary.integrationService.applyIntegration('projA', rec.id, { previewFingerprint: preview.fingerprint });
    const docAfter = await db.table('sourceDocuments').get(info.doc.id);
    report.immutable = {
      rawTextUnchanged: docBefore.rawText === docAfter.rawText,
      hashUnchanged: docBefore.rawTextHash === docAfter.rawTextHash,
    };
  }

  db.close();
  await Dexie.delete(DB_NAME);
  return report;
}
