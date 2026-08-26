/**
 * The server must not import client source.
 *
 * This exists because it happened. `cardHash.js` is shared between the browser
 * and the server on purpose — a reference hash and a capture hash are only
 * comparable if the identical code produced both — and it was first put in
 * `client/src/utils/`, next to the capture code that was its first caller. Every
 * test passed, the client built, the dev server ran, and the container would not
 * boot:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *   '/app/client/src/utils/cardHash.js' imported from
 *   /app/src/services/cardHashIndex.js
 *
 * Nothing local could have caught it, which is the whole point of this file.
 * The runtime image copies `src`, `scripts`, `package*.json` and the *built*
 * `client/dist` — never `client/src` — so an import that resolves perfectly on
 * a developer's disk resolves to nothing in production. The failure is not
 * subtle when it lands, it just lands late.
 *
 * The rule is about direction, not tidiness. The browser resolves its imports
 * at build time, when the whole repo is present, so the client may reach into
 * the server tree; the server resolves at runtime inside an image that
 * deliberately ships no client sources, so it must never reach the other way.
 * Shared code goes in `src/shared/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/**
 * Directories the runtime image actually contains, from the Dockerfile's final
 * stage. Anything reachable at runtime has to resolve within these.
 */
const SHIPPED = ['src', 'scripts'];

/** Matches a static or dynamic import specifier. */
const IMPORT_PATTERN = /(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g;

function jsFilesUnder(dir) {
  const files = [];

  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.js') || entry.endsWith('.mjs')) files.push(path);
    }
  };

  walk(dir);
  return files;
}

test('nothing shipped in the image imports client source', () => {
  const offenders = [];

  for (const shipped of SHIPPED) {
    for (const file of jsFilesUnder(join(ROOT, shipped))) {
      const source = readFileSync(file, 'utf8');

      for (const [, specifier] of source.matchAll(IMPORT_PATTERN)) {
        // Only relative specifiers can escape into the client tree; a bare
        // package name is resolved from node_modules, which the image has.
        if (!specifier.startsWith('.')) continue;

        const target = resolve(file, '..', specifier);
        const fromRoot = relative(ROOT, target).replace(/\\/g, '/');

        if (fromRoot.startsWith('client/') && !fromRoot.startsWith('client/dist/')) {
          offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')} → ${specifier}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These files ship in the container but import from client/, which does not:\n  ' +
    offenders.join('\n  ') +
    '\nMove the shared module to src/shared/ instead.'
  );
});

test('the shared hash module is on the server side of that line', () => {
  // Named explicitly rather than left to the sweep above, because this is the
  // one that broke and the sweep only catches the import, not the drift back.
  const shared = join(ROOT, 'src', 'shared', 'cardHash.js');
  assert.doesNotThrow(
    () => statSync(shared),
    'src/shared/cardHash.js must exist — the server imports it at runtime'
  );
});

test('the shared module pulls in nothing at all', () => {
  // Its portability is what makes one implementation serve both sides. A single
  // import of a Node built-in or a DOM helper would break one of them, and the
  // break would look like "hashes stopped matching" rather than a load error.
  const source = readFileSync(join(ROOT, 'src', 'shared', 'cardHash.js'), 'utf8');
  const specifiers = [...source.matchAll(IMPORT_PATTERN)].map(([, s]) => s);

  assert.deepEqual(
    specifiers,
    [],
    `src/shared/cardHash.js must stay import-free; found: ${specifiers.join(', ')}`
  );
});

/**
 * The mirror rule, and the second half of the same lesson.
 *
 * Moving cardHash.js to src/shared fixed the runtime image and immediately
 * broke the build, because the two stages copy different subtrees and I had
 * only checked one:
 *
 *   error during build:
 *   Could not resolve "../../../src/shared/cardHash.js" from "src/components/scan.js"
 *
 * The frontend-builder stage copies `client/` and nothing else, so a client
 * import that escapes `client/` resolves to a path that does not exist in that
 * stage. The import is legitimate — the browser resolves at build time and the
 * module has to be shared — so the stage has to be given what it reaches for.
 *
 * Reading the Dockerfile is crude, but it is the only check that runs without a
 * Docker daemon, and both of these failures were things a full local build could
 * not see.
 */
function frontendBuilderStage() {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  const start = dockerfile.indexOf('AS frontend-builder');
  assert.ok(start !== -1, 'Dockerfile no longer has a frontend-builder stage');

  const next = dockerfile.indexOf('\nFROM ', start);
  return dockerfile.slice(start, next === -1 ? undefined : next);
}

/** Paths copied into a stage from the build context, ignoring --from copies. */
function copiedPaths(stage) {
  const paths = [];

  for (const line of stage.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('COPY ') || trimmed.includes('--from=')) continue;

    // COPY <src>... <dest> — every argument but the last is a source.
    const args = trimmed.slice(5).trim().split(/\s+/);
    for (const source of args.slice(0, -1)) {
      paths.push(source.replace(/^\.\//, '').replace(/\/$/, ''));
    }
  }

  return paths;
}

test('everything the client imports from outside client/ is copied into the build stage', () => {
  const stage = frontendBuilderStage();
  const copied = copiedPaths(stage);

  const missing = [];

  for (const file of jsFilesUnder(join(ROOT, 'client', 'src'))) {
    const source = readFileSync(file, 'utf8');

    for (const [, specifier] of source.matchAll(IMPORT_PATTERN)) {
      if (!specifier.startsWith('.')) continue;

      const target = resolve(file, '..', specifier);
      const fromRoot = relative(ROOT, target).replace(/\\/g, '/');

      // Still inside client/, so `COPY client/ ./` already covers it.
      if (!fromRoot.startsWith('../') && fromRoot.startsWith('client/')) continue;

      const covered = copied.some(
        (path) => fromRoot === path || fromRoot.startsWith(`${path}/`)
      );

      if (!covered) {
        missing.push(
          `${relative(ROOT, file).replace(/\\/g, '/')} imports ${fromRoot}, ` +
          `which the frontend-builder stage never copies`
        );
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    'The client build will fail in Docker:\n  ' + missing.join('\n  ') +
    '\nAdd a COPY for it to the frontend-builder stage in the Dockerfile.'
  );
});
