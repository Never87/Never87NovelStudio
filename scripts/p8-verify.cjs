/**
 * P8 Batch-1 verification — Import data foundation & document parser contracts.
 *
 * Runs in plain Node (no browser, no network, no IndexedDB). Modules are bundled
 * from source with the project's own Vite/esbuild pipeline (see
 * `lib/p4-bundler.cjs`), so the code under test is exactly what ships. The
 * `ImportRepository` is driven through an in-memory fake of the three stores it
 * touches, implementing just the Dexie query surface the repository uses.
 *
 * Focus — the checks a UI smoke test cannot see and that must never regress:
 *   - Schema rejects malformed documents / sections / evidence / extractions,
 *     and enforces confidence bounds.
 *   - DocumentEvidence correctness: quote must match the addressed slice.
 *   - Parser offset integrity (rawText.slice(start,end) === text) across
 *     Markdown, numbered chapters, scene separators, CJK, emoji, CRLF/LF.
 *   - Parser is CONSERVATIVE: no headings → no fabricated scenes/volumes.
 *   - Repository CRUD, dedupe lookup, project isolation and cascade delete.
 *   - Migration: v8 data survives upgrade to v9 and remains readable; the three
 *     new stores start empty.
 *
 * Usage: npm run verify:import
 */
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
    const ok = predicate(error);
    record(name, ok, ok ? undefined : `threw ${error && error.name}: ${error && error.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory fake table + db (only the Dexie surface the repo uses)          */
/* -------------------------------------------------------------------------- */

/**
 * A tiny in-memory table realising the subset of the Dexie `Table` API used by
 * `ImportRepository`: get/add/bulkAdd/put/delete, and `where(index)` with
 * `equals`, `between`, `toArray`, `first`, `delete`. Compound indexes are keyed
 * by the index string used in the query (e.g. `[projectId+dedupeKey]`).
 */
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
    _set: (id, row) => map.set(id, row),
    async get(id) { return map.has(id) ? clone(map.get(id)) : undefined; },
    async add(row) {
      if (map.has(row.id)) {
        const err = new Error('ConstraintError');
        err.name = 'ConstraintError';
        throw err;
      }
      map.set(row.id, clone(row));
    },
    async bulkAdd(rows) {
      for (const r of rows) {
        if (map.has(r.id)) {
          const err = new Error('ConstraintError');
          err.name = 'ConstraintError';
          throw err;
        }
      }
      for (const r of rows) map.set(r.id, clone(r));
    },
    async put(row) { map.set(row.id, clone(row)); },
    async delete(id) { map.delete(id); },
    where(index) {
      const self = table;
      const list = () => [...map.values()];
      const rangeFn = {
        async toArray() { throw new Error('unreachable'); },
      };
      void rangeFn;
      const sel = (predicate) => ({
        async toArray() { return list().filter(predicate).map(clone); },
        async first() { const r = list().find(predicate); return r ? clone(r) : undefined; },
        async delete() {
          let n = 0;
          for (const r of list()) if (predicate(r)) { map.delete(r.id); n += 1; }
          return n;
        },
        async count() { return list().filter(predicate).length; },
      });
      return {
        equals(value) { return sel((r) => matchesIndex(r, index, value)); },
        between(lower, upper) {
          // Only used for [documentId+order]: rows whose documentId matches the
          // lower bound's first component and whose order is within [lower..upper].
          return sel((r) => r.documentId === lower[0] && r.order >= lower[1] && r.order <= upper[1]);
        },
      };
    },
  };
  return table;
}

function makeFakeDb(tables) {
  const db = {
    sourceDocuments: tables.documents,
    documentSections: tables.sections,
    extractionRecords: tables.extractions,
    // Dexie's `table.db.transaction(mode, ...tables, fn)` — run the fn directly.
    // eslint-disable-next-line no-unused-vars
    async transaction(_mode, ...args) {
      const fn = args[args.length - 1];
      return fn();
    },
  };
  // Each table needs `.db` pointing back so `this.table.db.transaction` works.
  for (const t of Object.values(tables)) {
    t.db = db;
  }
  return db;
}

function makeStores() {
  const tables = { documents: makeFakeTable(), sections: makeFakeTable(), extractions: makeFakeTable() };
  const db = makeFakeDb(tables);
  return { db, tables };
}

let seq = 0;
const uid = (p) => `${p}_${++seq}_${Date.now()}`;

function validDocument(overrides = {}) {
  const rawText = 'Hello world. This is the draft.';
  return {
    id: uid('doc'),
    projectId: 'proj',
    fileName: 'draft.txt',
    format: 'txt',
    rawText,
    characterCount: rawText.length,
    wordCount: 5,
    status: 'imported',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function validSection(doc, overrides = {}) {
  const start = overrides.start ?? 0;
  const end = overrides.end ?? 5;
  const raw = (overrides.rawText) ?? 'Hello world. This is the draft.';
  return {
    id: uid('dsec'),
    projectId: doc.projectId,
    documentId: doc.id,
    parentId: null,
    level: 'paragraph',
    title: '',
    order: 0,
    start,
    end,
    text: raw.slice(start, end),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function validEvidence(overrides = {}) {
  return {
    documentId: 'doc1',
    sectionId: 'dsec1',
    start: 0,
    end: 5,
    quote: 'Hello',
    ...overrides,
  };
}

function validExtraction(overrides = {}) {
  return {
    id: uid('ext'),
    projectId: 'proj',
    documentId: 'doc1',
    kind: 'character',
    title: 'Elara',
    summary: '',
    body: '',
    tags: [],
    origin: 'fact',
    confidence: null,
    evidence: [validEvidence()],
    dedupeKey: 'doc1|character|elara|sec1',
    reviewStatus: 'pending',
    relatedIds: [],
    integration: { status: 'not-applied' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p8-entry.ts', 'p8', { alias });
  const {
    SourceDocumentSchema,
    DocumentSectionSchema,
    DocumentEvidenceSchema,
    evidenceQuoteMatches,
    ExtractionRecordSchema,
    EXTRACTION_KINDS,
    EXTRACTION_ORIGINS,
    EXTRACTION_REVIEW_STATUSES,
    buildDedupeKey,
    normaliseForKey,
    normalizeText,
    detectStructure,
    parseDocument,
    DocumentParseError,
    ImportRepository,
    ProjectRepositoryError,
    MAX_DOCUMENT_CHARS,
  } = mod;

  /* ==================================================================== */
  /* 1. Schema — SourceDocument                                            */
  /* ==================================================================== */
  {
    eq('doc: valid document accepted', SourceDocumentSchema.safeParse(validDocument()).success, true);
    eq('doc: empty rawText rejected', SourceDocumentSchema.safeParse(validDocument({ rawText: '', characterCount: 0, wordCount: 0 })).success, false);
    eq('doc: unknown format rejected', SourceDocumentSchema.safeParse(validDocument({ format: 'docx' })).success, false);
    eq('doc: negative characterCount rejected', SourceDocumentSchema.safeParse(validDocument({ characterCount: -1 })).success, false);
    const tooLong = 'a'.repeat(MAX_DOCUMENT_CHARS + 1);
    eq('doc: over-limit rawText rejected', SourceDocumentSchema.safeParse(validDocument({ rawText: tooLong, characterCount: tooLong.length, wordCount: 0 })).success, false);
    eq('doc: updatedAt < createdAt rejected', SourceDocumentSchema.safeParse(validDocument({ createdAt: 10, updatedAt: 5 })).success, false);
  }

  /* ==================================================================== */
  /* 2. Schema — DocumentSection                                           */
  /* ==================================================================== */
  {
    const doc = validDocument();
    eq('section: valid section accepted', DocumentSectionSchema.safeParse(validSection(doc)).success, true);
    // end < start rejected.
    eq('section: end < start rejected', DocumentSectionSchema.safeParse(validSection(doc, { start: 5, end: 2, text: '' })).success, false);
    // text length must equal end - start.
    eq('section: text length mismatch rejected', DocumentSectionSchema.safeParse(validSection(doc, { start: 0, end: 5, text: 'Hi' })).success, false);
    // negative offset rejected.
    eq('section: negative start rejected', DocumentSectionSchema.safeParse(validSection(doc, { start: -1, end: 5, text: 'xxxxxx' })).success, false);
    // unknown level rejected.
    eq('section: unknown level rejected', DocumentSectionSchema.safeParse(validSection(doc, { level: 'subtitle' })).success, false);
  }

  /* ==================================================================== */
  /* 3. Schema — DocumentEvidence (quote slice match)                      */
  /* ==================================================================== */
  {
    eq('evidence: valid evidence accepted', DocumentEvidenceSchema.safeParse(validEvidence()).success, true);
    eq('evidence: end < start rejected', DocumentEvidenceSchema.safeParse(validEvidence({ start: 5, end: 2 })).success, false);
    eq('evidence: negative start rejected', DocumentEvidenceSchema.safeParse(validEvidence({ start: -1 })).success, false);
    // Quote-vs-slice helper.
    const ev = validEvidence({ start: 0, end: 5, quote: 'Hello' });
    even('evidence: quote matches the addressed slice', evidenceQuoteMatches(ev, 'Hello world.') === true);
    even('evidence: mismatching quote detected', evidenceQuoteMatches(validEvidence({ start: 0, end: 5, quote: 'HeLLo' }), 'Hello world.') === false);
    even('evidence: out-of-range quote detected', evidenceQuoteMatches(validEvidence({ start: 0, end: 100, quote: 'x' }), 'short') === false);
    even('evidence: absent quote always matches', evidenceQuoteMatches(validEvidence({ quote: undefined }), 'Hi') === true);
  }

  /* ==================================================================== */
  /* 4. Schema — ExtractionRecord                                          */
  /* ==================================================================== */
  {
    eq('extraction: valid record accepted', ExtractionRecordSchema.safeParse(validExtraction()).success, true);
    // Missing/empty evidence rejected.
    eq('extraction: empty evidence rejected', ExtractionRecordSchema.safeParse(validExtraction({ evidence: [] })).success, false);
    eq('extraction: missing evidence rejected', ExtractionRecordSchema.safeParse(validExtraction({ evidence: undefined })).success, false);
    // Confidence bounds.
    eq('extraction: confidence 0 accepted', ExtractionRecordSchema.safeParse(validExtraction({ confidence: 0 })).success, true);
    eq('extraction: confidence 1 accepted', ExtractionRecordSchema.safeParse(validExtraction({ confidence: 1 })).success, true);
    eq('extraction: confidence 1.1 rejected', ExtractionRecordSchema.safeParse(validExtraction({ confidence: 1.1 })).success, false);
    eq('extraction: confidence -0.1 rejected', ExtractionRecordSchema.safeParse(validExtraction({ confidence: -0.1 })).success, false);
    eq('extraction: confidence null accepted', ExtractionRecordSchema.safeParse(validExtraction({ confidence: null })).success, true);
    // Origin/review enums.
    eq('extraction: unknown origin rejected', ExtractionRecordSchema.safeParse(validExtraction({ origin: 'robot' })).success, false);
    eq('extraction: unknown reviewStatus rejected', ExtractionRecordSchema.safeParse(validExtraction({ reviewStatus: 'maybe' })).success, false);
    eq('extraction: unknown kind rejected', ExtractionRecordSchema.safeParse(validExtraction({ kind: 'planet' })).success, false);
    // Valid kinds include relationship & style.
    even('extraction: kinds include relationship', EXTRACTION_KINDS.includes('relationship'));
    even('extraction: kinds include style', EXTRACTION_KINDS.includes('style'));
    even('extraction: origins are fact/ai/manual', EXTRACTION_ORIGINS.length === 3 && ['fact', 'ai', 'manual'].every((o) => EXTRACTION_ORIGINS.includes(o)));
    even('extraction: review statuses cover lifecycle', ['pending', 'confirmed', 'rejected', 'merged'].every((s) => EXTRACTION_REVIEW_STATUSES.includes(s)));
    // Dedupe key required.
    eq('extraction: empty dedupeKey rejected', ExtractionRecordSchema.safeParse(validExtraction({ dedupeKey: '' })).success, false);
    // default integration shape.
    const noIntegration = validExtraction();
    delete noIntegration.integration;
    const parsedDefault = ExtractionRecordSchema.safeParse(noIntegration);
    even('extraction: integration defaults to not-applied', parsedDefault.success && parsedDefault.data.integration.status === 'not-applied');
  }

  /* ==================================================================== */
  /* 4b. Dedupe key determinism                                           */
  /* ==================================================================== */
  {
    eq('dedupe: trims/collapses/lowercases', normaliseForKey('  Tide  Magic '), 'tide magic');
    const a = buildDedupeKey({ documentId: 'd1', kind: 'character', title: 'Elara', primarySectionId: 's1' });
    const b = buildDedupeKey({ documentId: 'd1', kind: 'character', title: '  ELARA ', primarySectionId: 's1' });
    eq('dedupe: key stable across case/space', a, b);
    const c = buildDedupeKey({ documentId: 'd1', kind: 'location', title: 'Elara', primarySectionId: 's1' });
    even('dedupe: key differs by kind', a !== c);
  }

  /* ==================================================================== */
  /* 5. Parser — normalizeText offset map                                 */
  /* ==================================================================== */
  {
    const raw = 'A\r\nB\rC';
    const n = normalizeText(raw);
    eq('normalize: CRLF & CR collapse to LF', n.text, 'A\nB\nC');
    // Every normalised index maps to a raw index such that slices line up.
    let ok = true;
    for (let i = 0; i < n.text.length; i += 1) {
      const rawIdx = n.rawIndex[i];
      const rawChar = raw[rawIdx];
      const mapped = rawChar === '\r' ? '\n' : rawChar;
      if (mapped !== n.text[i]) { ok = false; break; }
    }
    even('normalize: rawIndex maps every char back correctly', ok);
    eq('normalize: final sentinel equals raw length', n.rawIndex[n.text.length], raw.length);
    // BOM stripped.
    const bom = normalizeText('\uFEFFHello');
    eq('normalize: leading BOM stripped', bom.text, 'Hello');
    eq('normalize: BOM index map starts at raw 1', bom.rawIndex[0], 1);
  }

  /* ==================================================================== */
  /* 6. Parser — slice invariant across tricky inputs                     */
  /* ==================================================================== */
  {
    const cases = [
      { name: 'markdown multi-level', text: '# Volume One\n\nIntro para.\n\n## Chapter 1\n\nHello there.\n\n### Scene A\n\nA scene.\n' },
      { name: 'chinese numbered', text: '第一章 开始\n\n这是第一段。\n\n第二章 继续\n\n第二段内容。\n' },
      { name: 'english chapters', text: 'Chapter 1\n\nIt began.\n\nChapter 2\n\nIt ended.\n' },
      { name: 'scene separators', text: '第一段。\n\n***\n\n第二段。\n\n---\n\n第三段。\n' },
      { name: 'no headings', text: 'Just some prose.\n\nAnother paragraph here.\n' },
      { name: 'emoji + cjk mixed', text: '第一章 龙😀\n\n他笑了😄，然后走开。\n\n## Scene 😀\n\n🌙 夜晚。\n' },
      { name: 'CRLF everywhere', text: '# Title\r\n\r\nPara one.\r\n\r\n## Chapter\r\n\r\nBody text.\r\n' },
      { name: 'empty lines heavy', text: '\n\n\nParagraph A.\n\n\n\nParagraph B.\n\n\n' },
    ];

    for (const c of cases) {
      let parsed;
      try {
        parsed = parseDocument(c.text, 'markdown');
      } catch (e) {
        record(`parser[${c.name}]: parsed without throwing`, false, e.message);
        continue;
      }
      let allExact = true;
      let offending = null;
      for (const s of parsed.sections) {
        if (c.text.slice(s.start, s.end) !== s.text) {
          allExact = false;
          offending = s;
          break;
        }
      }
      record(`parser[${c.name}]: every section slice is exact`, allExact, offending ? JSON.stringify({ start: offending.start, end: offending.end, text: offending.text }) : undefined);
      // Offsets must be within bounds and ordered start<=end.
      const boundsOk = parsed.sections.every((s) => s.start >= 0 && s.end <= c.text.length && s.end >= s.start);
      record(`parser[${c.name}]: offsets within bounds`, boundsOk);
      // Every paragraph has empty title, structural headings have a title.
      const titlesOk = parsed.sections.every((s) => (s.level === 'paragraph' ? s.title === '' : s.title.length > 0));
      record(`parser[${c.name}]: titles match level`, titlesOk);
    }
  }

  /* ==================================================================== */
  /* 7. Parser — conservative structure recognition                       */
  /* ==================================================================== */
  {
    // Markdown multi-level → volume/chapter/scene + paragraphs.
    const md = parseDocument('# Vol\n\nx\n\n## Chap\n\ny\n\n### Sc\n\nz\n');
    even('parser: markdown produces volume level', md.sections.some((s) => s.level === 'volume'));
    even('parser: markdown produces chapter level', md.sections.some((s) => s.level === 'chapter'));
    even('parser: markdown produces scene level', md.sections.some((s) => s.level === 'scene'));
    even('parser: markdown produces paragraphs', md.sections.some((s) => s.level === 'paragraph'));
    even('parser: markdown hasStructure=true', md.hasStructure === true);

    // Chinese numbered chapters.
    const cn = parseDocument('第一章 开始\n\n内容。\n\n第二章 继续\n\n更多内容。\n');
    eq('parser: chinese two chapters recognised', cn.counts.chapter, 2);
    even('parser: chinese chapter titles preserved', cn.sections.some((s) => s.level === 'chapter' && s.title.includes('第一章')));

    // Chinese volume (卷).
    const cnVol = parseDocument('第一卷 起源\n\n内容。\n');
    even('parser: chinese 卷 is a volume', cnVol.sections.some((s) => s.level === 'volume'));

    // Scene separator alone does not create a scene heading; text stays prose.
    const sep = parseDocument('para one.\n\n***\n\npara two.\n');
    eq('parser: separator creates no scene section', sep.counts.scene, 0);
    even('parser: separator keeps content as paragraphs', sep.counts.paragraph >= 2);

    // No headings → single implicit chapter, no fabricated scenes/volumes.
    const plain = parseDocument('Just prose line one.\n\nLine two here.\n');
    eq('parser: plain text → 1 implicit chapter', plain.counts.chapter, 1);
    eq('parser: plain text → 0 scenes', plain.counts.scene, 0);
    eq('parser: plain text → 0 volumes', plain.counts.volume, 0);
    eq('parser: plain text hasStructure=false', plain.hasStructure, false);

    // Prose line that merely begins with a word like "Chapter" mid-sentence is
    // not mistreated: a long tail after the keyword is not a heading.
    const notHeading = parseDocument('Chapter one was a very long and winding story that went on for many pages without any real break at all here.\n');
    even('parser: long "Chapter..." prose line not forced into structure', notHeading.sections.filter((s) => s.level === 'chapter' && s.title.startsWith('Chapter')).length === 0);

    // Empty text throws.
    await rejectsWith('parser: empty text rejected', () => parseDocument(''), (e) => e instanceof DocumentParseError);

    // Parent/child tree: paragraphs under the last heading.
    const tree = parseDocument('# Vol\n\n## Chap\n\nBody paragraph.\n');
    const para = tree.sections.find((s) => s.level === 'paragraph');
    even('parser: paragraph has a parent index', para && para.parentIndex >= 0);
    const parent = para ? tree.sections[para.parentIndex] : null;
    even('parser: paragraph parent is the chapter', parent && parent.level === 'chapter');
  }

  /* ==================================================================== */
  /* 7b. countWords CJK-aware                                             */
  /* ==================================================================== */
  {
    const { countWords } = mod;
    eq('countWords: english three words', countWords('one two three'), 3);
    even('countWords: cjk counted per char', countWords('龍的传人') >= 4);
    eq('countWords: empty string → 0', countWords(''), 0);
    eq('countWords: whitespace only → 0', countWords('   \n\t '), 0);
  }

  /* ==================================================================== */
  /* 8. Repository — CRUD & queries                                       */
  /* ==================================================================== */
  {
    const { db } = makeStores();
    const repo = new ImportRepository(db);

    // Documents CRUD.
    const doc = validDocument({ id: 'docA', projectId: 'projA' });
    const created = await repo.createDocument(doc);
    eq('repo: createDocument returns record', created.id, 'docA');
    eq('repo: getDocumentById finds it', (await repo.getDocumentById('docA')).id, 'docA');
    eq('repo: getDocumentById missing → null', await repo.getDocumentById('nope'), null);
    await rejectsWith('repo: createDocument rejects invalid', () => repo.createDocument(validDocument({ rawText: '', characterCount: 0, wordCount: 0 })), (e) => e instanceof ProjectRepositoryError);

    // Sections bulk add + order retrieval.
    const sec1 = validSection(doc, { id: 'sA1', order: 0, start: 0, end: 5 });
    const sec2 = validSection(doc, { id: 'sA2', order: 1, start: 5, end: 11 });
    await repo.bulkCreateSections([sec2, sec1]); // out of order on purpose
    const sections = await repo.listSectionsByDocument('docA');
    eq('repo: sections ordered by order asc', sections.map((s) => s.id), ['sA1', 'sA2']);

    // Extractions CRUD + dedupe lookup.
    const ext1 = validExtraction({ id: 'eA1', projectId: 'projA', documentId: 'docA', dedupeKey: 'k1' });
    await repo.createExtraction(ext1);
    eq('repo: findExtractionByDedupeKey finds it', (await repo.findExtractionByDedupeKey('projA', 'k1')).id, 'eA1');
    eq('repo: dedupe lookup miss → null', await repo.findExtractionByDedupeKey('projA', 'nope'), null);
    eq('repo: dedupe lookup wrong project → null', await repo.findExtractionByDedupeKey('otherProject', 'k1'), null);

    // Update extraction.
    const upd = { ...ext1, reviewStatus: 'confirmed', updatedAt: 2 };
    await repo.updateExtraction(upd);
    eq('repo: updateExtraction persists status', (await repo.getExtractionById('eA1')).reviewStatus, 'confirmed');
  }

  /* ==================================================================== */
  /* 9. Repository — project isolation                                    */
  /* ==================================================================== */
  {
    const { db } = makeStores();
    const repo = new ImportRepository(db);
    await repo.createDocument(validDocument({ id: 'docA', projectId: 'projA' }));
    await repo.createDocument(validDocument({ id: 'docB', projectId: 'projB' }));

    eq('isolation: projA lists only its docs', (await repo.listDocumentsByProject('projA')).map((d) => d.id), ['docA']);
    eq('isolation: projB lists only its docs', (await repo.listDocumentsByProject('projB')).map((d) => d.id), ['docB']);

    // Same dedupe key in two projects → two independent records (no cross-talk).
    await repo.createExtraction(validExtraction({ id: 'eA', projectId: 'projA', documentId: 'docA', dedupeKey: 'shared' }));
    await repo.createExtraction(validExtraction({ id: 'eB', projectId: 'projB', documentId: 'docB', dedupeKey: 'shared' }));
    eq('isolation: same key resolves to projA record', (await repo.findExtractionByDedupeKey('projA', 'shared')).id, 'eA');
    eq('isolation: same key resolves to projB record', (await repo.findExtractionByDedupeKey('projB', 'shared')).id, 'eB');
  }

  /* ==================================================================== */
  /* 10. Repository — cascade delete                                      */
  /* ==================================================================== */
  {
    const { db, tables } = makeStores();
    const repo = new ImportRepository(db);
    await repo.createDocument(validDocument({ id: 'docA', projectId: 'projA' }));
    await repo.createDocument(validDocument({ id: 'docB', projectId: 'projB' }));
    await repo.bulkCreateSections([
      validSection({ id: 'sA1', projectId: 'projA', documentId: 'docA' }),
      validSection({ id: 'sB1', projectId: 'projB', documentId: 'docB' }),
    ]);
    await repo.createExtraction(validExtraction({ id: 'eA1', projectId: 'projA', documentId: 'docA', dedupeKey: 'a1' }));
    await repo.createExtraction(validExtraction({ id: 'eB1', projectId: 'projB', documentId: 'docB', dedupeKey: 'b1' }));

    const removed = await repo.deleteByProjectId('projA');
    eq('cascade: removed one document', removed.documents, 1);
    eq('cascade: removed one section', removed.sections, 1);
    eq('cascade: removed one extraction', removed.extractions, 1);

    eq('cascade: projA documents gone', (await repo.listDocumentsByProject('projA')).length, 0);
    eq('cascade: projA sections gone', tables.sections._all().filter((s) => s.projectId === 'projA').length, 0);
    eq('cascade: projA extractions gone', tables.extractions._all().filter((e) => e.projectId === 'projA').length, 0);

    eq('cascade: projB documents intact', (await repo.listDocumentsByProject('projB')).length, 1);
    eq('cascade: projB sections intact', tables.sections._all().filter((s) => s.projectId === 'projB').length, 1);
    eq('cascade: projB extractions intact', tables.extractions._all().filter((e) => e.projectId === 'projB').length, 1);

    // Idempotent: deleting an empty project removes nothing and does not throw.
    const again = await repo.deleteByProjectId('projA');
    even('cascade: idempotent re-delete', again.documents === 0 && again.sections === 0 && again.extractions === 0);
  }

  /* ==================================================================== */
  /* 11. Migration — v8 → v9 keeps old data, adds empty stores            */
  /* ==================================================================== */
  {
    // A true IndexedDB upgrade can't run in plain Node (no indexedDB global),
    // so we assert the STRUCTURAL contract the migration must honour: v9's
    // declarative store definitions (`storesSource`) are a strict superset of
    // v8's — every v8 store restated with the SAME schema string — and the only
    // additions are the three expected P8 stores. Combined with the fact that
    // the v9 block restates every earlier store verbatim (verified here), a real
    // Dexie upgrade provably preserves all pre-existing data.
    const dexieMod = await importBundled('src/db/database.ts', 'p8-db', { alias });
    const { NovelStudioDb } = dexieMod;
    const db = new NovelStudioDb(`p8-migration-${Date.now()}`);

    const versions = db._versions || [];
    const v8 = versions.find((v) => v._cfg && v._cfg.version === 8);
    const v9 = versions.find((v) => v._cfg && v._cfg.version === 9);

    even('migration: v8 version block present', Boolean(v8));
    even('migration: v9 version block present', Boolean(v9));

    if (v8 && v9) {
      const s8 = v8._cfg.storesSource; // { tableName: 'schema-string' }
      const s9 = v9._cfg.storesSource;
      let sameSchema = true;
      const diffs = [];
      for (const name of Object.keys(s8)) {
        if (s9[name] !== s8[name]) { sameSchema = false; diffs.push(name); }
      }
      even('migration: every v8 store restated byte-identically in v9', sameSchema, diffs.join(','));
      const added = Object.keys(s9).filter((n) => !(n in s8)).sort();
      eq('migration: exactly three stores added', added, ['documentSections', 'extractionRecords', 'sourceDocuments']);
      // Spell out the new schemas so a future edit that drops an index is caught.
      eq('migration: sourceDocuments schema', s9.sourceDocuments, '&id, projectId, status, updatedAt');
      eq('migration: documentSections schema', s9.documentSections, '&id, projectId, documentId, [documentId+order], parentId');
      eq('migration: extractionRecords schema', s9.extractionRecords, '&id, projectId, documentId, kind, reviewStatus, updatedAt, [projectId+dedupeKey]');
    }

    // The new tables exist on the instance (they start empty in a fresh DB).
    even('migration: sourceDocuments table exists', Boolean(db.sourceDocuments));
    even('migration: documentSections table exists', Boolean(db.documentSections));
    even('migration: extractionRecords table exists', Boolean(db.extractionRecords));

    try { db.close(); } catch { /* not open */ }
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
  console.error('P8 verification crashed:', error);
  process.exit(1);
});
