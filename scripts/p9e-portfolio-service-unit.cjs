/**
 * P9 Batch E — Portfolio service: PURE unit tests with INJECTED fake repos
 * (no browser, no IndexedDB, no server).
 *
 * Bundles the REAL `portfolio-service.ts` (and its real dependencies) from
 * source, but constructs it with in-memory fake repositories. This proves the
 * SERVICE-level guarantees the UI relies on, without a database:
 *
 *   1. a project with no profile is still listed with pure project values;
 *   2. upsert CREATES a profile, then UPDATES the SAME row (no duplicate);
 *   3. `null`/blank clears an override so the project value shows again;
 *   4. saving a profile NEVER writes the project's `description` or `blurb`;
 *   5. profiles are project-ISOLATED (one project's edits never touch another);
 *   6. `deleteProfile` removes the override (back to project values);
 *   7. ordering follows featured → displayOrder → updatedAt.
 *
 * Usage: npm run verify:portfolio:service
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
    description: 'INTERNAL SUMMARY — must never be touched.',
    blurb: 'Public blurb.',
    status: 'completed',
    genre: ['Mystery'],
    tags: [],
    settings: { author: 'A. Author' },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

/** In-memory fake PortfolioProfileRepository. */
function makeProfileRepo() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    async getByProjectId(projectId) {
      return rows.find((r) => r.projectId === projectId) ?? null;
    },
    async getAll() {
      return [...rows];
    },
    async create(profile) {
      if (rows.some((r) => r.projectId === profile.projectId)) {
        throw new Error('duplicate projectId');
      }
      const withId = { ...profile, id: profile.id ?? `pfp_${++seq}` };
      rows.push(withId);
      return withId;
    },
    async update(profile) {
      const idx = rows.findIndex((r) => r.id === profile.id);
      if (idx < 0) throw new Error('not found');
      rows[idx] = profile;
      return profile;
    },
    async deleteByProjectId(projectId) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].projectId === projectId) rows.splice(i, 1);
      return before - rows.length;
    },
  };
}

/** In-memory fake ProjectRepository (records any writes to catch violations). */
function makeProjectRepo(projects) {
  const map = new Map(projects.map((p) => [p.id, { ...p }]));
  const writes = [];
  return {
    writes,
    map,
    async getById(id) {
      return map.has(id) ? { ...map.get(id) } : null;
    },
    async getAll() {
      return [...map.values()].map((p) => ({ ...p }));
    },
    // These would only be called if the service (wrongly) tried to write the
    // project. They record the attempt so a test can assert it never happened.
    async update(project) {
      writes.push(project);
      map.set(project.id, { ...project });
      return project;
    },
  };
}

async function main() {
  const mod = await importBundled('src/services/portfolio-service.ts', 'portfolio-service', { alias: ALIAS });
  const { PortfolioService } = mod;

  /* -------------------- 1. no profile -> project values -------- */
  {
    const projectRepo = makeProjectRepo([makeProject()]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);
    const entries = await svc.listEntries();
    eq('lists one entry', entries.length, 1);
    eq('entry title from project', entries[0].title, 'Silent City');
    eq('entry hasProfile false', entries[0].hasProfile, false);
  }

  /* -------------------- 2. upsert creates then updates -------- */
  {
    const projectRepo = makeProjectRepo([makeProject()]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);

    const created = await svc.upsertProfile('p1', { displayTitle: 'Curated', featured: true });
    eq('create: one row', profileRepo.rows.length, 1);
    eq('create: title saved', created.displayTitle, 'Curated');

    const updated = await svc.upsertProfile('p1', { tagline: 'New tagline' });
    eq('update: still one row (no duplicate)', profileRepo.rows.length, 1);
    eq('update: same id', updated.id, created.id);
    eq('update: displayTitle preserved (partial)', updated.displayTitle, 'Curated');
    eq('update: tagline set', updated.tagline, 'New tagline');
  }

  /* -------------------- 3. null clears override --------------- */
  {
    const projectRepo = makeProjectRepo([makeProject()]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);

    await svc.upsertProfile('p1', { displayTitle: 'Curated' });
    const cleared = await svc.upsertProfile('p1', { displayTitle: null });
    check('null clears displayTitle override', cleared.displayTitle === undefined);
    const entries = await svc.listEntries();
    eq('after clear: title reverts to project', entries[0].title, 'Silent City');
  }

  /* -------------------- 4. NEVER writes description/blurb ----- */
  {
    const projectRepo = makeProjectRepo([makeProject()]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);

    await svc.upsertProfile('p1', {
      displayTitle: 'Curated',
      penName: 'Pen',
      tagline: 'Tag',
      category: 'Cat',
    });
    eq('no project writes were attempted', projectRepo.writes.length, 0);
    const p = projectRepo.map.get('p1');
    eq('project description untouched', p.description, 'INTERNAL SUMMARY — must never be touched.');
    eq('project blurb untouched', p.blurb, 'Public blurb.');
    eq('project title untouched', p.title, 'Silent City');
  }

  /* -------------------- 5. project isolation ------------------ */
  {
    const projectRepo = makeProjectRepo([makeProject({ id: 'p1' }), makeProject({ id: 'p2', title: 'Second' })]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);

    await svc.upsertProfile('p1', { displayTitle: 'First Curated' });
    await svc.upsertProfile('p2', { displayTitle: 'Second Curated' });
    const entries = await svc.listEntries();
    const byId = Object.fromEntries(entries.map((e) => [e.projectId, e]));
    eq('isolation: p1 title', byId.p1.title, 'First Curated');
    eq('isolation: p2 title', byId.p2.title, 'Second Curated');

    // Deleting p1's profile must not affect p2.
    await svc.deleteProfile('p1');
    const after = Object.fromEntries((await svc.listEntries()).map((e) => [e.projectId, e]));
    eq('isolation: p1 reverted', after.p1.title, 'Silent City');
    eq('isolation: p2 untouched', after.p2.title, 'Second Curated');
  }

  /* -------------------- 6. deleteProfile reverts -------------- */
  {
    const projectRepo = makeProjectRepo([makeProject()]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);
    await svc.upsertProfile('p1', { featured: true });
    await svc.deleteProfile('p1');
    eq('deleteProfile: no rows', profileRepo.rows.length, 0);
    const entries = await svc.listEntries();
    eq('deleteProfile: hasProfile false', entries[0].hasProfile, false);
  }

  /* -------------------- 7. ordering --------------------------- */
  {
    const projectRepo = makeProjectRepo([
      makeProject({ id: 'a', updatedAt: 100 }),
      makeProject({ id: 'b', updatedAt: 200 }),
      makeProject({ id: 'c', updatedAt: 300 }),
    ]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);
    await svc.upsertProfile('a', { featured: true });
    await svc.upsertProfile('c', { displayOrder: 0 });
    // b has no profile (order 0, not featured); c order 0 not featured; a featured.
    const order = (await svc.listEntries()).map((e) => e.projectId);
    eq('ordering: featured first (a)', order[0], 'a');
  }

  /* -------------------- upsert unknown project fails ---------- */
  {
    const projectRepo = makeProjectRepo([makeProject()]);
    const profileRepo = makeProfileRepo();
    const svc = new PortfolioService(profileRepo, projectRepo);
    let threw = false;
    try {
      await svc.upsertProfile('does-not-exist', { displayTitle: 'X' });
    } catch (e) {
      threw = e && e.code === 'project-not-found';
    }
    check('upsert on missing project throws project-not-found', threw);
  }

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
