/**
 * P9 Batch 4-3 — Backup RESTORE editor-COORDINATION pure unit tests.
 *
 * No browser, no IndexedDB. Exercises the REAL tab-local editor coordination
 * registry (`editor-registry.ts`) that lets the restore UI flush pending
 * Chapter/Scene autosave BEFORE a destructive restore and reload editors AFTER
 * it. Proves the coordination the restore page depends on:
 *
 *   1. Registration / unregistration lifecycle.
 *   2. `flushProjectEditors` flushes ONLY the requested project, awaiting all.
 *   3. The MANDATORY pre-restore flush rejects (`EditorFlushError`) if ANY editor
 *      fails — a single failure among many MUST abort, never be silently
 *      tolerated. This is the load-bearing safety invariant.
 *   4. A TOTAL flush failure is also surfaced.
 *   5. `reloadProjectEditors` reloads ONLY the requested project, tolerating a
 *      single failing reload WITHOUT throwing (a reload failure after a
 *      successful transaction must NOT be reported as a failed/rolled-back tx).
 *   6. Project isolation across projects (restore-as-new / unrelated unaffected).
 *   7. StrictMode-like remount cycles (mount→unmount→mount) never leave
 *      duplicate or stale registrations.
 *
 * The TypeScript under test is bundled with the project's own esbuild pipeline,
 * so the code exercised is exactly what ships.
 *
 * Usage: npm run verify:backup:restore:coord
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

/** A fake editor handle; each flush/reload call is recorded. */
function makeHandle(kind, projectId, ownerId, opts = {}) {
  const calls = { flush: 0, reload: 0 };
  return {
    calls,
    handle: {
      kind,
      projectId,
      ownerId,
      flush: async () => {
        calls.flush += 1;
        if (opts.flushDelay) await new Promise((r) => setTimeout(r, opts.flushDelay));
        if (opts.flushThrows) throw new Error(`flush failed for ${ownerId}`);
      },
      reload: async () => {
        calls.reload += 1;
        if (opts.reloadThrows) throw new Error(`reload failed for ${ownerId}`);
      },
    },
  };
}

(async () => {
  let mod;
  try {
    mod = await importBundled('src/modules/editor/editor-registry.ts', 'p9-editor-registry', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle the editor registry:\n', error);
    process.exit(1);
  }

  const {
    registerEditor,
    editorsForProject,
    flushProjectEditors,
    reloadProjectEditors,
    registeredEditorCount,
    EditorFlushError,
  } = mod;

  try {
    /* (1) lifecycle */
    {
      eq('registry: starts empty', registeredEditorCount(), 0);
      const a = makeHandle('chapter', 'p1', 'chap_1');
      const b = makeHandle('scene', 'p1', 'scene_1');
      const unA = registerEditor(a.handle);
      const unB = registerEditor(b.handle);
      eq('registry: two editors registered', registeredEditorCount(), 2);
      eq('registry: editorsForProject(p1) returns both', editorsForProject('p1').length, 2);
      eq('registry: editorsForProject(p2) returns none', editorsForProject('p2').length, 0);
      unA();
      eq('registry: unregistering one leaves the other', registeredEditorCount(), 1);
      unB();
      eq('registry: unregistering all empties the registry', registeredEditorCount(), 0);
    }

    /* (2) flush is project-scoped + awaits all (multiple editors, same project) */
    {
      const a1 = makeHandle('chapter', 'p1', 'chap_1', { flushDelay: 20 });
      const a2 = makeHandle('scene', 'p1', 'scene_1', { flushDelay: 5 });
      const a3 = makeHandle('chapter', 'p1', 'chap_2');
      const b1 = makeHandle('chapter', 'p2', 'chap_9');
      const unregs = [a1, a2, a3, b1].map((h) => registerEditor(h.handle));

      const flushed = await flushProjectEditors('p1');
      eq('flush: reports number flushed for p1 (3 editors)', flushed, 3);
      eq('flush: p1 chap_1 flushed once', a1.calls.flush, 1);
      eq('flush: p1 scene_1 flushed once', a2.calls.flush, 1);
      eq('flush: p1 chap_2 flushed once', a3.calls.flush, 1);
      eq('flush: UNRELATED project editor NOT flushed', b1.calls.flush, 0);
      eq('flush: flushing a project with no editors is a no-op (0)', await flushProjectEditors('p3'), 0);
      unregs.forEach((u) => u());
    }

    /* (3) MANDATORY invariant: ONE failure among many ABORTS (throws) */
    {
      const okA = makeHandle('chapter', 'p1', 'chap_1');
      const badB = makeHandle('scene', 'p1', 'scene_1', { flushThrows: true });
      const okC = makeHandle('chapter', 'p1', 'chap_2');
      const unregs = [okA, badB, okC].map((h) => registerEditor(h.handle));

      let threw = null;
      try {
        await flushProjectEditors('p1');
      } catch (error) {
        threw = error;
      }
      check('flush: a SINGLE failure among many THROWS (restore must abort)', threw !== null, threw ? String(threw) : 'did not throw');
      check('flush: the thrown error is EditorFlushError', threw instanceof EditorFlushError, threw && threw.name);
      eq('flush: EditorFlushError names exactly the failing editor', threw && threw.failures.map((f) => f.ownerId), ['scene_1']);
      // Every editor was still given a chance to flush (no short-circuit).
      eq('flush: the failing flush was attempted', badB.calls.flush, 1);
      eq('flush: a healthy editor was ALSO attempted before aborting', okA.calls.flush, 1);
      eq('flush: the other healthy editor was ALSO attempted', okC.calls.flush, 1);
      unregs.forEach((u) => u());
    }

    /* (4) total failure surfaced */
    {
      const bad1 = makeHandle('chapter', 'p1', 'chap_1', { flushThrows: true });
      const bad2 = makeHandle('scene', 'p1', 'scene_1', { flushThrows: true });
      const unregs = [registerEditor(bad1.handle), registerEditor(bad2.handle)];
      let threw = null;
      try {
        await flushProjectEditors('p1');
      } catch (error) {
        threw = error;
      }
      check('flush: a TOTAL failure IS surfaced', threw instanceof EditorFlushError, threw ? String(threw) : 'null');
      eq('flush: EditorFlushError lists both failing editors', threw && threw.failures.length, 2);
      unregs.forEach((u) => u());
    }

    /* (5) reload is project-scoped */
    {
      const a = makeHandle('chapter', 'p1', 'chap_1');
      const b = makeHandle('scene', 'p2', 'scene_1');
      const unregs = [registerEditor(a.handle), registerEditor(b.handle)];
      const reloaded = await reloadProjectEditors('p1');
      eq('reload: reports number reloaded for p1', reloaded, 1);
      eq('reload: p1 editor reloaded once', a.calls.reload, 1);
      eq('reload: OTHER project editor NOT reloaded', b.calls.reload, 0);
      unregs.forEach((u) => u());
    }

    /* (6) reload tolerates individual failure AND does NOT throw
     *     (a failed reload after a committed transaction must never look like a
     *      rolled-back/failed restore to the UI). */
    {
      const bad = makeHandle('chapter', 'p1', 'chap_1', { reloadThrows: true });
      const good = makeHandle('scene', 'p1', 'scene_1');
      const unregs = [registerEditor(bad.handle), registerEditor(good.handle)];
      const originalError = console.error;
      console.error = () => {};
      let threw = null;
      let count = 0;
      try {
        count = await reloadProjectEditors('p1');
      } catch (error) {
        threw = error;
      } finally {
        console.error = originalError;
      }
      check('reload: an individual reload failure does NOT throw', threw === null, threw ? String(threw) : '');
      eq('reload: the healthy editor still reloaded', good.calls.reload, 1);
      eq('reload: the failing editor was still attempted', bad.calls.reload, 1);
      eq('reload: reports the editors attempted', count, 2);
      unregs.forEach((u) => u());
    }

    /* (7) StrictMode-like remount cycles: no duplicate / stale registration */
    {
      eq('strictmode: registry empty at start of cycle', registeredEditorCount(), 0);
      // Simulate React StrictMode: effect runs, cleanup runs, effect runs again.
      // Each effect run creates a FRESH handle (as the hooks do); the cleanup must
      // remove exactly the one it owns.
      const first = makeHandle('chapter', 'p1', 'chap_1');
      const unFirst = registerEditor(first.handle);
      eq('strictmode: after first mount -> 1 registration', registeredEditorCount(), 1);
      unFirst(); // simulated unmount between the double-invoke
      eq('strictmode: after simulated unmount -> 0 registrations', registeredEditorCount(), 0);
      const second = makeHandle('chapter', 'p1', 'chap_1');
      const unSecond = registerEditor(second.handle);
      eq('strictmode: after second mount -> exactly 1 registration (no duplicates)', registeredEditorCount(), 1);
      eq('strictmode: editorsForProject(p1) has exactly one handle', editorsForProject('p1').length, 1);
      // Re-invoking a stale unregister must not remove the live registration
      // (distinct object identity).
      unFirst();
      eq('strictmode: a stale unregister does not remove the live one', editorsForProject('p1').length, 1);
      unSecond();
      eq('strictmode: final unmount empties the registry', registeredEditorCount(), 0);
    }

    /* (8) Project isolation: flushing one project never touches another's editors,
     *     and restoring a brand-new project (no editors) flushes/reloads nothing. */
    {
      const srcA = makeHandle('chapter', 'proj_a', 'chap_a');
      const tgtB = makeHandle('chapter', 'proj_b', 'chap_b');
      const unregs = [registerEditor(srcA.handle), registerEditor(tgtB.handle)];

      // Replace-style: flush ONLY the target (proj_b).
      await flushProjectEditors('proj_b');
      eq('isolation: replaced target flushed', tgtB.calls.flush, 1);
      eq('isolation: source/unrelated project NOT flushed', srcA.calls.flush, 0);

      // Restore-as-new: the new project id has no editors -> 0 flushed/reloaded.
      const newId = 'proj_brand_new';
      eq('isolation: restore-as-new flushes 0 editors for the fresh id', await flushProjectEditors(newId), 0);
      eq('isolation: restore-as-new reloads 0 editors for the fresh id', await reloadProjectEditors(newId), 0);
      eq('isolation: unrelated editor never reloaded by a new-project reload', srcA.calls.reload, 0);
      unregs.forEach((u) => u());
    }
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
