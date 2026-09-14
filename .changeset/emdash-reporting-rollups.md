---
"@otta-sh/store-emdash": minor
---

`EmdashReportingStore` — the reporting port over precomputed day documents, plus the
recompute that keeps them exact and the order-store hook that feeds them.

Reporting was the one port whose SQL was pure read-time aggregation: one `GROUP BY` over
orders joined to totals and refunds, with the period bucket as a dialect-branched
truncation. There is no join, no aggregate and no raw SQL here, so two of the four
reports move to write time.

- **`reporting_daily/{currency}:{YYYY-MM-DD}`** holds the orders created that UTC day:
  how many sit in each state, how much of it counts as revenue under the allow-list, and
  how much came back. `revenueByPeriod` and `ordersByStatus` are folds over those
  documents, paged at the host's 100-document clamp; a week is the seven days from its
  ISO Monday and a month is its own days, so nothing is keyed by a week or a month and
  no second aggregate can disagree with the first.
- **The bucket is the order's CREATION day, never the day something happened to it.** A
  transition on an order placed three months ago moves three-month-old counters — out of
  the state it leaves, into the state it enters, and revenue with it through the
  allow-list — and a refund issued today lands in the day the order was placed. A refund
  is not a transition and is not driven by one, which is what keeps a fully refunded
  order's money reportable at all.
- **`topProducts` and `lowStock` stay on read.** A per-product-per-day rollup would put
  the whole catalogue inside one day document, and low stock has no window to roll up
  over. The first scans the window's orders over their frozen line snapshots; the second
  scans inventory and takes its title from the live sku claim, which is this tier's form
  of the SQL join's `deleted_at IS NULL` condition — so a tombstone sharing a live sku
  can neither duplicate a row nor title one, and an unresolvable sku is `title: null`,
  never the sku.
- **One event is two documents, and the claim is written first.** A claim per
  `(order, transition)` or `(order, refund)` makes a redelivered event a no-op; the
  counters follow under the usual bounded compare-and-set retry. A crash between them
  therefore leaves an UNDER-count — less revenue than came in, and never one order
  counted in two state buckets at once — rather than money counted twice.
- **`reconcile(range)` is the definition the counters are a cache of.** It recomputes
  each day from a paged scan of the orders, commits each document pinned to the revision
  it read (a lost race re-scans that day rather than clobbering a live delta), and marks
  the claims for the events it folded in, so a redelivery after a heal cannot move a
  counter that already counts it. It is safe to run while events are landing, and it is
  what a scheduled sweep will call.
- **The order store gained one option, `reporting`, defaulted to a no-op.** It is called
  only after the order write it describes is durable, exactly once per won write, and a
  writer that throws is swallowed: reporting is derived data and a transition is not, so
  a reporting outage must never be able to refuse a payment or lose a refund.

Also in this adapter: the safe-integer guard that used to sit where a Postgres bigint
string was parsed. Folding day documents in JS moves the precision risk into the
addition, so the guard and its focused test moved with it — a sum that leaves the safe
range throws rather than silently rounding a money figure.

Window semantics are day-granular, which is exact for the day-aligned windows this port
is asked for and includes the whole of a partial edge day otherwise — the one read
divergence from the SQL tier, and a property of the grain rather than a defect.
