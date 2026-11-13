/**
 * P8 Batch-2 verification — ImportService lifecycle, structure editing,
 * confirmation and re-parse protection.
 *
 * Runs in plain Node (no browser/IndexedDB) and bundles the REAL modules with
 * the project's own Vite/esbuild pipeline (`lib/p4-bundler.cjs`), so the code
 * under test is exactly what ships. The `ImportService` is driven through:
 *   - an in-memory fake of the three P8 tables, with a `transaction()` that
 *     truly rolls back (snapshot/restore) so atomicity assertions are real;
 *   - a fake `projectService.projectExists` so project-existence rules are
 *     exercised without a projects table.
 *
 * Focus — behaviours a schema/parser test cannot see:
 *   - lifecycle: register (imported) → parse (parsed) → confirm;
 *   - project existence + project isolation (cross-project access rejected);
 *   - delete cascades to sections + extraction records;
 *   - parse idempotency, concurrent-parse safety, empty-doc rejection, rollback
 *     on mid-parse failure, raw-text immutability, offset invariant;
 *   - structure edits: title/level/parent/order, cross-doc parent rejection,
 *     cycle rejection, illegal level rejection, out-of-bounds offset untouched;
 *   - confirmation: normal, invalidated on edit, repeated confirm, gating of
 *     extraction input;
 *   - re-parse protection: confirmed structure, extraction references, unchanged
 *     text idempotency, changed-text safe handling.
 *
 * Usage: npm run verify:import:batch2
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
    const ok = predicate ? predicate(error) : true;
    record(name, ok, ok ? undefined : `threw ${error && error.name}: ${error && error.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* In-memory fake table + db with rollback-capable transactions               */
/* -------------------------------------------------------------------------- */

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
      const list = () => [...map.values()];
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
          return sel((r) => r.documentId === lower[0] && r.order >= lower[1] && r.order <= upper[1]);
        },
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
    // Dexie's transaction(mode, ...tableArgs, fn) with real rollback.
    // eslint-disable-next-line no-unused-vars
    async transaction(_mode, ...args) {
      const fn = args[args.length - 1];
      const snaps = Object.values(tables).map((t) => t._snapshot());
      try {
        const out = await fn();
        return out;
      } catch (error) {
        Object.values(tables).forEach((t, i) => t._restore(snaps[i]));
        throw error;
      }
    },
  };
  for (const t of Object.values(tables)) t.db = db;
  return { db, tables };
}

/** Fake ProjectService exposing only projectExists, backed by a Set of ids. */
function makeFakeProjectService(ids) {
  const set = new Set(ids);
  return {
    async projectExists(id) { return set.has(id); },
    _add(id) { set.add(id); },
  };
}

/** Builds an ImportService wired to the fake db + fake project service. */
function makeService(mod, { projects = ['projA', 'projB'], repositoryOverride } = {}) {
  const { db, tables } = makeStores();
  const projectService = makeFakeProjectService(projects);
  const repository = new mod.ImportRepository(db);
  const svcRepo = repositoryOverride ? repositoryOverride(repository) : repository;
  const service = new mod.ImportService({ repository: svcRepo, projectService, db });
  return { service, db, tables, projectService, repository };
}

async function main() {
  const path = require('node:path');
  const alias = { '@': path.resolve(__dirname, '..', 'src') };
  const mod = await importBundled('scripts/lib/p8-entry.ts', 'p8b2', { alias });
  const {
    ImportService, ImportServiceError, ImportNotFoundError, ImportConflictError, hashText,
    hashRawText, sha256Hex, isCurrentHashFormat, HASH_PREFIX,
  } = mod;

  /* ==================================================================== */
  /* Hash: SHA-256, tagged, deterministic, no normalisation               */
  /* ==================================================================== */
  {
    // Tagged @ prefix + 64 lowercase hex.
    eq('hash: is tagged with sha256: prefix', HASH_PREFIX, 'sha256:');
    even('hash: hashText is tagged', hashText('abc').startsWith('sha256:'), hashText('abc'));
    eq('hash: tagged hex body is 64 chars', hashText('whatever').replace('sha256:', '').length, 64);
    even('hash: body is lowercase hex', /^[0-9a-f]{64}$/.test(hashText('x').slice(7)));
    even('hash: matches the FIPS-180-4 abc vector', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    even('hash: matches the empty-string vector', sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    eq('hash: stable for same text', hashText('abc'), hashText('abc'));
    even('hash: differs for different text', hashText('abc') !== hashText('abd'));
    eq('hash: empty string stable', hashText(''), hashText(''));
    eq('hash: hashText delegates to hashRawText', hashText('draft'), hashRawText('draft'));

    // Determinism across "runs": recomputing gives identical output.
    eq('hash: recompute is identical (deterministic)', hashRawText('龍😀\r\nsecond'), hashRawText('龍😀\r\nsecond'));

    // NO normalisation: CRLF vs LF, trailing space, BOM all change the digest.
    even('hash: CRLF vs LF differ (no EOL normalisation)', hashText('a\r\nb') !== hashText('a\nb'));
    even('hash: trailing space matters (no trim)', hashText('line ') !== hashText('line'));
    even('hash: leading BOM matters', hashText('\uFEFFtext') !== hashText('text'));

    // Format recognition: legacy/unknown formats are rejected.
    eq('hash: current format recognised', isCurrentHashFormat(hashText('x')), true);
    eq('hash: legacy 8-hex rejected by isCurrentHashFormat', isCurrentHashFormat('1a2b3c4d'), false);
    eq('hash: untagged 64-hex rejected (must be tagged)', isCurrentHashFormat('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), false);
    eq('hash: null/undefined rejected', isCurrentHashFormat(null) && isCurrentHashFormat(undefined), false);
  }

  /* ==================================================================== */
  /* 1. Lifecycle: register → parse → confirm                             */
  /* ==================================================================== */
  {
    const { service } = makeService(mod);
    const doc = await service.createDocument('projA', {
      fileName: 'a.md', format: 'markdown',
      rawText: '# Volume One\n\n## Chapter 1\n\nHello world here.\n',
    });
    eq('lifecycle: created status = imported', doc.status, 'imported');
    eq('lifecycle: created parsedAt is null', doc.parsedAt ?? null, null);
    even('lifecycle: characterCount computed', doc.characterCount === doc.rawText.length);
    even('lifecycle: wordCount positive', doc.wordCount > 0);

    const listed = await service.listDocuments('projA');
    eq('lifecycle: listed one document', listed.length, 1);
    const got = await service.getDocument('projA', doc.id);
    eq('lifecycle: getDocument returns it', got && got.id, doc.id);

    const parsed = await service.parseDocument('projA', doc.id);
    eq('lifecycle: parse flips status to parsed', parsed.document.status, 'parsed');
    even('lifecycle: parse produced sections', parsed.sections.length > 0);
    eq('lifecycle: parse result sectionCount matches', parsed.sectionCount, parsed.sections.length);
    even('lifecycle: parse recorded parsedTextHash', typeof parsed.document.parsedTextHash === 'string');
    even('lifecycle: parse recorded parsedAt', typeof parsed.document.parsedAt === 'number');

    const confirmed = await service.confirmStructure('projA', doc.id);
    even('lifecycle: confirm records structureConfirmedAt', typeof confirmed.structureConfirmedAt === 'number');
    eq('lifecycle: isStructureConfirmed true after confirm', await service.isStructureConfirmed('projA', doc.id), true);
  }

  /* ==================================================================== */
  /* 2. Project existence + isolation                                     */
  /* ==================================================================== */
  {
    const { service } = makeService(mod, { projects: ['projA'] });
    await rejectsWith(
      'isolation: createDocument on unknown project rejected',
      () => service.createDocument('ghost', { rawText: 'hi' }),
      (e) => e instanceof ImportServiceError,
    );
    const doc = await service.createDocument('projA', { rawText: 'Alpha text here.' });
    // Cross-project access must be denied.
    eq('isolation: getDocument via other project → null', await service.getDocument('projB', doc.id), null);
    await rejectsWith('isolation: parse via other project rejected', () => service.parseDocument('projB', doc.id), (e) => e instanceof ImportNotFoundError);
    await rejectsWith('isolation: delete via other project rejected', () => service.deleteDocument('projB', doc.id), (e) => e instanceof ImportNotFoundError);
    await rejectsWith('isolation: confirm via other project rejected', () => service.confirmStructure('projB', doc.id), (e) => e instanceof ImportNotFoundError);
  }

  /* ==================================================================== */
  /* 3. Delete cascades to sections + extractions                         */
  /* ==================================================================== */
  {
    const { service, tables } = makeService(mod);
    const doc = await service.createDocument('projA', { rawText: '# Vol\n\n## Ch\n\nBody text here.\n' });
    await service.parseDocument('projA', doc.id);
    const sections = await service.getSections('projA', doc.id);
    // Seed an extraction record citing the first section (simulating P8 Batch 3).
    const evidenceSection = sections[0];
    await tables.extractions.add({
      id: 'ext_seed', projectId: 'projA', documentId: doc.id, kind: 'character',
      title: 'Elara', summary: '', body: '', tags: [], origin: 'fact', confidence: null,
      evidence: [{ documentId: doc.id, sectionId: evidenceSection.id, start: 0, end: Math.min(3, evidenceSection.text.length) }],
      dedupeKey: 'seed', reviewStatus: 'pending', relatedIds: [], integration: { status: 'not-applied' },
      createdAt: 1, updatedAt: 1,
    });

    await service.deleteDocument('projA', doc.id);
    eq('delete: document removed', await service.getDocument('projA', doc.id), null);
    eq('delete: sections cascade-removed', tables.sections._all().filter((s) => s.documentId === doc.id).length, 0);
    eq('delete: extraction records cascade-removed', tables.extractions._all().filter((e) => e.documentId === doc.id).length, 0);
  }

  /* ==================================================================== */
  /* 4. Parsing: idempotent, concurrent, empty, rollback, rawText, offsets */
  /* ==================================================================== */
  {
    const { service, tables } = makeService(mod);
    const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nHello there.\n' });
    const first = await service.parseDocument('projA', doc.id);
    const count1 = tables.sections._all().length;
    const second = await service.parseDocument('projA', doc.id);
    const count2 = tables.sections._all().length;
    eq('parse: re-parse is a no-op (parsed=false)', second.parsed, false);
    eq('parse: re-parse creates no duplicate sections', count2, count1);
    eq('parse: re-parse returns same section ids', second.sections.map((s) => s.id), first.sections.map((s) => s.id));

    // Concurrent parse: fire two at once; only one set of sections must exist.
    const doc2 = await service.createDocument('projA', { format: 'markdown', rawText: '# V2\n\n## C2\n\nConcurrent body.\n' });
    const [a, b] = await Promise.all([
      service.parseDocument('projA', doc2.id),
      service.parseDocument('projA', doc2.id),
    ]);
    const sections2 = tables.sections._all().filter((s) => s.documentId === doc2.id);
    even('parse: concurrent parse does not duplicate sections', sections2.length === a.sections.length && sections2.length === b.sections.length, `count=${sections2.length}`);

    // Offset invariant: rawText.slice(start,end) === text for every stored section.
    const invariantOk = tables.sections._all().every((s) => {
      const d = tables.documents._all().find((x) => x.id === s.documentId);
      return d && d.rawText.slice(s.start, s.end) === s.text;
    });
    even('parse: every stored section slice is exact vs its document rawText', invariantOk);

    // rawText immutability: no service call changed the document rawText.
    const docAfter = await service.getDocument('projA', doc.id);
    eq('parse: rawText unchanged by parse', docAfter.rawText, doc.rawText);

    // Empty document rejected at registration.
    await rejectsWith('parse: empty rawText rejected at create', () => service.createDocument('projA', { rawText: '' }), (e) => e instanceof ImportServiceError);

    // Rollback: inject a repository whose bulkCreateSections throws mid-parse.
    const rollback = makeService(mod, {
      repositoryOverride: (repo) => new Proxy(repo, {
        get(target, prop) {
          if (prop === 'bulkCreateSections') {
            return async () => { throw new Error('simulated bulk write failure'); };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });
    const rdoc = await rollback.service.createDocument('projA', { format: 'markdown', rawText: '# R\n\n## RC\n\nRollback body.\n' });
    await rejectsWith('parse: mid-parse failure rejects', () => rollback.service.parseDocument('projA', rdoc.id));
    const rdocAfter = await rollback.service.getDocument('projA', rdoc.id);
    eq('parse: rollback leaves document status imported', rdocAfter.status, 'imported');
    eq('parse: rollback leaves zero sections', rollback.tables.sections._all().filter((s) => s.documentId === rdoc.id).length, 0);
    eq('parse: rollback did not set parsedTextHash', rdocAfter.parsedTextHash ?? null, null);
  }

  /* ==================================================================== */
  /* 5. Structure edits                                                   */
  /* ==================================================================== */
  {
    const { service, tables } = makeService(mod);
    const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# Vol\n\n## Chap\n\nBody paragraph text.\n' });
    await service.parseDocument('projA', doc.id);
    let sections = await service.getSections('projA', doc.id);
    const vol = sections.find((s) => s.level === 'volume');
    const chap = sections.find((s) => s.level === 'chapter');
    const para = sections.find((s) => s.level === 'paragraph');

    // Title edit.
    const retitled = await service.updateSection('projA', chap.id, { title: 'Renamed Chapter' });
    eq('structure: title updated', retitled.title, 'Renamed Chapter');
    eq('structure: title edit did not change offsets', { s: retitled.start, e: retitled.end, t: retitled.text }, { s: chap.start, e: chap.end, t: chap.text });

    // Level edit (chapter → scene) valid: parent volume rank 0 < scene rank 2.
    const relevelled = await service.updateSection('projA', chap.id, { level: 'scene' });
    eq('structure: level updated to scene', relevelled.level, 'scene');

    // Illegal level: volume cannot be a child of a scene-chapter chain — try to
    // reparent the volume under the scene → volume(0) <= scene(2) is fine, but a
    // chapter(1) cannot parent-below a paragraph(3) etc. Force an illegal case:
    // make paragraph a parent of a chapter by setting chapter.parentId=para.
    await rejectsWith(
      'structure: illegal level (chapter under paragraph) rejected',
      () => service.updateSection('projA', chap.id, { parentId: para.id }),
      (e) => e instanceof ImportConflictError && e.reason === 'invalid-structure',
    );

    // Non-leaf title cannot be blank.
    await rejectsWith(
      'structure: blank title on non-leaf rejected',
      () => service.updateSection('projA', vol.id, { title: '   ' }),
      (e) => e instanceof ImportConflictError,
    );

    // Paragraph title may be blank.
    const blankPara = await service.updateSection('projA', para.id, { title: '' });
    eq('structure: paragraph may keep blank title', blankPara.title, '');

    // Cross-document parent rejected: create a second doc, try to parent under it.
    const doc2 = await service.createDocument('projA', { format: 'markdown', rawText: '# Other\n\n## OC\n\nOther body.\n' });
    await service.parseDocument('projA', doc2.id);
    const otherSections = await service.getSections('projA', doc2.id);
    const otherVol = otherSections.find((s) => s.level === 'volume');
    await rejectsWith(
      'structure: cross-document parentId rejected',
      () => service.updateSection('projA', para.id, { parentId: otherVol.id }),
      (e) => e instanceof ImportConflictError && e.reason === 'invalid-structure',
    );

    // Self-parent rejected.
    await rejectsWith(
      'structure: self-parent rejected',
      () => service.updateSection('projA', vol.id, { parentId: vol.id }),
      (e) => e instanceof ImportConflictError,
    );

    // Cycle rejected: reparent volume under its own descendant chapter.
    sections = await service.getSections('projA', doc.id);
    const vol2 = sections.find((s) => s.level === 'volume');
    const chap2 = sections.find((s) => s.parentId === vol2.id && s.level !== 'paragraph');
    if (chap2) {
      await rejectsWith(
        'structure: cycle (parent under descendant) rejected',
        () => service.updateSection('projA', vol2.id, { parentId: chap2.id }),
        (e) => e instanceof ImportConflictError && e.reason === 'invalid-structure',
      );
    } else {
      record('structure: cycle (parent under descendant) rejected', false, 'setup: no descendant to test with');
    }

    // Reorder: exact set required.
    sections = await service.getSections('projA', doc.id);
    const reversed = [...sections].reverse().map((s) => s.id);
    const reordered = await service.reorderSections('projA', doc.id, reversed);
    eq('structure: reorder applied (order asc = reversed input)', reordered.map((s) => s.order), sections.map((_, i) => i));
    eq('structure: reorder wrote new order in db', (await service.getSections('projA', doc.id)).map((s) => s.id), reversed);

    // Reorder with a wrong set rejected.
    await rejectsWith(
      'structure: reorder with missing ids rejected',
      () => service.reorderSections('projA', doc.id, [sections[0].id]),
      (e) => e instanceof ImportConflictError,
    );
    await rejectsWith(
      'structure: reorder with duplicate ids rejected',
      () => service.reorderSections('projA', doc.id, [sections[0].id, sections[0].id, ...sections.slice(2).map((s) => s.id)]),
      (e) => e instanceof ImportConflictError,
    );

    // Out-of-bounds offsets cannot be introduced via structure edits: no API
    // touches start/end. Assert they are unchanged after all edits and still valid.
    const finalSections = await service.getSections('projA', doc.id);
    const docNow = await service.getDocument('projA', doc.id);
    const boundsOk = finalSections.every((s) => s.start >= 0 && s.end <= docNow.rawText.length && s.end >= s.start && docNow.rawText.slice(s.start, s.end) === s.text);
    even('structure: offsets remain valid & in-bounds after edits', boundsOk);
    eq('structure: section count unchanged by structure edits', finalSections.length, sections.length);
  }

  /* ==================================================================== */
  /* 5b. Structure ordering & level-combination constraints                */
  /* ==================================================================== */
  {
    const { service } = makeService(mod);
    // Build a doc with a known tree: volume > chapter > scene > paragraph.
    const doc = await service.createDocument('projA', {
      format: 'markdown',
      rawText: '# Volume A\n\n## Chapter A1\n\n### Scene A1a\n\nParagraph one text.\n\nParagraph two text.\n\n## Chapter A2\n\n### Scene A2a\n\nAnother para here.\n',
    });
    await service.parseDocument('projA', doc.id);
    const byId = async () => new Map((await service.getSections('projA', doc.id)).map((s) => [s.id, s]));
    const find = (sections, pred) => sections.find(pred);
    let sections = await service.getSections('projA', doc.id);
    const vol = find(sections, (s) => s.level === 'volume');
    const chapters = sections.filter((s) => s.level === 'chapter');
    const scenes = sections.filter((s) => s.level === 'scene');
    const paras = sections.filter((s) => s.level === 'paragraph');
    even('order-matrix: generated levels present', Boolean(vol) && chapters.length >= 2 && scenes.length >= 2 && paras.length >= 1);

    // ---- Full valid parent-level matrix (child rank must exceed parent) ----
    // volume(0) can parent chapter(1)/scene(2)/paragraph(3); chapter(1) can
    // parent scene/paragraph; scene(2) can parent paragraph; paragraph(3) none.
    const validMatrix = [
      ['volume', 'chapter'], ['volume', 'scene'], ['volume', 'paragraph'],
      ['chapter', 'scene'], ['chapter', 'paragraph'], ['scene', 'paragraph'],
    ];
    const invalidMatrix = [
      ['chapter', 'volume'], ['scene', 'volume'], ['paragraph', 'volume'],
      ['scene', 'chapter'], ['paragraph', 'chapter'], ['paragraph', 'scene'],
      ['volume', 'volume'], ['chapter', 'chapter'], ['scene', 'scene'], ['paragraph', 'paragraph'],
    ];
    // For the matrix, reparent a CHILD section under a parent of each level,
    // setting the child's level to the proposed child level in the same call.
    // Use a fresh disposable doc per attempt to avoid mutating the shared tree.
    async function tryParentLevel(childLevel, parentLevel) {
      const d = await service.createDocument('projA', {
        format: 'markdown',
        rawText: '# V\n\n## C\n\n### S\n\nbody para text.\n',
      });
      await service.parseDocument('projA', d.id);
      const secs = await service.getSections('projA', d.id);
      const parent = secs.find((s) => s.level === parentLevel);
      const child = secs.find((s) => s.level === 'paragraph'); // moveable leaf
      // Proposed: child becomes `childLevel` under `parent`. When promoting a
      // (title-less) paragraph to a structural level, supply a valid title so the
      // test isolates the LEVEL rule from the title rule.
      const patch = { parentId: parent.id, level: childLevel };
      if (childLevel !== 'paragraph') patch.title = 'Promoted';
      const res = await service.updateSection('projA', child.id, patch)
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, reason: e && e.reason }));
      return res;
    }
    let matrixOk = true;
    const matrixMismatches = [];
    for (const [pl, cl] of validMatrix) {
      const r = await tryParentLevel(cl, pl);
      if (!r.ok) { matrixOk = false; matrixMismatches.push(`valid ${cl}<-${pl} rejected (${r.reason})`); }
    }
    for (const [pl, cl] of invalidMatrix) {
      const r = await tryParentLevel(cl, pl);
      if (r.ok) { matrixOk = false; matrixMismatches.push(`invalid ${cl}<-${pl} accepted`); }
    }
    even(
      'order-matrix: exactly the valid parent-child level combinations are accepted',
      matrixOk,
      matrixMismatches.join('; '),
    );

    // ---- Invalid level with paragraph <-> scene boundaries and cross-parent ----
    // Setting a leaf's level HIGHER than its own parent must be rejected.
    sections = await service.getSections('projA', doc.id);
    const a2 = chapters.find((c) => c.title.includes('A2'));
    const sceneUnderA2 = scenes.find((s) => s.parentId === a2.id);
    // Try to turn a scene (rank 2) under a chapter into a volume (rank 0).
    await rejectsWith(
      'order-matrix: child level below its parent rejected (scene→volume under chapter)',
      () => service.updateSection('projA', (sceneUnderA2 ?? scenes[0]).id, { level: 'volume' }),
      (e) => e instanceof ImportConflictError && e.reason === 'invalid-structure',
    );

    // ---- reorderSections must NOT change parentId or level of any section ----
    {
      // Mixed tree; capture parent/level before reorder.
      const before = await byId();
      const beforeSig = [...before.values()]
        .map((s) => `${s.id}|${s.parentId ?? 'null'}|${s.level}|${s.title}`)
        .sort();
      const ids = (await service.getSections('projA', doc.id)).map((s) => s.id);
      // A deliberately "cross-parent" interleaving: reverse the global order.
      const permuted = [...ids].reverse();
      const result = await service.reorderSections('projA', doc.id, permuted);
      const after = await byId();
      const afterSig = [...after.values()]
        .map((s) => `${s.id}|${s.parentId ?? 'null'}|${s.level}|${s.title}`)
        .sort();
      eq('reorder: parentId/level/title of every section unchanged', afterSig, beforeSig);
      eq('reorder: order becomes exactly the input index (global sequence)', result.map((s) => s.id), permuted);
      eq('reorder: every section order is 0..n-1 contiguous', result.map((s) => s.order), permuted.map((_, i) => i));
      // And listing (which sorts by order) reflects the permutation.
      eq('reorder: listSections reflects permuted order', (await service.getSections('projA', doc.id)).map((s) => s.id), permuted);
    }

    // ---- Sibling ordering is a STABLE projection of the global order ----
    {
      const list = await service.getSections('projA', doc.id);
      // For each parent, siblings must appear in ascending `order` (stable).
      const groups = new Map();
      for (const s of list) {
        const key = s.parentId ?? 'ROOT';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      let stable = true;
      for (const group of groups.values()) {
        for (let i = 1; i < group.length; i += 1) {
          if (group[i - 1].order > group[i].order) { stable = false; break; }
        }
      }
      even('order-matrix: sibling order within each parent is stable ascending', stable);
    }

    // ---- moveSection changes ONLY parentId; order & level untouched ----
    {
      const list = await service.getSections('projA', doc.id);
      const vol2 = list.find((s) => s.level === 'volume');
      const scene = list.find((s) => s.level === 'scene' && s.parentId !== vol2.id);
      const targetChapter = list.find((s) => s.level === 'chapter');
      if (scene && targetChapter) {
        const before = await byId();
        const target = targetChapter.id;
        const moved = await service.moveSection('projA', scene.id, target);
        eq('move: parentId updated to new parent', moved.parentId, target);
        eq('move: level preserved', moved.level, before.get(scene.id).level);
        eq('move: order preserved', moved.order, before.get(scene.id).order);
        // other sections' parent/level untouched
        const others = (await service.getSections('projA', doc.id)).filter((s) => s.id !== scene.id);
        const othersOk = others.every((s) => s.parentId === before.get(s.id).parentId && s.level === before.get(s.id).level);
        even('move: no other section’s parent/level changed', othersOk);
      } else {
        record('move: parentId updated to new parent', false, 'setup: missing scene/chapter');
      }
    }
  }

  /* ==================================================================== */
  /* 6. Confirmation lifecycle                                            */
  /* ==================================================================== */
  {
    const { service } = makeService(mod);
    const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nSome body text.\n' });
    await service.parseDocument('projA', doc.id);

    // Cannot confirm before parse.
    const unparsed = await service.createDocument('projA', { rawText: 'plain text only.' });
    await rejectsWith('confirm: cannot confirm before parse', () => service.confirmStructure('projA', unparsed.id), (e) => e instanceof ImportConflictError && e.reason === 'not-parsed');

    // Unconfirmed structure cannot be used as extraction input.
    await rejectsWith('confirm: unconfirmed structure blocks getConfirmedSections', () => service.getConfirmedSections('projA', doc.id), (e) => e instanceof ImportConflictError);

    // Confirm.
    const c1 = await service.confirmStructure('projA', doc.id);
    even('confirm: structureConfirmedAt set', typeof c1.structureConfirmedAt === 'number');
    const confirmedSections = await service.getConfirmedSections('projA', doc.id);
    even('confirm: getConfirmedSections works once confirmed', confirmedSections.length > 0);

    // Repeated confirm refreshes timestamp but stays confirmed.
    const c2 = await service.confirmStructure('projA', doc.id);
    even('confirm: repeated confirm stays confirmed', c2.structureConfirmedAt != null);

    // A structure edit invalidates confirmation.
    const sections = await service.getSections('projA', doc.id);
    const chap = sections.find((s) => s.level === 'chapter') ?? sections[0];
    await service.updateSection('projA', chap.id, { title: 'Edited' });
    eq('confirm: structure edit clears confirmation', await service.isStructureConfirmed('projA', doc.id), false);
    await rejectsWith('confirm: after edit, getConfirmedSections blocked again', () => service.getConfirmedSections('projA', doc.id), (e) => e instanceof ImportConflictError);

    // Reorder also clears confirmation.
    await service.confirmStructure('projA', doc.id);
    const secs = await service.getSections('projA', doc.id);
    await service.reorderSections('projA', doc.id, [...secs].reverse().map((s) => s.id));
    eq('confirm: reorder clears confirmation', await service.isStructureConfirmed('projA', doc.id), false);
  }

  /* ==================================================================== */
  /* 7. Re-parse protection                                               */
  /* ==================================================================== */
  {
    // 7a. Content unchanged → idempotent even when confirmed.
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nStable body.\n' });
      await service.parseDocument('projA', doc.id);
      await service.confirmStructure('projA', doc.id);
      const before = tables.sections._all().length;
      const r = await service.reparseDocument('projA', doc.id);
      eq('reparse: unchanged text → parsed=false', r.parsed, false);
      eq('reparse: unchanged text → no new sections', tables.sections._all().length, before);
      eq('reparse: unchanged text → confirmation preserved', await service.isStructureConfirmed('projA', doc.id), true);
    }

    // 7b. Confirmed + changed text: reparse without force refused; with force allowed.
    //     To change text we simulate by editing the stored rawText directly (the
    //     service never does, but the DB could be written by another importer).
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nOriginal body.\n' });
      await service.parseDocument('projA', doc.id);
      await service.confirmStructure('projA', doc.id);
      // Mutate rawText out-of-band to simulate "content changed".
      const row = tables.documents._all().find((d) => d.id === doc.id);
      tables.documents._map.set(doc.id, { ...row, rawText: '# V\n\n## C\n\nCHANGED body!!.\n', characterCount: '# V\n\n## C\n\nCHANGED body!!.\n'.length });

      await rejectsWith(
        'reparse: confirmed structure, changed text, no force → refused',
        () => service.reparseDocument('projA', doc.id),
        (e) => e instanceof ImportConflictError && e.reason === 'structure-confirmed',
      );

      const forced = await service.reparseDocument('projA', doc.id, { force: true });
      eq('reparse: forced re-parse succeeds (parsed=true)', forced.parsed, true);
      even('reparse: forced re-parse produced sections', forced.sections.length > 0);
      eq('reparse: forced re-parse clears confirmation', await service.isStructureConfirmed('projA', doc.id), false);
    }

    // 7c. Extraction references block re-parse ALWAYS (even with force).
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nReferenced body.\n' });
      await service.parseDocument('projA', doc.id);
      const sections = await service.getSections('projA', doc.id);
      const sec = sections[0];
      await tables.extractions.add({
        id: 'ext_ref', projectId: 'projA', documentId: doc.id, kind: 'character',
        title: 'X', summary: '', body: '', tags: [], origin: 'fact', confidence: null,
        evidence: [{ documentId: doc.id, sectionId: sec.id, start: 0, end: Math.min(2, sec.text.length) }],
        dedupeKey: 'ref', reviewStatus: 'pending', relatedIds: [], integration: { status: 'not-applied' },
        createdAt: 1, updatedAt: 1,
      });
      // Change text out-of-band.
      const row = tables.documents._all().find((d) => d.id === doc.id);
      tables.documents._map.set(doc.id, { ...row, rawText: '# V\n\n## C\n\nDIFFERENT body now.\n' });

      await rejectsWith(
        'reparse: extraction-referenced sections block reparse (no force)',
        () => service.reparseDocument('projA', doc.id),
        (e) => e instanceof ImportConflictError && e.reason === 'has-extraction-references',
      );
      await rejectsWith(
        'reparse: extraction-referenced sections block reparse (WITH force)',
        () => service.reparseDocument('projA', doc.id, { force: true }),
        (e) => e instanceof ImportConflictError && e.reason === 'has-extraction-references',
      );
    }

    // 7d. Unconfirmed + unreferenced + changed text → safe auto reparse.
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nFirst body.\n' });
      await service.parseDocument('projA', doc.id);
      const row = tables.documents._all().find((d) => d.id === doc.id);
      const newText = '# V\n\n## C\n\nSecond freshly changed body.\n';
      tables.documents._map.set(doc.id, { ...row, rawText: newText, characterCount: newText.length });

      const r = await service.reparseDocument('projA', doc.id);
      eq('reparse: unconfirmed unreferenced → reparses', r.parsed, true);
      const after = await service.getDocument('projA', doc.id);
      eq('reparse: parsedTextHash updated to new text', after.parsedTextHash, hashText(newText));
      const sections = await service.getSections('projA', doc.id);
      const ok = sections.every((s) => newText.slice(s.start, s.end) === s.text);
      even('reparse: new sections align to new rawText', ok);
    }

    // 7e. parseDocument on a changed+confirmed doc delegates to guarded reparse.
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nBase body.\n' });
      await service.parseDocument('projA', doc.id);
      await service.confirmStructure('projA', doc.id);
      const row = tables.documents._all().find((d) => d.id === doc.id);
      const newText = '# V\n\n## C\n\nChanged after confirm body.\n';
      tables.documents._map.set(doc.id, { ...row, rawText: newText, characterCount: newText.length });
      await rejectsWith(
        'reparse: parseDocument on changed+confirmed doc refuses (delegates to guard)',
        () => service.parseDocument('projA', doc.id),
        (e) => e instanceof ImportConflictError && e.reason === 'structure-confirmed',
      );
    }

    // 7f. Legacy hash (8-hex FNV) is NEVER mistaken for the current algorithm:
    //     the text is genuinely unchanged, but the stored (legacy) hash must not
    //     be treated as "equal". For an UNCONFIRMED doc this means a safe
    //     regeneration (parsed=true) that UPGRADES the stored hash to sha256:.
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nLegacy body.\n' });
      await service.parseDocument('projA', doc.id);
      const sectionsBefore = (await service.getSections('projA', doc.id)).map((s) => s.id).sort();
      // Forge a legacy 8-hex hash exactly where the current one lives (text unchanged).
      const row = tables.documents._all().find((d) => d.id === doc.id);
      tables.documents._map.set(doc.id, { ...row, parsedTextHash: 'deadbeef' });

      const r = await service.reparseDocument('projA', doc.id);
      eq('legacy-hash: unchanged text but legacy hash → NOT treated as equal (parsed=true)', r.parsed, true);
      const after = await service.getDocument('projA', doc.id);
      even('legacy-hash: stored hash upgraded to sha256: form', isCurrentHashFormat(after.parsedTextHash), after.parsedTextHash);
      eq('legacy-hash: hash now equals current digest of unchanged text', after.parsedTextHash, hashRawText(doc.rawText));
      even('legacy-hash: regeneration produced a valid section set', r.sections.length > 0 && r.sections.every((s) => doc.rawText.slice(s.start, s.end) === s.text), `before=${sectionsBefore.length} after=${r.sections.length}`);
      // Now that the hash is current, a further reparse is an idempotent no-op.
      const r2 = await service.reparseDocument('projA', doc.id);
      eq('legacy-hash: after upgrade, reparse is idempotent no-op', r2.parsed, false);
    }

    // 7g. Legacy hash on a CONFIRMED doc is treated as changed → guarded reparse
    //     (refused without force). Legacy format must never bypass the guard.
    {
      const { service, tables } = makeService(mod);
      const doc = await service.createDocument('projA', { format: 'markdown', rawText: '# V\n\n## C\n\nLegacy confirmed body.\n' });
      await service.parseDocument('projA', doc.id);
      await service.confirmStructure('projA', doc.id);
      const row = tables.documents._all().find((d) => d.id === doc.id);
      tables.documents._map.set(doc.id, { ...row, parsedTextHash: 'deadbeef' });
      await rejectsWith(
        'legacy-hash: confirmed doc with legacy hash → guarded reparse refused (no silent skip or wipe)',
        () => service.reparseDocument('projA', doc.id),
        (e) => e instanceof ImportConflictError && e.reason === 'structure-confirmed',
      );
      const after = await service.getDocument('projA', doc.id);
      eq('legacy-hash: confirmed doc untouched after refusal', after.parsedTextHash, 'deadbeef');
      eq('legacy-hash: confirmation preserved after refusal', await service.isStructureConfirmed('projA', doc.id), true);
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
  console.error('P8 Batch-2 verification crashed:', error);
  process.exit(1);
});
