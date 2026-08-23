/**
 * Art slot specification — the single source of truth for every image a theme
 * can supply.
 *
 * Three things read this and nothing restates it:
 *   1. the theme loader (utils/theme.js), which turns each slot into a CSS
 *      custom property pointing at the theme's file;
 *   2. the chrome CSS, which consumes those properties;
 *   3. the prompt generator and palette extractor (Phase 4), which need the
 *      dimensions and composition rules to ask for art at the right size.
 *
 * Change a dimension here and the generated Gemini prompt changes with it.
 */

export const ART_SLOTS = [
  {
    id: 'banner',
    cssVar: '--art-banner',
    filename: 'banner.webp',
    width: 2400,
    height: 300,
    // The page title sits on top of the middle, so the centre has to stay quiet.
    safeArea: 'central 60% must be low-detail and below ~35% luminance',
    overlaidText: true,
    scrim: 'to bottom, transparent -> --bg',
    edgeFade: ['top', 'bottom'],
    tiles: false,
  },
  {
    id: 'rail-left',
    cssVar: '--art-rail-left',
    filename: 'rail-left.webp',
    width: 400,
    height: 2000,
    safeArea: 'inner edge (right) must dissolve to nothing',
    overlaidText: false,
    scrim: 'to right, opaque -> transparent',
    edgeFade: ['right'],
    tiles: 'vertical',
  },
  {
    id: 'rail-right',
    cssVar: '--art-rail-right',
    filename: 'rail-right.webp',
    width: 400,
    height: 2000,
    safeArea: 'inner edge (left) must dissolve to nothing',
    overlaidText: false,
    scrim: 'to left, opaque -> transparent',
    edgeFade: ['left'],
    tiles: 'vertical',
  },
  {
    id: 'footer',
    cssVar: '--art-footer',
    filename: 'footer.webp',
    width: 2400,
    height: 200,
    safeArea: 'version and links sit left and right; keep both ends calm',
    overlaidText: true,
    scrim: 'to top, transparent -> --bg',
    edgeFade: ['top'],
    tiles: false,
  },
];

/** The slot whose art anchors the palette extraction. */
export const ANCHOR_SLOT = 'banner';

export function getSlot(id) {
  return ART_SLOTS.find((s) => s.id === id) || null;
}
