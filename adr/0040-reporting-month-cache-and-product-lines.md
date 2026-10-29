# 0040. Long reports read a month cache and built product lines, kept honest by a verifier

- Status: accepted
- Date: 2026-10-29
- Builds on: [ADR-0023](./0023-reporting-rollup-is-a-guarded-delta.md) (the day document is a
  guarded delta), [ADR-0019](./0019-commerce-aggregates-are-one-document-each.md)
- Issue: #572

## Context

A "Last 365 days" Reports render read every `reporting_daily` document of the period and of
the previous one (a document per currency per day), and `topProducts` scanned every order
created in the period. On a two-currency store with 3,000 orders that was 51 plugin queries.
That is over Workers Free's 50 per invocation before the host's own session and auth reads,
and it grew with the order count.

## Decision

1. **`reporting_monthly/{YYYY-MM}` is a cache of a month's day documents**, every currency in
   one document. It is rebuilt from the days by the `reporting-heal` cron leg and never moved by
   a delta. A long report reads a CLEAN month document for every whole month it covers, and
   day documents for the partial months at its ends and for any month that is dirty, missing
   or of another `format`.
2. **Day documents carry top-products lines**: one per `(productId, title)` over the day's
   orders in a revenue-counting state. They are BUILT, by a recompute or by a product-only
   build, because one event can move any number of products and a guarded delta addresses
   a bounded number of fields. A delta that moves an order into or out of the revenue set
   marks them dirty (`productsDirty: 1`). The lines record the epoch they were built at
   (`productsEpoch`), and lines whose epoch is not the document's are untrusted. A day whose
   lines are untrusted is scanned from its orders, which is what every day did before.
3. **The cache protocol** (`ReportingMonthlyDoc` in `reporting-documents.ts`):
   - Every writer of a day document *touches* the month before its write (one unguarded
     numeric delta: `gen + 1`, `dirty = 1`, `touchedAt = now`), and marks the write done after
     it:
     - a sweep writer (a recompute, a product build) with a second touch;
     - a live order event with the `appliedAt` stamp its claim already gets;
     - a live event whose stamp is refused, because a recompute stamped the claim first, with a
       second touch;
     - a recompute that absorbed claims, which touches the month on its way out however it
       leaves.
   - A rebuild pins `gen`, refuses while the month was touched within the settle window
     (20 minutes: a Cron Trigger invocation, which writes live events from the expiry leg, may
     run for up to 15) or while any of its claims is unstamped,
     reads the days, and commits guarded on `gen`.
   - A claim that stays unstamped past the settle window, and that a recompute of its day cannot
     prove, is stamped (not absorbed) by the sweep, so it cannot hold its month dirty forever.
4. **A verifier backs the protocol up.** No protocol survives every writer:
   - a writer that stalls past the settle window and then writes;
   - a live event that dies between its day write and its second touch;
   - a Worker from a build older than #572, during a rollback or a mixed-version rollout, which
     never touches a month or dirties a line.

   So the leg re-checks what it has already built, round robin from a cursor. It rebuilds up
   to two CLEAN closed months, which writes nothing when they still match their days, and
   re-checks one closed day's lines against its orders. It announces every repair as a sweep
   anomaly. On the Workers Free preset the leg has about nine calls a run, so once the walk
   has caught up it takes turns with the verifier. While an upgrade's backfill is still
   pending, the refresh gets three runs in four, and the fourth goes to the walk or the
   verifier, so neither stops for the length of the backfill. The verifier walks days
   newest first, as the backfill builds them. A month rebuild that finds lines marked clean
   but stale by `productsEpoch` flags them dirty, so the refresh lists that day again.
5. **The backfill is newest first, and cannot wedge.** Day documents written before #572 have
   no lines, and the refresh builds them a batch at a time, the trailing year first. A day
   whose orders need more pages than the leg could ever be given in one tick is marked
   `PRODUCTS_UNBUILDABLE` and announced, instead of heading every batch. A month document
   keeps at most 1,000 product groups per currency; past that its lines are `null` and top
   products read that month's days.
6. **Periods past 186 days are charted, and asked for, by calendar month.** Up to 92 days they
   are charted by day, and up to 186 by week. A monthly comparison is paired with its period
   by the end.

## Consequences

- 365 days costs 12 plugin queries (30 days 8, 90 days 10, 186 days 14), independent of the
  order count, once the cron has built the caches. Until then the figures are the same and
  the cost is what it was.
- Every order event costs one more call (the month touch). One order expiry is 14 calls (was
  13). Checkout and settle stay well inside 50 (pinned in `checkout-query-budget.test.ts`).
- A clean cache can be wrong for as long as the verifier takes to come round to it. That is
  from minutes to a day or two on a store with a year of history: every month is re-checked
  within hours, and every day within days. DEPLOYMENT.md §5 states the window for a rollback.
- Follow-up, not changed here: `topProducts` sums a product's lines across currencies, as the
  order scan did before #572, so one product sold in two currencies ranks on the sum of two
  currencies' minor units. Splitting it by currency is a port change of its own.
