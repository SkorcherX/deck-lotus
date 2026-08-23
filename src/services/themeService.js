import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/**
 * Server-side theme validation.
 *
 * The client registry (client/src/themes/registry.js) is NOT importable here:
 * the Dockerfile copies only client/dist into the runtime image, so reaching
 * into client/src would work in dev and crash in production. This enumerates
 * the packs that actually ship instead.
 *
 * Two locations, because the built image and a source checkout differ:
 *   client/dist/themes    what the container serves
 *   client/public/themes  the source, before a build
 */
const THEME_DIRS = [
  join(ROOT, 'client', 'dist', 'themes'),
  join(ROOT, 'client', 'public', 'themes'),
];

export const DEFAULT_THEME = 'arcane';

/**
 * A slug becomes a URL path segment on the client, so the shape is checked
 * before anything else. This is the part that must never be relaxed, whatever
 * happens with the directory listing below.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isWellFormedSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/** Slugs of every pack on disk, or null when no theme directory can be read. */
export function listInstalledThemes() {
  for (const dir of THEME_DIRS) {
    if (!existsSync(dir)) continue;
    try {
      const slugs = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'theme.css')))
        .map((e) => e.name)
        .filter(isWellFormedSlug);
      if (slugs.length) return slugs;
    } catch (err) {
      /* unreadable directory — fall through to the next candidate */
    }
  }
  return null;
}

/**
 * Validate a requested theme.
 *
 * Shape is always enforced. Membership is enforced only when the packs can
 * actually be listed: if the directory is missing — an unusual deploy, a
 * volume not mounted yet — a well-formed slug is accepted rather than locking
 * every user out of changing their theme. An unknown slug is harmless at the
 * far end, because the client resolves one it does not recognise back to the
 * default.
 */
export function validateTheme(slug) {
  if (!isWellFormedSlug(slug)) {
    return { ok: false, error: 'theme must be a slug of lowercase letters, digits and hyphens' };
  }
  const installed = listInstalledThemes();
  if (installed && !installed.includes(slug)) {
    return { ok: false, error: `unknown theme "${slug}"`, installed };
  }
  return { ok: true, slug };
}
