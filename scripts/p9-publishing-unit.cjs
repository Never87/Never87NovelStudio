/**
 * P9 Batch A — Publishing Foundation: PURE unit tests (no browser, no UI).
 *
 * Exercises the REAL modules bundled from source with the project's own Vite
 * pipeline (`scripts/lib/p4-bundler.cjs`), so the code under test is what ships:
 *
 *   1. Preset registry        — all built-in ids, stable lookup/list, default,
 *                               unknown-id error, immutable under pipeline use.
 *   2. Formatting pipeline    — volume/chapter heading policy, paragraph layout,
 *                               Unicode preservation, empty inputs, immutability,
 *                               determinism; Markdown hierarchy discipline.
 *   3. Writers (TXT/MD/HTML)  — same IR, correct structure, HTML escaping of
 *                               <script>/quotes/&, no text loss, UTF-8.
 *   4. Filename utilities     — reserved/control chars, Chinese, empty, reserved
 *                               names, long names (surrogate pairs), extension.
 *   5. Book assembly service  — canonical order, missing drafts kept, ChapterDraft
 *                               is the prose source, scenes never appended,
 *                               project isolation, determinism, read-only.
 *
 * Usage: npm run verify:publishing
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

/* ------------------------------------------------------------- fake DB ---- */

/**
 * Minimal in-memory stand-in for `NovelStudioDb`, implementing exactly what the
 * project / outline / scene / manuscript repositories use:
 *   table.get(id), table.where(col).equals(v).{toArray,first,count,anyOf}
 */
function createFakeDb() {
  const names = ['projects', 'volumes', 'chapters', 'scenes', 'chapterDrafts', 'sceneDrafts'];
  const stores = {};
  for (const name of names) stores[name] = [];

  function tableApi(name) {
    const rows = () => stores[name];
    return {
      get: async (id) => rows().find((r) => r.id === id),
      toArray: async () => rows().slice(),
      where: (col) => ({
        equals: (value) => ({
          toArray: async () => rows().filter((r) => r[col] === value),
          count: async () => rows().filter((r) => r[col] === value).length,
          first: async () => rows().find((r) => r[col] === value),
        }),
        anyOf: (values) => ({
          toArray: async () => rows().filter((r) => values.includes(r[col])),
        }),
      }),
    };
  }

  const db = { stores };
  for (const name of names) db[name] = tableApi(name);
  return db;
}

const T0 = 1_700_000_000_000;

function makeProject(id, title, extra = {}) {
  return {
    id, title, description: extra.description ?? '', status: 'writing',
    genre: extra.genre ?? [], tags: extra.tags ?? [],
    settings: extra.settings ?? {}, createdAt: T0, updatedAt: T0 + 1000,
  };
}

function makeVolume(id, projectId, title, createdAt) {
  return { id, projectId, title, summary: '', createdAt, updatedAt: createdAt };
}

function makeChapter(id, volumeId, projectId, title, order, createdAt = T0) {
  return {
    id, volumeId, projectId, title, order, summary: '', goal: '', keyEvents: '',
    endingHook: '', status: 'drafted', characterIds: [], tags: [], createdAt, updatedAt: createdAt,
  };
}

function makeChapterDraft(id, projectId, ownerId, content) {
  return {
    id, projectId, ownerId, kind: 'chapter', content, plainText: content,
    wordCount: 0, characterCount: 0, revision: 1, createdAt: T0, updatedAt: T0,
  };
}

function makeSceneDraft(id, projectId, ownerId, content) {
  return {
    id, projectId, ownerId, kind: 'scene', content, plainText: content,
    wordCount: 0, characterCount: 0, revision: 1, createdAt: T0, updatedAt: T0,
  };
}

function makeScene(id, chapterId, projectId, title, order) {
  return {
    id, chapterId, projectId, title, order, summary: '', location: '', timeOfDay: '',
    characterIds: [], goal: '', conflict: '', turningPoint: '', outcome: '', purpose: 'setup',
    status: 'drafted', tags: [], createdAt: T0, updatedAt: T0,
  };
}

/* ------------------------------------------------------------------ main -- */

(async () => {
  let presets;
  let pipeline;
  let writers;
  let filename;
  let assembly;
  let servicesIndex;
  try {
    presets = await importBundled('src/modules/publishing/presets.ts', 'p9-pub-presets', { alias: ALIAS });
    pipeline = await importBundled('src/modules/publishing/formatting-pipeline.ts', 'p9-pub-pipeline', { alias: ALIAS });
    writers = await importBundled('src/modules/publishing/writers/index.ts', 'p9-pub-writers', { alias: ALIAS });
    filename = await importBundled('src/modules/publishing/filename.ts', 'p9-pub-filename', { alias: ALIAS });
    assembly = await importBundled('src/services/book-assembly-service.ts', 'p9-pub-assembly', { alias: ALIAS });
    servicesIndex = await importBundled('src/services/index.ts', 'p9-services-index', { alias: ALIAS });
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

  /* ==================== test bodies (hoisted) ==================== */
  async function runAll() {
    await testPresets();
    await testPipeline();
    await testWriters();
    await testHtmlEscaping();
    await testUnicode();
    await testFilename();
    await testAssembly();
    await testServiceIndex();
  }

  async function testPresets() {
    const { getPreset, listPresets, hasPreset, getDefaultPreset, BUILTIN_PRESET_IDS, DEFAULT_PRESET_ID, UnknownPresetError } = presets;
    const required = ['generic', 'qidian', 'jinjiang', 'fanqie', 'wattpad', 'royal-road', 'amazon-kdp', 'generic-epub'];
    eq('presets: all required built-in ids are present', required.filter((id) => hasPreset(id)), required);
    eq('presets: BUILTIN_PRESET_IDS lists exactly the required ids', [...BUILTIN_PRESET_IDS], required);
    eq('presets: default id is generic', DEFAULT_PRESET_ID, 'generic');
    eq('presets: default preset resolves', getDefaultPreset().id, 'generic');
    check('presets: listPresets returns 8 presets in registry order',
      listPresets().length === 8 && listPresets().map((p) => p.id).join(',') === required.join(','));
    check('presets: every built-in is marked builtin', listPresets().every((p) => p.builtin === true));
    check('presets: lookup is stable (same instance)', getPreset('generic') === getPreset('generic'));

    let unknownError = null;
    try { getPreset('does-not-exist'); } catch (e) { unknownError = e; }
    check('presets: unknown id throws UnknownPresetError', unknownError instanceof UnknownPresetError);
    eq('presets: unknown error carries the id', unknownError && unknownError.presetId, 'does-not-exist');

    check('presets: qidian label is Chinese', getPreset('qidian').label === '起点中文网');
    check('presets: jinjiang label is Chinese', getPreset('jinjiang').label === '晋江文学城');
    check('presets: fanqie label is Chinese', getPreset('fanqie').label === '番茄小说');
  }

  function modelFrom(volumes, project = {}) {
    return {
      project: {
        id: project.id ?? 'proj_1', title: project.title ?? 'Test Book',
        description: project.description ?? '', author: project.author ?? 'Elara Vance',
        language: project.language ?? 'en', genre: [], tags: [],
      },
      volumes,
      totalChapters: volumes.reduce((n, v) => n + v.chapters.length, 0),
      totalWords: 0,
    };
  }
  function chapter(id, title, order, content) {
    return {
      id, volumeId: 'v', title, order, status: 'drafted', source: content ? 'draft' : 'empty',
      content, stats: { wordCount: 0, characterCount: 0 }, sceneCount: 0,
    };
  }
  function volume(id, title, chapters) {
    return { id, title, summary: '', chapters };
  }

  async function testPipeline() {
    const { getPreset } = presets;
    const { FormattingPipeline, renderDocument } = pipeline;
    const model = modelFrom([
      volume('vol_1', 'The Beginning', [
        chapter('c1', 'The Storm', 0, 'Rain fell.\n\nShe waited.'),
        chapter('c2', 'Aftermath', 1, 'Morning came.'),
      ]),
    ]);

    const generic = getPreset('generic');
    const ir = new FormattingPipeline().render(model, generic);
    check('pipeline: generic emits a volume heading', ir.volumes[0].heading !== null && ir.volumes[0].heading.type === 'heading');
    check('pipeline: volume heading carries the title', ir.volumes[0].heading.text.includes('The Beginning'));
    check('pipeline: chapter heading is a level-2 node', ir.volumes[0].chapters[0].blocks[0].type === 'heading' && ir.volumes[0].chapters[0].blocks[0].level === 2);
    check('pipeline: chapter heading includes the title', ir.volumes[0].chapters[0].blocks[0].text.includes('The Storm'));
    check('pipeline: chapters numbered globally (1, 2)',
      ir.volumes[0].chapters[0].blocks[0].text.includes('1') && ir.volumes[0].chapters[1].blocks[0].text.includes('2'));
    check('pipeline: paragraph blocks preserve body text',
      ir.volumes[0].chapters[0].blocks.some((b) => b.type === 'paragraph' && b.text.includes('Rain fell.')));

    const irW = renderDocument(model, getPreset('wattpad'));
    check('pipeline: wattpad hides the volume heading', irW.volumes[0].heading === null);
    check('pipeline: records the preset id', irW.presetId === 'wattpad');

    const cnModel = modelFrom([volume('v1', '卷一', [chapter('cc', '第一章 雨夜', 0, '他走进了雨中。\n\n她没有动。')])],
      { title: '我的小说', author: '作者' });
    const irCn = new FormattingPipeline().render(cnModel, getPreset('qidian'));
    const flatCn = JSON.stringify(irCn);
    check('pipeline: Chinese title preserved', flatCn.includes('我的小说'));
    check('pipeline: Chinese chapter body preserved', flatCn.includes('他走进了雨中。'));

    const emptyIr = new FormattingPipeline().render(modelFrom([]), generic);
    check('pipeline: empty project yields no volumes', emptyIr.volumes.length === 0);
    check('pipeline: empty project still has metadata', emptyIr.metadata.title === 'Test Book');

    const emptyChapModel = modelFrom([volume('v', 'V', [chapter('e1', 'Silent', 0, '')])]);
    const irEmptyChap = new FormattingPipeline().render(emptyChapModel, getPreset('royal-road'));
    check('pipeline: empty chapter keeps its heading block', irEmptyChap.volumes[0].chapters[0].blocks[0].type === 'heading');

    const modelSnapshot = JSON.stringify(model);
    const presetSnapshot = JSON.stringify(generic);
    new FormattingPipeline().render(model, generic);
    check('pipeline: input model is not mutated', JSON.stringify(model) === modelSnapshot);
    check('pipeline: input preset is not mutated', JSON.stringify(generic) === presetSnapshot);

    const a = JSON.stringify(new FormattingPipeline().render(model, generic));
    const b = JSON.stringify(new FormattingPipeline().render(model, generic));
    eq('pipeline: deterministic IR for unchanged input', a, b);

    const innerModel = modelFrom([volume('v', 'V', [chapter('h1', 'Real', 0, '# Inner\n\nbody')])]);
    const irInner = new FormattingPipeline().render(innerModel, generic);
    const internalHeading = irInner.volumes[0].chapters[0].blocks.find((bl) => bl.type === 'heading' && bl.text.includes('Inner'));
    check('pipeline: internal # heading demoted to level >= 3 (round-trip safe)', internalHeading && internalHeading.level >= 3, JSON.stringify(internalHeading));

    const sbModel = modelFrom([volume('v', 'V', [chapter('s1', 'S', 0, 'one\n\n* * *\n\ntwo')])]);
    const irSb = new FormattingPipeline().render(sbModel, getPreset('amazon-kdp'));
    const sb = irSb.volumes[0].chapters[0].blocks.find((bl) => bl.type === 'scene-break');
    check('pipeline: explicit scene break block produced', !!sb);
    check('pipeline: scene break uses the preset representation', sb && sb.text === getPreset('amazon-kdp').sceneBreak);
  }

  async function testWriters() {
    const { getPreset } = presets;
    const { FormattingPipeline } = pipeline;
    const { renderTxt, renderMarkdown, renderHtml } = writers;
    const model = modelFrom(
      [volume('vol_1', 'The Beginning', [
        chapter('c1', 'The Storm', 0, 'Rain fell.\n\nShe waited.'),
        chapter('c2', 'Aftermath', 1, 'Morning **came** in `gold`.'),
      ])],
      { title: 'My Great Novel', author: 'Elara Vance', language: 'en' },
    );
    const ir = new FormattingPipeline().render(model, getPreset('generic'));

    const txt = renderTxt(ir);
    check('txt: is a string', typeof txt === 'string');
    check('txt: contains chapter titles', txt.includes('The Storm') && txt.includes('Aftermath'));
    check('txt: contains body text', txt.includes('Rain fell.') && txt.includes('She waited.'));
    check('txt: strips Markdown markers', !txt.includes('**') && !txt.includes('`'));
    check('txt: keeps the emphasised words', txt.includes('came') && txt.includes('gold'));
    check('txt: ends with a single newline', txt.endsWith('\n') && !txt.endsWith('\n\n'));

    const md = renderMarkdown(ir);
    check('md: emits chapter headings with ## (level-2 chapter node)', /^## .*The Storm/m.test(md));
    check('md: emits a document title heading (#)', /^# .*My Great Novel/m.test(md));
    check('md: preserves inline Markdown (** and `)', md.includes('**came**') && md.includes('`gold`'));
    check('md: ends with a single newline', md.endsWith('\n'));

    const html = renderHtml(ir);
    check('html: is a complete document', html.startsWith('<!DOCTYPE html>') && html.trimEnd().endsWith('</html>'));
    check('html: declares utf-8 charset', html.includes('<meta charset="utf-8">'));
    check('html: has a <title> with the book title', /<title>.*My Great Novel.*<\/title>/.test(html));
    check('html: declares the language attribute', html.includes('lang="en"'));
    check('html: renders bold as <strong>', html.includes('<strong>came</strong>'));
    check('html: renders code as <code>', html.includes('<code>gold</code>'));
    check('html: body text preserved', html.includes('Rain fell.') && html.includes('She waited.'));

    for (const ch of ir.volumes[0].chapters) {
      check(`shared-IR: TXT/MD/HTML all include chapter "${ch.title}"`,
        txt.includes(ch.title) && md.includes(ch.title) && html.includes(ch.title));
    }
  }

  async function testHtmlEscaping() {
    const { getPreset } = presets;
    const { FormattingPipeline } = pipeline;
    const { renderHtml } = writers;
    const evil = [
      '<script>alert(1)</script>',
      'Tom & Jerry "quoted" and \'single\'',
      '<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1))',
    ].join('\n\n');
    const model = modelFrom(
      [volume('v', 'V', [chapter('x1', 'Evil <b>Title</b>', 0, evil)])],
      { title: 'Safe & Sound', author: 'A "B" <C>' },
    );
    const ir = new FormattingPipeline().render(model, getPreset('generic'));
    const html = renderHtml(ir);

    check('html-escape: <script> from manuscript is escaped (no live tag)',
      !/<script>alert\(1\)<\/script>/.test(html) && html.includes('&lt;script&gt;'));
    check('html-escape: raw <img onerror> is escaped', !html.includes('<img') && html.includes('&lt;img'));
    check('html-escape: ampersand in title is escaped', html.includes('Safe &amp; Sound'));
    check('html-escape: double quotes escaped', !/content="A "B"/.test(html) && html.includes('&quot;'));
    check('html-escape: single quotes escaped', html.includes('&#39;'));
    check('html-escape: manuscript text not lost', html.includes('Tom &amp; Jerry') && html.includes('click'));
    check('html-escape: heading text with <b> is escaped', !html.includes('<b>Title</b>') && html.includes('&lt;b&gt;Title&lt;/b&gt;'));
    check('html-escape: javascript: URL not emitted as a href', !/href=["']?javascript/i.test(html));
    check('html-escape: link visible text preserved', html.includes('click'));
  }

  async function testUnicode() {
    const { getPreset } = presets;
    const { FormattingPipeline } = pipeline;
    const { renderTxt, renderMarkdown, renderHtml } = writers;
    const model = modelFrom(
      [volume('v', '卷一 起风', [chapter('u1', '第一章 雨夜', 0, '他走进了雨中。\n\n她没有动。')])],
      { title: '我的小说', author: '某作者', language: 'zh-CN' },
    );
    const ir = new FormattingPipeline().render(model, getPreset('jinjiang'));
    const outputs = { txt: renderTxt(ir), md: renderMarkdown(ir), html: renderHtml(ir) };
    for (const [label, out] of Object.entries(outputs)) {
      check(`${label}: Chinese book title preserved`, out.includes('我的小说'));
      check(`${label}: Chinese body preserved`, out.includes('他走进了雨中。'));
      check(`${label}: Chinese chapter title preserved`, out.includes('雨夜'));
    }
    check('html: zh-CN language attribute emitted', outputs.html.includes('lang="zh-CN"'));
  }

  async function testFilename() {
    const { sanitizeFileName, buildFileName, buildFileNameFromTemplate, truncateUnicode } = filename;
    eq('filename: reserved chars replaced', sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
    eq('filename: control chars removed', sanitizeFileName('ab\u0000\u0007cd'), 'abcd');
    eq('filename: leading dots stripped', sanitizeFileName('...secret'), 'secret');
    eq('filename: trailing dots/spaces trimmed', sanitizeFileName('name . . '), 'name');
    eq('filename: whitespace collapsed + trimmed', sanitizeFileName('  a   b  '), 'a b');
    eq('filename: Chinese preserved', sanitizeFileName('我的小说 第一部'), '我的小说 第一部');
    eq('filename: empty falls back', sanitizeFileName(''), 'manuscript');
    eq('filename: whitespace-only falls back', sanitizeFileName('   '), 'manuscript');
    eq('filename: all-illegal falls back', sanitizeFileName('///???'), 'manuscript');
    eq('filename: reserved device name guarded', sanitizeFileName('CON'), 'CON_');
    eq('filename: reserved name case-insensitive', sanitizeFileName('Nul'), 'Nul_');

    const emoji = '\u{1F600}';
    const cut = sanitizeFileName(emoji.repeat(200), 121);
    check('filename: long name truncated to <= max length', cut.length <= 121);
    check('filename: truncation never leaves a dangling high surrogate',
      cut.charCodeAt(cut.length - 1) < 0xd800 || cut.charCodeAt(cut.length - 1) > 0xdbff);
    eq('filename: truncateUnicode keeps whole code points', truncateUnicode(emoji.repeat(3), 5), emoji.repeat(2));

    eq('filename: extension appended', buildFileName('My Novel', 'txt'), 'My Novel.txt');
    eq('filename: extension normalised', buildFileName('My Novel', '.TXT'), 'My Novel.txt');
    eq('filename: existing extension not duplicated', buildFileName('My Novel.txt', 'txt'), 'My Novel.txt');
    eq('filename: Chinese base keeps extension', buildFileName('我的小说', 'md'), '我的小说.md');
    eq('filename: empty extension returns base only', buildFileName('My Novel', ''), 'My Novel');
    check('filename: long base + extension stays <= max', buildFileName('x'.repeat(300), 'txt').length <= 120);

    eq('filename: template fills {title}', buildFileNameFromTemplate('{title}', { title: 'My Book', author: '' }, 'txt'), 'My Book.txt');
    eq('filename: template fills {title}-{author}',
      buildFileNameFromTemplate('{title} - {author}', { title: 'My Book', author: 'A' }, 'txt'), 'My Book - A.txt');
    eq('filename: template sanitises illegal chars',
      buildFileNameFromTemplate('{title}', { title: 'a/b', author: '' }, 'md'), 'a b.md');
  }

  async function testAssembly() {
    const { BookAssemblyService, BookAssemblyError } = assembly;
    const repo = async (file, name) => importBundled(file, name, { alias: ALIAS });
    const { OutlineRepository } = await repo('src/repositories/outline-repository.ts', 'p9-pub-outline-repo');
    const { ManuscriptRepository } = await repo('src/repositories/manuscript-repository.ts', 'p9-pub-ms-repo');
    const { SceneRepository } = await repo('src/repositories/scene-repository.ts', 'p9-pub-scene-repo');
    const { ProjectRepository } = await repo('src/repositories/project-repository.ts', 'p9-pub-project-repo');
    const { NarrativeRepository } = await repo('src/repositories/narrative-repository.ts', 'p9-pub-narr-repo');
    const { OutlineService } = await repo('src/services/outline-service.ts', 'p9-pub-outline-svc');
    const { ManuscriptService } = await repo('src/services/manuscript-service.ts', 'p9-pub-ms-svc');
    const { SceneService } = await repo('src/services/scene-service.ts', 'p9-pub-scene-svc');
    const { ProjectService } = await repo('src/services/project-service.ts', 'p9-pub-project-svc');
    const { getPreset } = presets;
    const { FormattingPipeline } = pipeline;
    const { renderTxt, renderMarkdown, renderHtml } = writers;

    function buildService(db) {
      const outlineService = new OutlineService(
        new OutlineRepository(db),
        new NarrativeRepository(db),
        new SceneRepository(db),
        new ManuscriptService(new ManuscriptRepository(db)),
      );
      const manuscriptService = new ManuscriptService(
        new ManuscriptRepository(db),
        new OutlineRepository(db),
        new SceneRepository(db),
      );
      const sceneService = new SceneService(
        new SceneRepository(db),
        new OutlineRepository(db),
        new ManuscriptService(new ManuscriptRepository(db)),
      );
      const projectService = new ProjectService(new ProjectRepository(db));
      return new BookAssemblyService({ outlineService, manuscriptService, sceneService, projectService });
    }

    const db = createFakeDb();
    db.stores.projects.push(makeProject('proj_A', 'Alpha Novel', { settings: { author: 'Elara', language: 'en' } }));
    // Volumes created out of title order — order must follow getOutline (creation
    // time, oldest first), NOT title. Titles deliberately reversed.
    db.stores.volumes.push(
      makeVolume('vol_1', 'proj_A', 'Zeta Volume', T0 + 10),
      makeVolume('vol_2', 'proj_A', 'Alpha Volume', T0 + 20),
    );
    db.stores.chapters.push(
      makeChapter('ch_1', 'vol_1', 'proj_A', 'First', 0),
      makeChapter('ch_2', 'vol_1', 'proj_A', 'Second', 1),
      makeChapter('ch_3', 'vol_2', 'proj_A', 'Third', 0),
      makeChapter('ch_4', 'vol_2', 'proj_A', 'Fourth', 1),
    );
    db.stores.chapterDrafts.push(
      makeChapterDraft('cd_1', 'proj_A', 'ch_1', 'Chapter one prose.'),
      makeChapterDraft('cd_2', 'proj_A', 'ch_2', 'Chapter two prose.'),
      // ch_3 has NO draft → must be kept as empty, never dropped.
      makeChapterDraft('cd_4', 'proj_A', 'ch_4', 'Chapter four prose.'),
    );
    // A scene with prose that must NOT leak into the chapter body.
    db.stores.scenes.push(makeScene('scene_1', 'ch_1', 'proj_A', 'Opening', 0));
    db.stores.sceneDrafts.push(makeSceneDraft('sd_1', 'proj_A', 'scene_1', 'SCENE PROSE SHOULD NOT APPEAR'));

    const service = buildService(db);
    const beforeSnapshot = JSON.stringify(db.stores);
    const book = await service.assembleBook('proj_A');
    const afterSnapshot = JSON.stringify(db.stores);

    eq('assembly: volume order follows outline (not title)', book.volumes.map((v) => v.id), ['vol_1', 'vol_2']);
    eq('assembly: chapter order within volume', book.volumes[0].chapters.map((c) => c.id), ['ch_1', 'ch_2']);
    eq('assembly: second volume chapter order', book.volumes[1].chapters.map((c) => c.id), ['ch_3', 'ch_4']);
    eq('assembly: total chapter count', book.totalChapters, 4);
    eq('assembly: project metadata carries author & language', [book.project.author, book.project.language], ['Elara', 'en']);

    const ch1 = book.volumes[0].chapters.find((c) => c.id === 'ch_1');
    eq('assembly: chapter prose comes from the ChapterDraft', ch1.content, 'Chapter one prose.');
    eq('assembly: chapter source marked draft', ch1.source, 'draft');

    check('assembly: scene draft prose is NOT in chapter content',
      !ch1.content.includes('SCENE PROSE') && !JSON.stringify(book).includes('SCENE PROSE'));
    eq('assembly: scene count is carried as metadata only', ch1.sceneCount, 1);

    const ch3 = book.volumes[1].chapters.find((c) => c.id === 'ch_3');
    check('assembly: missing draft is kept as a chapter', !!ch3);
    eq('assembly: missing draft source is empty', ch3.source, 'empty');
    eq('assembly: missing draft content is empty string', ch3.content, '');

    check('assembly: does not mutate the database', beforeSnapshot === afterSnapshot);

    const b1 = JSON.stringify(await service.assembleBook('proj_A'));
    const b2 = JSON.stringify(await service.assembleBook('proj_A'));
    eq('assembly: deterministic for unchanged data', b1, b2);

    db.stores.projects.push(makeProject('proj_B', 'Beta'));
    db.stores.volumes.push(makeVolume('vol_B', 'proj_B', 'Beta Vol', T0 + 30));
    db.stores.chapters.push(makeChapter('ch_B', 'vol_B', 'proj_B', 'Beta Chapter', 0));
    db.stores.chapterDrafts.push(makeChapterDraft('cd_B', 'proj_B', 'ch_B', 'Beta prose.'));
    const betaBook = await service.assembleBook('proj_B');
    eq('assembly: project isolation — Beta has only its own volume', betaBook.volumes.map((v) => v.id), ['vol_B']);
    eq('assembly: project isolation — Alpha untouched', (await service.assembleBook('proj_A')).volumes.map((v) => v.id), ['vol_1', 'vol_2']);

    let missingProject = null;
    try { await service.assembleBook('nope'); } catch (e) { missingProject = e; }
    check('assembly: missing project throws BookAssemblyError', missingProject instanceof BookAssemblyError);

    const single = await service.assembleChapter('proj_A', 'ch_2');
    eq('assembly: chapter-only assembly has one volume', single.volumes.length, 1);
    eq('assembly: chapter-only assembly has the chapter', single.volumes[0].chapters.map((c) => c.id), ['ch_2']);
    eq('assembly: chapter-only assembly uses the chapter draft', single.volumes[0].chapters[0].content, 'Chapter two prose.');

    let crossError = null;
    try { await service.assembleChapter('proj_A', 'ch_B'); } catch (e) { crossError = e; }
    check('assembly: chapter from another project throws', crossError instanceof BookAssemblyError);

    const noCounts = await service.assembleBook('proj_A', { includeSceneCounts: false });
    eq('assembly: sceneCount 0 when disabled', noCounts.volumes[0].chapters[0].sceneCount, 0);
    check('assembly: scene prose still absent when counts disabled', !JSON.stringify(noCounts).includes('SCENE PROSE'));

    const ir = new FormattingPipeline().render(book, getPreset('generic'));
    const txt = renderTxt(ir);
    check('e2e: assembled book renders to TXT with chapter prose', txt.includes('Chapter one prose.') && txt.includes('Chapter four prose.'));
    check('e2e: assembled book TXT excludes scene prose', !txt.includes('SCENE PROSE'));
    const md = renderMarkdown(ir);
    check('e2e: assembled book renders to Markdown', md.includes('## ') && md.includes('First'));
    const html = renderHtml(ir);
    check('e2e: assembled book renders to HTML', html.includes('<section class="volume"') && html.includes('Chapter one prose.'));
  }

  async function testServiceIndex() {
    check('index: exports bookAssemblyService singleton', typeof servicesIndex.bookAssemblyService === 'object' && servicesIndex.bookAssemblyService !== null);
    check('index: exports BookAssemblyService class', typeof servicesIndex.BookAssemblyService === 'function');
    check('index: exports BookAssemblyError class', typeof servicesIndex.BookAssemblyError === 'function');
    check('index: singleton is an instance of BookAssemblyService',
      servicesIndex.bookAssemblyService instanceof servicesIndex.BookAssemblyService);
    for (const method of ['assembleBook', 'assembleChapter']) {
      check(`index: singleton.${method} is a function`, typeof servicesIndex.bookAssemblyService[method] === 'function');
    }
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
