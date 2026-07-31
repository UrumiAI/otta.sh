# 0008. Order refunds are an append-only ledger + a gateway `refund` port method (Stripe real, x402 record-only)

- Status: accepted — second-expert concurrence **with conditions**, all three incorporated in the
  2026-07-23 amendment: (1) refund-time provider pre-flight (never issue blind), (2) ceiling bound
  to `min(Σ captured, total)`, (3) the Stripe-stub → first-live-API reality stated and scoped
- Date: 2026-07-22 (amended 2026-07-23 per review of PR #77)
- Refines: ADR-0001/0002 (pluggable payments; `PaymentGateway` port). Relates to Phase 4 settle
  (`settle-order.ts`), the order state machine (`state-machine.ts`), the reconciliation
  disposition (`resolve-reconciliation.ts` / #61), and the timeline/audit spine (#65).

## Context

The admin UX build has reached money movement, and today the system *cannot move money back*.
The reality on disk:

- **`PaymentGateway` has only `createIntent` + `verifyConfirmation`** (`ports/payment-gateway.ts`).
  Both are money-IN paths; there is no money-OUT verb. All secrets/crypto live inside the
  adapter (Stripe HMAC, x402 facilitator), and the domain is IO-free.
- **`refunded` is a bare state label.** `ORDER_STATE_MACHINE` lets `paid`/`processing`/
  `shipped`/`delivered`/`completed → refunded` and fires an `order-refunded` email
  (`state-machine.ts`), but *nothing moves money* — reaching `refunded` is a status flip only.
- The seam is already **admitted in the UI copy**: the reconciliation resolve form's `refunded`
  disposition is labelled *"recorded only — issue the refund separately"* and the panel says
  *"Resolving records your decision only — it does NOT move money … issue it via your payment
  provider (or the refunded status flow) separately"* (`admin/orders-page.ts:676,703`). That copy
  is honest, but it points at a "refunded status flow" that does not exist as a money action.
- **Settlement records a `payments` row** (`recordPayment`: gateway, `providerRef`, amount,
  currency, status) and dedupes/anomalies on `payment_events`. There is **no refunds ledger**.
- **The snapshot invariant is absolute**: `order_totals` is written **once** at creation and
  never rewritten; `order_items` are insert-once (`model.ts`, `create-order-from-cart.ts`). Any
  refund design that mutates the order's money columns is disqualified on sight.
- **Two gateways, asymmetric refundability.** Stripe has a first-class, idempotent refund API
  (`refunds.create`, native `Idempotency-Key`). **x402 is on-chain settlement** (USDC on an
  eip155 network; `X402Proof.transaction` is a tx hash, `payer` is the buyer wallet). On-chain
  transfers are **irreversible**, and the x402 adapter only *verifies inbound receipts via a
  facilitator* — it holds **no signing wallet and no outbound-payment capability at all**. There
  is no "x402 refund" to call. This is the load-bearing fact of the whole ADR.
- **The Stripe adapter is currently an offline deterministic stub — `refund` will be the repo's
  FIRST live Stripe API call.** `packages/payments-stripe`'s `createIntent` makes **no network
  call** (it constructs the `pi_…` handle offline so the whole suite runs without Stripe;
  `secretKey` is accepted but *"reserved for real intent creation"* — `index.ts`); only
  `verifyConfirmation` does real crypto, and that is inbound HMAC, not an outbound API call. A
  real `refunds.create` therefore introduces the first outbound Stripe dependency the codebase
  has ever had — live-API error classes (network failure, 4xx vs 5xx, ambiguous timeout), real
  `secretKey` handling, and a test seam none of which exist today. The refunds slice must be
  scoped for this, not treated as "one more offline adapter method".
- **Settle admits short captures.** `settle-order.ts` records `AMOUNT_MISMATCH` anomalies and
  can leave a `paid` order whose actually-captured `payments` amount differs from the frozen
  `order_totals.total` — so "the order total" and "the money we actually hold" are NOT the same
  number, and a refund ceiling must respect the smaller of the two.

### The Shopify / WooCommerce lens

- **Shopify** models a refund as a first-class Orders-API object: line-level refunds (pick line
  items + quantities), a **restock toggle**, refund-shipping, refund-to-original-payment-method,
  **partial and repeated** refunds that sum toward the order total, and a `refund.transactions[]`
  ledger of the gateway refund transactions. Order line items are never mutated —
  `financial_status` (`partially_refunded`/`refunded`) is **derived** from the refund ledger.
- **WooCommerce** is simpler and more honest about the gateway split: an order-refund child with
  negative line items, and a per-refund choice of **manual refund** (record only) vs **automatic
  refund** (call the gateway API). The merchant decides, per refund, whether money actually moves.

Shopify's line-level + restock richness is *more* than v1 needs and collides head-on with Otta's
frozen-snapshot, single-terminal-`refunded`-state design. Woo's **manual-vs-gateway** split, by
contrast, maps almost exactly onto Otta's **Stripe (gateway) vs x402 (manual-only)** asymmetry —
that is the model we adopt, kept at order/amount granularity rather than line granularity.

## Decision

Ship refunds as **money-movement made honest**, in the smallest shape that preserves every
invariant. Five parts:

1. **New port verb: `PaymentGateway.refund(input): Promise<RefundResult>`** — the mirror of
   `createIntent`. Input carries `orderId`, the original `providerRef` (charge/PI id from the
   `payments` row), `amount: Cents`, `currency`, and the `idempotencyKey`. Result is the
   normalized `{ ok: true; refundRef; amount; currency } | { ok: false; reason }`. All crypto /
   secrets stay adapter-side, exactly like the money-in verbs.
   - The gateway also declares its capability: **`readonly refundable: boolean`** (Stripe `true`,
     x402 `false`). The domain and admin UI branch on this — never a `try/catch` to *discover* it.

2. **Stripe adapter refunds for real — with a mandatory refund-time pre-flight (review
   condition 1).** Before issuing, `refund` **synchronously reads the charge/PaymentIntent's
   `amount_refunded`** from Stripe and **fails closed** (`PROVIDER_ALREADY_REFUNDED`, nothing
   recorded, nothing issued) if provider-side refunds already exceed — or would exceed with this
   refund — the local ledger's view. This kills the classic Woo+Stripe double-refund failure mode
   (dashboard refund + app refund both going through): deferring `charge.refunded` webhooks is a
   *visibility* gap we accept, but **issuing refunds blind is out**. Only after the pre-flight
   passes does `refund` call `refunds.create`, passing our `idempotencyKey` as Stripe's native
   **`Idempotency-Key`**. Partial is supported (any `amount ≤ captured − amount_refunded`).
   - **This is the repo's first live Stripe API call** (see Context): the pre-flight
     (`GET /charges|payment_intents`) and `refunds.create` both require the real `secretKey`
     (service-env only, per the existing option's contract), explicit error taxonomy in the
     normalized `RefundResult` (retryable transport failure vs terminal provider rejection vs the
     **ambiguous timeout** — an errored `refunds.create` whose fate is unknown must surface as
     "unverified, re-check before retry", never as a clean failure), and a **test strategy at the
     adapter contract level with a mocked transport** (an injected fetch/HTTP seam playing
     recorded Stripe responses — keeping the suite offline, the same philosophy as the existing
     offline fake-Stripe webhook driver).

3. **x402 is the honest degraded path — a *manual, recorded* refund.** `X402PaymentGateway.refund`
   returns `{ ok: false; reason: "UNSUPPORTED" }` (a capability statement, not a runtime error):
   an on-chain settlement cannot be reversed and the service has no wallet to send from. A refund
   on an x402 order is therefore recorded as a **`kind: "manual"`** ledger entry — the admin sends
   the return transfer out of band (to the captured `payer` wallet, which the refund path surfaces
   from the original `X402Proof`) and records that they did. The domain **never claims** to have
   moved the money; this is exactly today's *"records only, no money moves"* copy, promoted from a
   bare state label to a first-class, audited record.

4. **An append-only `refunds` ledger — the order snapshot is never touched.** New use-case
   `refundOrder` and a store write `recordRefund` (folded into `OrderStore` alongside
   `recordPayment`, or a sibling `RefundStore`). A refund row:
   `{ id, orderId, amount: Cents, currency, kind: "gateway" | "manual", gateway, refundRef | null,
   reason, refundedBy, createdAt, idempotencyKey }`. Invariants:
   - **`Σ refunds(order) ≤ min(Σ captured payments, order_totals.total)`** (review condition 2)
     — the ceiling is the smaller of the money we *actually captured* (the `payments` rows) and
     the frozen total. `settle-order.ts` admits capture-amount anomalies, so refunding up to the
     frozen total against a **short capture** would return money we never received; the frozen
     total remains a hard upper bound (never rewritten, never exceeded even if a capture
     over-recorded). Over-refund is rejected (`REFUND_EXCEEDS_CAPTURED` / `REFUND_EXCEEDS_TOTAL`).
   - **Idempotent once-only** via `UNIQUE(idempotency_key)` (CLAUDE.md), *and* Stripe's native
     `Idempotency-Key` for the gateway leg — a replay records nothing and re-calls nothing.
   - **No inventory restock** (deliberately unlike Shopify's toggle): `settle` already `commit`ted
     the reservation; auto-returning stock would re-open an oversell path and pre-empt a merchant
     inventory decision. v1 records the refund only; re-stocking is a separate manual inventory act.

5. **State interaction — reuse the `#flipAndEnqueue` choke point, do not widen the machine.**
   - A **full** refund (`Σ refunds` reaches the ceiling — all recoverable money returned) drives
     the existing `→ refunded` transition **and**
     writes the ledger row **atomically**, in the exact "guarded flip + record the mutable
     envelope" shape as `cancelOrder`/`recordFulfillment` — so the `order-refunded` email fires
     once and a `state_change` audit event is captured, with no reachable "refunded but no refund
     recorded" state.
   - A **partial** refund records the ledger row and **does not transition** (the order stays
     `paid`/`shipped`/…). "Partially refunded" is a **derived badge** (`Σ refunds` vs `total`,
     Shopify's `financial_status` idea) — *not* a new stored state. We deliberately do **not** add
     a `partially_refunded` state this increment.
   - **Reconciliation stays decoupled.** `resolveReconciliation`'s `refunded` outcome remains a
     pure disposition record; `refundOrder` is the money verb. The existing "issue it separately"
     copy is now satisfied by a real flow instead of pointing at a phantom one.
   - **Timeline:** add a derived `refund` entry kind (from the ledger, like `fulfillment`/
     `cancellation`) so refunds appear in the audit view (#65).

## Consequences

- **The `refunded` state stops lying.** Reaching it now means money was returned (gateway) or a
  return was recorded (manual), atomically with the status and the email.
- **The Stripe/x402 asymmetry is surfaced, not hidden.** `refundable` lets the admin order page
  render "Refund via Stripe" as an action but "Record manual refund (send USDC to `payer`
  yourself)" for x402 — no button ever silently no-ops.
- **The snapshot invariant is untouched.** Refunds are a new append-only table keyed to the order;
  `order_items`/`order_totals` are never mutated, so a refunded order's history is intact and the
  ledger, not the order row, is the source of "how much came back".
- **Externally-initiated refunds are a *visibility* gap only — never an issuance hazard.**
  Settlement consumes only `payment_intent.succeeded|failed`; we do **not** consume
  `charge.refunded`, so a Stripe-dashboard refund stays invisible to the ledger *until the next
  refund attempt*. But the mandatory refund-time pre-flight (Decision 2) reads the provider's
  live `amount_refunded` before every issuance and fails closed on divergence — so an out-of-band
  refund can make the ledger stale, it can no longer cause a **double refund**. Reconciling
  inbound refund webhooks (closing the visibility gap and healing the ledger) remains an
  explicitly deferred follow-up (in the spirit of the fire-and-forget reconcile gaps noted in
  ADR-0007). The pre-flight guards Stripe only; the manual/x402 leg has no provider to ask (see
  the residual risk below).
- **The Stripe adapter stops being fully offline.** `refund` + its pre-flight are the first
  outbound Stripe API calls in the repo; the adapter gains a transport seam (injected, mocked in
  tests — the suite stays offline), a normalized live-error taxonomy including the ambiguous
  timeout, and a hard requirement on `secretKey` for the refund path (unset ⇒ `refundable`
  effectively false at wiring time, surfaced honestly in the admin UI). The refunds slice is
  costed as a live-integration slice, not an offline-stub extension.
- **No auto-restock** means a merchant refunding a physical order must return stock by hand — an
  accepted trade to keep the no-oversell invariant unbreached through a refund path.
- Implementable as **1–3 vertical slices**: (a) `refund` port verb + x402 `UNSUPPORTED` +
  `refundable`, and the Stripe adapter's live transport seam (pre-flight + `refunds.create`
  behind a mocked transport at the adapter contract level); (b) `refundOrder` use-case (ceiling +
  pre-flight orchestration) + `recordRefund` ledger + migration + full-refund `#flipAndEnqueue`
  compose; (c) admin order-page refund action + timeline entry.

## Alternatives considered

- **Line-level refunds with a restock toggle (full Shopify).** Rejected for v1: it needs a
  `partially_refunded` state, per-line refund quantities against frozen `order_items`, and a
  restock path that re-touches inventory — three invariant-adjacent expansions at once. The
  derived-badge + amount-granular ledger gives 90% of the value at a fraction of the risk.
- **Refund as a pure record, no gateway call (Woo "manual" for *both* gateways).** This is
  literally today's behaviour. Rejected as the *whole* design: it would leave Stripe refunds
  manual forever when Stripe offers a safe, idempotent API — the admin would keep bouncing to the
  Stripe dashboard, and the ledger would perpetually under-count. Manual is the honest floor for
  x402 **only**.
- **A generic `PaymentGateway` that pretends x402 can refund** (throwing at runtime). Rejected:
  it hides an operational truth (irreversibility) behind an exception and invites a caller to
  treat a failed on-chain "refund" as retryable. A declared `refundable: false` is honest by
  construction.
- **Auto-refund on a settle anomaly** (amount mismatch, lost hold). Already explicitly rejected by
  `settle-order.ts` (§9 Risk 3, "no auto-refund"); this ADR keeps that — refunds are always an
  admin-initiated, audited act, never an automatic consequence of a settlement race.

## Status rationale — **ACCEPTED (scoped; reviewer concurrence with conditions incorporated)**

The invariant scaffolding refunds need already exists — frozen snapshots, idempotency keys,
guarded flips, a payments ledger, the `#flipAndEnqueue` choke point, and adapter-side crypto — so
the *risk is in scope creep, not in the primitive*. Accepting the tight shape (gateway `refund`
verb; append-only amount-granular ledger with `Σ ≤ min(Σ captured, total)`; full-refund reuses
the existing transition; x402 = declared-unsupported / manual-record-only; no restock, no
line-level refunds, no inbound-refund-webhook consumption) makes the `refunded` state truthful
this increment while leaving every richer capability as an additive, non-breaking follow-up.
Rejecting refunds would ship the admin build with a `refunded` label that actively lies to
operators — the worse outcome.

The second reviewer concurred with three conditions, all incorporated above: the original draft's
own named riskiest assumption (a ledger-only ceiling admits double refunds against out-of-band
returns) is now closed on the issuance side by the **mandatory refund-time pre-flight** (Decision
2) and the **captured-bound ceiling** (Decision 4), and the hidden implementation cliff is named:
the Stripe adapter is an offline stub today, so `refund` is the repo's **first live Stripe API
call** and the slice is scoped as a live integration (transport seam, error taxonomy, mocked
transport at the adapter contract level).

**Residual riskiest assumption (post-conditions):** that the pre-flight + ceiling actually close
the double-refund window. Two attack surfaces remain: (a) the pre-flight is a **read-then-issue
race** — a concurrent dashboard refund landing between the `amount_refunded` read and
`refunds.create` can still double-refund (narrowed to seconds, not closed; only consuming
`charge.refunded` or a Stripe-side atomic guard closes it); and (b) the **manual/x402 leg has no
provider to pre-flight** — the ledger's `Σ` for manual refunds is only as truthful as the admin
recording them, so the honest-record path can under- or over-count with no external check.
