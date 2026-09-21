---
"@otta-sh/plugin": minor
---

Give the plugin a scheduled `cron` hook and the nine commerce sweeps that run on
it — the work the standalone service's `scheduled()` handler used to do, plus the
five completers ADR-0019 always owed and nothing ran on a schedule.

- Adds `ctx.cron` (`CronAccess`: `schedule`/`cancel`/`list`) to the plugin's
  context type and to the workerd sandbox entry, mirroring the host's
  upsert-on-`(plugin, task)` registration. Like `ctx.storage`, it carries NO
  capability requirement — the only gate is whether the runtime wired a cron
  executor — so the declared capabilities stay exactly `content:read` +
  `network:request`.
- Declares two hooks: `plugin:activate` and `cron`. The cadence is the service's
  own fifteen-minute schedule, carried over unchanged.
- REGISTERS THE TASK FROM A PATH A CONFIGURED DEPLOYMENT ACTUALLY REACHES. A
  `cron` hook never fires until a task ROW exists — the host's executor claims due
  rows and collects nothing from plugins — and `plugin:activate` fires only from an
  admin enable toggle, which a plugin hand-registered in a site's `plugins` array
  never sees. So the four content-sync hooks and the two public storefront routes
  are wrapped: reaching any of them ensures the task exists, memoized once per
  isolate, and the wrapper can neither slow nor fail the handler it wraps. The tick
  still re-affirms (the upsert is free, and a schedule change then lands on the
  next tick).
- One tick runs nine legs, each in its own try/catch so a failing sweep cannot
  starve the other eight: the four ported sweeps (`expireHolds` — now fed the
  configured hold TTL from one settings read per tick, closing the parity gap the
  composition root flagged — `expireOrders`, `dispatchOrderEmails`,
  `pruneChallenges`) and five new ones (sku-transfer completion,
  `order_sku_index` heal, partial adopt/commit/release completion, reporting
  rollup heal, and orphaned coupon-redemption release). Every leg is idempotent
  and discovers its work through DECLARED indexes only.
- NO LEG CAN STARVE. Every scan over an unbounded collection walks behind an
  advancing cursor kept in `ctx.kv` rather than re-reading the oldest page of a
  `createdAt ASC` list on every tick: the coupon and `order_sku_index` legs move
  forward with a small overlap, the product scan rotates and wraps, and the
  reporting heal walks a day watermark so a day lost to an outage is healed by a
  later tick instead of never. A lost cursor costs a re-read, never correctness.
- The coupon leg releases ONLY the claimed-but-unapplied case (`order === null`),
  which is the domain's own rule in `reconcileCouponRedemptions` and the scope the
  ratified amendment gave it. An `expired` order's redemption is already released
  by `expireOrders`' `releaseByOrder`, and `cancelOrder` deliberately releases
  none — reversing that from a sweeper would be an unratified policy change.
- Every leg logs its own line, and a genuinely lost reservation is written to the
  order with `flagReconciliation`: the host's cron executor discards the hook's
  return value, so a summary is not a record.
- The hold-intent completer drives the order store's PER-ID completers from the
  order's own recorded intent — never a `commitMany` replay, which skips ids
  already terminal in `reservation_index` and would stamp a partial set done —
  and re-reads the order's current state before treating a lost reservation as an
  anomaly, because that guard reads a non-versioned `get`.

KNOWN GAP: the coupon leg releases an orphaned redemption but does not RECOUNT
the coupon's global counter, so a release that dies mid-way can leave `usesCount`
one high (the safe direction — it refuses a redemption, never grants one).
`CouponStore` exposes no recount today.
