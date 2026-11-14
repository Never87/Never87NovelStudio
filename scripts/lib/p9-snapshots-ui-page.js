/**
 * In-page driver for `p9-snapshots-ui-verify.cjs` — P9 B3-3 Project Snapshots
 * UI, driven through the real rendered DOM (clicks / selects) against the REAL
 * app and the REAL Dexie/IndexedDB it uses. Returns a JSON report object.
 *
 * The restore/create/delete ACTIONS all go through the actual page UI; the
 * service is NOT mocked. Read-only DB inspection verifies effects. A REAL
 * AutosaveEngine (module) is bound after restore to prove editor safety.
 */
async () => {
  const report = {};
  try {
  const dbMod = await import('/src/db/index.ts');
  const svc = await import('/src/services/index.ts');
  const { AutosaveEngine } = await import('/src/modules/editor/autosave-engine.ts');
  await dbMod.initDatabase();
  const { db } = dbMod;
  const { projectService, outlineService, sceneService, manuscriptService } = svc;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 9000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        /* not ready */
      }
      await sleep(120);
    }
    return null;
  };
  const setSelect = (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const btnByText = (re, root = document) =>
    [...root.querySelectorAll('button')].find((b) => re.test((b.textContent || '').trim()));

  const snapCount = (projectId) => db.projectSnapshots.where('projectId').equals(projectId).count();
  const dbCounts = async (projectId) => {
    const out = {};
    for (const t of ['volumes', 'chapters', 'scenes', 'chapterDrafts', 'sceneDrafts', 'characters', 'worlds']) {
      out[t] = await db[t].where('projectId').equals(projectId).count();
    }
    return out;
  };

  /* ------------------------------------------------------------------ */
  /* Resolve the pre-seeded projects (seeded by the harness BEFORE this   */
  /* page mounted, so useProjects already loaded them). A is snapshotted  */
  /* then mutated; B is the untouched control.                           */
  /* ------------------------------------------------------------------ */
  const findProjectByTitle = async (title) => {
    const all = await projectService.listProjects();
    const p = all.find((x) => x.title === title);
    if (!p) throw new Error(`Seeded project "${title}" not found`);
    return p;
  };
  const A = await findProjectByTitle('P9 Snapshots Alpha');
  const B = await findProjectByTitle('P9 Snapshots Beta');

  // Resolve A's chapter/scene by title (seed created one of each).
  const chaptersA = await db.chapters.where('projectId').equals(A.id).toArray();
  const chA = chaptersA.find((c) => c.title === 'Alpha Chapter') || chaptersA[0];
  const scenesA = await db.scenes.where('projectId').equals(A.id).toArray();
  const scA = scenesA.find((s) => s.title === 'Alpha Scene') || scenesA[0];

  const chB = (await db.chapters.where('projectId').equals(B.id).toArray()).find(
    (c) => c.title === 'Beta Chapter',
  );

  const betaFingerprintBefore = JSON.stringify({
    project: await db.projects.get(B.id),
    volumes: await db.volumes.where('projectId').equals(B.id).toArray(),
    chapters: await db.chapters.where('projectId').equals(B.id).toArray(),
    drafts: await db.chapterDrafts.where('projectId').equals(B.id).toArray(),
  });

  report.seed = { projA: A.id, projB: B.id, chA: chA && chA.id, scA: scA && scA.id, chB: chB && chB.id };

  const selectProject = async (projectId) => {
    const picker = await waitFor(() => {
      const el = document.querySelector('#ps-project-picker');
      return el && [...el.options].some((o) => o.value === projectId) ? el : null;
    });
    if (!picker) return false;
    setSelect(picker, projectId);
    await sleep(800);
    return true;
  };

  /* =================================================================== */
  /* (ROUTE) The page renders, nav link exists/highlights.               */
  /* =================================================================== */
  {
    const h1 = await waitFor(() => {
      const el = document.querySelector('h1');
      return el && /Project Snapshots/i.test(el.textContent || '') ? el : null;
    });
    const body = document.body.innerText;
    const navLink = [...document.querySelectorAll('a')].find((a) =>
      (a.getAttribute('href') || '').includes('/data/snapshots'),
    );
    report.route = {
      heading: h1 ? (h1.textContent || '').trim() : null,
      isPlaceholder: /under construction|ModulePlaceholder/i.test(body),
      hasPicker: Boolean(await waitFor(() => document.querySelector('#ps-project-picker'), 3000)),
      hasCreateButton: Boolean(btnByText(/Create Snapshot/i)),
      hasNavLink: Boolean(navLink),
      navActive: navLink
        ? navLink.getAttribute('aria-current') === 'page' || /\bactive\b/.test(navLink.className)
        : false,
    };
  }

  /* =================================================================== */
  /* (EMPTY) Project A starts with no snapshots → empty state + CTA.     */
  /* =================================================================== */
  await selectProject(A.id);
  {
    const body = document.body.innerText;
    report.empty = {
      showsNoSnapshots: /No snapshots taken/i.test(body),
      hasCreateCta: Boolean(btnByText(/Create Snapshot/i)),
    };
  }

  /* =================================================================== */
  /* (CREATE) Click the real Create Snapshot button → real service + IDB */
  /* =================================================================== */
  const beforeCreate = await snapCount(A.id);
  {
    const picker = document.querySelector('#ps-project-picker');
    const createBtn = await waitFor(() => btnByText(/^Create Snapshot$/i));
    const diag = {
      pickerValue: picker ? picker.value : null,
      pickerSelectedText: picker && picker.selectedIndex >= 0 ? picker.options[picker.selectedIndex].textContent : null,
      createDisabled: createBtn ? createBtn.disabled : null,
      bodyHead: document.body.innerText.slice(0, 200).replace(/\s+/g, ' '),
    };
    if (createBtn && !createBtn.disabled) createBtn.click();
    const created = await waitFor(() => btnByText(/^Details$/i), 9000);
    await sleep(400);
    report.create = {
      beforeCount: beforeCreate,
      afterCount: await snapCount(A.id),
      rowRendered: Boolean(created),
      showsSuccess: /Snapshot created\./i.test(document.body.innerText),
      diag,
    };
  }

  const listA1 = await db.projectSnapshots.where('projectId').equals(A.id).toArray();
  const snap1 = listA1.sort((a, b) => b.createdAt - a.createdAt)[0];
  report.snap1Id = snap1 ? snap1.id : null;

  /* =================================================================== */
  /* (LIST) Row shows real reason/time/id + integrity verified.          */
  /* =================================================================== */
  {
    const body = document.body.innerText;
    report.list = {
      showsManualReason: /\bmanual\b/i.test(body),
      showsIntegrityVerified: /Integrity verified/i.test(body),
      showsRecordCount: /\d[\d,]* records/.test(body),
      showsShortId: snap1 ? body.includes(snap1.id.slice(0, 10)) : false,
      mentionsProject: /P9 Snapshots Alpha/.test(body),
    };
  }

  /* =================================================================== */
  /* (DETAILS) Dialog shows FULL id + digest + 19-collection table.      */
  /* =================================================================== */
  {
    const details = btnByText(/^Details$/i);
    let detailInfo = { open: false };
    if (details) {
      details.click();
      const dlg = await waitFor(() => {
        const d = document.querySelector('[role="dialog"]');
        return d && /Snapshot details/i.test(d.textContent || '') ? d : null;
      });
      if (dlg) {
        const text = dlg.textContent || '';
        const rowCount = dlg.querySelectorAll('tbody tr').length;
        detailInfo = {
          open: true,
          hasFullId: snap1 ? text.includes(snap1.id) : false,
          hasShortDigest: snap1 ? text.includes(snap1.integrity.digest.slice(0, 16)) : false,
          hasReason: /manual/i.test(text),
          hasSchemaFormat: /schema v\d+/i.test(text) && /format v\d+/i.test(text),
          hasProjectId: text.includes(A.id),
          collectionRows: rowCount,
          hasCopyControls: dlg.querySelectorAll('[aria-label^="Copy"]').length >= 2,
        };
        const close = btnByText(/^Close$/i, dlg) || dlg.querySelector('[aria-label="Close dialog"]');
        if (close) close.click();
        await sleep(300);
      }
    }
    report.details = detailInfo;
  }

  /* =================================================================== */
  /* (DELETE) Confirm required; cancel writes nothing; delete one row.   */
  /* =================================================================== */
  {
    // Create another via UI so the list has 2.
    const createBtn = await waitFor(() => btnByText(/^Create Snapshot$/i));
    if (createBtn) createBtn.click();
    await waitFor(async () => ((await snapCount(A.id)) >= 2 ? true : null), 9000);
    await sleep(400);
  }
  {
    const countBefore = await snapCount(A.id);
    const delBtn = btnByText(/^Delete$/i);
    let dialogText = null;
    let cancelLeftIntact = false;
    if (delBtn) {
      delBtn.click();
      const dlg = await waitFor(() => {
        const d = document.querySelector('[role="dialog"]');
        return d && /Delete this snapshot/i.test(d.textContent || '') ? d : null;
      });
      if (dlg) {
        dialogText = dlg.textContent || '';
        const cancel = btnByText(/^Cancel$/i, dlg.parentElement || dlg) || btnByText(/^Cancel$/i);
        if (cancel) cancel.click();
        await sleep(400);
        cancelLeftIntact = (await snapCount(A.id)) === countBefore;
      }
    }
    const delBtn2 = btnByText(/^Delete$/i);
    let actuallyDeleted = false;
    if (delBtn2) {
      delBtn2.click();
      const dlg2 = await waitFor(() => {
        const d = document.querySelector('[role="dialog"]');
        return d && /Delete this snapshot/i.test(d.textContent || '') ? d : null;
      });
      if (dlg2) {
        const confirm = btnByText(/Delete snapshot/i, dlg2) || btnByText(/Deleting…/i, dlg2);
        if (confirm) confirm.click();
        await sleep(900);
        actuallyDeleted = (await snapCount(A.id)) === countBefore - 1;
      }
    }
    const afterCounts = await dbCounts(A.id);
    report.delete = {
      dialogShown: Boolean(dialogText),
      mentionsProjectUnaffected: /project data itself is NOT affected/i.test(dialogText || ''),
      cancelLeftIntact,
      actuallyDeleted,
      projectDataIntact:
        afterCounts.volumes === 1 && afterCounts.chapters === 1 && afterCounts.scenes === 1,
    };
  }

  /* =================================================================== */
  /* (RESTORE SETUP) Force exactly one snapshot (snap1) for determinism, */
  /* then MUTATE project A after the snapshot.                           */
  /* =================================================================== */
  {
    for (const s of await db.projectSnapshots.where('projectId').equals(A.id).toArray()) {
      if (s.id !== snap1.id) await svc.projectSnapshotService.deleteSnapshot(s.id, A.id);
    }
    const refresh = btnByText(/^Refresh$/i);
    if (refresh) refresh.click();
    await sleep(500);
  }

  const volA2 = await outlineService.createVolume(A.id, { title: 'Alpha Volume 2 (post-snapshot)' });
  await outlineService.createChapter(A.id, volA2.id, { title: 'Alpha Extra Chapter' });
  const liveDraftA = await manuscriptService.getDraft('chapter', chA.id);
  await manuscriptService.saveChapterDraft(A.id, chA.id, {
    content: 'Alpha MUTATED after snapshot.',
    expectedRevision: liveDraftA.revision,
  });

  /* =================================================================== */
  /* (RESTORE CANCEL) Dialog contract + CANCEL performs NO write.        */
  /* =================================================================== */
  {
    const countsBefore = await dbCounts(A.id);
    const snapsBefore = await snapCount(A.id);
    const restoreBtn = await waitFor(() => btnByText(/^Restore$/i));
    let cancelDialogText = null;
    let cancelNoWrite = false;
    if (restoreBtn) {
      restoreBtn.click();
      const dlg = await waitFor(() => {
        const d = document.querySelector('[role="dialog"]');
        return d && /Restore this snapshot/i.test(d.textContent || '') ? d : null;
      });
      if (dlg) {
        cancelDialogText = dlg.textContent || '';
        const cancel = btnByText(/^Cancel$/i, dlg.parentElement || dlg) || btnByText(/^Cancel$/i);
        if (cancel) cancel.click();
        await sleep(400);
        const countsAfter = await dbCounts(A.id);
        cancelNoWrite =
          JSON.stringify(countsAfter) === JSON.stringify(countsBefore) &&
          (await snapCount(A.id)) === snapsBefore;
      }
    }
    report.restoreCancel = {
      dialogShown: Boolean(cancelDialogText),
      noWrite: cancelNoWrite,
      contract: {
        fullProjectNotUndo: /Full project restore, not an undo/i.test(cancelDialogText || ''),
        warnsDataAfter:
          /after/i.test(cancelDialogText || '') && /deleted/i.test(cancelDialogText || ''),
        safetySnapshot: /pre-restore safety snapshot/i.test(cancelDialogText || ''),
        rollback: /rolled back and the current project is left intact/i.test(cancelDialogText || ''),
        credentials: /API keys and provider credentials are not part/i.test(cancelDialogText || ''),
        showsTargetId: /Snapshot ID:/.test(cancelDialogText || ''),
      },
    };
  }

  /* =================================================================== */
  /* (RESTORE CONFIRM) Two-step confirm performs a REAL restore.         */
  /* =================================================================== */
  {
    const countsBefore = await dbCounts(A.id);
    const snapsBefore = await snapCount(A.id);
    const restoreBtn = await waitFor(() => btnByText(/^Restore$/i));
    let confirmClicked = false;
    if (restoreBtn) {
      restoreBtn.click();
      const dlg = await waitFor(() => {
        const d = document.querySelector('[role="dialog"]');
        return d && /Restore this snapshot/i.test(d.textContent || '') ? d : null;
      });
      if (dlg) {
        const ack =
          btnByText(/I understand, continue/i, dlg.parentElement || dlg) ||
          btnByText(/I understand, continue/i);
        if (ack) {
          ack.click();
          await sleep(300);
          const finalBtn = await waitFor(
            () => btnByText(/Restore entire project/i) || btnByText(/Restoring…/i),
            4000,
          );
          if (finalBtn) {
            finalBtn.click();
            confirmClicked = true;
            await waitFor(() => /Project restored from snapshot/i.test(document.body.innerText), 12000);
            await sleep(800);
          }
        }
      }
    }
    const countsAfter = await dbCounts(A.id);
    const snapsAfter = await snapCount(A.id);
    const restoredDraft = await manuscriptService.getDraft('chapter', chA.id);
    const safety = (await db.projectSnapshots.where('projectId').equals(A.id).toArray()).find(
      (s) => s.reason === 'pre-restore',
    );
    report.restoreConfirm = {
      confirmClicked,
      countsRevertedToSnapshot:
        countsAfter.volumes === 1 && countsAfter.chapters === 1 && countsAfter.scenes === 1,
      extraChapterGone: countsAfter.chapters < countsBefore.chapters,
      draftRestored: restoredDraft.content === 'Alpha ORIGINAL snapshot content.',
      preRestoreSafetySnapshotCreated: Boolean(safety),
      snapshotCountGrewBySafety: snapsAfter === snapsBefore + 1,
      showsSuccessNotice: /Project restored from snapshot/i.test(document.body.innerText),
      safetyMentionsInUi: /pre-restore safety snapshot/i.test(document.body.innerText),
    };
  }

  /* =================================================================== */
  /* (ISOLATION) Project B is byte-for-byte unchanged after all of this. */
  /* =================================================================== */
  {
    const betaFingerprintAfter = JSON.stringify({
      project: await db.projects.get(B.id),
      volumes: await db.volumes.where('projectId').equals(B.id).toArray(),
      chapters: await db.chapters.where('projectId').equals(B.id).toArray(),
      drafts: await db.chapterDrafts.where('projectId').equals(B.id).toArray(),
    });
    report.isolation = { betaUntouched: betaFingerprintAfter === betaFingerprintBefore };
  }

  /* =================================================================== */
  /* (SYNC) The project root reloaded; title intact (fresh read).        */
  /* =================================================================== */
  {
    const projNow = await projectService.getProject(A.id);
    report.sync = {
      projectStillExists: Boolean(projNow),
      titleIntact: projNow ? projNow.title === 'P9 Snapshots Alpha' : false,
    };
  }

  /* =================================================================== */
  /* (EDITOR) A REAL AutosaveEngine bound AFTER restore persists new     */
  /*          edits against the restored revision; pre-restore text never */
  /*          resurrects.                                                */
  /* =================================================================== */
  {
    const current = await manuscriptService.getDraft('chapter', chA.id);
    const engine = new AutosaveEngine(
      {
        save: (target, input, options) =>
          manuscriptService.saveChapterDraft(target.projectId, target.ownerId, input, options),
      },
      { debounceMs: 50, maxWaitMs: 200 },
    );
    engine.bind({
      projectId: A.id,
      ownerId: chA.id,
      revision: current.revision,
      content: current.content,
    });
    const POST = 'Alpha ORIGINAL snapshot content. A NEW post-restore sentence.';
    engine.update(POST);
    await engine.flush();
    const after = await manuscriptService.getDraft('chapter', chA.id);
    const snap = engine.snapshot();
    engine.dispose();
    report.editor = {
      persistsNewEdit: after.content === POST,
      noResurrectPreRestore: !after.content.includes('MUTATED'),
      revisionAdvanced: after.revision > current.revision,
      engineNotDirty: snap.dirty === false,
    };
  }

  /* =================================================================== */
  /* (FAILURE) Restoring a now-missing id is rejected; page stays usable. */
  /* =================================================================== */
  {
    await svc.projectSnapshotService.deleteSnapshot(snap1.id, A.id);
    let threw = false;
    let code = null;
    try {
      await svc.projectSnapshotService.restoreSnapshot(snap1.id, A.id);
    } catch (e) {
      threw = true;
      code = e && e.code ? e.code : null;
    }
    const refresh = btnByText(/^Refresh$/i);
    if (refresh) refresh.click();
    await sleep(500);
    report.failure = {
      threw,
      code,
      pageUsable: Boolean(await waitFor(() => document.querySelector('h1'), 3000)),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Cleanup                                                            */
  /* ------------------------------------------------------------------ */
  // Snapshots are NOT deleted with a project (they are independent records),
  // so remove every remaining snapshot for both projects first, then the
  // projects themselves.
  for (const pid of [A.id, B.id]) {
    for (const s of await db.projectSnapshots.where('projectId').equals(pid).toArray()) {
      try {
        await svc.projectSnapshotService.deleteSnapshot(s.id, pid);
      } catch {
        /* already gone */
      }
    }
  }
  for (const p of await projectService.listProjects()) await projectService.deleteProject(p.id);
  report.cleanup = {
    projects: await db.projects.count(),
    snapshots: await db.projectSnapshots.count(),
  };

  return report;
  } catch (error) {
    report.crash = error && error.stack ? error.stack : String(error);
    report.crashMessage = error && error.message ? error.message : String(error);
    return report;
  }
}
