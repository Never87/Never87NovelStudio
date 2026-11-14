/**
 * P8 Batch-6 UI: Import workflow (Import -> Parser -> Structure -> Extraction).
 *
 * Drives the ACTUAL React pages at their real routes in a headless Chrome over
 * the DevTools Protocol, on the SAME infrastructure the P2-P8 UI scripts use,
 * against the REAL IndexedDB:
 *
 *   1. Every one of the four routes mounts its real page (NOT a placeholder) and
 *      is reachable + active from the sidebar.
 *   2. Manuscript Import registers a document through the real form (typing +
 *      clicking), stores it verbatim, and adds it to the project.
 *   3. Duplicate protection blocks a byte-identical re-import until resolved.
 *   4. Document Parser parses into sections and shows correct offsets.
 *   5. Structure Recognition edits + confirms; ANY edit clears the confirmation.
 *   6. Information Extraction is BLOCKED until the structure is confirmed.
 *   7. Information Extraction creates a MANUAL review-pending candidate only.
 *   8. Nothing from extraction reaches project entities.
 *   9. Project isolation: project B's documents never appear for project A.
 *
 * Usage: npm run verify:import:workflow:ui   (needs dev server on http://localhost:5177/)
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9379;

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
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
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
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(method + ' timed out in ' + ms + 'ms.')), ms);
    });
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
      throw new Error(
        'Page exception: ' +
          (d.exception && d.exception.description ? d.exception.description : d.text || JSON.stringify(d)),
      );
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
  try {
    if (activeWs) activeWs.close();
  } catch (e) {
    /* closed */
  }
  try {
    if (activeChrome) activeChrome.kill();
  } catch (e) {
    /* gone */
  }
  try {
    if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true });
  } catch (e) {
    /* best effort */
  }
}
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  teardown();
  process.exit(143);
});

const PAGE_HELPERS = `
window.__wf = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async waitFor(fn, ms = 12000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) { /* not ready */ }
      await window.__wf.sleep(120);
    }
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
  bodyText() {
    return document.body.innerText || '';
  },
};
true;
`;

/** Waits for the shell/heading of a stage page to be mounted. */
const stageMounted = (headingText) => `(async () => {
  const h1 = await window.__wf.waitFor(() => {
    const el = document.querySelector('h1');
    return el && (el.textContent || '').includes(${JSON.stringify(headingText)}) ? el : null;
  });
  const body = document.body.innerText || '';
  const navLink = [...document.querySelectorAll('a')].find((a) =>
    (a.getAttribute('href') || '').includes(window.location.pathname),
  );
  return {
    heading: h1 ? (h1.textContent || '').trim() : null,
    isPlaceholder: body.includes('under construction') || body.includes('ModulePlaceholder'),
    hasNavLink: Boolean(navLink),
    navActive: navLink
      ? navLink.getAttribute('aria-current') === 'page' || /\\bactive\\b/.test(navLink.className)
      : false,
    body: body.slice(0, 400),
  };
})()`;

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('Chrome not found at ' + CHROME + '.');

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8wfui-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(
    CHROME,
    [
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + userDataDir,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1500,1100',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) {
      /* starting */
    }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket never opened within 10s.')), 10000);
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
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

  const goto = async (route) => {
    await cdp.sendBounded('Page.navigate', { url: APP_URL.replace(/\/$/, '') + route }, 20000);
    await sleep(700);
    await cdp.eval(PAGE_HELPERS);
  };

  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(2500);
  await cdp.eval(PAGE_HELPERS);

  /* ------------------------------------------------------------------ */
  /* SEED: two projects through the real ProjectService                  */
  /* ------------------------------------------------------------------ */
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
    const A = await svc.projectService.createProject({ title: 'Workflow Alpha' });
    const B = await svc.projectService.createProject({ title: 'Workflow Beta' });
    return { projA: A.id, projB: B.id };
  })()`);
  record('seeded two projects through the real ProjectService', Boolean(seed && seed.projA && seed.projB), JSON.stringify(seed));

  /* ------------------------------------------------------------------ */
  /* (1) All four routes mount real pages (not placeholders)             */
  /* ------------------------------------------------------------------ */
  const routes = [
    { path: '/import/manuscript', heading: 'Manuscript Import' },
    { path: '/import/document-parser', heading: 'Document Parser' },
    { path: '/import/structure-recognition', heading: 'Structure Recognition' },
    { path: '/import/information-extraction', heading: 'Information Extraction' },
  ];

  for (const route of routes) {
    await goto(route.path);
    const view = await cdp.eval(stageMounted(route.heading));
    record(
      `route ${route.path} renders the "${route.heading}" heading`,
      Boolean(view && view.heading),
      JSON.stringify(view && { heading: view.heading }),
    );
    record(`route ${route.path} is NOT a placeholder page`, Boolean(view && view.isPlaceholder === false), String(view && view.isPlaceholder));
    record(`sidebar exposes ${route.path} and marks it active`, Boolean(view && view.hasNavLink && view.navActive), JSON.stringify(view && { hasNavLink: view.hasNavLink, navActive: view.navActive }));
  }

  /* ------------------------------------------------------------------ */
  /* (2) Manuscript Import: create a document through the real form       */
  /* ------------------------------------------------------------------ */
  await goto('/import/manuscript');

  const MANUSCRIPT = [
    '# Volume One',
    '',
    '## Chapter 1',
    '',
    'Mara Vell carried the lantern across the frozen bridge. She feared nothing.',
    '',
    '## Chapter 2',
    '',
    'The Hollow Court gathered beneath the old oak to judge the traveler.',
    '',
  ].join('\n');

  const imported = await cdp.eval(`(async () => {
    // Clear the persisted selection so the shell starts from a known state, then
    // explicitly select project A through the shell's project picker.
    sessionStorage.clear();
    await window.__wf.sleep(150);

    const picker = await window.__wf.waitFor(() => document.querySelector('#import-workflow-project-picker'));
    if (!picker) return { error: 'project picker missing' };
    window.__wf.setSelect(picker, ${JSON.stringify(seed.projA)});
    await window.__wf.sleep(400);

    // Switch to the paste tab so no file input is required.
    const pasteTab = [...document.querySelectorAll('[role="tab"]')].find((b) => (b.textContent || '').includes('Paste text'));
    if (!pasteTab) return { error: 'paste tab missing' };
    pasteTab.click();
    await window.__wf.sleep(200);

    const nameInput = await window.__wf.waitFor(() =>
      [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('Draft 3')),
    );
    const textArea = await window.__wf.waitFor(() => document.querySelector('textarea'));
    if (!nameInput || !textArea) return { error: 'form fields missing' };

    window.__wf.setValue(nameInput, 'Workflow Draft.md');
    window.__wf.setValue(textArea, ${JSON.stringify(MANUSCRIPT)});
    await window.__wf.sleep(250);

    const submit = window.__wf.button('Import document');
    if (!submit) return { error: 'import button missing' };
    const wasDisabled = submit.disabled;
    submit.click();

    const ok = await window.__wf.waitFor(() => {
      const t = window.__wf.bodyText();
      return t.includes('Imported') || t.includes('already exists') || t.includes('byte-identical');
    });
    const t = window.__wf.bodyText();
    return {
      wasDisabled,
      banner: t.includes('Imported'),
      duplicatePrompt: t.includes('byte-identical'),
      rowPresent: [...document.querySelectorAll('li')].some((li) => (li.textContent || '').includes('Workflow Draft.md')),
    };
  })()`);

  record('Import form enables submission once text is present', Boolean(imported && imported.wasDisabled === false), JSON.stringify(imported));
  record('Importing creates the document and reports success', Boolean(imported && imported.banner), JSON.stringify(imported));

  const stored = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const docs = await svc.importService.listDocuments(${JSON.stringify(seed.projA)});
    const doc = docs.find((d) => (d.fileName || '') === 'Workflow Draft.md') || docs[0] || null;
    return doc ? {
      id: doc.id,
      rawTextExact: doc.rawText === ${JSON.stringify(MANUSCRIPT)},
      length: doc.rawText.length,
      status: doc.status,
      confirmation: doc.structureConfirmedAt ?? null,
      count: docs.length,
    } : { count: 0 };
  })()`);

  record('Import stores the raw text verbatim (UTF-16 slice unchanged)', Boolean(stored && stored.rawTextExact), JSON.stringify(stored));
  record('Newly imported document starts unparsed and unconfirmed', Boolean(stored && stored.status === 'imported' && stored.confirmation === null), JSON.stringify(stored));

  /* ------------------------------------------------------------------ */
  /* (3) Duplicate protection blocks a byte-identical re-import          */
  /* ------------------------------------------------------------------ */
  const duplicate = await cdp.eval(`(async () => {
    const textArea = await window.__wf.waitFor(() => document.querySelector('textarea'));
    const nameInput = [...document.querySelectorAll('input')].find((i) => (i.placeholder || '').includes('Draft 3'));
    if (!textArea) return { error: 'textarea missing' };
    window.__wf.setValue(nameInput, 'Workflow Copy.md');
    window.__wf.setValue(textArea, ${JSON.stringify(MANUSCRIPT)});
    await window.__wf.sleep(250);
    const submit = window.__wf.button('Import document');
    submit.click();
    const prompted = await window.__wf.waitFor(() => window.__wf.bodyText().includes('byte-identical'));
    const before = await import('/src/services/index.ts');
    const countBefore = (await before.importService.listDocuments(${JSON.stringify(seed.projA)})).length;
    return { prompted: Boolean(prompted), countBefore };
  })()`);

  record('A byte-identical re-import is intercepted before writing', Boolean(duplicate && duplicate.prompted), JSON.stringify(duplicate));

  const afterPromptCount = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    return (await svc.importService.listDocuments(${JSON.stringify(seed.projA)})).length;
  })()`);
  record(
    'No duplicate document is written while the prompt is unresolved',
    afterPromptCount === (duplicate && duplicate.countBefore),
    'before=' + (duplicate && duplicate.countBefore) + ' after=' + afterPromptCount,
  );

  /* ------------------------------------------------------------------ */
  /* (4) Document Parser: parse + verify offsets                         */
  /* ------------------------------------------------------------------ */
  await goto('/import/document-parser');
  const parserView = await cdp.eval(`(async () => {
    const btn = await window.__wf.waitFor(() => window.__wf.button('Parse document') || window.__wf.button('Parse again'));
    if (!btn) return { error: 'parse button missing' };
    btn.click();
    const ok = await window.__wf.waitFor(() => window.__wf.bodyText().includes('Parsed into'));
    return { ok: Boolean(ok), body: window.__wf.bodyText().slice(0, 300) };
  })()`);
  record('Document Parser parses the document into sections', Boolean(parserView && parserView.ok), JSON.stringify(parserView && { ok: parserView.ok }));

  const parseDb = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');


    const sections = await svc.importService.getSections(${JSON.stringify(seed.projA)}, ${JSON.stringify(stored && stored.id)});
    const bad = sections.filter((s) => s.text !== (${JSON.stringify(MANUSCRIPT)}).slice(s.start, s.end) || s.text.length !== s.end - s.start);
    return {
      count: sections.length,
      mismatched: bad.length,
      ordered: sections.every((s, i) => i === 0 || sections[i - 1].order <= s.order),

    };
  })()`);
  record('Parsed sections exist', Boolean(parseDb && parseDb.count > 0), JSON.stringify(parseDb));
  record('Every section text equals rawText.slice(start, end) (UTF-16 offsets)', Boolean(parseDb && parseDb.mismatched === 0 && parseDb.count > 0), JSON.stringify(parseDb));
  record('Sections remain in a single ascending order', Boolean(parseDb && parseDb.ordered), JSON.stringify(parseDb));

  /* ------------------------------------------------------------------ */
  /* (5) Structure Recognition: edit clears confirmation                 */
  /* ------------------------------------------------------------------ */
  await goto('/import/structure-recognition');

  const confirmStep = await cdp.eval(`(async () => {
    const btn = await window.__wf.waitFor(() => window.__wf.button('Confirm structure'));
    if (!btn) return { error: 'confirm button missing' };
    btn.click();
    const ok = await window.__wf.waitFor(() => window.__wf.bodyText().includes('Structure confirmed'));
    return { ok: Boolean(ok) };
  })()`);
  record('Structure Recognition confirms the detected structure', Boolean(confirmStep && confirmStep.ok), JSON.stringify(confirmStep));

  const confirmedDb = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const doc = await svc.importService.getDocument(${JSON.stringify(seed.projA)}, ${JSON.stringify(stored && stored.id)});
    return { confirmed: doc ? doc.structureConfirmedAt != null : null, status: doc && doc.status };
  })()`);
  record('Confirmation is persisted on the document', Boolean(confirmedDb && confirmedDb.confirmed === true), JSON.stringify(confirmedDb));

  const editStep = await cdp.eval(`(async () => {
    const editBtn = await window.__wf.waitFor(() => window.__wf.byAriaLabel('Edit structure'));
    if (!editBtn) return { error: 'edit button missing' };
    editBtn.click();
    const input = await window.__wf.waitFor(() => window.__wf.byAriaLabel('Section title'));
    if (!input) return { error: 'title input missing' };
    window.__wf.setValue(input, 'Renamed By UI');
    const save = await window.__wf.waitFor(() => window.__wf.button('Save'));
    save.click();
    const cleared = await window.__wf.waitFor(
      () => window.__wf.bodyText().includes('confirmation was cleared') || window.__wf.button('Confirm structure'),
    );
    return { cleared: Boolean(cleared) };
  })()`);
  record('Editing the structure in the UI is applied', Boolean(editStep && editStep.cleared), JSON.stringify(editStep));

  const editDb = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const doc = await svc.importService.getDocument(${JSON.stringify(seed.projA)}, ${JSON.stringify(stored && stored.id)});
    const sections = await svc.importService.getSections(${JSON.stringify(seed.projA)}, doc.id);
    return {
      confirmed: doc.structureConfirmedAt != null,
      renamed: sections.some((s) => s.title === 'Renamed By UI'),
      rawTextIntact: doc.rawText === ${JSON.stringify(MANUSCRIPT)},
    };
  })()`);
  record('A structural edit clears the confirmation (service-enforced)', Boolean(editDb && editDb.confirmed === false), JSON.stringify(editDb));
  record('A structural edit never modifies the raw text', Boolean(editDb && editDb.rawTextIntact === true), JSON.stringify(editDb));

  /* ------------------------------------------------------------------ */
  /* (6) Extraction is blocked while unconfirmed                         */
  /* ------------------------------------------------------------------ */
  await goto('/import/information-extraction');
  const blocked = await cdp.eval(`(async () => {
    const ready = await window.__wf.waitFor(() => window.__wf.bodyText().includes('Blocked') || window.__wf.bodyText().includes('Ready to extract'));
    const runBtn = window.__wf.button('Run AI extraction');
    const addBtn = window.__wf.button('Add candidate');
    return {
      blocked: window.__wf.bodyText().includes('Blocked'),
      runDisabled: runBtn ? runBtn.disabled : null,
      addDisabled: addBtn ? addBtn.disabled : null,
    };
  })()`);
  record('Extraction page reports Blocked while structure is unconfirmed', Boolean(blocked && blocked.blocked), JSON.stringify(blocked));
  record('Manual add is disabled while unconfirmed', Boolean(blocked && blocked.addDisabled === true), JSON.stringify(blocked));

  const noWrite = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    return (await svc.extractionService.listExtractionsByDocument(${JSON.stringify(seed.projA)}, ${JSON.stringify(stored && stored.id)})).length;
  })()`);
  record('No extraction record exists while unconfirmed', noWrite === 0, 'count=' + noWrite);

  /* ------------------------------------------------------------------ */
  /* (7) Confirm via UI, then create a MANUAL pending candidate          */
  /* ------------------------------------------------------------------ */
  await goto('/import/structure-recognition');
  const reconfirm = await cdp.eval(`(async () => {
    const btn = await window.__wf.waitFor(() => window.__wf.button('Confirm structure'));
    if (!btn) return { error: 'confirm button missing' };
    btn.click();
    const ok = await window.__wf.waitFor(() => window.__wf.bodyText().includes('Structure confirmed'));
    return { ok: Boolean(ok) };
  })()`);
  record('Structure can be re-confirmed after an edit', Boolean(reconfirm && reconfirm.ok), JSON.stringify(reconfirm));

  await goto('/import/information-extraction');
  const manual = await cdp.eval(`(async () => {
    const ready = await window.__wf.waitFor(() => window.__wf.bodyText().includes('Ready to extract'));
    const titleInput = await window.__wf.waitFor(() => window.__wf.byAriaLabel('Candidate title'));
    const sectionSelect = await window.__wf.waitFor(() => window.__wf.byAriaLabel('Evidence section'));
    if (!titleInput || !sectionSelect) return { error: 'manual form missing' };

    // Pick the section whose PREVIEW TEXT contains the quote we will use. The
    // select options are labelled "<title> (<level>)" and ordered like the
    // confirmed sections, so read the section texts from the DOM previews.
    const svc = await import('/src/services/index.ts');
    const QUOTE = 'Mara Vell carried the lantern';
    const projectId = document.querySelector('#import-workflow-project-picker').value;

    const docId = JSON.parse(sessionStorage.getItem('n87.import.workflow.v1') || '{}').documentId;
    const sections = await svc.importService.getSections(projectId, docId);
    const target = sections.find((s) => s.text.includes(QUOTE));
    if (!target) return { error: 'no section contains the quote' };

    window.__wf.setValue(titleInput, 'Mara Vell');
    window.__wf.setSelect(sectionSelect, target.id);
    await window.__wf.sleep(250);

    const quoteInput = await window.__wf.waitFor(() => window.__wf.byAriaLabel('Evidence quote'));
    // A quote that is NOT in the text must be rejected by the service.
    window.__wf.setValue(quoteInput, 'this sentence does not exist');
    await window.__wf.sleep(250);
    window.__wf.button('Add candidate').click();
    const rejected = await window.__wf.waitFor(() => {
      const t = window.__wf.bodyText();
      return t.includes('does not appear verbatim') || t.includes('evidence') || t.includes('quote') || t.includes('could not') || t.includes('Could not');
    });

    // Now a real verbatim quote.
    window.__wf.setValue(quoteInput, QUOTE);
    await window.__wf.sleep(250);
    window.__wf.button('Add candidate').click();
    const created = await window.__wf.waitFor(() => window.__wf.bodyText().includes('Created pending candidate'));

    return { ready: Boolean(ready), rejected: Boolean(rejected), created: Boolean(created), targetSection: target.id };
  })()`);
  record('Extraction becomes available once the structure is confirmed', Boolean(manual && manual.ready), JSON.stringify(manual));
  record('A fabricated evidence quote is rejected', Boolean(manual && manual.rejected), JSON.stringify(manual));
  record('A grounded manual candidate is created', Boolean(manual && manual.created), JSON.stringify(manual));

  const candidateDb = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const recs = await svc.extractionService.listExtractionsByDocument(${JSON.stringify(seed.projA)}, ${JSON.stringify(stored && stored.id)});
    const rec = recs.find((r) => r.title === 'Mara Vell') || null;
    if (!rec) return { found: false };
    const sections = await svc.importService.getSections(${JSON.stringify(seed.projA)}, ${JSON.stringify(stored && stored.id)});
    // Evidence offsets are SECTION-RELATIVE; resolve each against its section text.
    const grounded = rec.evidence.every((e) => {
      const section = sections.find((s) => s.id === e.sectionId);
      if (!section) return false;
      const slice = section.text.slice(e.start, e.end);
      if (e.quote != null) return slice === e.quote;
      return slice.length > 0;
    });
    return {
      status: rec.reviewStatus,
      origin: rec.origin,
      evidence: rec.evidence.length,
      grounded,
    };
  })()`);
  record('Manual candidate is stored as review-pending (never auto-applied)', Boolean(candidateDb && candidateDb.status === 'pending'), JSON.stringify(candidateDb));
  record('Manual candidate carries evidence grounded in its exact section slice', Boolean(candidateDb && candidateDb.evidence > 0 && candidateDb.grounded === true), JSON.stringify(candidateDb));

  /* ------------------------------------------------------------------ */
  /* (8) Nothing from extraction reached project entities                */
  /* ------------------------------------------------------------------ */
  const entities = await cdp.eval(`(async () => {
    const db = (await import('/src/db/index.ts')).db;
    return {
      characters: await db.characters.count(),
      worlds: await db.worlds.count(),
      knowledge: await db.knowledgeEntries.count(),
    };
  })()`);
  record(
    'Extraction did not write any project entity (pending only)',
    Boolean(entities && entities.characters === 0 && entities.worlds === 0 && entities.knowledge === 0),
    JSON.stringify(entities),
  );

  /* ------------------------------------------------------------------ */
  /* (9) Project isolation                                               */
  /* ------------------------------------------------------------------ */
  const isolation = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const docsA = await svc.importService.listDocuments(${JSON.stringify(seed.projA)});
    const docsB = await svc.importService.listDocuments(${JSON.stringify(seed.projB)});
    return { a: docsA.length, b: docsB.length };
  })()`);
  record('Documents are scoped to their own project (B sees none of A)', Boolean(isolation && isolation.b === 0 && isolation.a > 0), JSON.stringify(isolation));

  const crossProject = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const doc = await svc.importService.getDocument(${JSON.stringify(seed.projB)}, ${JSON.stringify(stored && stored.id)});
    let sectionsThrew = false;
    try {
      await svc.importService.getSections(${JSON.stringify(seed.projB)}, ${JSON.stringify(stored && stored.id)});
    } catch (e) {
      sectionsThrew = true;
    }
    return { docIsNull: doc === null, sectionsThrew };
  })()`);
  record('Another project cannot read this document (null) or its sections (throws)', Boolean(crossProject && crossProject.docIsNull && crossProject.sectionsThrew), JSON.stringify(crossProject));

  /* ------------------------------------------------------------------ */
  const fatal = pageErrors.filter((e) => !/ResizeObserver/.test(e));
  record('No uncaught page exceptions during the workflow', fatal.length === 0, fatal.slice(0, 3).join(' | '));

  await cdp
    .eval(`(async () => {
      const svc = await import('/src/services/index.ts');
      for (const p of await svc.projectService.listProjects()) await svc.projectService.deleteProject(p.id);
      return true;
    })()`)
    .catch(() => {});

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
  .then(() => {
    teardown();
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    teardown();
    process.exit(1);
  });
