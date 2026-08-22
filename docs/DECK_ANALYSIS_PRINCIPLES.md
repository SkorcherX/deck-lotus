# Deck Analysis Principles

A distillation of Reid Duke's eight-part *Ultimate Guide to Legacy* into rules a
program can actually check. The source is Legacy-specific; the lessons are not.
Each principle below is written as **observation → metric → threshold →
finding**, so it can be implemented as a deterministic check over the cards in a
deck rather than as prose a new player has to interpret.

Source: Reid Duke, *The Ultimate Guide to Legacy MTG*, Parts 1–8
(ChannelFireball / TCGplayer, updated Feb 2025).

## How to read this document

- **Metric** — something countable from the card rows we already store
  (`type_line`, `oracle_text`, `keywords`, `cmc`, `mana_cost`, `color_identity`).
- **Band** — the expected range. Bands are *format-* and *archetype-*dependent;
  a number that is correct for Commander is nonsense for Legacy.
- **Finding** — what the player is told. Severity is one of:
  - `info` — an observation, a strength worth naming.
  - `consider` — a soft nudge; the deck may be doing this on purpose.
  - `warn` — the deck is very likely worse than the player thinks.
- Nothing here is a legality rule. A deck that ignores every finding in this
  document is still perfectly legal, and the UI must keep that distinction.

---

## Part 1 — Speed and power level

> "Games are often won — or otherwise decided — on the very first turn… Trying
> to resolve a spell that costs more than three mana will typically be folly
> unless it wins the game all on its own."

### 1.1 Every format has a clock, and the deck must operate inside it

**Observation.** The first question when entering a format is *how long do games
last*. A deck's curve is only good or bad relative to that clock.

**Metric.** `formatClock` — a per-format constant for the turn by which a deck
must have meaningfully affected the game.

| Format | Deck decided by ~turn | Avg MV band (spells) | Notes |
|---|---|---|---|
| Legacy | 1–3 | 1.4 – 2.3 | free spells; turn-1 kills exist |
| Vintage | 1–2 | 1.2 – 2.0 | restricted list, fast mana |
| Modern | 3–4 | 1.8 – 2.6 | |
| Pioneer | 4–5 | 2.0 – 3.0 | |
| Standard | 5–6 | 2.2 – 3.4 | |
| Pauper | 4–5 | 1.8 – 2.8 | commons only |
| Commander | 8–12 | 2.8 – 4.0 | 40 life, multiplayer, singleton |

**Finding.** If `avgMv` sits above the band's ceiling: *"Your average cost is
X.X. In <format>, games are usually decided around turn N — most of this deck
never gets cast."* Severity `warn` when above ceiling by >0.5, else `consider`.

### 1.2 Expensive cards must pay for themselves

**Observation.** A spell above the format's efficiency threshold is only
defensible if it ends the game, is free/discounted, or is a payoff the deck is
explicitly built around.

**Metric.** For each card with `cmc >= expensiveThreshold(format)` (3–4 in
eternal formats, 5 in Standard, 6 in Commander), test whether it is *excused*:

- has an alternative or reduced cost (`without paying its mana cost`,
  `you may cast … by`, `costs {N} less`, delve, convoke, affinity, improvise,
  evoke, miracle, madness, escape, foretell, cascade-into);
- is a designated win condition (see 5.3);
- is cheated into play by another card in the deck (reanimation, `put … onto
  the battlefield`, `Show and Tell` effects) — i.e. the deck contains an enabler
  that targets its type;
- is a payoff for a synergy the deck actually supports (see 8.2).

**Threshold.** More than 25% of non-land cards expensive *and* unexcused.

**Finding.** `warn`: *"N expensive cards have no discount, no way to cheat them
in, and don't end the game on their own."* Evidence: name them. Action: show
cheaper cards from inventory.

### 1.3 Pet cards

**Observation.** "If you anchor your career to playing with your favorite cards
of all time… it will hinder your chances to be competitive."

**Metric.** Singleton oddities in a non-singleton format: cards at 1 copy that
are neither lands, nor tutor targets, nor sideboard-style flex slots, while the
rest of the deck runs 3–4 copies.

**Finding.** `consider`: *"N one-ofs in a 4-copy format. If you can't tutor for
them, you'll rarely see them — consider cutting or going up to a playset."*
This is the "pet card" detector, phrased without moralising.

### 1.4 There are few true aggro decks

**Observation.** An attack-with-creatures plan must either be *fast enough to
resemble combo* or *carry enough disruption to be midrange/control*. A creature
deck that is neither is the classic new-player trap.

**Metric.** Compute `creatureShare`, `clockTurns` (see 5.2) and
`interactionCount` (see 4.1).

**Threshold.** `creatureShare > 0.45` AND `clockTurns > formatClock + 1` AND
`interactionCount < archetypeBand.min`.

**Finding.** `warn`: *"This deck attacks with creatures but isn't fast (kills
around turn K) and carries little interaction (N cards). Aggressive decks need
to be either faster or more disruptive."* Two actions: *show cheap threats*,
*show your removal*.

---

## Part 2 — The four ways games are won and lost

This is the single most valuable frame in the series for a deck checker, because
it is a **coverage checklist** rather than a curve statistic.

> "A combo. / Somebody can't cast their spells. / An unanswered threat. / A
> grindy game."

### 2.1 Loss-mode coverage

For each of the four modes, a deck should have *something*. Absence of all four
is a deck that only wins when the opponent does nothing.

| Loss mode | What covers it | Metric |
|---|---|---|
| Opponent combos off | free/cheap interaction, discard, graveyard hate, a faster clock | `freeInteraction + discard + gyHate + (clockTurns <= formatClock)` |
| You can't cast spells | enough lands, basics, low colour requirements, cheap curve | `landCount`, `basicCount`, `maxPipRequirement`, `avgMv` |
| An unanswered threat | removal breadth (see 4.2), blockers, sweepers | `answerBreadth` |
| A grindy game | card advantage engines, recursion, raw draw | `cardAdvantageCount` |

**Finding.** For each uncovered mode, one `consider` item naming the mode in
plain language: *"Nothing in this deck answers a resolved permanent that isn't a
creature."* / *"No card advantage — in a long game you run out of cards first."*

This is the check most worth surfacing to a *new* player, because it maps
directly onto "why did I lose?"

### 2.2 Card selection lowers your land requirement

> "Cantrips… are the reason why Legacy decks sometimes play as few as 14 lands…
> If all of your cards draw you more cards, you really only need one land in
> your opening hand."

**Metric.** `selectionDensity` = count of cantrips and library-manipulation
spells (cost ≤ 2, oracle text matches `draw a card` alongside another effect, or
`look at the top`, `scry`, `surveil`, `Ponder`-style rearrangement) as a share
of non-lands.

**Adjustment.** `suggestedLandCount` shifts down by 1 when
`selectionDensity >= 0.15`, and by 2 when `>= 0.25`. This directly refines the
land heuristic already in `formatRulesService.suggestedLandCount()`, which today
looks only at average cost.

**Finding.** `info` (a strength): *"12 cantrips smooth your draws — you can
afford a land or two fewer than the curve alone suggests."*

### 2.3 Card economy vs. tempo

> "Casting Force of Will for its alternate cost will always represent card
> disadvantage. Play with it if your deck can support it, but don't treat it as
> a sacred cow."

**Metric.** `freeSpellCount` (cards with an alternative cost paid in cards or
life) versus `cardAdvantageCount`.

**Finding.** `consider` when `freeSpellCount >= 6 && cardAdvantageCount <= 2`:
*"Free spells cost you cards. With little card advantage to refill, you'll run
out of gas against a grindy deck."*

### 2.4 Protect your mana

> "Your lands can be destroyed with Wasteland… you can lose everything to a
> Blood Moon."

**Metric.** `basicCount`, `nonbasicShare`, `landsThatEnterTapped`,
`untappedTurnOneSources`.

**Findings.**
- `consider` when `basicCount == 0` and format is Legacy/Modern/Vintage:
  *"No basic lands. Blood Moon, Back to Basics and land destruction turn your
  mana base off entirely."*
- `warn` when `landsThatEnterTapped / landCount > 0.5` and
  `avgMv <= 2.5`: *"Half your lands enter tapped in a deck this cheap — you'll
  spend turn 1 doing nothing."*

---

## Part 3 — Choosing a deck (and staying with it)

### 3.1 Proactive beats reactive for a new player

> "If you play a fast deck… you can always hope to simply win before your
> opponent presents a threat you can't answer. If you choose a slow deck… you
> open the door for too many things to go wrong."

**Metric.** `proactiveShare` = threats + engines + combo pieces, over non-lands.
`reactiveShare` = removal + permission + hate.

**Finding.** `consider` when `reactiveShare > 0.5 && proactiveShare < 0.25`:
*"This deck is mostly answers. Answer-heavy decks need you to know the whole
format — a proactive plan is more forgiving while you're learning."* Action:
show threats / finishers.

### 3.2 A reactive deck still needs a way to win

Reid's fix for slow decks is explicit: *"include potent threats… or build in a
way to kill your opponent out of nowhere."* This is the same check as 5.3
(win-condition count) but is *escalated to `warn`* for control-shaped decks.

### 3.3 Deck difficulty rating

> "The faster and more proactive your deck is, the less you have to worry about
> what your opponents are doing. I call these goldfish decks."

**Metric.** `difficultyScore` — a 1–5 rating from:
`+` reactive share, `+` number of distinct modal/situational cards,
`+` colour count, `−` proactive share, `−` redundancy (playsets).

**Finding.** `info`: *"Difficulty: 4/5 — this deck asks you to know what your
opponent is doing. Expect it to reward practice rather than reward you now."*
Purely descriptive; never a warning.

### 3.4 Budget and substitution — the deck-lotus-native lesson

> "If you don't have access to Force of Wills and Wastelands, you can play
> without them. Just try to track down the affordable commons and uncommons."

deck-lotus already knows what the user owns and what things cost. Part 3 says
the right advice is *functional substitution*, not "buy the staple":

**Metric.** For each card in the deck the user does not own, find owned cards
that share role, colour and MV band (see the role taxonomy in the appendix).

**Finding.** `info` with an action: *"You don't own Force of Will. From your
collection, Daze and Spell Pierce fill a similar slot more cheaply."*

### 3.5 Deck stability

> "Sticking with the same deck through multiple tournaments is the best way to
> improve."

**Metric.** Churn: cards added/removed over the last N days (`deck_cards`
history would need to be recorded; currently it is not).

**Finding.** `info`, opt-in only. Listed here for completeness; low priority.

---

## Part 4 — Graveyard decks, and how much hate to pack

This part yields the most precisely numbered advice in the whole series, which
makes it excellent for a checker.

### 4.1 Sideboard graveyard hate: 3–4 is the answer

> "Playing six or more dedicated sideboard cards is probably past the point of
> diminishing returns… It's most common to see three or four."

**Metric.** `gyHateCount` in the sideboard — cards whose oracle text matches
exile-from-graveyard, `graveyards`, `can't be cast from`, `if a card would be
put into a graveyard … exile it instead`, `Rest in Peace`-style effects.

**Bands.** 0 = calculated risk (`consider`), 1–2 = light (`info`),
3–4 = correct (`info`, a strength), 6+ = diminishing returns (`consider`).

**Finding at 0.** *"No graveyard hate in the sideboard. Graveyard decks are hard
to beat before sideboarding — 3 or 4 cards is the usual amount."* Action: show
owned graveyard hate.

### 4.2 Hate must be fast enough for what it must beat

> "Leyline of the Void… is the only card that's both fast enough to stop a quick
> Griselbrand and packs enough punch… That said, Leylines lose value in a format
> with the card selection of Brainstorm."

**Metric.** Two-axis classification of each hate card: `speed` (turn-0/free,
1-mana, 2-mana, 3+) and `reach` (one-shot vs. continuous).

**Rule.** If the deck has `selectionDensity >= 0.15`, prefer *findable* hate
(cheap, one-shot) — a turn-0 card the deck can dig for is redundant. If the deck
has low selection, prefer *continuous* hate that does not depend on drawing it
at the right time.

**Finding.** `consider`: *"Your sideboard's graveyard hate is all 2-mana
one-shots. Against a turn-1 or turn-2 graveyard kill it arrives too late."*

### 4.3 Prefer answers that overlap

> "Containment Priest… is an all-star against Reanimator, but can also come in
> against Elves, Sneak and Show."

**Metric.** `overlapScore` — how many distinct opposing strategy tags a
sideboard card's text maps to (graveyard, combo, creatures, artifacts,
enchantments, lands, ramp).

**Finding.** `info`: *"6 of your 15 sideboard cards only do one thing. Cards
that answer several strategies free up slots."*

### 4.4 You cannot respond to a cost

> "Since delve is part of the cost… you cannot respond to your opponent
> delving."

Generalised rule for the checker: an answer that requires *holding priority* is
worse against effects paid as costs. This is a play-pattern lesson, better
delivered as a contextual tip attached to a detected card than as a deck-wide
metric. Implement as a **card note**, not a finding.

---

## Part 5 — Combo decks

### 5.1 A combo deck has no plan B — and that is a decision, not a bug

> "If there's a combo in your deck, it's likely that your entire game plan is
> based around that combo, and you have no Plan B."

Implication for the checker: **once a deck is classified as combo, suppress the
generic findings** about interaction count, creature count and curve shape.
Telling a Storm deck it needs more removal is exactly the nagging that makes
deck checkers useless. Archetype inference must gate the rule set.

### 5.2 Clock estimation

**Metric.** `clockTurns` — the earliest turn the deck can plausibly win,
estimated as:

- **Combo:** turn on which the cheapest complete combo line is castable given
  the deck's mana (fast mana counts).
- **Creature:** cumulative power deployable per turn against the format's
  starting life total, assuming curve-perfect draws.
- **Burn/direct damage:** total damage available divided by cards drawn per
  turn.

Approximate is fine; it feeds comparisons (1.4, 3.1, 5.5), never a claim of
precision. Display as a range: *"kills around turn 4–5 on a good draw."*

### 5.3 Win conditions

**Metric.** `winConditionCount` — cards that can end a game: combo pieces,
evasive/large threats, alt-win text (`you win the game`), engines that produce
lethal.

**Bands.** 60-card constructed: 6–12 threats for a creature deck, 2–4 for
control. Commander: at least 2–3 distinct win routes.

**Finding.** `warn` at 0–1: *"Only one card in this deck can actually win the
game. If it's answered, you can't close."*

### 5.4 Anti-combo disruption must be free or fast

> "If your anticombo cards are primarily spells that cost one or more mana…
> you'll be dead in the water when the combo player has a good hand on the play."

**Metric.** `freeInteraction` — interaction with an alternative cost or
castable on turn 1 off a single land.

**Finding.** `consider` in fast formats when `interactionCount >= 6 &&
freeInteraction == 0`: *"All of your interaction costs mana. Against a turn-1 or
turn-2 kill, you never get to use it."*

### 5.5 Attack from multiple angles

> "Permission spells won't do the job on their own… Combine as many of these
> forms of disruption as possible with a fast clock."

**Metric.** `disruptionAxes` — how many *distinct kinds* of disruption the deck
has: permission, discard, targeted removal, sweepers, permanent-based taxes,
graveyard hate, mana denial.

**Threshold.** A deck presenting itself as interactive with only one axis.

**Finding.** `consider`: *"All of your disruption is counterspells. A deck that
resolves one threat you can't counter beats you — mix in discard or removal."*

### 5.6 Pressure multiplies disruption

> "The one thing that will improve your chances against all of these combo decks
> is a fast clock. By applying pressure, you give them less time to set up."

**Finding.** `info` when `clockTurns <= formatClock && interactionCount >= 8`:
*"A fast clock plus real disruption — your disruption is worth more because
they have fewer turns to find an answer."* This is a **strength**, and naming
strengths is half the point of the feature.

---

## Part 6 — Prison decks and structural hazards

### 6.1 Symmetry hazard — check your own lock against your own curve

> "Some decks make the sacrifice of going without Legacy's powerful one-mana
> spells in order to reap the rewards of utilizing Chalice of the Void… if your
> deck is designed to play conveniently around that."

This is the highest-value *mechanical* check in the series, and it generalises
far beyond Chalice.

**Metric.** For each symmetric lock card in the deck, count the deck's own cards
that it hits:

| Lock pattern | Self-hit metric |
|---|---|
| "counter … mana value N" (Chalice) | own cards at MV N |
| "nonbasic lands are Mountains" (Blood Moon) | own nonbasic lands with abilities/colour needs |
| "spells cost {1} more" (Thalia, Sphere) | own spell count, weighted by curve |
| "players can't draw more than one card" | own extra-draw effects |
| "creatures can't attack unless…" (Ensnaring Bridge) | own attacking creatures |
| "no more than one spell each turn" (Rule of Law) | own storm/cheap-spell chains |

**Finding.** `warn`: *"Chalice of the Void on 1 would also counter 14 of your
own cards."* Evidence: list them. This is precisely the kind of mistake a new
player makes and cannot see.

### 6.2 The four ingredients of a lock deck

> "Speed. The ability to find the right card. Flexible answers. Win the game
> quickly and decisively once you're ready."

**Metric.** For decks inferred as prison/control-lock, check four sub-scores:
`fastManaCount`, `tutorCount`, `flexibleAnswerCount` (answers that hit more than
one permanent type), `winConditionCount`.

**Finding.** One `consider` per missing ingredient, e.g. *"Your lock pieces are
strongest on turn 1, but you have no fast mana to deploy them early."*

### 6.3 Single-mindedness is fragility

> "The more single-minded your game plan, the more vulnerable you will be."

**Metric.** `fragilityScore` — the share of the deck that becomes dead if the
single most-depended-on card or effect is removed. Computed by counting cards
whose oracle text references a card/type that only one or two cards supply.

**Finding.** `consider`: *"N cards in this deck only do something when you have
<card>. If it's answered, a third of your deck stops working."*

### 6.4 Answers must reach non-creature permanents

> "Swords to Plowshares and Lightning Bolt may be the most efficient removal
> spells… but I feel most comfortable when I have access to cards like Prismatic
> Ending and Force of Will because those cards can protect me against much of
> what these Prison decks are trying to do."

**Metric.** `answerBreadth` — a boolean set over
{creature, artifact, enchantment, planeswalker, land, graveyard, stack}.

**Finding.** `warn` when only {creature} is covered: *"All of your removal only
hits creatures. Chalice of the Void, Blood Moon and Ensnaring Bridge are all
game over."* Action: show owned artifact/enchantment removal.

### 6.5 Play enough lands, including basics

Already covered by 2.4; Part 6 raises its severity, because mana denial is a
*strategy* someone is actively pursuing, not bad luck.

---

## Part 7 — Efficient shells (Delver)

### 7.1 Density supports synergy — the enabler/payoff ratio

> "You keep your density of spells high for 'blind flipping' Delver."

**Observation.** Many cards state a requirement on the rest of the deck.
Delver wants instants/sorceries; delve wants a full graveyard; metalcraft wants
artifacts; threshold, delirium, spell mastery, landfall, ferocious, revolt and
so on are all the same shape.

**Metric.** A **requirements table**: `pattern → { needs: category, minCount }`.
For each card matching a pattern, compare the deck's count of the needed
category against the minimum.

| Payoff pattern | Needs | Suggested minimum (60-card) |
|---|---|---|
| `instant or sorcery` reveal/flip (Delver) | instants + sorceries | 24 |
| delve / `Tarmogoyf`-style graveyard count | self-mill + cheap spells | 20 cheap spells |
| metalcraft (`three or more artifacts`) | artifacts | 16 |
| delirium (`four or more card types`) | distinct types in deck ≥ 5 | — |
| threshold (`seven or more cards … graveyard`) | cheap spells + self-mill | 22 |
| landfall | lands + fetch effects | 24 |
| `you've cast … this turn` (prowess/storm) | cheap spells | 26 |
| tribal lords (`other <Type> creatures`) | creatures of that subtype | 16 |

**Finding.** `warn`: *"Delver of Secrets wants around 24 instants and sorceries
to flip reliably; this deck has 11."* Action: show owned instants/sorceries.
This is one of the most concretely useful checks for a new player and is
entirely derivable from data we already store.

### 7.2 Efficiency: the 1–2 mana concentration

**Metric.** `cheapShare` = cards with MV ≤ 2 as a share of non-lands.

**Bands** (non-Commander): eternal formats want ≥ 0.60; Standard ≥ 0.45.

**Finding.** Feeds the existing `curve-top-heavy` check; refine its message to
name the format's expectation rather than a fixed 0.4/0.3 pair.

### 7.3 Flexibility is strength

> "All Delver decks are capable of taking on a defensive posture… In that way,
> Delver decks are their own animal."

**Metric.** `flexibilityScore` — presence of *both* proactive threats and
reactive answers in reasonable proportion (both ≥ 0.2 of non-lands).

**Finding.** `info`: *"This deck can play offense or defense — that flexibility
is a real strength against an unknown field."*

### 7.4 Sideboard shape: many 1- and 2-ofs

> "Delver players diversify their game plans with lots of one and two-of
> sideboard cards that allow them to attack from new angles."

**Metric.** `sideboardDistinctCards`, `sideboardMaxCopies`.

**Finding.** `consider` when the sideboard is 3–4 copies of 4 cards:
*"Your sideboard is four playsets. Sideboards usually want more distinct
answers — 1s and 2s let you attack from more angles."*

---

## Part 8 — Engines, payoffs and long-game plans

### 8.1 Card advantage vs. card selection are different things

> "Legacy is home to incredible card selection, but raw card advantage can
> actually be difficult to come by."

**Metric.** Two separate counters, never summed:
- `selectionCount` — cantrips, scry, surveil, filtering, tutors.
- `advantageCount` — net extra cards: draw-two-plus, recurring triggers,
  engines, recursion.

**Finding.** `consider` when `selectionCount >= 8 && advantageCount <= 1`:
*"Plenty of card selection but no card advantage. You'll always find your best
card, and still run out of cards first."*

### 8.2 Payoff engines want enough triggers

> "Pair Up the Beanstalk with spells that have high mana value, but can be cast
> without paying their full mana cost."

Same machinery as 7.1, applied to engines: an engine card names a trigger
condition; count the deck's cards that satisfy it.

**Finding.** `warn`: *"Up the Beanstalk triggers on mana value 5 or greater;
this deck has 3 such cards, and you'd need roughly 10 for it to be an engine."*

### 8.3 A slow deck needs cheap interaction to survive to its plan

> "Since Beanstalk is not a fast or explosive archetype… there needs to be a
> density of cheap (or free) reactive cards so that the pilot can keep their
> head above water."

**Metric.** For control-inferred decks: `earlyInteraction` = interaction with
MV ≤ 2 or free.

**Threshold.** Control decks want `earlyInteraction >= 10` in 60 cards.

**Finding.** `warn`: *"This is a slow deck with only 4 cheap answers. You'll be
dead before your expensive cards matter."*

### 8.4 Splashing is cheap when the mana supports it, and expensive when it doesn't

> "With the costs of touching into an additional color being so low, it's a
> common choice to do so."

**Metric.** Per colour: `pipDemand` (weighted by how early the card is cast) vs.
`sources`. Use Karsten-style thresholds rather than a flat share:

| Requirement | Sources needed (60-card) |
|---|---|
| `{C}` by turn 1 | 14 |
| `{C}` by turn 2 | 13 |
| `{C}{C}` by turn 2 | 20 |
| `{C}` by turn 3 | 12 |
| `{C}{C}` by turn 3 | 18 |
| `{C}{C}{C}` by turn 3 | 23 |

**Finding.** Replaces today's flat "25% of lands" rule with a real threshold:
*"7 cards need double blue by turn 2; that wants about 20 blue sources and you
have 12."* Also emits the *good* case: `info` when a splash is well-supported.

### 8.5 Sideboard purpose: fix extremes, then improve broadly

> "The main deck is focused on value and card advantage, while the sideboard
> looks to correct weaknesses against extreme decks, and make small improvements
> against a diverse range of decks."

**Metric.** Bucket every sideboard card into: `graveyard`, `combo/permission`,
`artifacts-enchantments`, `sweepers`, `mirror/value`, `unclassified`.

**Finding.** `consider` for each empty bucket that the format's common
strategies demand. For a 15-card board a reasonable default shape is:
3–4 graveyard, 3–4 combo, 2–3 artifact/enchantment, 2–4 mirror/value,
with the remainder flexible.

---

## Appendix A — Card role taxonomy

Deterministic classification from `type_line`, `oracle_text` and `keywords`.
Every role is a predicate; a card may hold several.

| Role | Detection sketch |
|---|---|
| `land` | type includes Land |
| `ramp` | produces mana and isn't a land; `search your library for a … land`; `add {` |
| `fast-mana` | ramp with MV ≤ 1 that nets mana on the turn it resolves |
| `fixing` | land or spell that produces 2+ colours |
| `selection` | `scry`, `surveil`, `look at the top`, MV ≤ 2 with `draw a card` |
| `draw` | net card advantage: `draw two`, `draw a card` on a recurring trigger |
| `engine` | triggered ability that repeats each turn/each time a condition is met |
| `tutor` | `search your library for a card` (non-land) |
| `removal-creature` | `destroy target creature`, `exile target creature`, damage to creature |
| `removal-permanent` | `destroy target permanent/artifact/enchantment`, `exile target …` |
| `sweeper` | `destroy all`, `each creature`, `all creatures get -X/-X` |
| `permission` | `counter target` |
| `discard` | `target player discards`, `reveal their hand … you choose` |
| `graveyard-hate` | `exile … graveyard`, `if a card would be put into a graveyard` |
| `tax` | `spells cost {N} more`, `can't be cast unless` |
| `lock` | continuous "can't" effects (see 6.1 table) |
| `mana-denial` | `destroy target land`, `doesn't untap`, `sacrifice a land` |
| `protection` | `hexproof`, `indestructible`, `counter target spell that targets` |
| `recursion` | `return … from your graveyard to your hand/the battlefield` |
| `threat` | creature with relevant stats, or planeswalker with a win-ward ultimate |
| `finisher` | `you win the game`, evasive threat with power ≥ 4, infinite-combo piece |
| `free` | `without paying its mana cost`, `you may cast … by`, pitch/alternative cost |
| `combo-piece` | referenced by another card's requirement table entry |

**Accuracy note.** These are heuristics over English oracle text and *will*
misclassify. Two mitigations are mandatory in the implementation:
1. Every finding carries the card names it is based on, so the player can see
   the reasoning and dismiss it.
2. No finding is ever phrased as a fact about the deck's quality — only as an
   observation with numbers attached.

## Appendix B — Archetype inference

Findings must be gated by archetype, or a combo deck gets told to add removal.

| Archetype | Signature |
|---|---|
| `aggro` | creatureShare > 0.4, avgMv < 2.3, clockTurns ≤ formatClock |
| `midrange` | creatureShare > 0.3, interaction ≥ 6, avgMv 2.3–3.2 |
| `control` | permission + removal > 0.4 of non-lands, few threats, high advantage |
| `combo` | ≥ 2 named combo pieces with ≥ 3 copies each, or a requirements-table payoff with a tutor package |
| `prison` | ≥ 4 lock/tax cards |
| `graveyard` | ≥ 6 cards referencing graveyards as a resource |
| `ramp` | ≥ 8 ramp cards and a top end |

When confidence is low, fall back to the *format-generic* rule set and say so:
*"I can't tell what this deck is trying to do yet — that's often a sign it
hasn't picked a plan."* This is itself one of the most useful findings for a new
player, and is exactly Reid's Part 6 point about single-mindedness inverted.

## Appendix C — Turn 0 and turn 1

The series repeatedly emphasises the first turn. Concretely checkable:

- `turnZeroCards` — cards playable before your first draw: free spells, Leylines,
  Chancellors, companions.
- `turnOnePlays` — cards castable off one land (or off fast mana).
- `pOpeningTurnOnePlay` — hypergeometric probability that a 7-card opener
  contains a land plus at least one turn-1 play.
- `pOpeningKeepable` — probability of 2–5 lands in an opening seven.

**Findings.**
- `warn` when `pOpeningTurnOnePlay < 0.45` in a fast format: *"Only a 38% chance
  your opening hand does anything on turn 1."*
- `info` when high: names it as a strength.
- `consider` when `pOpeningKeepable < 0.75`: *"Your land count means you'll
  mulligan more than you'd like."*

These are cheap, exact (hypergeometric, no simulation needed) and directly
answer the "have I thought about turn 0/1?" question.
