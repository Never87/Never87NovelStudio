/**
 * In-page driver for `p9-backup-preview-ui-verify.cjs` (P9 Batch 4-2 — REAL UI).
 *
 * NOT executed by Node. The harness reads this text and evaluates the exported
 * functions in a headless-Chrome tab against the REAL rendered app. File selection
 * is performed by the harness via the CDP `DOM.setFileInputFiles` command (the
 * in-page code cannot set `input.files` itself); this driver performs DOM reads
 * and non-file interactions ONLY.
 *
 * The object below is serialised into the page; each method returns plain data.
 */
({
  /** Initial structural snapshot (route, import controls, export controls). */
  snapshot() {
    const text = document.body.innerText;
    const heading = document.querySelector('h1, h2')?.textContent || '';
    const navLink = [...document.querySelectorAll('a')].find((a) =>
      (a.getAttribute('href') || '').includes('/data/backup-restore'),
    );
    const navActive = navLink ? navLink.className.split(/\s+/).some((c) => /active|current|bg-/.test(c)) : false;
    const fileInput = document.querySelector('input[type="file"]');
    return {
      heading: heading.trim(),
      routeIsPlaceholder: /coming soon|under construction|placeholder/i.test(text),
      hasFileInput: !!fileInput,
      fileInputAccept: fileInput ? fileInput.getAttribute('accept') : null,
      hasSelectButton: /Select backup file/i.test(text) || /Choose another file/i.test(text),
      mentionsReadOnly: /Read-only preview|inspect only|only inspects/i.test(text),
      mentionsNoRestore: /No restore is performed|nothing is imported/i.test(text),
      navLink: !!navLink,
      navActive,
    };
  },

  /** Reads the current import area state (preview or error). */
  importState() {
    const panel = document.querySelector('[data-testid="backup-preview-panel"]');
    const err = document.querySelector('[data-testid="backup-import-error"]');
    if (panel) {
      const facts = {};
      panel.querySelectorAll('dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd) facts[dt.textContent.trim()] = dd.textContent.trim();
      });
      const collectionRows = panel.querySelectorAll('.grid .flex.items-center.justify-between');
      const counts = {};
      collectionRows.forEach((row) => {
        const key = row.querySelector('.font-mono')?.textContent?.trim();
        const val = row.querySelector('.tabular-nums')?.textContent?.trim();
        if (key) counts[key] = Number((val || '0').replace(/[^0-9]/g, ''));
      });
      const text = panel.innerText;
      return {
        kind: 'preview',
        text,
        facts,
        counts,
        collectionRowCount: Object.keys(counts).length,
        showsValid: /Valid backup file/i.test(text),
        showsIntegrityVerified: /verified/i.test(text),
        showsExistingWarning: !!document.querySelector('[data-testid="backup-existing-project-warning"]'),
        showsNewProjectNote: !!document.querySelector('[data-testid="backup-new-project-note"]'),
        showsNoRestore: /No restore has been performed/i.test(text),
        showsNextStepNotImplemented: /Nothing has been restored yet|restore actions below/i.test(text),
      };
    }
    if (err) {
      return { kind: 'error', text: err.innerText };
    }
    return { kind: 'none' };
  },

  /** Clicks a button by its visible label (used for Clear preview / Dismiss). */
  clickButton(label) {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent || '').trim().toLowerCase().includes(label.toLowerCase()),
    );
    if (!btn) return false;
    btn.click();
    return true;
  },

  /** Whether the import controls are still present & usable (page not crashed). */
  importUsable() {
    const fileInput = document.querySelector('input[type="file"]');
    const btns = [...document.querySelectorAll('button')];
    return !!fileInput && btns.length > 0 && document.body.innerText.length > 0;
  },
})
