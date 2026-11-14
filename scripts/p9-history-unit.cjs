/**
 * P9 Batch-2 — Version History & Diff Viewer PURE unit tests.
 *
 * No browser, no IndexedDB. Exercises the REAL `ManuscriptHistoryService`
 * against injected fake repositories, plus the real `diffWords` engine the Diff
 * Viewer renders. This proves the logic that the two new pages depend on:
 *
 *   1. Project- and manuscript-scoping of history.
 *   2. Ordering: chapters before scenes; owner outline order; versions newest
 *      revision first.
 *   3. The CURRENT draft is reported separately from the version log, and is
 *      never merged into it.
 *   4. Owner titles fall back safely when the chapter/scene is missing.
 *   5. Cross-project access is impossible by id (`getDraftHistory` returns null).
 *   6. `getComparableDraftHistories` rejects cross-manuscript / cross-project
 *      comparisons (the Diff Viewer's compatibility guard).
 *   7. `diffWords` produces the alignment the Diff Viewer renders, with the
 *      correct left(delete)/right(insert) semantics.
 *
 * The TypeScript under test is bundled with the project's own esbuild pipeline,
 * so the code exercised is exactly what ships.
 *
 * Usage: npm run verify:history
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

const ALIAS = { '@': projectPath('src') };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------- fixtures -- */

const T0 = 1_700_000_000_000;

function draftRow(over) {
  return {
    id: 'cdraft_1', kind: 'chapter', projectId: 'p1', ownerId: 'chap_1',
    content: 'Current body.', plainText: 'Current body.', wordCount: 2,
    characterCount: 13, revision: 5, createdAt: T0, updatedAt: T0, ...over,
  };
}
function versionRow(over) {
  return {
    id: 'dver_1', draftId: 'cdraft_1', projectId: 'p1', kind: 'chapter',
    revision: 1, content: 'Old body.', wordCount: 2, reason: 'auto', label: '', createdAt: T0, ...over,
  };
}

/**
 * Minimal fake repositories implementing ONLY the methods
 * `ManuscriptHistoryService` calls.
 */
function makeRepos({ chapterDrafts = [], sceneDrafts = [], versions = [], chapters = [], scenes = [] } = {}) {
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const chapterById = byId(chapters);
  const sceneById = byId(scenes);
  const cdById = byId(chapterDrafts);
  const sdById = byId(sceneDrafts);

  const manuscriptRepository = {
    async listChapterDraftsByProject(pid) {
      return chapterDrafts.filter((d) => d.projectId === pid);
    },
    async listSceneDraftsByProject(pid) {
      return sceneDrafts.filter((d) => d.projectId === pid);
    },
    async listVersionsByProject(pid) {
      // Mirror the real repo sort: draftId asc, then revision asc.
      return versions
        .filter((v) => v.projectId === pid)
        .slice()
        .sort((a, b) => (a.draftId === b.draftId ? a.revision - b.revision : a.draftId < b.draftId ? -1 : 1));
    },
    async listVersions(draftId) {
      // Mirror the real repo: newest revision first.
      return versions
        .filter((v) => v.draftId === draftId)
        .slice()
        .sort((a, b) => b.revision - a.revision || (a.createdAt !== b.createdAt ? b.createdAt - a.createdAt : (a.id < b.id ? 1 : -1)));
    },
    async getChapterDraftById(id) {
      return cdById.get(id) ?? null;
    },
    async getSceneDraftById(id) {
      return sdById.get(id) ?? null;
    },
  };

  const outlineRepository = {
    async listChaptersByProject(pid) {
      return chapters.filter((c) => c.projectId === pid);
    },
    async getChapter(id) {
      return chapterById.get(id) ?? null;
    },
  };

  const sceneRepository = {
    async listByProject(pid) {
      return scenes.filter((s) => s.projectId === pid);
    },
    async getById(id) {
      return sceneById.get(id) ?? null;
    },
  };

  return { manuscriptRepository, outlineRepository, sceneRepository };
}

/* ------------------------------------------------------------------ main -- */

(async () => {
  let mod;
  try {
    mod = await importBundled('src/services/manuscript-history-service.ts', 'p9-history', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle the manuscript history service:\n', error);
    process.exit(1);
  }
  const diff = await importBundled('src/services/ai/text-diff.ts', 'p9-diff', { alias: ALIAS });

  const { ManuscriptHistoryService } = mod;
  const { diffWords } = diff;

  try {
    /* ========================================================= */
    /* (1) Scoping & ordering                                    */
    /* ========================================================= */
    {
      const repos = makeRepos({
        chapters: [
          { id: 'chap_2', projectId: 'p1', title: 'Second Chapter', order: 1 },
          { id: 'chap_1', projectId: 'p1', title: 'First Chapter', order: 0 },
        ],
        scenes: [{ id: 'scene_1', projectId: 'p1', title: 'A Scene', order: 0 }],
        chapterDrafts: [
          { ...draftRow({ id: 'cdraft_1', ownerId: 'chap_1', revision: 3 }) },
          { ...draftRow({ id: 'cdraft_2', ownerId: 'chap_2', revision: 1 }) },
        ],
        sceneDrafts: [
          { ...draftRow({ id: 'sdraft_1', kind: 'scene', ownerId: 'scene_1', revision: 2 }) },
        ],
        versions: [
          versionRow({ id: 'v1', draftId: 'cdraft_1', revision: 1, createdAt: T0 }),
          versionRow({ id: 'v3', draftId: 'cdraft_1', revision: 3, createdAt: T0 + 2 }),
          versionRow({ id: 'v2', draftId: 'cdraft_1', revision: 2, createdAt: T0 + 1 }),
          versionRow({ id: 'sv1', draftId: 'sdraft_1', kind: 'scene', revision: 2, createdAt: T0 }),
        ],
      });
      const service = new ManuscriptHistoryService(
        repos.manuscriptRepository,
        repos.outlineRepository,
        repos.sceneRepository,
      );

      const history = await service.listProjectHistory('p1');
      eq('history: two chapter drafts + one scene draft → three entries', history.entries.length, 3);
      eq('history: chapters come before scenes', history.entries.map((e) => e.kind), ['chapter', 'chapter', 'scene']);
      eq('history: chapters follow owner outline order', history.entries.map((e) => e.ownerId), ['chap_1', 'chap_2', 'scene_1']);
      eq('history: owner titles resolved', history.entries.map((e) => e.ownerTitle), ['First Chapter', 'Second Chapter', 'A Scene']);

      const ch1 = history.entries.find((e) => e.draftId === 'cdraft_1');
      eq('history: chapter versions are newest revision first', ch1.versions.map((v) => v.revision), [3, 2, 1]);
      eq('history: current draft revision is reported', ch1.currentRevision, 3);
      eq('history: current draft content is reported', ch1.currentContent, 'Current body.');
      check(
        'history: the current draft is NOT merged into the version log',
        ch1.versions.every((v) => v.id !== 'cdraft_1'),
      );
    }

    /* ========================================================= */
    /* (2) Owner title fallback                                  */
    /* ========================================================= */
    {
      const repos = makeRepos({
        chapters: [],
        scenes: [],
        chapterDrafts: [draftRow({ id: 'cdraft_x', ownerId: 'ghost' })],
        versions: [],
      });
      const service = new ManuscriptHistoryService(
        repos.manuscriptRepository,
        repos.outlineRepository,
        repos.sceneRepository,
      );
      const history = await service.listProjectHistory('p1');
      eq('fallback: missing chapter title → placeholder', history.entries[0].ownerTitle, '(untitled chapter)');
      eq('fallback: missing owner order → null', history.entries[0].ownerOrder, null);
      eq('fallback: a draft with no versions has an empty history', history.entries[0].versions.length, 0);
    }

    /* ========================================================= */
    /* (3) Project isolation                                     */
    /* ========================================================= */
    {
      const repos = makeRepos({
        chapters: [
          { id: 'chap_1', projectId: 'p1', title: 'P1 Chapter', order: 0 },
          { id: 'chap_1b', projectId: 'p2', title: 'P2 Chapter', order: 0 },
        ],
        chapterDrafts: [
          draftRow({ id: 'cdraft_p1', projectId: 'p1', ownerId: 'chap_1' }),
          draftRow({ id: 'cdraft_p2', projectId: 'p2', ownerId: 'chap_1b' }),
        ],
        versions: [
          versionRow({ id: 'v_p1', projectId: 'p1', draftId: 'cdraft_p1' }),
          versionRow({ id: 'v_p2', projectId: 'p2', draftId: 'cdraft_p2' }),
        ],
      });
      const service = new ManuscriptHistoryService(
        repos.manuscriptRepository,
        repos.outlineRepository,
        repos.sceneRepository,
      );

      const p1 = await service.listProjectHistory('p1');
      eq('isolation: project p1 sees only its own draft', p1.entries.map((e) => e.draftId), ['cdraft_p1']);
      eq('isolation: project p1 sees only its own versions', p1.entries[0].versions.map((v) => v.id), ['v_p1']);

      // By-id access must refuse a draft that belongs to another project.
      const crossProject = await service.getDraftHistory('p1', 'cdraft_p2');
      eq('isolation: getDraftHistory refuses a foreign-project draft', crossProject, null);
      const own = await service.getDraftHistory('p1', 'cdraft_p1');
      check('isolation: getDraftHistory returns the owner’s own draft', own && own.draftId === 'cdraft_p1');
      const missing = await service.getDraftHistory('p1', 'no_such_draft');
      eq('isolation: getDraftHistory returns null for an unknown id', missing, null);
    }

    /* ========================================================= */
    /* (4) Diff compatibility guard                              */
    /* ========================================================= */
    {
      const repos = makeRepos({
        chapters: [
          { id: 'chap_1', projectId: 'p1', title: 'Chapter One', order: 0 },
          { id: 'chap_2', projectId: 'p1', title: 'Chapter Two', order: 1 },
        ],
        scenes: [{ id: 'scene_1', projectId: 'p1', title: 'Scene One', order: 0 }],
        chapterDrafts: [
          draftRow({ id: 'cdraft_1', ownerId: 'chap_1' }),
          draftRow({ id: 'cdraft_2', ownerId: 'chap_2' }),
        ],
        sceneDrafts: [draftRow({ id: 'sdraft_1', kind: 'scene', ownerId: 'scene_1' })],
        versions: [],
      });
      const service = new ManuscriptHistoryService(
        repos.manuscriptRepository,
        repos.outlineRepository,
        repos.sceneRepository,
      );

      const sameDraftPair = await service.getComparableDraftHistories('p1', 'cdraft_1', 'cdraft_1');
      eq('diff-compat: comparing a draft with itself is rejected', sameDraftPair, null);

      const crossManuscript = await service.getComparableDraftHistories('p1', 'cdraft_1', 'cdraft_2');
      eq('diff-compat: comparing two different chapters is rejected', crossManuscript, null);

      const crossKind = await service.getComparableDraftHistories('p1', 'cdraft_1', 'sdraft_1');
      eq('diff-compat: comparing a chapter with a scene is rejected', crossKind, null);

      const missingSide = await service.getComparableDraftHistories('p1', 'cdraft_1', 'nope');
      eq('diff-compat: a missing side is rejected', missingSide, null);
    }

    /* ========================================================= */
    /* (5) diffWords alignment semantics                         */
    /* ========================================================= */
    {
      const tokens = diffWords('the cat sat', 'the dog sat');
      const deletes = tokens.filter((t) => t.op === 'delete').map((t) => t.text.trim());
      const inserts = tokens.filter((t) => t.op === 'insert').map((t) => t.text.trim());
      const equals = tokens.filter((t) => t.op === 'equal').map((t) => t.text.trim());
      eq('diff: replaced word appears as a single delete', deletes, ['cat']);
      eq('diff: replaced word appears as a single insert', inserts, ['dog']);
      eq('diff: unchanged words are equal on both sides', equals, ['the', 'sat']);

      // Reconstruction: left = equal + delete, right = equal + insert.
      const left = tokens.filter((t) => t.op !== 'insert').map((t) => t.text).join('');
      const right = tokens.filter((t) => t.op !== 'delete').map((t) => t.text).join('');
      eq('diff: left side (equal+delete) reconstructs the original', left, 'the cat sat');
      eq('diff: right side (equal+insert) reconstructs the revised', right, 'the dog sat');

      const identical = diffWords('same text', 'same text');
      check('diff: identical inputs yield only equal tokens', identical.every((t) => t.op === 'equal'));

      const additions = diffWords('one two', 'one two three');
      eq('diff: appended words are inserts only', additions.filter((t) => t.op === 'insert').map((t) => t.text.trim()), ['three']);
    }

    /* ========================================================= */
    /* Summary                                                   */
    /* ========================================================= */
  } finally {
    cleanupTemp();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\nTOTAL ${results.length}  PASS ${results.length - failures.length}  FAIL ${failures.length}`);
  if (failures.length > 0) {
    console.log('Failed:');
    for (const f of failures) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exit(1);
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
