/**
 * P9 Batch E — Portfolio entry assembly: PURE unit tests (no browser/UI/server).
 *
 * Exercises the REAL `portfolio-entry.ts` bundled from source with the project's
 * own Vite pipeline. Covers:
 *
 *   - fallback precedence: profile override → project value → computed default;
 *   - the blurb is taken from `project.blurb` ONLY (never the internal
 *     `description`), proving the portfolio cannot leak/overwrite the summary;
 *   - ordering: featured first, then displayOrder, then most-recently-updated;
 *   - filtering by title/author/tag/genre/blurb;
 *   - no mutation of the input array.
 *
 * Usage: npm run verify:portfolio
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

function makeProject(overrides = {}) {
  return {
    id: 'p1',
    title: 'Silent City',
    description: 'INTERNAL SUMMARY — must never reach the portfolio.',
    blurb: 'A public back-cover hook.',
    status: 'completed',
    genre: ['Mystery'],
    tags: ['noir', 'memory'],
    settings: { author: 'A. Author', language: 'en' },
    targetWordCount: 90000,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeProfile(overrides = {}) {
  return {
    id: 'pfp1',
    projectId: 'p1',
    featured: false,
    displayOrder: 0,
    links: [],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

async function main() {
  const mod = await importBundled('src/modules/publishing/portfolio/portfolio-entry.ts', 'portfolio', { alias: ALIAS });
  const { buildPortfolioEntry, orderPortfolioEntries, filterPortfolioEntries } = mod;

  /* -------------------- no profile: pure project values --------- */
  {
    const e = buildPortfolioEntry(makeProject(), null);
    eq('no profile: title = project title', e.title, 'Silent City');
    eq('no profile: author = settings.author', e.author, 'A. Author');
    eq('no profile: blurb = project.blurb', e.blurb, 'A public back-cover hook.');
    eq('no profile: hasProfile false', e.hasProfile, false);
    eq('no profile: featured false', e.featured, false);
    eq('no profile: genre passed through', e.genre, ['Mystery']);
    eq('no profile: tags passed through', e.tags, ['noir', 'memory']);
    eq('no profile: status', e.status, 'completed');
    eq('no profile: targetWordCount', e.targetWordCount, 90000);
    eq('no profile: category null', e.category, null);
    eq('no profile: tagline null', e.tagline, null);
  }

  /* -------------------- CRITICAL: never leaks description ------- */
  {
    const e = buildPortfolioEntry(makeProject({ blurb: undefined }), null);
    eq('no blurb: entry.blurb is null', e.blurb, null);
    check('no blurb: internal description NOT used', e.blurb !== 'INTERNAL SUMMARY — must never reach the portfolio.');
    check('entry has no description field at all', !('description' in e));
  }

  /* -------------------- profile overrides win ------------------- */
  {
    const profile = makeProfile({
      displayTitle: 'The Silent City (Curated)',
      penName: 'Pen Name',
      tagline: 'A tagline',
      category: 'Space Noir',
      featured: true,
      displayOrder: 5,
      links: [{ label: 'Store', url: 'https://example.com' }],
    });
    const e = buildPortfolioEntry(makeProject(), profile);
    eq('override: displayTitle wins', e.title, 'The Silent City (Curated)');
    eq('override: penName wins', e.author, 'Pen Name');
    eq('override: tagline set', e.tagline, 'A tagline');
    eq('override: category set', e.category, 'Space Noir');
    eq('override: featured true', e.featured, true);
    eq('override: displayOrder 5', e.displayOrder, 5);
    eq('override: links passed', e.links, [{ label: 'Store', url: 'https://example.com' }]);
    eq('override: hasProfile true', e.hasProfile, true);
  }

  /* -------------------- blank override falls back --------------- */
  {
    const profile = makeProfile({ displayTitle: '   ', penName: '' });
    const e = buildPortfolioEntry(makeProject(), profile);
    eq('blank override: title falls back to project', e.title, 'Silent City');
    eq('blank override: author falls back to project', e.author, 'A. Author');
  }

  /* -------------------- missing author -------------------------- */
  {
    const e = buildPortfolioEntry(makeProject({ settings: {} }), null);
    eq('missing author: null (not empty string)', e.author, null);
  }

  /* -------------------- missing title falls back ---------------- */
  {
    const e = buildPortfolioEntry(makeProject({ title: '   ' }), null);
    eq('blank project title -> "Untitled"', e.title, 'Untitled');
  }

  /* -------------------- ordering -------------------------------- */
  {
    const base = makeProject();
    const entries = [
      buildPortfolioEntry({ ...base, id: 'a', updatedAt: 100 }, null),
      buildPortfolioEntry({ ...base, id: 'f', updatedAt: 50 }, makeProfile({ projectId: 'f', featured: true })),
      buildPortfolioEntry({ ...base, id: 'o1', updatedAt: 300 }, makeProfile({ projectId: 'o1', displayOrder: 1 })),
      buildPortfolioEntry({ ...base, id: 'o0', updatedAt: 400 }, makeProfile({ projectId: 'o0', displayOrder: 0, featured: true })),
    ];
    const ordered = orderPortfolioEntries(entries);
    // Featured first (o0 @order0, f @order0), then non-featured by displayOrder
    // (a @order0 before o1 @order1); a/o1 share no feature, so order decides.
    eq('ordering: ids', ordered.map((e) => e.projectId), ['o0', 'f', 'a', 'o1']);
    check('ordering: does not mutate input', entries.map((e) => e.projectId).join(',') === 'a,f,o1,o0');
  }

  /* -------------------- filtering ------------------------------- */
  {
    const entries = [
      buildPortfolioEntry(makeProject({ id: 'x', title: 'Alpha', settings: { author: 'Zed' } }), null),
      buildPortfolioEntry(makeProject({ id: 'y', title: 'Beta', genre: ['Fantasy'], settings: {} }), makeProfile({ projectId: 'y', tagline: 'dragon quest' })),
    ];
    eq('filter empty returns all', filterPortfolioEntries(entries, '').length, 2);
    eq('filter by title', filterPortfolioEntries(entries, 'alpha').map((e) => e.projectId), ['x']);
    eq('filter by author', filterPortfolioEntries(entries, 'zed').map((e) => e.projectId), ['x']);
    eq('filter by genre', filterPortfolioEntries(entries, 'fantasy').map((e) => e.projectId), ['y']);
    eq('filter by tagline', filterPortfolioEntries(entries, 'dragon').map((e) => e.projectId), ['y']);
    eq('filter no match', filterPortfolioEntries(entries, 'zzz').length, 0);
  }

  /* -------------------- summary --------------------------------- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (failed > 0) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail ? `(${r.detail})` : ''}`);
  }
  cleanupTemp();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
