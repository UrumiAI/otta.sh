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
- Declares two hooks: `plugin:activate`, which registers the `commerce-sweeps`
  task at the host's own registration moment, and `cron`, which re-affirms that
  registration (the upsert is free, and it lets a schedule change land on the next
  tick) and then runs the sweeps. The cadence is the service's own
  fifteen-minute schedule, carried over unchanged.
- One tick runs nine legs, each in its own try/catch so a failing sweep cannot
  starve the other eight: the four ported sweeps (`expireHolds` — now fed the
  configured hold TTL from one settings read per tick, closing the parity gap the
  composition root flagged — `expireOrders`, `dispatchOrderEmails`,
  `pruneChallenges`) and five new ones (sku-transfer completion,
  `order_sku_index` heal, partial adopt/commit/release completion, reporting
  rollup heal, and orphaned coupon-redemption release). Every leg is idempotent
  and discovers its work through DECLARED indexes only.
- The hold-intent completer drives the order store's PER-ID completers from the
  order's own recorded intent — never a `commitMany` replay, which skips ids
  already terminal in `reservation_index` and would stamp a partial set done —
  and re-reads the order's current state before treating a lost reservation as an
  anomaly, because that guard reads a non-versioned `get`.

KNOWN GAP: the coupon leg releases an orphaned redemption but does not RECOUNT
the coupon's global counter, so a release that dies mid-way can leave `usesCount`
one high (the safe direction — it refuses a redemption, never grants one).
`CouponStore` exposes no recount today.
