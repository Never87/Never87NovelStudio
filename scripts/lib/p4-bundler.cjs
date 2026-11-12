/**
 * Shared test utilities for the P4 verification scripts.
 *
 * The autosave engine and the text utilities are TypeScript, and the project
 * already ships Vite — so instead of hand-rolling a TypeScript transform (which
 * would mean testing a copy of the code rather than the real thing), these
 * helpers bundle the modules with Vite's own esbuild pipeline into a temporary
 * ESM file and import it. No new dependency, and the code under test is exactly
 * what ships.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Project root (this file lives in `scripts/lib/`). */
const ROOT = path.resolve(__dirname, '..', '..');
const TMP_DIR = path.join(os.tmpdir(), 'n87-p4');

/** Absolute path of a project-relative file. */
function projectPath(...segments) {
  return path.join(ROOT, ...segments);
}

/**
 * Bundles one module (with its relative imports) into a temp ESM file and
 * imports it.
 *
 * @param {string} entry project-relative entry, e.g. 'src/utils/manuscript-text.ts'
 * @param {string} [name] bundling target name, used for the cache-busting temp file
 */
async function importBundled(entry, name = 'bundle') {
  const vite = await import(
    pathToFileURL(path.join(ROOT, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href
  );

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outFile = path.join(TMP_DIR, `${name}-${Date.now()}.mjs`);

  await vite.build({
    configFile: false,
    logLevel: 'silent',
    root: ROOT,
    build: {
      write: true,
      minify: false,
      target: 'esnext',
      outDir: TMP_DIR,
      emptyOutDir: false,
      lib: {
        entry: projectPath(entry),
        formats: ['es'],
        fileName: () => path.basename(outFile),
      },
      rollupOptions: {
        // The engine has no external runtime imports other than type-only ones.
        external: [],
      },
    },
  });

  return import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
}

/** Removes the temporary build output. */
function cleanupTemp() {
  try {
    for (const file of fs.readdirSync(TMP_DIR)) {
      if (file.endsWith('.mjs')) fs.unlinkSync(path.join(TMP_DIR, file));
    }
  } catch {
    // Nothing to clean up.
  }
}

module.exports = { importBundled, cleanupTemp, projectPath, ROOT };
