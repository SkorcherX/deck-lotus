#!/usr/bin/env node
/**
 * Token reference check.
 *
 * Two failure modes that are silent in the browser and easy to introduce when
 * sweeping colours into tokens:
 *
 *   1. var(--something-that-does-not-exist). CSS drops the declaration and the
 *      property inherits, so text renders in the wrong colour rather than
 *      visibly breaking.
 *   2. var() reaching a canvas. Chart.js paints to a 2D context, which cannot
 *      resolve custom properties — the colour is simply not applied. Chart
 *      colours must come from utils/theme.js (token / tokenRgba).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CSS_SOURCES = ['client/src/styles/main.css'];
const THEME_DIR = 'client/public/themes';
if (existsSync(THEME_DIR)) {
  for (const d of readdirSync(THEME_DIR)) {
    const f = join(THEME_DIR, d, 'theme.css');
    if (existsSync(f)) CSS_SOURCES.push(f);
  }
}

const css = CSS_SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [...walk('client/src'), 'client/index.html'];
const missing = new Map();
const canvasColours = [];

// Chart.js / canvas colour properties. A var() in one of these is inert.
const CANVAS_PROPS = /\b(borderColor|backgroundColor|pointBackgroundColor|pointBorderColor|fillStyle|strokeStyle|shadowColor|hoverBackgroundColor|hoverBorderColor)\s*:\s*['"`][^'"`]*var\(/;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip comment lines — prose mentioning var() is not a reference.
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

    if (file.endsWith('.js') && CANVAS_PROPS.test(line)) {
      canvasColours.push(`${file}:${i + 1}  ${trimmed.slice(0, 88)}`);
    }

    for (const m of line.matchAll(/var\((--[a-z0-9-]+)([^)]*)/g)) {
      // A name built by interpolation (var(--tone-${n})) cannot be checked.
      if (m[2].startsWith('$') || m[2].startsWith('{')) continue;
      // var(--x, fallback) is valid by design — the fallback is the point.
      if (m[2].trimStart().startsWith(',')) continue;
      if (defined.has(m[1])) continue;
      const key = m[1];
      if (!missing.has(key)) missing.set(key, new Set());
      missing.get(key).add(`${file.replace(/\\/g, '/')}:${i + 1}`);
    }
  });
}

console.log(`${defined.size} tokens defined across ${CSS_SOURCES.length} stylesheet(s); ${files.length} files scanned\n`);

let failed = 0;
if (missing.size) {
  console.log('Undefined tokens (the declaration is dropped and the property inherits):');
  for (const [t, where] of [...missing].sort()) {
    console.log(`  ${t}`);
    for (const w of where) console.log(`      ${w}`);
    failed++;
  }
} else {
  console.log('✓ every var() reference resolves to a defined token');
}

if (canvasColours.length) {
  console.log('\nvar() reaching a canvas (use token()/tokenRgba() from utils/theme.js):');
  for (const c of canvasColours) console.log(`  ${c}`);
  failed += canvasColours.length;
} else {
  console.log('✓ no var() reaching a canvas colour property');
}

process.exitCode = failed ? 1 : 0;
