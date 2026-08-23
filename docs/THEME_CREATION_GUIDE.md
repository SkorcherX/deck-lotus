# Creating a Deck Lotus Theme

How to produce a new theme — artwork and palette — from a one-line idea.

## Just want to make a theme? Open the wizard

Double-click **`tools/theme-forge.bat`** (or run `npm run theme:forge`). It opens
the wizard on whichever Deck Lotus is already running, and starts the client dev
server first if none is. Pass an address to aim it somewhere specific:
`tools\theme-forge.bat http://unraid.local:3000`.

**`/tools/theme-forge.html`** on the running site walks the whole thing through
one step at a time: name it, describe it, pick how dark the app should be, copy
a prompt, drop the result back in, and download the two files at the end. It
checks each step before letting you move on, needs no terminal, and remembers
where you were if you close the tab.

The rest of this document is the reference behind it — why each rule exists,
and what the command line offers on top. Read it if the wizard tells you
something you want to argue with, or if you are changing how themes work.

> **Status: every step below works today.** The pack format, the loader, the
> chrome that consumes the art, the wizard, the prompt generator and the
> palette extractor are all built.
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
    empty.webp          600 x 600   (transparent, every empty screen)
    celebration.webp    600 x 600   (transparent, the win moment)
```

Every slot is optional. A theme that declares none still works — the chrome
collapses and the empty states fall back to their icons. Declare a slot only
once its file exists, or the CSS points at a 404.

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
npm run theme:prompt -- <slug> --mood "..." --ground "#0a0711"
```

That single command prints the whole banner prompt, ready to paste into Gemini —
you write the mood line and nothing else.

**`--ground` is the page background the art has to fade into, and it is worth
supplying even though it is optional.** It is the one instruction that has to be
decided before any art exists, because the alternative is asking for a fade to
"near-black" and getting one a few shades off — which shows as a lighter band
where the art meets the page. The rails are painted as opaque images with no
mask over them, so nothing downstream can rescue it. Pass the `--bg` you intend
to use; the wizard picks it for you in step 3 and puts it in every prompt after.

Without `--ground` the command says so, loudly, rather than quietly emitting the
weaker wording.

**It prints the banner prompt only, on purpose.** The rails and footer come from
a second run after the palette exists (step 6), so they can be generated to match
the banner rather than merely to match the same sentence. Add `--all` to see all
four now, at the cost of that consistency.

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

BACKGROUND COLOUR — THIS IS EXACT, NOT APPROXIMATE: #0a0711
The page behind this image is the flat colour #0a0711 (near-black violet-cast,
RGB 10,7,17). The top and bottom edges must fade to precisely #0a0711 — not to
black, not to a dark neutral grey, and not merely to a darker version of the
artwork. ...

DO NOT INCLUDE: text, letters, words, numbers, glyphs, runes, calligraphy,
watermarks, signatures, logos, UI elements, buttons, borders, frames, card frames,
or any decorative edge treatment.
```

Two parts of that are load-bearing and should not be trimmed:

- **The negatives are repetitive on purpose.** Image models add plausible-looking
  garbled text to anything banner-shaped. Naming text five ways is what stops it.
- **The value constraint is a hard rule, not a preference.** It is far cheaper to have
  the model paint dark than to darken a scrim afterward until the artwork disappears.
- **The background hex is repeated numerically, several ways.** "Fade to the page
  colour" is not an instruction an image model acts on; "the final row of pixels
  must be flat #0a0711" is. The wizard measures the delivered art's edges against
  that hex and tells you when it missed — a mismatch of more than about 1 unit of
  OKLab distance is visible as a line, and the rails have no scrim to hide it.

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
| Surfaces | Hue and (clamped) chroma from the **declared background** when there is one, otherwise from the art; **lightness ladder is forced** from the Arcane spec |
| Text, borders | Computed, never extracted — solved for 4.5:1 body / 3:1 UI against the fixed surface |
| Accent, highlight | Hue from the art; chroma and lightness clamped into a legible band |
| Rarity, status | **Locked.** Identical in every theme |

Why each of those:

- **The surface hue follows the background you declared**, not the artwork's own
  darkest cluster. They are usually close, but "usually" is not good enough here:
  the art was told to fade to a specific hex, so shifting the page out from under
  it by a few degrees of hue puts the seam back.
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
- **Spot art** (600×600, two of them) — `empty` and `celebration`. Both want a
  **transparent background**: they sit directly on a surface, so a baked-in
  backdrop or vignette shows as a visible square. Unlike the bands they compete
  with nothing, so they may carry real light and colour. Keep them apart in
  intent — `empty` is a calm "nothing here yet" that must not name what is
  missing (one image serves every empty screen), while `celebration` is a
  flourish. The generator writes both of those constraints into the prompts.

> Rails only render above 1700px of viewport width, and they SCALE to whatever
> gutter is left beside the 1400px content column — so the art is rarely shown at
> its native 400px. Two consequences when generating it: the inner-edge fade must
> be gradual enough to survive being squeezed to ~150px, and fine detail near that
> edge will be lost.
>
> Display scaling matters more than resolution here. A 2560px monitor at 125% is
> 2048 CSS pixels, and at 150% only 1707 — so a wide screen can leave a far
> narrower gutter than its spec sheet suggests. Check at the scaling you actually
> use.

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
- [ ] Checked above 1700px wide so the rails actually render, at your real display scaling
