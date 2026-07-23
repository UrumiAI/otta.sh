# 0008. Order refunds are an append-only ledger + a gateway `refund` port method (Stripe real, x402 record-only)

- Status: accepted
- Date: 2026-07-23
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

### The Shopify / WooCommerce lens

- **Shopify** models a refund as a first-class Orders-API object: line-level refunds (pick line
  items + quantities), a **restock toggle**, refund-shipping, refund-to-original-payment-method,
  **partial and repeated** refunds that sum toward the order total, and a `refund.transactions[]`
  ledger of the gateway refund transactions. Order line items are never mutated —
  `financial_status` (`partially_refunded`/`refunded`) is **derived** from the refund ledger.
- **WooCommerce** is simpler and more honest about the gateway split: an order-refund child with
  negative line items, and a per-refund choice of **manual refund** (record only) vs **automatic
  refund** (call the gateway API). The merchant decides, per refund, whether money actually moves.

Shopify's line-level + restock richness is *more* than v1 needs and collides head-on with Urumi's
frozen-snapshot, single-terminal-`refunded`-state design. Woo's **manual-vs-gateway** split, by
contrast, maps almost exactly onto Urumi's **Stripe (gateway) vs x402 (manual-only)** asymmetry —
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

2. **Stripe adapter refunds for real.** `refund` calls `refunds.create` against the charge/PI,
   passing our `idempotencyKey` as Stripe's native **`Idempotency-Key`** (double-charge-back
   safety at the provider). Partial is supported (any `amount ≤ captured`).

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
   - **`Σ refunds(order) ≤ order_totals.total`** — the frozen total is the ceiling the ledger
     *reads*; it is never rewritten. Over-refund is rejected (`REFUND_EXCEEDS_TOTAL`).
   - **Idempotent once-only** via `UNIQUE(idempotency_key)` (CLAUDE.md), *and* Stripe's native
     `Idempotency-Key` for the gateway leg — a replay records nothing and re-calls nothing.
   - **No inventory restock** (deliberately unlike Shopify's toggle): `settle` already `commit`ted
     the reservation; auto-returning stock would re-open an oversell path and pre-empt a merchant
     inventory decision. v1 records the refund only; re-stocking is a separate manual inventory act.

5. **State interaction — reuse the `#flipAndEnqueue` choke point, do not widen the machine.**
   - A **full** refund (`Σ refunds == total`) drives the existing `→ refunded` transition **and**
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
- **Externally-initiated refunds are a documented v1 gap.** Settlement consumes only
  `payment_intent.succeeded|failed`; we do **not** consume `charge.refunded`. A refund issued from
  the Stripe dashboard (or any out-of-band return) is **invisible to the ledger**, so the
  `Σ refunds ≤ total` ceiling reflects *Urumi-initiated* refunds only. Reconciling inbound refund
  webhooks is explicitly deferred (a follow-up, in the spirit of the fire-and-forget reconcile
  gaps noted in ADR-0007).
- **No auto-restock** means a merchant refunding a physical order must return stock by hand — an
  accepted trade to keep the no-oversell invariant unbreached through a refund path.
- Implementable as **1–3 vertical slices**: (a) `refund` port verb + Stripe adapter + x402
  `UNSUPPORTED` + `refundable`; (b) `refundOrder` use-case + `recordRefund` ledger + migration +
  full-refund `#flipAndEnqueue` compose; (c) admin order-page refund action + timeline entry.

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

## Status rationale — **ACCEPTED (scoped)**

The invariant scaffolding refunds need already exists — frozen snapshots, idempotency keys,
guarded flips, a payments ledger, the `#flipAndEnqueue` choke point, and adapter-side crypto — so
the *risk is in scope creep, not in the primitive*. Accepting the tight shape (gateway `refund`
verb; append-only amount-granular ledger with `Σ ≤ total`; full-refund reuses the existing
transition; x402 = declared-unsupported / manual-record-only; no restock, no line-level refunds,
no inbound-refund-webhook consumption) makes the `refunded` state truthful this increment while
leaving every richer capability as an additive, non-breaking follow-up. Rejecting refunds would
ship the admin build with a `refunded` label that actively lies to operators — the worse outcome.

**Riskiest assumption (for the reviewing expert to attack):** that the `Σ refunds ≤ total` ceiling
is trustworthy while it is enforced **only against Urumi's own ledger**. Any out-of-band return —
a Stripe-dashboard refund, or a gateway `refunds.create` that succeeded but whose response we
failed to record — makes the ceiling wrong and admits a **double refund**. The mitigations
(Stripe `Idempotency-Key`, deferring inbound `charge.refunded` reconciliation) narrow but do not
close this; whether v1 can ship without consuming inbound refund webhooks is the crux.
