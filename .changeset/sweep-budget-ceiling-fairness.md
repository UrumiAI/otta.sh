---
"@otta-sh/plugin": minor
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

The commerce sweep never passes its query budget, says what each leg spent, and no leg is
starved (QA2 M2).

- **Hard ceiling.** The tick's call counter refuses any call past the "Background work per
  minute" budget (`SweepQueryCeilingError`). On the Workers Free preset no tick passes 30 queries.
  QA logged ticks of 334 and 44.
- **Per-leg accounting.** Every summary leg carries `queries`, and the summary carries
  `budget.overheadQueries`. A tick that did work logs one line: `[otta] cron sweep used N of M
  queries (…): <leg> <calls>, …, overhead <calls>; deferred to the next tick: …`. The old
  `deferred to the next tick: … (Xms of Yms, N of M queries)` line is folded into it.
- **Every leg stops at its share.** `reporting-heal` bounds each day's reconcile by the calls it
  has left and resumes a first heal across ticks (it was the 334-query tick).
  `prune-challenges` stops between deletes (new optional `pruneChallenges(now, { shouldContinue })`,
  `PruneChallengesOptions` in `@otta-sh/domain`) and moves to the fifteen-minute cadence.
  `hold-intents` sizes each order before starting it. Every leg has a share. A leg its share
  stopped gets a second go on what the tick has left.
- **Order and fairness.** `cancel-intents` runs first. Then come `expire-orders`, `order-emails`,
  `hold-intents`, `expire-holds`, `late-refunds`, and housekeeping last (`LEG_PRIORITY`). A leg
  passed over three ticks in a row with work goes to the head of the next tick (`AGING_TICKS`,
  `tickOrder`); one passed over nine goes ahead of even `cancel-intents` (`STARVING_TICKS`), for
  the hold expiry and stock-commit units that cannot fit behind an intent cancel on Free. The
  by-minute rotation of the lead is gone. `coupon-orphans` no longer waits for a
  drained `expire-orders`: it stops its walk at an order the expiry has not reached yet.
- **Idle ticks.** An empty outbox is no longer reported "0 (more next tick)", and `expire-orders`
  is never deferred for room it did not need. Every every-minute leg asks one "anything due?"
  read first, and a leg deferred last tick skips it.
- **Free preset batches** are one hold, one order and one email a tick (were two holds and two
  orders, which never fit).

Measured on a backlog in every leg at once (`cron-sweep-backlog.test.ts`, Free preset): 50 lapsed
orders expired in 71 minutes while every other leg progressed, every leg did some of its work
within 7 ticks, no leg waited more than 6 in a row, and no tick passed 30 queries. With only an
expiry backlog it is one order a minute. QA measured one every three minutes. DEPLOYMENT.md §5
says how to choose the budget. ADR-0019, ADR-0022 and ADR-0023 carry the amendments.
