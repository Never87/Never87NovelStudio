/**
 * P9 Batch 3-3 — Project Snapshots UI: pure logic / wiring tests.
 *
 * Runs in plain Node (no browser). The interactive behaviour (clicking,
 * dialogs, real restore) is proven by `p9-snapshots-ui-verify.cjs` against a
 * REAL browser + REAL IndexedDB. This file proves the parts that are static and
 * declarative, so a regression in wiring is caught fast without a browser:
 *
 *   1. Navigation: the `snapshots` item exists in the Version & Data group with
 *      the canonical path the router registers (/data/snapshots), and its copy
 *      describes a full-project restore (not an undo).
 *   2. Routing: `routes/index.tsx` declares the real page, adds `snapshots` to
 *      REAL_PAGE_NAV_IDS, and registers the `/data/snapshots` route element.
 *   3. Service reuse: the page calls ONLY the B3-2 SnapshotService methods and
 *      never re-implements capture/serialise/integrity/restore (no direct db /
 *      transfer / remap usage, no `restoreSnapshot`-by-hands writes).
 *   4. Restore contract copy: the Restore dialog states the non-negotiable
 *      guarantees (whole-project replace, not undo; post-snapshot data may be
 *      deleted; automatic pre-restore safety snapshot; rollback on failure;
 *      credentials not restored) and uses a destructive confirm.
 *   5. Details dialog derives its collection table from TRANSFER_COLLECTIONS
 *      (never a hardcoded list) and shows the full integrity digest (copyable).
 *   6. The page reloads state after create/delete/restore and broadcasts the
 *      PROJECT_RESTORED_EVENT, and never claims a cross-tab lock.
 *
 * "Source assertions" read the shipped .tsx/.ts text: they are stable contract
 * checks (the guarantees live in the copy/markup), not brittle snapshot tests.
 *
 * Usage: npm run verify:snapshots:logic
 */
const fs = require('node:fs');
const { projectPath } = require('./lib/p4-bundler.cjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function read(rel) {
  return fs.readFileSync(projectPath(rel), 'utf8');
}

(async () => {
  let nav;
  try {
    // Navigation is pure data — import it directly (it has no React/runtime deps
    // beyond icon components, which the bundler resolves).
    const { importBundled, cleanupTemp } = require('./lib/p4-bundler.cjs');
    nav = await importBundled('src/config/navigation.ts', 'p9-b3-3-nav', {
      alias: { '@': projectPath('src') },
    });
    cleanupTemp();
  } catch (error) {
    console.error('Failed to bundle navigation:\n', error);
    process.exit(1);
  }

  const pageSrc = read('src/modules/data/ProjectSnapshotsPage.tsx');
  const restoreSrc = read('src/modules/data/snapshots/RestoreSnapshotDialog.tsx');
  const detailsSrc = read('src/modules/data/snapshots/SnapshotDetailsDialog.tsx');
  const routesSrc = read('src/routes/index.tsx');

  // Comment-stripped source for PRESENCE/ABSENCE checks that must look only at
  // real code/copy — not at explanatory doc comments (e.g. "NOT a cross-tab lock").
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const pageCode = stripComments(pageSrc);

  /* ========================================================= */
  /* (1) Navigation item                                       */
  /* ========================================================= */
  {
    const item = nav.NAV_ITEMS_BY_ID['snapshots'];
    check('nav: a "snapshots" item exists', Boolean(item));
    eq('nav: label', item.label, 'Project Snapshots');
    eq('nav: canonical path', item.path, '/data/snapshots');
    const group = nav.findGroupByItemId('snapshots');
    eq('nav: lives in the Version & Data group', group && group.id, 'version-data');
    const desc = `${nav.NAV_ITEMS_BY_ID['snapshots'].description} ${nav.NAV_ITEMS_BY_ID['snapshots'].emptyDescription}`.toLowerCase();
    check('nav: copy mentions whole-project capture/restore', /capture/.test(desc) && /restore/.test(desc));
  }

  /* ========================================================= */
  /* (2) Router wiring                                         */
  /* ========================================================= */
  {
    check(
      'routes: imports the ProjectSnapshotsPage module',
      /modules\/data\/ProjectSnapshotsPage/.test(routesSrc),
    );
    check(
      'routes: adds "snapshots" to REAL_PAGE_NAV_IDS',
      /REAL_PAGE_NAV_IDS = new Set\(\[[\s\S]*'snapshots'[\s\S]*\]\)/.test(routesSrc),
    );
    check(
      'routes: registers the /data/snapshots route element',
      /path:\s*'data\/snapshots'[\s\S]*?<ProjectSnapshotsPage\s*\/>/.test(routesSrc),
    );
    check(
      'routes: snapshots is NOT rendered as a placeholder (no createModulePage for it)',
      !/createModulePage\(\s*['"]snapshots['"]\s*\)/.test(routesSrc),
    );
  }

  /* ========================================================= */
  /* (3) Service reuse (no re-implementation / no direct writes) */
  /* ========================================================= */
  {
    check(
      'service: uses projectSnapshotService.createSnapshot',
      /projectSnapshotService\.createSnapshot\(/.test(pageSrc),
    );
    check('service: uses projectSnapshotService.listSnapshots', /projectSnapshotService\.listSnapshots\(/.test(pageSrc));
    check(
      'service: uses projectSnapshotService.deleteSnapshot (with project id)',
      /projectSnapshotService\.deleteSnapshot\([^)]*effectiveProjectId/.test(pageSrc),
    );
    check(
      'service: uses projectSnapshotService.restoreSnapshot(id, projectId)',
      /projectSnapshotService\.restoreSnapshot\(\s*target\.id,\s*effectiveProjectId/.test(pageSrc),
    );
    // Must NOT reach under the service to re-implement the pipeline.
    for (const forbidden of [
      /\bcomputeIntegrity\b/,
      /\bcanonicalStringify\b/,
      /\bremapProject\b/,
      /\bvalidateTransferPackage\b/,
      /from ['"]@\/db/,
      /\.transaction\(/,
      /db\.\w+\.(bulkPut|put|delete|add|where)\b/,
    ]) {
      check(`service: page does NOT use ${forbidden}`, !forbidden.test(pageSrc));
    }
  }

  /* ========================================================= */
  /* (4) Restore dialog contract copy & destructive confirm    */
  /* ========================================================= */
  {
    check('restore: dialog states it is a full-project restore', /Full project restore, not an undo/i.test(restoreSrc));
    check(
      'restore: warns post-snapshot data may be deleted',
      /added or changed <strong[^>]*>after<\/strong> this snapshot may be\s+deleted|after<\/strong> this snapshot may be deleted/i.test(
        restoreSrc.replace(/\s+/g, ' '),
      ) || /may be\s+deleted/.test(restoreSrc),
    );
    check('restore: states a pre-restore safety snapshot is created automatically', /pre-restore safety snapshot/i.test(restoreSrc));
    check('restore: states rollback leaves the project intact on failure', /rolled back and the current project is left intact/i.test(restoreSrc.replace(/\s+/g, ' ')));
    check('restore: states credentials are not touched', /API keys and provider credentials are not part/i.test(restoreSrc));
    check('restore: shows the target snapshot identity (id + project)', /Snapshot ID:/.test(restoreSrc) && /Project:/.test(restoreSrc));
    check('restore: confirm button is danger-styled', /variant="danger"/.test(restoreSrc));
    check('restore: uses a two-step acknowledgement', /acknowledged/.test(restoreSrc) && /I understand, continue/.test(restoreSrc));
    check('restore: does NOT claim it can undo via the page', !/this can be undone/i.test(restoreSrc) || /except by restoring/i.test(restoreSrc));
    // The UI must not fabricate a second safety snapshot itself.
    check('restore: dialog does not itself call createSnapshot (service owns safety)', !/createSnapshot\(/.test(restoreSrc));
  }

  /* ========================================================= */
  /* (5) Details dialog derived from TRANSFER_COLLECTIONS      */
  /* ========================================================= */
  {
    check('details: imports TRANSFER_COLLECTIONS from the registry', /import\s*\{[^}]*TRANSFER_COLLECTIONS[^}]*\}\s*from\s*'@\/transfer\/collection-registry'/.test(detailsSrc));
    check('details: renders the collection table by mapping TRANSFER_COLLECTIONS', /TRANSFER_COLLECTIONS\.map\(/.test(detailsSrc));
    check('details: shows the FULL snapshot id', /snapshot\.id/.test(detailsSrc));
    check('details: shows schemaVersion & formatVersion', /schemaVersion/.test(detailsSrc) && /formatVersion/.test(detailsSrc));
    check('details: shows the integrity digest with a copy control', /snapshot\.integrity\.digest/.test(detailsSrc) && /Copy/.test(detailsSrc));
    check('details: does NOT dump raw payload JSON', !/snapshot\.payload/.test(detailsSrc) && !/JSON\.stringify\(snapshot/.test(detailsSrc));
  }

  /* ========================================================= */
  /* (6) Post-restore reload + no false cross-tab claim        */
  /* ========================================================= */
  {
    check('page: reloads snapshots after create', /await projectSnapshotService\.createSnapshot[\s\S]*?await load\(\)/.test(pageSrc));
    check('page: reloads snapshots after delete', /deleteSnapshot\([\s\S]*?await load\(\)/.test(pageSrc));
    check(
      'page: reloads snapshots + project list after restore',
      /restoreSnapshot\([\s\S]*?await Promise\.all\(\[load\(\), refreshProjects\(\)\]\)/.test(pageSrc),
    );
    check('page: broadcasts PROJECT_RESTORED_EVENT after restore', /PROJECT_RESTORED_EVENT/.test(pageSrc) && /window\.dispatchEvent/.test(pageSrc));
    check(
      'page: tells the user other tabs must reload (no false lock claim)',
      /other browser tab[\s\S]*?reload/i.test(pageSrc) && /do not coordinate live tabs/i.test(pageSrc),
    );
    check('page: does NOT claim a cross-tab lock was implemented', !/cross-tab lock|acquired the lock|lock acquired/i.test(pageCode));
    // Delete must be guarded by a confirmation.
    check('page: delete goes through a confirmation dialog', /DeleteSnapshotDialog/.test(pageSrc));
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exit(1);
  }
})().catch((error) => {
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
