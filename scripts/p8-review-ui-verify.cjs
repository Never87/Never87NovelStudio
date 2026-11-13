/**
 * P8 Batch-4 UI: Extraction Review Center — real browser / real DOM / real Dexie.
 *
 * Drives the ACTUAL React page (`ExtractionReviewPanel`) at its real route in a
 * headless Chrome over the DevTools Protocol, on the SAME infrastructure the
 * P2–P8 UI scripts use (no separate framework is introduced). Records are
 * produced through the REAL `ExtractionService` against the REAL IndexedDB and
 * then every requirement-critical UI behaviour is exercised by CLICKING and
 * TYPING in the DOM (never by calling the service from the test):
 *
 *   1. Route + navigation: the page mounts at /import/review-center, the sidebar
 *      link exists and is the active nav item.
 *   2. Review queue + filters (status / kind / search), queue count text.
 *   3. Detail + Evidence display (valid evidence, per-locator rows).
 *   4. Pending edit (title/summary persisted to IndexedDB).
 *   5. Confirm / Reject / Restore via the buttons.
 *   6. Merge preview (candidate picker lists eligible targets only) + execute.
 *   7. Duplicate-operation protection (repeated buttons, ineligible actions).
 *   8. Project switch + data isolation between two projects.
 *
 * Usage: npm run verify:review:ui   (needs dev server on http://localhost:5177/)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9374;

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
  sendBounded(method, params = {}, ms = 20_000) {
    let timer = null;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out in ${ms}ms.`)), ms); });
    const call = this.send(method, params);
    call.catch(() => {});
    return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
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

/* ------------------------------------------------------------------ */
/* In-page helpers, injected once and reused by every interaction.     */
/* ------------------------------------------------------------------ */
const PAGE_HELPERS = `
window.__rv = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) { /* not ready */ } await window.__rv.sleep(120); }
    return null;
  },
  setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  setSelect(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  button(text) {
    const want = text.toLowerCase();
    return [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === want) || null;
  },
  byAriaLabel(label) {
    return document.querySelector('[aria-label="' + label + '"]');
  },
  cards() {
    return [...document.querySelectorAll('button[aria-pressed]')];
  },
  cardTitles() {
    return window.__rv.cards().map((b) => ((b.querySelector('h3') || {}).textContent || '').trim());
  },
};
true;
`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}.`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8revui-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1400,1000',
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
  await cdp.sendBounded('Page.navigate', { url: 'about:blank' }, 10_000);

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(PAGE_HELPERS);

  /* ------------------------------------------------------------------ */
  /* SEED: two projects, real docs/sections/extractions via real services */
  /* ------------------------------------------------------------------ */
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();

    // Clean slate so the run is deterministic (real UI reads the same DB).
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);

    const A = await svc.projectService.createProject({ title: 'Review Alpha' });
    const B = await svc.projectService.createProject({ title: 'Review Beta' });

    const prose = 'Elara the brave walked into the forest. Aria the wise followed her.';
    const makeDoc = async (projectId, label) => {
      const rawText = '# Volume ' + label + '\\n\\n## Chapter 1\\n\\n' + prose + '\\n';
      const doc = await svc.importService.createDocument(projectId, { format: 'markdown', rawText });
      await svc.importService.parseDocument(projectId, doc.id);
      await svc.importService.confirmStructure(projectId, doc.id);
      const sections = await svc.importService.getConfirmedSections(projectId, doc.id);
      const para = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
      return { doc, para };
    };
    const mkExtraction = (projectId, doc, para, title, quote, kind) =>
      svc.extractionService.createManualExtraction(projectId, {
        documentId: doc.id, kind: kind || 'character', title,
        evidence: [{ sectionId: para.id, quote }],
      });

    const a = await makeDoc(A.id, 'alpha');
    // Distinct kinds so dedupe keys never collide, distinct quotes for evidence.
    const eConfirm = await mkExtraction(A.id, a.doc, a.para, 'Elara Brave', 'Elara the brave');
    const eReject = await mkExtraction(A.id, a.doc, a.para, 'Aria Wise', 'Aria the wise');
    const eRestore = await mkExtraction(A.id, a.doc, a.para, 'Forest Walk', 'walked into the forest');
    // Distinct quotes: identical quotes would make the two records share a
    // dedupe key / evidence locator, which the service (correctly) dedupes.
    const eMergeSrc = await mkExtraction(A.id, a.doc, a.para, 'Merge Source', 'the brave', 'concept');
    const eMergeTgt = await mkExtraction(A.id, a.doc, a.para, 'Merge Target', 'followed her', 'faction');
    // Pre-reject one record so the Restore path has a starting state.
    await svc.reviewService.rejectExtraction(A.id, eRestore.id);

    const b = await makeDoc(B.id, 'beta');
    const bExt = await mkExtraction(B.id, b.doc, b.para, 'Beta Only Record', 'Elara the brave');

    return {
      projA: A.id, projB: B.id,
      ids: {
        confirm: eConfirm.id, reject: eReject.id, restore: eRestore.id,
        mergeSrc: eMergeSrc.id, mergeTgt: eMergeTgt.id, beta: bExt.id,
      },
    };
  })()`);

  if (!seed || !seed.projA) throw new Error('Seed failed: ' + JSON.stringify(seed));

  /* ------------------------------------------------------------------ */
  /* (1) Route + navigation                                             */
  /* ------------------------------------------------------------------ */
  await cdp.sendBounded('Page.navigate', { url: `${APP_URL.replace(/\/$/, '')}/import/review-center` }, 20_000);
  await sleep(500);
  await cdp.eval(PAGE_HELPERS);

  const routeView = await cdp.eval(`(async () => {
    const h1 = await window.__rv.waitFor(() => {
      const el = document.querySelector('h1');
      return el && (el.textContent || '').includes('Extraction Review Center') ? el : null;
    });
    const body = document.body.innerText;
    const navLink = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').includes('/import/review-center'));
    return {
      heading: h1 ? (h1.textContent || '').trim() : null,
      isPlaceholder: body.includes('under construction') || body.includes('ModulePlaceholder'),
      hasNavLink: Boolean(navLink),
      navActive: navLink ? (navLink.getAttribute('aria-current') === 'page' || /\\bactive\\b/.test(navLink.className)) : false,
      hasProjectPicker: Boolean(document.querySelector('#ai-project-picker')),
    };
  })()`);

  record('route /import/review-center renders the Review Center heading', routeView?.heading === 'Extraction Review Center', JSON.stringify(routeView));
  record('review center is NOT a placeholder page', routeView?.isPlaceholder === false, String(routeView?.isPlaceholder));
  record('sidebar exposes the Extraction Review Center link', routeView?.hasNavLink === true, String(routeView?.hasNavLink));
  record('sidebar marks the current route as active', routeView?.navActive === true, String(routeView?.navActive));
  record('project picker is present on the page', routeView?.hasProjectPicker === true, String(routeView?.hasProjectPicker));

  /* ------------------------------------------------------------------ */
  /* Helpers: project select + queue-count wait                          */
  /* ------------------------------------------------------------------ */
  const selectProject = (projectId) => cdp.eval(`(async () => {
    const picker = await window.__rv.waitFor(() => document.querySelector('#ai-project-picker'));
    window.__rv.setSelect(picker, ${JSON.stringify(projectId)});
    return true;
  })()`);

  const waitQueueCount = (expected) => cdp.eval(`(async () => {
    const el = await window.__rv.waitFor(() => {
      const p = [...document.querySelectorAll('p[role="status"]')].find((p) => /\\bin queue\\b/.test(p.textContent || ''));
      if (!p) return null;
      const m = /^(\\d+)\\s+record/.exec((p.textContent || '').trim());
      return m && Number(m[1]) === ${expected} ? p : null;
    });
    if (!el) {
      const p = [...document.querySelectorAll('p[role="status"]')].find((p) => /\\bin queue\\b/.test(p.textContent || ''));
      return { ok: false, text: p ? p.textContent.trim() : null };
    }
    return { ok: true, text: el.textContent.trim() };
  })()`);

  const openCard = (title) => cdp.eval(`(async () => {
    // Click the card repeatedly until BOTH the detail heading AND the card's
    // selected state (aria-pressed) reflect the requested record. This is
    // resilient to React committing the selection in a later paint after a
    // filter/project change, without weakening any assertion.
    const want = ${JSON.stringify(title)};
    const cardFor = () => window.__rv.cards().find((b) => ((b.querySelector('h3') || {}).textContent || '').trim() === want);
    const h2For = () => {
      const el = document.querySelector('h2');
      return el && (el.textContent || '').trim() === want ? el : null;
    };
    const first = await window.__rv.waitFor(cardFor);
    if (!first) return { ok: false, reason: 'card not found' };
    const ok = await window.__rv.waitFor(() => {
      const card = cardFor();
      if (!card) return null;
      if (!h2For() || card.getAttribute('aria-pressed') !== 'true') card.click();
      return h2For() && card.getAttribute('aria-pressed') === 'true' ? true : null;
    });
    return { ok: Boolean(ok), title: ok ? want : null };
  })()`);

  /* ------------------------------------------------------------------ */
  /* (2) Review queue + filters                                         */
  /* ------------------------------------------------------------------ */
  await selectProject(seed.projA);

  // Default filter is "pending": 4 pending in A (confirm, reject, mergeSrc,
  // mergeTgt) — "restore" was pre-rejected so it is excluded.
  const pendingCount = await waitQueueCount(4);
  record('queue defaults to PENDING records for the selected project', pendingCount?.ok === true, JSON.stringify(pendingCount));

  const queueItems = await cdp.eval(`(() => ({ count: window.__rv.cards().length, titles: window.__rv.cardTitles() }))()`);
  record('queue renders one card per pending record', queueItems?.count === 4, JSON.stringify(queueItems));
  record(
    'queue shows the expected record titles',
    ['Elara Brave', 'Aria Wise', 'Merge Source', 'Merge Target'].every((t) => queueItems?.titles.includes(t)),
    JSON.stringify(queueItems?.titles),
  );

  // Status filter = rejected → only "Forest Walk".
  await cdp.eval(`(async () => { window.__rv.setSelect(window.__rv.byAriaLabel('Filter by review status'), 'rejected'); return true; })()`);
  const rejectedCount = await waitQueueCount(1);
  const rejectedTitles = await cdp.eval(`window.__rv.cardTitles()`);
  record('status filter (rejected) narrows the queue to 1 record', rejectedCount?.ok === true, JSON.stringify(rejectedCount));
  record('status filter (rejected) shows the rejected record', JSON.stringify(rejectedTitles) === JSON.stringify(['Forest Walk']), JSON.stringify(rejectedTitles));

  // Status = all + kind = concept → Merge Source + Merge Target.
  await cdp.eval(`(async () => {
    window.__rv.setSelect(window.__rv.byAriaLabel('Filter by review status'), 'all');
    window.__rv.setSelect(window.__rv.byAriaLabel('Filter by kind'), 'concept');
    return true;
  })()`);
  const conceptCount = await waitQueueCount(1);
  const conceptTitles = await cdp.eval(`window.__rv.cardTitles()`);
  record('kind filter (concept) narrows the queue to the matching kind', conceptCount?.ok === true && JSON.stringify(conceptTitles) === JSON.stringify(['Merge Source']), JSON.stringify({ count: conceptCount, titles: conceptTitles }));

  // Search by title substring → 1.
  await cdp.eval(`(async () => {
    window.__rv.setSelect(window.__rv.byAriaLabel('Filter by kind'), '');
    window.__rv.setValue(window.__rv.byAriaLabel('Search extraction records'), 'Merge Target');
    return true;
  })()`);
  const searchCount = await waitQueueCount(1);
  record('search filter narrows the queue by title', searchCount?.ok === true, JSON.stringify(searchCount));

  // Reset to pending for detail tests.
  await cdp.eval(`(async () => {
    window.__rv.setValue(window.__rv.byAriaLabel('Search extraction records'), '');
    window.__rv.setSelect(window.__rv.byAriaLabel('Filter by review status'), 'pending');
    return true;
  })()`);
  await waitQueueCount(4);

  /* ------------------------------------------------------------------ */
  /* (3) Detail + Evidence display                                      */
  /* ------------------------------------------------------------------ */
  const card = await openCard('Elara Brave');
  record('clicking a queue card opens its detail view', card?.ok === true, JSON.stringify(card));

  const detail = await cdp.eval(`(() => {
    const evidenceHeading = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'Evidence');
    const q = document.querySelector('q');
    const badges = [...document.querySelectorAll('span')].map((s) => (s.textContent || '').trim());
    return {
      hasEvidenceHeading: Boolean(evidenceHeading),
      sliceText: q ? (q.textContent || '').trim() : null,
      validBadge: badges.includes('Valid'),
      invalidBadge: badges.includes('Invalid'),
      hasConfirm: Boolean(window.__rv.button('Confirm')),
      hasReject: Boolean(window.__rv.button('Reject')),
      hasEdit: Boolean(window.__rv.button('Edit')),
    };
  })()`);

  record('detail shows the Evidence section', detail?.hasEvidenceHeading === true, String(detail?.hasEvidenceHeading));
  record('detail renders the verbatim evidence slice', detail?.sliceText === 'Elara the brave', detail?.sliceText);
  record('detail marks the evidence locator as Valid', detail?.validBadge === true && detail?.invalidBadge === false, JSON.stringify({ valid: detail?.validBadge, invalid: detail?.invalidBadge }));
  record('detail exposes Confirm / Reject / Edit for a pending record', detail?.hasConfirm === true && detail?.hasReject === true && detail?.hasEdit === true, JSON.stringify({ c: detail?.hasConfirm, r: detail?.hasReject, e: detail?.hasEdit }));

  /* ------------------------------------------------------------------ */
  /* (4) Pending edit                                                   */
  /* ------------------------------------------------------------------ */
  const editResult = await cdp.eval(`(async () => {
    const btn = await window.__rv.waitFor(() => window.__rv.button('Edit'));
    btn.click();
    const titleInput = await window.__rv.waitFor(() => document.querySelector('#review-title'));
    if (!titleInput) return { ok: false, reason: 'edit form did not open' };
    window.__rv.setValue(titleInput, 'Elara The Bold');
    window.__rv.setValue(document.querySelector('#review-summary'), 'Edited summary from UI.');
    window.__rv.button('Save changes').click();
    const h2 = await window.__rv.waitFor(() => {
      const el = document.querySelector('h2');
      return el && (el.textContent || '').trim() === 'Elara The Bold' ? el : null;
    });
    return { ok: Boolean(h2) };
  })()`);

  const persistedEdit = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const row = await db.extractionRecords.get(${JSON.stringify(seed.ids.confirm)});
    return row ? { title: row.title, summary: row.summary, status: row.reviewStatus } : null;
  })()`);

  record('edit: form opens and saving updates the detail heading', editResult?.ok === true, JSON.stringify(editResult));
  record('edit: change is PERSISTED to IndexedDB', persistedEdit?.title === 'Elara The Bold' && persistedEdit?.summary === 'Edited summary from UI.', JSON.stringify(persistedEdit));
  record('edit: editing a pending record keeps it pending', persistedEdit?.status === 'pending', persistedEdit?.status);

  /* ------------------------------------------------------------------ */
  /* (5) Confirm (button) + duplicate protection                        */
  /* ------------------------------------------------------------------ */
  const confirmResult = await cdp.eval(`(async () => {
    window.__rv.button('Confirm').click();
    const confirmedMsg = await window.__rv.waitFor(() => (/Confirmed — approved/.test(document.body.innerText) ? true : null));
    return {
      confirmedMsg: Boolean(confirmedMsg),
      hasConfirmButton: Boolean(window.__rv.button('Confirm')),
      hasRestoreButton: Boolean(window.__rv.button('Restore to pending')),
    };
  })()`);
  const confirmDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    return (await db.extractionRecords.get(${JSON.stringify(seed.ids.confirm)})).reviewStatus;
  })()`);
  record('confirm: button transitions the record to confirmed', confirmResult?.confirmedMsg === true, JSON.stringify(confirmResult));
  record('confirm: persisted status is confirmed', confirmDb === 'confirmed', confirmDb);
  record('confirm: Confirm is withdrawn once confirmed (no double-apply)', confirmResult?.hasConfirmButton === false, String(confirmResult?.hasConfirmButton));

  const afterConfirmCount = await waitQueueCount(3);
  record('confirm: record removed from the pending queue', afterConfirmCount?.ok === true, JSON.stringify(afterConfirmCount));

  /* ------------------------------------------------------------------ */
  /* (5b) Reject (button) + Restore (button)                            */
  /* ------------------------------------------------------------------ */
  await openCard('Aria Wise');
  const rejectResult = await cdp.eval(`(async () => {
    window.__rv.waitFor(() => window.__rv.button('Reject')).then((b) => b && b.click());
    const restore = await window.__rv.waitFor(() => window.__rv.button('Restore to pending'));
    return { hasRestore: Boolean(restore), hasConfirm: Boolean(window.__rv.button('Confirm')) };
  })()`);
  const rejectDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    return (await db.extractionRecords.get(${JSON.stringify(seed.ids.reject)})).reviewStatus;
  })()`);
  record('reject: button transitions the record to rejected', rejectDb === 'rejected', rejectDb);
  record('reject: Confirm is withdrawn and Restore is offered', rejectResult?.hasConfirm === false && rejectResult?.hasRestore === true, JSON.stringify(rejectResult));

  const restoreResult = await cdp.eval(`(async () => {
    window.__rv.button('Restore to pending').click();
    const confirm = await window.__rv.waitFor(() => window.__rv.button('Confirm'));
    return { hasConfirm: Boolean(confirm) };
  })()`);
  const restoreDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    return (await db.extractionRecords.get(${JSON.stringify(seed.ids.reject)})).reviewStatus;
  })()`);
  record('restore: button returns the record to pending', restoreDb === 'pending', restoreDb);
  record('restore: Confirm is offered again after restore', restoreResult?.hasConfirm === true, JSON.stringify(restoreResult));

  // The pre-rejected record (Forest Walk) can also be restored from its detail.
  await cdp.eval(`(async () => {
    window.__rv.setSelect(window.__rv.byAriaLabel('Filter by review status'), 'rejected');
    return true;
  })()`);
  await waitQueueCount(1);
  await openCard('Forest Walk');
  const restorePre = await cdp.eval(`(async () => {
    window.__rv.button('Restore to pending').click();
    const c = await window.__rv.waitFor(() => window.__rv.button('Confirm'));
    return { hasConfirm: Boolean(c) };
  })()`);
  const restorePreDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    return (await db.extractionRecords.get(${JSON.stringify(seed.ids.restore)})).reviewStatus;
  })()`);
  record('restore: a rejected record restores to pending from its detail', restorePreDb === 'pending' && restorePre?.hasConfirm === true, JSON.stringify({ status: restorePreDb, ui: restorePre }));

  // Back to pending filter for the merge tests. Wait for BOTH the count text
  // and the rendered cards to show the requested record before clicking.
  await cdp.eval(`(async () => {
    window.__rv.setSelect(window.__rv.byAriaLabel('Filter by review status'), 'pending');
    return true;
  })()`);
  await waitQueueCount(4);
  await cdp.eval(`(async () => window.__rv.waitFor(() =>
    window.__rv.cardTitles().includes('Merge Source') && window.__rv.cardTitles().includes('Merge Target')) && true)()`);

  /* ------------------------------------------------------------------ */
  /* (6) Merge preview + execute                                        */
  /* ------------------------------------------------------------------ */
  await openCard('Merge Source');
  const mergePreview = await cdp.eval(`(async () => {
    const select = await window.__rv.waitFor(() => window.__rv.byAriaLabel('Merge into'));
    const options = [...select.querySelectorAll('option')].map((o) => ({ value: o.value }));
    const mergeBtn = window.__rv.button('Merge');
    return {
      hasSelect: Boolean(select),
      optionCount: options.length,
      includesSelf: options.some((o) => o.value === ${JSON.stringify(seed.ids.mergeSrc)}),
      includesTarget: options.some((o) => o.value === ${JSON.stringify(seed.ids.mergeTgt)}),
      includesBeta: options.some((o) => o.value === ${JSON.stringify(seed.ids.beta)}),
      mergeDisabledInitially: mergeBtn ? mergeBtn.disabled : null,
    };
  })()`);

  record('merge preview: a "Merge into…" picker is shown for a pending record', mergePreview?.hasSelect === true, JSON.stringify(mergePreview));
  record('merge preview: the record itself is not a merge candidate', mergePreview?.includesSelf === false, String(mergePreview?.includesSelf));
  record('merge preview: an eligible same-project target is offered', mergePreview?.includesTarget === true, String(mergePreview?.includesTarget));
  record('merge preview: a cross-project target is NOT offered (isolation)', mergePreview?.includesBeta === false, String(mergePreview?.includesBeta));
  record('merge preview: Merge button disabled until a target is chosen', mergePreview?.mergeDisabledInitially === true, String(mergePreview?.mergeDisabledInitially));

  const mergeExecute = await cdp.eval(`(async () => {
    window.__rv.setSelect(window.__rv.byAriaLabel('Merge into'), ${JSON.stringify(seed.ids.mergeTgt)});
    const btn = await window.__rv.waitFor(() => { const b = window.__rv.button('Merge'); return b && !b.disabled ? b : null; });
    if (!btn) return { clicked: false };
    btn.click();
    const merged = await window.__rv.waitFor(() => (/Merged into/.test(document.body.innerText) ? true : null));
    return { clicked: true, mergedView: Boolean(merged) };
  })()`);

  const mergeDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const src = await db.extractionRecords.get(${JSON.stringify(seed.ids.mergeSrc)});
    const tgt = await db.extractionRecords.get(${JSON.stringify(seed.ids.mergeTgt)});
    return {
      srcStatus: src.reviewStatus,
      srcTarget: src.merge ? src.merge.targetId : null,
      tgtStatus: tgt.reviewStatus,
      tgtEvidence: tgt.evidence.length,
    };
  })()`);

  record('merge: executing the merge is reflected in the UI', mergeExecute?.clicked === true && mergeExecute?.mergedView === true, JSON.stringify(mergeExecute));
  record('merge: source persisted as merged with the right target', mergeDb?.srcStatus === 'merged' && mergeDb?.srcTarget === seed.ids.mergeTgt, JSON.stringify(mergeDb));
  record('merge: target absorbed the source evidence (2 locators)', mergeDb?.tgtEvidence === 2, JSON.stringify(mergeDb));

  const afterMergeCount = await waitQueueCount(3);
  record('merge: merged record is removed from the pending queue', afterMergeCount?.ok === true, JSON.stringify(afterMergeCount));

  const mergedTerminal = await cdp.eval(`(() => ({
    hasConfirm: Boolean(window.__rv.button('Confirm')),
    hasMerge: Boolean(window.__rv.button('Merge')),
    terminalText: /Merged — folded into another record/.test(document.body.innerText),
  }))()`);
  record('duplicate protection: a merged record offers no further actions', mergedTerminal?.hasConfirm === false && mergedTerminal?.hasMerge === false && mergedTerminal?.terminalText === true, JSON.stringify(mergedTerminal));

  /* ------------------------------------------------------------------ */
  /* (7) Project switch + isolation                                     */
  /* ------------------------------------------------------------------ */
  await selectProject(seed.projB);
  const betaQueue = await waitQueueCount(1);
  const betaTitles = await cdp.eval(`window.__rv.cardTitles()`);
  record('project switch: selecting project B loads its own queue', betaQueue?.ok === true, JSON.stringify(betaQueue));
  record('project switch: project B queue contains only its own record', JSON.stringify(betaTitles) === JSON.stringify(['Beta Only Record']), JSON.stringify(betaTitles));

  await selectProject(seed.projA);
  const backToA = await waitQueueCount(3);
  const titlesA = await cdp.eval(`window.__rv.cardTitles()`);
  record('isolation: switching back to project A restores its queue', backToA?.ok === true, JSON.stringify(backToA));
  record('isolation: project A queue never contains project B records', titlesA?.includes?.('Beta Only Record') === false, JSON.stringify(titlesA));

  const crossProject = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    let threw = false;
    try { await svc.reviewService.getReviewDetail(${JSON.stringify(seed.projA)}, ${JSON.stringify(seed.ids.beta)}); }
    catch (e) { threw = true; }
    return { threw };
  })()`);
  record('isolation: project A cannot load project B record detail', crossProject?.threw === true, JSON.stringify(crossProject));

  record('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  /* ------------------------------------------------------------------ */
  /* Cleanup                                                            */
  /* ------------------------------------------------------------------ */
  await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    return true;
  })()`).catch(() => {});

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
