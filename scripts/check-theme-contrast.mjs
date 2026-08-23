import { readFileSync } from 'node:fs';

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
  '--rarity-uncommon': base['--rarity-uncommon'], '--success': base['--success'],
  '--danger': base['--danger'], '--warning': base['--warning'],
  '--status-ok': base['--status-ok'], '--status-warn': base['--status-warn'],
  '--status-unknown': base['--status-unknown'],
};

// Colours that already fail on the stock palette. A new theme must not make
// them worse, but it is not required to fix them — that is a deliberate
// product decision about locked recognition cues, not a theming bug.
const KNOWN = new Set(['uncommon on card', 'mythic on card', 'highlight on card']);

const results = {};
let regressions = 0;
for (const slug of ['classic', 'arcane']) {
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
    ['rare on card',                 t['--rarity-rare'], t['--bg-secondary'], 4.5],
    ['mythic on card',               t['--rarity-mythic'], t['--bg-secondary'], 4.5],
    ['uncommon on card',             t['--rarity-uncommon'], t['--bg-secondary'], 4.5],
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
