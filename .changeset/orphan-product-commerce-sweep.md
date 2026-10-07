---
"@otta-sh/plugin": patch
---

A commerce row whose CMS product is gone is now soft-deleted by the cron sweep (issue #374).
`content:afterDelete` is fire-and-forget: when its soft delete failed, nothing retried it, so a
product deleted in the CMS — and typically re-created under a new id — left its old
`product_commerce` row live for good, listed in Pricing & inventory beside the new one and
holding the sku the new product needs.

- **A twelfth sweep leg, `product-orphans`**, on the fifteen-minute maintenance cadence. It walks
  the live commerce rows behind a rotating `(createdAt, id)` cursor, one page a run sized to its
  budget, and asks the CMS through `ctx.content` — the `content:read` capability the plugin
  already declares, so no manifest change — whether each row's document still exists.
- **A `null` is evidence, not proof.** On the sandboxed path EmDash's bridge answers `null` (and
  an empty list) for ANY database error, so a broken binding reads like a deleted catalog and a
  database failing reads at random reads like products deleted at random. The tombstone is final
  and releases the sku, so it takes all of:
  - the CMS lists at least one product in that run (otherwise the run judges nothing);
  - three misses in a row for the row in one run, in a run that read some other document
    successfully (the page's, or the product the list returned);
  - no contradiction in that run: a row that misses and is then FOUND by a re-read proves the
    host is answering "missing" for documents that exist, so such a FLAKY run strikes nothing,
    wipes the strikes of every row it read, and moves the walk past them. A real deletion misses on
    every look of every pass, so it is never mistaken for flakiness;
  - three such strikes, from runs at least fifteen minutes apart. Any read that finds the
    document wipes them. A list or canary trip wipes all strikes. Strikes expire after seven
    days, or four full passes when a pass is longer;
  - fewer than five tombstones this minute;
  - the row is older than fifteen minutes.

  A read that rejects never counts; a row whose read rejects on three runs in a row is stepped
  past, left live. Every stop logs a `cron sweep product-orphans` error line. Seeded simulations of
  random read failures (128 cases: 40 live products with `get` failing alone or with `list` at
  p 0.15–0.9, and 250 live products with p around 0.2–0.35, at 0.5 and 0.9, and in bursts; both
  presets; 360 ticks each) tombstoned no live product — seeded PRNGs and one independent-failure
  model, not a proof. While reads are failing, real orphans wait — the safe direction.
- **A dense block of real orphans is struck out like any rows** (a bulk delete whose hooks were
  all lost), at most five a minute: with every read truthful, 20 adjacent orphans plus one more
  in 60 products all went by tick 123 on Free and 34 on Paid; a 40-orphan block and two lone
  orphans in 250 products by tick 379 on Free and 41 on Paid.
- **The soft delete is the hook's own** — the same use-case under the same idempotency key, so the
  sweep and a late hook delivery converge on one tombstone and a replay is a no-op. It keeps the
  row's commercial data, releases its sku claim, and touches no order, stock or hold.
- **Budgeted like every leg, and never promoted.** A CMS `get` is charged one query for a miss and
  three for a hit, a `list` four. On the Workers Free preset an otherwise idle store walks a
  1000-product catalog in about 350 ticks (about six hours), on Paid in about seven; an orphan is
  tombstoned on the third pass that finds it (measured about 900 ticks on Free for that catalog,
  up to about eighteen hours). The leg has no deadline, so aging and the starvation
  guard never move it ahead of other legs. Where the host hands over no `ctx.content`, it reports
  itself skipped.
- `PluginContext` gains an optional, read-only `content` (`ContentReadAccess`: `get` and `list`).
- Each unwired sweep leg now logs its "skipped — not wired" line once per isolate, instead of the
  first such leg silencing the rest.
