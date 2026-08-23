/**
 * Token bridge.
 *
 * CSS custom properties are the single source of truth for colour, but some
 * consumers cannot read them: Chart.js wants real colour strings for its
 * datasets, and canvas has no cascade at all. Everything that needs a resolved
 * value goes through here rather than hardcoding a hex.
 *
 * Inline styles built in JS do NOT need this — `style="color: var(--danger)"`
 * resolves normally inside innerHTML. Reach for token() only when the value
 * has to be a real colour string.
 */

let cache = new Map();

/**
 * Resolved value of a CSS custom property from :root.
 * @param {string} name  e.g. '--primary' (with or without the leading --)
 * @param {string} [fallback] returned when the property is unset
 */
export function token(name, fallback = '') {
  const prop = name.startsWith('--') ? name : `--${name}`;
  if (cache.has(prop)) return cache.get(prop);
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(prop)
    .trim() || fallback;
  cache.set(prop, value);
  return value;
}

/**
 * Drop every memoised value. Call after switching themes — the properties
 * change underneath the cache and stale colours would otherwise persist until
 * reload.
 */
export function clearTokenCache() {
  cache = new Map();
}

/** Ramp colour for a converted mana cost. Cycles above 10. */
export function cmcColor(cmc) {
  const n = Number(cmc);
  if (!Number.isFinite(n) || n < 0) return token('--cmc-default', '#6b7280');
  const index = n > 10 ? n % 11 : n;
  return token(`--cmc-${index}`, token('--cmc-default', '#6b7280'));
}

const MANA_TOKENS = { W: '--mana-w', U: '--mana-u', B: '--mana-b', R: '--mana-r', G: '--mana-g' };

/** Colour for a single mana symbol letter. */
export function manaColor(letter) {
  const prop = MANA_TOKENS[String(letter).toUpperCase()];
  return prop ? token(prop) : token('--mana-unknown', '#cccccc');
}

/**
 * Shift a hex colour's channels by `amount` (-255..255). Used to derive the
 * second stop of a single-colour gradient.
 */
export function adjustBrightness(color, amount) {
  const hex = String(color).replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return color;
  const num = parseInt(hex, 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(((num >> 16) & 0xff) + amount);
  const g = clamp(((num >> 8) & 0xff) + amount);
  const b = clamp((num & 0xff) + amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * Background gradient for a card's colour identity. Single colours get a
 * shaded gradient of themselves; multicolour cards blend their mana colours in
 * order; colourless falls back to the neutral pair.
 */
export function manaGradient(colors) {
  if (!colors) {
    return `linear-gradient(135deg, ${token('--mana-colorless-a', '#d0c6bb')}, ${token('--mana-colorless-b', '#a8a8a8')})`;
  }
  const values = String(colors).split('').map(manaColor);
  if (values.length === 1) {
    return `linear-gradient(135deg, ${values[0]}, ${adjustBrightness(values[0], -20)})`;
  }
  return `linear-gradient(135deg, ${values.join(', ')})`;
}
