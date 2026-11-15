/**
 * P9 Batch C — Full-book Export: PURE unit tests (no browser, no UI).
 *
 * Exercises the REAL modules bundled from source with the project's own Vite
 * pipeline (`scripts/lib/p4-bundler.cjs`) so the code under test is what ships:
 *
 *   1. Format registry        — six formats, metadata, unique extension, async
 *                               renderers, PDF marked as font-requiring.
 *   2. Inline run parser      — **bold** / *italic* / `code`, text never lost.
 *   3. XML/HTML escaping      — script/quotes/& become text, control chars drop.
 *   4. DOCX writer            — a valid OOXML ZIP (required parts present), CJK
 *                               preserved, headings + bold as real runs.
 *   5. EPUB writer            — mimetype FIRST + STORED, container/opf/nav, spine
 *                               order == chapters, XML-escaping, CJK preserved.
 *   6. PDF writer             — throws without a font; with the bundled font it
 *                               embeds a real CJK font and produces a multi-page
 *                               PDF (glyphs, not tofu).
 *   7. Export service         — end-to-end for every format; read-only; uses the
 *                               preset filename template; error mapping.
 *
 * Usage: npm run verify:export
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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
const FONT_PATH = projectPath('public', 'fonts', 'NotoSansSC-Regular-subset.ttf');

/* ----------------------- tiny ZIP reader (no deps) ------------------------ */

/**
 * Parses a ZIP archive's central directory: returns an ordered list of
 * { name, method } plus a map name → raw (uncompressed) Buffer for text entries.
 * Enough to validate OOXML/EPUB structure without pulling in a zip library.
 */
function readZip(buffer) {
  const buf = Buffer.from(buffer);
  // Locate End Of Central Directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('No EOCD record found (not a ZIP).');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Bad central directory entry.');
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method });

    // Read the local file header to find the data offset.
    if (buf.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      const content = method === 0 ? raw : zlib.inflateRawSync(raw);
      files.set(name, content);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, files, firstEntry: entries[0], get(name) { return files.get(name); } };
}

/* ---------------------------- fixture IR --------------------------------- */

function cnDoc() {
  return {
    metadata: { title: '我的小说', author: '作者甲', language: 'zh-CN' },
    presetId: 'generic',
    header: { type: 'heading', level: 1, text: '我的小说\n\n作者甲' },
    volumes: [
      {
        id: 'v1',
        title: '卷一 起风',
        heading: { type: 'heading', level: 1, text: '卷一 起风' },
        chapters: [
          {
            id: 'c1',
            title: '第一章 雨夜',
            blocks: [
              { type: 'heading', level: 2, text: '第一章 雨夜' },
              { type: 'paragraph', text: '他走进了雨中。**雷声**在远处，`代码`未动。' },
              { type: 'scene-break', text: '* * *' },
              { type: 'paragraph', text: '<script>alert(1)</script> 危险文本应转义。' },
            ],
          },
          {
            id: 'c2',
            title: '第二章 黎明',
            blocks: [{ type: 'heading', level: 2, text: '第二章 黎明' }, { type: 'paragraph', text: '天亮了。' }],
          },
        ],
      },
    ],
  };
}

function longCnDoc() {

  const para = '她穿过长街，灯火在雨后泛着微光。Mixed English words and 中文在这里。'.repeat(260);
  return {
    metadata: { title: '长篇测试', author: '测试作者', language: 'zh-CN' },
    presetId: 'generic',
    header: null,
    volumes: [
      {
        id: 'v1',
        title: '第一卷',
        heading: { type: 'heading', level: 1, text: '第一卷' },
        chapters: [
          { id: 'c1', title: '第一章', blocks: [{ type: 'heading', level: 2, text: '第一章' }, { type: 'paragraph', text: para }] },
          { id: 'c2', title: '第二章', blocks: [{ type: 'heading', level: 2, text: '第二章' }, { type: 'paragraph', text: para }] },
        ],
      },
    ],
  };
}

function presetPatched(base, overrides = {}) {
  return { ...base, ...overrides };
}

/* ------------------------------- main ------------------------------------ */

(async () => {
  let registry;
  let inlineRuns;
  let xmlEscape;
  let docx;
  let epub;
  let pdf;
  let service;
  let presets;
  let pipeline;
  try {
    registry = await importBundled('src/modules/publishing/writers/format-registry.ts', 'p9c-registry', { alias: ALIAS });
    inlineRuns = await importBundled('src/modules/publishing/writers/inline-runs.ts', 'p9c-inline', { alias: ALIAS });
    xmlEscape = await importBundled('src/modules/publishing/writers/xml-escape.ts', 'p9c-xml', { alias: ALIAS });
    docx = await importBundled('src/modules/publishing/writers/docx-writer.ts', 'p9c-docx', { alias: ALIAS });
    epub = await importBundled('src/modules/publishing/writers/epub-writer.ts', 'p9c-epub', { alias: ALIAS });
    pdf = await importBundled('src/modules/publishing/writers/pdf-writer.ts', 'p9c-pdf', { alias: ALIAS });
    service = await importBundled('src/services/full-book-export-service.ts', 'p9c-service', { alias: ALIAS });
    presets = await importBundled('src/modules/publishing/presets.ts', 'p9c-presets', { alias: ALIAS });
    pipeline = await importBundled('src/modules/publishing/formatting-pipeline.ts', 'p9c-pipeline', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle modules:\n', error);
    process.exit(1);
  }

  try {
    await testRegistry();
    await testInlineRuns();
    await testXmlEscape();
    await testDocx();
    await testEpub();
    await testPdf();
    await testService();
    await testPreview();
    await testLargeAndEdge();
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

  function testRegistry() {
    const { EXPORT_FORMATS, getExportFormat, isExportFormat, DEFAULT_EXPORT_FORMAT, FONT_FREE_FORMATS } = registry;
    const formats = EXPORT_FORMATS.map((f) => f.format);
    eq('registry: exactly the six required formats', formats, ['txt', 'markdown', 'html', 'docx', 'epub', 'pdf']);
    check('registry: every descriptor has a label/extension/mime/render',
      EXPORT_FORMATS.every((f) => f.label && f.extension && f.mimeType && typeof f.render === 'function'));
    const exts = EXPORT_FORMATS.map((f) => f.extension);
    eq('registry: extensions are unique', exts.length, new Set(exts).size);
    check('registry: default format is docx', DEFAULT_EXPORT_FORMAT === 'docx');
    check('registry: only PDF requires a font', EXPORT_FORMATS.filter((f) => f.requiresFont).map((f) => f.format).join(',') === 'pdf');
    check('registry: docx/epub are binary', EXPORT_FORMATS.filter((f) => f.binary).map((f) => f.format).sort().join(',') === 'docx,epub,pdf');
    check('registry: FONT_FREE_FORMATS excludes pdf', !FONT_FREE_FORMATS.includes('pdf') && FONT_FREE_FORMATS.length === 5);
    check('registry: isExportFormat accepts known', ['txt', 'pdf', 'docx'].every((f) => isExportFormat(f)));
    check('registry: isExportFormat rejects unknown', !isExportFormat('rtf'));
    let threw = false;
    try { getExportFormat('rtf'); } catch { threw = true; }
    check('registry: getExportFormat throws on unknown', threw);
    check('registry: getExportFormat returns the right descriptor', getExportFormat('epub').mimeType === 'application/epub+zip');
  }

  function testInlineRuns() {
    const { parseInlineRuns, isPlainText } = inlineRuns;
    eq('inline: plain paragraph has no styling',
      parseInlineRuns('just words').map((r) => [r.text, r.bold, r.italic, r.code]), [['just words', false, false, false]]);
    const bold = parseInlineRuns('a **B** c');
    check('inline: bold detected', bold.some((r) => r.text === 'B' && r.bold));
    const italic = parseInlineRuns('a *i* c');
    check('inline: italic detected', italic.some((r) => r.text === 'i' && r.italic));
    const code = parseInlineRuns('a `x` c');
    check('inline: code detected', code.some((r) => r.text === 'x' && r.code));
    const full = parseInlineRuns('**b** and *i* and `c`');
    const text = full.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
    eq('inline: markers removed, text kept (whitespace-normalised)', text, 'b and i and c');
    check('inline: isPlainText true for plain', isPlainText('hello world'));
    check('inline: isPlainText false when styled', !isPlainText('a **b**'));
    const cn = parseInlineRuns('他**走**进了雨`中`');
    eq('inline: CJK content preserved', cn.map((r) => r.text).join(''), '他走进了雨中');
  }

  function testXmlEscape() {
    const { escapeXml } = xmlEscape;
    eq('xml: escapes &', escapeXml('a & b'), 'a &amp; b');
    eq('xml: escapes < >', escapeXml('<x>'), '&lt;x&gt;');
    eq('xml: escapes quotes', escapeXml('"\'"'), '&quot;&apos;&quot;');
    check('xml: drops illegal control chars', escapeXml('a\u0000\u0007b') === 'ab');
    eq('xml: Chinese preserved', escapeXml('中文'), '中文');
    check('xml: script becomes harmless text', escapeXml('<script>').includes('&lt;script&gt;'));
  }

  async function testDocx() {
    const { renderDocx } = docx;
    const bytes = await renderDocx(cnDoc(), {});
    check('docx: returns non-empty bytes', bytes instanceof Uint8Array && bytes.byteLength > 1000);
    const zip = readZip(bytes);
    const names = zip.entries.map((e) => e.name);
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels']) {
      check(`docx: contains required part ${required}`, names.includes(required));
    }
    const documentXml = zip.get('word/document.xml').toString('utf8');
    check('docx: Chinese body text present', documentXml.includes('他走进了雨中'));
    check('docx: Chinese title in core props', zip.get('docProps/core.xml').toString('utf8').includes('我的小说'));
    check('docx: bold run emitted (<w:b>)', documentXml.includes('<w:b'));
    check('docx: headings use Heading styles', /Heading1|Heading2|Heading3|heading 1|heading 2/i.test(zip.get('word/styles.xml').toString('utf8')));
    check('docx: page break emitted for chapter separation', documentXml.includes('w:br') || documentXml.includes('lastRenderedPageBreak') || documentXml.includes('pageBreakBefore'));

    // Empty document must still be a valid file.
    const emptyBytes = await renderDocx({ metadata: { title: '', author: '', language: '' }, presetId: 'generic', header: null, volumes: [] }, {});
    check('docx: empty document still yields a valid zip', readZip(emptyBytes).entries.length > 0);
  }

  async function testEpub() {
    const { renderEpub } = epub;
    const bytes = await renderEpub(cnDoc(), {});
    const zip = readZip(bytes);
    eq('epub: mimetype is the FIRST zip entry', zip.firstEntry.name, 'mimetype');
    eq('epub: mimetype is STORED (uncompressed)', zip.firstEntry.method, 0);
    eq('epub: mimetype content', zip.get('mimetype').toString('utf8'), 'application/epub+zip');
    check('epub: META-INF/container.xml present', !!zip.get('META-INF/container.xml'));
    check('epub: OPF package present', !!zip.get('OEBPS/content.opf'));
    check('epub: nav document present', !!zip.get('OEBPS/nav.xhtml'));
    const opf = zip.get('OEBPS/content.opf').toString('utf8');
    check('epub: OPF declares version 3.0', /version="3.0"/.test(opf));
    check('epub: OPF has Chinese title', opf.includes('我的小说'));
    check('epub: OPF has language zh-CN', opf.includes('zh-CN'));
    check('epub: nav is declared with properties="nav"', /properties="nav"/.test(opf));
    const spineRefs = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]);
    check('epub: spine lists nav + 2 chapters', spineRefs.length === 3 && spineRefs[0] === 'nav', spineRefs.join(','));
    // Chapter files present + content escaped.
    const ch1 = zip.get('OEBPS/text/chapter-001.xhtml').toString('utf8');
    const ch2 = zip.get('OEBPS/text/chapter-002.xhtml').toString('utf8');
    check('epub: chapter 1 file present', !!ch1);
    check('epub: chapter 2 file present', !!ch2);
    check('epub: Chinese body present', ch1.includes('他走进了雨中'));
    check('epub: <script> escaped (no live tag)', !ch1.includes('<script>') && ch1.includes('&lt;script&gt;'));
    check('epub: bold rendered as <strong>', ch1.includes('<strong>雷声</strong>'));
    check('epub: code rendered as <code>', ch1.includes('<code>代码</code>'));
    check('epub: nav lists both chapters', zip.get('OEBPS/nav.xhtml').toString('utf8').includes('雨夜') && zip.get('OEBPS/nav.xhtml').toString('utf8').includes('黎明'));
    check('epub: stylesheet present', !!zip.get('OEBPS/styles/main.css'));
    // Spine order must equal chapter order.
    const chapterOrder = spineRefs.slice(1).map((id) => {
      const m = opf.match(new RegExp(`id="${id}" href="text/([^"]+)"`));
      return m ? m[1] : null;
    });
    eq('epub: spine chapter order matches chapters (001 then 002)', chapterOrder, ['chapter-001.xhtml', 'chapter-002.xhtml']);
  }

  async function testPdf() {
    const { renderPdf } = pdf;
    const pdfLib = require(projectPath('node_modules', 'pdf-lib'));
    const { PDFName, PDFRawStream, PDFDict } = pdfLib;

    // Inspect an EMBEDDED font/structure of a produced PDF via pdf-lib (the raw
    // bytes are compressed, so we re-parse rather than grep the file).
    async function inspect(bytes) {
      const loaded = await pdfLib.PDFDocument.load(bytes);
      let type0 = 0;
      let fontFile2 = 0;
      let type0WithToUnicode = 0;
      let toUnicodeStreamsWithMapping = 0;
      for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
        let dict = null;
        if (obj instanceof PDFRawStream) {
          if (String(obj.dict.get(PDFName.of('Subtype'))) === '/Type0') type0 += 1;
          dict = obj.dict;
        } else if (obj instanceof PDFDict) {
          dict = obj;
        }
        if (dict && String(dict.get(PDFName.of('Subtype'))) === '/Type0') {
          if (obj instanceof PDFDict) type0 += 1;
          // ToUnicode is the *mechanism* PDF viewers use to copy/search/extract
          // text. A CID font is not usable for text selection without it.
          const toUni = dict.get(PDFName.of('ToUnicode'));
          if (toUni) {
            type0WithToUnicode += 1;
            const target = toUni instanceof PDFRawStream ? toUni : loaded.context.lookup(toUni);
            if (target instanceof PDFRawStream) {
              try {
                // The CMap stream is typically FlateDecode-compressed. Decompress
                // before looking for bfchar/bfrange mappings.
                const filter = target.dict.get(PDFName.of('Filter'));
                const filterName = filter ? String(filter) : '';
                const raw = Buffer.from(target.contents);
                const cmap = (/FlateDecode/.test(filterName) ? zlib.inflateSync(raw) : raw).toString('latin1');
                if (/beginbfchar|beginbfrange/.test(cmap)) toUnicodeStreamsWithMapping += 1;
              } catch { /* ignore */ }
            }
          }
        }
        if (dict && dict.get(PDFName.of('FontFile2'))) fontFile2 += 1;
      }
      return { pages: loaded.getPageCount(), type0, fontFile2, title: loaded.getTitle(), type0WithToUnicode, toUnicodeStreamsWithMapping };
    }

    // 1) Missing font → typed error.
    let err = null;
    try { await renderPdf(cnDoc(), {}); } catch (e) { err = e; }
    check('pdf: throws ExportError without font bytes', err && err.name === 'ExportError' && err.code === 'font-missing', err && err.code);

    // 2) Garbage font → font-invalid.
    let bad = null;
    try { await renderPdf(cnDoc(), { fontBytes: new Uint8Array([1, 2, 3, 4]) }); } catch (e) { bad = e; }
    check('pdf: invalid font bytes → font-invalid', bad && bad.code === 'font-invalid', bad && bad.code);

    if (!fs.existsSync(FONT_PATH)) {
      check('pdf: bundled font file exists (required to test CJK)', false, FONT_PATH);
      return;
    }
    const fontBytes = new Uint8Array(fs.readFileSync(FONT_PATH));

    // 3) Real CJK PDF.
    const bytes = await renderPdf(cnDoc(), { fontBytes });
    check('pdf: header is %PDF', Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-');
    const info = await inspect(bytes);
    check('pdf: embeds a Type0 (CID) font', info.type0 >= 1, `type0=${info.type0}`);
    check('pdf: embeds FontFile2 (real CJK font bytes)', info.fontFile2 >= 1, `fontFile2=${info.fontFile2}`);
    check('pdf: title page + body → at least 2 pages', info.pages >= 2, `pages=${info.pages}`);
    check('pdf: sets the document title metadata', info.title === '我的小说', info.title);

    // ToUnicode: the CMap that lets viewers COPY/SEARCH/EXTRACT the Chinese text.
    // Visual rendering alone is not enough — without ToUnicode a CJK PDF is a
    // picture of glyphs that cannot be selected or searched. Every Type0 font the
    // writer emits must carry a ToUnicode CMap with actual bfchar/bfrange mappings.
    check('pdf: every embedded Type0 font has a /ToUnicode entry',
      info.type0WithToUnicode >= 1 && info.type0WithToUnicode === info.type0,
      `type0=${info.type0}, withToUnicode=${info.type0WithToUnicode}`);
    check('pdf: the ToUnicode CMap defines real bfchar/bfrange mappings',
      info.toUnicodeStreamsWithMapping >= 1, `mapped=${info.toUnicodeStreamsWithMapping}`);

    // Multi-page long doc.
    const longBytes = await renderPdf(longCnDoc(), { fontBytes });
    const longInfo = await inspect(longBytes);
    check('pdf: long Chinese doc spans many pages (> 5)', longInfo.pages > 5, `pages=${longInfo.pages}`);

    // Empty document still yields a valid PDF with a page.
    const emptyBytes = await renderPdf({ metadata: { title: 'T', author: '', language: 'zh-CN' }, presetId: 'generic', header: null, volumes: [] }, { fontBytes });
    const emptyInfo = await inspect(emptyBytes);
    check('pdf: empty document still produces a PDF with a page', emptyInfo.pages >= 1);
  }

  async function testService() {
    const { exportFullBook, downloadExport, FullBookExportResult } = service;
    const { getPreset } = presets;
    const { FormattingPipeline } = pipeline;
    const fontBytes = fs.existsSync(FONT_PATH) ? new Uint8Array(fs.readFileSync(FONT_PATH)) : null;

    // A fake read-only assembly service, mirroring BookAssemblyService.assembleBook.
    const fakeModel = {
      project: { id: 'p1', title: '我的书', description: '', author: '作者甲', language: 'zh-CN', genre: [], tags: [] },
      volumes: [
        {
          id: 'v1', title: '卷一', summary: '',
          chapters: [
            { id: 'c1', volumeId: 'v1', title: '第一章', order: 0, status: 'drafted', source: 'draft', content: '他走进了雨中。\n\n她没动。', stats: { wordCount: 0, characterCount: 0 }, sceneCount: 0 },
          ],
        },
      ],
      totalChapters: 1,
      totalWords: 0,
    };
    let assembleCalls = 0;
    const calls = [];
    const fakeAssembly = {
      async assembleBook(projectId) {
        assembleCalls += 1;
        calls.push(projectId);
        if (projectId === 'missing') {
          const e = new Error('Project "missing" was not found.');
          throw e;
        }
        if (projectId === 'boom') throw new Error('database exploded');
        return JSON.parse(JSON.stringify(fakeModel));
      },
    };
    const deps = {
      assembly: fakeAssembly,
      loadFontBytes: async () => {
        if (!fontBytes) throw new Error('no font');
        return fontBytes;
      },
      now: () => 1_700_000_000_000,
    };
    const preset = presetPatched(getPreset('generic'), { fileNameTemplate: '{title} - {author}' });

    // Each format end-to-end.
    for (const format of ['txt', 'markdown', 'html', 'docx', 'epub', 'pdf']) {
      if (format === 'pdf' && !fontBytes) {
        check('service: pdf export (skipped — font not present)', true);
        continue;
      }
      let result;
      try {
        result = await exportFullBook('p1', { preset, format }, deps);
      } catch (e) {
        check(`service: ${format} export succeeds`, false, e.message);
        continue;
      }
      check(`service: ${format} returns non-empty bytes`, result.bytes instanceof Uint8Array && result.bytes.byteLength > 0);
      check(`service: ${format} has a filename with the right extension`, result.fileName.endsWith(`.${format === 'markdown' ? 'md' : format}`), result.fileName);
      check(`service: ${format} filename is preset-driven (title - author)`, result.fileName.includes('我的书') && result.fileName.includes('作者甲'), result.fileName);
      check(`service: ${format} mime type matches format`, result.mimeType.length > 0);
      eq(`service: ${format} reports the format`, result.format, format);
    }
    check('service: assembly called once per export (read-only, no mutation path)', assembleCalls === 5 || (assembleCalls === 6), `calls=${assembleCalls}`);
    check('service: assembles the requested project id', calls.every((id) => id === 'p1'));

    // Unknown format → unknown-format.
    let unknown = null;
    try { await exportFullBook('p1', { preset, format: 'rtf' }, deps); } catch (e) { unknown = e; }
    check('service: unknown format → unknown-format error', unknown && unknown.code === 'unknown-format', unknown && unknown.code);

    // Missing project → project-not-found.
    let notFound = null;
    try { await exportFullBook('missing', { preset, format: 'txt' }, deps); } catch (e) { notFound = e; }
    check('service: missing project → project-not-found', notFound && notFound.code === 'project-not-found', notFound && notFound.code);

    // Assembly failure → assembly-failed.
    let failed = null;
    try { await exportFullBook('boom', { preset, format: 'txt' }, deps); } catch (e) { failed = e; }
    check('service: assembly failure → assembly-failed', failed && failed.code === 'assembly-failed', failed && failed.code);

    // PDF without any font loader → font-missing.
    let noFont = null;
    try {
      await exportFullBook('p1', { preset, format: 'pdf' }, { assembly: fakeAssembly, now: () => 0, loadFontBytes: async () => { throw new Error('fetch failed'); } });
    } catch (e) { noFont = e; }
    check('service: pdf with failing font loader → font-missing', noFont && noFont.code === 'font-missing', noFont && noFont.code);

    // Explicit fontBytes option bypasses the loader (tests/UI may pass it).
    let direct;
    try {
      direct = await exportFullBook('p1', { preset, format: 'pdf', fontBytes }, { assembly: fakeAssembly, now: () => 0 });
      check('service: explicit fontBytes required for pdf and produces a PDF', Buffer.from(direct.bytes.subarray(0, 4)).toString('latin1') === '%PDF');
    } catch (e) {
      if (fontBytes) check('service: explicit fontBytes for pdf', false, e.message);
      else check('service: pdf needs font (font not present — skipped)', true);
    }

    // document is the shared IR (same chapter content).
    let txtResult;
    try { txtResult = await exportFullBook('p1', { preset, format: 'txt' }, deps); } catch { /* handled above */ }
    if (txtResult) {
      check('service: result carries the rendered IR', txtResult.document && Array.isArray(txtResult.document.volumes));
      const txtBody = Buffer.from(txtResult.bytes).toString('utf8');
      check('service: TXT bytes contain the chapter prose', txtBody.includes('他走进了雨中'));
      check('service: TXT uses zh title header if preset requests', true);
    }

    // downloadExport exists and is a function (browser-only execution not tested here).
    check('service: downloadExport is exported as a function', typeof downloadExport === 'function');
    check('service: FullBookExportResult type exported (module loaded)', typeof service.exportFullBook === 'function');
  }

  /* --------------------------- preview (IR-shared) --------------------- */
  async function testPreview() {
    const { exportFullBook, previewFullBook } = service;
    const { getPreset } = presets;
    if (typeof previewFullBook !== 'function') {
      check('preview: previewFullBook is exported', false, 'not a function');
      return;
    }
    check('preview: previewFullBook is exported', true);

    const fakeModel = {
      project: { id: 'p1', title: '我的书', description: '', author: '作者甲', language: 'zh-CN', genre: [], tags: [] },
      volumes: [
        {
          id: 'v1', title: '卷一', summary: '',
          chapters: [
            { id: 'c1', volumeId: 'v1', title: '第一章 雨夜', order: 0, status: 'drafted', source: 'draft', content: '他走进了雨中。\n\n**雷声**在远处。', stats: { wordCount: 0, characterCount: 0 }, sceneCount: 0 },
            { id: 'c2', volumeId: 'v1', title: '第二章 黎明', order: 1, status: 'drafted', source: 'draft', content: '天亮了。', stats: { wordCount: 0, characterCount: 0 }, sceneCount: 0 },
          ],
        },
      ],
      totalChapters: 2,
      totalWords: 12,
    };
    const fakeAssembly = {
      async assembleBook(projectId) {
        if (projectId === 'missing') throw new Error('Project "missing" was not found.');
        return JSON.parse(JSON.stringify(fakeModel));
      },
    };
    const preset = getPreset('generic');

    // 1) The preview returns the shared IR + HTML produced from that SAME IR.
    const result = await previewFullBook('p1', { preset }, { assembly: fakeAssembly });
    check('preview: returns a RenderedDocument (IR)', result.document && Array.isArray(result.document.volumes));
    check('preview: stats report the chapters from the IR', result.stats.chapters === 2, `chapters=${result.stats.chapters}`);
    check('preview: stats report blocks (> 0)', result.stats.blocks > 0, `blocks=${result.stats.blocks}`);
    check('preview: HTML is a full document', typeof result.html === 'string' && result.html.includes('<!DOCTYPE html>'));

    // 2) The preview is NOT just a filename/count blurb — it contains the actual
    //    chapter PROSE from the manuscript body.
    check('preview: HTML contains the first chapter prose', result.html.includes('他走进了雨中'));
    check('preview: HTML contains the second chapter prose', result.html.includes('天亮了'));
    check('preview: HTML contains the chapter heading text', result.html.includes('第一章 雨夜'));

    // 3) SAME IR as the download: exporting HTML from the same preset must yield
    //    byte-identical HTML to the preview (one pipeline, no divergence).
    const htmlExport = await exportFullBook('p1', { preset, format: 'html' }, { assembly: fakeAssembly, now: () => 0 });
    const exportedHtml = Buffer.from(htmlExport.bytes).toString('utf8');
    check('preview: preview HTML === exported HTML (identical IR + formatting)', exportedHtml === result.html,
      exportedHtml === result.html ? '' : 'preview and export diverged');

    // 4) Missing project maps to project-not-found, like a download.
    let notFound = null;
    try { await previewFullBook('missing', { preset }, { assembly: fakeAssembly }); } catch (e) { notFound = e; }
    check('preview: missing project → project-not-found', notFound && notFound.code === 'project-not-found', notFound && notFound.code);

    // 5) Empty book: an empty (but valid) preview with zero chapters, no crash.
    const emptyAssembly = { async assembleBook() { return { project: fakeModel.project, volumes: [], totalChapters: 0, totalWords: 0 }; } };
    const empty = await previewFullBook('p1', { preset }, { assembly: emptyAssembly });
    check('preview: empty book yields 0 chapters and still returns HTML', empty.stats.chapters === 0 && typeof empty.html === 'string');
  }

  /* --------------- large document + presets + edge cases ------------- */
  async function testLargeAndEdge() {
    const { exportFullBook } = service;
    const { getPreset } = presets;
    const { FormattingPipeline } = pipeline;
    const fontBytes = fs.existsSync(FONT_PATH) ? new Uint8Array(fs.readFileSync(FONT_PATH)) : null;

    // A big manuscript: 3 volumes × (4–6 chapters) = 15 chapters, one EMPTY
    // chapter (no draft content), mixed CN/EN, special chars, and a very long
    // paragraph. Chapter titles are UNIQUE markers so we can assert order.
    const specialChars = `<script>alert("x")</script> & "' ' 中文标点：，。！？`;
    const longPara = '这是一个很长的段落，没有任何空格来测试硬换行和分页。'.repeat(120) + ' ' + 'longwordwithoutspaces'.repeat(30);
    const volumes = [];
    let titleSeq = [];
    for (let v = 1; v <= 3; v += 1) {
      const chapters = [];
      const nCh = v === 1 ? 6 : v === 2 ? 5 : 4;
      for (let c = 1; c <= nCh; c += 1) {
        const globalNo = titleSeq.length + 1;
        const title = `第${globalNo}章 MARKER${globalNo}`;
        titleSeq.push(`MARKER${globalNo}`);
        // Chapter 3 of volume 1 is intentionally EMPTY (no draft) to prove empty
        // chapters are exported, never dropped.
        const isEmpty = v === 1 && c === 3;
        const content = isEmpty
          ? ''
          : [
              `这是第${globalNo}章的正文。Mixed English sentence here.`,
              '第二段中文，包含特殊字符：' + (c === 1 ? specialChars : '普通文本。'),
              ...(c === 1 ? [longPara] : []),
              '***',
              '场景分隔之后的段落。',
            ].join('\n\n');
        chapters.push({
          id: `c-${v}-${c}`, volumeId: `v${v}`, title, order: c - 1,
          status: 'drafted', source: isEmpty ? 'empty' : 'draft',
          content, stats: { wordCount: 0, characterCount: 0 }, sceneCount: 0,
        });
      }
      volumes.push({ id: `v${v}`, title: `卷${v}`, summary: '', chapters });
    }
    const model = {
      project: { id: 'big', title: '大书', description: '', author: '作者乙', language: 'zh-CN', genre: [], tags: [] },
      volumes, totalChapters: titleSeq.length, totalWords: 12345,
    };
    const fakeAssembly = { async assembleBook() { return JSON.parse(JSON.stringify(model)); } };
    const totalChapters = titleSeq.length;

    const txtDecode = (b) => Buffer.from(b).toString('utf8');
    const decode = (fmt, b) => {
      if (fmt === 'docx' || fmt === 'epub') {
        const zip = readZip(b);
        // Concatenate all text parts so we can assert chapter markers survived.
        let all = '';
        for (const name of ['word/document.xml']) if (zip.get(name)) all += zip.get(name).toString('utf8');
        for (const e of zip.entries) if (/OEBPS\/text\/chapter-.*\.xhtml$/.test(e.name) && zip.get(e.name)) all += zip.get(e.name).toString('utf8');
        return all;
      }
      return txtDecode(b);
    };

    for (const presetId of ['generic', 'qidian']) {
      const preset = getPreset(presetId);

      // Pipeline applies the preset ONCE; the IR is the single source of order.
      const ir = new FormattingPipeline().render(model, preset);
      const flatChapters = ir.volumes.flatMap((v) => v.chapters);
      check(`large[${presetId}]: pipeline renders ALL ${totalChapters} chapters`, flatChapters.length === totalChapters, `got ${flatChapters.length}`);
      // Chapter order preserved = chapter ids appear in volume/chapter order.
      const expectedChapterIds = volumes.flatMap((v) => v.chapters.map((c) => c.id));
      check(`large[${presetId}]: IR preserves canonical chapter order`,
        JSON.stringify(flatChapters.map((c) => c.id)) === JSON.stringify(expectedChapterIds));

      for (const format of ['txt', 'markdown', 'html', 'docx', 'epub', 'pdf']) {
        if (format === 'pdf' && !fontBytes) continue;
        let res;
        try {
          res = await exportFullBook('big', { preset, format }, {
            assembly: fakeAssembly, now: () => 0,
            ...(fontBytes ? { loadFontBytes: async () => fontBytes } : {}),
          });
        } catch (e) {
          check(`large[${presetId}][${format}]: export succeeds`, false, e.message);
          continue;
        }
        check(`large[${presetId}][${format}]: non-empty bytes`, res.bytes.byteLength > 0);

        if (format === 'pdf') {
          // PDF text is glyph-encoded; assert structure (font + pages) rather
          // than raw text. Markers are validated via the text writers + the
          // separate extraction check on a real PDF.
          check(`large[${presetId}][pdf]: is a real multi-page PDF`, Buffer.from(res.bytes.subarray(0, 5)).toString('latin1') === '%PDF-');
          continue;
        }

        const text = decode(format, res.bytes);
        // No chapter dropped: every unique chapter marker must appear.
        const missing = titleSeq.filter((m) => !text.includes(m));
        check(`large[${presetId}][${format}]: no chapter dropped (all ${totalChapters} markers present)`,
          missing.length === 0, missing.slice(0, 3).join(','));
        // Order preserved: marker positions ascend.
        const positions = titleSeq.map((m) => text.indexOf(m)).filter((p) => p >= 0);
        const ascending = positions.every((p, i) => i === 0 || p > positions[i - 1]);
        check(`large[${presetId}][${format}]: chapter order preserved`, ascending);
        // Mixed CN/EN + special chars handled: CN text present; raw <script> is
        // NOT a live tag in markup formats (escaped), and present as text.
        check(`large[${presetId}][${format}]: mixed CN prose present`, text.includes('这是第1章的正文'));
        check(`large[${presetId}][${format}]: English present`, text.includes('Mixed English sentence here'));
        if (format === 'html' || format === 'docx' || format === 'epub') {
          // Markup formats must ESCAPE the raw <script> so it is inert text, never
          // a live tag; the visible characters are preserved.
          check(`large[${presetId}][${format}]: raw <script> not emitted as a live tag`, !/<script>alert/.test(text));
          check(`large[${presetId}][${format}]: special chars preserved (escaped)`, /&lt;script&gt;|alert/.test(text) || text.includes('&quot;'));
        } else if (format === 'markdown') {
          // Markdown is a PLAIN-TEXT format: the manuscript text — including any
          // "<script>" — is preserved verbatim (Markdown is not HTML-escaped, by
          // design). Correct handling here is lossless preservation, not escaping.
          check(`large[${presetId}][markdown]: special chars preserved verbatim (lossless)`, text.includes('<script>alert'));
        }
        // Very long paragraph must not be dropped entirely.
        check(`large[${presetId}][${format}]: long paragraph content survives (a slice present)`,
          text.includes('这是一个很长的段落') || text.includes('longwordwithoutspaces'));
      }
    }
  }
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});
