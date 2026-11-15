/**
 * P9 Batch D — EPUB cover product verification (PURE, no browser/server).
 *
 * Drives the REAL `renderEpub` writer bundled from source and inspects the
 * ACTUAL `.epub` ZIP it produces with JSZip. This is product verification of
 * the file bytes — NOT a check of any `supportsCover` flag.
 *
 * Two exports are produced from the same document:
 *   (A) WITH a cover  — asserts the cover image is inside the ZIP, its bytes are
 *                       byte-for-byte identical to the uploaded bytes, and the
 *                       OPF manifest/metadata/guide reference the cover.
 *   (B) WITHOUT cover — asserts the export still succeeds and declares NO cover
 *                       resources (graceful absence).
 *
 * Usage: npm run verify:epub:cover
 */
const path = require('node:path');
const zlib = require('node:zlib');
const JSZip = require('jszip');
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

/* ----------------- real-ish PNG/JPEG byte blobs (valid headers) -------- */
// A small but structurally valid PNG (1x1) so it is a genuine image payload.
function realPngBytes() {
  // 1x1 transparent PNG, canonical 67-byte file.
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function realJpegBytes() {
  // Minimal JPEG (SOI + EOI with a JFIF APP0); structurally starts FF D8 FF.
  const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9];
  return new Uint8Array(bytes);
}

function sampleDoc() {
  return {
    presetId: 'generic',
    metadata: { title: 'EPUB 封面测试', author: '作者甲', language: 'zh-CN' },
    volumes: [
      {
        title: '第一卷',
        chapters: [
          { title: '第一章', blocks: [{ type: 'paragraph', text: '这是正文第一段。' }, { type: 'paragraph', text: '这是正文第二段。' }] },
        ],
      },
    ],
  };
}

(async () => {
  let epub;
  try {
    epub = await importBundled('src/modules/publishing/writers/epub-writer.ts', 'p9d-epub', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle epub-writer:\n', error);
    process.exit(1);
  }
  const { renderEpub } = epub;

  try {
    const doc = sampleDoc();
    const png = realPngBytes();
    const jpeg = realJpegBytes();

    /* ============================== (A) WITH COVER ==================== */
    const coverName = 'cover.png';
    const withCover = await renderEpub(doc, {
      title: doc.metadata.title,
      author: doc.metadata.author,
      language: doc.metadata.language,
      modifiedAt: Date.UTC(2024, 0, 2),
      cover: { bytes: png, mimeType: 'image/png', fileName: coverName, altText: '封面' },
    });
    check('epub(cover): produced non-empty bytes', withCover instanceof Uint8Array && withCover.byteLength > 0);
    check('epub(cover): starts with the ZIP local-file signature "PK\\x03\\x04"',
      withCover[0] === 0x50 && withCover[1] === 0x4b && withCover[2] === 0x03 && withCover[3] === 0x04);

    const zipA = await JSZip.loadAsync(withCover);

    // (A1) mimetype: first entry AND stored (not deflated).
    const firstEntry = readFirstCentralEntryName(withCover);
    eq('epub(cover): first ZIP entry is "mimetype"', firstEntry.name, 'mimetype');
    check('epub(cover): mimetype entry is STORED (uncompressed)',
      firstEntry.method === 0, `compression method = ${firstEntry.method}`);
    const mimetypeText = await zipA.file('mimetype').async('string');
    eq('epub(cover): mimetype content = application/epub+zip', mimetypeText, 'application/epub+zip');

    // (A2) container points at the OPF.
    const container = await zipA.file('META-INF/container.xml').async('string');
    check('epub(cover): container.xml points at OEBPS/content.opf', container.includes('OEBPS/content.opf'));

    // (A3) cover IMAGE resource is present in the ZIP.
    const imageEntry = `OEBPS/images/${coverName}`;
    const hasImage = zipA.file(imageEntry) !== null;
    check('epub(cover): cover image resource exists in ZIP', hasImage, imageEntry);

    // (A4) BYTE IDENTITY: the embedded cover bytes equal the uploaded bytes.
    if (hasImage) {
      const embedded = await zipA.file(imageEntry).async('uint8array');
      const identical = embedded.byteLength === png.byteLength && embedded.every((v, i) => v === png[i]);
      check('epub(cover): embedded cover bytes are IDENTICAL to the upload', identical,
        `embedded=${embedded.byteLength}B upload=${png.byteLength}B`);
    }

    // (A5) OPF manifest declares the cover-image with a proper media-type.
    const opf = await zipA.file('OEBPS/content.opf').async('string');
    check('epub(cover): OPF manifest has a cover-image item',
      /<item\b[^>]*id="cover-image"/.test(opf) && /properties="cover-image"/.test(opf));
    check('epub(cover): cover-image media-type is image/png',
      /id="cover-image"[^>]*media-type="image\/png"/.test(opf) || /media-type="image\/png"[^>]*id="cover-image"/.test(opf));
    check('epub(cover): cover-image href points at images/cover.png',
      /id="cover-image"[^>]*href="images\/cover\.png"/.test(opf) || /href="images\/cover\.png"[^>]*id="cover-image"/.test(opf));

    // (A6) OPF metadata carries the cover <meta> reference.
    check('epub(cover): OPF metadata declares <meta name="cover" ...>',
      /<meta\s+name="cover"\s+content="cover-image"\s*\/>/.test(opf), snippet(opf, 'cover'));

    // (A7) OPF guide references a cover page, and that page exists + is declared.
    const guideHasCover = /<reference\b[^>]*type="cover"/.test(opf);
    check('epub(cover): OPF <guide> references a cover page', guideHasCover);
    if (guideHasCover) {
      const guideHref = (opf.match(/<reference\b[^>]*type="cover"[^>]*href="([^"]+)"/) || [])[1];
      const coverPagePath = guideHref ? `OEBPS/${guideHref.replace(/^\.?\//, '')}` : null;
      const coverPageExists = coverPagePath ? zipA.file(coverPagePath) !== null : false;
      check('epub(cover): the referenced cover page file exists in the ZIP', coverPageExists, String(coverPagePath));
      // STRICT: a manest-declared cover page should also be listed in the manifest.
      const coverPageInManifest = /<item\b[^>]*href="text\/cover\.xhtml"/.test(opf);
      check('epub(cover): cover page is declared in the OPF manifest', coverPageInManifest, 'text/cover.xhtml');
      const coverPageInSpine = /<itemref\b[^>]*idref="cover-page"[^>]*\/>/.test(opf);
      check('epub(cover): cover page is referenced from the spine', coverPageInSpine, '(orphan cover page would be a defect)');
      // STRICT: cover page must be the FIRST spine itemref (reading order).
      const spineBlock = (opf.match(/<spine>([\s\S]*?)<\/spine>/) || [])[1] || '';
      const firstItemref = (spineBlock.match(/<itemref\b[^>]*idref="([^"]+)"/) || [])[1];
      eq('epub(cover): cover page is FIRST in the spine', firstItemref, 'cover-page');
    }

    // (A8) chapters still present and spine-ordered.
    const ch1 = await zipA.file('OEBPS/text/chapter-001.xhtml').async('string');
    check('epub(cover): chapter content still present', ch1.includes('这是正文第一段'));
    check('epub(cover): nav.xhtml present and marked as nav',
      (await zipA.file('OEBPS/nav.xhtml').async('string')).includes('epub:type="toc"') && /properties="nav"/.test(opf));

    /* ============================= (B) JPEG COVER =================== */
    const withJpeg = await renderEpub(doc, {
      title: doc.metadata.title,
      cover: { bytes: jpeg, mimeType: 'image/jpeg', fileName: 'cover.jpg' },
      modifiedAt: Date.UTC(2024, 0, 2),
    });
    const zipJ = await JSZip.loadAsync(withJpeg);
    check('epub(jpeg): JPEG cover resource exists', zipJ.file('OEBPS/images/cover.jpg') !== null);
    if (zipJ.file('OEBPS/images/cover.jpg')) {
      const embeddedJ = await zipJ.file('OEBPS/images/cover.jpg').async('uint8array');
      const identicalJ = embeddedJ.byteLength === jpeg.byteLength && embeddedJ.every((v, i) => v === jpeg[i]);
      check('epub(jpeg): embedded JPEG bytes are IDENTICAL to the upload', identicalJ);
      const opfJ = await zipJ.file('OEBPS/content.opf').async('string');
      check('epub(jpeg): manifest media-type is image/jpeg', /media-type="image\/jpeg"/.test(opfJ));
    }

    /* ====================== (C) WITHOUT COVER ======================= */
    const noCover = await renderEpub(doc, {
      title: doc.metadata.title,
      author: doc.metadata.author,
      language: doc.metadata.language,
      modifiedAt: Date.UTC(2024, 0, 2),
    });
    check('epub(no-cover): export still succeeds + non-empty', noCover instanceof Uint8Array && noCover.byteLength > 0);
    const zipN = await JSZip.loadAsync(noCover);
    check('epub(no-cover): no cover image entry', zipN.file('OEBPS/images/cover.png') === null && zipN.file('OEBPS/images/cover.jpg') === null);
    const opfN = await zipN.file('OEBPS/content.opf').async('string');
    check('epub(no-cover): manifest declares NO cover-image item', !/id="cover-image"/.test(opfN));
    check('epub(no-cover): metadata declares NO cover <meta>', !/<meta\s+name="cover"/.test(opfN));
    check('epub(no-cover): guide has NO cover reference', !/<reference\b[^>]*type="cover"/.test(opfN));
    check('epub(no-cover): chapter content intact', (await zipN.file('OEBPS/text/chapter-001.xhtml').async('string')).includes('这是正文第一段'));
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
  process.exit(0);
})().catch((error) => {
  cleanupTemp();
  console.error('\nUnexpected error:', error);
  process.exit(1);
});

function snippet(text, needle) {
  const i = text.indexOf(needle);
  return i < 0 ? '(not found)' : text.slice(Math.max(0, i - 20), i + 40).replace(/\n/g, ' ');
}

/**
 * Reads the FIRST central-directory entry's name + compression method directly
 * from the ZIP bytes, so the "mimetype is first and STORED" rule is checked on
 * the real bytes (not via JSZip's object ordering).
 */
function readFirstCentralEntryName(bytes) {
  // Find End-Of-Central-Directory (EOCD) signature 0x06054b50 (search from end).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { name: null, method: null };
  const cdOffset = readUint32LE(bytes, eocd + 16);
  // First central directory header signature 0x02014b50.
  if (bytes[cdOffset] !== 0x50 || bytes[cdOffset + 1] !== 0x4b || bytes[cdOffset + 2] !== 0x01 || bytes[cdOffset + 3] !== 0x02) {
    return { name: null, method: null };
  }
  const method = readUint16LE(bytes, cdOffset + 10);
  const nameLen = readUint16LE(bytes, cdOffset + 28);
  const name = Buffer.from(bytes.slice(cdOffset + 46, cdOffset + 46 + nameLen)).toString('utf8');
  return { name, method };
}
function readUint16LE(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}
function readUint32LE(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}
// keep zlib referenced so bundlers don't complain about unused import removal
void zlib;
void path;
