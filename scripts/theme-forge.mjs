#!/usr/bin/env node
/**
 * Theme forge — art prompt generator.
 *
 * Emits a paste-ready Gemini prompt for one art slot, built from the SAME slot
 * spec the CSS and the loader consume (client/src/themes/slots.js). Change a
 * dimension there and the prompt changes with it; nothing is written twice.
 *
 *   node scripts/theme-forge.mjs prompt <slug> --mood "..." [--slot banner]
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
const { ART_SLOTS, ANCHOR_SLOT } = await import(
  new URL('../client/src/themes/slots.js', import.meta.url)
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

const NEGATIVES = [
  'text', 'letters', 'words', 'numbers', 'glyphs', 'runes', 'calligraphy',
  'watermarks', 'signatures', 'logos', 'UI elements', 'buttons', 'borders',
  'frames', 'card frames', 'any decorative edge treatment',
];

function buildPrompt(slot, { mood, palette, isAnchor }) {
  const lines = [];
  const shape = slot.tiles === 'vertical' ? 'Vertical decorative panel' : 'Wide decorative banner illustration';
  lines.push(`${shape}, exactly ${slot.width}x${slot.height} pixels, ${simplifyRatio(slot.width, slot.height)} aspect ratio.`);
  lines.push('');
  lines.push(`SUBJECT: ${mood}`);
  lines.push('MEDIUM: painted digital illustration, Magic: The Gathering card-art character,');
  lines.push('        visible brushwork, no photographic realism.');
  lines.push('');
  lines.push(`COMPOSITION: ${slot.safeArea}.`);
  if (slot.overlaidText) {
    lines.push('Interface text sits directly on top of this image, so the area named above');
    lines.push('must stay quiet, low-detail and uncluttered.');
  }
  lines.push('');
  lines.push('VALUE: This is a dark UI. Keep the image in the lower half of the value');
  lines.push('range. Highlights are permitted only away from the area named above.');
  lines.push('');
  lines.push(`EDGES: The ${listEdges(slot.edgeFade)} must fade toward flat near-black so the`);
  lines.push('image dissolves into the page rather than ending in a hard line.');
  if (slot.tiles === 'vertical') {
    lines.push('');
    lines.push('TILING: This panel repeats vertically. The top and bottom edges must match');
    lines.push('so the seam is invisible when it repeats.');
  }
  if (palette) {
    lines.push('');
    lines.push('PALETTE: build the image from these colours, which the interface around it');
    lines.push('already uses:');
    lines.push(`  background ${palette.bg}   surfaces ${palette.bgSecondary}`);
    lines.push(`  accent ${palette.primary}   highlight ${palette.highlight}`);
  }
  if (!isAnchor) {
    lines.push('');
    lines.push('MATCH THE ATTACHED IMAGE: same palette, same lighting, same brush character.');
    lines.push('This belongs to the same set as the banner, not merely the same idea.');
  }
  lines.push('');
  lines.push(`DO NOT INCLUDE: ${NEGATIVES.join(', ')}.`);
  lines.push('');
  lines.push(`Deliver as ${slot.filename.split('.').pop().toUpperCase()}, exactly ${slot.width}x${slot.height}.`);
  return lines.join('\n');
}

function simplifyRatio(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function listEdges(edges) {
  if (!edges || !edges.length) return 'outer edges';
  const names = edges.map((e) => `${e} edge`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.slice(-1)}`;
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
  console.error('usage: node scripts/theme-forge.mjs prompt <slug> --mood "..." [--slot <id>] [--with-palette]');
  console.error('       node scripts/theme-forge.mjs slots');
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

for (const id of wanted) {
  const slot = ART_SLOTS.find((s) => s.id === id);
  if (!slot) { console.error(`error: unknown slot "${id}". Run \`slots\` to list them.`); process.exit(1); }
  console.log(`${'='.repeat(72)}\n${slug} / ${slot.id}  ->  client/public/themes/${slug}/${'art/' + slot.filename}\n${'='.repeat(72)}\n`);
  console.log(buildPrompt(slot, { mood: args.mood, palette, isAnchor: slot.id === ANCHOR_SLOT }));
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
