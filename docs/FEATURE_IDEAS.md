# Feature Ideas

Captured, not scheduled. Each one says what it is and why it came up, so the
reasoning survives until someone picks it up.

---

## User tagging, and gating collection browsing on it

**Status:** idea · raised 2026-08-25 during the functional review.

Today any account on the instance can browse any other account's entire
collection. `assertTradeable` ([src/services/tradeService.js:806](src/services/tradeService.js:806))
checks only that the partner exists and is not you, and `listTradePartners`
returns every other user on the instance. That is correct for a household where
everyone already trusts everyone, and wrong the moment there is a user who is
not in the house. See **S4-A** in [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md).

### The shape

**Tags on users.** A user carries one or more tags. A **House** tag is the
common case: everyone sharing a roof and, in practice, a card pool.

**Browsing is gated on a tag match.** If your tags intersect, you can browse
each other's collections as today — nothing changes for the household. If they
do not, you cannot see the collection at all.

**Outsiders ask, by email.** Someone with no matching tag can send a browse
request, but only if they already know the target's **email address** — the
address is the shared secret that stops the user list from doubling as a
directory of people to pester. No browsing of who exists, no request button
next to a name you found by scrolling.

**The owner approves.** The request goes to the target, who approves or refuses
it. Nothing opens on the requester's say-so.

**Approval is temporary: 48 hours.** An approved request opens browsing for the
requester for 48 hours, then closes on its own. The default is closed, and it
returns to closed without anyone having to remember to revoke it.

### Why this shape

- The household case stays frictionless — tags match, nothing to approve.
- Knowing the email is what converts "everyone is browsable" into "you have to
  already know who you are asking for", without building a blocking system.
- The 48-hour expiry means the safe state is the one that happens by default.
  A permanent grant is a thing people forget they gave.

### Things to work out when this is picked up

- Where tags are administered — self-serve, or admin-only? A self-assigned
  `House` tag is a self-serve way into someone's collection.
- Whether a tag match should gate **trading** too, or only **browsing**. Trades
  already move real cards, and the privacy argument for browsing is about decks,
  not inventory — these may want different answers.
- What an in-flight trade does when a 48-hour window closes underneath it.
- Whether the audit log should record browse grants. The review's position on
  the partner-browse paths is that anything revealing deck membership is a
  privacy question; a grant is the moment that access is handed over, which is
  the thing worth having a record of.
- Whether expiry is a stored timestamp checked on read (no job needed) rather
  than something swept — the app has one cron already and it is a source of
  timezone bugs.
