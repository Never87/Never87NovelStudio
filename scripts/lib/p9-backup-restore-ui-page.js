/**
 * In-page driver for `p9-backup-restore-ui-verify.cjs` (P9 Batch 4-3 — REAL UI).
 *
 * NOT executed by Node. The harness reads this text and evaluates the exported
 * functions in a headless-Chrome tab against the REAL rendered app. File
 * selection is performed by the harness via CDP `DOM.setFileInputFiles`; this
 * driver performs DOM reads and clicks ONLY and returns plain data.
 *
 * It NEVER fabricates restore results — every action clicks the real buttons and
 * the harness verifies the REAL IndexedDB afterwards.
 */
({
  /** Structural snapshot of the page + currently visible restore controls. */
  snapshot() {
    const text = document.body.innerText;
    const heading = document.querySelector('h1, h2')?.textContent || '';
    const hasActions = !!document.querySelector('[data-testid="backup-restore-actions"]');
    const panel = document.querySelector('[data-testid="backup-preview-panel"]');
    return {
      heading: heading.trim(),
      routeIsPlaceholder: /coming soon|under construction|placeholder/i.test(text),
      hasFileInput: !!document.querySelector('input[type="file"]'),
      hasActions,
      hasPreview: !!panel,
      mentionsNoRestorePerformed: /No restore has been performed/i.test(text),
      url: location.pathname,
    };
  },

  /** Whether the restore action buttons are present (only after valid preview). */
  restoreActions() {
    const box = document.querySelector('[data-testid="backup-restore-actions"]');
    if (!box) return { present: false };
    const newBtn = document.querySelector('[data-testid="backup-restore-new"]');
    const replaceBtn = document.querySelector('[data-testid="backup-restore-replace"]');
    const text = box.innerText;
    return {
      present: true,
      hasNew: !!newBtn,
      hasReplace: !!replaceBtn,
      newDisabled: newBtn ? newBtn.disabled : null,
      replaceDisabled: replaceBtn ? replaceBtn.disabled : null,
      showsSourceName: /Source project/i.test(text),
      mentionsFreshId: /fresh ID|new project/i.test(text),
      mentionsSafetySnapshot: /safety snapshot/i.test(text),
      mentions19Collections: /19 project collections|19 collections/i.test(text),
    };
  },

  /** Clicks a button by data-testid (returns whether it was found + enabled). */
  clickTestId(id) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return { clicked: false, reason: 'missing' };
    if (el.disabled) return { clicked: false, reason: 'disabled' };
    el.click();
    return { clicked: true };
  },

  /** Clicks a button by visible label (for dialog buttons without testids). */
  clickButton(label) {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent || '').trim().toLowerCase().includes(label.toLowerCase()),
    );
    if (!btn) return false;
    if (btn.disabled) return false;
    btn.click();
    return true;
  },

  /** Current dialog title text (or null when no dialog is open). */
  dialogTitle() {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    return (dlg.querySelector('h2')?.textContent || '').trim();
  },

  /** Reads the replace-dialog target <select> options + current value. */
  replaceTargetOptions() {
    const sel = document.querySelector('[data-testid="backup-restore-replace-target"]');
    if (!sel) return { present: false };
    const options = [...sel.options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
    return { present: true, options, value: sel.value };
  },

  /** Selects a target project in the replace dialog by id (fires change). */
  selectReplaceTarget(id) {
    const sel = document.querySelector('[data-testid="backup-restore-replace-target"]');
    if (!sel) return false;
    sel.value = id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  /** Reads the replace-dialog source/target identity block text. */
  replaceIdentityText() {
    const dlg = document.querySelector('[role="dialog"]');
    return dlg ? dlg.innerText : '';
  },

  /** Is the restore success banner visible, and its text? */
  successBanner() {
    const el = document.querySelector('[data-testid="backup-restore-success"]');
    return el ? { visible: true, text: el.innerText } : { visible: false, text: '' };
  },

  /** Is a restore-error line visible inside the current dialog? */
  restoreError() {
    const el = document.querySelector('[data-testid="backup-restore-error"]');
    return el ? { visible: true, text: el.innerText } : { visible: false, text: '' };
  },

  /** Is any restore button currently showing a loading/spinner state? */
  anyRestoreBusy() {
    const ids = ['backup-restore-new', 'backup-restore-replace', 'backup-restore-new-confirm', 'backup-restore-replace-confirm'];
    return ids.some((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el && (el.disabled || /restoring|replacing|creating/i.test(el.textContent || ''));
    });
  },

  /** Whether the modal dialog is currently open. */
  dialogOpen() {
    return !!document.querySelector('[role="dialog"]');
  },
})
