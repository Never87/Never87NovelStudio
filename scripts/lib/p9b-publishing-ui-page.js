/**
 * In-page driver for `p9b-publishing-ui-verify.cjs` (P9 Batch B — REAL UI).
 *
 * NOT executed by Node. The harness evaluates these exported helpers in a
 * headless-Chrome tab against the REAL rendered app. Each helper performs DOM
 * reads / real clicks ONLY and returns plain data. It NEVER fabricates results —
 * the harness verifies real IndexedDB and real localStorage afterwards.
 */
({
  clickTestId(id) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return { clicked: false, reason: 'missing' };
    if (el.disabled) return { clicked: false, reason: 'disabled' };
    el.click();
    return { clicked: true };
  },

  clickByText(label) {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent || '').trim().toLowerCase().includes(label.toLowerCase()),
    );
    if (!btn) return false;
    if (btn.disabled) return false;
    btn.click();
    return true;
  },

  setInput(testId, value) {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) return false;
    const proto = el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    if (el.tagName !== 'SELECT') el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  checkCheckbox(testId, checked) {
    const el = document.querySelector(`[data-testid="${testId}"]`);
    if (!el) return false;
    if (el.checked !== checked) el.click();
    return true;
  },

  activePresetLabel() {
    const el = document.querySelector('[data-testid="active-preset-label"]');
    return el ? el.textContent.trim() : null;
  },

  presetCards() {
    return [...document.querySelectorAll('[data-testid="preset-card"]')].map((el) => ({
      id: el.getAttribute('data-preset-id'),
      active: el.getAttribute('data-active') === 'true',
      text: el.innerText,
    }));
  },

  presetFeedback() {
    const el = document.querySelector('[data-testid="preset-feedback"]');
    return el ? el.innerText : null;
  },

  dialogTitle() {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    return (dlg.querySelector('h2')?.textContent || '').trim();
  },

  dialogOpen() {
    return !!document.querySelector('[role="dialog"]');
  },

  dialogError() {
    const el = document.querySelector('[data-testid="preset-editor-error"]');
    return el ? el.innerText : null;
  },

  /** Export page: current chapter row checkboxes state. */
  chapterRows() {
    return [...document.querySelectorAll('[data-testid="chapter-row"]')].map((el) => ({
      id: el.getAttribute('data-chapter-id'),
      checked: el.querySelector('input[type="checkbox"]').checked,
      text: el.innerText,
    }));
  },

  selectionCount() {
    const el = document.querySelector('[data-testid="selection-count"]');
    return el ? el.innerText : null;
  },

  previewText() {
    const el = document.querySelector('[data-testid="preview-text"]');
    return el ? el.textContent : null;
  },

  exportMessage() {
    const el = document.querySelector('[data-testid="export-message"]');
    return el ? el.innerText : null;
  },

  exportError() {
    const el = document.querySelector('[data-testid="export-error"]');
    return el ? el.innerText : null;
  },

  /** Reads what the "Download" click would produce by hooking the anchor. */
  /** Intercepts the next download and returns its file name + blob text. */
  interceptDownload(triggerTestId) {
    return new Promise((resolve) => {
      const original = HTMLAnchorElement.prototype.click;
      let captured = null;
      HTMLAnchorElement.prototype.click = function patched() {
        if (this.download) {
          captured = { fileName: this.download };
          // The blob URL is same-origin object URL; fetch it to read content.
          fetch(this.href)
            .then((r) => r.text())
            .then((text) => {
              captured.text = text;
              HTMLAnchorElement.prototype.click = original;
              resolve(captured);
            })
            .catch(() => {
              HTMLAnchorElement.prototype.click = original;
              resolve(captured);
            });
        } else {
          original.call(this);
        }
      };
      const btn = document.querySelector(`[data-testid="${triggerTestId}"]`);
      if (btn) btn.click();
      // Safety timeout in case no download fires.
      setTimeout(() => {
        if (!captured) {
          HTMLAnchorElement.prototype.click = original;
          resolve(null);
        }
      }, 6000);
    });
  },

  /** Intercepts clipboard.writeText and returns the text the page copied. */
  interceptClipboard(triggerTestId) {
    return new Promise((resolve) => {
      let captured = null;
      const original = navigator.clipboard?.writeText;
      if (navigator.clipboard) {
        navigator.clipboard.writeText = (text) => {
          captured = text;
          return Promise.resolve();
        };
      }
      const btn = document.querySelector(`[data-testid="${triggerTestId}"]`);
      if (btn) btn.click();
      const start = Date.now();
      const poll = setInterval(() => {
        if (captured !== null || Date.now() - start > 5000) {
          clearInterval(poll);
          if (navigator.clipboard && original) navigator.clipboard.writeText = original;
          resolve(captured);
        }
      }, 100);
    });
  },

  selectPresetValue(pickerTestId, value) {
    const el = document.querySelector(`[data-testid="${pickerTestId}"]`);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  presetPickerValue(pickerTestId) {
    const el = document.querySelector(`[data-testid="${pickerTestId}"]`);
    return el ? el.value : null;
  },

  /** Reads a form control's value by its DOM id (for id-keyed <select>s). */
  byIdValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : null;
  },

  /** Sets a <select>'s value by DOM id and fires change (React-compatible). */
  setById(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  /** Export Manager: list of format cards (id + text + pressed state). */
  exportFormatCards() {
    return [...document.querySelectorAll('[data-testid="export-format-card"]')].map((el) => ({
      format: el.getAttribute('data-format'),
      pressed: el.getAttribute('aria-pressed') === 'true',
      text: el.innerText,
    }));
  },

  /** Export Manager: predicted file name shown in the UI. */
  predictedFileName() {
    const el = document.querySelector('[data-testid="predicted-file-name"]');
    return el ? el.textContent.trim() : null;
  },

  /** Export Manager: status messages. */
  exportManagerMessage() {
    const el = document.querySelector('[data-testid="export-manager-message"]');
    return el ? el.innerText : null;
  },
  exportManagerError() {
    const el = document.querySelector('[data-testid="export-manager-error"]');
    return el ? el.innerText : null;
  },
  pdfFontStatusText() {
    const el = document.querySelector('[data-testid="pdf-font-status"]');
    return el ? el.innerText : null;
  },

  /**
   * Intercepts the next download triggered by `triggerTestId` and returns
   * { fileName, mimeType, byteLength, headBase64 } — the blob is read as bytes
   * so binary formats (DOCX/EPUB/PDF) can be inspected, not just text.
   */
  interceptDownloadBinary(triggerTestId) {
    return new Promise((resolve) => {
      const original = HTMLAnchorElement.prototype.click;
      let captured = null;
      HTMLAnchorElement.prototype.click = function patched() {
        if (this.download) {
          const fileName = this.download;
          const href = this.href;
          fetch(href)
            .then((r) => r.arrayBuffer().then((buf) => ({ r, buf })))
            .then(({ r, buf }) => {
              const bytes = new Uint8Array(buf);
              let bin = '';
              for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
              captured = {
                fileName,
                mimeType: r.headers.get('content-type') || '',
                byteLength: bytes.length,
                headBase64: btoa(bin.slice(0, 2048)),
              };
              HTMLAnchorElement.prototype.click = original;
              resolve(captured);
            })
            .catch((err) => {
              HTMLAnchorElement.prototype.click = original;
              resolve({ fileName, error: String(err) });
            });
        } else {
          original.call(this);
        }
      };
      const btn = document.querySelector(`[data-testid="${triggerTestId}"]`);
      if (btn && !btn.disabled) btn.click();
      setTimeout(() => {
        if (!captured) {
          HTMLAnchorElement.prototype.click = original;
          resolve(null);
        }
      }, 20000);
    });
  },
})
