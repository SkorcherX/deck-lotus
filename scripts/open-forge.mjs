#!/usr/bin/env node
/**
 * Open the theme wizard.
 *
 * The wizard is a page on the site, not a standalone file — it imports the
 * slot spec from /tools/, so opening the .html off the filesystem shows an
 * error rather than a wizard. Something therefore has to be serving it, and
 * "which something" is the only decision here:
 *
 *   1. a Deck Lotus that is already running (the container, or `npm start`);
 *   2. failing that, the client dev server, started here and left running.
 *
 * Checking before starting matters. Someone who already has the app open does
 * not want a second server on a different port, and someone who has neither
 * should not have to know that a dev server is the answer.
 *
 *   node scripts/open-forge.mjs [url]
 *   npm run theme:forge
 *   tools/theme-forge.bat          (double-click, Windows)
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = '/tools/theme-forge.html';

/* Candidates in the order worth trying: an explicit argument, then whatever
   the user set, then the two ports this project actually uses. */
const candidates = [
  process.argv[2],
  process.env.DECK_LOTUS_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean).map((u) => u.replace(/\/+$/, ''));

async function reachable(base) {
  try {
    const res = await fetch(base + PAGE, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

for (const base of candidates) {
  if (await reachable(base)) {
    console.log(`Opening the theme wizard at ${base}${PAGE}`);
    openBrowser(base + PAGE);
    process.exit(0);
  }
}

console.log('Nothing is serving Deck Lotus yet, so starting the client dev server.');
console.log('Leave this window open while you work; close it when you are done.\n');

/* One string rather than a command plus an args array: `npm` needs a shell on
   Windows to resolve to npm.cmd, and passing args alongside shell:true earns a
   deprecation warning on every launch that this script has no way to act on. */
const dev = spawn('npm run dev --prefix client', {
  cwd: ROOT, stdio: 'inherit', shell: true,
});
dev.on('error', (err) => {
  console.error('\nCould not start the dev server:', err.message);
  console.error('Is Node installed, and have you run `npm install` in client/?');
  process.exit(1);
});
dev.on('exit', (code) => process.exit(code ?? 0));

/* Vite is up within a second or two, but polling rather than sleeping means a
   cold start on a slow disk still lands on a working page instead of a
   connection error the user has to interpret. */
const DEV = 'http://localhost:5173';
for (let i = 0; i < 60; i++) {
  if (await reachable(DEV)) {
    console.log(`\nOpening the theme wizard at ${DEV}${PAGE}\n`);
    openBrowser(DEV + PAGE);
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
