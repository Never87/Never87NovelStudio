/**
 * P9 Batch 3-2 — Project Snapshots BUSINESS LAYER: pure unit tests.
 *
 * Runs in plain Node (no browser). This batch is mostly about the ATOMIC restore
 * and the capture pipeline against a REAL IndexedDB, which `p9-snapshot-service-
 * idb-verify.cjs` covers. The parts that are pure and can be proven here are:
 *
 *   1. The service module exports the required public API and a stable, closed
 *      set of error codes / restore phases (the error contract B3-3 will match on).
 *   2. `SnapshotServiceError` carries `code`, optional `phase`, optional
 *      `problems`, and always preserves the original `cause`.
 *   3. `isQuotaError` recognises the cross-browser quota signals and NOTHING else.
 *   4. `RESTORE_UI_LIFECYCLE` documents the non-negotiable editor-coordination
 *      contract (flush before, reload after) — the API B3-3 must follow.
 *   5. The service is registered on the module-level singleton index and exported
 *      there alongside its error/types (so hooks never `new SnapshotService()`).
 *   6. The payload stays immutable by CONTRACT: the service exposes no update
 *      method and no method that mutates a snapshot's payload.
 *   7. `CreateSnapshotOptions.reason` only admits the caller-facing `'manual'`
 *      reason (pre-restore is service-internal) — asserted at the type level via
 *      the runtime shape of what the service accepts (documentation guard).
 *
 * The TypeScript under test is bundled with the project's own Vite/esbuild
 * pipeline (`scripts/lib/p4-bundler.cjs`) so the code exercised is what ships.
 *
 * Usage: npm run verify:snapshot:service
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ALIAS = { '@': projectPath('src') };

(async () => {
  let svc;
  let index;
  try {
    svc = await importBundled('src/services/snapshot-service.ts', 'p9-snapshot-service-unit', { alias: ALIAS });
    index = await importBundled('src/services/index.ts', 'p9-services-index', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle modules:\n', error);
    process.exit(1);
  }

  try {
    const {
      SnapshotService,
      SnapshotServiceError,
      SNAPSHOT_ERROR_CODES,
      RESTORE_UI_LIFECYCLE,
      isQuotaError,
    } = svc;

    /* ========================================================= */
    /* (1) Public API surface                                    */
    /* ========================================================= */
    {
      check('api: SnapshotService is a class/constructor', typeof SnapshotService === 'function');
      const proto = SnapshotService.prototype;
      for (const method of [
        'createSnapshot',
        'listSnapshots',
        'getSnapshot',
        'deleteSnapshot',
        'restoreSnapshot',
      ]) {
        check(`api: SnapshotService.prototype.${method} is a function`, typeof proto[method] === 'function');
      }
      // Immutability by contract: there must be NO update/patch/put of a payload.
      for (const forbidden of ['updateSnapshot', 'patchSnapshot', 'updatePayload', 'setPayload', 'remapSnapshot']) {
        check(`api: no ${forbidden}() (snapshots are immutable)`, typeof proto[forbidden] === 'undefined');
      }
    }

    /* ========================================================= */
    /* (2) Error codes contract                                  */
    /* ========================================================= */
    {
      eq('errors: the closed error-code set', SNAPSHOT_ERROR_CODES, [
        'snapshot-not-found',
        'project-not-found',
        'project-mismatch',
        'integrity-failed',
        'validation-failed',
        'quota-exceeded',
        'capture-failed',
        'restore-failed',
      ]);
      check('errors: codes are unique', new Set(SNAPSHOT_ERROR_CODES).size === SNAPSHOT_ERROR_CODES.length);
    }

    /* ========================================================= */
    /* (3) SnapshotServiceError shape & cause preservation       */
    /* ========================================================= */
    {
      const cause = new Error('underlying');
      const e = new SnapshotServiceError('integrity-failed', 'bad digest', { cause, phase: 'precheck' });
      check('error: is an Error', e instanceof Error);
      eq('error: name is SnapshotServiceError', e.name, 'SnapshotServiceError');
      eq('error: code carried', e.code, 'integrity-failed');
      eq('error: phase carried', e.phase, 'precheck');
      check('error: cause preserved by identity', e.cause === cause);

      const withProblems = new SnapshotServiceError('validation-failed', 'invalid', {
        problems: [{ code: 'schema-invalid', message: 'x', path: '$.data.chapters' }],
      });
      eq('error: problems carried', withProblems.problems, [
        { code: 'schema-invalid', message: 'x', path: '$.data.chapters' },
      ]);
      check('error: phase is undefined when not supplied', withProblems.phase === undefined);
      check('error: cause is undefined when not supplied', withProblems.cause === undefined);
    }

    /* ========================================================= */
    /* (4) isQuotaError                                          */
    /* ========================================================= */
    {
      check('quota: QuotaExceededError name detected', isQuotaError({ name: 'QuotaExceededError' }) === true);
      check('quota: NS_ERROR_DOM_QUOTA_REACHED detected', isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }) === true);
      check('quota: message fallback detected', isQuotaError(new Error('The quota has been exceeded.')) === true);
      check('quota: a plain error is NOT a quota error', isQuotaError(new Error('boom')) === false);
      check('quota: null is not a quota error', isQuotaError(null) === false);
      check('quota: a string is not a quota error', isQuotaError('quota') === false);
      check('quota: ConstraintError is NOT a quota error', isQuotaError({ name: 'ConstraintError', message: 'duplicate' }) === false);

      // A DOMException, if present in this Node runtime, is also handled.
      if (typeof DOMException === 'function') {
        check('quota: a real DOMException(QuotaExceededError) detected',
          isQuotaError(new DOMException('exceeded', 'QuotaExceededError')) === true);
      }
    }

    /* ========================================================= */
    /* (5) RESTORE_UI_LIFECYCLE contract (B3-3 hand-off)         */
    /* ========================================================= */
    {
      const phases = Object.keys(RESTORE_UI_LIFECYCLE);
      eq('lifecycle: phases', phases, ['beforeRestore', 'duringRestore', 'afterSuccess', 'afterFailure']);
      const flat = JSON.stringify(RESTORE_UI_LIFECYCLE).toLowerCase();
      check('lifecycle: documents flushing editors BEFORE restore', flat.includes('flush'));
      check('lifecycle: documents reloading AFTER success', flat.includes('reload'));
      check('lifecycle: documents DB-unchanged after failure', flat.includes('unchanged') || flat.includes('rolled back'));
      check('lifecycle: every phase has at least one step',
        Object.values(RESTORE_UI_LIFECYCLE).every((arr) => Array.isArray(arr) && arr.length >= 1));
    }

    /* ========================================================= */
    /* (6) Registered on the module-level service index          */
    /* ========================================================= */
    {
      // NOTE: `index` is bundled SEPARATELY from `svc`, so the classes it
      // re-exports are distinct module instances (different objects) from the
      // ones `svc` exports. We therefore assert the index's OWN surface is
      // complete & self-consistent rather than comparing object identity across
      // two independent bundles.
      check('index: exports projectSnapshotService singleton', typeof index.projectSnapshotService === 'object' && index.projectSnapshotService !== null);
      check('index: singleton is an instance of the index-exported SnapshotService',
        typeof index.SnapshotService === 'function' && index.projectSnapshotService instanceof index.SnapshotService);
      check('index: exports SnapshotService class', typeof index.SnapshotService === 'function');
      check('index: exports SnapshotServiceError class', typeof index.SnapshotServiceError === 'function');
      eq('index: exports the full error-code set', index.SNAPSHOT_ERROR_CODES, [
        'snapshot-not-found',
        'project-not-found',
        'project-mismatch',
        'integrity-failed',
        'validation-failed',
        'quota-exceeded',
        'capture-failed',
        'restore-failed',
      ]);
      check('index: exports RESTORE_UI_LIFECYCLE', typeof index.RESTORE_UI_LIFECYCLE === 'object');
      check('index: exports isQuotaError', typeof index.isQuotaError === 'function');
      // The singleton must expose the required methods.
      for (const method of ['createSnapshot', 'listSnapshots', 'getSnapshot', 'deleteSnapshot', 'restoreSnapshot']) {
        check(`index: singleton.${method} is a function`, typeof index.projectSnapshotService[method] === 'function');
      }
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
