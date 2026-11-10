import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * GitHub Pages deployment notes
 * ---------------------------------------------------------------
 * `base` must match the repository path on GitHub Pages:
 *   - Project site (https://never87.github.io/never87-novel-studio/) -> '/never87-novel-studio/'
 *   - User site    (https://never87.github.io/)                      -> '/'
 *
 * The value is read from the `VITE_BASE_PATH` environment variable so the same
 * config works locally, in CI and for a user/organisation root site.
 * The GitHub Actions workflow sets it automatically from `actions/configure-pages`.
 */
const base = process.env.VITE_BASE_PATH ?? '/';

/**
 * Bakes `base` into the GitHub Pages SPA fallback (`dist/404.html`).
 *
 * `public/404.html` ships with a `__N87_BASE__` placeholder because the
 * required rewrite target depends on whether this is a user site (`/`) or a
 * project site (`/<repo>/`). Injecting it here — from the exact same `base`
 * Vite used — guarantees the fallback and the router basename can never
 * disagree. Done as a build plugin to avoid touching package.json scripts.
 */
function pagesFallbackPlugin(): Plugin {
  return {
    name: 'n87-pages-fallback',
    apply: 'build',
    closeBundle() {
      const file = path.resolve(import.meta.dirname, 'dist/404.html');
      try {
        const html = readFileSync(file, 'utf8');
        if (!html.includes('__N87_BASE__')) return;
        writeFileSync(file, html.replaceAll('__N87_BASE__', base), 'utf8');
        console.log(`\n  n87-pages-fallback: dist/404.html base -> "${base}"`);
      } catch {
        // dist/404.html is absent when the public folder is customised;
        // that is not fatal for the build.
      }
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), tailwindcss(), pagesFallbackPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    host: true,
  },
});
