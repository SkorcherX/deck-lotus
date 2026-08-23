/**
 * Theme registry.
 *
 * Adding a theme for a release means dropping a folder into
 * client/public/themes/<slug>/ and adding one entry here. Nothing else in the
 * app needs to change.
 *
 * The slug is used to build a URL, so it is validated on the way in and on the
 * server side of the preference endpoint. Never trust a slug from the client.
 */

export const THEMES = [
  {
    slug: 'arcane',
    name: 'Arcane',
    description: 'Violet on obsidian. Deeper and higher-contrast than the original.',
    // Shown as the picker preview; order is surface, surface, accent, highlight.
    swatches: ['#0a0711', '#14101f', '#8348ec', '#38d6ec'],
  },
  {
    slug: 'classic',
    name: 'Classic',
    description: 'The original indigo-on-slate palette.',
    swatches: ['#0f172a', '#1e293b', '#6366f1', '#ec4899'],
  },
];

export const DEFAULT_THEME = 'arcane';

/** Fail-safe used when a stored preference names a theme that no longer ships. */
export const FALLBACK_THEME = 'classic';

const BY_SLUG = new Map(THEMES.map((t) => [t.slug, t]));

export function isValidTheme(slug) {
  return typeof slug === 'string' && BY_SLUG.has(slug);
}

export function getTheme(slug) {
  return BY_SLUG.get(slug) || null;
}

/** Resolve any candidate to a slug that definitely ships. */
export function resolveTheme(slug) {
  return isValidTheme(slug) ? slug : DEFAULT_THEME;
}
