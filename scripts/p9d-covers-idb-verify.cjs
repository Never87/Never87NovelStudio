/**
 * P9 Batch D — Book Covers: REAL IndexedDB integration.
 *
 * Drives the ACTUAL `CoverService` against the browser's REAL IndexedDB over the
 * same headless-Chrome/CDP infrastructure the other P9 scripts use. The in-page
 * logic lives in `scripts/lib/p9d-covers-idb-page.js`; this file only launches
 * Chrome, evaluates the driver, and turns its report into PASS/FAIL lines.
 *
 * Covers (per the P9 acceptance brief, Batch D):
 *   - upload persists the asset Blob + sets the project `cover` reference;
 *   - replacing a cover deletes the superseded asset (no orphan; exactly one);
 *   - WebP is stored but NOT export-embeddable; PNG/JPEG are;
 *   - external URL covers resolve as `external` (not as an asset);
 *   - removeCover clears the reference and deletes the asset;
 *   - an orphaned `asset:<missing>` reference resolves to `asset-missing`
 *     (placeholder), never crashes, and exports as null;
 *   - project isolation: operations on one project never touch another's assets;
 *   - project-delete cascade physically removes the project's cover assets.
 *
 * Requires the dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:covers:idb
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9418;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
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

const DB_NAME = `p9-cov-idb-${Date.now()}`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-cov-chrome-'));
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
  await cdp.eval(`(() => { window.__P9COV_DB_NAME = ${JSON.stringify(DB_NAME)}; return true; })()`);

  const driver = fs.readFileSync(path.join(__dirname, 'lib', 'p9d-covers-idb-page.js'), 'utf8');
  const out = await cdp.eval(`(${driver})()`);

  /* -------- (1) upload -------- */
  const u = out?.upload ?? {};
  record('upload: asset Blob persisted to coverAssets', u.assetStored === true, String(u.assetStored));
  record('upload: project.cover set to asset:<id>', u.projectRefSet === true, String(u.projectRefSet));
  record('upload: canonical MIME derived from bytes', u.mimeCanonical === true, String(u.mimeCanonical));
  record('upload: current cover resolves as an asset', u.resolvesAsAsset === true, String(u.resolvesAsAsset));
  record('upload: exactly one asset for the project', u.exactlyOneAsset === true, String(u.exactlyOneAsset));

  /* -------- (2) replace -------- */
  const r = out?.replace ?? {};
  record('replace: project points at the new asset', r.newRefSet === true, String(r.newRefSet));
  record('replace: the new asset exists', r.newAssetExists === true, String(r.newAssetExists));
  record('replace: the superseded asset is deleted (no orphan)', r.oldAssetDeleted === true, String(r.oldAssetDeleted));
  record('replace: still exactly one asset (old cleaned up)', r.stillExactlyOne === true, String(r.stillExactlyOne));

  /* -------- (3) webp vs exportable -------- */
  const w = out?.webp ?? {};
  record('webp: WebP asset is stored', w.webpStored === true, String(w.webpStored));
  record('webp: WebP canonical MIME', w.webpMimeCanonical === true, String(w.webpMimeCanonical));
  record('webp: WebP is NOT export-embeddable (writers get null)', w.webpNotExportable === true, String(w.webpNotExportable));
  const eb = out?.exportBytes ?? {};
  record('export-bytes: JPEG is export-embeddable', eb.jpegExportable === true, String(eb.jpegExportable));
  record('export-bytes: exported bytes match stored size', eb.jpegBytesMatch === true, String(eb.jpegBytesMatch));

  /* -------- (4) external -------- */
  const ex = out?.external ?? {};
  record('external: external URL stored on project.cover', ex.refSet === true, String(ex.refSet));
  record('external: resolves as "external" (not an asset)', ex.resolvesExternal === true, String(ex.resolvesExternal));

  /* -------- (5) remove -------- */
  const rm = out?.remove ?? {};
  record('remove: cover reference cleared', rm.refCleared === true, String(rm.refCleared));
  record('remove: the asset is deleted', rm.assetDeleted === true, String(rm.assetDeleted));
  record('remove: no cover assets remain for the project', rm.noAssetsLeft === true, String(rm.noAssetsLeft));

  /* -------- (6) orphan / missing -------- */
  const or = out?.orphan ?? {};
  record('orphan: dangling asset:<id> resolves to asset-missing', or.resolvesAssetMissing === true, String(or.resolvesAssetMissing));
  record('orphan: no display URL for a missing asset (placeholder)', or.noDisplayUrl === true, String(or.noDisplayUrl));
  record('orphan: export bytes are null for a missing asset', or.exportNullForMissing === true, String(or.exportNullForMissing));

  /* -------- (7) isolation -------- */
  const iso = out?.isolation ?? {};
  record('isolation: project B still has exactly one asset', iso.bHasExactlyOne === true, String(iso.bHasExactlyOne));
  record('isolation: project B cover reference intact', iso.bRefIntact === true, String(iso.bRefIntact));
  record('isolation: A operations never touched B\'s asset', iso.bNotAffectedByARemove === true, String(iso.bNotAffectedByARemove));

  /* -------- (8) cascade -------- */
  const ca = out?.cascade ?? {};
  record('cascade: B held at least one stored asset before delete', ca.bHadAssetBefore === true, String(ca.bHadAssetBefore));
  record('cascade: project delete physically removes B\'s cover assets', ca.bAssetsGoneAfterDelete === true, String(ca.bAssetsGoneAfterDelete));
  record('cascade: the deleted project row is gone', ca.bProjectGone === true, String(ca.bProjectGone));
  record('cascade: the unrelated project survives', ca.aStillExists === true, String(ca.aStillExists));

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  teardown();

  const failed = results.filter((x) => !x.ok);
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
