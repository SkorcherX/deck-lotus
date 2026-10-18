<div align="center">
  <img src="assets/decklotus-icon.png" alt="Deck Lotus" width="200">
  <h1>Deck Lotus</h1>
  <p>A modern, self-hosted Magic: The Gathering deck builder with Mana Pool integration, price monitoring, cart optimization, and multi-user support.</p>
</div>

> **Note:** This is a fork of [madeofpendletonwool/deck-lotus](https://github.com/madeofpendletonwool/deck-lotus)
> maintained by [SkorcherX](https://github.com/SkorcherX), with additional fixes and features.
> Instructions below reference this fork's container image.

## Features

### Deck Building
- **Deck Builder** — "From Inventory" search is the main way to add cards; an "Any card" search adds cards you don't own (marked as not from your collection)
- **Boards** — mainboard, sideboard and maybeboard, with drag & drop between them
- **Commander Support** — mark commanders; colour identity is shown automatically
- **Printings & Finishes** — pick the exact set, art and foil for each card; foil and non-foil copies are tracked separately
- **Printing Optimizer** — switch a whole deck to the cheapest or most thematic printings
- **Deck Statistics** — mana curve, type and colour breakdown, average and median mana value, the total mana needed to cast every non-land card, and estimated value
- **Format Rules** — Commander, Standard, Modern, Pioneer, Legacy, Vintage and Pauper. "Check Legality" runs locally against the card database; "Validate Deck" asks Mana Pool
- **Deck Status** — ready, building, idea or retired. A deck only competes for cards with decks at least as committed as it is, so an idea deck never makes a sleeved deck look short
- **Readiness** — each deck shows whether your collection can build it, with a per-card breakdown of what is missing, lent out or held by another deck. Basic lands are always free
- **Win/Loss Record** — log games against a deck; totals are worked out from the log
- **Pull List** — a checklist for pulling a deck's cards out of storage, grouped the way your shelves are sorted (colour → rarity → type, configurable)
- **Precon Detection** — decks that are still mostly a preconstructed product get their advisor warnings folded behind one line
- **Layout Views** — full card, compact and ultra-compact

### Deck Generator & Advisor
- **Generate from your collection** — pick a commander and theme (plus an optional second theme) and get a deck built from cards you own, mana base included
- **Revise a deck** — keep the cards you choose and fill the gaps; a deck's plan (themes and kept cards) is saved with it
- **Mimic** — rebuild an existing or imported list card by card from your collection, using owned copies first and similar cards second. Loose matches are labelled as such
- **Fill the gaps** — send what a generated deck is missing straight to the shopping list
- Nothing is saved until you accept a proposal; it saves as a new `idea` deck

### Collection
- **Inventory** — quantity per printing, finish and (optionally) condition (NM/LP/MP/HP/DMG)
- **Quick Add & Bulk Add** — quick add sits behind the "Add cards" button (key `A`); bulk add takes pasted lists by name or by set code + collector number. Added cards show their price, colour-coded by value
- **CardCastle Import** — import singles and sealed product from a CardCastle CSV
- **Filters** — colour (exactly or at most the picked colours), set, rarity, condition, copies owned, availability (free, in decks, lent out)
- **Set Condition in bulk** — grade many cards at once; only ungraded copies are changed unless you choose to overwrite
- **Remove & Recover** — removing cards in bulk needs a typed confirmation, and every removal can be rebuilt into a Bulk Add list from the audit page
- **Inventory Export** — a simple export, or a precise one that keeps printing, foil and condition so it can be pasted back in
- **Sealed Product** — track boxes, bundles and precons as lots, priced from MTGJSON with optional overrides
- **Forgiving Search** — punctuation and accents optional, typos still match, foreign names included
- **Card Browser** — filter by colour, type, mana value, set, subtype and rarity; card detail shows every printing with prices, legality and rulings

### Household: Trades, Loans & Sharing
- **Trades** — propose a trade, or send a shopping request and let the other person pick what they want back. Accepting moves both collections in one step, so the household total never drifts. Owners can decline individual cards
- **Loans** — lend a card without giving it away. It stays in the lender's collection but counts toward the borrower's decks until it is returned
- **Deck disruptions** — when a trade or a returned loan leaves a deck short, the deck owner is told and chooses to remove the card or keep it listed
- **Partner Browsing** — browse another user's collection to shop from it, without ever seeing their decks
- **Collection Sharing** — a read-only public link to your collection for someone without an account; regenerate it to cut off the old link
- **Deck Sharing** — public read-only deck links that anyone can view and copy to their own account

### Shopping List
- **Cross-Deck Aggregation** — everything your decks need, plus cards you want on their own, merged per card and grouped by set
- **Mana Pool Optimizer** — turn the list into a ready-to-buy cart
- **Filters** — price range, rarity, colour, set and budget mode
- **Found it!** — tick cards off at the store or out of a bulk box. Found cards go to a pile you review at home and add to the collection with the right printing
- **Export** — the full list as text

### Import & Export
- **Deck import** from Moxfield, Archidekt, Arena, MTGO and plain text, including the nameless `1 FDN 1` set-and-number form. Lines that can't be matched are listed rather than failing the import
- **Deck export** to Moxfield, Archidekt, EDHREC/Deckstats, MTG Arena, MTGO and plain text — copy or download as `.txt`

### Prices, Alerts & Analytics
- **Daily price refresh** from MTGJSON, separate from the weekly card data sync
- **Price Watches** — set a target price and condition; checked on a schedule (default every 6 hours) with Chart.js history graphs
- **Push Notifications** via [ntfy](https://ntfy.sh) for price hits, trades and loans — configured and tested from Settings
- **Analytics** — collection value over time, activity timeline, set completion, colour and rarity make-up, top cards, biggest price movers, idle cards, and trade/loan totals. Admins can view a household combined
- **Audit Log** — every collection change with its source (quick add, import, trade, loan, …), filterable, with whole imports selectable as a batch

### Mana Pool Integration
Needs both `MANAPOOL_USER_EMAIL` and `MANAPOOL_API_TOKEN`.
- **Cart Optimizer** — lowest total price, fewest packages, balanced, or gathered shipping only
- **Deck Validator** — format legality via Mana Pool
- **Buy Links** — "Buy on Mana Pool" throughout the deck builder and shopping list

### Android Companion App
The in-browser scanner has been replaced by the [deck-lotus-android](https://github.com/SkorcherX/deck-lotus-android) app, which scans cards with the phone camera and adds them through this server's `/api/scan/*` and `/api/inventory/bulk-add` endpoints.

### Accounts, Themes & Admin
- **Multi-User** — each user has their own decks, collection, watches and settings; JWT auth with refresh tokens; named API keys
- **Themes** — selectable per user, plus a Theme Forge wizard (`/tools/theme-forge.html`) for making new ones
- **Admin** — manage users, toggle registration, trigger syncs, and back up / restore all user data (on demand or on a schedule)
- **Maintenance Notice** — users get a five-minute warning and a notice while the weekly card data rebuild runs, so an empty-looking collection isn't mistaken for data loss

---

## Quick Start with Docker

```bash
mkdir -p deck-lotus-data

cat > docker-compose.yml << 'EOF'
services:
  deck-lotus:
    image: ghcr.io/skorcherx/deck-lotus:latest
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - JWT_SECRET=replace-with-a-long-random-secret
      - ADMIN_USERNAME=admin
      - ADMIN_EMAIL=admin@example.com
      - ADMIN_PASSWORD=changeme123
      # Optional but recommended — enables price monitoring & cart optimizer
      # Both are required together; setting only one leaves the integration disabled
      - MANAPOOL_USER_EMAIL=
      - MANAPOOL_API_TOKEN=
      # Recommended — the timezone the sync schedule is read in
      - SYNC_TIMEZONE=America/Los_Angeles
    volumes:
      - ./deck-lotus-data:/app/data
    restart: unless-stopped
EOF

docker compose up -d
```

App runs at `http://localhost:3000`.

**The first start takes a while.** Before the server opens port 3000 it
downloads and imports the full MTGJSON card database, and the decompress and
import steps print little while they run. Expect 10–30 minutes depending on
the machine; it is finished when the log shows `Deck Lotus server running on
port 3000`. Follow it with `docker logs -f deck-lotus`, and don't restart the
container mid-import, or it starts over. Later restarts skip this.

Generate a secure JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Unraid

An Unraid template lives at [`unraid/deck-lotus.xml`](unraid/deck-lotus.xml). On the server:

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-deck-lotus.xml https://raw.githubusercontent.com/SkorcherX/deck-lotus/main/unraid/deck-lotus.xml
```

Then **Docker → Add Container**, pick `deck-lotus` from the template list, set JWT Secret and the admin password, and apply. Updates then work from the Docker tab. If Unraid reports "Configuration not found" on update, the container was created without a template (or renamed away from it); remove it and recreate it this way — data in `/mnt/user/appdata/deck-lotus` is kept.

## Test Environment

Runs the real app against a scrubbed copy of a real database, on port 3100, so
a change can be checked against production-shaped data before it is pushed.

```bash
npm run test:env:fresh
```

Then open <http://localhost:3100> and log in as `admin`, `Valoxi`, `MacTheCat`
or `Viewaskewfool` — every account's password is `test`.

| Command | What it does |
|---|---|
| `npm run test:env:reset` | Fresh working copy from the master fixture |
| `npm run test:env` | Start the server against the existing copy |
| `npm run test:env:fresh` | Reset, then start |

**The fixture is never written to.** `data/deck-lotus-test.db` is the master and
the server never opens it; every run works on `data/test-run/deck-lotus.db`,
which `reset` replaces. The app migrates its database on startup, so the first
thing any run does is write — without the disposable copy the master would
drift away from what was handed over, one run at a time.

**Scheduled jobs are off** (`DISABLE_SCHEDULED_JOBS=true`). The weekly MTGJSON
sync clears `printings` and rebuilds it from a multi-gigabyte download, and the
price checker calls live APIs. Neither belongs near a fixture. That flag is
honoured by `src/server.js` and is useful in CI for the same reason.

Registration is disabled for the run, so a stray signup cannot change what the
next person testing sees.

To make a fixture of your own:

```bash
cp data/deck-lotus.db data/deck-lotus-test.db
node scripts/scrub-db.js data/deck-lotus-test.db --vacuum
```

The scrub replaces passwords with `test`, deletes API keys, rewrites emails and
regenerates share tokens, while keeping the decks, inventory, trades and prices
that make a bug reproducible. `test:env:reset` re-checks the password and fixes
it if the fixture was scrubbed by an older version of that script.

---

## Build from Source

```bash
git clone https://github.com/SkorcherX/deck-lotus.git
cd deck-lotus

cp .env.example .env
# Edit .env — set JWT_SECRET at minimum

# In docker-compose.yml, comment out the `image:` line and uncomment the
# `build:` block (building needs Docker buildx), then:
docker compose up -d --build
```

---

## Environment Variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `JWT_SECRET` | — | **Yes** | Secret for signing JWT tokens. Use a long random string. |
| `PORT` | `3000` | No | Port the server listens on |
| `NODE_ENV` | `development` | No | `production` or `development` |
| `DATABASE_PATH` | `./data/deck-lotus.db` | No | Path to the SQLite database |
| `MANAPOOL_USER_EMAIL` | — | No | Your Mana Pool account email address. Required alongside the token. |
| `MANAPOOL_API_TOKEN` | — | No | Enables price monitoring, cart optimizer, and deck validator. Generate at [manapool.com/seller/settings/integrations](https://manapool.com/seller/settings/integrations) |
| `TCGPLAYER_CLIENT_ID` | — | No | TCGPlayer API fallback (keys no longer publicly issued) |
| `TCGPLAYER_CLIENT_SECRET` | — | No | TCGPlayer API fallback |
| `NTFY_URL` | `https://ntfy.sh` | No | ntfy server URL. Fallback only — the value in Settings wins |
| `NTFY_TOPIC` | — | No | ntfy topic. Fallback only — the value in Settings wins |
| `NTFY_TOKEN` | — | No | ntfy access token, for protected topics. Fallback only |
| `PRICE_CHECK_SCHEDULE` | `0 */6 * * *` | No | Cron for price watch checks. Fallback only — editable in Settings |
| `SYNC_TIMEZONE` | `TZ`, else UTC | **Recommended** | Timezone for the sync schedule (e.g. `America/Los_Angeles`). Without it, "3 AM" means 3 AM UTC |
| `BACKUP_TIMEZONE` | `SYNC_TIMEZONE` | No | Timezone for scheduled backups |
| `REGISTRATION_ENABLED` | (Settings) | No | `false` forces sign-up off regardless of Settings |
| `DISABLE_SCHEDULED_JOBS` | `false` | No | `true` turns off syncs and price checks (test/CI) |
| `ADMIN_USERNAME` | — | No | Username for initial admin account |
| `ADMIN_EMAIL` | — | No | Email for initial admin account |
| `ADMIN_PASSWORD` | — | No | Password for initial admin account |
| `JWT_EXPIRES_IN` | `7d` | No | Access token lifetime |
| `JWT_REFRESH_EXPIRES_IN` | `30d` | No | Refresh token lifetime |
| `MTGJSON_URL` | (auto) | No | Custom MTGJSON download URL |
| `FORCE_REIMPORT` | `false` | No | Set `true` to clear and reimport all card data on next startup. User decks are preserved. |

### Mana Pool setup

Mana Pool is the preferred price source and unlocks the most powerful features. To enable it:

1. Create a Mana Pool account at [manapool.com](https://manapool.com)
2. Go to **Seller Settings → Integrations**
3. Generate an API access token
4. Set both `MANAPOOL_USER_EMAIL` (your account email) and `MANAPOOL_API_TOKEN` in your `.env` or `docker-compose.yml`

With the token set you get:
- Price monitoring that actually works
- Cart optimizer in the buy modal and shopping list
- Deck legality validator
- Per-card buy links throughout the app

### Scheduled jobs

| Job | When | What it touches |
|---|---|---|
| MTGJSON card data sync | Sundays 3:00 AM (warning at 2:55) | Rebuilds cards, printings and sealed catalog; user data is backed up and restored by UUID |
| Price refresh | Daily 4:00 AM | `prices` only, plus value snapshots and price history for owned cards |
| Price watch checks | `PRICE_CHECK_SCHEDULE` / Settings | Watches only |

Times are in `SYNC_TIMEZONE`; startup logs the zone it resolved.

### Price alert notifications (ntfy)

1. Install the [ntfy app](https://ntfy.sh) on your phone, or use the web UI
2. Pick a unique topic name (e.g. `deck-lotus-alerts-abc123`)
3. Subscribe to that topic in the ntfy app
4. As an admin, open **Settings → Push Notifications**, enter the topic (and
   server/token if you self-host), and press **Send test notification** — it
   should arrive within a few seconds. Save once it does.

`NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` still work as a fallback for any field
left blank in Settings. Alerts go to one topic for the whole server, so every
subscriber sees every user's price, trade and loan notices.

You'll receive a push notification whenever a watched card price drops to or below your target.

---

## Admin User Setup

On every startup, Deck Lotus checks whether an admin user exists:

- **Admin exists** → nothing happens, server starts normally
- **No admin exists + env vars set** → creates or promotes `ADMIN_USERNAME` to admin
- **No admin exists + no env vars** → auto-generates credentials and prints them to the console **once**

Auto-generated credentials look like this:

```
╔════════════════════════════════════════════════════════════╗
║  AUTO-GENERATED ADMIN CREDENTIALS                          ║
╠════════════════════════════════════════════════════════════╣
║  Username: admin                                           ║
║  Email:    admin@localhost                                 ║
║  Password: a1b2c3d4e5f6...                                 ║
╠════════════════════════════════════════════════════════════╣
║  ⚠️  SAVE THESE CREDENTIALS NOW!                           ║
║  They will not be shown again.                             ║
╚════════════════════════════════════════════════════════════╝
```

**Change the password immediately after first login.**

---

## Usage Guide

### Building a Deck

1. Go to **My Decks** → **New Deck**
2. Name your deck and optionally set a format
3. Search for cards — autocomplete shows results as you type
4. Click a card to select a printing and add it
5. Use **+/-** or the quantity field to adjust counts
6. Switch between **Mainboard**, **Sideboard**, and **Maybeboard** tabs
7. Right-click any card for the actions menu (move board, set as commander, buy on Mana Pool, remove)
8. Click **Save**

### Buying a Deck

1. Open a deck → click **Buy Deck**
2. The **Mana Pool Optimizer** tab opens by default:
   - Choose a strategy (Lowest Price, Fewest Packages, Balanced, or Gathered Shipping Only)
   - Click **Optimize Cart** — results show a per-seller breakdown with prices
   - Click **View on Mana Pool** to complete the purchase
3. Switch to **Quick Export** to copy the deck list for Mana Pool or TCGplayer mass entry

### Validating a Deck

1. Open a deck → look for **Validate Deck** in the sidebar stats panel
2. Select a format (Commander, Standard, Modern, etc.)
3. Click **Validate** — results show legality status, your commander, color identity, and any violations

### Setting Up Price Watches

1. Go to **Price Watch** in the nav
2. Click **Add Watch**
3. Start typing a card name — autocomplete suggests matching cards
4. Set a target price and condition
5. Optionally set an expiry date and notes
6. Click **Save Watch**

Prices are checked on the configured schedule. When a price hits your target you get a push notification (if ntfy is configured) and the watch shows a green "Price Hit!" badge.

Click the chart icon on any watch to see the full price history graph with your target threshold.

### Shopping List

1. Go to **Shopping List**
2. Select the decks you want to shop for
3. Use filters to narrow down by price, rarity, or color
4. Click **Optimize Cart** to run the Mana Pool optimizer across your entire list
5. Click the **Mana Pool** button on any individual card to search for it directly
6. Mark cards as **Found** during an LGS visit to track progress

### Importing Decks

1. Go to **My Decks** → **Import Deck**
2. Enter a deck name and format
3. Paste your deck list — any of these formats work:
   - `4 Lightning Bolt` (Arena / MTGO)
   - `4 Counterspell [DMR]` (Moxfield with set code)
   - `1 Black Lotus (LEA)` (set code in parentheses)
4. Click **Import Deck**

### Bulk Adding Cards to Inventory

Go to **Inventory** → **Bulk Add** and paste one card per line. Everything is
case-insensitive.

Two line formats are accepted:

| Format | Example | What it does |
| --- | --- | --- |
| `[qty] SET NUMBER` | `4 DSK 123` | Adds that exact printing — no card name needed |
| `[qty] Card Name [SET]` | `4 Counterspell [DMR]` | Looks the card up by name |

Quantity is optional and defaults to `1`. Write it as `4` or `4x`, followed by
a space. Add `*F*` (or `(F)`) anywhere on the line for foils — foils are
tracked as separate copies from non-foils.

```
4 DSK 123
2x blb 84a
1 M21 55 *F*
mh3-201
4 Lightning Bolt
2 Counterspell [DMR]
1 Sol Ring (F)
```

That list adds four copies of Duskmourn #123; two of Bloomburrow #84a; one foil
M21 #55; one Modern Horizons 3 #201 (a hyphen works as the separator too); four
Lightning Bolt; two Counterspell from Dominaria Remastered; and one foil Sol
Ring.

Notes:

- **Collector numbers are matched as text**, so suffixes work: `84a`, `S1`,
  `★123`. Keep any leading zero the set actually uses.
- **A line with no set code gets the cheapest printing** of that card. Give a
  set code and collector number when you care which printing lands in your
  inventory.
- A line is read as set + collector number when it is two tokens, the first is
  2–6 characters and the second contains a digit — so `Sol Ring` stays a card
  name.
- **Click Preview before adding.** It resolves every line against the card
  database and shows the actual card name each one maps to, with failures in
  red. This is the check that a set/number line is the printing you meant,
  since you never typed a name.

### API Keys

Generate API keys for external integrations:

1. Go to **Settings** → **Generate New API Key**
2. Enter a name → save the key (shown once only)

Use in requests:
```bash
curl -H "X-API-Key: your-api-key" http://localhost:3000/api/cards/search?q=lightning
```

---

## API Reference

All endpoints require authentication via `Authorization: Bearer <token>` or `X-API-Key: <key>` unless noted.

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register a new account |
| `POST` | `/api/auth/login` | Login, returns JWT |
| `GET` | `/api/auth/me` | Current user profile |
| `GET` | `/api/auth/stats` | User statistics |
| `GET` | `/api/auth/api-keys` | List API keys |
| `POST` | `/api/auth/api-keys` | Create API key |
| `DELETE` | `/api/auth/api-keys/:id` | Revoke API key |

### Cards

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cards/search?q=&limit=` | Autocomplete search |
| `GET` | `/api/cards/browse` | Filtered card browser (name, colors, type, cmc, sets, sort, page) |
| `GET` | `/api/cards/:id` | Card details |
| `GET` | `/api/cards/:id/printings` | All printings with prices |
| `POST` | `/api/cards/:id/owned` | Toggle card ownership |

### Inventory

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/inventory` | Paginated inventory with filters |
| `GET` | `/api/inventory/stats` | Totals and value |
| `GET` | `/api/inventory/search?q=&limit=` | Quick-add search (punctuation- and typo-tolerant) |
| `GET` | `/api/inventory/sets` | Sets you own cards from |
| `GET` | `/api/inventory/availability?deckId=&printingIds=` | Copies of each printing and finish still free to spend |
| `POST` | `/api/inventory/bulk-resolve` | Resolve bulk-add lines to printings without saving |
| `POST` | `/api/inventory/bulk-add` | Bulk add cards to inventory |
| `POST` | `/api/inventory/quick-add` | Add a single printing |

`bulk-add` and `bulk-resolve` take the same body. Identify a card either by
`cardName` (with optional `setCode`) or by `setCode` plus `collectorNumber`:

```json
{
  "items": [
    { "setCode": "DSK", "collectorNumber": "123", "quantity": 4 },
    { "cardName": "Sol Ring", "quantity": 1, "isFoil": true }
  ]
}
```

`bulk-resolve` returns each line with `resolved`, the `cardName` and
`printingId` it maps to, or an `error` — use it to preview an import before
committing it.

`availability` reports, per printing and finish, how many copies you `owned`,
how many are `committed` to your other decks, how many are `inThisDeck`, and
how many are `free`. Pass `deckId` for the deck being edited so it is not
counted as competing with itself. Allocation is advisory: `free` goes negative
when a card is spread across more decks than you own copies. Basic lands come
back `unlimited: true` with `free: null`.

### Decks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/decks` | List decks |
| `POST` | `/api/decks` | Create deck |
| `GET` | `/api/decks/:id` | Get deck |
| `PUT` | `/api/decks/:id` | Update deck |
| `DELETE` | `/api/decks/:id` | Delete deck |
| `POST` | `/api/decks/:id/cards` | Add card |
| `PUT` | `/api/decks/:id/cards/:cardId` | Update card quantity / board |
| `DELETE` | `/api/decks/:id/cards/:cardId` | Remove card |
| `GET` | `/api/decks/:id/stats` | Mana curve, type distribution, colors |
| `GET` | `/api/decks/:id/price` | Deck total estimated value |
| `POST` | `/api/decks/import` | Import from text |
| `POST` | `/api/decks/:id/share` | Create public share link |
| `DELETE` | `/api/decks/:id/share` | Remove share link |
| `GET` | `/api/decks/share/:token` | View shared deck (public) |
| `POST` | `/api/decks/share/:token/import` | Import shared deck |

### Price Monitoring

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/price-monitoring/status` | Check if price source and ntfy are configured |
| `GET` | `/api/price-monitoring` | List all price watches |
| `POST` | `/api/price-monitoring` | Create price watch |
| `PUT` | `/api/price-monitoring/:id` | Update watch (price, condition, active state) |
| `DELETE` | `/api/price-monitoring/:id` | Delete watch |
| `GET` | `/api/price-monitoring/:id/history` | Price check history |
| `POST` | `/api/price-monitoring/check-now` | Trigger immediate check of all active watches |

### Mana Pool

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/manapool/status` | Check if `MANAPOOL_API_TOKEN` is configured |
| `POST` | `/api/manapool/optimize` | Cart optimizer — body: `{ items, model }` |
| `POST` | `/api/manapool/validate-deck` | Deck validator — body: `{ decklist, format }` |
| `POST` | `/api/manapool/card-info` | Card info lookup — body: `{ names }` |

#### Optimizer models

| Model | Description |
|---|---|
| `lowest_price` | Minimize total spend |
| `fewest_packages` | Minimize number of sellers (saves shipping) |
| `balanced` | Balance between price and packages |
| `gathered_shipping_only` | Sellers offering combined shipping only |

#### Example: optimize a cart

```http
POST /api/manapool/optimize
Authorization: Bearer <token>
Content-Type: application/json

{
  "model": "fewest_packages",
  "items": [
    { "name": "Sol Ring", "quantity": 1 },
    { "name": "Arcane Signet", "quantity": 1 },
    { "name": "Command Tower", "quantity": 1 }
  ]
}
```

#### Example: validate a deck

```http
POST /api/manapool/validate-deck
Authorization: Bearer <token>
Content-Type: application/json

{
  "format": "commander",
  "decklist": "1 Atraxa, Praetors' Voice\n1 Sol Ring\n..."
}
```

### Admin

All admin endpoints require admin privileges.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/admin/users` | List all users |
| `PUT` | `/api/admin/users/:id` | Update user (promote/demote admin) |
| `DELETE` | `/api/admin/users/:id` | Delete user and all their data |
| `POST` | `/api/admin/users/:id/reset-password` | Reset user password |
| `POST` | `/api/admin/sync` | Trigger MTGJSON sync |
| `GET` | `/api/admin/sync-status` | Last sync timestamp |
| `POST` | `/api/admin/backup` | Create data backup |
| `POST` | `/api/admin/restore` | Restore from backup |
| `GET` | `/api/admin/backups` | List saved backup files |

### Other endpoints

| Area | Base path | Main routes |
|---|---|---|
| Deck generator | `/api/decks/generate` | `GET commanders`, `GET themes`, `POST /`, `POST gaps`, `POST mimic`, `POST accept` |
| Deck extras | `/api/decks/:id` | `GET/PUT/DELETE pull-list…`, `PUT plan`, `GET/POST/PUT/DELETE games` |
| Trades | `/api/trades` | list, `partners`, `partners/:userId/inventory`, `preview`, `request`, `:id/counter`, `:id/accept`, `:id/decline`, `:id/cancel`, `disruptions` |
| Loans | `/api/loans` | list, `request`, `:id/:action` |
| Sealed | `/api/sealed` | CRUD, `catalog`, `import` (CardCastle CSV) |
| Analytics | `/api/analytics` | `summary`, `timeline`, `value-history`, `sets`, `colors`, `composition`, `top-cards`, `set-completion`, `deck-use`, `trades-loans`, `movers` |
| Audit log | `/api/audit` | list, `filters` |
| Collection share | `/api/collection-share` | `GET/POST/DELETE /`, `regenerate`; public read-only under `public/:token` |
| Scanner (Android) | `/api/scan` | `POST resolve`, `shortfall`, `commit` |
| Maintenance | `/api/system/maintenance` | Sync notice state (no auth) |

---

## Project Structure

```
deck-lotus/
├── src/
│   ├── db/
│   │   ├── migrations/            # 48 database migrations
│   │   ├── connection.js
│   │   └── index.js
│   ├── middleware/
│   │   ├── auth.js                # JWT + API key auth
│   │   └── errorHandler.js
│   ├── routes/
│   │   ├── auth.js
│   │   ├── cards.js
│   │   ├── decks.js
│   │   ├── sets.js
│   │   ├── shopping.js
│   │   ├── inventory.js
│   │   ├── priceMonitoring.js
│   │   ├── manapool.js            # Mana Pool proxy routes
│   │   ├── trades.js / loans.js   # Household trades and loans
│   │   ├── sealed.js              # Sealed product
│   │   ├── analytics.js / audit.js
│   │   ├── collectionShare.js     # Public read-only collection link
│   │   ├── scan.js                # Android companion app endpoints
│   │   ├── system.js              # Maintenance status (unauthenticated)
│   │   └── admin.js
│   └── services/
│       ├── authService.js
│       ├── cardService.js
│       ├── deckService.js
│       ├── pricingService.js      # Local deck price calculation
│       ├── manaPoolService.js     # Mana Pool API integration
│       ├── tcgplayerService.js    # TCGPlayer fallback
│       ├── priceMonitoringService.js
│       ├── notificationService.js # ntfy integration
│       ├── deckGeneratorService.js / deckMimicService.js
│       ├── deckReadinessService.js / shoppingService.js
│       ├── tradeService.js / loanService.js
│       ├── backupService.js / auditService.js
│       └── syncService.js         # Weekly card sync + daily price sync
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── deckBuilder.js     # Deck builder + optimizer + validator
│   │   │   ├── cards.js
│   │   │   ├── shopping.js        # Shopping list + Mana Pool optimizer
│   │   │   ├── inventory.js
│   │   │   ├── priceMonitoring.js # Price watches + Chart.js history charts
│   │   │   ├── settings.js
│   │   │   └── auth.js
│   │   ├── services/api.js        # API client
│   │   ├── utils/
│   │   └── main.js
│   ├── index.html
│   └── package.json
├── scripts/
│   └── import-mtgjson.js
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

---

## Tech Stack

**Backend** — Node.js, Express, SQLite (better-sqlite3), JWT, bcrypt, node-cron

**Frontend** — Vanilla JavaScript (ES6+), Vite, Chart.js (price history charts), Phosphor Icons

**Data** — MTGJSON (card data weekly, prices daily, sealed product catalog), Mana Pool API (optimizer, validator, live listings)

---

## Backup & Restore

Admins can export and restore all user data from Settings → Backup & Restore.

Backups (format version 2) include every user-scoped table: users, decks and their cards, the collection with foil and condition, trades, loans, sealed lots, deck plans and records, pull-list progress, shopping and found lists, value snapshots, API keys and share links. Card and printing data is excluded — it is rebuilt from MTGJSON — so cards are stored by name and printings by UUID, which survive the rebuild. Backups can also run on a schedule.

Restores can **merge** (keeps existing data, adds backup data) or **overwrite** (replaces everything). Deck integrity is maintained via stable UUIDs.

---

## Docker Build

The Dockerfile uses a three-stage build to keep the final image small (~150 MB):

1. **Frontend builder** — runs `npm run build` in the client directory
2. **Backend builder** — installs production dependencies only
3. **Final image** — Alpine Node.js with runtime files only

```bash
# Build and run locally (after switching docker-compose.yml from `image:` to `build:`)
docker compose up -d --build

# Force a card data reimport (preserves user decks)
FORCE_REIMPORT=true docker compose up -d
```

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## Credits

- Card data: [MTGJSON](https://mtgjson.com/)
- Prices & marketplace: [Mana Pool](https://manapool.com)
- Push notifications: [ntfy](https://ntfy.sh)
- Icons: [Phosphor Icons](https://phosphoricons.com)
- Charts: [Chart.js](https://www.chartjs.org)

---

## License

MIT — see LICENSE file for details.

---

<div align="center">
  <strong>Deck Lotus</strong> — Build decks with style.
  <br><br>
  Made with love for the Magic: The Gathering community.
</div>
