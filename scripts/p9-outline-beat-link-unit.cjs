/**
 * Outline ↔ PlotBeat two-way link — PURE logic tests.
 *
 * Exercises the REAL `OutlineService` (bundled from source) against in-memory
 * fake repositories, verifying the reverse half of the chapter↔beat link:
 *
 *   - `getBeatChapterLinks` derives beat→chapters from `Chapter.plotBeatId`
 *     (single source of truth), grouping correctly and ignoring unlinked rows.
 *   - `unlinkRemovedBeats` clears ONLY the dangling `plotBeatId` (leaving every
 *     other field intact), is idempotent, and is a no-op for an empty/absent set.
 *   - Reverse editing (assign/unassign) goes through `updateChapter`, so the
 *     same write path & validation apply; a chapter never ends up pointing at a
 *     removed beat.
 *
 * Usage: npm run verify:outline:beatlink
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

const T0 = 1_700_000_000_000;

/** Chapters keyed by id, mutable backing store. */
function makeChapter(id, overrides = {}) {
  return {
    id,
    volumeId: 'vol_1',
    projectId: 'proj_1',
    title: `Chapter ${id}`,
    order: 0,
    summary: 'Summary kept verbatim.',
    goal: '',
    keyEvents: '',
    endingHook: '',
    status: 'planned',
    characterIds: [],
    tags: ['keep'],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/**
 * A fake OutlineRepository exposing exactly the methods the service touches for
 * the reverse-link paths. Chapters are stored by reference-copy; putChapters
 * replaces by id.
 */
function makeRepo(chapters) {
  const byId = new Map(chapters.map((c) => [c.id, { ...c }]));
  return {
    _byId: byId,
    async listChaptersByProject(projectId) {
      return [...byId.values()].filter((c) => c.projectId === projectId);
    },
    async listChaptersByVolume(volumeId) {
      return [...byId.values()].filter((c) => c.volumeId === volumeId).sort((a, b) => a.order - b.order);
    },
    async getChapter(id) {
      return byId.get(id) ?? null;
    },
    async putChapters(rows) {
      for (const row of rows) byId.set(row.id, { ...row });
    },
    async updateChapter(row) {
      byId.set(row.id, { ...row });
      return { ...row };
    },
    // Unused here but present so the service's constructor wiring is satisfied.
    async listVolumes() { return []; },
    async getVolume() { return null; },
    async deleteChaptersByProjectId() {},
    async deleteVolumesByProjectId() {},
    async deleteChaptersByVolume() {},
    async deleteChapter() {},
    async deleteVolume() {},
    async putVolumes() {},
  };
}

function makeService(repo) {
  const narrativeRepo = {
    async getByProjectId() {
      return {
        id: 'narr_1',
        projectId: 'proj_1',
        beats: [
          { id: 'beat_1', title: 'A', description: '', position: 10 },
          { id: 'beat_2', title: 'B', description: '', position: 50 },
        ],
      };
    },
  };
  const sceneRepo = {};
  const manuscript = {};
  return new Imported.OutlineService(repo, narrativeRepo, sceneRepo, manuscript);
}

let Imported;
(async () => {
  try {
    Imported = await importBundled('src/services/outline-service.ts', 'p9-outline-beatlink', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle OutlineService:\n', error);
    process.exit(1);
  }

  try {
    /* =================================================================== */
    /* getBeatChapterLinks — derived reverse grouping                      */
    /* =================================================================== */
    {
      const chapters = [
        makeChapter('c1', { plotBeatId: 'beat_1' }),
        makeChapter('c2', { plotBeatId: 'beat_1' }),
        makeChapter('c3', { plotBeatId: 'beat_2' }),
        makeChapter('c4'), // unlinked
      ];
      const repo = makeRepo(chapters);
      const service = makeService(repo);
      const links = await service.getBeatChapterLinks('proj_1');

      eq('links: beat_1 has two chapters', (links.get('beat_1') ?? []).map((c) => c.id).sort(), ['c1', 'c2']);
      eq('links: beat_2 has one chapter', (links.get('beat_2') ?? []).map((c) => c.id), ['c3']);
      eq('links: unlinked chapter appears under no beat', links.has('beat_3'), false);
      eq('links: total linked chapters is three', [...links.values()].reduce((n, arr) => n + arr.length, 0), 3);
    }

    /* =================================================================== */
    /* unlinkRemovedBeats — targeted, integrity-preserving cleanup         */
    /* =================================================================== */
    {
      const chapters = [
        makeChapter('c1', { plotBeatId: 'beat_1', title: 'Keep title', summary: 'Keep summary', tags: ['keep'], goal: 'goal!' }),
        makeChapter('c2', { plotBeatId: 'beat_2' }),
        makeChapter('c3', { plotBeatId: 'beat_1' }),
        makeChapter('c4'), // never linked
      ];
      const repo = makeRepo(chapters);
      const service = makeService(repo);

      const unlinked = await service.unlinkRemovedBeats('proj_1', ['beat_1']);
      eq('unlink: reports two chapters unlinked', unlinked, 2);

      const c1 = await service.getChapter('c1');
      eq('unlink: c1 plotBeatId cleared', c1.plotBeatId, undefined);
      eq('unlink: c1 title preserved', c1.title, 'Keep title');
      eq('unlink: c1 summary preserved', c1.summary, 'Keep summary');
      eq('unlink: c1 tags preserved', c1.tags, ['keep']);
      eq('unlink: c1 goal preserved', c1.goal, 'goal!');

      const c3 = await service.getChapter('c3');
      eq('unlink: c3 plotBeatId cleared', c3.plotBeatId, undefined);

      const c2 = await service.getChapter('c2');
      eq('unlink: c2 (different beat) untouched', c2.plotBeatId, 'beat_2');

      // Idempotent: re-running with the same set unlinks nothing new.
      const again = await service.unlinkRemovedBeats('proj_1', ['beat_1']);
      eq('unlink: idempotent second run unlinks zero', again, 0);

      // Empty set is a no-op.
      const empty = await service.unlinkRemovedBeats('proj_1', []);
      eq('unlink: empty set unlinks zero', empty, 0);
    }

    /* =================================================================== */
    /* Reverse edit via updateChapter keeps the single source of truth     */
    /* =================================================================== */
    {
      const chapters = [makeChapter('c1')];
      const repo = makeRepo(chapters);
      const service = makeService(repo);

      // Assign to a beat that exists in the plan.
      const assigned = await service.updateChapter('c1', { plotBeatId: 'beat_2' });
      eq('assign: chapter now points at beat_2', assigned.plotBeatId, 'beat_2');

      // The reverse view reflects it.
      let links = await service.getBeatChapterLinks('proj_1');
      eq('assign: reverse view groups c1 under beat_2', (links.get('beat_2') ?? []).map((c) => c.id), ['c1']);

      // Unassign clears it.
      const cleared = await service.updateChapter('c1', { plotBeatId: null });
      eq('unassign: plotBeatId cleared', cleared.plotBeatId, undefined);
      links = await service.getBeatChapterLinks('proj_1');
      eq('unassign: reverse view no longer lists c1', [...links.values()].flat().some((c) => c.id === 'c1'), false);

      // Assigning to a NON-existent beat is rejected (validation holds).
      let err = null;
      try {
        await service.updateChapter('c1', { plotBeatId: 'beat_does_not_exist' });
      } catch (e) {
        err = e;
      }
      check('assign: unknown beat is rejected', err instanceof Error && /beat_does_not_exist/.test(err.message));
    }

    /* =================================================================== */
    /* Removal + cleanup leaves no dangling references                     */
    /* =================================================================== */
    {
      const chapters = [
        makeChapter('c1', { plotBeatId: 'beat_1' }),
        makeChapter('c2', { plotBeatId: 'beat_2' }),
      ];
      const repo = makeRepo(chapters);
      const service = makeService(repo);

      // Simulate a plan edit that removes beat_1 only.
      await service.unlinkRemovedBeats('proj_1', ['beat_1']);

      const links = await service.getBeatChapterLinks('proj_1');
      eq('dangling: no chapter remains under the removed beat', links.has('beat_1'), false);
      eq('dangling: the surviving beat keeps its chapter', (links.get('beat_2') ?? []).map((c) => c.id), ['c2']);
    }
  } finally {
    cleanupTemp();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exit(1);
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
