/**
 * P8 Batch-5 UI: Project Integration - real browser / real DOM / real Dexie.
 *
 * Drives the ACTUAL React page (`ProjectIntegrationPanel`) at its real route in
 * a headless Chrome over the DevTools Protocol, on the SAME infrastructure the
 * P2-P8 UI scripts use. Records are produced through the REAL Extraction / Review
 * services against the REAL IndexedDB, then every requirement-critical UI
 * behaviour is exercised by CLICKING and TYPING in the DOM (never by calling the
 * apply path from the test):
 *
 *   1. Route + navigation: page mounts at /import/project-integration.
 *   2. Pending queue (confirmed only) + search/kind filters.
 *   3. Detail/evidence display (valid evidence, per-locator rows).
 *   4. Preview generation is READ-ONLY (no entity written, record not applied).
 *   5. Conflict display + per-field strategy selection (existing match).
 *   6. Explicit Apply interaction -> success + target reference shown in the UI.
 *   7. Stale preview: Apply refused + reported in the UI + regenerate retry.
 *   8. Project switching + isolation (project B never shows project A records).
 *   9. Repeated interaction / duplicate Apply prevention (control withdrawn).
 *
 * Usage: npm run verify:integration:ui   (needs dev server on http://localhost:5177/)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9376;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ('  -> ' + detail) : ''));
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
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  sendBounded(method, params = {}, ms = 20000) {
    let timer = null;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(method + ' timed out in ' + ms + 'ms.')), ms); });
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
      throw new Error('Page exception: ' + (d.exception && d.exception.description ? d.exception.description : (d.text || JSON.stringify(d))));
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
  try { if (activeWs) activeWs.close(); } catch (e) { /* closed */ }
  try { if (activeChrome) activeChrome.kill(); } catch (e) { /* gone */ }
  try { if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

const PAGE_HELPERS = `
window.__ig = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async waitFor(fn, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) { /* not ready */ } await window.__ig.sleep(120); }
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
    return window.__ig.cards().map((b) => ((b.querySelector('h3') || {}).textContent || '').trim());
  },
};
true;
`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME + '.');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8igui-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(CHROME, [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1500,1100',
    'about:blank',
  ], { stdio: 'ignore' });
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { /* starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket never opened within 10s.')), 10000);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    ws.addEventListener('open', settle(resolve), { once: true });
    ws.addEventListener('error', settle(reject), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.sendBounded('Page.navigate', { url: 'about:blank' }, 10000);

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails;
      pageErrors.push(d && d.exception && d.exception.description ? d.exception.description : 'unknown');
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

    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);

    const A = await svc.projectService.createProject({ title: 'Integration Alpha' });
    const B = await svc.projectService.createProject({ title: 'Integration Beta' });

    const prose = 'Elara the brave walked into the forest. A wise sage named Mira spoke.';
    const makeDoc = async (projectId, label) => {
      const rawText = '# Volume ' + label + '\\n\\n## Chapter 1\\n\\n' + prose + '\\n';
      const doc = await svc.importService.createDocument(projectId, { format: 'markdown', rawText });
      await svc.importService.parseDocument(projectId, doc.id);
      await svc.importService.confirmStructure(projectId, doc.id);
      const sections = await svc.importService.getConfirmedSections(projectId, doc.id);
      const para = sections.find((s) => s.level === 'paragraph') || sections[sections.length - 1];
      return { doc, para };
    };
    const mkConfirmed = async (projectId, doc, para, title, quote, kind, summary, body, tags) => {
      const rec = await svc.extractionService.createManualExtraction(projectId, {
        documentId: doc.id, kind: kind || 'character', title, summary, body, tags,
        evidence: [{ sectionId: para.id, quote }],
      });
      await svc.reviewService.confirmExtraction(projectId, rec.id);
      return rec;
    };

    const a = await makeDoc(A.id, 'alpha');
    const eCreate = await mkConfirmed(A.id, a.doc, a.para, 'Elara Brave', 'Elara the brave', 'character', 'A brave ranger.', 'Elara leads the vanguard.', ['hero']);
    const eConflict = await mkConfirmed(A.id, a.doc, a.para, 'Mira Sage', 'A wise sage named Mira', 'character', 'Extracted sage summary.', 'Sage background from the text.', ['sage']);
    const eWorld = await mkConfirmed(A.id, a.doc, a.para, 'Whispering Forest', 'walked into the forest', 'location', 'A dense wood.', 'Haunted, they say.', []);
    const pendingRec = await svc.extractionService.createManualExtraction(A.id, {
      documentId: a.doc.id, kind: 'character', title: 'Pending Person', summary: 'not confirmed',
      evidence: [{ sectionId: a.para.id, quote: 'Elara the brave' }],
    });

    const existingMira = await svc.characterService.createCharacter(A.id, {
      name: 'Mira Sage', summary: 'Hand-authored summary.', background: 'Hand-authored background.',
    });

    const b = await makeDoc(B.id, 'beta');
    const bExt = await mkConfirmed(B.id, b.doc, b.para, 'Beta Only Record', 'Elara the brave', 'character', 'beta summary', 'beta body', []);

    return {
      projA: A.id, projB: B.id,
      ids: {
        create: eCreate.id, conflict: eConflict.id, world: eWorld.id,
        pending: pendingRec.id, miraCharacter: existingMira.id, beta: bExt.id,
      },
    };
  })()`);

  if (!seed || !seed.projA) throw new Error('Seed failed: ' + JSON.stringify(seed));

  /* ------------------------------------------------------------------ */
  /* (1) Route + navigation                                             */
  /* ------------------------------------------------------------------ */
  await cdp.sendBounded('Page.navigate', { url: APP_URL.replace(/\/$/, '') + '/import/project-integration' }, 20000);
  await sleep(600);
  await cdp.eval(PAGE_HELPERS);

  const routeView = await cdp.eval(`(async () => {
    const h1 = await window.__ig.waitFor(() => {
      const el = document.querySelector('h1');
      return el && (el.textContent || '').includes('Project Integration') ? el : null;
    });
    const body = document.body.innerText;
    const navLink = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').includes('/import/project-integration'));
    return {
      heading: h1 ? (h1.textContent || '').trim() : null,
      isPlaceholder: body.includes('under construction') || body.includes('ModulePlaceholder'),
      hasNavLink: Boolean(navLink),
      navActive: navLink ? (navLink.getAttribute('aria-current') === 'page' || /\bactive\b/.test(navLink.className)) : false,
      hasProjectPicker: Boolean(document.querySelector('#ai-project-picker')),
    };
  })()`);

  record('route /import/project-integration renders the Project Integration heading', routeView && routeView.heading === 'Project Integration', JSON.stringify(routeView));
  record('integration page is NOT a placeholder page', routeView && routeView.isPlaceholder === false, String(routeView && routeView.isPlaceholder));
  record('sidebar exposes the Project Integration link', Boolean(routeView && routeView.hasNavLink), String(routeView && routeView.hasNavLink));
  record('sidebar marks the current route as active', Boolean(routeView && routeView.navActive), String(routeView && routeView.navActive));
  record('project picker is present on the page', Boolean(routeView && routeView.hasProjectPicker), String(routeView && routeView.hasProjectPicker));

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */
  const selectProject = (projectId) => cdp.eval(`(async () => {
    const picker = await window.__ig.waitFor(() => document.querySelector('#ai-project-picker'));
    window.__ig.setSelect(picker, ${JSON.stringify(projectId)});
    return true;
  })()`);

  const waitQueueCount = (expected) => cdp.eval(`(async () => {
    const statusParas = () => [...document.querySelectorAll('p[role="status"]')];
    const countPara = () => statusParas().find((p) => (p.textContent || '').includes('awaiting integration'));
    const el = await window.__ig.waitFor(() => {
      const p = countPara();
      if (!p) return null;
      const text = (p.textContent || '').trim();
      const lead = parseInt(text, 10);
      return lead === ${expected} ? p : null;
    });
    if (!el) {
      const p = countPara();
      return { ok: false, text: p ? p.textContent.trim() : null };
    }
    return { ok: true, text: el.textContent.trim() };
  })()`);

  const openCard = (title) => cdp.eval(`(async () => {
    const want = ${JSON.stringify(title)};
    const cardFor = () => window.__ig.cards().find((b) => ((b.querySelector('h3') || {}).textContent || '').trim() === want);
    const h2For = () => { const el = document.querySelector('h2'); return el && (el.textContent || '').trim() === want ? el : null; };
    const first = await window.__ig.waitFor(cardFor);
    if (!first) return { ok: false, reason: 'card not found' };
    const ok = await window.__ig.waitFor(() => {
      const card = cardFor();
      if (!card) return null;
      if (!h2For() || card.getAttribute('aria-pressed') !== 'true') card.click();
      const applyBtn = window.__ig.button('Apply integration');
      return h2For() && card.getAttribute('aria-pressed') === 'true' && applyBtn ? true : null;
    });
    return { ok: Boolean(ok), title: ok ? want : null };
  })()`);

  /* ------------------------------------------------------------------ */
  /* (2) Pending queue (confirmed only) + filters                       */
  /* ------------------------------------------------------------------ */
  await selectProject(seed.projA);

  const pendingCount = await waitQueueCount(3);
  record('queue lists only CONFIRMED records awaiting integration', pendingCount && pendingCount.ok === true, JSON.stringify(pendingCount));

  const queueItems = await cdp.eval(`(() => ({ count: window.__ig.cards().length, titles: window.__ig.cardTitles() }))()`);
  record('queue renders one card per confirmed record', queueItems && queueItems.count === 3, JSON.stringify(queueItems));
  record(
    'queue shows the expected record titles',
    queueItems && ['Elara Brave', 'Mira Sage', 'Whispering Forest'].every((t) => queueItems.titles.includes(t)),
    JSON.stringify(queueItems && queueItems.titles),
  );
  record('a PENDING (unconfirmed) record is NOT in the integration queue', !queueItems.titles.includes('Pending Person'), JSON.stringify(queueItems && queueItems.titles));

  await cdp.eval(`(async () => { window.__ig.setSelect(window.__ig.byAriaLabel('Filter by kind'), 'location'); return true; })()`);
  const kindTitles = await cdp.eval(`(async () => { await window.__ig.sleep(300); return window.__ig.cardTitles(); })()`);
  record('kind filter narrows the queue to the matching kind', JSON.stringify(kindTitles) === JSON.stringify(['Whispering Forest']), JSON.stringify(kindTitles));

  await cdp.eval(`(async () => {
    window.__ig.setSelect(window.__ig.byAriaLabel('Filter by kind'), '');
    window.__ig.setValue(window.__ig.byAriaLabel('Search pending extractions'), 'Mira');
    return true;
  })()`);
  const searchTitles = await cdp.eval(`(async () => { await window.__ig.sleep(300); return window.__ig.cardTitles(); })()`);
  record('search filter narrows the queue by title', JSON.stringify(searchTitles) === JSON.stringify(['Mira Sage']), JSON.stringify(searchTitles));

  await cdp.eval(`(async () => { window.__ig.setValue(window.__ig.byAriaLabel('Search pending extractions'), ''); return true; })()`);
  await waitQueueCount(3);

  /* ------------------------------------------------------------------ */
  /* (3) Detail + Evidence + (4) read-only preview                      */
  /* ------------------------------------------------------------------ */
  const dbBeforePreview = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    return {
      characters: await db.characters.count(),
      worlds: await db.worlds.count(),
      knowledge: await db.knowledgeEntries.count(),
    };
  })()`);

  const card = await openCard('Elara Brave');
  record('clicking a queue card opens its read-only preview', card && card.ok === true, JSON.stringify(card));

  const previewDetail = await cdp.eval(`(() => {
    const evidenceHeading = [...document.querySelectorAll('h3')].find((h) => (h.textContent || '').trim() === 'Source evidence');
    const q = document.querySelector('q');
    const badges = [...document.querySelectorAll('span')].map((s) => (s.textContent || '').trim());
    const body = document.body.innerText;
    return {
      hasEvidenceHeading: Boolean(evidenceHeading),
      sliceText: q ? (q.textContent || '').trim() : null,
      validBadge: badges.includes('Valid'),
      hasPreviewNote: /Preview only/.test(body),
      hasApply: Boolean(window.__ig.button('Apply integration')),
      routingSaysCreate: /Will create a new/.test(body),
    };
  })()`);

  record('preview shows the Source evidence section', previewDetail && previewDetail.hasEvidenceHeading === true, String(previewDetail && previewDetail.hasEvidenceHeading));
  record('preview renders the verbatim evidence slice', previewDetail && previewDetail.sliceText === 'Elara the brave', previewDetail && previewDetail.sliceText);
  record('preview marks the evidence locator as Valid', previewDetail && previewDetail.validBadge === true, String(previewDetail && previewDetail.validBadge));
  record('preview states it is read-only ("Preview only")', previewDetail && previewDetail.hasPreviewNote === true, String(previewDetail && previewDetail.hasPreviewNote));
  record('preview shows the routing decision (create new)', previewDetail && previewDetail.routingSaysCreate === true, String(previewDetail && previewDetail.routingSaysCreate));
  record('an explicit Apply control is offered', previewDetail && previewDetail.hasApply === true, String(previewDetail && previewDetail.hasApply));

  const dbAfterPreview = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const rec = await db.extractionRecords.get(${JSON.stringify(seed.ids.create)});
    return {
      characters: await db.characters.count(),
      worlds: await db.worlds.count(),
      knowledge: await db.knowledgeEntries.count(),
      recStatus: rec.integration.status,
    };
  })()`);
  record(
    'opening a preview writes NOTHING to the database',
    dbAfterPreview.characters === dbBeforePreview.characters &&
      dbAfterPreview.worlds === dbBeforePreview.worlds &&
      dbAfterPreview.knowledge === dbBeforePreview.knowledge,
    JSON.stringify({ before: dbBeforePreview, after: dbAfterPreview }),
  );
  record('opening a preview leaves the record not-applied', dbAfterPreview.recStatus === 'not-applied', dbAfterPreview.recStatus);

  /* ------------------------------------------------------------------ */
  /* (5) Conflict display + strategy selection                          */
  /* ------------------------------------------------------------------ */
  const conflictCard = await openCard('Mira Sage');
  record('opening an existing-match record shows its preview', conflictCard && conflictCard.ok === true, JSON.stringify(conflictCard));

  const conflictView = await cdp.eval(`(() => {
    const body = document.body.innerText;
    const strategySummary = window.__ig.byAriaLabel('Strategy for Summary');
    const tags = window.__ig.byAriaLabel('Strategy for Tags');
    const conflictBadges = [...document.querySelectorAll('span')].filter((s) => (s.textContent || '').trim() === 'Conflict').length;
    return {
      routingSaysUpdate: /Will update the existing/.test(body),
      hasSummaryStrategy: Boolean(strategySummary),
      summaryDefault: strategySummary ? strategySummary.value : null,
      hasTagsStrategy: Boolean(tags),
      conflictCount: conflictBadges,
    };
  })()`);

  record('existing match is shown as "Will update the existing"', conflictView && conflictView.routingSaysUpdate === true, String(conflictView && conflictView.routingSaysUpdate));
  record('preview displays field-level conflicts', (conflictView && conflictView.conflictCount || 0) >= 1, String(conflictView && conflictView.conflictCount));
  record('per-field strategy selectors are rendered', Boolean(conflictView && conflictView.hasSummaryStrategy && conflictView.hasTagsStrategy), JSON.stringify({ s: conflictView && conflictView.hasSummaryStrategy, t: conflictView && conflictView.hasTagsStrategy }));
  record('strategy defaults to the conservative keep-existing', conflictView && conflictView.summaryDefault === 'keep-existing', String(conflictView && conflictView.summaryDefault));

  const strategyChanged = await cdp.eval(`(async () => {
    const sel = window.__ig.byAriaLabel('Strategy for Summary');
    window.__ig.setSelect(sel, 'use-extracted');
    await window.__ig.sleep(150);
    return window.__ig.byAriaLabel('Strategy for Summary').value;
  })()`);
  record('selecting use-extracted is reflected in the strategy control', strategyChanged === 'use-extracted', String(strategyChanged));

  /* ------------------------------------------------------------------ */
  /* (6) Explicit Apply -> success + target reference                    */
  /* ------------------------------------------------------------------ */
  const applyResult = await cdp.eval(`(async () => {
    const btn = await window.__ig.waitFor(() => window.__ig.button('Apply integration'));
    if (!btn) return { clicked: false };
    btn.click();
    const done = await window.__ig.waitFor(() => (/integration complete/.test(document.body.innerText) ? true : null));
    const body = document.body.innerText;
    return { clicked: true, successShown: Boolean(done), targetShown: /Target id:/.test(body) };
  })()`);

  const applyDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const rec = await db.extractionRecords.get(${JSON.stringify(seed.ids.conflict)});
    const chars = await db.characters.where('projectId').equals(${JSON.stringify(seed.projA)}).toArray();
    const mira = chars.find((c) => c.name === 'Mira Sage');
    return {
      status: rec.integration.status,
      entityType: rec.integration.appliedEntityType,
      entityId: rec.integration.appliedEntityId,
      miraCount: chars.filter((c) => c.name === 'Mira Sage').length,
      miraSummary: mira ? mira.summary : null,
    };
  })()`);

  record('explicit Apply shows a success message', applyResult && applyResult.successShown === true, JSON.stringify(applyResult));
  record('Apply displays the integrated target reference (Target id)', applyResult && applyResult.targetShown === true, String(applyResult && applyResult.targetShown));
  record('after Apply the record is stamped applied in IndexedDB', applyDb && applyDb.status === 'applied', applyDb && applyDb.status);
  record('the applied record references the real Character entity', applyDb && applyDb.entityType === 'character' && Boolean(applyDb.entityId), JSON.stringify(applyDb));
  record('use-extracted overwrote the existing summary (explicit choice honoured)', applyDb && applyDb.miraSummary === 'Extracted sage summary.', applyDb && applyDb.miraSummary);
  record('no duplicate character was created', applyDb && applyDb.miraCount === 1, String(applyDb && applyDb.miraCount));

  const queueAfterApply = await waitQueueCount(2);
  record('applied record leaves the pending queue', queueAfterApply && queueAfterApply.ok === true, JSON.stringify(queueAfterApply));

  /* ------------------------------------------------------------------ */
  /* (7) Stale preview + failed Apply                                   */
  /* ------------------------------------------------------------------ */
  const worldCard = await openCard('Whispering Forest');
  record('world record preview opens for the stale test', worldCard && worldCard.ok === true, JSON.stringify(worldCard));

  await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const rec = await db.extractionRecords.get(${JSON.stringify(seed.ids.world)});
    await db.extractionRecords.put(Object.assign({}, rec, { summary: 'mutated behind the UI', updatedAt: rec.updatedAt + 1 }));
    return true;
  })()`);

  const staleApply = await cdp.eval(`(async () => {
    const btn = await window.__ig.waitFor(() => window.__ig.button('Apply integration'));
    if (!btn) return { clicked: false };
    btn.click();
    const err = await window.__ig.waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      return alert && /stale/i.test(alert.textContent || '') ? alert : null;
    });
    return {
      clicked: true,
      errShown: Boolean(err),
      hasRegenerate: Boolean(window.__ig.button('Regenerate preview')),
      text: err ? (err.textContent || '').trim() : null,
    };
  })()`);

  const staleDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const rec = await db.extractionRecords.get(${JSON.stringify(seed.ids.world)});
    const worlds = await db.worlds.where('projectId').equals(${JSON.stringify(seed.projA)}).toArray();
    return { status: rec.integration.status, worldCount: worlds.length };
  })()`);

  record('a stale preview fails the Apply with a clear error in the UI', staleApply && staleApply.errShown === true, JSON.stringify(staleApply));
  record('a stale apply writes no world entity', staleDb && staleDb.worldCount === 0, String(staleDb && staleDb.worldCount));
  record('a stale apply leaves the record not-applied', staleDb && staleDb.status === 'not-applied', staleDb && staleDb.status);
  record('a "Regenerate preview" retry path is offered after a stale failure', staleApply && staleApply.hasRegenerate === true, String(staleApply && staleApply.hasRegenerate));

  const regenerate = await cdp.eval(`(async () => {
    const btn = await window.__ig.waitFor(() => window.__ig.button('Regenerate preview'));
    if (!btn) return { clicked: false };
    btn.click();
    const cleared = await window.__ig.waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      const applyBtn = window.__ig.button('Apply integration');
      return !alert && applyBtn ? true : null;
    });
    return { clicked: true, cleared: Boolean(cleared) };
  })()`);
  record('regenerating the preview clears the stale error and re-enables Apply', regenerate && regenerate.cleared === true, JSON.stringify(regenerate));

  /* ------------------------------------------------------------------ */
  /* (8) Project switching + isolation                                  */
  /* ------------------------------------------------------------------ */
  await selectProject(seed.projB);
  const betaCount = await waitQueueCount(1);
  const betaTitles = await cdp.eval(`(async () => { await window.__ig.sleep(200); return window.__ig.cardTitles(); })()`);
  record('project switch: selecting project B loads its own queue', betaCount && betaCount.ok === true, JSON.stringify(betaCount));
  record('project switch: project B queue contains only its own record', JSON.stringify(betaTitles) === JSON.stringify(['Beta Only Record']), JSON.stringify(betaTitles));

  await selectProject(seed.projA);
  const backToA = await waitQueueCount(2);
  const titlesA = await cdp.eval(`(async () => { await window.__ig.sleep(200); return window.__ig.cardTitles(); })()`);
  record('isolation: switching back to project A restores its queue', backToA && backToA.ok === true, JSON.stringify(backToA));
  record('isolation: project A queue never contains project B records', !titlesA.includes('Beta Only Record'), JSON.stringify(titlesA));

  const crossProject = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    let previewThrew = false;
    let applyThrew = false;
    const recB = ${JSON.stringify(seed.ids.beta)};
    try { await svc.integrationService.previewIntegration(${JSON.stringify(seed.projA)}, recB); } catch (e) { previewThrew = true; }
    try { await svc.integrationService.applyIntegration(${JSON.stringify(seed.projA)}, recB, { previewFingerprint: 'prv_x' }); } catch (e) { applyThrew = true; }
    return { previewThrew, applyThrew };
  })()`);
  record('isolation: project A cannot preview a project B record', crossProject && crossProject.previewThrew === true, JSON.stringify(crossProject));
  record('isolation: project A cannot apply a project B record', crossProject && crossProject.applyThrew === true, JSON.stringify(crossProject));

  /* ------------------------------------------------------------------ */
  /* (9) Repeated interaction / duplicate Apply prevention             */
  /* ------------------------------------------------------------------ */
  const worldCard2 = await openCard('Whispering Forest');
  record('re-opening a record regenerates a fresh preview', worldCard2 && worldCard2.ok === true, JSON.stringify(worldCard2));

  const dupClick = await cdp.eval(`(async () => {
    const btn = await window.__ig.waitFor(() => { const b = window.__ig.button('Apply integration'); return b && !b.disabled ? b : null; });
    if (!btn) return { firstClick: false };
    btn.click();
    const done = await window.__ig.waitFor(() => (/integration complete/.test(document.body.innerText) ? true : null));
    // After a successful apply the Apply control must be withdrawn or disabled so
    // the user cannot submit a second integration for the same record.
    const after = window.__ig.button('Apply integration');
    const alertEl = document.querySelector('[role="alert"]');
    return {
      firstClick: true,
      successShown: Boolean(done),
      applyWithdrawn: !after || after.disabled,
      err: alertEl ? alertEl.textContent.trim() : null,
    };
  })()`);

  const worldDupDb = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    const worlds = await db.worlds.where('projectId').equals(${JSON.stringify(seed.projA)}).toArray();
    const sections = worlds.reduce((n, w) => n + (w.sections ? w.sections.length : 0), 0);
    return { worldCount: worlds.length, sectionCount: sections };
  })()`);

  record('explicit Apply on the world record integrates exactly once', dupClick && dupClick.successShown === true && worldDupDb.sectionCount === 1, JSON.stringify({ ui: dupClick, db: worldDupDb }));
  record('after a successful Apply the Apply control is withdrawn (no double-apply)', dupClick && dupClick.applyWithdrawn === true, String(dupClick && dupClick.applyWithdrawn));

  const alreadyApplied = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const db = (await import('/src/db/index.ts')).db;
    const mira = await db.extractionRecords.get(${JSON.stringify(seed.ids.conflict)});
    let reason = null;
    try {
      await svc.integrationService.applyIntegration(${JSON.stringify(seed.projA)}, mira.id, { previewFingerprint: mira.integrationAudit.previewFingerprint });
    } catch (e) { reason = e.reason || e.name; }
    return { reason };
  })()`);
  record('re-applying an already-integrated record is refused (already-applied)', alreadyApplied && alreadyApplied.reason === 'already-applied', JSON.stringify(alreadyApplied));

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
  console.log('TOTAL ' + results.length + '  PASS ' + (results.length - failed.length) + '  FAIL ' + failed.length);
  if (failed.length > 0) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + ': ' + f.detail));
    process.exitCode = 1;
  }
}

main()
  .then(() => { teardown(); process.exit(process.exitCode || 0); })
  .catch((error) => { console.error('HARNESS ERROR:', error); teardown(); process.exit(1); });
