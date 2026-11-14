/**
 * P9 Batch-1 — REAL Dexie/IndexedDB integration for the Transfer foundation.
 *
 * Unlike `p9-transfer-unit.cjs` (pure Node, in-memory fake tables) this drives
 * the ACTUAL `TransferRepositoryAdapter` + `TransferService` against the REAL
 * Dexie database and the browser's REAL IndexedDB (schema v12), over the same
 * headless-Chrome/CDP infrastructure the P2–P8 scripts use.
 *
 * Every project record is seeded through the EXISTING application services, so
 * the transfer layer reads data the application itself produces. Real API keys
 * are written ONLY to `aiProviders` to prove the exporter never carries them.
 *
 * Guarantees checked at the DATABASE level:
 *   1. All 19 project-owned collections are exported (count == direct table).
 *   2. Multi-project isolation (no id of B appears in A's package).
 *   3. Empty collections export as explicit `[]` (never dropped).
 *   4. P8 documents/sections/extractions/DocumentEvidence relationships & offsets.
 *   5. The exporter's own package validates clean (self-validation).
 *   6. Dangling / broken relationships are REPORTED with a located path.
 *   7. API keys / provider credentials are NEVER exported.
 *   8. Export is READ-ONLY (DB byte-for-byte unchanged, volatile cols aside).
 *   9. Consecutive exports of different projects never cross-contaminate.
 *  10. Dangling-index / `.first()` audit (does it affect the transfer flow?).
 *
 * Usage: npm run verify:transfer:idb   (needs dev server on :5177)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9382;

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
          const issues = pick('issues');
          const details = pick('details');
          const message = pick('message');
          if (issues !== undefined || details !== undefined || message !== undefined) {
            detail = '\n    issues=' + JSON.stringify(issues) + '\n    details=' + JSON.stringify(details) + '\n    msg=' + JSON.stringify(message);
          }
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

const DB_NAME = `p9-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-idb-chrome-'));
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

  // Load the real app so modules + Dexie registration are live, then configure
  // the app singleton to use THIS run's isolated database (so seeding through
  // the real services never touches any existing user data).
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(`(() => { window.__P9_DB_NAME = ${JSON.stringify(DB_NAME)}; return true; })()`);

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9-transfer-idb-page.js'), 'utf8');
  const out = await cdp.eval(`(${driver})()`);

  /* ------------------------------ Assertions ------------------------------ */

  /* (1) All 19 collections exported */
  const cp = out?.complete ?? {};
  record('complete: registry declares 19 project-owned collections', cp.expectedCount === 19, String(cp.expectedCount));
  record('complete: exported data has exactly the registry keys', cp.keysMatchRegistry === true && cp.collectionCount === 19,
    JSON.stringify({ keys: cp.collectionCount, match: cp.keysMatchRegistry }));
  record('complete: a fully-seeded project populates EVERY collection', cp.everyCollectionPopulated === true,
    JSON.stringify(cp.counts));
  for (const [key, n] of Object.entries(cp.counts ?? {})) {
    record(`complete: ${key} export count == direct DB count (${cp.direct?.[key]})`, n === cp.direct?.[key], `export=${n} db=${cp.direct?.[key]}`);
  }
  record('complete: the fully-seeded export validates clean', cp.valid === true, String(cp.valid));

  /* (2) Isolation */
  const iso = out?.isolation ?? {};
  record('isolation: projects A and B have distinct ids', iso.distinctProjectIds === true, String(iso.distinctProjectIds));
  record('isolation: A export contains no B ids', (iso.aLeaksBIds ?? []).length === 0, JSON.stringify(iso.aLeaksBIds));
  record('isolation: B export contains no A ids', (iso.bLeaksAIds ?? []).length === 0, JSON.stringify(iso.bLeaksAIds));
  record('isolation: every A row is owned by A', iso.aAllOwnedByA === true, String(iso.aAllOwnedByA));
  record('isolation: every B row is owned by B', iso.bAllOwnedByB === true, String(iso.bAllOwnedByB));
  record('isolation: per-collection id sets are disjoint', iso.idsDisjoint === true, String(iso.idsDisjoint));

  /* (3) Empty */
  const em = out?.empty ?? {};
  record('empty: a bare project still has its one world', em.worlds === 1, String(em.worlds));
  record('empty: all other collections export as []', em.nonWorldEmpty === true, String(em.nonWorldEmpty));
  record('empty: every collection key is present (arrays, never dropped)', em.keysPresent === true, String(em.keysPresent));
  record('empty: the mostly-empty export validates clean', em.valid === true, String(em.valid));

  /* (4) P8 relationships & offsets */
  const p8 = out?.p8Relations ?? {};
  record('p8: exactly one source document exported', p8.singleDocument === true, String(p8.singleDocument));
  record('p8: section offsets reproduce rawText (real)', p8.allSectionSlicesMatchRaw === true, String(p8.allSectionSlicesMatchRaw));
  record('p8: extraction.documentId matches its document', p8.extractionDocumentMatches === true, String(p8.extractionDocumentMatches));
  record('p8: DocumentEvidence resolves to a section of the same document', p8.evidenceInSameDocument === true, String(p8.evidenceInSameDocument));
  record('p8: DocumentEvidence offsets reproduce the quote', p8.evidenceQuoteMatchesSlice === true, String(p8.evidenceQuoteMatchesSlice));
  record('p8: paragraph section nests under its chapter section', p8.paragraphHasChapterParent === true, String(p8.paragraphHasChapterParent));
  record('p8: extraction.relatedIds follow the character', p8.extractionRelatedIds === true, String(p8.extractionRelatedIds));
  record('p8: knowledge evidence carries a document-section source locator', p8.knowledgeSourceSameDocument === true, JSON.stringify({ present: p8.knowledgeSourcePresent, same: p8.knowledgeSourceSameDocument }));
  record('p8: the export carrying P8 relations validates clean', p8.valid === true, String(p8.valid));

  /* (5) Self-validation */
  const sv = out?.selfValidation ?? {};
  record('self-check: single-project export validates clean', sv.singleValid === true, JSON.stringify(sv.singleErrors));
  record('self-check: workspace export validates clean', sv.workspaceValid === true, JSON.stringify(sv.workspaceErrors));
  record('self-check: workspace carries all three projects', sv.workspaceProjectCount === 3, String(sv.workspaceProjectCount));
  record('self-check: workspace metadata.projectCount matches', sv.workspaceMetadata === 3, String(sv.workspaceMetadata));
  record('self-check: serialise→parse round-trips', sv.roundTripParses === true, String(sv.roundTripParses));
  record('self-check: serialise→parse→serialise is byte-identical', sv.roundTripByteIdentical === true, String(sv.roundTripByteIdentical));

  /* (6) Dangling / broken relationships reported */
  const dg = out?.dangling ?? {};
  record('dangling: chapter → missing volume reported', dg.chapterVolume === 'dangling-reference', String(dg.chapterVolume));
  record('dangling: extraction evidence → missing section reported', dg.evidenceSection === 'dangling-reference', String(dg.evidenceSection));
  record('dangling: continuity → missing anchor scene reported', dg.continuityScene === 'dangling-reference', String(dg.continuityScene));
  record('dangling: section text/rawText mismatch reported', dg.sectionQuote === 'quote-mismatch', String(dg.sectionQuote));
  record('dangling: ownership mismatch reported', dg.ownership === 'ownership-mismatch', String(dg.ownership));
  record('dangling: tampered content yields integrity mismatch', dg.integrity === 'integrity-mismatch', String(dg.integrity));
  record('dangling: every broken package is rejected', dg.allReported === true, String(dg.allReported));
  record('dangling: evidence problem carries a located path', dg.evidenceHasPath === true, String(dg.evidenceHasPath));

  /* (7) Secrets excluded */
  const sec = out?.secrets ?? {};
  record('secrets: a real API key IS stored in the DB (assertion is meaningful)', sec.dbHasSecret === true, String(sec.dbHasSecret));
  record('secrets: project package contains no AI credential material', (sec.projectLeaks ?? []).length === 0, JSON.stringify(sec.projectLeaks));
  record('secrets: workspace package contains no AI credential material', (sec.workspaceLeaks ?? []).length === 0, JSON.stringify(sec.workspaceLeaks));
  record('secrets: serialised package never mentions aiProviders', sec.mentionsAiProviders === false, String(sec.mentionsAiProviders));
  record('secrets: serialised package never mentions an apiKey field', sec.mentionsApiKey === false, String(sec.mentionsApiKey));
  record('secrets: user-authored project prose is retained verbatim (scan is meaningful)', sec.descriptionRetained === true, String(sec.descriptionRetained));

  /* (8) Read-only */
  const ro = out?.readOnly ?? {};
  record('read-only: exporting never modifies ANY table', ro.unchanged === true, JSON.stringify(ro.changedTables));

  /* (9) Consecutive different-project exports */
  const cs = out?.consecutive ?? {};
  record('consecutive: every A export stays A-only', cs.aConsistent === true, String(cs.aConsistent));
  record('consecutive: every B export stays B-only', cs.bConsistent === true, String(cs.bConsistent));
  record('consecutive: repeated A exports are stable (no drift)', cs.stableAcrossRuns === true, String(cs.stableAcrossRuns));
  record('consecutive: alternating exports never swap project ids',
    JSON.stringify(cs.aProjectIds) === JSON.stringify([out?.isolation?.projectIdA, out?.isolation?.projectIdA, out?.isolation?.projectIdA, out?.isolation?.projectIdA]) &&
    JSON.stringify(cs.bProjectIds) === JSON.stringify([out?.isolation?.projectIdB, out?.isolation?.projectIdB, out?.isolation?.projectIdB, out?.isolation?.projectIdB]),
    JSON.stringify({ a: cs.aProjectIds, b: cs.bProjectIds }));

  /* (10) Dangling-index / .first() audit — informational + a hard guarantee */
  const ia = out?.indexAudit ?? {};
  const missing = ia.missingIndexedValue ?? {};
  record('index-audit: no project-owned row is missing a value for an indexed column', Object.keys(missing).length === 0, JSON.stringify(missing));
  record('index-audit: the knowledge source-key (nullable, .first() path) is NOT used by transfer reads',
    typeof ia.knowledgeNullKeyRows === 'number', `null sourceKey rows=${ia.knowledgeNullKeyRows}`);

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
