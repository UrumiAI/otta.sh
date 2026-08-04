# Phase 4 — Checkout + Gateways

_Implementation plan (no code). Follows [`../DEVELOPMENT.md`](../DEVELOPMENT.md),
[`../CLAUDE.md`](../CLAUDE.md), and slots into
[`draft-plans/implementation-plan.md`](../draft-plans/implementation-plan.md) row 4. Every
step is **failing test first, then the minimum code**; a step is done only when its named
test is green. The contract suite is the spec._

**One-line goal:** turn a Phase-3 cart (with live reservations) into an immutable order,
take money through a `PaymentGateway` port with two very different adapters (Stripe
async-webhook, x402 synchronous page-gate), and on confirmed payment either **commit** the
reservation (physical) or **grant an entitlement** (digital) — with order lines that
snapshot price + title so later product edits never rewrite them.

---

## 1. Goal & headline tests

The phase is done when these behavioral cases are green (exact cases; test names fixed in §8):

1. **Stripe webhook flips paid + commits reservation.** A cart with a physical line is
   turned into a `pending` order holding a Phase-3 reservation. A *verified* Stripe
   `payment_intent.succeeded` webhook for that order transitions `pending → paid` and calls
   `InventoryStore.commit(reservationId)` exactly once. Stock is committed, not released.
2. **x402 page-gate grants an entitlement.** A digital line's order, once its x402 payment
   proof verifies, transitions to `paid` and inserts an `entitlements` row that a later
   entitlement check returns as active — authorizing digital delivery.
3. **Order lines snapshot price + title.** After an order is created, editing the product
   (price and title change via the Phase-1 sync path) leaves the existing order's line
   items **byte-for-byte unchanged** (`unit_price_cents`, `currency`, `title`).
4. **Webhook idempotency / replay.** Delivering the same Stripe event twice (Stripe
   retries) settles the order **once**; the second delivery is a no-op success.
5. **Payment failure / timeout releases the reservation.** A `payment_intent.payment_failed`
   webhook — or an unpaid order past its checkout hold TTL swept by the Phase-3 expiry
   mechanism — transitions the order to `failed`/`expired` and calls
   `InventoryStore.release(reservationId)`, returning stock.
6. **Idempotent order creation.** `createOrderFromCart` replayed with the same
   `IdempotencyKey` returns the same order and does not double-snapshot or double-reserve.

---

## 2. Scope

### In
- Order creation from a cart: `pending` order, line items with **price + title snapshots**,
  and a **1:1 `order_totals` stub row** (`subtotal_cents = total_cents = Σ(unit_price_cents ×
  quantity)`; discount/shipping/tax `0`). Totals live in `order_totals`, never on `orders`.
- `PaymentGateway` **port** + two adapters: **Stripe** (create intent → async webhook
  confirmation) and **x402** (challenge descriptor → synchronous page-gate proof).
- The domain `settleOrder` use-case that both adapters converge on: verify → dedupe →
  transition → commit-or-grant.
- **Entitlements** for digital goods: schema, grant on paid, check for delivery
  authorization.
- Order **state machine** with success, failure, and expiry paths; expiry is a **real
  `orders`-table guarded transition** (`pending → expired`) that then releases the order's
  adopted reservations — not a reuse of the Phase-3 reservation sweep (§5).
- New REST surface (`@otta-sh/service`), 1:1 with the new ports; a Stripe **webhook receiver**
  and an **entitlement check** endpoint.
- Plugin (`@otta-sh/plugin`) wiring, sandbox-clean: a public webhook **proxy** route and the
  x402 **page-layer** gate + entitlement-verified digital download — `ctx.http` only.

### Out (explicitly deferred)
- **No shipping / tax / coupon math** — Phase 6. Phase 4 writes the `order_totals` **stub**
  (`subtotal_cents = total_cents = Σ(unit_price_cents × quantity)`; discount/shipping/tax `0`).
  Phase 6 **replaces the computation feeding that one write** — it adds no new table and no
  `orders` money column; it fills the `order_totals` columns this phase already creates.
- **No customer accounts** — Phase 5. Entitlements in Phase 4 are keyed by order + a claim
  token (email/session), re-associated to a customer identity in Phase 5. No `ctx.users`
  ever (that is CMS staff).
- **No transactional email** — Phase 5. We only expose the state-transition points an email
  trigger will later hook.
- No refunds, partial capture, multi-intent orders, or variations (past-v1). One payment
  intent per order.
- No `store-emdash` / `InProcessCommerceClient` (adapter-architecture §6 — not until a
  second real impl exists).

---

## 3. Dependencies

### Reused from Phases 0–3 (exact)
- **`InventoryStore.commit(reservationId)` / `.release(reservationId)`** (Phase 0.2) — the
  settle path commits; the failure/expiry path releases. No new inventory primitive.
- **Branded money & ids** (Phase 0.2): `Cents`, `Currency`, `Sku`, `ProductId`,
  `IdempotencyKey`. A `number` reaching a money field stays a compile error.
- **Contract-suite harness** (`describeEachDialect`-style, Phase 0.3–0.4) — extended with
  `orderStoreContract`, `entitlementStoreContract`, `paymentGatewayContract`.
- **REST-mirrors-port + live-server HTTP contract harness** (Phase 0.6) — reused for the new
  endpoints and the webhook receiver.
- **Product sync → `product_commerce`** (Phase 1) — the source of the price + title that the
  order snapshots; the immutability test edits a product through this same sync path.
- **Storefront PDP/PLP + cart with live reservations & hold expiry** (Phases 2–3) — checkout
  page, success/polling page, digital download route hang off these; order creation **adopts
  the cart's existing reservations** rather than reserving again.

### Provided to Phases 5–6
- **To Phase 5:** the order state machine and the `paid` state to extend with
  `fulfilled/refunded/cancelled`; entitlement rows to re-key onto customer accounts;
  explicit state-transition hook points for exactly-one-email-per-transition. **Phase 5's
  enforced state machine MUST include `expired` (terminal, `release`-on-entry) and the
  `pending → expired` transition Phase 4 ships (§4/§5), or it will reject the very transition
  Phase 4 performs.** `orders.customer_id` is added (nullable) here, forward-only; Phase 5
  populates it — the column lands exactly once.
- **To Phase 6:** the authoritative `order_totals` table (this phase creates it) with the
  `Σ(line)` **stub** as the seam Phase 6 replaces — Phase 6 fills `discount_cents`,
  `shipping_cents`, `tax_cents`, `applied_coupon_code`, `shipping_method_snapshot`,
  `tax_breakdown` and the real `total_cents` into the **same** columns/table, written once at
  creation. See the canonical-schema subsection (§4).

---

## 4. Order model & state machine

### Schema (commerce Postgres; SQLite mirrors it)
`orders`
- `id` (OrderId), `cart_id`, `currency`,
- `state` (enum below), `idempotency_key` **UNIQUE** (order-creation dedupe),
- `hold_expires_at` (checkout hold TTL; drives the **order-level** guarded expiry transition
  in §5 — *not* the Phase-3 reservation sweep),
- `payment_method` (`stripe` | `x402` | null-until-intent),
- `buyer_ref` (email/session claim token — pre-Phase-5 entitlement key),
- `customer_id` **nullable** (Phase-5 hook; added here forward-only, populated by Phase 5 —
  so the column lands exactly once),
- `created_at`, `updated_at`.
- **No money columns on `orders`.** Order totals live only in `order_totals` (below), the
  single authoritative home — see the canonical-schema subsection.

`order_items` — **insert-once, never updated**
- `id`, `order_id`, `product_id`, `sku`,
- **`title` (snapshot)**, **`unit_price_cents` (Cents, snapshot)**, **`currency`
  (snapshot)**, `quantity`, `fulfillment_kind` (`physical` | `digital`),
- `reservation_id` — the adopted Phase-3 reservation for **physical** lines; **NULL for
  digital** (digital never reserves — §6). `fulfillment_kind` is copied from
  `product_commerce` onto the line so settle's commit-vs-grant branch has a stable input.

`payments`
- `id`, `order_id`, `gateway`, `provider_ref` (e.g. Stripe `pi_…`), `amount_cents`,
  `currency`, `status`, `created_at`.

`order_totals` — **1:1 with `orders` (`order_id` PK), written once at order creation, never
rewritten.** This is the **authoritative order-total home for the whole repo (Phases 4–7)**;
`orders` carries no totals. Schema (integer minor units, `Cents`, explicit `currency`):
- `order_id` (PK/FK), `currency`,
- `subtotal_cents`, `discount_cents`, `shipping_cents`, `tax_cents`, `total_cents`,
- `applied_coupon_code` **nullable**, `shipping_method_snapshot` **jsonb nullable**,
  `tax_breakdown` **jsonb nullable**.
- **Phase 4 writes the stub:** `subtotal_cents = total_cents = Σ(unit_price_cents × quantity)`;
  `discount_cents = shipping_cents = tax_cents = 0`; the three nullable columns `NULL`.
- **Phase 6 replaces the *computation* feeding this one write** (real discount/shipping/tax +
  coupon/method/breakdown); the row is still written exactly once at creation and never
  rewritten — the Phase-4 snapshot invariant extended to totals. Phase 6 adds **no new table**;
  it fills columns this migration already creates.

`payment_events` — **webhook/settlement dedupe**
- `dedupe_key` **UNIQUE** (Stripe event id, or x402 receipt id), `order_id`, `gateway`,
  `received_at`. The unique constraint is what makes redelivery a no-op.

`entitlements` — see §6.

> **Snapshot immutability is structural.** Price/title live on `order_items`, not joined
> from `product_commerce` at read time. Product edits touch `product_commerce` only; there
> is no code path from sync to `order_items`. The Phase-4 test edits `product_commerce`,
> re-reads `order_items`, and asserts equality — proving the immutability by construction.

### States & transitions
```
                      pay ok (verified webhook / x402 proof)
   pending ───────────────────────────────────────────────▶ paid
      │  │                                                     │
      │  │ payment_failed webhook                              └─(physical) commit(reservation)
      │  └───────────────────────────────▶ failed                (digital)  grant entitlement
      │                                       │  release(reservation)
      │ hold_expires_at passed (order sweep §5)│
      └───────────────────────────────────────▶ expired  release(reservation)
```
- **`pending`** — created from cart; reservation adopted; payment intent created;
  `hold_expires_at` set (checkout TTL, e.g. 15 min — see §9).
- **`paid`** — terminal-for-Phase-4; commit (physical) / grant (digital) already applied.
- **`failed`** — explicit gateway failure; reservation released.
- **`expired`** — checkout hold TTL passed while unpaid; set by an **order-level guarded
  transition** (`UPDATE orders SET state='expired' WHERE id=:id AND state='pending' AND
  hold_expires_at<=:now RETURNING`), which then `release`s the order's adopted reservations
  (§5). This is a **real `orders`-table transition**, not a reuse of the Phase-3 reservation
  sweep. (`fulfilled/refunded/cancelled` are Phase-5 extensions — not implemented.)
- Only a **verified** confirmation drives `pending → paid`. The buyer's browser redirect is
  **display-only** and never mutates state (see §5 race handling).

### Idempotency of order creation
`createOrderFromCart(cartId, key)` inserts guarded by `orders.idempotency_key` UNIQUE;
replay returns the existing order (no re-snapshot, no second reservation). Snapshots are
taken **once** at creation from the current cart lines (which already carry Phase-3
reserved price context).

### Canonical order schema (authoritative for Phases 5–7)

**This subsection is the single source of truth for order / line / total column names.**
Phases 5, 6, and 7 align to it verbatim; downstream plans must not re-declare or rename these.

- **Money convention (repo-wide): `*_cents` suffix + an explicit `currency` column**, integer
  minor units, backed by the branded `Cents` type (a `number` reaching one is a compile error).
  Chosen over `_minor`/`_amount` because it matches the branded `Cents` type and Phases 6–7 as
  written; Phase 1's `price_amount` and any `_minor` names are corrected to `_cents` in their
  own revisions.
- **`orders`** — no money columns. Keys / state / TTL / identity only: `id`, `cart_id`,
  `currency`, `state`, `idempotency_key` UNIQUE, `hold_expires_at`, `payment_method`,
  `buyer_ref`, `customer_id` (nullable, Phase-5), `created_at`, `updated_at`.
- **`order_items`** (insert-once): `id`, `order_id`, `product_id`, `sku`, `title` (snapshot),
  `unit_price_cents` (snapshot), `currency` (snapshot), `quantity`, `fulfillment_kind`,
  `reservation_id` (physical only; NULL for digital). **Phase 7 reads** `title`,
  `unit_price_cents`, `quantity` from here (snapshot, never a live product join).
- **`order_totals`** (1:1, written once): `order_id` PK, `currency`, `subtotal_cents`,
  `discount_cents`, `shipping_cents`, `tax_cents`, `total_cents`, `applied_coupon_code`,
  `shipping_method_snapshot` jsonb, `tax_breakdown` jsonb.
  - **Phase 4 populates:** `subtotal_cents`, `total_cents` (both `= Σ(unit_price_cents ×
    quantity)`), `currency`; `discount_cents = shipping_cents = tax_cents = 0`; nullable
    columns `NULL`. The domain amount/currency check at settle reads `order_totals.total_cents`.
  - **Phase 6 populates:** `discount_cents`, `shipping_cents`, `tax_cents`,
    `applied_coupon_code`, `shipping_method_snapshot`, `tax_breakdown`, and the real
    `total_cents` — into these **same** columns, still one write at creation (no new table).
  - **Phase 7 reads:** `SUM(total_cents)`, `SUM(discount_cents)`, `SUM(tax_cents)`, … **from
    `order_totals`** (the authoritative post-discount/shipping/tax figure), never from `orders`.
- **`payments`**: `amount_cents`, `currency` (+ `gateway`, `provider_ref`, `status`, …).
- **Canonical create-order endpoint:** `POST /checkout/orders` (§7). Phase 6 **extends this
  exact endpoint** (adds `shippingMethodId` + `couponCode`); it is **not** renamed
  `/checkout/complete`.

---

## 5. `PaymentGateway` port design

### The interface (verbatim proposal)
```ts
// @otta-sh/domain/ports — pure types, NO pg / ctx / fetch
export type PaymentMethod = "stripe" | "x402";

export interface PaymentGateway {
	readonly id: PaymentMethod;

	// Begin payment for an order. Returns the provider next-action the caller
	// surfaces to the buyer: a Stripe client secret, or an x402 challenge descriptor.
	createIntent(input: CreateIntentInput): Promise<PaymentIntentHandle>;

	// Turn a RAW provider confirmation (webhook bytes+headers, or a page-gate proof)
	// into a normalized, cryptographically VERIFIED settlement — or reject it.
	// All secrets / signature crypto live inside the adapter, never in the domain.
	verifyConfirmation(raw: RawConfirmation): Promise<ConfirmationResult>;
}

export interface CreateIntentInput {
	orderId: OrderId;
	amount: Cents;          // branded minor units + carries currency
	currency: Currency;
	idempotencyKey: IdempotencyKey;
}

export interface PaymentIntentHandle {
	gateway: PaymentMethod;
	intentId: string;                 // pi_… (Stripe) or x402 resource id
	clientAction: ClientAction;
}

export type ClientAction =
	| { kind: "stripe_client_secret"; clientSecret: string }
	| { kind: "x402_challenge"; accepts: string[]; price: Cents; payTo: string }
	| { kind: "none" };

export type RawConfirmation =
	| { kind: "webhook"; body: Uint8Array; headers: Record<string, string> }
	| { kind: "page_gate"; proof: X402Proof };

export type ConfirmationResult =
	| {
			ok: true;
			orderId: OrderId;
			providerRef: string;      // pi_… / receipt id — recorded on `payments`
			amount: Cents;
			currency: Currency;
			dedupeKey: string;        // Stripe event id / x402 receipt id → payment_events UNIQUE
	  }
	| { ok: false; reason: "INVALID_SIGNATURE" | "UNKNOWN_EVENT" | "MALFORMED" };
```

### How one interface fits both confirmation models
The port draws the seam at **"raw provider signal → verified normalized settlement."** The
domain use-case `settleOrder(gateway, raw, deps)` is gateway-agnostic:

1. `gateway.verifyConfirmation(raw)` → `ConfirmationResult`. **Rejection** (bad signature,
   unknown/malformed) → typed failure (HTTP 400).
2. **Dedupe** on `dedupeKey` via `payment_events` UNIQUE insert. Duplicate → **no-op
   success** (handles Stripe retries and double delivery).
3. Load order. Already `paid` → **no-op success** (webhook-before-redirect, double
   delivery).
4. **Amount + currency must equal the order-total snapshot** — the domain reads
   `order_totals.total_cents` + `currency` (it holds the order) and checks equality; mismatch →
   reject + record anomaly (§9). Keeps the adapter from needing order state.
5. Transition `pending → paid`; record `payments` row.
6. **Physical:** `InventoryStore.commit(reservationId)`. **Digital:** grant entitlement.

- **Stripe (async):** the webhook receiver hands the raw bytes+headers as
  `{ kind: "webhook" }`. The adapter HMAC-verifies `Stripe-Signature` over the **exact raw
  body** and parses the event.
- **x402 (synchronous page-gate):** the page layer's proof is handed as
  `{ kind: "page_gate" }`. The adapter validates the x402 receipt **server-side** (never
  trusting the plugin's assertion — §6/§9) and normalizes it to the same
  `ConfirmationResult`. Confirmation is a page-render check instead of a webhook, but it
  lands on the identical settle path.

### Webhook verification, replay/idempotency, races
- **Verification** is adapter-side and secret-bearing: Stripe signing secret lives in
  **service env only** (CLAUDE.md). The domain never sees a secret.
- **Replay / Stripe retries:** `payment_events.dedupe_key` UNIQUE makes redelivery a no-op.
  The receiver returns **HTTP 200 after successful dedupe/settle** (so Stripe stops
  retrying) and **400 only on signature failure**. No status-code-as-logic beyond that.
- **Webhook-before-redirect race:** settlement is **webhook-only**; the browser redirect
  success page is **read-only** and *polls* `GET /orders/:id`. If the webhook wins, the page
  loads already-`paid`. If the redirect wins, the page shows "processing" and polls until the
  webhook flips it. The client redirect never settles.

### Adopting the cart's reservations, failure & timeout (the TTL handoff — ties to Phase 3)

**Adopting the cart's reservations (the TTL handoff).** A physical cart line already holds a
Phase-3 reservation in `state='held'` governed by the cart's `expires_at`. If the order merely
copied `reservation_id` and set a *second* TTL, the Phase-3 sweep
(`WHERE state='held' AND expires_at<=:now`) could still reap that hold out from under an
in-flight payment. So order creation performs a **single guarded flip that moves the
reservation out of the Phase-3 sweep's scope** (Clock-driven, `:now = clock.now()`):

**Ordering: the `pending` order row is inserted before any line is adopted.**
`createOrderFromCart` first durably inserts the `orders` row (`state='pending'`,
`hold_expires_at` set) as its own statement, *then* iterates the cart's lines and adopts each
one's reservation via the guarded flip below. This ordering is what makes a partial-adoption
abort self-healing on a multi-line cart: if an earlier line's flip succeeds (`held → adopted`,
`order_id` set) and a later line's flip then returns 0 rows (`RESERVATION_LOST`), the
use-case fails the whole command — but the `orders` row already exists as a real `pending`
order with a real `hold_expires_at`. The earlier line's adopted hold is therefore never
orphaned: it is governed by the same order-level expiry authority as any other pending order
(below), and `expireOrders` flips it to `expired` and `release`s the reservation once
`hold_expires_at` passes, exactly as for an order that fails at checkout for any other reason.
Inserting the order first turns a partial-adoption failure into "a `pending` order that never
gets paid" (a case the sweep already handles), never "an adopted hold with no owning row at
all" (a case nothing would ever release).

```
UPDATE reservations
   SET state='adopted', order_id=:orderId, expires_at=:orderHoldExpiresAt
 WHERE id=:reservationId AND state='held' AND expires_at > :now
RETURNING id, qty;      -- 0 rows ⇒ hold already swept/committed
```

- This introduces a **new, additive reservation state `adopted`** (extends Phase-0's
  `pending|held|committed|released|failed` by one value — the only change Phase 4 makes to the
  `reservations` table, contract-tested like Phase-3's additive `adjust`; it also adds nullable
  `reservations.order_id`). Because Phase-3's sweep is scoped to `state='held'`, an `adopted`
  reservation is **structurally invisible to it** — **no Phase-3 edit is needed**; Phase 4 is
  consistent with Phase-3-as-written *precisely because* the sweep already filters on `held`.
- **0 rows** = the hold was reaped/committed before adoption → order creation fails with a
  typed `RESERVATION_LOST` (buyer re-adds). On a single-line cart nothing is half-created. On a
  **multi-line** cart where an earlier line already flipped to `adopted`, that hold is not
  stranded — per the ordering above, the `pending` order row was persisted before any line was
  adopted, so the earlier line's adopted hold is healed by `expireOrders` like any other
  pending order that never gets paid.
- The flip is **single-statement, guarded, no interactive transaction**, and idempotent under
  replay: a re-run of `createOrderFromCart` with the same `idempotency_key` finds the order
  (or, mid-flight, re-issues the flip and treats an already-`adopted` row for this `order_id`
  as success).
- Governance now belongs **solely** to the order: exactly one TTL (`orders.hold_expires_at`)
  and one expiry authority (the order-level transition below).

**Fencing the cart against the adopted hold (two guards, defense-in-depth).** Adopting a hold
takes it out of the *sweep's* scope, but the cart is still live — a shopper who returns to the
cart page and removes/decrements a line would otherwise call Phase-3's `removeLine`/`adjustLine`
against a reservation the order now owns, `release`-ing or shrinking stock out from under a
pending order → resale → oversell (the paid order's later `commit` would find nothing to
commit). Two coherent guards close this, both in-pattern with Phase 3:

1. **Reservation-state guard (primary, the real fence).** Phase-3's cart-initiated
   reservation writes are scoped to `state='held'` — the same guarded-flip idiom already used
   for expiry. `removeLine`/`adjustLine`'s release/adjust run
   `… WHERE reservation_id=:id AND state='held' RETURNING`; **0 rows ⇒ typed `LINE_CHECKED_OUT`**
   (the hold is `adopted`/`committed`, no longer the cart's to touch), never a blind
   release/decrement. An `adopted` reservation is thus **structurally untouchable** by any cart
   mutation, exactly as it is invisible to the sweep. This is a small explicit change in
   Phase 3 (see that plan's Revision log) — the reservation state, not the cart row, is the
   authority.
2. **Cart-state guard (secondary, for clean UX + belt-and-suspenders).** At successful
   adoption of *all* the order's lines, `createOrderFromCart` flips the cart out of `active`
   with a single guarded write on the new `carts.state` column:

   ```
   UPDATE carts SET state='checked_out' WHERE id=:cartId AND state='active' RETURNING id;
   ```

   Cart mutation use-cases reject a non-`active` cart up front with a typed `CART_CHECKED_OUT`,
   so a post-checkout mutation fails loudly at the cart layer before it ever reaches a
   reservation. (`carts.state` and this rejection are the small Phase-3 change noted in that
   plan's Revision log.) The guard is idempotent under order-creation replay: a re-run finds the
   cart already `checked_out` (0 rows) and treats it as success for the same order.

   **`checked_out` is terminal — no transition ever flips a cart back to `active`.** Recovery
   after a failed or expired checkout (adopted holds already `release`d) is always a **new**
   cart, never a reactivation of this one. This is deliberate, not an oversight: reactivating a
   `checked_out` cart would re-open exactly the fence this guard exists to close, letting a live
   cart mutation reach a reservation an order still (or once) depended on.

**Commit / release act on the adopted reservation.** On `paid` (physical),
`InventoryStore.commit` flips `adopted → committed`; on failure/expiry, `release` flips
`adopted → released` then returns stock. Both are the existing guarded flips with the source
state widened to include `adopted` (additive; `held` still works, so Phase-0's own tests are
unaffected).

**A 0-row `commit` at settle is a loud anomaly, never a silent no-op.** The guards above make
losing an adopted hold impossible on the intended paths, so if settle's
`commit(reservation_id)` matches **0 rows** (the reservation is `released`/absent rather than
`adopted`/`committed`), an invariant has been violated — stock was already resold under a paid
order. The domain must **not** swallow this: it records a `payment_events` anomaly, alerts
(same channel as the amount/currency-mismatch anomaly, §9 Risk 3), and marks the order for
**manual reconciliation / refund** (no auto-refund in v1 — Phase 5+). A 0-row `commit` on an
*already-committed* reservation (idempotent webhook replay of a settle that already committed)
is distinguished by state (`committed`) and remains a benign no-op; only a
`released`/missing reservation is the anomaly.

**Digital lines carry no reservation** (§6): `order_items.reservation_id` is `NULL`, there is
no adoption flip, and settle grants an entitlement instead of committing.

**Explicit payment failure** (`payment_intent.payment_failed`) → guarded `pending → failed`,
then `release` each adopted reservation.

**Timeout — a real `orders`-table guarded transition (not the Phase-3 reservation sweep).**
A dedicated order-expiry use-case `expireOrders(now)` (Clock-driven), run by a self-interval or
the plugin-`cron` → `POST /internal/expire-orders` trigger (mirroring Phase 3's
`/internal/expire-holds`), flips unpaid past-TTL orders **exactly once**:

```
UPDATE orders SET state='expired'
 WHERE id=:orderId AND state='pending' AND hold_expires_at <= :now
RETURNING id;          -- 0 rows ⇒ someone else won (paid/failed/expired)
```

The winner then `release`s each adopted reservation via the same guarded `adopted → released`
flip (0 rows = already committed/released), so stock returns **exactly once**. One release path
(`release`), two triggers (explicit failure, order-expiry) — the Phase-3 reservation sweep is
never involved in order-owned holds.

---

## 6. x402 design

x402 deliberately **breaks the plugin boundary**: the 402 challenge is served by EmDash's
Astro integration at `Astro.locals.x402` on public pages — **not callable inside the
sandboxed plugin** (emdash-platform-notes §x402). So the "adapter" is a **page-level gate +
service-owned entitlements**, and the plugin stays `ctx.http`-only.

### Flow
1. A digital product's PDP/download page is x402-gated at the **Astro page layer** (site
   config, not sandbox code). Unpaid access → **HTTP 402** challenge (`accepts`, `price`,
   `payTo`) built from the order's `x402_challenge` `ClientAction`.
2. Buyer pays; the x402 integration produces a **receipt/proof** at render time.
3. The page (or a plugin **public route** the page calls) forwards the proof to the service
   via `ctx.http`. The service's **x402 adapter verifies the proof server-side** (via the
   x402 facilitator over egress — §9 open), then `settleOrder` runs: `pending → paid` +
   **grant entitlement**.
4. Delivery is **entitlement-gated**: the digital download (plugin public route, or a
   service-issued signed R2 URL) calls the entitlement check and serves the file only if an
   active entitlement exists.

### Entitlement model
`entitlements`
- `id`, `order_id`, `sku`/`product_id`, `buyer_ref` (email/session claim token; Phase-5
  re-keys to customer id), `state` (`active` | `revoked`), `granted_at`,
  `source` (`order_paid` | `x402`), `grant_idempotency_key` **UNIQUE** (grant-once).

- **Grant** — inside `settleOrder` for digital lines (Stripe-paid digital *and* x402);
  UNIQUE key makes the grant idempotent under webhook/proof replay.
- **Check** — `hasEntitlement(buyer_ref | order_id, sku) → active?`; the domain check the
  download route calls. Shared machinery for both digital-via-Stripe and x402 (component-map
  §4: "the entitlement table is shared machinery with x402").
- **Authorization of delivery** — no entitlement ⇒ not purchasable/downloadable; the file
  is never served without an active row.

---

### Digital goods: cart path & x402 composition

**Digital lines never reserve.** v1 digital = unlimited stock → **no `inventory` row, no
`reserve`, no reservation**. The Phase-3 cart branches on `fulfillment_kind` (copied from
`product_commerce`): physical lines call `reserve` and store `reservationId` + `expires_at`;
**digital lines skip `reserve` and store `reservation_id = NULL`, `expires_at = NULL`** — so
the Phase-3 hold-expiry sweep ignores them. Phase 3's `cart_lines` already allows both columns
nullable, so this needs **no Phase-3 schema change** — only the reserve-call branch (owned by
Phase 4, which declares digital semantics; called out for Phase 3).

**Mixed cart checkout.** `createOrderFromCart` iterates lines: physical → adoption flip (§5),
`order_items.reservation_id` set; digital → no flip, `reservation_id = NULL`,
`fulfillment_kind='digital'`. On `paid`, settle branches per line on `fulfillment_kind`:
physical → `commit(reservation_id)`, digital → grant entitlement. A mixed order does **both**,
each idempotent.

**x402 page-gate composition with carts.** Two modes converge on the same order + entitlement
machinery:
1. **Cart-based (default):** digital lines ride the normal cart→order flow (no reservation);
   payment via Stripe *or* x402; on `paid` → entitlement. Carts are unaffected.
2. **Page-gate bypass (single bare resource):** the pure "pay-to-unlock one digital resource"
   x402 page-gate has no cart. At the first `402`, the service **mints a one-line digital order
   server-side** (`subtotal_cents = total_cents = product price`, no reservation) so the x402
   proof settles through the **identical** `settleOrder` → grant-entitlement path. It bypasses
   the cart but never bypasses the order / entitlement / `order_totals` record.

So there is exactly **one** settlement + entitlement path; the cart is optional plumbing in
front of it, and no digital line ever touches inventory.

## 7. New service surface

### REST endpoints (`@otta-sh/service`, 1:1 with the ports — no status-code-as-logic)
- `POST /checkout/orders` — create order from cart. Body `{ cartId }`, `Idempotency-Key`
  header → `IdempotencyKey`. Returns the `Order` + `PaymentIntentHandle` (`createIntent`).
  **Canonical endpoint name** — Phase 6 *extends this exact route* (adds `shippingMethodId` +
  `couponCode`); it is **not** renamed `/checkout/complete`.
- `GET /orders/:id` — read order state (drives the redirect success-page poll).
- `POST /internal/expire-orders` — not public; runs the order-expiry guarded transition (§5),
  releasing adopted reservations of unpaid past-TTL orders. Mirrors Phase-3
  `/internal/expire-holds`; self-interval or plugin-`cron` trigger.
- `POST /webhooks/stripe` — **public**, consumes the **raw body** (no JSON re-parse before
  verification), reads `Stripe-Signature`. Runs `settleOrder(stripeGateway, {kind:"webhook"})`.
  Returns **200 after dedupe/settle**, **400 on bad signature**.
- `POST /entitlements/grant` — service-authenticated; receives an x402 page-gate proof, runs
  `settleOrder(x402Gateway, {kind:"page_gate"})`.
- `GET /entitlements/check?scope=&sku=` — entitlement check for delivery authorization.

### New domain ports + contract-suite extension
- Ports: `PaymentGateway` (§5), `OrderStore` (create/get/transition/snapshot-immutable),
  `EntitlementStore` (grant/check), `PaymentEventStore` (dedupe) — or fold events into
  `OrderStore`. `Clock`/`IdGen` reused.
- Contract suites (run against fakes first, then Postgres/SQLite):
  - `orderStoreContract` — create, get, idempotent replay, **snapshot immutability**, legal
    transitions, illegal transitions rejected.
  - `entitlementStoreContract` — grant-once, check active/absent, revoke.
  - `paymentGatewayContract` — the shared *settlement* behavior (verify→dedupe→settle→commit/
    grant), run against the **fake gateway**, then the **Stripe** and **x402** adapters.

### Secrets handling (CLAUDE.md)
- Stripe **secret key + webhook signing secret** live in **service env only**. Verification
  and intent creation are service-side.
- The **plugin holds no secrets**: it only declares `network:request` + `allowedHosts` to
  reach the service. The Stripe webhook proxy is a **dumb pipe** (cannot verify — no secret).
- x402 `payTo`/config lives at the **EmDash site / page layer**, not in the sandboxed
  plugin. Non-secret store config uses `ctx.kv`; secrets never touch `ctx.kv`.

---

## 8. Ordered red→green steps (TDD)

Domain state machine first (fake gateway), then store, then HTTP + a fake-Stripe webhook
driver, then plugin x402 under the workerd sandbox. Each step: named failing test → minimum
code → green.

**4.1 — Domain types + ports + fakes.** `packages/domain/src/orders/model.ts` (Order,
OrderLine, OrderState), ports (`OrderStore`, `EntitlementStore`, `PaymentGateway`,
`PaymentEventStore`), in-memory fakes in test-utils. *Type test:* a `number` assigned to
`unit_price_cents` fails to compile. ✅ types compile; fakes satisfy the interfaces.

**4.2 — `createOrderFromCart` (fake stores).**
`orders/createOrderFromCart.test.ts`:
- `it("snapshots price+title from cart lines and writes the order_totals stub (Σ line)")`
- `it("adopts a physical line's reservation via the guarded held→adopted flip (out of the Phase-3 sweep's scope)")`
- `it("a digital line reserves nothing: reservation_id is NULL, no adoption flip")`
- `it("a lost/swept hold at adoption time fails creation with RESERVATION_LOST")`
- `it("a multi-line cart aborts on a later line's RESERVATION_LOST after an earlier line was already adopted: the pending order row was durably inserted before any line was adopted, so the earlier line's adopted hold is not stranded and is later released by expireOrders")`
- `it("is idempotent: replay with same key returns the same order, no double snapshot, no re-adopt")`
✅ green against fakes.

**4.3 — `settleOrder` (fake gateway).** `orders/settleOrder.test.ts`:
- `it("verified confirmation flips pending→paid and commits the reservation (physical)")`
- `it("verified confirmation on a digital line grants an entitlement")`
- `it("replayed confirmation with same dedupeKey settles once (no-op on redelivery)")`
- `it("already-paid order + late confirmation is a no-op (webhook-before-redirect)")`
- `it("amount/currency mismatch is rejected and recorded as anomaly")`
- `it("invalid signature confirmation is rejected")`
- `it("payment_failed → failed → releases the reservation")`
- `it("order-expiry guarded transition (pending→expired) releases the adopted reservation exactly once")`
- `it("commit that matches 0 rows because the adopted hold was lost (released) records a payment_events anomaly + flags manual reconciliation — never a silent no-op")`
- `it("commit on an already-committed reservation (idempotent replay) is a benign no-op, not an anomaly")`
✅ green against fakes (drives the whole state machine before any DB or gateway).

**4.4 — Contract suites against fakes.** `orderStoreContract`,
`entitlementStoreContract`, `paymentGatewayContract` authored and green against the
in-memory adapters (proves the suites are real and the port shapes are right).

**4.5 — `store-postgres` adapters (SQLite + Postgres).** Forward-only migration for
`orders` (no money cols), `order_items` (`unit_price_cents`/`title`/`quantity` snapshot cols),
`order_totals` (1:1, `*_cents` breakdown — stub-written in Phase 4), `payments`
(`amount_cents`), `payment_events` (UNIQUE `dedupe_key`), `entitlements` (UNIQUE
`grant_idempotency_key`), plus the additive `reservations.state='adopted'` value + nullable
`reservations.order_id`. Run `orderStoreContract` + `entitlementStoreContract` on **both
dialects**. Explicit:
- `it("editing product_commerce leaves existing order_items unchanged")` — the **snapshot-
  immutability** test at SQL level (edit product row, re-read order line, assert equality).
- `it("held→adopted flip removes the reservation from the Phase-3 held-scoped sweep")` — run
  the Phase-3 sweep after adoption; the adopted hold is untouched.
- `it("order-expiry guarded transition releases the adopted reservation exactly once under a double-sweep race")`.
- `it("a post-checkout cart removeLine/adjustLine cannot release or shrink an adopted hold — returns LINE_CHECKED_OUT, stock and reservation qty unchanged")` — the primary reservation-state fence (§5): create an order from a cart, then drive Phase-3 `removeLine`/`adjustLine` against the now-`adopted` reservation and assert the guarded write matches 0 rows and stock does not return.
- `it("createOrderFromCart flips the cart active→checked_out; a subsequent add/adjust/remove on that cart is rejected CART_CHECKED_OUT")` — the secondary cart-state fence (§5).
- `it("settle commit against a reservation lost to a stray release records the anomaly at SQL level (order flagged, payment_events anomaly row written)")` — the loud-anomaly path end-to-end on real stores.
✅ contract suites green on SQLite and Postgres.

**4.6 — Stripe adapter + fake-Stripe webhook driver.** `payments-stripe/` implements
`PaymentGateway`: `createIntent` → Stripe PaymentIntent (client secret); `verifyConfirmation`
→ HMAC-verify `Stripe-Signature` over raw bytes, parse event. A **fake-Stripe driver**
signs test payloads with the test secret (no network). Run `paymentGatewayContract` against
it, plus:
- `it("rejects a body whose bytes were altered after signing")`
✅ green.

**4.7 — x402 adapter.** `payments-x402/` implements `PaymentGateway`: `createIntent` →
`x402_challenge` descriptor; `verifyConfirmation({kind:"page_gate"})` → validate receipt →
normalized settlement granting an entitlement. Run `paymentGatewayContract`. ✅ green.

**4.8 — Service REST + live-server HTTP contract.** Wire endpoints (§7). HTTP contract test
on a live ephemeral server backed by Postgres, using the fake-Stripe driver to POST a signed
webhook:
- `it("POST /webhooks/stripe with a signed payment_intent.succeeded flips the order to paid")`
- `it("redelivering the same event returns 200 and settles once")`
- `it("bad signature returns 400 and does not settle")`
- `it("GET /orders/:id reflects paid after the webhook (redirect poll)")`
- `it("GET /entitlements/check returns active after a digital order is paid")`
✅ wire ⇄ port fidelity green.

**4.9 — Plugin under the workerd-on-Node sandbox.**
- Public **webhook proxy** route: forwards raw Stripe bytes + `Stripe-Signature` **verbatim**
  (base64-safe through the bridge) to the service via `ctx.http`; holds no secret.
  `it("proxied webhook body still verifies service-side (byte-exact)")`.
- x402 **page-layer** gate + plugin route to grant entitlement + entitlement-verified digital
  download. Sandbox-clean check: `it("plugin egress is ctx.http+allowedHosts only; no secret,
  no DB surface")`. Run under **workerd-on-Node**, not trusted in-process. Once storefront
  e2e exists, drive checkout→paid with **Playwright** and attach a screenshot to the PR.

**4.10 — No-oversell holds through checkout (Postgres-required).**
`it.runIf(pg)("concurrent checkout of the last unit: exactly one order reaches paid+commit")`
— reserve→order→pay commits exactly the reserved units; the loser never got a reservation.
Extends the Phase-0/3 concurrency guarantee across `commit`.

---

## 9. Risks & open questions

1. **Stripe webhook: proxy vs direct-to-service.** Component-map wants a plugin public route
   as inbound receiver; raw-body fidelity through the sandbox bridge (JSON/base64 marshalling)
   risks corrupting bytes → signature failure. **Resolution:** forward the body base64-exact
   and verify service-side; add the byte-exact proxy test (4.9). **Prefer direct-to-service**
   when the service has a public URL; the proxy is the fallback for single-origin merchants.
2. **x402 proof trust.** The service must **not** trust the plugin's word that payment
   happened. **Resolution:** the x402 adapter verifies the receipt server-side (x402
   facilitator call over egress). **Open:** exact x402 proof format and whether independent
   verification is available without the page-layer secret — confirm against `packages/x402`;
   recommend facilitator-verified grants only.
3. **Amount / currency mismatch.** **Resolution:** reject settlement, record a
   `payment_events` anomaly, alert; **no auto-refund in v1** (Phase 5+).
4. **Reservation handoff / TTL double-governance.** Order creation must not leave the adopted
   hold in the Phase-3 sweep's scope. **Resolution:** a single **guarded flip** `held → adopted`
   (set `order_id`, re-point `expires_at` to the order hold) at creation (§5). Because Phase-3's
   sweep is scoped to `state='held'`, `adopted` is invisible to it — **one TTL, one expiry
   authority**. `commit`/`release` widen to accept `adopted`. Additive reservation state +
   nullable `reservations.order_id`; contract-tested. A lost hold at adoption → `RESERVATION_LOST`.
5. **Checkout hold TTL.** Recommend **15 min** (consistent with Phase-3). Order creation sets
   `orders.hold_expires_at`; expiry is a **real `orders`-table guarded transition**
   (`expireOrders(now)`, §5), *not* a reuse of the Phase-3 reservation sweep, then it `release`s
   the adopted holds. Clock-driven; self-interval or plugin-`cron` → `/internal/expire-orders`.
6. **Digital + inventory / cart path.** **Resolution:** v1 digital = unlimited → **never
   reserves**: the Phase-3 cart skips `reserve` for `fulfillment_kind='digital'` (line stores
   `reservation_id = NULL`, `expires_at = NULL`; no Phase-3 schema change). Mixed carts check
   out per-line; settle branches on `fulfillment_kind` (physical→commit, digital→grant). The
   x402 page-gate either settles a cart-created digital order or mints a one-line digital order
   server-side — both converge on the single settle→entitlement path (§6).
7. **Entitlement identity before Phase 5.** **Resolution:** key on `order_id` + `buyer_ref`
   (email/session claim token) now; Phase 5 re-associates to the customer account. Flag the
   dependency in the PR.
8. **`createOrder` idempotency key source.** **Resolution:** client-supplied
   `Idempotency-Key`; fall back to deriving from `cartId` + cart version.

---

## 10. Definition of done (per CLAUDE.md verification policy)

- [ ] `orderStoreContract` + `entitlementStoreContract` **green on SQLite and Postgres**.
- [ ] `paymentGatewayContract` green against the **fake, Stripe, and x402** adapters.
- [ ] Headline tests all green: Stripe webhook → paid + commit; x402 → paid + entitlement;
      **snapshot immutability**; webhook replay settles once; failure/timeout → release.
- [ ] **No-oversell-through-checkout** concurrency test green **on Postgres** (recorded in the
      PR; better-sqlite3 verifies the SQL, not the race).
- [ ] **Reservation TTL handoff** proven: the `held → adopted` guarded flip takes the hold out
      of the Phase-3 sweep; an order-level guarded `pending → expired` transition releases the
      adopted reservation **exactly once** (double-sweep race tested); all TTL math via `Clock`.
- [ ] **Adopted hold fenced from the live cart** proven: a post-checkout cart
      remove/adjust cannot release or shrink an `adopted` reservation (reservation-state guard →
      `LINE_CHECKED_OUT`; cart-state guard → `CART_CHECKED_OUT`), and a `commit` that loses its
      adopted hold surfaces a recorded anomaly + manual-reconciliation flag — never a silent
      no-op (§5).
- [ ] **Digital cart path** proven: a digital line reserves nothing; a mixed order commits
      physical + grants digital; the x402 page-gate settles through the same path.
- [ ] **Canonical schema honored:** totals live only in `order_totals` (`*_cents`), `orders`
      carries no money column, `order_items` uses `unit_price_cents`/`title`/`quantity`; the
      settle amount-check reads `order_totals.total_cents`.
- [ ] HTTP contract test green against a **live server** (webhook receiver + entitlement check
      + order poll) — wire format does not drift from the ports.
- [ ] Plugin exercised under the **workerd-on-Node sandbox** (not trusted in-process); egress
      is `ctx.http` + `allowedHosts` only; **no secret** in the plugin; Playwright screenshot
      attached once storefront e2e exists.
- [ ] `@otta-sh/domain` still imports **nothing with IO** (boundary dep-check green); money is
      integer minor units throughout (type test intact).
- [ ] Stripe secrets in **service env only**; migrations **forward-only**.
- [ ] `pnpm lint` clean, `pnpm typecheck` clean, `pnpm format` applied, **changeset added**
      for every published package changed.
- [ ] PR titles tagged per area (`[Domain]`, `[Adapters]`, `[Service]`, `[Plugin]`,
      `[Test]`); one PR = one thing; no drive-by refactors; **never pushed to `main`**
      (merge is user-gated).

---

## 11. Revision log (plan-review REQUEST CHANGES → resolutions)

Each finding from the two-reviewer plan review and how this revision resolves it.

| # | Finding (reviewer) | Resolution |
| --- | --- | --- |
| 1 | **Reservation TTL double-governance** (A, blocker; A §CP-3) — adopted hold still governed by the Phase-3 sweep. | §5: order creation performs a guarded `held → adopted` flip (sets `order_id`, re-points `expires_at`, Clock-driven, single-statement, `RESERVATION_LOST` on 0 rows). `adopted` is a new additive reservation state; Phase-3's `held`-scoped sweep can never touch it — consistent with Phase-3-as-written with no Phase-3 edit. One TTL, one authority. |
| 2 | **Digital goods have no coherent cart path** (A, blocker; A §CP-4) — cart reserves every line but digital has no reservation. | §6 new subsection: digital lines **never reserve** (`reservation_id`/`expires_at` NULL — fits Phase-3's nullable `cart_lines` with no schema change); mixed carts check out per-line; settle branches on `fulfillment_kind`; x402 page-gate either settles a cart-created digital order or mints a one-line digital order server-side — one settle→entitlement path. |
| 3 | **Order expiry needs a real guarded `orders` transition** (B, should-fix) — "reuse the Phase-3 sweep" underspecified. | §4/§5: explicit `expireOrders(now)` guarded flip `UPDATE orders SET state='expired' WHERE state='pending' AND hold_expires_at<=:now RETURNING`, then `release` adopted holds exactly once. New `POST /internal/expire-orders` (§7), step 4.3/4.5 tests, DoD gate. |
| 4 | **Canonical order-money schema** (A §CP-1/§CP-2; B C1, blocker) — three names/homes for the order total. | New **"Canonical order schema (authoritative for Phases 5–7)"** subsection (§4). Repo-wide `*_cents` + explicit `currency`. `order_totals` (created here) is the sole authoritative totals home; `orders` carries no money column. States exactly which columns Phase 4 stubs, Phase 6 populates, Phase 7 reads. Renamed `unit_price_minor`→`unit_price_cents`, `amount_minor`→`amount_cents`; dropped `orders.subtotal_minor`/`total_minor`. |
| 5a | **`expired` must be a legal Phase-5 transition** (B P4.2, should-fix). | §3 "Provided to Phase 5" now requires Phase 5's state machine to include `expired` (terminal, release-on-entry) + `pending → expired`. |
| 5b | **Endpoint name drift** `/checkout/orders` vs `/checkout/complete` (B C3). | §4 canonical subsection + §7: `POST /checkout/orders` is canonical; Phase 6 extends this exact route. |
| 5c | **`orders.customer_id` provenance** (B P5.3, nit). | Column added (nullable) here forward-only, populated by Phase 5 — lands exactly once (§4). |
| 5d | **x402 proof trust** (A §3, should-fix). | Retained as Risk 2 (already correct): facilitator-verified server-side grants only; confirm proof format against `packages/x402`. |

**Round 2 (re-review):**

| # | Finding (reviewer) | Resolution |
| --- | --- | --- |
| R2-1 | **Post-adoption cart mutations can free a pending order's adopted hold → oversell** (B New-1, blocker) — closing the sweep seam left the cart-mutation seam open: Phase-3 `removeLine`/`adjustLine` call the widened `release`/`adjust` with no state guard, so a shopper returning to the live cart could release an `adopted` hold, stock resells, and the paid order's later `commit` silently no-ops. | §5 gained the **"Fencing the cart against the adopted hold"** subsection with two in-pattern guards: (1) **primary** — Phase-3 cart-initiated release/adjust is scoped `WHERE state='held'` (guarded-flip idiom, typed `LINE_CHECKED_OUT` on 0 rows) so an `adopted` hold is structurally untouchable; (2) **secondary** — `createOrderFromCart` flips the new `carts.state` `active→checked_out` at adoption (guarded write), and cart mutations reject a non-`active` cart with `CART_CHECKED_OUT`. A **0-row `commit` at settle is now a loud anomaly** (recorded `payment_events` anomaly + alert + manual-reconciliation/refund flag), distinguished from the benign already-`committed` replay no-op. New tests in 4.3 (anomaly, benign replay) and 4.5 (post-checkout mutation blocked at reservation + cart level; anomaly at SQL level) + DoD gate. The two small Phase-3 changes (`carts.state`; release/adjust scoped by reservation state) are marked in Phase 3's Revision log. |

**Round 3 (final focused pass):**

| # | Finding (reviewer) | Resolution |
| --- | --- | --- |
| R3-1 | **Partial adoption on a multi-line cart can strand stock** (A, should-fix) — if a later line hits `RESERVATION_LOST` after earlier lines were already adopted, the cart-fence guards correctly block cart-side release of those adopted holds, but no sweep covered an order that was never persisted, orphaning the earlier holds. | §5: `createOrderFromCart` now durably inserts the `pending` order row (`hold_expires_at` set) **before** adopting any line's reservation, so an aborted partial adoption is healed by the existing `expireOrders` sweep (the adopted holds point at a real pending order that will expire and release them). New named test in §8 step 4.2. |
| R3-2 | **`checked_out` has no return transition** (A, nit) — worth stating explicitly so no one later adds an unguarded re-open. | §5 cart-state guard now states `checked_out` is terminal and why (reactivation would re-open the adopted-hold fence); mirrored in Phase 3's Revision log. |

**Considered and not changed:** the verified-webhook-only settlement, structural snapshot
immutability, `payment_events` dedupe, single `PaymentGateway` seam, and the domain amount/
currency check were all endorsed by both reviewers and are kept as-is (the amount check now
just reads `order_totals.total_cents`). No finding was rejected.
