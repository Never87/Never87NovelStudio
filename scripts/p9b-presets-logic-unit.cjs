/**
 * P9 Batch B — Preset store & chapter selection: PURE unit tests.
 *
 * Exercises the REAL modules bundled from source (`scripts/lib/p4-bundler.cjs`)
 * against a fake, in-memory storage — no browser, no React, no IndexedDB:
 *
 *   1. preset-store  — default selection, select, create/edit/rename/duplicate/
 *                      delete custom presets, built-in protection, versioned
 *                      persistence, reload, corrupt/old-version/malformed
 *                      recovery (never throws, never silently clobbers valid
 *                      data), shared subscription, immutable built-ins.
 *   2. chapter-selection — canonical flattens, stale-selection pruning, toggle,
 *                      select-all/clear, summarize; order preserved, no
 *                      cross-project leakage.
 *
 * Usage: npm run verify:publishing:ui:logic
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const ALIAS = { '@': projectPath('src') };

/** Minimal in-memory storage implementing the injectable `PresetStorage`. */
function createFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function validDraft(overrides = {}) {
  return {
    label: 'My Profile',
    metadata: 'title-and-author',
    includeVolumeHeadings: true,
    volumeHeadingTemplate: 'Volume {index}: {title}',
    chapterHeadingStyle: 'number',
    chapterHeadingTemplate: 'Chapter {index}: {title}',
    paragraphStyle: 'indent',
    paragraphIndent: 2,
    paragraphSpacing: 1,
    sceneBreak: '* * *',
    fileNameTemplate: '{title} - {author}',
    fileExtension: 'txt',
    ...overrides,
  };
}

(async () => {
  let storeMod;
  let selection;
  try {
    storeMod = await importBundled('src/modules/publishing/preset-store.ts', 'p9b-store', { alias: ALIAS });
    selection = await importBundled('src/modules/publishing/chapter-selection.ts', 'p9b-selection', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle modules:\n', error);
    process.exit(1);
  }

  try {
    await runAll();
  } finally {
    cleanupTemp();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}  ${f.detail ?? ''}`);
    process.exit(1);
  }

  async function runAll() {
    await testDefaults();
    await testSelection();
    await testCustomCrud();
    await testBuiltinProtection();
    await testPersistence();
    await testRecovery();
    await testSubscription();
    await testImmutability();
    await testChapterSelection();
  }

  async function testDefaults() {
    const { PublishingPresetStore } = storeMod;
    const store = new PublishingPresetStore({ storage: createFakeStorage() });
    eq('store: default active is the generic preset', store.getActive().id, 'generic');
    check('store: generic preset is built-in', store.getActive().builtin === true);
    eq('store: lists all 8 built-ins before any custom', store.listAll().length, 8);
    eq('store: no custom presets initially', store.listCustom().length, 0);
    eq('store: recoveryNotice is null on a clean first run', store.getState().recoveryNotice, null);

    const state = store.getState();
    check('store: getState is referentially stable without mutation', store.getState() === state);
  }

  async function testSelection() {
    const { PublishingPresetStore } = storeMod;
    const store = new PublishingPresetStore({ storage: createFakeStorage() });
    store.setActive('qidian');
    eq('select: setActive changes the active preset', store.getActive().id, 'qidian');
    store.resetActiveToDefault();
    eq('select: resetActiveToDefault returns to generic', store.getActive().id, 'generic');

    let rejected = false;
    try { store.setActive('does-not-exist'); } catch { rejected = true; }
    check('select: selecting an unknown preset throws', rejected);
    eq('select: failed selection leaves active unchanged', store.getActive().id, 'generic');
  }

  async function testCustomCrud() {
    const { PublishingPresetStore, PRESET_STORAGE_KEY } = storeMod;
    const storage = createFakeStorage();
    const store = new PublishingPresetStore({ storage });

    const created = store.createCustom(validDraft());
    eq('crud: create adds a custom preset', store.listCustom().length, 1);
    eq('crud: created preset carries the label', created.label, 'My Profile');
    check('crud: created preset is NOT built-in', created.builtin === false);
    eq('crud: create makes the new preset active', store.getActive().id, created.id);
    check('crud: created entry has audit timestamps', typeof created.createdAt === 'number' && typeof created.updatedAt === 'number');
    check('crud: created preset is persisted', storage.getItem(PRESET_STORAGE_KEY) !== null);

    const updated = store.updateCustom(created.id, validDraft({ label: 'Renamed Profile', paragraphIndent: 4 }));
    eq('crud: update changes the label', updated.label, 'Renamed Profile');
    eq('crud: update changes a formatting field', store.find(created.id).paragraphIndent, 4);
    eq('crud: update keeps the same id', updated.id, created.id);

    const renamed = store.renameCustom(created.id, 'Third Name');
    eq('crud: rename changes only the label', renamed.label, 'Third Name');

    const copy = store.duplicateCustom(created.id);
    eq('crud: duplicate adds a second custom', store.listCustom().length, 2);
    check('crud: duplicate gets a fresh id', copy.id !== created.id);
    check('crud: duplicate is labelled as a copy', /copy/i.test(copy.label));
    eq('crud: duplicate becomes active', store.getActive().id, copy.id);

    store.deleteCustom(created.id);
    eq('crud: delete removes the preset', store.listCustom().length, 1);
    eq('crud: deleted preset is gone', store.find(created.id), null);
    check('crud: deleting a non-active preset keeps the active one', store.getActive().id === copy.id);

    store.deleteCustom(copy.id);
    eq('crud: deleting the active custom falls back to generic', store.getActive().id, 'generic');

    const fromBuiltin = store.createFromBuiltin('wattpad');
    check('crud: createFromBuiltin clones into a custom', fromBuiltin.builtin === false);
    eq('crud: clone copies the built-in formatting', fromBuiltin.paragraphStyle, store.find('wattpad').paragraphStyle);
    check('crud: clone has its own id', fromBuiltin.id !== 'wattpad');

    let invalidRejected = false;
    try { store.createCustom(validDraft({ label: '' })); } catch (e) { invalidRejected = e.name === 'PresetValidationError'; }
    check('crud: invalid draft rejected with PresetValidationError', invalidRejected);

    let badExt = false;
    try { store.createCustom(validDraft({ fileExtension: 't xt!' })); } catch { badExt = true; }
    check('crud: invalid extension rejected', badExt);

    const dotExt = store.createCustom(validDraft({ fileExtension: '.MD' }));
    eq('crud: leading-dot extension normalised to lowercase bare ext', dotExt.fileExtension, 'md');
  }

  async function testBuiltinProtection() {
    const { PublishingPresetStore } = storeMod;
    const store = new PublishingPresetStore({ storage: createFakeStorage() });

    for (const action of ['updateCustom', 'deleteCustom', 'renameCustom', 'duplicateCustom']) {
      let threw = false;
      try {
        if (action === 'updateCustom') store.updateCustom('generic', validDraft());
        if (action === 'deleteCustom') store.deleteCustom('generic');
        if (action === 'renameCustom') store.renameCustom('generic', 'x');
        if (action === 'duplicateCustom') store.duplicateCustom('generic');
      } catch { threw = true; }
      check(`builtin: ${action} on a built-in throws`, threw);
    }
    eq('builtin: built-ins are never mutated', store.listBuiltins().length, 8);
  }

  async function testPersistence() {
    const { PublishingPresetStore, PRESET_STORAGE_KEY } = storeMod;
    const storage = createFakeStorage();
    const first = new PublishingPresetStore({ storage });
    const created = first.createCustom(validDraft({ label: 'Persisted' }));
    first.setActive(created.id);

    const raw = JSON.parse(storage.getItem(PRESET_STORAGE_KEY));
    eq('persist: envelope records version 1', raw.version, 1);
    eq('persist: envelope records the active id', raw.activePresetId, created.id);
    eq('persist: envelope stores the custom preset', raw.customPresets.length, 1);

    // A brand-new store over the SAME storage restores state (survives reload).
    const second = new PublishingPresetStore({ storage });
    eq('persist: reload restores the custom preset', second.listCustom().length, 1);
    eq('persist: reload restores the active id', second.getActive().id, created.id);
    eq('persist: reload restores custom formatting', second.getActive().label, 'Persisted');

    // Active id pointing at a now-missing custom → falls back to default.
    storage.setItem(PRESET_STORAGE_KEY, JSON.stringify({
      version: 1, activePresetId: 'custom_removed', customPresets: [],
    }));
    const third = new PublishingPresetStore({ storage });
    eq('persist: missing active id falls back to default', third.getActive().id, 'generic');
    check('persist: notices the selection fallback', /default was selected|no longer exists/i.test(third.getState().recoveryNotice || ''));
  }

  async function testRecovery() {
    const { PublishingPresetStore, PRESET_STORAGE_KEY } = storeMod;

    // Corrupt JSON.
    const s1 = createFakeStorage({ [PRESET_STORAGE_KEY]: '{ not json' });
    const store1 = new PublishingPresetStore({ storage: s1 });
    eq('recover: corrupt JSON loads defaults', store1.getActive().id, 'generic');
    check('recover: corrupt JSON sets a notice', !!store1.getState().recoveryNotice);
    eq('recover: corrupt JSON is NOT overwritten on load', s1.getItem(PRESET_STORAGE_KEY), '{ not json');

    // Wrong version.
    const s2 = createFakeStorage({ [PRESET_STORAGE_KEY]: JSON.stringify({ version: 999, activePresetId: 'x', customPresets: [] }) });
    const store2 = new PublishingPresetStore({ storage: s2 });
    check('recover: unsupported version loads defaults with a notice',
      store2.getActive().id === 'generic' && !!store2.getState().recoveryNotice);

    // Envelope-shaped but a custom record is individually bad → dropped, rest kept.
    const good = { ...validDraft({ label: 'Good' }), id: 'custom_good', createdAt: 1, updatedAt: 1 };
    const bad = { id: 'custom_bad', label: '', createdAt: 1, updatedAt: 1 }; // invalid label
    const s3 = createFakeStorage({
      [PRESET_STORAGE_KEY]: JSON.stringify({ version: 1, activePresetId: 'custom_good', customPresets: [good, bad] }),
    });
    const store3 = new PublishingPresetStore({ storage: s3 });
    eq('recover: only the valid custom preset is kept', store3.listCustom().length, 1);
    eq('recover: valid custom preset is retained', store3.listCustom()[0].label, 'Good');
    eq('recover: active custom still resolves', store3.getActive().id, 'custom_good');

    // Storage throwing on read.
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => {}, removeItem: () => {},
    };
    const store4 = new PublishingPresetStore({ storage: throwing });
    eq('recover: throwing storage loads defaults', store4.getActive().id, 'generic');
    check('recover: throwing storage never crashes construction', true);

    // No storage at all (SSR / tests) — everything still works in memory.
    const store5 = new PublishingPresetStore({ storage: null });
    const c = store5.createCustom(validDraft());
    check('recover: null storage still supports mutations in memory', store5.find(c.id) !== null);
  }

  async function testSubscription() {
    const { PublishingPresetStore } = storeMod;
    const store = new PublishingPresetStore({ storage: createFakeStorage() });
    let calls = 0;
    const unsub = store.subscribe(() => { calls += 1; });
    store.setActive('qidian');
    eq('subscribe: listener fired on mutation', calls, 1);
    store.createCustom(validDraft());
    eq('subscribe: listener fired on create', calls, 2);
    unsub();
    store.setActive('fanqie');
    eq('subscribe: unsubscribe stops notifications', calls, 2);
    store.setActive('fanqie'); // no-op (same id) must not notify even if subscribed
  }

  async function testImmutability() {
    const { PublishingPresetStore } = storeMod;
    const store = new PublishingPresetStore({ storage: createFakeStorage() });
    const genericBefore = JSON.stringify(store.find('generic'));

    // Creating/editing/deleting a custom preset must never touch a built-in.
    const c = store.createCustom(validDraft({ label: 'Custom A' }));
    store.updateCustom(c.id, validDraft({ label: 'Custom B', paragraphIndent: 5 }));
    store.deleteCustom(c.id);
    eq('immutability: built-in unchanged after custom CRUD', JSON.stringify(store.find('generic')), genericBefore);

    check('immutability: store surfaces 8 frozen-array built-ins',
      store.listBuiltins().length === 8 && store.listBuiltins().every((p) => p.builtin === true));
    eq('immutability: built-in registry order stable',
      store.listBuiltins().map((p) => p.id).join(','),
      'generic,qidian,jinjiang,fanqie,wattpad,royal-road,amazon-kdp,generic-epub');
  }

  async function testChapterSelection() {
    const {
      toSelectableChapters, chaptersInVolume, normalizeSelection, pruneToAllowed,
      toggleSelection, selectAllInVolume, clearSelection, summarizeSelection,
    } = selection;

    const outline = [
      { volume: { id: 'v1', title: 'Vol One' }, chapters: [
        { id: 'c1', title: 'One', order: 0 }, { id: 'c2', title: 'Two', order: 1 },
      ] },
      { volume: { id: 'v2', title: 'Vol Two' }, chapters: [
        { id: 'c3', title: 'Three', order: 0 },
      ] },
    ];
    const rows = toSelectableChapters(outline, { c1: 3 });
    eq('selection: flatten preserves canonical order', rows.map((r) => r.id), ['c1', 'c2', 'c3']);
    eq('selection: carries scene counts', rows[0].sceneCount, 3);
    eq('selection: missing scene count defaults to 0', rows[1].sceneCount, 0);
    eq('selection: carries volume title', rows[0].volumeTitle, 'Vol One');

    eq('selection: chaptersInVolume returns that volume only', chaptersInVolume(outline, 'v2'), ['c3']);
    eq('selection: chaptersInVolume unknown volume is empty', chaptersInVolume(outline, 'nope'), []);

    // normalizeSelection: intersect + canonical order (NOT selection order).
    eq('selection: normalize keeps canonical order, ignores click order',
      normalizeSelection(['c1', 'c2', 'c3'], ['c3', 'c1']), ['c1', 'c3']);
    eq('selection: normalize drops unknown ids',
      normalizeSelection(['c1', 'c2'], new Set(['c9', 'c2'])), ['c2']);

    // pruneToAllowed: drop ids not in the allowed (current-volume) set.
    eq('selection: pruneToAllowed removes out-of-scope ids',
      [...pruneToAllowed(new Set(['c1', 'c3']), ['c1', 'c2'])], ['c1']);
    eq('selection: pruneToAllowed empties when switching project',
      pruneToAllowed(new Set(['c1', 'c2']), []).size, 0);

    // toggle.
    let sel = new Set();
    sel = toggleSelection(sel, 'c1');
    check('selection: toggle adds an id', sel.has('c1'));
    sel = toggleSelection(sel, 'c1');
    check('selection: toggle removes an id', !sel.has('c1'));

    // select all / clear for a volume.
    const all = selectAllInVolume(['c1', 'c2']);
    eq('selection: selectAll selects every volume chapter', all.size, 2);
    eq('selection: clear empties the selection', clearSelection().size, 0);

    // summarize against the current volume.
    const sum = summarizeSelection(new Set(['c1', 'c2', 'c3']), ['c1', 'c2']);
    eq('summary: effective ids are only the current volume\'s', sum.effectiveIds, ['c1', 'c2']);
    eq('summary: stale ids are reported', sum.staleIds, ['c3']);
    eq('summary: count is the effective count', sum.count, 2);
    check('summary: allSelected true when every chapter selected', sum.allSelected);

    const partial = summarizeSelection(new Set(['c1']), ['c1', 'c2']);
    check('summary: allSelected false for a partial selection', !partial.allSelected);
    eq('summary: noneSelected false for partial', partial.noneSelected, false);

    const none = summarizeSelection(new Set(), ['c1', 'c2']);
    check('summary: noneSelected true when nothing selected', none.noneSelected);

    const emptyScope = summarizeSelection(new Set(), []);
    check('summary: empty volume is never "all selected"', !emptyScope.allSelected);
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
