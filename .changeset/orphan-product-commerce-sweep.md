---
"@otta-sh/plugin": patch
---

A commerce row whose CMS product is gone is now soft-deleted by the cron sweep (issue #374).
`content:afterDelete` is fire-and-forget: when its soft delete failed, nothing retried it, so a
product deleted in the CMS — and typically re-created under a new id — left its old
`product_commerce` row live for good, listed in Pricing & inventory beside the new one and
holding the sku the new product needs.

- **A twelfth sweep leg, `product-orphans`**, on the fifteen-minute maintenance cadence. It walks
  the live commerce rows behind a rotating cursor, one page a run sized to its budget, and asks
  the CMS through `ctx.content.get` — the `content:read` capability the plugin already declares,
  so no manifest change — whether each row's document still exists.
- **Only a positive "not found" counts.** A draft, scheduled, published or unpublished document
  keeps its row. A document in the trash reads as not found, exactly as the delete hook already
  treats a trash. A read that fails or times out is never taken for absence: the leg stops at that
  row, keeps its place, and fails loudly; it resumes there at its next run. Rows younger than
  fifteen minutes are not judged.
- **The soft delete is the hook's own** — the same use-case under the same idempotency key, so the
  sweep and a late hook delivery converge on one tombstone and a replay is a no-op. It keeps the
  row's commercial data, releases its sku claim, and touches no order, stock or hold.
- **Budgeted like every leg.** A CMS read is charged as three queries. On the Workers Free preset
  an otherwise idle store judges about six rows a minute — a 1000-product catalog in about two and
  a half hours — and on Paid the same catalog in about seven ticks. Where the host hands over no
  `ctx.content`, the leg reports itself skipped.
- `PluginContext` gains an optional, read-only `content` (`ContentReadAccess`).
