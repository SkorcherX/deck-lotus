/**
 * Price bands — the same scheme the Android companion app pulses when a card
 * is scanned (`PriceBand` in deck-lotus-android's CaptureViewModel.kt), so a
 * card reads the same colour on the phone and on the page.
 *
 * Thresholds are inclusive lower bounds in USD, checked from the top. The
 * colours are tokens (`--price-band-*` in main.css), locked across themes like
 * rarity: they are a recognition cue, and one that has to match the phone.
 *
 * `unknown` is no price at all, which is a different statement from cheap.
 * Thousands of printings have no tcgplayer row, and grey is the band that
 * says a card is not worth setting aside — showing it for a card nobody has
 * priced says something the data does not support.
 *
 * Import-free on purpose, so the server and the client can both load it.
 */
export const PRICE_BANDS = [
  { key: 'purple', min: 20, label: '$20+' },
  { key: 'blue', min: 10, label: '$10–20' },
  { key: 'green', min: 5, label: '$5–10' },
  { key: 'yellow', min: 1, label: '$1–5' },
  { key: 'grey', min: -Infinity, label: 'Under $1' },
];

export const UNKNOWN_BAND = { key: 'unknown', min: null, label: 'No price' };

/** The band one copy's price falls in; null/undefined is `unknown`, not grey. */
export function priceBand(price) {
  if (price === null || price === undefined || Number.isNaN(Number(price))) return UNKNOWN_BAND;
  const value = Number(price);
  return PRICE_BANDS.find((band) => value >= band.min) || PRICE_BANDS[PRICE_BANDS.length - 1];
}
