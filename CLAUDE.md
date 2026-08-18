# CLAUDE.md

## This is a fork

This repo is a fork of `madeofpendletonwool/deck-lotus`, maintained by SkorcherX
to run fixes and features locally (Unraid/Docker).

Remotes:

- `origin` → `SkorcherX/deck-lotus` — our fork. We push here.
- `upstream` → `madeofpendletonwool/deck-lotus` — the original. Read-only; we
  pull their updates from here, never push.

## Change workflow — follow this every time

Never commit directly to `main`. Every change, however small, goes on a branch:

```bash
git checkout -b fix/short-description     # or feat/ or docs/
# make the edits
git add -A && git commit -m "Message"
git push -u origin fix/short-description
```

Then merge into `main` so a rebuilt image picks it up:

```bash
git checkout main && git merge fix/short-description && git push origin main
```

Optional cleanup once merged:

```bash
git branch -d fix/short-description && git push origin --delete fix/short-description
```

Ask before pushing or merging — those are the outward-facing steps. Making the
branch and the commits is the routine part.

## Syncing with upstream

```bash
git fetch upstream && git checkout main && git merge upstream/main && git push origin main
```

Our `main` has diverged from upstream (it carries our fixes), so these merges
create merge commits rather than fast-forwarding. That is expected. If upstream
independently fixes something we already fixed, expect a conflict in that file
and resolve it in favour of keeping the behaviour we rely on.

## Contributing back

Pushing a branch to `origin` does not notify the original author. Opening a pull
request against `madeofpendletonwool/deck-lotus` is a separate, deliberate step
taken on GitHub — only do it when explicitly asked.

## Notes on the codebase

- Mana Pool integration requires **both** `MANAPOOL_USER_EMAIL` and
  `MANAPOOL_API_TOKEN`. Setting only one leaves the integration disabled.
  See `src/services/manaPoolService.js` (`isConfigured` / `assertConfigured`).
- "Check Legality" and "Validate Deck" are deliberately different code paths:
  legality is checked locally against the MTGJSON data in the app's SQLite
  database and needs no credentials; Validate Deck proxies to Mana Pool's
  `/deck` endpoint and does. They are not duplicates.
- Foil copies are separate `owned_printings` rows: the table is keyed
  `UNIQUE(user_id, printing_id, is_foil)`. Anything reading or writing an owned
  row must carry `is_foil`, or it will silently act on the wrong finish.
  Foil copies price off `price_type = 'foil'`, falling back to `normal`.
- Deployment is Docker on Unraid. Env var changes require recreating the
  container, not just restarting the app or reloading the page.
