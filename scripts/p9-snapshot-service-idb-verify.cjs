/**
 * P9 Batch 3-2 — Project Snapshots BUSINESS LAYER: REAL IndexedDB integration.
 *
 * Drives the ACTUAL `SnapshotService` (plus the real services it composes) against
 * the browser's REAL IndexedDB, over the same headless-Chrome/CDP infrastructure
 * the P2–P9 scripts use. The in-page logic lives in
 * `scripts/lib/p9-snapshot-service-idb-page.js`; this file only launches Chrome,
 * evaluates the driver, and turns its report into PASS/FAIL lines.
 *
 * Scenarios (see the driver for detail):
 *   1. CAPTURE      — all 19 collections captured, metadata/payload/integrity
 *                     consistent, secrets & snapshots excluded, empty project,
 *                     consecutive captures, isolation, no half-record on failure.
 *   2. MANAGE       — get/delete ownership, idempotent/missing, ordering,
 *                     project isolation, project data untouched.
 *   3. RESTORE      — full 19-collection replace, extra rows deleted, ids +
 *                     references preserved, other project untouched, pre-restore
 *                     safety snapshot created, target snapshot unmodified,
 *                     P7/P8/B2 relations intact.
 *   4. ATOMIC       — a REAL mid-transaction fault is injected; the Dexie
 *                     transaction must roll the WHOLE restore back (pre-restore
 *                     state intact, snapshots kept), then a normal restore
 *                     still succeeds.
 *   5. PRECHECK     — integrity tamper / project mismatch / not-found are
 *                     rejected BEFORE any write.
 *   6. SAFETY       — project-not-found and a failed safety snapshot both abort
 *                     with the project untouched; a later restore still works.
 *
 * Usage: npm run verify:snapshot:service:idb   (start the dev server on :5177
 * first, e.g. `npm run dev -- --port 5177 --strictPort`)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9399;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      })
      .on('error', reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      let detail = '';
      try {
        const ref = d.exception?.objectId;
        if (ref) {
          const props = await this.send('Runtime.getProperties', { objectId: ref, ownProperties: true });
          const pick = (name) => {
            const p = (props.result ?? []).find((x) => x.name === name);
            return p ? p.value : undefined;
          };
          const message = pick('message');
          if (message !== undefined) detail = '\n    msg=' + JSON.stringify(message);
        }
      } catch { /* best effort */ }
      throw new Error(`Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}${detail}`);
    }
    return result.result.value;
  }
}

let activeWs = null;
let activeChrome = null;
let activeProfileDir = null;
let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  try { activeWs?.close(); } catch { /* closed */ }
  try { activeChrome?.kill(); } catch { /* gone */ }
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

const DB_NAME = `p9-snap-svc-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-snap-svc-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket never opened within 10s.')), 10_000);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    ws.addEventListener('open', settle(resolve), { once: true });
    ws.addEventListener('error', settle(reject), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(`(() => { window.__P9SNAP_DB_NAME = ${JSON.stringify(DB_NAME)}; return true; })()`);

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-snapshot-service-idb-page.js'), 'utf8');
  const out = await cdp.eval(`(${driver})()`);

  /* -------------------------------- CAPTURE -------------------------------- */
  const cap = out?.capture ?? {};
  record('capture: all 19 collections captured (payload == DB count)', cap.completeAllNineteen === true, JSON.stringify(cap.payloadCounts));
  record('capture: a fully-seeded project populates EVERY collection', cap.everyCollectionPopulated === true, JSON.stringify(cap.payloadCounts));
  record('capture: metadata matches the payload exactly', cap.metadataConsistent === true, String(cap.metadataConsistent));
  record('capture: integrity digest recomputes to the stored digest', cap.integrityOk === true, String(cap.integrityOk));
  record('capture: wordCount matches the captured drafts', cap.wordCountMatches === true, String(cap.wordCountMatches));
  record('capture: no API key / provider credential leaks into the snapshot', cap.secretsExcluded === true, JSON.stringify(cap.leaked));
  record('capture: the snapshot payload does NOT nest snapshots', cap.snapshotNotNested === true, String(cap.snapshotNotNested));
  record('capture: an (almost) empty project captures with [] for other collections', cap.emptyCaptureOk === true, JSON.stringify(cap.emptyCounts));
  record('capture: consecutive captures of one project are distinct rows', cap.consecutiveOk === true, String(cap.consecutiveOk));
  record('capture: listing is strictly project-scoped', cap.isolationOk === true, String(cap.isolationOk));
  record('capture: capturing a missing project -> project-not-found', cap.missingProjectCode === 'project-not-found', String(cap.missingProjectCode));
  record('capture: a failed capture leaves NO half-record', cap.noHalfRecord === true, String(cap.noHalfRecord));

  /* -------------------------------- MANAGE --------------------------------- */
  const man = out?.manage ?? {};
  record('manage: getSnapshot on own project works', man.getOwnOk === true, String(man.getOwnOk));
  record('manage: getSnapshot with wrong project -> project-mismatch', man.getWrongCode === 'project-mismatch', String(man.getWrongCode));
  record('manage: getSnapshot missing -> snapshot-not-found', man.getMissingCode === 'snapshot-not-found', String(man.getMissingCode));
  record('manage: delete with wrong project -> project-mismatch', man.delWrongCode === 'project-mismatch', String(man.delWrongCode));
  record('manage: snapshot survives a wrong-project delete attempt', man.survivesWrongDelete === true, String(man.survivesWrongDelete));
  record('manage: delete missing -> snapshot-not-found', man.delMissingCode === 'snapshot-not-found', String(man.delMissingCode));
  record('manage: delete removes exactly the target snapshot', man.deleteRemovedOne === true, String(man.deleteRemovedOne));
  record('manage: deleting a snapshot never touches project data', man.projectDataUntouched === true, String(man.projectDataUntouched));
  record('manage: deleting a snapshot never touches another project\'s snapshots', man.otherProjectSnapshotUntouched === true, String(man.otherProjectSnapshotUntouched));
  record('manage: listing is newest-first regardless of insertion', man.orderedDesc === true, JSON.stringify(man.orderedCreatedAts));

  /* -------------------------------- RESTORE -------------------------------- */
  const rs = out?.restore ?? {};
  record('restore: all 19 collections end with the snapshot counts', rs.countsMatchAll === true, JSON.stringify(rs.afterCounts));
  record('restore: id sets match the snapshot exactly (extra rows deleted)', rs.idsMatchSnapshot === true, String(rs.idsMatchSnapshot));
  record('restore: an edited draft is reverted to the snapshot content', rs.contentReverted === true, String(rs.contentReverted));
  record('restore: the root project is restored (id + createdAt preserved)', rs.rootOk === true, String(rs.rootOk));
  record('restore: another project is byte-for-byte untouched', rs.otherProjectUntouched === true, String(rs.otherProjectUntouched));
  record('restore: the target snapshot is NOT modified', rs.snapshotUnmodified === true, String(rs.snapshotUnmodified));
  record('restore: a pre-restore safety snapshot is captured', rs.safetySnapshotCreated === true, String(rs.safetySnapshotCreated));
  record('restore: the safety snapshot reflects the pre-restore (mutated) state', rs.safetyMatchesMutated === true, JSON.stringify({ mut: rs.mutatedChapterCount, snap: rs.snapshotChapterCount }));
  record('restore: the result reports snapshot + safety + project', rs.resultOk === true, String(rs.resultOk));
  record('restore: extra chapter/character added after the snapshot are gone', rs.extraChapterGone === true && rs.extraCharGone === true, JSON.stringify({ ch: rs.extraChapterGone, chr: rs.extraCharGone }));
  record('restore: a scene deleted after the snapshot is re-created', rs.sceneRestored === true, String(rs.sceneRestored));
  record('restore: P8 extraction evidence still resolves after restore', rs.extractionEvidenceOk === true, String(rs.extractionEvidenceOk));
  record('restore: B2 draftVersion references still resolve after restore', rs.draftVersionRefsOk === true, String(rs.draftVersionRefsOk));
  record('restore: P7 knowledge source locators still resolve after restore', rs.knowledgeSourceOk === true, String(rs.knowledgeSourceOk));

  /* -------------------------------- ATOMIC --------------------------------- */
  const at = out?.atomic ?? {};
  const atErr = at.restoreError ?? {};
  record('atomic: mid-transaction fault raised restore-failed @ transaction', atErr.code === 'restore-failed' && atErr.phase === 'transaction', JSON.stringify(atErr));
  record('atomic: the injected failure was reached AFTER partial writes (meaningful)', (at.chaptersWrittenBeforePoison ?? 0) > 0, String(at.chaptersWrittenBeforePoison));
  record('atomic: the WHOLE restore rolled back (pre-restore state intact)', at.fullyRolledBack === true, String(at.fullyRolledBack));
  record('atomic: the target snapshot survives the rollback', at.targetSnapshotIntact === true, String(at.targetSnapshotIntact));
  record('atomic: the pre-restore safety snapshot survives the rollback', at.safetySnapshotExists === true, String(at.safetySnapshotExists));
  record('atomic: a normal restore still succeeds afterwards', at.followUpOk === true, String(at.followUpError || ''));
  record('atomic: that follow-up restore fully applies the snapshot', at.followUpMatches === true, JSON.stringify(at.afterFollowUp));

  /* -------------------------------- PRECHECK ------------------------------- */
  const pc = out?.precheck ?? {};
  // A tampered snapshot is caught at precheck. Two layers can reject it first:
  //  - `validation-failed` (the transfer validator recomputes the digest and
  //    raises `integrity-mismatch`), or
  //  - `integrity-failed` (the service's own recompute, reached if validation
  //    passes for some reason).
  // Both are legitimate integrity rejections; the load-bearing guarantees are
  // the phase (`precheck`) and that NOTHING was written.
  const tamperRejectedOnIntegrity =
    pc.tamperPhase === 'precheck' &&
    (pc.tamperCode === 'integrity-failed' || pc.tamperCode === 'validation-failed');
  record('precheck: a tampered integrity digest -> rejected on integrity @ precheck', tamperRejectedOnIntegrity, JSON.stringify({ code: pc.tamperCode, phase: pc.tamperPhase }));
  record('precheck: a rejected restore writes NOTHING', pc.tamperNoWrite === true, String(pc.tamperNoWrite));
  record('precheck: wrong project -> project-mismatch', pc.mismatchCode === 'project-mismatch', String(pc.mismatchCode));
  record('precheck: missing snapshot -> snapshot-not-found', pc.notFoundCode === 'snapshot-not-found', String(pc.notFoundCode));

  /* -------------------------------- SAFETY --------------------------------- */
  const sf = out?.safety ?? {};
  record('safety: restoring when the project row is gone -> project-not-found', sf.pnfCode === 'project-not-found' && sf.pnfPhase === 'precheck', JSON.stringify({ code: sf.pnfCode, phase: sf.pnfPhase }));
  record('safety: a failed safety snapshot aborts @ safety-snapshot (capture-failed)', sf.safetyAborted === true, JSON.stringify({ code: sf.safetyCode, phase: sf.safetyPhase }));
  record('safety: the abort preserves the original cause', sf.safetyCauseOk === true, String(sf.safetyCauseOk));
  record('safety: a safety-snapshot failure leaves the project untouched', sf.projectUntouchedAfterSafetyFailure === true, String(sf.projectUntouchedAfterSafetyFailure));
  record('safety: a safety-snapshot failure does not add or drop snapshots', sf.snapshotListUnchangedBySafetyFailure === true, String(sf.snapshotListUnchangedBySafetyFailure));
  record('safety: the target snapshot survives a safety-snapshot failure', sf.targetSnapshotStillPresent === true, String(sf.targetSnapshotStillPresent));
  record('safety: a later restore still succeeds', sf.recoveryOk === true, String(sf.recoveryOk));

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  teardown();

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ SUMMARY ================');
  console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
    process.exitCode = 1;
  }
}

main()
  .then(() => { teardown(); process.exit(process.exitCode || 0); })
  .catch((error) => { console.error('HARNESS ERROR:', error); teardown(); process.exit(1); });
