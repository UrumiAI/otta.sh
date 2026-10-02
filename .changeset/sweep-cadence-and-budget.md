---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

Run the commerce sweep every minute, inside a budget of time and of D1 queries, so holds expire close to
their TTL and a slow leg can no longer starve the rest (ADR-0019 amendment 2026-10-02).

End-to-end QA found the `commerce-sweeps` task due every fifteen minutes under a one-minute site cron, so
a fifteen-minute cart or order hold lasted fifteen to thirty minutes and queued emails waited up to
fifteen. Worse, the nine legs ran back to back in one hook that EmDash abandons after 5000 ms: the log
showed `expire-holds 18`, `expire-orders 14`, then `Hook timeout after 5000ms`, and the outbox and every
completer after them never ran.

`@otta-sh/plugin`:

- `SWEEP_SCHEDULE` is now `* * * * *`. An existing deployment's task row is rewritten by the per-isolate
  bootstrap, which now reads the row first and writes only when the schedule differs; the tick no
  longer re-registers the task on every run.
- The `cron` hook declares its timeout (`SWEEP_HOOK_TIMEOUT_MS`, 15 s — raised from the host's 5 s
  default so a slow-but-working email provider's send fits; a long tick can delay another plugin's
  task due in the same minute). Each tick's budget starts at hook entry: `SWEEP_TICK_BUDGET_MS` (9.5 s)
  of wall time (not CPU) and
  a number of storage/kv/egress calls set by the new **"Background work per minute"** operational
  setting (Settings → Checkout & holds; `settings:backgroundWorkPerMinute` in plugin kv) — presets
  Workers Free (30, the default, `SWEEP_TICK_QUERY_BUDGET`) and Workers Paid (600); 30–900 accepted
  (30 is the floor: below it an order expiry could never start), anything else refused on save with a
  message and ignored on read. Read once per tick, counted in the budget. It is checked before every leg and before each unit inside one (each hold or order flip,
  outbox claim, scanned page or row, reporting day), admitting a unit only if the slowest seen so far
  still fits with a trailing reserve (`SWEEP_TICK_RESERVE_MS`). A leg the budget did not reach is
  `deferred` (with `ok: true`) and runs on the next tick; a leg that stopped early is `incomplete`.
- Each email send from the sweep is limited to `SWEEP_EMAIL_SEND_TIMEOUT_MS` (5 s) or what is left of the
  outbox's share, whichever is sooner, and the whole send (including pre-request work the abort signal
  cannot reach) is raced against a timer at that limit. A row handed back because too little time was
  left just before the send is not counted and is due again in 30 s. A send the tick gave LESS than the
  full cap that times out is not the provider's fault: due at once, nothing recorded. A TIMEOUT with the
  full cap is not counted either, but the row is backed off (1 min, doubling to 15) so it cannot stall
  the queue; after ten such timeouts the sweep logs `console.error` and further timeouts count,
  eventually parking the row with reason "provider kept timing out". `CtxHttpEmailSender` reports its own abort as `EmailSendTimeoutError` and
  accepts `requestTimeoutMs` as a function, asked at each send; the sender is built lazily.
- The three critical legs (`order-emails`, `expire-holds`, `expire-orders`) run first and take turns
  leading by minute; each may use only a share of the tick, never less than one unit of its own work.
  Then `hold-intents`, `prune-challenges`, then the scans. Per-leg unit costs are measured
  (`LEG_QUERY_COSTS`, pinned by a test).
- The four scan legs (`MAINTENANCE_LEGS`: `sku-transfers`, `order-sku-index`, `reporting-heal`,
  `coupon-orphans`) keep a fifteen-minute cadence per leg (`MAINTENANCE_LEG_INTERVAL_MS`), stamped in
  `ctx.kv` (`SWEEP_STATE_KV_KEY`); a not-yet-due leg is `notDue`, a failed scan is stamped (it retries at
  its own cadence), a cut-short one is not. `reporting-heal` reconciles one day per budget check.
- Per-tick bites are sized from the query budget and the measured costs: 2 holds / 2 orders / 1 email
  on the Free preset, 18 / 18 / 22 on Paid; backlogs beyond that drain over several ticks.
- The workerd sandbox entry's kv window is test-only (`createSandboxWorker(plugin, { testHooks: true })`
  in a fixture entry); the production `./sandbox-entry` export does not have it. A forward cursor cut short by the budget always advances.
- `coupon-orphans` is deferred in any tick whose `expire-orders` did not run to the end, since its
  `expired` arm is that leg's retry.
- Logging: an idle leg logs nothing; a leg logs when it did work or has more left; deferrals are one
  line per tick, with a warning after five consecutive deferrals of the same leg.
- `CommerceSweepSummary` gains `budget` (the limits a tick ran under, and the queries it used).
- `SweepLegOutcome` gains optional `deferred`, `notDue` and `incomplete`; `CommerceSweepOptions` gains
  `budgetMs`, `queryBudget`, `tickClock`, `startedAtMs`, `expiryBatchLimit`, `emailBatchLimit` and
  `emailSenderFactory`.

`@otta-sh/domain` (additive): `expireHoldsBatch` and `expireOrdersBatch` take a `limit` and a
`shouldContinue` and report `{ count, drained }`, asking the store for `limit + 1` candidates;
`expireHolds`/`expireOrders` are unchanged and delegate to them; `shouldContinueListing` bounds the
store's candidate list too. A limit that is not a positive integer
is a `RangeError` (`assertSweepLimit`). `CartStore.listExpired` and `OrderStore.listExpirable` take an
optional `{ limit, shouldContinue }` (`ExpiryListOptions`), with contract cases; `listExpired` must not
offer a lapsed hold that can no longer be expired. `DispatchOrderEmailsOptions` gains `shouldContinue`
(before each claim) and `canSend` (just before each send; a refusal hands the row back). New
`OrderStore.releaseEmailClaim(id, { retryAt?, timedOut? })` (contract cases) hands a claimed row back
without counting the attempt — optionally backed off and with one more timeout recorded — and
`EmailSendTimeoutError`/`isEmailSendTimeoutError` mark a send the caller cut off (with `cutShort` /
`isCutShortEmailTimeout` when it was given less than its full allowance — handed back due at once,
nothing recorded). A canSend refusal is handed back due in `UNTRIED_RETRY_MS` (30 s). `OutboxEmail`
gains `timeouts` (it stops at `MAX_UNCOUNTED_TIMEOUTS`; later timeouts are recorded as attempts); `rescheduleEmail` takes an optional park `reason`; new exports `timeoutBackoffMs`,
`TIMEOUT_BACKOFF_BASE_MS`, `TIMEOUT_BACKOFF_MAX_MS`, `MAX_UNCOUNTED_TIMEOUTS`,
`TIMEOUT_FAILURE_REASON`, `ReleaseEmailClaimOptions`, and `onRepeatedTimeouts`/`maxUncountedTimeouts`
on `DispatchOrderEmailsOptions`.

**Breaking for `OrderStore` implementers:** `releaseEmailClaim` is a REQUIRED port method, and
`claimNextEmail` must now return `timeouts` on `OutboxEmail`. Any custom `OrderStore` (including
hand-written test doubles) must add both — see the in-memory fake for the reference behaviour.

`@otta-sh/store-emdash` (additive): `EmdashCartStore.listExpired` and `EmdashOrderStore.listExpirable`
honour the limit, stopping their page walk and per-row reads once they hold that many;
`listExpired` honours the stop check and skips lapsed lines whose reservation is no longer live
(unless a claimed expiry is owed its completion), and HEALS such a cart's `holdExpiresAt` index so it
stops matching every listing (dead carts no longer starve hold expiry at the listing step).
`EmdashOrderStore.releaseEmailClaim` implements the new port method (forward `dueAt`, a `timeouts`
counter on the outbox entry), and a parked entry records `failureReason`.
