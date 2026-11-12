/**
 * P4 data-layer verification: real browser, real IndexedDB, real Services.
 *
 * Exercises the writing layer through the app's own modules (imported from
 * `/src/...`, so it runs against the real compiled code):
 *
 *   open chapter (creates draft) -> save + counters -> autosave revisions ->
 *   stale-revision conflict -> version snapshot + prune -> restore -> locked
 *   chapter rejection -> Markdown import preview/commit -> export round trip ->
 *   cascade delete (no orphans).
 *
 * Requires a dev server on http://localhost:5177/ (started by the caller).
 *
 * Usage: npm run verify:writing
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_URL = 'http://localhost:5177/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9347;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
function stage(label, extra) {
  console.log(`[${String(Date.now() - t0).padStart(6, ' ')}ms] STAGE: ${label}${extra ? '  ' + extra : ''}`);
}

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
  try { activeWs?.close(); } catch { /* already closed */ }
  try { activeChrome?.kill(); } catch { /* already gone */ }
  try {
    if (activeProfileDir) fs.rmSync(activeProfileDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

process.on('SIGINT', () => { teardown(); process.exit(130); });
process.on('SIGTERM', () => { teardown(); process.exit(143); });

async function main() {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}. Set CHROME or install Chrome.`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-chrome-'));
  activeProfileDir = userDataDir;
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  activeChrome = chrome;

  let target = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* still starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome DevTools endpoint never became ready.');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  activeWs = ws;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  const pageErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  stage('navigating to app');
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);

  // ---- Seed: project -> volume -> 2 chapters ----
  stage('seeding project and outline');
  const seed = await cdp.eval(`(async () => {
    const dbMod = await import('/src/db/index.ts');
    const svc = await import('/src/services/index.ts');
    await dbMod.initDatabase();
    const p = await svc.projectService.createProject({ title: 'Writing UI Project' });
    const vol = await svc.outlineService.createVolume(p.id, { title: 'Book One' });
    const c1 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'The Lighthouse' });
    const c2 = await svc.outlineService.createChapter(p.id, vol.id, { title: 'The Storm' });
    localStorage.setItem('n87-p4-project', JSON.stringify({ projectId: p.id, volumeId: vol.id, c1: c1.id, c2: c2.id }));
    return { projectId: p.id, volumeId: vol.id, c1: c1.id, c2: c2.id };
  })()`);
  record('seed project + volume + 2 chapters', !!seed?.c1 && !!seed?.c2, JSON.stringify(seed));

  // ---- 1. Opening a chapter creates an empty draft (idempotently) ----
  const opened = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1, projectId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const a = await svc.manuscriptService.openChapterDraft(projectId, c1);
    const b = await svc.manuscriptService.openChapterDraft(projectId, c1);
    return {
      created: a.created,
      secondCreated: b.created,
      sameId: a.draft.id === b.draft.id,
      revision: b.draft.revision,
      siblings: a.siblings.length,
      title: a.title,
      locked: a.locked,
    };
  })()`);
  record(
    'openChapterDraft: creates once, reuses on reopen, exposes siblings',
    opened?.created === true &&
      opened?.secondCreated === false &&
      opened?.sameId === true &&
      opened?.siblings === 2 &&
      opened?.title === 'The Lighthouse' &&
      opened?.locked === false,
    JSON.stringify(opened),
  );

  // ---- 2. Save stores Markdown + derived counters + increments revision ----
  const saved = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1, projectId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const content = '# Opening\\n\\nThe **lamp** swept the sea.\\n\\n- one\\n- two';
    const r1 = await svc.manuscriptService.saveChapterDraft(projectId, c1, { content, expectedRevision: 0 });
    const noop = await svc.manuscriptService.saveChapterDraft(projectId, c1, { content, expectedRevision: r1.draft.revision });
    const r2 = await svc.manuscriptService.saveChapterDraft(projectId, c1, { content: content + '\\n\\nMore.', expectedRevision: noop.draft.revision });
    return {
      r1Changed: r1.changed,
      r1Revision: r1.draft.revision,
      words: r1.draft.wordCount,
      chars: r1.draft.characterCount,
      plainHasSyntax: /[#*]/.test(r1.draft.plainText),
      noopChanged: noop.changed,
      noopRevision: noop.draft.revision,
      r2Revision: r2.draft.revision,
      r2Words: r2.draft.wordCount,
    };
  })()`);
  record(
    'saveChapterDraft: counters derived, revision bumps only on real changes',
    saved?.r1Changed === true &&
      saved?.r1Revision === 1 &&
      saved?.words === 8 &&
      saved?.plainHasSyntax === false &&
      saved?.noopChanged === false &&
      saved?.noopRevision === 1 &&
      saved?.r2Revision === 2 &&
      saved?.r2Words === 9,
    JSON.stringify(saved),
  );

  // ---- 3. A stale revision is rejected (autosave concurrency guard) ----
  const conflict = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1, projectId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    try {
      await svc.manuscriptService.saveChapterDraft(projectId, c1, { content: 'stale', expectedRevision: 0 });
      return { threw: false };
    } catch (e) {
      return { threw: true, name: e.name, current: e.currentRevision, expected: e.expectedRevision };
    }
  })()`);
  record(
    'saveChapterDraft: stale expectedRevision → DraftConflictError (no overwrite)',
    conflict?.threw === true && conflict?.name === 'DraftConflictError' && conflict?.current === 2,
    JSON.stringify(conflict),
  );

  // ---- 4. Version snapshots + restore keeps history append-only ----
  const versions = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1, projectId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const manual = await svc.manuscriptService.createManualVersion('chapter', c1, 'before rewrite');
    const before = await svc.manuscriptService.listVersions(manual.draftId);
    // Restore the manual snapshot after changing the text.
    const current = await svc.manuscriptService.getDraft('chapter', c1);
    await svc.manuscriptService.saveChapterDraft(projectId, c1, { content: 'rewritten text', expectedRevision: current.revision });
    const restored = await svc.manuscriptService.restoreVersion(manual.id);
    const after = await svc.manuscriptService.listVersions(manual.draftId);
    return {
      beforeCount: before.length,
      afterCount: after.length,
      restoreReason: after[0]?.reason,
      restoredContent: restored.draft.content.slice(0, 20),
      revisionAfter: restored.draft.revision,
      newestFirst: after.every((v, i) => i === 0 || after[i - 1].revision >= v.revision),
    };
  })()`);
  record(
    'versions: manual snapshot, restore is append-only and newest-first',
    versions?.beforeCount >= 1 &&
      versions?.afterCount === versions?.beforeCount + 1 &&
      versions?.restoreReason === 'restore' &&
      versions?.restoredContent.startsWith('# Opening') &&
      versions?.newestFirst === true,
    JSON.stringify(versions),
  );

  // ---- 5. Locked (final) chapters refuse writes ----
  const locked = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { c1, projectId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    await svc.outlineService.updateChapter(c1, { status: 'final' });
    const opened = await svc.manuscriptService.openChapterDraft(projectId, c1);
    let errorName = null;
    try {
      await svc.manuscriptService.saveChapterDraft(projectId, c1, { content: 'nope' });
    } catch (e) {
      errorName = e.name;
    }
    await svc.outlineService.updateChapter(c1, { status: 'drafting' });
    return { lockedFlag: opened.locked, errorName };
  })()`);
  record(
    'locked chapter: editor is read-only and the service refuses writes',
    locked?.lockedFlag === true && locked?.errorName === 'ChapterLockedError',
    JSON.stringify(locked),
  );

  // ---- 6. Markdown import: preview writes nothing, import creates chapters ----
  const imported = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId, volumeId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const md = '## The Storm\\n\\nRain fell hard.\\n\\n## A New Chapter\\n\\nSomething began.';
    const existing = await svc.outlineService.listChapters(volumeId);
    const preview = svc.manuscriptTransferService.previewImport(md, existing);
    const afterPreview = await svc.outlineService.listChapters(volumeId);
    const result = await svc.manuscriptTransferService.importMarkdown(projectId, volumeId, md, { volumeId, onDuplicate: 'skip' });
    const after = await svc.outlineService.listChapters(volumeId);
    return {
      previewCount: preview.length,
      previewWroteNothing: afterPreview.length === existing.length,
      duplicateDetected: preview[0].existingChapterId !== null,
      created: result.createdChapterIds.length,
      skipped: result.skippedTitles,
      importedWords: result.importedWords,
      totalChapters: after.length,
    };
  })()`);
  record(
    'Markdown import: preview is a dry run, duplicates skipped, prose written',
    imported?.previewCount === 2 &&
      imported?.previewWroteNothing === true &&
      imported?.duplicateDetected === true &&
      imported?.created === 1 &&
      imported?.skipped?.length === 1 &&
      imported?.importedWords === 2 &&
      imported?.totalChapters === 3,
    JSON.stringify(imported),
  );

  // ---- 7. Export round-trips: exactly one heading per chapter ----
  const roundTrip = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { splitMarkdownChapters } = await import('/src/utils/manuscript-text.ts');
    const { projectId, volumeId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const md = await svc.manuscriptTransferService.exportVolume(projectId, volumeId);
    const chapters = splitMarkdownChapters(md);
    const expected = (await svc.outlineService.listChapters(volumeId)).map((c) => c.title);
    return {
      headings: (md.match(/^## /gm) || []).length,
      parsed: chapters.length,
      titles: chapters.map((c) => c.title),
      expectedCount: expected.length,
      matchesOutline: expected.every((t, i) => chapters[i]?.title === t),
    };
  })()`);
  record(
    'export→import: one heading per chapter, matches the outline exactly',
    roundTrip?.headings === roundTrip?.expectedCount &&
      roundTrip?.parsed === roundTrip?.expectedCount &&
      roundTrip?.matchesOutline === true,
    JSON.stringify(roundTrip),
  );

  // ---- 7b. Headings inside a chapter never split it again ----
  // Built with String.fromCharCode(10) so no newline escaping is needed
  // inside the template literal passed to the page.
  const nested = await cdp.eval(`(async () => {
    const NL = String.fromCharCode(10);
    const { splitMarkdownChapters, normaliseChapterHeadings } = await import('/src/utils/manuscript-text.ts');
    const source = ['A #tag line', '', '# Inner title', '', 'body', '', '## Sub inner', '', 'more'].join(NL);
    const stored = normaliseChapterHeadings(source);
    const reparsed = splitMarkdownChapters('## Outer' + NL + stored);
    return {
      stored,
      reparsedCount: reparsed.length,
      firstTitle: reparsed[0] ? reparsed[0].title : null,
      keepsInner: stored.indexOf('### Inner title') >= 0 && stored.indexOf('### Sub inner') >= 0,
    };
  })()`);
  record(
    'in-chapter headings are demoted so re-importing cannot split the chapter',
    nested?.reparsedCount === 1 && nested?.firstTitle === 'Outer' && nested?.keepsInner === true,
    JSON.stringify(nested),
  );

  // ---- 8. Word totals aggregate chapter + scene prose ----
  const totals = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const { projectId, volumeId, c1 } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const total = await svc.manuscriptService.countProjectWords(projectId);
    const before = await import('/src/db/index.ts').then((m) => m.db.chapterDrafts.where('projectId').equals(projectId).count());
    return { total, before };
  })()`);
  record('countProjectWords: aggregates persisted prose', totals?.total > 0, JSON.stringify(totals));

  // ---- 9. Deleting a chapter removes its draft AND its versions ----
  const cascade = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const db = await import('/src/db/index.ts');
    const { c1 } = JSON.parse(localStorage.getItem('n87-p4-project'));
    const draftIdsBefore = (await db.db.chapterDrafts.where('ownerId').equals(c1).toArray()).map((d) => d.id);
    const versionCount = async (ids) =>
      ids.length === 0 ? 0 : db.db.draftVersions.where('draftId').anyOf(ids).count();
    const versionsBefore = await versionCount(draftIdsBefore);
    await svc.outlineService.deleteChapter(c1);
    const draftAfter = await db.db.chapterDrafts.where('ownerId').equals(c1).count();
    const versionsAfter = await versionCount(draftIdsBefore);
    return { draftsBefore: draftIdsBefore.length, versionsBefore, draftAfter, versionsAfter };
  })()`);
  record(
    'cascade: deleting a chapter removes its draft AND every version',
    cascade?.draftsBefore === 1 &&
      cascade?.versionsBefore > 0 &&
      cascade?.draftAfter === 0 &&
      cascade?.versionsAfter === 0,
    JSON.stringify(cascade),
  );

  // ---- 10. Deleting the project leaves no manuscript rows ----
  const cleaned = await cdp.eval(`(async () => {
    const svc = await import('/src/services/index.ts');
    const dbMod = await import('/src/db/index.ts');
    const { projectId } = JSON.parse(localStorage.getItem('n87-p4-project'));
    await svc.projectService.deleteProject(projectId);
    return {
      chapterDrafts: await dbMod.db.chapterDrafts.where('projectId').equals(projectId).count(),
      sceneDrafts: await dbMod.db.sceneDrafts.where('projectId').equals(projectId).count(),
      versions: await dbMod.db.draftVersions.where('projectId').equals(projectId).count(),
      chapters: await dbMod.db.chapters.where('projectId').equals(projectId).count(),
    };
  })()`);
  record(
    'cascade: project delete leaves no manuscripts or versions',
    Object.values(cleaned ?? {}).every((v) => v === 0),
    JSON.stringify(cleaned),
  );

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
  .then(() => {
    teardown();
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error('HARNESS ERROR:', error);
    teardown();
    process.exit(1);
  });
