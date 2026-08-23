# Creating a Deck Lotus Theme

How to produce a new theme — artwork and palette — from a one-line idea.

> **Status: every step below works today.** The pack format, the loader, the
> chrome that consumes the art, the prompt generator and the palette extractor
> are all built.
>
> The one thing still outstanding: Arcane ships **SVG placeholder art**, not
> generated art. Running this guide against it is exactly how that gets fixed.

A finished theme is a folder:

```
client/public/themes/<slug>/
  theme.json      # manifest — name, author, appearance, art filenames
  theme.css       # token overrides only: :root[data-theme="<slug>"] { --x: … }
  art/
    banner.webp        2400 x 300
    rail-left.webp      400 x 2000  (tiles vertically)
    rail-right.webp     400 x 2000  (tiles vertically)
    footer.webp        2400 x 200
```

Budget about an hour.

---

## The one rule that makes this work

**Generate the banner first. Extract the palette from it. Then generate everything else
against that corrected palette.**

The tempting order — make all four images, then pull colors out of them — produces a
theme that clashes with itself and usually fails contrast. The banner is the anchor:
it decides the palette, the palette gets corrected against the accessibility rules, and
the remaining art is then generated to match colors the site has already committed to.

Everything below is that loop.

---

## Step 1 — Write the mood line

One or two sentences. Name a plane, a set, a weather condition, a time of day. Be
concrete about light, because light is what the extractor reads.

Good:

> Storm-wracked Azorius skyline at dusk; fractured aether arcs between marble spires;
> cold blue-white light against deep indigo cloud.

Too vague to extract from:

> Blue and white, magical, cool.

Pick a name and a slug at the same time — `stormreach`, `duskmantle`, `emberfall`.

---

## Step 2 — Generate the prompt

```bash
npm run theme:prompt -- <slug> --mood "..." --slot banner
```

It reads `client/src/themes/slots.js` (the single source of truth for every slot's
dimensions, safe areas and edge treatment) and prints a paste-ready prompt. You supply
the mood line; everything else is generated, which is why the art always comes back at
the right size.

The banner prompt looks roughly like this:

```
Wide decorative banner illustration, exactly 2400x300 pixels, 8:1 aspect ratio.

SUBJECT: <your mood line>
MEDIUM: painted digital illustration, Magic: The Gathering card-art character,
        visible brushwork, no photographic realism.

COMPOSITION: Place all visual interest in the outer thirds. The central 60% must
stay quiet, low-detail and uncluttered — interface text sits directly on top of it.

VALUE: This is a dark UI. Keep the image in the lower half of the value range.
Nothing in the central band may exceed roughly 35% luminance. Highlights are
permitted only in the outer thirds.

EDGES: The top and bottom edges must fade toward flat near-black so the image
dissolves into the page rather than ending in a hard line.

DO NOT INCLUDE: text, letters, words, numbers, glyphs, runes, calligraphy,
watermarks, signatures, logos, UI elements, buttons, borders, frames, card frames,
or any decorative edge treatment.
```

Two parts of that are load-bearing and should not be trimmed:

- **The negatives are repetitive on purpose.** Image models add plausible-looking
  garbled text to anything banner-shaped. Naming text five ways is what stops it.
- **The value constraint is a hard rule, not a preference.** It is far cheaper to have
  the model paint dark than to darken a scrim afterward until the artwork disappears.

Paste it into Gemini, iterate until you like the result, save it as
`client/public/themes/<slug>/art/banner.webp`.

Judge the result on three things before moving on: is the centre quiet enough for a
page title, is it genuinely dark, and did it sneak any text in.

---

## Step 3 — Extract the palette

Open the dev-only tool:

```bash
npm run client:dev
```

then visit `http://localhost:5173/tools/theme-forge.html`, load the banner, and read
the output.

> This runs in the browser rather than as a Node script on purpose. Palette extraction
> needs image decoding, and the Node options (`sharp`, `@napi-rs/canvas`) are native
> modules that do not build on the Windows dev machine — the same wall `better-sqlite3`
> hits. A `<canvas>` needs nothing installed.

What it does:

1. Downsamples the banner to ~100px wide.
2. Converts to **OKLCH**. Not HSL — HSL lightness is inconsistent across hues and will
   confidently hand you a "dark" violet that is visually glaring.
3. Median-cuts into ~8 clusters.
4. Classifies them:
   - low chroma + high frequency → **surface** candidate
   - high chroma × frequency → **accent** candidate
   - highest-chroma cluster more than ~60° of hue from the accent → **highlight**

---

## Step 4 — Understand what the tool will and will not take from your art

This is the step that keeps themes usable, so it is worth knowing before you argue with
the output.

**Extraction donates hue and chroma. Never lightness.**

| Token group | Where it comes from |
|---|---|
| Surfaces | Hue and (clamped) chroma from the art; **lightness ladder is forced** from the Arcane spec |
| Text, borders | Computed, never extracted — solved for 4.5:1 body / 3:1 UI against the fixed surface |
| Accent, highlight | Hue from the art; chroma and lightness clamped into a legible band |
| Rarity, status | **Locked.** Identical in every theme |

Why each of those:

- **Surfaces keep a fixed depth** because that is what guarantees the banner and rails
  separate from the content. A theme that picked its own mid-tone surfaces would mush
  the artwork into the page — which is exactly the problem the overhaul exists to fix.
- **Text is computed** because a colour sampled from artwork has no idea what it will
  sit on. This is the single most common way a hand-made theme becomes unreadable.
- **Accent is clamped** so washed-out artwork cannot produce an invisible focus ring.
- **Rarity and status are locked** because rarity colours are recognition cues players
  read without labels — recolour mythic away from orange and you have broken the card
  list. And a theme where `--danger` looks calm makes destructive actions unsafe.

So the knobs a theme actually turns are three: **accent ramp, surface hue, and shape**
(radius / shadow / border intensity). That constraint is the reason a new theme is an
hour rather than a project.

---

## Step 5 — Check the contrast report

```bash
npm run check:themes
```

It prints a row per check for every theme, and it grades against the stock palette
rather than in the abstract: a theme must be **at least as legible** as `classic`.
Three checks already fail on the stock palette (uncommon rarity, mythic rarity, and
the highlight role) and are listed as known — a new theme is not required to fix
them, but making any of them worse is a **regression** and fails the run.

**Do not skip a real failure.**
It is the one thing a colours-only theme pack can still get catastrophically wrong, and
it is invisible to you if your monitor is bright and your eyes are good.

If something fails, the fix is almost always to nudge the accent chroma or pick a
different cluster — not to relax the threshold.

Save the output as `client/public/themes/<slug>/theme.css`. Keep the generated header
comment; it records which artwork the palette came from, which matters a year later.

---

## Step 6 — Generate the remaining art

```bash
npm run theme:prompt -- <slug> --mood "..." --with-palette
```

Now that the palette is fixed, the prompts for the rails and footer include the actual
hex values, and you **attach the banner as a reference image** with:

> Match the palette, lighting and brush character of the attached image.

**Generate them one at a time, each referencing the banner.** Four images generated
independently from the same text prompt will not look like one set — they will look
like four illustrations of the same idea, which is worse than it sounds when they are
on screen together.

Slot-specific notes:

- **Rails** (400×2000, one per side) — these are the gutter tapestries. They must
  **tile vertically without a visible seam**, and the *inner* edge (facing the content)
  must fade to nothing. Composition runs vertically: think banner, tapestry, column,
  vine — not a scene.
- **Footer** (2400×200) — same treatment as the banner but shallower, fading upward
  into the page.

> Rails only render above roughly 1600px of viewport width. On a laptop you will not
> see them. Check the theme on a wide monitor before calling it done.

---

## Step 7 — Register it

Add `theme.json`, then one entry to `client/src/themes/registry.js` with the slug,
display name, description and four preview swatches (two surfaces, accent, highlight).

Two things to know about the wiring:

- **The slug becomes a URL path segment**, so it is validated against the registry on
  the way in. `resolveTheme()` falls back to the default for anything unknown, and the
  loader falls back again to `classic` if a pack's stylesheet fails to load.
- **`index.html` carries a hardcoded copy of the default slug and the known-slug list**
  in its pre-paint script, because nothing can be imported synchronously before first
  paint. Adding a theme means updating that list too, or a user who selects it will see
  one frame of the default on every load.

Selecting a theme is `applyTheme(slug)` from `utils/theme.js`; the choice is mirrored to
`localStorage`. The settings picker and the per-user server column are Phase 5.

---

## Final checklist

- [ ] Banner: centre 60% quiet, dark enough for white text, no smuggled text
- [ ] Rails tile vertically with no seam; inner edges fade out
- [ ] All four images present, correct dimensions, `.webp`
- [ ] All four read as one set (they were generated against the banner)
- [ ] Contrast report fully passing
- [ ] `theme.css` contains **only** custom properties — no selectors, no layout, no fonts
- [ ] Rarity and status tokens untouched
- [ ] Walked the app in the new theme, including a chart-heavy page
  (`deck-builder`, `cards`, `price-monitoring`) — a grey or wrong-coloured chart means
  a hardcoded hex escaped tokenization
- [ ] Checked above 1600px wide so the rails actually render
