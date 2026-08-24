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
 *
 * Removing one is the other half of that: the wizard, the prompt generator and
 * the loader all derive from this list, so a slot deleted here stops being
 * asked for everywhere at once. The `empty` and `celebration` spots went that
 * way — two square illustrations every theme had to commission, one for the
 * screens people look at least and one for an overlay that stopped being fun
 * around the sixth time it fired.
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
    safeArea: 'inner edge (right) must dissolve to nothing; top and bottom must end in flat background so the vertical repeat has no seam',
    overlaidText: false,
    scrim: 'to right, opaque -> transparent',
    // Top and bottom are in the list for tiling, not for the page edge. A
    // panel that ends in the flat ground colour at both ends tiles seamlessly
    // whatever is drawn between them, which is a far easier thing to ask an
    // image model for than two edges whose detail continues into each other.
    edgeFade: ['right', 'top', 'bottom'],
    tiles: 'vertical',
    // The right rail can be this one flipped — see `mirrorRails` in a theme
    // manifest. Nothing here changes when it is; the manifest just omits the
    // other rail and the CSS mirrors this file in place.
    mirrorable: true,
  },
  {
    id: 'rail-right',
    cssVar: '--art-rail-right',
    filename: 'rail-right.webp',
    width: 400,
    height: 2000,
    safeArea: 'inner edge (left) must dissolve to nothing; top and bottom must end in flat background so the vertical repeat has no seam',
    overlaidText: false,
    scrim: 'to left, opaque -> transparent',
    edgeFade: ['left', 'top', 'bottom'],
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
    // The footer is generated from the same mood sentence as the banner, with
    // the banner attached as a style reference — which reliably produced the
    // banner again, slightly shorter. It is the only slot that has to be told
    // what to do *differently*, because it is the only one whose brief would
    // otherwise be identical to the anchor's.
    variation: 'The banner is attached as a style reference, not as a subject reference. Do not repeat its composition, its focal point or its main motif. This band sits at the far end of a long page from the banner and should read as a different view of the same world — if the banner is a figure or a structure, this is landscape, horizon, ground detail, or distant architecture. Quieter and emptier than the banner: it closes the page rather than opening it.',
  },
];

/** The slot whose art anchors the palette extraction. */
export const ANCHOR_SLOT = 'banner';

export function getSlot(id) {
  return ART_SLOTS.find((s) => s.id === id) || null;
}
