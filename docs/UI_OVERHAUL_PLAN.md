# Deck Lotus — Themeable UI Overhaul

## Context

The app is functional but visually flat: every page is a `.page-header` followed by an
undifferentiated content block. There is no banner, no footer, no background layer, no
gutter treatment — so there is nowhere for artwork to live and no structural rhythm to
read as "designed."

The token block at `client/src/styles/main.css:53-152` is already a real design system
(brand, status, surface, text, border, rarity, spacing, radii, shadow, easing, z-index),
but it is dark-only by construction and is undermined by ~55 stray hex values and ~72
`rgba()` calls elsewhere in `main.css`, plus ~92 hex literals hardcoded in JS (36 in
`deckBuilder.js` alone, mostly Chart.js palettes).

Goal: a **repeatable theme pack format** — one folder per theme, droppable per release —
plus the structural chrome that makes a theme visible, a generated Gemini art prompt so
each release's artwork arrives at the right slots and sizes, per-user theme selection,
and a small set of celebration animations.

### Decisions taken

- **Scope:** structural chrome *and* a shared component-surface restyle.
- **Theme power:** color tokens + art + accent shape (radii/shadow/border intensity).
  Layout, spacing scale and fonts stay fixed across themes — this is what keeps every
  future theme guaranteed-usable without QA.
- **Persistence:** `theme` column on `users` (migration 032, mirroring the avatar
  pattern) + a `localStorage` mirror for instant first paint.
- **Animation:** a small named set of celebration moments.
- **Default:** a new signature dark theme replaces the current indigo-on-slate.
- **Art slots:** side-rail tapestries (gutters), page banner strip, footer band,
  and 600x600 spot art for empty states and the win celebration.
- **Palette direction:** "Arcane" — violet on obsidian, run deeper and higher-contrast
  than today. Rarity and status colors locked across all themes.

---

> **Status:** Phases 0-2 are shipped. Phases 3-6 are still planned.
>
> | Phase | State |
> |---|---|
> | 0 - palette and tone | done - Arcane defined and contrast-verified |
> | 1 - tokenise | done - proven visually inert against 46 selectors |
> | 2 - theme pack format | done - `arcane` (default) and `classic` ship |
> | 3 - structural chrome | done - banner, gutter rails, footer, nav indicator |
> | 4 - theme forge | done - prompt generator and browser extractor |
> | 5 - per-user selection | localStorage half done; server column outstanding |
> | 6 - celebration animations | not started (the `celebration` art slot is ready) |
>
> Run `npm run check:themes` to re-check every theme's contrast,
> `npm run theme:slots` to list the art slots, and `npm run theme:prompt` to
> generate a Gemini prompt. The palette extractor is at
> `/tools/theme-forge.html` on the dev server.
>
> Arcane currently ships **SVG placeholder art** so the chrome is visible and
> testable. Replacing it with generated art is the remaining work in Phase 4.
> **Companion:** [`THEME_CREATION_GUIDE.md`](THEME_CREATION_GUIDE.md) — the step-by-step
> procedure for actually producing a theme once Phases 1–4 exist.

---

## Phase 0 — Palette and tone (defines what Phase 1 tokenizes *to*)

### The Arcane default

Deliberately distanced from the current Tailwind-indigo default. A richer, less blue
violet primary against cold obsidian surfaces, with a cool highlight for interactive
and data accents.

- **Primary:** true violet, more saturated and less blue than `#6366f1`, with
  `--primary-dark` / `--primary-light` / `--primary-soft` (translucent tint) derived
  from it. The existing `--brand-pink` is retired as a stray and folded into the
  accent ramp.
- **Highlight:** a cool cyan-leaning accent for links, focus rings, active nav
  indicator, and the first chart series — the current palette has no such role, which
  is why interactive state is hard to spot.
- **Surfaces:** rebuilt **deeper and higher-contrast** than today. Near-black obsidian
  page base carrying a faint cool tint (not neutral grey), then a clearly separated
  elevation ladder for `--bg-secondary` / `--bg-tertiary` / `--bg-hover`. The depth is
  what gives the banner and rail artwork separation from content — with today's flat
  mid-slate the art would mush into the page.
- **Text and borders** re-derived against the new base so contrast ratios hold at the
  deeper background; this is a real re-check, not a re-tint, because `--text-muted`
  on today's slate will not carry over unchanged.

### Locked across every theme

Rarity (`--rarity-common/uncommon/rare/mythic`) and status
(`--success`/`--danger`/`--warning`/`--info`) are **fixed**. Rarity colors are
recognition cues MTG players read without labels, and a theme that recolors mythic away
from orange breaks that; a theme that makes `--danger` look calm makes destructive
actions unsafe. Themes may tune saturation/intensity of these via a multiplier token,
but not hue.

This means the per-theme knobs are exactly three: **accent ramp, surface ladder, and
shape** (radii/shadow/border intensity) — which is also what makes the Gemini round trip
predictable, since art only ever has to sit against a known surface ladder.

### Contrast gate

Every built-in theme must clear WCAG AA for body text and UI borders against its own
surface ladder, checked at the token level once rather than per-component. It is a
checklist item in [`THEME_CREATION_GUIDE.md`](THEME_CREATION_GUIDE.md) — the one
constraint that a color-only theme pack can still violate.

---

## Phase 1 — Tokenize (prerequisite; nothing else works without it)

The single highest-value and least glamorous phase. No visual change should result.

1. **Extend the token vocabulary** in `main.css:53-152` with what themes need but that
   does not exist yet: overlay/scrim, elevated-surface, accent-gradient stops, focus
   ring, chart series 1..8, and the shape tokens a theme may tune
   (`--radius-*` intensity, `--shadow-*` strength, `--border-width`).
2. **Sweep the stray CSS colors.** Replace the ~55 hex and ~72 `rgba()` occurrences
   outside the token block with tokens. Notable clusters: `#d97706`×4, `#1f1300`×3,
   `#f5d17a`, `#f0abfc`, `#22d3ee`, `#3fa66a`, `#d98324`, `#1e1b4b`. Where an `rgba()`
   is a translucent tint of a brand color, introduce a matching `--x-soft` token rather
   than a one-off.
3. **New `client/src/utils/theme.js`** exposing `token(name)` (a cached
   `getComputedStyle(document.documentElement).getPropertyValue`) and
   `chartPalette(n)`. This is the bridge JS needs — Chart.js cannot read CSS variables.
4. **Sweep the JS hex literals** through that helper. Priority order:
   `deckBuilder.js:2492-2519` (mana-curve / type-distribution ramp) and `:2286`,
   `cards.js:725-727` (rarity gradients) and `:903-911`, then `utils/avatar.js`,
   `sharedDeck.js`, `priceMonitoring.js`, `trades.js`, `shopping.js`, `decks.js`,
   `utils/gravatar.js`.
5. **Sweep raw `style="..."` in `index.html`** — most already use `var(--…)`; fix the
   remainder (e.g. the `background:#16a34a;color:#fff` badge).

**Definition of done:** grep for hex literals in `client/src` returns only the theme
files themselves and the vendored font CSS.

---

## Phase 2 — Theme pack format

A theme is a self-contained folder. Adding a release theme means adding a folder and
one manifest line — no code changes.

```
client/public/themes/<slug>/
  theme.json      # manifest: name, author, appearance, art slot filenames
  theme.css       # :root[data-theme="<slug>"] { --token: value; }  — tokens only
  art/
    rail-left.webp      rail-right.webp
    banner.webp
    footer.webp
```

> The `:root` prefix is load-bearing. A bare `[data-theme="..."]` has exactly the
> same specificity as the `:root` baseline (0,1,0), so the winner would come down
> to source order — and Vite emits `main.css` as a `<link>` in production but
> injects it from JS in dev. `:root[data-theme]` is (0,2,0) and wins in both.

- `client/src/themes/registry.js` — the list of available themes (slug, display name,
  preview swatches). Read by the settings picker.
- Loader in `main.js`: sets `document.documentElement.dataset.theme`, injects the
  theme's `<link>`, and sets art-slot custom properties
  (`--art-rail-left: url(...)`) so CSS references art indirectly and a theme with a
  missing slot degrades to no image rather than a broken one.
- **Constraint enforced by convention and review:** `theme.css` may only declare custom
  properties. No selectors, no layout, no font swaps.
- `:root` in `main.css` keeps the stock indigo as a **fail-safe baseline** rather
  than being stripped: if a theme stylesheet 404s or is slow, the app renders in a
  working palette instead of unstyled. `classic` restates those values explicitly
  so it is a real choice a user can stay on, not merely the absence of a theme.
- A pre-paint inline script in `index.html` stamps the theme and injects its
  stylesheet during head parsing. The module bundle loads too late to avoid a
  flash, and the login page renders before any profile request happens.

---

## Phase 3 — Structural chrome (where the art lives)

New markup in `client/index.html` and new CSS sections in `main.css`.

- **Page shell**: wrap content in a shell grid — `[rail | page-max 1400px | rail]`.
  Rails carry `--art-rail-left/right`, are `position: fixed`, `pointer-events: none`,
  masked to fade toward the content edge, and **collapse below ~1600px** so nothing
  changes on laptops or mobile.
- **Banner strip**: a themed band behind the existing `.page-header` (~2400×300 art),
  with a token-driven scrim so title text stays legible against any theme's artwork.
  This is the highest-impact slot — it converts every one of the 16 pages at once.
- **Global footer**: does not exist today. New `<footer>` after the page container —
  version, links, theme name/credit — carrying `--art-footer` (~2400×200).
- **Nav polish**: `.navbar` (`main.css:229-319`) gets the elevated-surface treatment,
  scroll-aware background, and a themed active-link indicator.
- **Component surface pass**: unify the per-feature card/table/panel CSS
  (`.inventory-grid`, `.inventory-list-view`, `.shopping-cards-list`, `.audit-*`,
  `.filter-bar`, `.badge`, `.setting-row`) onto a shared surface/elevation/border
  vocabulary. Because all markup is built by string interpolation with stable class
  names, **this is a CSS job, not a rewrite of the 16 component files.**
- Clean up the blunt `transition: all 0.2s|0.3s` declarations onto `--transition`.

---

## Phase 4 — The theme forge (art generation → palette extraction)

The repeatability mechanism, and the part that must be a *loop*, not a one-shot.

### 4a. The slot spec — one source of truth

`client/src/themes/slots.js` describes every art slot and is consumed by **three**
things: the CSS (dimensions/mask), the prompt generator, and the extractor. Nothing
about a slot is written down twice.

Per slot: `id`, pixel dimensions, aspect, `safeArea` (where nothing important may sit),
`scrim` (direction + strength of the gradient the UI lays over it), `overlaidText`
(bool), `tiles` (bool + axis), `edgeFade` (which edges must dissolve into the page
base), and `filename`. Slots: `banner` 2400×300, `rail-left` / `rail-right` 400×2000
(vertically tileable), `footer` 2400×200.

### 4b. `scripts/theme-forge.js prompt <slug>` — the Gemini prompt

Emits a paste-ready prompt built from the slot spec plus a short mood line you supply.
Structure:

1. **Theme bible preamble** (identical across every slot in the theme) — the mood line,
   the set/plane inspiration, medium direction, and the *value range* the art must live
   in, stated as a constraint rather than a suggestion.
2. **Per-slot block** — exact pixels, composition rule ("subject mass in the outer
   third; the inner edge must be near-empty"), edge-fade direction, tiling seam
   requirement for rails, and output format.
3. **Hard negatives** — no text, letterforms, glyphs, UI elements, logos, watermarks,
   borders, or frames. Image models add garbled text to anything banner-shaped unless
   told repeatedly not to.

**Generation order is sequential, and this is the important bit.** The banner is
generated *first* and becomes the anchor. Every subsequent slot is generated with the
banner attached as a reference image plus a "match the palette, lighting and brush
character of the attached image" instruction. Generating four slots independently from
the same text prompt reliably produces four images that do not look like one set.

### 4c. `theme-forge.js extract <slug>` — palette off the art

Runs **after the banner exists, before the remaining slots are generated**, so the rest
of the art is made to match a palette that has already been corrected.

> Runs in the browser, not Node. A dev-only page (`/tools/theme-forge.html`) loads the
> art into a `<canvas>` and does the work there. This deliberately avoids `sharp` /
> `@napi-rs/canvas` — native modules do not build on this machine, the same wall
> `better-sqlite3` hits, and a themeing tool that only works on the server would be
> useless.

Algorithm:
1. Downsample the banner to ~100px wide; read pixels.
2. Convert to **OKLCH**. Not HSL — HSL's lightness is a lie across hues and will pick a
   "dark" accent that is visually bright.
3. Cluster into ~8 groups (median-cut).
4. Classify each cluster by chroma: **low chroma + high frequency = surface candidate**;
   **high chroma × frequency = accent candidate**; the highest-chroma cluster more than
   ~60° of hue away from the accent = **highlight candidate**.

### 4d. The guardrail step — extraction proposes, the spec disposes

Raw extracted palettes are unusable: they fail contrast, drift in depth, and fight the
locked colors. So the extractor only donates **hue and chroma**, never lightness:

- **Surfaces** — take the extracted hue and a clamped chroma, then force the *lightness
  ladder* from Phase 0. The theme colors the surfaces; it does not get to decide how
  deep they are. This is what guarantees art/content separation in every future theme.
- **Text and borders** — computed, never extracted. Solve for the lightness that clears
  4.5:1 (body) and 3:1 (UI borders) against the surface that was just fixed.
- **Accent and highlight** — extracted hue kept; chroma and lightness clamped into a
  legible band so a washed-out artwork cannot produce an invisible focus ring.
- **Rarity and status** — untouched. Locked per Phase 0.

Output is `themes/<slug>/theme.css`, with a header comment recording the source artwork
and extraction date, plus a printed **contrast report** that fails loudly rather than
writing a theme that looks fine to the extractor and terrible to a person.

### 4e. The round trip

```
mood line → forge prompt → Gemini: banner → drop in art/
  → forge extract → theme.css + contrast report
  → forge prompt --with-palette → Gemini: rails + footer (banner as reference image)
  → drop in art/ → registry line → done
```

Written up in full in [`THEME_CREATION_GUIDE.md`](THEME_CREATION_GUIDE.md), so producing
a release theme is a mechanical hour and not a design project.

---

## Phase 5 — Per-user theme selection

Copy the avatar feature end to end; it is the exact precedent.

- `src/db/migrations/032-add-user-theme.js` — `ALTER TABLE users ADD COLUMN theme TEXT
  NOT NULL DEFAULT 'default'`.
- Add `theme` to the SELECT lists in `src/services/authService.js:153` (`getUserById`)
  and `:205` (`getAllUsers`); it then flows out of `GET /api/auth/me`
  (`src/routes/auth.js:103`).
- `PUT /api/auth/preferences` in `src/routes/auth.js`, validating the slug against the
  registry — never trust the client's string as a path segment.
- Apply in `main.js` `showApp()` after `api.getProfile()`, with the `localStorage`
  mirror read **before** first paint (and on `#auth-page`, which renders pre-login) so
  there is no flash of the default theme.
- Picker UI as a new `<section class="settings-section">` in the settings page
  (`index.html:1791-2027`), wired in `components/settings.js` — swatch previews from the
  registry, live apply on selection.

> ⚠️ **SQLite cannot be exercised locally** (`better-sqlite3` will not build here, and
> the `node:sqlite` shim has previously hidden a migration bug that took the site down).
> Migration 032 must be reviewed by eye and verified against the live server, not
> assumed to work from a local run.

---

## Phase 6 — Celebration animations

One shared utility, `celebrate(kind, anchorEl)` added to `client/src/utils/ui.js`
alongside `showToast`/`confirmDialog`, driving token-colored effects so each theme's
celebrations match its palette. Four moments:

1. **Deck win recorded** — `components/deckRecord.js`, the flagship moment.
2. **Collection milestones** — crossing 100/500/1000 owned cards, fired from
   `setOwnedPrintingQuantity`'s client-side callers.
3. **Import complete** — bulk add / deck import, keyed off the existing `batchId` paths.
4. **Trade accepted** — `components/trades.js`.

All effects gated behind the two existing `@media (prefers-reduced-motion: reduce)`
blocks (`main.css:1762`, `:1965`), which already null out the modal/drawer/toast
animations — extend them rather than adding a third.

---

## Verification

- `npm run client:build` — must succeed; check the emitted CSS for leaked hex literals.
- Dev server via the preview tools (`npm run client:dev`, port 5173): walk all 16 pages
  in each built-in theme; confirm rails collapse at <1600px and mobile is unchanged.
- Chart-heavy pages (`deck-builder`, `cards`, `price-monitoring`) are the tokenization
  canary — if a chart renders grey or wrong, `theme.js` was bypassed somewhere.
- Toggle OS reduced-motion and re-check every celebration and modal.
- Theme persistence: change theme → hard reload (no flash) → different browser →
  confirm it followed the account.
- **Live server only** for the migration: verify against the Unraid host with a
  temporary API key and curl, per the established practice. Env changes there require
  recreating the container, not restarting the app.

## Sequencing note

Phase 0 defines the target values; Phase 1 gates everything else. Phases 2–3 land together (a theme format with no chrome shows
nothing; chrome with no format has nothing to fill it). Phases 4, 5 and 6 are then
independent and can go in any order, each on its own branch per `CLAUDE.md`.
