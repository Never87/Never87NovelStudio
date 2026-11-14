/**
 * In-page driver for `p9-backup-ui-verify.cjs` — P9 B4-1 Backup & Restore UI,
 * driven through the real rendered DOM against the REAL app (real services,
 * real IndexedDB). Returns a JSON report object.
 *
 * The download itself is captured by the HARNESS via CDP download behaviour
 * (the click triggers a real browser download); this driver records the click,
 * the loading state and the resulting UI feedback.
 */
async () => {
  const report = {};
  try {
    const svc = await import('/src/services/index.ts');
    const dbMod = await import('/src/db/index.ts');
    await dbMod.initDatabase();
    const { projectService } = svc;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 9000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try {
          const v = await fn();
          if (v) return v;
        } catch { /* not ready */ }
        await sleep(120);
      }
      return null;
    };
    const btnByText = (re, root = document) =>
      [...root.querySelectorAll('button')].find((b) => re.test((b.textContent || '').trim()));
    const setSelect = (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const findProjectByTitle = async (title) => {
      const all = await projectService.listProjects();
      return all.find((x) => x.title === title) || null;
    };
    const A = await findProjectByTitle('Bk UI Alpha');
    const B = await findProjectByTitle('Bk UI Beta');
    report.seed = { projA: A && A.id, projB: B && B.id };

    /* ROUTE */
    {
      const h1 = await waitFor(() => {
        const el = document.querySelector('h1');
        return el && /Backup & Restore/i.test(el.textContent || '') ? el : null;
      });
      const body = document.body.innerText;
      const navLink = [...document.querySelectorAll('a')].find((a) =>
        (a.getAttribute('href') || '').includes('/data/backup-restore'),
      );
      report.route = {
        heading: h1 ? (h1.textContent || '').trim() : null,
        isPlaceholder: /under construction|ModulePlaceholder/i.test(body),
        hasPicker: Boolean(await waitFor(() => document.querySelector('#backup-project-picker'), 3000)),
        hasDownloadButton: Boolean(btnByText(/Download backup/i)),
        hasNavLink: Boolean(navLink),
        navActive: navLink
          ? navLink.getAttribute('aria-current') === 'page' || /\bactive\b/.test(navLink.className)
          : false,
      };
    }

    /* PICKER: switch to project A */
    let selectedA = false;
    {
      const picker = await waitFor(() => {
        const el = document.querySelector('#backup-project-picker');
        return el && [...el.options].some((o) => o.value === A.id) ? el : null;
      }, 5000);
      if (picker) {
        setSelect(picker, A.id);
        await sleep(400);
        selectedA = document.querySelector('#backup-project-picker').value === A.id;
      }
    }
    report.picker = { selectedA };

    /* SCOPE COPY: the page must state single-project + later-restore + snapshot distinction */
    {
      const body = document.body.innerText;
      report.scope = {
        mentionsSingleProject: /single-project/i.test(body),
        mentionsRestoreLater: /restore/i.test(body) && /later batch/i.test(body),
        mentionsSnapshotsDifferent: /snapshot/i.test(body),
        mentions19: /19 project/i.test(body) || /19 collection/i.test(body),
      };
    }

    /* DOWNLOAD: click, verify loading + success feedback + duplicate-click guard.
       A MutationObserver is installed BEFORE the click so the (very fast)
       loading transition cannot slip between polls. We also install a capture
       shim (before the click) that records the Blob + download filename the
       app hands to the browser's download machinery — this is the authoritative
       proof of the downloaded file's name and content, independent of headless
       disk-download quirks. */
    {
      const btn = await waitFor(() => btnByText(/^Download backup$/i));
      let doubleClickBlocked = false;
      let sawLoading = false;
      let success = false;
      const captured = { name: null, type: null, text: null };
      // Capture shim: intercept the object URL the app creates for the download.
      const realCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        captured.type = blob.type;
        try {
          // Read the blob asynchronously; the download click happens right after.
          blob.text().then((t) => { captured.text = t; }).catch(() => {});
        } catch { /* ignore */ }
        return realCreate(blob);
      };
      // Capture the anchor's download filename.
      const realAppend = document.body.appendChild.bind(document.body);
      document.body.appendChild = (node) => {
        if (node && node.tagName === 'A' && node.download) captured.name = node.download;
        return realAppend(node);
      };

      if (btn && !btn.disabled) {
        const obs = new MutationObserver(() => {
          const busy = btnByText(/Preparing…/i);
          const active = btnByText(/^Download backup$/i);
          if (busy) {
            sawLoading = true;
            if (busy.disabled || busy.getAttribute('aria-busy') === 'true') doubleClickBlocked = true;
          }
          if (active && (active.disabled || active.getAttribute('aria-busy') === 'true')) {
            sawLoading = true;
            doubleClickBlocked = true;
          }
        });
        obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        btn.click();
        const second = btnByText(/Preparing…/i);
        if (second && (second.disabled || second.getAttribute('aria-busy') === 'true')) doubleClickBlocked = true;
        success = Boolean(await waitFor(() => /Backup downloaded for/i.test(document.body.innerText), 12000));
        // Give the blob.text() promise a moment to resolve.
        await sleep(300);
        obs.disconnect();
      }
      URL.createObjectURL = realCreate;
      document.body.appendChild = realAppend;
      report.download = { sawLoading, success, doubleClickBlocked, captured };
    }

    /* ERROR STATE: a GENUINE failure. Delete project A from the database while
       the picker still references it (React state is not refreshed), so the
       next export genuinely cannot find the project and must throw. The UI must
       surface an error alert and must NOT claim success. */
    {
      // Clear any prior success first by switching away and back.
      const picker0 = await waitFor(() => document.querySelector('#backup-project-picker'), 6000);
      if (picker0 && B) {
        setSelect(picker0, B.id);
        await sleep(250);
        setSelect(picker0, A.id);
        await sleep(400);
      }
      // Delete A from the DB behind the page's back — keeps the picker value.
      await projectService.deleteProject(A.id);

      const btn = await waitFor(() => btnByText(/^Download backup$/i));
      let errorShown = false;
      let errorText = '';
      let falseSuccess = false;
      let clicked = false;
      const btnState = btn ? { disabled: btn.disabled } : null;
      if (btn && !btn.disabled) {
        btn.click();
        clicked = true;
        const alert = await waitFor(() => document.querySelector('[role="alert"]'), 8000);
        if (alert) {
          errorShown = true;
          errorText = (alert.textContent || '').trim();
        }
        falseSuccess = /Backup downloaded for/i.test(document.body.innerText);
      }
      report.error = { errorShown, errorText, falseSuccess, clicked, btnState };
    }

    report.noProjectStillUsable = Boolean(await waitFor(() => document.querySelector('h1'), 3000));

    return report;
  } catch (error) {
    report.crash = error && error.stack ? error.stack : String(error);
    report.crashMessage = error && error.message ? error.message : String(error);
    return report;
  }
}
