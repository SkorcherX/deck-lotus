/**
 * Art prompt builder — the single implementation, shared by both front ends.
 *
 * Two things generate prompts and neither restates this: the CLI
 * (scripts/theme-forge.mjs) and the browser wizard
 * (client/public/tools/theme-forge.html, which loads this file from /tools/
 * via the copy step in vite.config.js). Change the wording once, here.
 *
 * The dimensions and composition rules come from slots.js, so a slot resized
 * there changes the prompt without anything being edited twice.
 */

import { ART_SLOTS, ANCHOR_SLOT } from './slots.js';

/**
 * Things image models add unasked. The list is repetitive on purpose: naming
 * text five ways is what stops a banner-shaped canvas coming back with
 * plausible-looking garbled lettering baked into it.
 */
export const NEGATIVES = [
  'text', 'letters', 'words', 'numbers', 'glyphs', 'runes', 'calligraphy',
  'watermarks', 'signatures', 'logos', 'UI elements', 'buttons', 'borders',
  'frames', 'card frames', 'any decorative edge treatment',
];

/** The surface lightness ladder. Themes pick hue and chroma; this picks depth. */
export const SURFACE_L = { bg: 0.155, secondary: 0.205, tertiary: 0.265, hover: 0.325 };
export const SURFACE_C_MAX = 0.045;

export function simplifyRatio(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function listEdges(edges) {
  if (!edges || !edges.length) return 'outer edges';
  if (edges.length === 1 && edges[0] === 'all') return 'outer edges';
  const names = edges.map((e) => `${e} edge`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.slice(-1)}`;
}

/**
 * Build the prompt for one slot.
 *
 * `ground` is the exact hex of the page background the art will sit against,
 * and it is the difference between art that dissolves into the page and art
 * that ends in a visible seam. The rails are painted as opaque images with no
 * CSS mask over them, so nothing downstream can rescue an edge that faded to
 * "near-black" in general rather than to this colour in particular — a rail
 * whose darkest tone is #14101f against a #0a0711 page reads as a lighter
 * stripe down the side of the window, which is the failure this argument
 * exists to prevent. Naming the hex, repeatedly and numerically, is the
 * instruction image models actually act on.
 */
export function buildPrompt(slot, { mood, palette = null, isAnchor = false, ground = null } = {}) {
  const lines = [];
  const shape = slot.tiles === 'vertical'
    ? 'Vertical decorative panel'
    : 'Wide decorative banner illustration';

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
  lines.push(...groundLines(slot, ground));

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
  lines.push(`Deliver as ${slot.filename.split('.').pop().toUpperCase()}, exactly ${slot.width}x${slot.height}, with no border, no matte and no padding added around the canvas.`);
  return lines.join('\n');
}

/**
 * The edge-fade instruction. With a ground colour it names the hex and says
 * how far in to run the fade; without one it can only ask for "near-black",
 * which is what produced grey-purple seams in the first place.
 */
function groundLines(slot, ground) {
  const edges = listEdges(slot.edgeFade);
  const depth = slot.tiles === 'vertical' ? '35%' : '20%';
  if (!ground) {
    return [
      `EDGES: The ${edges} must fade toward flat near-black so the image dissolves`,
      'into the page rather than ending in a hard line.',
      '',
      'NOTE: no exact background colour was supplied, so this fade is approximate.',
      'Supplying one is what makes the edge actually disappear.',
    ];
  }
  const many = slot.edgeFade && slot.edgeFade.length > 1;
  const out = [
    `BACKGROUND COLOUR — THIS IS EXACT, NOT APPROXIMATE: ${ground}`,
    `The page behind this image is the flat colour ${ground} (${describeHex(ground)}).`,
    `The ${edges} must fade to precisely ${ground} — not to black, not to a dark`,
    'neutral grey, and not merely to a darker version of the artwork. The final',
    `row of pixels along ${many ? 'each of those edges' : 'that edge'} must be flat ${ground} with no`,
    `texture, noise or vignette in it, and the fade should run about ${depth} of`,
    'the way in so the transition is gradual rather than a band.',
    '',
    `The darkest tone anywhere in the image should be ${ground} itself: let shadows`,
    'settle toward that colour rather than toward neutral black, so the whole',
    'picture belongs to the page it is painted on.',
  ];
  if (slot.tiles === 'vertical') {
    out.push('');
    out.push('This panel is shown at the edge of the window with nothing masking it: if');
    out.push(`its inner edge is even slightly lighter than ${ground}, it reads as a`);
    out.push('visible stripe down the side of the screen.');
  }
  return out;
}

/** Plain-language gloss, so the model has more than six hex digits to go on. */
export function describeHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const depth = max < 24 ? 'near-black' : max < 48 ? 'very dark' : 'dark';
  if (max - min < 6) return `${depth} neutral, RGB ${r},${g},${b}`;
  let cast = 'tinted';
  if (r === max && b >= g) cast = b - g > 10 ? 'magenta-cast' : 'red-cast';
  else if (r === max) cast = 'warm amber-cast';
  else if (g === max) cast = 'green-cast';
  else if (b === max) cast = r > g ? 'violet-cast' : 'blue-cast';
  return `${depth} ${cast}, RGB ${r},${g},${b}`;
}

export { ART_SLOTS, ANCHOR_SLOT };
