---
"@otta-sh/plugin": patch
---

The console stops spending its loudest ink on the value nearly every row
carries. No status column is a badge column any more; the exceptions mark
themselves in the cell's own words.

**Why the spec's rendering was unreachable, and what shipped instead.** The
increment was written as "badge `failed`/`expired`/`cancelled`/`refunded`, leave
`paid`/`shipped`/`completed` plain". Block Kit cannot express it: `format` is a
property of the COLUMN, not of a cell, so a table badges every row of a column
or none of them — and blanking the happy-path cell to fake the split is worse
than either end, because the renderer draws its pill from padding and a radius
alone, so an empty cell in a badge column is a solid mark with no word in it.
Column-level badging is also not a neutral compromise: filter Orders by status,
or Pricing & inventory to Active, and every row carries the same value — the
column of identical pills the contract rejects outright (X-4/T-5) and the exact
reason `Kind` was deleted from the products table. So the choice was badges
everywhere or nowhere, and nowhere wins. What the badge was reaching for moves
into the text, which is the convention `On hand` already ships
(`0 · Out of stock`).

- **Orders.** The list's `Status`, the customer's other-orders table, the
  identity strip and the History timeline's `Event` column are all plain text,
  and all four read through one renderer — so a state cannot say one thing on
  the list and another one click away. A dead-end order reads `cancelled ·
  closed`; the happy path says one quiet word.
- **The exception set is the domain's, not a taste call.** It is exactly the
  states `ORDER_STATE_MACHINE` leaves with no outbound transition, which is why
  `completed` is NOT in it — a completed order can still be refunded. The mark
  says the one thing that set guarantees (the order is closed, nothing more will
  happen to it) rather than a consequence the console cannot stand behind: a
  `refunded` order here is a bookkeeping disposition that moves no money, so a
  cell claiming the money came back would be false. A state this plugin has
  never heard of renders as itself, so an unknown value never acquires the
  loudest rendering by default.
- **Reports.** "Orders by status" was the clearest case: one identical pill per
  row put `failed` and `paid` at the same weight on the one screen whose
  question is which number should worry you. It renders in the Orders screen's
  own words now. Low stock's `0 / Out of stock` becomes `0 · Out of stock` —
  it shipped against an unmerged sibling that then landed with the middot, and
  one fact spelled two ways one screen apart is what this pass exists to close.
- **Pricing & inventory.** `Status` loses its badge; `statusLabel` already
  badges the exceptions in words (`active` is one quiet word, and every
  exception is longer and says why — `inactive`, `deleted`,
  `active (not priced)`).
- **Coupons.** Unchanged on screen, and no longer the odd one out: the reasoning
  it shipped with is now the console-wide rule. The last badge column anywhere
  is Shipping's `Type`, a two-value closed set with no happy path to be
  near-constant about.

**A dated test fixed on the way past.** The coupons suite's changed-expiry test
hard-coded `2026-08-31` against a fixture that expires at `now + 30 days`. On
2026-08-01 those became the same day, `resolveBound` correctly read the submit
as "unchanged", and the assertion went red — a test about a CHANGE that no
longer describes one, failing loudly on `main` rather than passing vacuously.
The submitted days are relative now, like the fixtures the file already
documents as time bombs when hard-coded.

**Coupons joins the one date dialect, and the timestamp rule closes.** The
detail's `Created (UTC) = 2026-06-01T00:00:00Z` was the last raw wire instant in
the console; it reads `1 Jun 2026, 00:00 UTC` now, and the label drops its
`(UTC)` suffix because the value carries the zone. Validity windows follow —
`10 Jul 2026 – 1 Aug 2026`, an en dash because a window is a range and not a
transition — while the `date_input`s that edit those bounds still submit and
prefill `YYYY-MM-DD`: the dialect governs what is displayed, never what is
typed. The screen's private `DAY_PATTERN` (the third copy) is gone, imported
from the scaffold like the rest. With no screen left failing it, "no raw wire
timestamp reaches an operator" folds out of its standalone assertion and into
X-13 inside `assertBlockContract`, so every screen gets it from the one call it
already makes and no screen can be wired out of it.
