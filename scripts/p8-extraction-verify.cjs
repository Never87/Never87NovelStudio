// P8 Batch-3 verification — built below.
const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}
function even(name, condition, detail) {
  record(name, Boolean(condition), detail);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, ok, ok ? undefined : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
async function rejectsWith(name, fn, predicate) {
  try {
    await fn();
    record(name, false, 'expected a rejection');
  } catch (error) {
    const ok = predicate ? predicate(error) : true;
    record(name, ok, ok ? undefined : `threw ${error && error.name}: ${error && error.message}`);
  }
}

/* ---- fake tables / db (same strategy as p8-batch2) ---------------------- */

function makeFakeTable() {
  const map = new Map();
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const matchesIndex = (row, index, value) => {
    if (index.startsWith('[') && index.endsWith(']')) {
      const fields = index.slice(1, -1).split('+');
      return fields.every((f, i) => row[f] === value[i]);
    }
    return row[index] === value;
  };
  const table = {
    _all: () => [...map.values()],
    _map: map,
    _snapshot: () => new Map([...map].map(([k, v]) => [k, clone(v)])),
    _restore: (snap) => { map.clear(); for (const [k, v] of snap) map.set(k, v); },
    async get(id) { return map.has(id) ? clone(map.get(id)) : undefined; },
    async add(row) {
      if (map.has(row.id)) { const err = new Error('ConstraintError'); err.name = 'ConstraintError'; throw err; }
      map.set(row.id, clone(row));
    },
    async bulkAdd(rows) {
      for (const r of rows) { if (map.has(r.id)) { const err = new Error('ConstraintError'); err.name = 'ConstraintError'; throw err; } }
      for (const r of rows) map.set(r.id, clone(r));
    },
    async put(row) { map.set(row.id, clone(row)); },
    async delete(id) { map.delete(id); },
    where(index) {
      const list = () => [...map.values()];
      const sel = (predicate) => ({
        async toArray() { return list().filter(predicate).map(clone); },
        async first() { const r = list().find(predicate); return r ? clone(r) : undefined; },
        async delete() { let n = 0; for (const r of list()) if (predicate(r)) { map.delete(r.id); n += 1; } return n; },
        async count() { return list().filter(predicate).length; },
      });
      return {
        equals(value) { return sel((r) => matchesIndex(r, index, value)); },
        between(lower, upper) { return sel((r) => r.documentId === lower[0] && r.order >= lower[1] && r.order <= upper[1]); },
      };
    },
  };
  return table;
}

function makeStores() {
  const tables = { documents: makeFakeTable(), sections: makeFakeTable(), extractions: makeFakeTable() };
  const db = {
    sourceDocuments: tables.documents,
    documentSections: tables.sections,
    extractionRecords: tables.extractions,
    async transaction(_mode, ...args) {
      const fn = args[args.length - 1];
      const snaps = Object.values(tables).map((t) => t._snapshot());
      try {
        return await fn();
      } catch (error) {
        Object.values(tables).forEach((t, i) => t._restore(snaps[i]));
        throw error;
      }
    },
  };
  for (const t of Object.values(tables)) t.db = db;
  return { db, tables };
}

function makeFakeProjectService(ids) {
  const set = new Set(ids);
  return { async projectExists(id) { return set.has(id); } };
}

/** Wires ImportService + ExtractionService against the fake db. */
function makeServices(mod, { projects = ['projA', 'projB'], generate } = {}) {
  const { db, tables } = makeStores();
  const projectService = makeFakeProjectService(projects);
  const repository = new mod.ImportRepository(db);
  const importService = new mod.ImportService({ repository, projectService, db });
  const extractionService = new mod.ExtractionService({ repository, importService, generate });
  return { extractionService, importService, db, tables };
}

/** A generator that returns whatever JSON the test supplies (function or string). */
function fakeGenerator(content, target) {
  const calls = [];
  const fn = async (options) => {
    calls.push(options);
    const body = typeof content === 'function' ? content(options) : content;
    return {
      result: { content: body, finishReason: 'stop' },
      target: target || {
        provider: { name: 'TestProvider' },
        model: { modelId: 'test-model', displayName: 'Test Model' },
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** Sets up a confirmed document with deterministic structure, returns {doc, sections}. */
async function setupConfirmedDoc(importService, opts = {}) {
  const projectId = opts.projectId || 'projA';
  const rawText = opts.rawText || '# Volume One\n\n## Chapter 1\n\nElara the brave walked into the forest.\n\nAria the wise followed her closely.\n';
  const doc = await importService.createDocument(projectId, { format: opts.format || 'markdown', rawText });
  await importService.parseDocument(projectId, doc.id);
  await importService.confirmStructure(projectId, doc.id);
  const sections = await importService.getConfirmedSections(projectId, doc.id);
  return { doc, sections };
}

function pickProseSection(sections) {
  return sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
}

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p8-extraction-entry.ts', 'p8b3', { alias });
  const {
    ExtractionValidationError, ExtractionNotFoundError, ExtractionServiceError,
    resolveEvidenceInSection, resolveEvidenceInDocument, findOccurrences, toDocumentOffsets,
    parseAiCandidates, buildExtractionMessages,
  } = mod;

  /* ==================================================================== */
  /* A. Pure evidence-resolution utilities                                */
  /* ==================================================================== */
  {
    eq('evidence.fn: findOccurrences finds all non-overlapping', findOccurrences('aaaa', 'aa'), [0, 2]);
    eq('evidence.fn: findOccurrences single', findOccurrences('hello world', 'world'), [6]);
    eq('evidence.fn: findOccurrences none', findOccurrences('hello', 'zzz'), []);
    eq('evidence.fn: findOccurrences empty quote -> []', findOccurrences('hello', ''), []);

    const section = {
      id: 'dsec_x', projectId: 'projA', documentId: 'doc_x', parentId: null, level: 'paragraph',
      title: '', order: 0, start: 100, end: 100 + 'Elara the brave.'.length, text: 'Elara the brave.',
      createdAt: 1, updatedAt: 1,
    };
    const unique = resolveEvidenceInSection(section, 'the brave');
    even('evidence.fn: unique quote resolves', unique.ok);
    eq('evidence.fn: section-relative offsets are exact', { s: unique.evidence.start, e: unique.evidence.end }, { s: 6, e: 15 });
    eq('evidence.fn: resolved quote preserved verbatim', unique.evidence.quote, 'the brave');

    const empty = resolveEvidenceInSection(section, '');
    even('evidence.fn: empty quote rejected', !empty.ok && empty.reason === 'empty-quote');

    const missing = resolveEvidenceInSection(section, 'not present');
    even('evidence.fn: missing quote -> not-found', !missing.ok && missing.reason === 'not-found');

    const dupSection = { ...section, text: 'the the', end: 100 + 7 };
    const amb = resolveEvidenceInSection(dupSection, 'the');
    even('evidence.fn: ambiguous quote (no hint) rejected', !amb.ok && amb.reason === 'ambiguous');

    const ambHint = resolveEvidenceInSection(dupSection, 'the', { expectedStart: 4 });
    even('evidence.fn: expectedStart disambiguates', ambHint.ok);
    eq('evidence.fn: hint picks nearest occurrence', ambHint.evidence.start, 4);

    const raw = 'X'.repeat(100) + 'Elara the brave.';
    const inDoc = resolveEvidenceInDocument(raw, section, 'brave');
    even('evidence.fn: document resolution ok', inDoc.ok);
    eq('evidence.fn: document resolution keeps section-relative offsets', { s: inDoc.evidence.start, e: inDoc.evidence.end }, { s: 10, e: 15 });

    const badSection = { ...section, text: 'Elara the brave but drifted.', end: 100 + 'Elara the brave but drifted.'.length };
    const drifted = resolveEvidenceInDocument(raw, badSection, 'brave');
    even('evidence.fn: section/raw drift -> cross-section rejection', !drifted.ok && drifted.reason === 'cross-section');

    const conv = toDocumentOffsets(section, 6, 15);
    eq('evidence.fn: toDocumentOffsets adds section.start', conv, { start: 106, end: 115 });
    let threw = false;
    try { toDocumentOffsets(section, 0, 9999); } catch { threw = true; }
    even('evidence.fn: toDocumentOffsets rejects out-of-range', threw);
  }

  /* ==================================================================== */
  /* B. Manual extraction over confirmed structure                        */
  /* ==================================================================== */
  {
    const gen = fakeGenerator('{"candidates":[]}');
    const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProseSection(sections);

    const quote = 'Elara the brave';
    const rec = await extractionService.createManualExtraction('projA', {
      documentId: doc.id, kind: 'character', title: 'Elara',
      summary: 'Brave protagonist', body: 'A brave character.', tags: ['protagonist'],
      evidence: [{ sectionId: prose.id, quote }],
    });
    eq('manual: origin = manual', rec.origin, 'manual');
    eq('manual: reviewStatus = pending (does NOT bypass review)', rec.reviewStatus, 'pending');
    eq('manual: confidence null (advisory only)', rec.confidence, null);
    eq('manual: integration not-applied', rec.integration.status, 'not-applied');
    eq('manual: created one record', tables.extractions._all().length, 1);
    even('manual: id prefixed ext_', rec.id.startsWith('ext_'), rec.id);

    const ev = rec.evidence[0];
    eq('manual: evidence documentId matches', ev.documentId, doc.id);
    eq('manual: evidence sectionId matches', ev.sectionId, prose.id);
    eq('manual: evidence quote verbatim', ev.quote, quote);
    eq('manual: evidence slice reproduces quote in section', prose.text.slice(ev.start, ev.end), quote);
    eq('manual: evidence doc-slice reproduces quote', doc.rawText.slice(prose.start + ev.start, prose.start + ev.end), quote);

    eq('manual: getExtraction via other project -> null', await extractionService.getExtraction('projB', rec.id), null);
    eq('manual: listPending includes it', (await extractionService.listPendingExtractions('projA')).map((r) => r.id), [rec.id]);

    const again = await extractionService.createManualExtraction('projA', {
      documentId: doc.id, kind: 'character', title: 'Elara', summary: 'Updated summary',
      evidence: [{ sectionId: prose.id, quote }],
    });
    eq('manual: re-create with same key does NOT duplicate', tables.extractions._all().length, 1);
    eq('manual: re-create preserves id', again.id, rec.id);
    eq('manual: re-create updates summary', again.summary, 'Updated summary');
    eq('manual: dedupeKey stable across re-create', again.dedupeKey, rec.dedupeKey);

    const other = await extractionService.createManualExtraction('projA', {
      documentId: doc.id, kind: 'character', title: 'Elara (alias)',
      evidence: [{ sectionId: prose.id, quote }],
    });
    eq('manual: different title creates a second record', tables.extractions._all().length, 2);
    even('manual: second record has a distinct id', other.id !== rec.id);
  }

  /* ==================================================================== */
  /* C. Manual extraction — evidence grounding rules                      */
  /* ==================================================================== */
  {
    const gen = fakeGenerator('{"candidates":[]}');
    const { extractionService, importService } = makeServices(mod, { generate: gen });
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProseSection(sections);

    await rejectsWith(
      'manual.grounding: fabricated quote rejected',
      () => extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'Ghost',
        evidence: [{ sectionId: prose.id, quote: 'this text is not in the document' }],
      }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'fabricated-quote',
    );

    await rejectsWith(
      'manual.grounding: unknown sectionId rejected (cross-document)',
      () => extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'X',
        evidence: [{ sectionId: 'dsec_does_not_exist', quote: 'Elara' }],
      }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'cross-document',
    );

    await rejectsWith(
      'manual.grounding: empty evidence rejected',
      () => extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'NoEvidence', evidence: [],
      }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'empty-evidence',
    );

    await rejectsWith(
      'manual.grounding: explicit offsets not matching quote rejected',
      () => extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'BadOffsets',
        evidence: [{ sectionId: prose.id, quote: 'Elara', start: 0, end: 3 }],
      }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'fabricated-quote',
    );

    await rejectsWith(
      'manual.grounding: explicit out-of-bounds rejected',
      () => extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'OOB',
        evidence: [{ sectionId: prose.id, quote: 'x', start: 0, end: prose.text.length + 99 }],
      }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'out-of-bounds',
    );

    const idx = prose.text.indexOf('brave');
    const ok = await extractionService.createManualExtraction('projA', {
      documentId: doc.id, kind: 'character', title: 'Grounded',
      evidence: [{ sectionId: prose.id, quote: 'brave', start: idx, end: idx + 'brave'.length }],
    });
    eq('manual.grounding: explicit valid offsets accepted', ok.evidence[0].start, idx);

    eq('manual.grounding: failed attempts persisted nothing', (await extractionService.listExtractions('projA')).length, 1);
  }

  /* ==================================================================== */
  /* D. Structure gating — confirmed sections required                    */
  /* ==================================================================== */
  {
    const gen = fakeGenerator('{"candidates":[]}');
    const { extractionService, importService } = makeServices(mod, { generate: gen });
    const doc = await importService.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nSome text here.\n' });
    await importService.parseDocument('projA', doc.id);
    const sections = await importService.getSections('projA', doc.id);
    const prose = pickProseSection(sections);

    await rejectsWith(
      'gating: extraction blocked when structure unconfirmed',
      () => extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'Early',
        evidence: [{ sectionId: prose.id, quote: 'Some text' }],
      }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'unconfirmed-structure',
    );

    await rejectsWith(
      'gating: AI extraction blocked when structure unconfirmed',
      () => extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'model_x' }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'unconfirmed-structure',
    );

    await rejectsWith(
      'gating: unknown document rejected',
      () => extractionService.createManualExtraction('projA', {
        documentId: 'doc_ghost', kind: 'character', title: 'X',
        evidence: [{ sectionId: 'dsec_x', quote: 'x' }],
      }),
      (e) => e instanceof Error,
    );

    await rejectsWith(
      'gating: cross-project document rejected',
      () => extractionService.createManualExtraction('projB', {
        documentId: doc.id, kind: 'character', title: 'X',
        evidence: [{ sectionId: prose.id, quote: 'Some text' }],
      }),
      (e) => e instanceof Error,
    );
  }

  /* ==================================================================== */
  /* E. AI extraction — happy path, grounding, JSON validation            */
  /* ==================================================================== */
  {
    let prose;
    const gen = fakeGenerator(() => JSON.stringify({
      candidates: [
        {
          kind: 'character', title: 'Elara', summary: 'Brave one', body: 'A protagonist.',
          tags: ['hero'], confidence: 0.8,
          evidence: [{ sectionId: prose.id, quote: 'Elara the brave' }],
        },
        {
          kind: 'character', title: 'Phantom', summary: '', body: '', tags: [], confidence: 0.9,
          evidence: [{ sectionId: prose.id, quote: 'Phantom is not mentioned anywhere here' }],
        },
      ],
    }));
    const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
    const { doc, sections } = await setupConfirmedDoc(importService);
    prose = pickProseSection(sections);

    const result = await extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'model_test' });
    eq('ai: one grounded candidate created', result.created.length, 1);
    eq('ai: fabricated candidate rejected', result.rejected, 1);
    eq('ai: no updates on first run', result.updated.length, 0);
    eq('ai: origin = ai', result.created[0].origin, 'ai');
    eq('ai: reviewStatus = pending', result.created[0].reviewStatus, 'pending');
    eq('ai: confidence preserved as advisory metadata', result.created[0].confidence, 0.8);
    eq('ai: target reflects injected model', result.target.modelId, 'test-model');
    eq('ai: exactly one record persisted (fabricated dropped)', tables.extractions._all().length, 1);

    const ev = result.created[0].evidence[0];
    eq('ai: grounded evidence slice reproduces quote', prose.text.slice(ev.start, ev.end), 'Elara the brave');

    eq('ai: generator called once', gen.calls.length, 1);
    eq('ai: generate uses explicit modelId', gen.calls[0].modelId, 'model_test');
    even('ai: messages include a system role', gen.calls[0].messages.some((m) => m.role === 'system'));
    even('ai: messages include a user role', gen.calls[0].messages.some((m) => m.role === 'user'));
    eq('ai: generation temperature pinned to 0', gen.calls[0].temperature, 0);

    const result2 = await extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'model_test' });
    eq('ai: re-run does not duplicate', tables.extractions._all().length, 1);
    eq('ai: re-run reports update', result2.updated.length, 1);
    eq('ai: re-run created nothing new', result2.created.length, 0);
    eq('ai: re-run preserves id', result2.updated[0].id, result.created[0].id);
  }

  /* ==================================================================== */
  /* F. AI extraction — malformed JSON / schema; nothing written          */
  /* ==================================================================== */
  {
    {
      const gen = fakeGenerator('this is not json');
      const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
      const { doc } = await setupConfirmedDoc(importService);
      await rejectsWith(
        'ai.invalid: non-JSON rejected',
        () => extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'm' }),
        (e) => e instanceof ExtractionValidationError && e.reason === 'invalid-ai-output',
      );
      eq('ai.invalid: nothing persisted on invalid JSON', tables.extractions._all().length, 0);
    }

    {
      const gen = fakeGenerator(JSON.stringify({ candidates: [{ kind: 'character', title: 'X' }] }));
      const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
      const { doc } = await setupConfirmedDoc(importService);
      await rejectsWith(
        'ai.invalid: schema-mismatch rejected',
        () => extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'm' }),
        (e) => e instanceof ExtractionValidationError && e.reason === 'invalid-ai-output',
      );
      eq('ai.invalid: nothing persisted on schema mismatch', tables.extractions._all().length, 0);
    }

    {
      let prose;
      const gen = fakeGenerator(() => '```json\n' + JSON.stringify({
        candidates: [{
          kind: 'location', title: 'The Forest', summary: '', body: '', tags: [], confidence: 0.5,
          evidence: [{ sectionId: prose.id, quote: 'into the forest' }],
        }],
      }) + '\n```');
      const { extractionService, importService } = makeServices(mod, { generate: gen });
      const { doc, sections } = await setupConfirmedDoc(importService);
      prose = pickProseSection(sections);
      const result = await extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'm' });
      eq('ai.fence: fenced JSON parsed', result.created.length, 1);
      eq('ai.fence: kind captured', result.created[0].kind, 'location');
    }

    {
      let prose;
      const gen = fakeGenerator(() => JSON.stringify({
        candidates: [{
          kind: 'not-a-real-kind', title: 'X', summary: '', body: '', tags: [], confidence: 0.2,
          evidence: [{ sectionId: prose.id, quote: 'Elara' }],
        }],
      }));
      const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
      const { doc, sections } = await setupConfirmedDoc(importService);
      prose = pickProseSection(sections);
      const result = await extractionService.generateAiExtractions('projA', { documentId: doc.id, modelId: 'm' });
      eq('ai.unknown-kind: nothing created', result.created.length, 0);
      eq('ai.unknown-kind: nothing persisted', tables.extractions._all().length, 0);
    }

    {
      const sentSection = { id: 'dsec_sent', text: 'abc' };
      const sectionById = new Map([[sentSection.id, sentSection]]);
      const out = parseAiCandidates(JSON.stringify({
        candidates: [{ kind: 'character', title: 'Y', evidence: [{ sectionId: 'dsec_other', quote: 'abc' }] }],
      }), sectionById);
      eq('ai.parse: candidate citing an unsent section is dropped', out.length, 0);
    }
  }

  /* ==================================================================== */
  /* G. Prompt builder sanity                                             */
  /* ==================================================================== */
  {
    const doc = { id: 'doc_x', fileName: 'novel.md', rawText: '', characterCount: 0, wordCount: 0, projectId: 'p', format: 'markdown', status: 'parsed', createdAt: 1, updatedAt: 1 };
    const sections = [{ id: 'dsec_1', projectId: 'p', documentId: 'doc_x', parentId: null, level: 'paragraph', title: '', order: 0, start: 0, end: 5, text: 'hello', createdAt: 1, updatedAt: 1 }];
    const messages = buildExtractionMessages(doc, sections, ['character', 'location'], 'focus on names');
    eq('prompt: two messages (system+user)', messages.map((m) => m.role), ['system', 'user']);
    even('prompt: system demands verbatim evidence + JSON only', /VERBATIM quote/.test(messages[0].content) && /JSON/.test(messages[0].content));
    even('prompt: user includes the section id', messages[1].content.includes('dsec_1'));
    even('prompt: user includes allowed kinds', messages[1].content.includes('character') && messages[1].content.includes('location'));
    even('prompt: user includes the instruction', messages[1].content.includes('focus on names'));
  }

  /* ==================================================================== */
  /* H. Update / delete / isolation                                       */
  /* ==================================================================== */
  {
    const gen = fakeGenerator('{"candidates":[]}');
    const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProseSection(sections);
    const rec = await extractionService.createManualExtraction('projA', {
      documentId: doc.id, kind: 'character', title: 'Elara',
      evidence: [{ sectionId: prose.id, quote: 'Elara' }],
    });

    const updated = await extractionService.updateExtraction('projA', rec.id, { summary: 'new summary', tags: ['a', 'b'] });
    eq('update: summary changed', updated.summary, 'new summary');
    eq('update: tags changed', updated.tags, ['a', 'b']);
    eq('update: origin preserved', updated.origin, 'manual');
    eq('update: createdAt preserved', updated.createdAt, rec.createdAt);
    even('update: updatedAt advanced or equal', updated.updatedAt >= rec.updatedAt);

    const moved = await extractionService.updateExtraction('projA', rec.id, {
      evidence: [{ sectionId: (sections.find((s) => s.text.includes('Aria the wise')) || prose).id, quote: 'Aria the wise' }],
    });
    const mev = moved.evidence[0];
    eq('update: new evidence quote correct', mev.quote, 'Aria the wise');
    const ariaSection = sections.find((s) => s.text.includes('Aria the wise'));
    eq('update: new evidence slice reproduces quote', ariaSection.text.slice(mev.start, mev.end), 'Aria the wise');

    await rejectsWith(
      'update: fabricated evidence rejected',
      () => extractionService.updateExtraction('projA', rec.id, { evidence: [{ sectionId: prose.id, quote: 'not here at all' }] }),
      (e) => e instanceof ExtractionValidationError && e.reason === 'fabricated-quote',
    );

    await rejectsWith('update: cross-project rejected', () => extractionService.updateExtraction('projB', rec.id, { summary: 'x' }), (e) => e instanceof ExtractionNotFoundError || e instanceof ExtractionServiceError);
    await rejectsWith('delete: cross-project rejected', () => extractionService.deleteExtraction('projB', rec.id), (e) => e instanceof ExtractionNotFoundError || e instanceof ExtractionServiceError);

    const docSectionsBefore = tables.sections._all().filter((s) => s.documentId === doc.id).length;
    await extractionService.deleteExtraction('projA', rec.id);
    eq('delete: extraction gone', await extractionService.getExtraction('projA', rec.id), null);
    eq('delete: document still exists', (await importService.getDocument('projA', doc.id)).id, doc.id);
    eq('delete: sections untouched', tables.sections._all().filter((s) => s.documentId === doc.id).length, docSectionsBefore);
  }

  /* ==================================================================== */
  /* I. Extraction never writes project entities (only extraction records)*/
  /* ==================================================================== */
  {
    const gen = fakeGenerator('{"candidates":[]}');
    const { extractionService, importService, tables } = makeServices(mod, { generate: gen });
    const { doc, sections } = await setupConfirmedDoc(importService);
    const prose = pickProseSection(sections);
    const docsBefore = JSON.stringify(tables.documents._all());
    const secsBefore = JSON.stringify(tables.sections._all());
    await extractionService.createManualExtraction('projA', {
      documentId: doc.id, kind: 'character', title: 'OnlyExtraction',
      evidence: [{ sectionId: prose.id, quote: 'Elara' }],
    });
    eq('isolation: documents table unchanged by extraction', JSON.stringify(tables.documents._all()), docsBefore);
    eq('isolation: sections table unchanged by extraction', JSON.stringify(tables.sections._all()), secsBefore);
    even('isolation: only extraction table gained a row', tables.extractions._all().length === 1);
  }

  /* ==================================================================== */
  /* J. UTF-16 offsets — CJK, emoji (surrogate pairs), CRLF, BOM, repeats  */
  /*                                                                      */
  /* These run the REAL parser (via ImportService) then ground evidence    */
  /* against the stored rawText, proving offsets are half-open UTF-16 code */
  /* units and that the persisted slice === quote for tricky characters.   */
  /* ==================================================================== */
  {
    const gen = fakeGenerator('{"candidates":[]}');

    // (J1) CJK text — multi-byte characters inside one paragraph.
    {
      const { extractionService, importService } = makeServices(mod, { generate: gen });
      const rawText = '# 第一卷\n\n## 第一章\n\n艾拉很勇敢。她走进了森林。\n';
      const { doc, sections } = await setupConfirmedDoc(importService, { rawText });
      const prose = pickProseSection(sections);
      const quote = '她走进了森林'; // must be found verbatim
      const rec = await extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'event', title: '进森林',
        evidence: [{ sectionId: prose.id, quote }],
      });
      const ev = rec.evidence[0];
      eq('utf16.cjk: section slice reproduces quote', prose.text.slice(ev.start, ev.end), quote);
      eq('utf16.cjk: rawText slice reproduces quote', doc.rawText.slice(prose.start + ev.start, prose.start + ev.end), quote);
      eq('utf16.cjk: quote length is UTF-16 code units', ev.end - ev.start, quote.length);
    }

    // (J2) Emoji (astral / surrogate pair) — 1 code point, 2 UTF-16 units.
    {
      const { extractionService, importService } = makeServices(mod, { generate: gen });
      const rawText = '# Story\n\n## Chapter 1\n\nShe smiled 😀 and waved 👋 goodbye.\n';
      const { doc, sections } = await setupConfirmedDoc(importService, { rawText });
      const prose = pickProseSection(sections);
      const quote = '😀 and waved 👋';
      const rec = await extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'style', title: 'emoji',
        evidence: [{ sectionId: prose.id, quote }],
      });
      const ev = rec.evidence[0];
      eq('utf16.emoji: section slice reproduces quote', prose.text.slice(ev.start, ev.end), quote);
      eq('utf16.emoji: rawText slice reproduces quote', doc.rawText.slice(prose.start + ev.start, prose.start + ev.end), quote);
      // The offset width must equal the UTF-16 length (emoji count as 2 units).
      eq('utf16.emoji: offsets count surrogate pairs as 2 units', ev.end - ev.start, quote.length);
    }

    // (J3) CRLF line endings — offsets must address the verbatim raw text.
    {
      const { extractionService, importService } = makeServices(mod, { generate: gen });
      const rawText = '# Volume\r\n\r\n## Chapter 1\r\n\r\nElara the brave walked.\r\n';
      const { doc, sections } = await setupConfirmedDoc(importService, { rawText });
      const prose = pickProseSection(sections);
      eq('utf16.crlf: section text has no synthetic chars beyond raw', prose.text, doc.rawText.slice(prose.start, prose.end));
      const quote = 'the brave';
      const rec = await extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'CRLF Elara',
        evidence: [{ sectionId: prose.id, quote }],
      });
      const ev = rec.evidence[0];
      eq('utf16.crlf: rawText slice reproduces quote', doc.rawText.slice(prose.start + ev.start, prose.start + ev.end), quote);
      const first = findOccurrences(prose.text, quote);
      eq('utf16.crlf: findOccurrences localises the quote', first.length, 1);
    }

    // (J4) Leading BOM — stripped for scanning but offsets still address raw.
    {
      const { extractionService, importService } = makeServices(mod, { generate: gen });
      const rawText = '\uFEFF# Volume\n\n## Chapter 1\n\nAria the wise followed.\n';
      const { doc, sections } = await setupConfirmedDoc(importService, { rawText });
      const prose = pickProseSection(sections);
      const quote = 'the wise';
      const rec = await extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'character', title: 'BOM Aria',
        evidence: [{ sectionId: prose.id, quote }],
      });
      const ev = rec.evidence[0];
      eq('utf16.bom: rawText slice reproduces quote (BOM-safe)', doc.rawText.slice(prose.start + ev.start, prose.start + ev.end), quote);
      even('utf16.bom: raw text still starts with BOM (never normalised)', doc.rawText.charCodeAt(0) === 0xfeff);
    }

    // (J5) Repeated quote within one section — ambiguous is rejected; an
    //      explicit disambiguating offset selects one occurrence.
    {
      const { extractionService, importService } = makeServices(mod, { generate: gen });
      const rawText = '# Volume\n\n## Chapter 1\n\nThe raven flew. The raven landed.\n';
      const { doc, sections } = await setupConfirmedDoc(importService, { rawText });
      const prose = pickProseSection(sections);
      eq('utf16.repeat: quote occurs twice', findOccurrences(prose.text, 'The raven').length, 2);

      await rejectsWith(
        'utf16.repeat: ambiguous repeated quote (no offset) rejected',
        () => extractionService.createManualExtraction('projA', {
          documentId: doc.id, kind: 'item', title: 'Raven ambiguous',
          evidence: [{ sectionId: prose.id, quote: 'The raven' }],
        }),
        (e) => e instanceof ExtractionValidationError && e.reason === 'ambiguous-quote',
      );

      const positions = findOccurrences(prose.text, 'The raven');
      const rec = await extractionService.createManualExtraction('projA', {
        documentId: doc.id, kind: 'item', title: 'Raven disambiguated',
        evidence: [{ sectionId: prose.id, quote: 'The raven', start: positions[1], end: positions[1] + 'The raven'.length }],
      });
      eq('utf16.repeat: disambiguated offset selects the 2nd occurrence', rec.evidence[0].start, positions[1]);
      eq('utf16.repeat: slice at chosen offset equals quote', prose.text.slice(rec.evidence[0].start, rec.evidence[0].end), 'The raven');
    }
  }

  cleanupTemp();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('P8 Batch-3 verification crashed:', error);
  process.exit(1);
});
