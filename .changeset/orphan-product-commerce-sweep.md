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
  - the page is not an outage: at least three, and more than 30%, of its rows missing on the
    FIRST read (before re-reads), or more than half still missing after them, abandons it (three
    rows read at least, so on the Workers Free first pass, pages of one or two rows, these only
    fire on a second pass);
  - three misses in a row for the row in one run, in a run that read some other document
    successfully (the page's, or the product the list returned);
  - three such strikes, from runs at least fifteen minutes apart — any read that finds the
    document wipes them, and every breaker trip wipes all of them;
  - fewer than five tombstones this minute;
  - the row is older than fifteen minutes.

  A read that rejects never counts; a row whose read rejects on three runs in a row is stepped
  past, left live. Every stop logs a `cron sweep product-orphans` error line. A seeded simulation
  of random read failures (40 live products, 360 ticks, `get` failing alone or with `list`)
  tombstones no live product at any failure rate up to 70%, on either preset. While reads are
  failing, real orphans wait — the safe direction.
- **The soft delete is the hook's own** — the same use-case under the same idempotency key, so the
  sweep and a late hook delivery converge on one tombstone and a replay is a no-op. It keeps the
  row's commercial data, releases its sku claim, and touches no order, stock or hold.
- **Budgeted like every leg, and never promoted.** A CMS `get` is charged one query for a miss and
  three for a hit, a `list` four. On the Workers Free preset an otherwise idle store walks a
  1000-product catalog in about 280 ticks (under five hours), on Paid in about seven; an orphan is
  tombstoned on the third pass that finds it. The leg has no deadline, so aging and the starvation
  guard never move it ahead of other legs. Where the host hands over no `ctx.content`, it reports
  itself skipped.
- `PluginContext` gains an optional, read-only `content` (`ContentReadAccess`: `get` and `list`).
- Each unwired sweep leg now logs its "skipped — not wired" line once per isolate, instead of the
  first such leg silencing the rest.
