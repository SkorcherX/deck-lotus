import { readFileSync, readdirSync, existsSync } from 'node:fs';

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const L = (h) => { const n = parseInt(h.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function parse(file) {
  const src = readFileSync(file, 'utf8');
  const out = {};
  for (const m of src.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
}

// Locked colours live in main.css, not the packs.
const base = parse('client/src/styles/main.css');
const LOCKED = {
  '--rarity-rare': base['--rarity-rare'], '--rarity-mythic': base['--rarity-mythic'],
  '--rarity-uncommon': base['--rarity-uncommon'], '--rarity-common': base['--rarity-common'],
  '--rarity-rare-fill': base['--rarity-rare-fill'], '--rarity-mythic-fill': base['--rarity-mythic-fill'],
  '--rarity-uncommon-fill': base['--rarity-uncommon-fill'], '--rarity-common-fill': base['--rarity-common-fill'],
  '--on-rarity-rare': base['--on-rarity-rare'], '--on-rarity-uncommon': base['--on-rarity-uncommon'],
  '--on-rarity-mythic': base['--on-rarity-mythic'],
  '--rarity-rare-grad-a': base['--rarity-rare-grad-a'], '--rarity-rare-grad-b': base['--rarity-rare-grad-b'],
  '--rarity-mythic-grad-a': base['--rarity-mythic-grad-a'], '--rarity-mythic-grad-b': base['--rarity-mythic-grad-b'],
  '--rarity-uncommon-grad-b': base['--rarity-uncommon-grad-b'],
  '--on-accent': base['--on-accent'], '--success': base['--success'],
  '--danger': base['--danger'], '--warning': base['--warning'],
  '--status-ok': base['--status-ok'], '--status-warn': base['--status-warn'],
  '--status-unknown': base['--status-unknown'],
};

// Colours that already fail on the stock palette. A new theme must not make
// them worse, but it is not required to fix them — that is a deliberate
// product decision about locked recognition cues, not a theming bug.
const KNOWN = new Set(['highlight on card']);

/* Every pack on disk, not a hardcoded list — a theme that is not checked is
   the whole failure this script exists to prevent. `classic` goes first
   because every other theme is graded against it as the baseline. */
const THEME_DIR = 'client/public/themes';
const slugs = readdirSync(THEME_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(`${THEME_DIR}/${e.name}/theme.css`))
  .map((e) => e.name)
  .sort((a, b) => (a === 'classic' ? -1 : b === 'classic' ? 1 : a.localeCompare(b)));

if (!slugs.includes('classic')) {
  console.error('error: no classic pack found; it is the baseline every theme is graded against.');
  process.exit(1);
}
console.log(`checking ${slugs.length} theme(s): ${slugs.join(', ')}`);

/* A pack that declares a selector not matching its own folder name is dead —
   it will never apply. This is easy to do: the extractor names the file after
   the image you dropped in. */
let structural = 0;
for (const slug of slugs) {
  const css = readFileSync(`${THEME_DIR}/${slug}/theme.css`, 'utf8');
  if (!css.includes(`:root[data-theme="${slug}"]`)) {
    const found = css.match(/\[data-theme="([^"]+)"\]/);
    console.error(`  STRUCTURAL  ${slug}/theme.css targets ${found ? `"${found[1]}"` : 'nothing'}, not "${slug}" — it will never apply`);
    structural++;
  }
  if (!existsSync(`${THEME_DIR}/${slug}/theme.json`)) {
    console.error(`  STRUCTURAL  ${slug} has no theme.json — its art will never be wired up`);
    structural++;
  }
}

const results = {};
let regressions = 0;
for (const slug of slugs) {
  const t = { ...base, ...parse(`client/public/themes/${slug}/theme.css`), ...LOCKED };
  console.log(`\n=== ${slug} ===`);
  const checks = [
    ['body text on page',            t['--text'], t['--bg'], 4.5],
    ['body text on card',            t['--text'], t['--bg-secondary'], 4.5],
    ['secondary text on card',       t['--text-secondary'], t['--bg-secondary'], 4.5],
    ['muted text on card',           t['--text-muted'], t['--bg-secondary'], 4.5],
    ['muted text on page',           t['--text-muted'], t['--bg'], 4.5],
    ['text on tertiary surface',     t['--text'], t['--bg-tertiary'], 4.5],
    ['text on hover surface',        t['--text'], t['--bg-hover'], 4.5],
    ['border-strong as boundary',    t['--border-strong'], t['--bg-secondary'], 3.0],
    ['primary-light on card',        t['--primary-light'], t['--bg-secondary'], 4.5],
    ['highlight on card',            t['--highlight'], t['--bg-secondary'], 4.5],
    ['white on primary button',      t['--on-accent'], t['--primary-btn'], 4.5],
    ['white on success button',      t['--on-accent'], t['--success-btn'], 4.5],
    ['white on danger button',       t['--on-accent'], t['--danger-btn'], 4.5],
    ['dark on warning button',       t['--on-warning'], t['--warning-btn'], 4.5],
    ['text on secondary button',     t['--text'], t['--surface-btn'], 4.5],
    // Rarity colours are BADGE BACKGROUNDS carrying a label, not foreground
    // text. Checking them as text was measuring a direction the app never
    // uses, and reported a failure that did not exist.
    ['label on rare badge',          t['--on-rarity-rare'], t['--rarity-rare-fill'], 4.5],
    ['label on mythic badge',        t['--on-rarity-mythic'], t['--rarity-mythic-fill'], 4.5],
    ['label on uncommon badge',      t['--on-rarity-uncommon'], t['--rarity-uncommon-fill'], 4.5],
    ['label on common badge',        t['--on-accent'], t['--rarity-common-fill'], 4.5],
    ['common vs uncommon apart',     t['--rarity-common-fill'], t['--rarity-uncommon-fill'], 3.0],
    // The card-detail pill is a gradient, so its label must clear BOTH stops.
    ['pill label, rare light stop',  t['--on-accent'], t['--rarity-rare-grad-a'], 4.5],
    ['pill label, rare dark stop',   t['--on-accent'], t['--rarity-rare-grad-b'], 4.5],
    ['pill label, mythic light stop', t['--on-accent'], t['--rarity-mythic-grad-a'], 4.5],
    ['pill label, mythic dark stop', t['--on-accent'], t['--rarity-mythic-grad-b'], 4.5],
    ['pill label, uncommon dark stop', t['--on-rarity-uncommon'], t['--rarity-uncommon-grad-b'], 4.5],
    // The rarity filter chips use the flat identity colour, not the fill.
    ['chip label, rare',             t['--on-rarity-rare'], t['--rarity-rare'], 4.5],
    ['chip label, mythic',           t['--on-rarity-mythic'], t['--rarity-mythic'], 4.5],
    ['chip label, uncommon',         t['--on-rarity-uncommon'], t['--rarity-uncommon'], 4.5],
    ['legality ok on card',          t['--status-ok'], t['--bg-secondary'], 4.5],
    ['legality warn on card',        t['--status-warn'], t['--bg-secondary'], 4.5],
    ['legality unknown on card',     t['--status-unknown'], t['--bg-secondary'], 4.5],
  ];
  results[slug] = {};
  for (const [name, fg, bg, min] of checks) {
    if (!fg || !bg || !fg.startsWith('#') || !bg.startsWith('#')) {
      console.log(`  SKIP        ${name}  (${fg} on ${bg})`);
      continue;
    }
    const r = ratio(fg, bg);
    results[slug][name] = r;
    const ok = r >= min;
    let verdict, note = '';
    if (ok) {
      verdict = 'pass';
      if (slug !== 'classic' && results.classic[name] !== undefined && results.classic[name] < min) {
        note = `  <- FIXED (was ${results.classic[name].toFixed(2)} on classic)`;
      }
    } else if (KNOWN.has(name)) {
      verdict = 'known';
      const baseline = results.classic[name];
      if (slug !== 'classic' && baseline !== undefined) {
        if (r < baseline - 0.01) { verdict = 'REGRESS'; regressions++; note = `  <- WORSE than classic (${baseline.toFixed(2)})`; }
        else if (r > baseline + 0.01) note = `  <- improved from ${baseline.toFixed(2)}, still short`;
      }
    } else {
      verdict = 'FAIL';
      regressions++;
    }
    console.log(`  ${verdict.padEnd(7)} ${r.toFixed(2).padStart(5)}:1 (>=${min})  ${name}${note}`);
  }
}
console.log('\nknown, pre-existing on the stock palette (product decisions, not theming bugs):');
for (const n of KNOWN) console.log(`  - ${n}`);
console.log(regressions ? `\n${regressions} REGRESSION(S) — do not ship` : '\nno regressions: every theme is at least as legible as the stock palette');
process.exitCode = regressions ? 1 : 0;
