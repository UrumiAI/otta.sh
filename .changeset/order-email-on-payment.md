---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

A paid order's confirmation email goes out with the settlement, not on the next sweep
(ADR-0005, amended 2026-10-02). The sweep's `order-emails` leg is the only dispatcher today,
so the email waits for the next tick even after a payment has settled.

- **Breaking (port):** `OrderStore` gains a required method,
  `claimNextEmailForOrder(orderId, now, leaseUntil, options?)`. A custom `OrderStore`
  adapter must implement it.
- **`@otta-sh/domain`.** `claimNextEmailForOrder` is `claimNextEmail` narrowed to one order.
  It uses the same due predicate, the same lease and the same single-winner write, and it
  never claims another order's row. It returns the same `notice` and `timeouts` fields as the
  global claim. `{ onlyUnattempted: true }` further limits it to rows no dispatcher has tried
  (`attempts === 0` and `timeouts === 0`), checked inside the write, so a request never
  undercuts the sweep's backoff. Its behaviour is pinned in `orderTransitionContract`, which
  runs on the fake, both Node dialects and D1. A new use-case,
  `dispatchOrderEmailsForOrder(deps, orderId, options)`, shares one drain body with
  `dispatchOrderEmails`, and only the claim differs. Both therefore get `shouldContinue` and
  `canSend`, cut-short and genuine timeout handling, failure reasons and notice rendering.
- **`@otta-sh/store-emdash`.** `EmdashOrderStore.claimNextEmailForOrder` exposes the per-order
  claim step `claimNextEmail` already ran for each index candidate: one `getVersioned` of the
  order document and one compare-and-set, with no index walk. Contention on it is labelled
  `claimNextEmailForOrder`.
- **`@otta-sh/plugin`.** After an ok settle, `webhooks/stripe/settle` and
  `entitlements/x402/settle` call `sendOrderEmailsNow` for the order the settlement reports.
  The call is best-effort and cannot change the response. It runs outside the 503 mappings
  and never throws. It makes at most one attempt per row, so redeliveries cannot spend the
  retry budget; the total budget (`maxAttempts`) is unchanged. The sender is built only once
  a row has been claimed, so a replay costs one order read.
- **One deadline per settle request.** `settle-deadline.ts` fixes an 8 s deadline as the
  route starts. A late payment's Stripe refund calls (each also capped at
  `SETTLE_PROVIDER_TIMEOUT_MS`) and the inline email wait (capped at 5 s) both draw on it, so
  the whole request stays under Stripe's ~10 s. A spent budget skips the inline attempt.
  Each inline send is capped at the login email's 3 s, or at what is left of the wait if
  less, and an inline timeout is marked cut short. It is therefore released uncounted, and
  the provider is never charged with it. The claim takes a 1-minute lease. Store failures are
  logged with the order id and the error message only. A bundle with no email API URL sends
  nothing inline. The sweep's leg is unchanged and remains the at-least-once backstop, and
  the provider `Idempotency-Key` is still the outbox row id.
