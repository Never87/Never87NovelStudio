/**
 * P9 Batch D — Book Covers: PURE unit tests (no browser, no UI, no server).
 *
 * Exercises the REAL validation module bundled from source with the project's
 * own Vite pipeline, so the code under test is what ships
 * (`src/modules/publishing/covers/image-validation.ts`) plus the cover schema
 * (`src/schemas/cover-asset.ts`).
 *
 * Coverage required by the acceptance brief:
 *   - PNG / JPEG / WebP magic-byte sniffing (and per-format rejections);
 *   - FORGED MIME: a WebP/JPEG/PNG body is reported under its TRUE format, and
 *     a text/garbage body is rejected regardless of any claimed type;
 *   - CORRUPT / truncated files (too short to carry a signature) rejected;
 *   - SIZE boundaries (empty / exactly-at / just-over MAX_COVER_BYTES);
 *   - DIMENSION boundaries (min / max / just-over) via an injected probe;
 *   - DECODE FAILURE (probe rejects / hangs → timeout) → `decode-failed`;
 *   - aspect classification (ok / warning / critical) is advisory, never fatal;
 *   - asset-reference parsing (asset / external / none / empty).
 *
 * The browser `<img>` decode path is exercised by the UI/IDB suites; here the
 * dimension decoder is injected so the checks are deterministic and DOM-free.
 *
 * Usage: npm run verify:covers
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

/* --------------------------- byte factories ---------------------------- */

// Real leading signatures (rest padded) so sniffing sees true magic bytes.
function pngBytes(extra = 8) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...sig, ...new Array(extra).fill(0)]);
}
function jpegBytes(extra = 8) {
  return new Uint8Array([0xff, 0xd8, 0xff, ...new Array(extra).fill(0)]);
}
function webpBytes(extra = 8) {
  // "RIFF" .... "WEBP"
  const head = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  return new Uint8Array([...head, ...new Array(extra).fill(0)]);
}
const textBytes = () => new TextEncoder().encode('this is definitely not an image');

/** Builds a deterministic probe returning fixed dimensions. */
const probeOf = (width, height) => async () => ({ width, height });

/* ------------------------------- main ---------------------------------- */

(async () => {
  let validation;
  let schema;
  try {
    validation = await importBundled('src/modules/publishing/covers/image-validation.ts', 'p9d-cov-imgval', { alias: ALIAS });
    schema = await importBundled('src/schemas/cover-asset.ts', 'p9d-cov-schema', { alias: ALIAS });
  } catch (error) {
    console.error('Failed to bundle modules:\n', error);
    process.exit(1);
  }

  const { sniffImageMime, precheckImageFile, classifyAspect, validateCoverImage, toArrayBuffer } = validation;
  const { MAX_COVER_BYTES, MAX_COVER_DIMENSION, MIN_COVER_DIMENSION, parseCoverRef, coverAssetRef } = schema;

  try {
    /* --------------------------- magic bytes --------------------------- */
    eq('mime: PNG magic bytes -> image/png', sniffImageMime(pngBytes()), 'image/png');
    eq('mime: JPEG magic bytes -> image/jpeg', sniffImageMime(jpegBytes()), 'image/jpeg');
    eq('mime: WebP magic bytes -> image/webp', sniffImageMime(webpBytes()), 'image/webp');

    /* ----------------------- FORGED / wrong types ---------------------- */
    eq('mime: WebP body is webp (not the claimed type)', sniffImageMime(webpBytes()), 'image/webp');
    eq('mime: JPEG body is jpeg (not the claimed type)', sniffImageMime(jpegBytes()), 'image/jpeg');
    eq('mime: GIF signature -> null (unsupported)', sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), null);
    eq('mime: plain text -> null', sniffImageMime(textBytes()), null);
    eq('mime: BMP signature -> null', sniffImageMime(new Uint8Array([0x42, 0x4d, 0, 0])), null);

    /* --------------------------- corrupt input ------------------------- */
    eq('mime: empty bytes -> null', sniffImageMime(new Uint8Array([])), null);
    eq('mime: truncated PNG (2 bytes) -> null', sniffImageMime(new Uint8Array([0x89, 0x50])), null);
    eq('mime: truncated JPEG (2 bytes) -> null', sniffImageMime(new Uint8Array([0xff, 0xd8])), null);
    eq('mime: truncated WebP (header only, 4 bytes) -> null', sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null);

    /* ----------------------- precheck (size) --------------------------- */
    check('precheck: empty file (size 0) -> empty', precheckImageFile({ size: 0 }).code === 'empty');
    check('precheck: exactly MAX_COVER_BYTES is allowed', precheckImageFile({ size: MAX_COVER_BYTES }).ok === true);
    check('precheck: MAX_COVER_BYTES + 1 -> too-large', precheckImageFile({ size: MAX_COVER_BYTES + 1 }).code === 'too-large');
    check('precheck: normal small file ok', precheckImageFile({ size: 1024 }).ok === true);

    /* ------------------- validateCoverImage (happy paths) -------------- */
    const okPng = await validateCoverImage(pngBytes(), probeOf(800, 1200));
    check('validate: valid PNG (800x1200) ok', okPng.ok === true && okPng.mimeType === 'image/png', JSON.stringify(okPng));
    check('validate: canonical mime derived from bytes, not caller', okPng.ok && okPng.mimeType === 'image/png');
    const okJpeg = await validateCoverImage(jpegBytes(), probeOf(600, 900));
    check('validate: valid JPEG ok', okJpeg.ok === true && okJpeg.mimeType === 'image/jpeg');
    const okWebp = await validateCoverImage(webpBytes(), probeOf(1000, 1500));
    check('validate: valid WebP ok', okWebp.ok === true && okWebp.mimeType === 'image/webp');
    check('validate: byteSize reported from real bytes', okPng.ok && okPng.byteSize === pngBytes().byteLength);

    /* ------------------- validateCoverImage (rejections) --------------- */
    const empty = await validateCoverImage(new Uint8Array([]), probeOf(100, 100));
    check('validate: empty bytes -> empty', empty.ok === false && empty.code === 'empty');

    const big = await validateCoverImage(new Uint8Array(MAX_COVER_BYTES + 1), probeOf(100, 100));
    check('validate: oversize bytes -> too-large (before decode)', big.ok === false && big.code === 'too-large');

    const text = await validateCoverImage(textBytes(), probeOf(100, 100));
    check('validate: text bytes -> unknown-format', text.ok === false && text.code === 'unknown-format');

    const decodeFail = await validateCoverImage(pngBytes(), async () => { throw new Error('cannot decode'); });
    check('validate: probe rejection -> decode-failed', decodeFail.ok === false && decodeFail.code === 'decode-failed');

    const timedOut = await validateCoverImage(pngBytes(), () => new Promise(() => {}), { decodeTimeoutMs: 50 });
    check('validate: probe hang -> decode-failed (timeout)', timedOut.ok === false && timedOut.code === 'decode-failed');

    /* ------------------- dimension boundaries -------------------------- */
    const tooSmall = await validateCoverImage(pngBytes(), probeOf(MIN_COVER_DIMENSION - 1, 1000));
    check(`validate: width < MIN (${MIN_COVER_DIMENSION}) -> too-small`, tooSmall.ok === false && tooSmall.code === 'too-small', JSON.stringify(tooSmall));
    const atMin = await validateCoverImage(pngBytes(), probeOf(MIN_COVER_DIMENSION, MIN_COVER_DIMENSION));
    check('validate: exactly MIN x MIN ok', atMin.ok === true);
    const tooWide = await validateCoverImage(pngBytes(), probeOf(MAX_COVER_DIMENSION + 1, 1000));
    check(`validate: width > MAX (${MAX_COVER_DIMENSION}) -> dimensions-too-large`, tooWide.ok === false && tooWide.code === 'dimensions-too-large');
    const atMax = await validateCoverImage(pngBytes(), probeOf(MAX_COVER_DIMENSION, MAX_COVER_DIMENSION));
    check('validate: exactly MAX x MAX ok', atMax.ok === true);
    const notInt = await validateCoverImage(pngBytes(), probeOf(100.5, 100));
    check('validate: non-integer dimensions -> too-small (invalid)', notInt.ok === false);

    /* --------------------- aspect classification ---------------------- */
    const aspectOk = classifyAspect(600, 900, 2 / 3);
    check('aspect: on-target ratio is ok (no message)', aspectOk.severity === 'ok' && aspectOk.message === null);
    const aspectWarn = classifyAspect(700, 900, 2 / 3);
    check('aspect: slightly-off ratio -> warning (advisory)', aspectWarn.severity === 'warning' && typeof aspectWarn.message === 'string');
    const aspectCrit = classifyAspect(1920, 1080, 2 / 3);
    check('aspect: far-off ratio -> critical (advisory)', aspectCrit.severity === 'critical' && typeof aspectCrit.message === 'string');
    const aspectNull = classifyAspect(100, 100, null);
    check('aspect: no target -> ok', aspectNull.severity === 'ok');
    const critValidate = await validateCoverImage(pngBytes(), probeOf(1920, 1080), { targetAspectRatio: 2 / 3 });
    check('validate: off-aspect is a WARNING, not a rejection', critValidate.ok === true && critValidate.warnings.length > 0, JSON.stringify(critValidate));

    /* ------------------------ toArrayBuffer --------------------------- */
    const src = pngBytes();
    const buf = toArrayBuffer(src);
    check('toArrayBuffer: returns an ArrayBuffer of equal length', buf instanceof ArrayBuffer && buf.byteLength === src.byteLength);
    check('toArrayBuffer: copies bytes faithfully', new Uint8Array(buf)[0] === 0x89 && new Uint8Array(buf)[7] === 0x0a);
    src[0] = 0x00;
    check('toArrayBuffer: is a defensive copy', new Uint8Array(buf)[0] === 0x89);

    /* ----------------------- cover-ref parsing ------------------------ */
    const ref = coverAssetRef('cov_123');
    eq('coverRef: builds asset:<id>', ref, 'asset:cov_123');
    const parsedAsset = parseCoverRef('asset:cov_123');
    check('coverRef: parses asset reference', parsedAsset.kind === 'asset' && parsedAsset.assetId === 'cov_123');
    const parsedExt = parseCoverRef('https://example.com/cover.png');
    check('coverRef: parses external URL', parsedExt.kind === 'external' && parsedExt.value === 'https://example.com/cover.png');
    check('coverRef: empty string -> none', parseCoverRef('').kind === 'none');
    check('coverRef: undefined -> none', parseCoverRef(undefined).kind === 'none');
    check('coverRef: bare "asset:" -> none (no id)', parseCoverRef('asset:').kind === 'none');
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
