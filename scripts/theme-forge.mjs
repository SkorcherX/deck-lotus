#!/usr/bin/env node
/**
 * Theme forge — art prompt generator (command line).
 *
 * This is the admin-shaped front end. The one built for everyone else is the
 * wizard at /tools/theme-forge.html, which walks the whole theme through in
 * order and needs no terminal; both call the same buildPrompt() in
 * client/src/themes/prompt.js, so neither can drift from the other.
 *
 *   node scripts/theme-forge.mjs prompt <slug> --mood "..." [--slot banner]
 *   node scripts/theme-forge.mjs prompt <slug> --mood "..." --ground "#0a0711"
 *   node scripts/theme-forge.mjs prompt <slug> --mood "..." --with-palette
 *   node scripts/theme-forge.mjs slots
 *
 * Generation order matters. Do the banner FIRST, extract the palette from it
 * with /tools/theme-forge.html, then generate the remaining slots with
 * --with-palette and the banner attached as a reference image. Four slots
 * generated independently from the same text will not look like one set.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const { ART_SLOTS, ANCHOR_SLOT, buildPrompt } = await import(
  new URL('../client/src/themes/prompt.js', import.meta.url)
);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function readPalette(slug) {
  const file = join(ROOT, 'client/public/themes', slug, 'theme.css');
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  return {
    bg: grab('bg'), bgSecondary: grab('bg-secondary'),
    primary: grab('primary'), highlight: grab('highlight'),
    text: grab('text'),
  };
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (cmd === 'slots') {
  console.log('Art slots (client/src/themes/slots.js):\n');
  for (const s of ART_SLOTS) {
    console.log(`  ${s.id.padEnd(12)} ${String(s.width).padStart(5)}x${String(s.height).padEnd(5)}  -> ${s.filename}${s.id === ANCHOR_SLOT ? '   [anchor: generate first]' : ''}`);
  }
  process.exit(0);
}

if (cmd !== 'prompt') {
  console.error('usage: node scripts/theme-forge.mjs prompt <slug> --mood "..." [--slot <id>] [--ground "#rrggbb"] [--with-palette]');
  console.error('       node scripts/theme-forge.mjs slots');
  console.error('');
  console.error('Or skip the terminal entirely: open /tools/theme-forge.html, which walks');
  console.error('the whole theme through one step at a time.');
  process.exit(1);
}

const slug = args._[1];
if (!slug) { console.error('error: missing <slug>'); process.exit(1); }
if (!args.mood || args.mood === true) {
  console.error('error: --mood is required. One or two concrete sentences naming a plane,');
  console.error('       a weather condition and a light source. "Blue and magical" will not');
  console.error('       give the extractor anything to read.');
  process.exit(1);
}

const palette = args['with-palette'] ? readPalette(slug) : null;
if (args['with-palette'] && !palette) {
  console.error(`error: --with-palette needs client/public/themes/${slug}/theme.css to exist.`);
  console.error('       Generate the banner first, then extract the palette, then come back.');
  process.exit(1);
}

/* The ground colour is the exact page background the art has to fade into.
   Once a palette exists it is simply --bg; before that it has to be declared,
   and art generated without it comes back fading to some other near-black,
   which shows as a lighter band down the side of the window. */
let ground = null;
if (args.ground && args.ground !== true) {
  ground = String(args.ground).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(ground)) {
    console.error(`error: --ground must be a six-digit hex like "#0a0711" (got "${args.ground}").`);
    process.exit(1);
  }
} else if (palette && /^#[0-9a-f]{6}$/i.test(palette.bg || '')) {
  ground = palette.bg.toLowerCase();
}

let wanted;
if (args.slot && args.slot !== true) {
  wanted = [args.slot];
} else if (args.all) {
  wanted = ART_SLOTS.map((s) => s.id);
} else if (palette) {
  wanted = ART_SLOTS.filter((s) => s.id !== ANCHOR_SLOT).map((s) => s.id);
} else {
  wanted = [ANCHOR_SLOT];
}

if (args.all && !palette) {
  console.log('NOTE: --all without --with-palette emits every prompt up front, so you can');
  console.log('see the whole set. The rail and footer prompts below carry no palette and');
  console.log('nothing to match against yet. For art that actually looks like one set, do');
  console.log('the banner first, extract, then re-run with --with-palette.\n');
}

if (!ground && wanted.some((id) => (ART_SLOTS.find((s) => s.id === id) || {}).shape !== 'spot')) {
  console.log('NOTE: no --ground given, so the edge fades below can only ask for');
  console.log('"near-black". That is how art ends up fading to a colour a few shades off');
  console.log('the page and showing a seam. Pass --ground "#rrggbb" with the page');
  console.log('background you intend to use.\n');
}

for (const id of wanted) {
  const slot = ART_SLOTS.find((s) => s.id === id);
  if (!slot) { console.error(`error: unknown slot "${id}". Run \`slots\` to list them.`); process.exit(1); }
  console.log(`${'='.repeat(72)}\n${slug} / ${slot.id}  ->  client/public/themes/${slug}/${'art/' + slot.filename}\n${'='.repeat(72)}\n`);
  console.log(buildPrompt(slot, { mood: args.mood, palette, ground, isAnchor: slot.id === ANCHOR_SLOT }));
  console.log('');
}

if (!palette && wanted.length === 1 && wanted[0] === ANCHOR_SLOT) {
  const others = ART_SLOTS.filter((s) => s.id !== ANCHOR_SLOT).map((s) => s.id).join(', ');
  console.log('-'.repeat(72));
  console.log('THAT WAS STEP 1 OF 2. This prompt makes the banner only.');
  console.log('');
  console.log(`The other slots (${others}) come from step 2,`);
  console.log('which needs the banner to exist first so the rest of the art can be');
  console.log('generated to match it — four images made independently from the same');
  console.log('text do not look like one set.');
  console.log('');
  console.log('  1. Paste the prompt above into Gemini.');
  console.log(`  2. Save the result as client/public/themes/${slug}/art/banner.webp`);
  console.log('  3. Open /tools/theme-forge.html and drop it in. Save the CSS it writes');
  console.log(`     to client/public/themes/${slug}/theme.css`);
  console.log(`  4. npm run theme:prompt -- ${slug} --mood "..." --with-palette`);
  console.log('     ...then attach the banner to each of those prompts as a reference image.');
  console.log('');
  console.log('To see all four prompts now instead, add --all.');
}
