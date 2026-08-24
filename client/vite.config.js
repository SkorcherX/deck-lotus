import { defineConfig } from 'vite';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The theme wizard (public/tools/theme-forge.html) is a plain static page, not
 * part of the bundle — it has to keep working when opened straight off the
 * built site. But its slot spec and prompt wording are owned by
 * src/themes/slots.js and src/themes/prompt.js, and a second copy pasted into
 * the page would go stale the first time a slot is resized.
 *
 * So the modules are served (dev) and copied (build) to /tools/ alongside the
 * page, which imports them relatively. One source, two front ends, no paste.
 */
const FORGE_MODULES = ['slots.js', 'prompt.js', 'registry.js'];

function forgeModules() {
  const src = (name) => resolve(HERE, 'src/themes', name);
  return {
    name: 'theme-forge-modules',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = FORGE_MODULES.find((f) => (req.url || '').split('?')[0] === `/tools/${f}`);
        if (!name) return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(readFileSync(src(name), 'utf8'));
      });
    },
    closeBundle() {
      const dir = resolve(HERE, 'dist/tools');
      mkdirSync(dir, { recursive: true });
      for (const name of FORGE_MODULES) copyFileSync(src(name), resolve(dir, name));
    },
  };
}

export default defineConfig({
  plugins: [forgeModules()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['./src/services/api.js'],
        },
      },
    },
  },
});
