/**
 * P8 Batch-5 — REAL Dexie/IndexedDB integration for IntegrationService.
 *
 * Unlike `p8-integration-verify.cjs` (pure Node, in-memory fake tables) this
 * drives the ACTUAL `IntegrationService` (plus the shared Import / Extraction /
 * Review services used to seed CONFIRMED records) against the REAL Dexie
 * database and the browser's REAL IndexedDB, over the same headless-Chrome/CDP
 * infrastructure the P2–P8 UI scripts use. Independent service instances are
 * created over one shared connection (as several components/hooks would be), so
 * cross-instance races run for real.
 *
 * The in-page driver lives in `scripts/lib/p8-integration-idb-page.js`; this
 * harness reads its source and evaluates it inside the tab so its `/src/…`
 * imports resolve against the live dev server. Guarantees verified (all at the
 * DB level, no fake):
 *   1.  Preview is read-only (writes nothing).
 *   2.  Apply persists the entity + audit stamp together.
 *   3.  Apply is one-shot (second Apply refused already-applied).
 *   4.  Concurrent Apply of the SAME preview → one write.
 *   5.  Concurrent Apply with DIFFERENT previews → one write.
 *   6.  Two records → same Character concurrently → no duplicate row.
 *   7.  World sections appended concurrently → no lost write.
 *   8.  Duplicate KnowledgeEntry integration → one entry.
 *   9.  stale-preview refused; no write.
 *   10. Evidence failure refused; no entity, no stamp.
 *   11. Field strategies: keep-existing / use-extracted / unsupported-field.
 *   12. Mid-write failure → entity + audit + stamp all roll back.
 *   13. Project isolation.
 *   14. Raw-text immutability.
 *
 * Usage: npm run verify:integration:idb   (needs dev server on http://localhost:5177/)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9375;
const DB_NAME = `p8b5-idb-${Date.now()}`;

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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`Page exception: ${d.exception?.description || d.text || JSON.stringify(d)}`);
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

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8b5-idb-chrome-'));
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

  // Load the real app so the dev server + module graph are live.
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);

  // Read the in-page driver, inject the DB name, and run it inside the tab.
  const driverSource = fs.readFileSync(path.join(__dirname, 'lib', 'p8-integration-idb-page.js'), 'utf8');
  const evaluate = `(async () => {\n  window.__P8B5_DB_NAME = ${JSON.stringify(DB_NAME)};\n  return (${driverSource})();\n})()`;

  let out;
  try {
    out = await cdp.eval(evaluate);
  } catch (error) {
    console.error('HARNESS ERROR: in-page driver threw:', error.message);
    try {
      out = await cdp.eval(`(async () => {
        const Dexie = (await import('/src/db/index.ts')).NovelStudioDb;
        await Object.getPrototypeOf(Dexie).delete(${JSON.stringify(DB_NAME)});
        return null;
      })()`);
    } catch { /* ignore */ }
    teardown();
    process.exit(1);
  }

  /* ------------------------------ Assertions ------------------------------ */
  const pv = (out && out.preview) || {};
  record('preview: writes NOTHING to any table', pv.writesNothing === true, String(pv.writesNothing));
  record('preview: returns a deterministic prv_ fingerprint', pv.hasFingerprint === true, String(pv.hasFingerprint));
  record('preview: routes a character record to a character target', pv.targetType === 'character', pv.targetType);
  record('preview: reports expectedAction=create when no match', pv.expectedAction === 'create', pv.expectedAction);
  record('preview: reports valid evidence', pv.evidenceValid === true, String(pv.evidenceValid));
  record('preview: not already integrated', pv.notIntegrated === true, String(pv.notIntegrated));

  const ap = (out && out.apply) || {};
  record('apply: reports applied=created', ap.applied === 'created', ap.applied);
  record('apply: target type is character', ap.targetType === 'character', ap.targetType);
  record('apply: record stamped integration.status=applied', ap.recordStatus === 'applied', ap.recordStatus);
  record('apply: integrationAudit written', ap.auditPresent === true, String(ap.auditPresent));
  record('apply: audit fingerprint matches the confirmed preview', ap.auditFingerprintMatches === true, String(ap.auditFingerprintMatches));
  record('apply: resolutions recorded in the audit', ap.resolutionsPresent === true, String(ap.resolutionsPresent));
  record('apply: target Character row persisted', ap.characterCreated === true, String(ap.characterCreated));
  record('apply: character summary carried from the record', ap.characterSummary === 'A wise sage.', ap.characterSummary);
  record('apply: character background carried from the body', ap.characterBackground === 'She followed closely.', ap.characterBackground);
  record('apply: record stamp references the real entity id', ap.stampMatchesEntity === true, String(ap.stampMatchesEntity));

  const os1 = (out && out.oneshot) || {};
  record('one-shot: second Apply refused (already-applied)', os1.secondReason === 'already-applied', os1.secondReason);
  record('one-shot: no duplicate entity created', os1.noDuplicate === true, String(os1.noDuplicate));

  const cs = (out && out.concurrentSame) || {};
  record('concurrency (same preview): exactly one apply commits', cs.fulfilled === 1, String(cs.fulfilled));
  record('concurrency (same preview): the loser is refused already-applied', cs.rejectedReason === 'already-applied', cs.rejectedReason);
  record('concurrency (same preview): exactly one entity row', cs.entityCount === 1, String(cs.entityCount));
  record('concurrency (same preview): record applied', cs.recordStatus === 'applied', cs.recordStatus);

  const cd = (out && out.concurrentDiff) || {};
  record('concurrency (different previews): exactly one apply commits', cd.fulfilled === 1, String(cd.fulfilled));
  record('concurrency (different previews): exactly one entity row', cd.entityCount === 1, String(cd.entityCount));

  const sc = (out && out.sameCharacter) || {};
  record('same-character race: no apply threw an unexpected error', (sc.rejectedReasons || []).every((r) => r === 'stale-preview'), JSON.stringify(sc.rejectedReasons));
  record('same-character race: exactly ONE character row (no duplicate)', sc.entityCount === 1, String(sc.entityCount));

  const cw = (out && out.concurrentWorld) || {};
  record('world race: every append either commits or is safely refused', cw.fulfilled + (cw.rejectedReasons || []).length === 3, JSON.stringify(cw));
  record('world race: only stale-preview (never a silent loss) can refuse', (cw.rejectedReasons || []).every((r) => r === 'stale-preview'), JSON.stringify(cw.rejectedReasons));
  record('world race: exactly one world row', cw.worldCount === 1, String(cw.worldCount));
  record('world race: every committed append is present as its own section', cw.sectionCount === cw.fulfilled, JSON.stringify(cw));

  const kd = (out && out.knowledgeDedupe) || {};
  record('knowledge: duplicate integration keeps exactly ONE entry', kd.entryCount === 1, String(kd.entryCount));

  const sp = (out && out.stalePreview) || {};
  record('stale-preview: a changed record is refused (stale-preview)', sp.reason === 'stale-preview', sp.reason);
  record('stale-preview: no entity written', sp.noEntityWritten === true, String(sp.noEntityWritten));
  record('stale-preview: record not stamped applied', sp.recordNotApplied === true, String(sp.recordNotApplied));

  const ef = (out && out.evidenceFailure) || {};
  record('evidence failure: refused (stale-preview | invalid-evidence)', ef.reason === 'stale-preview' || ef.reason === 'invalid-evidence', ef.reason);
  record('evidence failure: no entity written', ef.noEntityWritten === true, String(ef.noEntityWritten));
  record('evidence failure: record not stamped applied', ef.recordNotApplied === true, String(ef.recordNotApplied));

  const cf = (out && out.conflicts) || {};
  record('conflict: default apply keeps the existing summary (no overwrite)', cf.keepExistingSummary === 'original', cf.keepExistingSummary);
  record('conflict: use-extracted overwrites the summary', cf.useExtractedSummary === 'forced summary', cf.useExtractedSummary);
  record('conflict: use-extracted on an unsupported field is refused', cf.unsupportedReason === 'unsupported-field', String(cf.unsupportedReason));
  record('conflict: all applies converge on ONE character row', cf.heroCount === 1, String(cf.heroCount));

  const rb = (out && out.rollback) || {};
  record('rollback: mid-write failure surfaced as a rejection', rb.threw === true, String(rb.threw));
  record('rollback: target entity rolled back (no residue)', rb.entityRolledBack === true, String(rb.entityRolledBack));
  record('rollback: record stamp NOT applied', rb.stampRolledBack === true, String(rb.stampRolledBack));
  record('rollback: no integration audit residue', rb.auditAbsent === true, String(rb.auditAbsent));

  const iso = (out && out.isolation) || {};
  record('isolation: cross-project preview is not-found', iso.previewFromB === 'IntegrationNotFoundError', String(iso.previewFromB));
  record('isolation: cross-project apply is not-found', iso.applyFromB === 'IntegrationNotFoundError', String(iso.applyFromB));
  record('isolation: foreign record not applied', iso.recordAStatusUnchanged === true, String(iso.recordAStatusUnchanged));
  record('isolation: project A pending list only contains A', iso.pendAOnlyA === true, String(iso.pendAOnlyA));
  record('isolation: project B pending list only contains B', iso.pendBOnlyB === true, String(iso.pendBOnlyB));
  record('isolation: project B list contains its own record', iso.bHasB === true, String(iso.bHasB));
  record('isolation: project A list excludes project B record', iso.aHasB === false, String(iso.aHasB));

  const im = (out && out.immutable) || {};
  record('immutability: source document rawText unchanged after apply', im.rawTextUnchanged === true, String(im.rawTextUnchanged));
  record('immutability: source document hash unchanged after apply', im.hashUnchanged === true, String(im.hashUnchanged));

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
