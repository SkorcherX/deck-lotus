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

import { ART_SLOTS } from '../themes/slots.js';
import { DEFAULT_THEME, FALLBACK_THEME, isValidTheme, resolveTheme } from '../themes/registry.js';

const STORAGE_KEY = 'deckLotusTheme';
const LINK_ID = 'theme-stylesheet';

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

/* -------------------------------------------------------------------------
 * Theme loading
 *
 * A theme is a folder under /themes/<slug>/ holding a manifest, a stylesheet
 * of token overrides, and its art. Applying one does three things: stamp the
 * slug on <html> so the [data-theme] rules match, swap the stylesheet link,
 * and point the art-slot custom properties at that theme's files.
 *
 * The :root block in main.css is the fail-safe: if the stylesheet 404s or is
 * slow, the app still renders in the baseline palette rather than unstyled.
 * ------------------------------------------------------------------------- */

/** The theme this browser last used, or null. Safe against disabled storage. */
export function getStoredTheme() {
  try {
    const slug = localStorage.getItem(STORAGE_KEY);
    return isValidTheme(slug) ? slug : null;
  } catch (err) {
    return null;
  }
}

function storeTheme(slug) {
  try {
    localStorage.setItem(STORAGE_KEY, slug);
  } catch (err) {
    /* private mode or storage disabled — the server copy is the real record */
  }
}

/**
 * Point every art-slot property at this theme, or clear it if unsupplied, and
 * stamp a has-art-<slot> class for each one present.
 *
 * The class is what the chrome keys off. CSS cannot ask "is this custom
 * property set?", and a themed band that reserves its height whether or not
 * art arrives would leave an empty stripe on every art-less theme.
 */
function applyArtSlots(slug, art) {
  const root = document.documentElement;
  for (const slot of ART_SLOTS) {
    const file = art && art[slot.id];
    if (file) {
      root.style.setProperty(slot.cssVar, `url("/themes/${slug}/${file}")`);
    } else {
      // A theme without this slot must degrade to no image, never a 404 box.
      root.style.removeProperty(slot.cssVar);
    }
    root.classList.toggle(`has-art-${slot.id}`, Boolean(file));
  }
}

function loadStylesheet(slug) {
  return new Promise((resolve) => {
    const href = `/themes/${slug}/theme.css`;
    let link = document.getElementById(LINK_ID);
    if (link && link.getAttribute('href') === href) return resolve(true);
    if (!link) {
      link = document.createElement('link');
      link.id = LINK_ID;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.onload = () => resolve(true);
    link.onerror = () => resolve(false);
    link.setAttribute('href', href);
  });
}

async function loadManifest(slug) {
  try {
    const res = await fetch(`/themes/${slug}/theme.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Switch to a theme: stamp it, load its stylesheet, wire up its art.
 * Returns the slug actually applied, which may differ from the one asked for
 * if it does not ship or its stylesheet failed to load.
 */
export async function applyTheme(slug, { persist = true } = {}) {
  let target = resolveTheme(slug);

  document.documentElement.setAttribute('data-theme', target);
  const ok = await loadStylesheet(target);

  if (!ok && target !== FALLBACK_THEME) {
    // The pack is broken or missing. Fall back rather than leave the page
    // stamped with a theme whose tokens never arrived.
    target = FALLBACK_THEME;
    document.documentElement.setAttribute('data-theme', target);
    await loadStylesheet(target);
  }

  const manifest = await loadManifest(target);
  applyArtSlots(target, manifest && manifest.art);

  // Token values just changed underneath the memoised reads.
  clearTokenCache();
  if (persist) storeTheme(target);
  document.dispatchEvent(new CustomEvent('theme:changed', { detail: { theme: target } }));
  return target;
}

/**
 * Apply the theme this browser already knows about, before any profile round
 * trip. Called as early as possible so there is no flash of the default, and
 * so the pre-login page is themed too.
 */
export function initTheme() {
  return applyTheme(getStoredTheme() || DEFAULT_THEME, { persist: false });
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
}
