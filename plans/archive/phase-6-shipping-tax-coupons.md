# Phase 6 — Shipping / Tax / Coupons: Implementation Plan

_Author: principal-engineer planning pass. Status: proposed. Scope: replaces the Phase 4
checkout-totals stub (naive sum of snapshot line prices) with a real totals pipeline built
from three pure rules engines behind ports, per `adr/0002-adapter-based-split.md`._

Sources read: `CLAUDE.md`, `DEVELOPMENT.md`, `README.md`, `adr/0002-adapter-based-split.md`,
`draft-plans/implementation-plan.md`, `draft-plans/adapter-architecture.md`,
`draft-plans/component-map.md`, `draft-plans/design-decisions.md`.

---

## 1. Goal & headline test

**Goal.** Given a cart of price-snapshotted line items, a shipping zone/method selection,
each line's tax class, and an optional coupon code, checkout totals compute
**deterministically, in integer minor units (`Cents`)**, with zero float ever touching a
money field. This replaces the Phase 4 stub (`total = Σ line.snapshotPrice × qty`) with a
pipeline: subtotal → discount → shipping → tax → grand total.

**Headline test (the one from the Phases table):**

> Given zone/method/rate + tax class + coupon, checkout totals compute deterministically in
> integer minor units, with a property test proving no float drift.

### Exact behavioral cases (examples, written before code)

1. No coupon, no tax, flat shipping: `total == subtotal + shipping`.
2. Fixed-amount coupon `$5.00` off a `$12.99` subtotal → discount `500`, capped so
   `discount ≤ subtotal` (e.g. subtotal `300` → discount `300`, not `500`).
3. Percentage coupon `10%` with a `$20.00` cap on a `$500.00` subtotal → discount
   `min(round(subtotal × 1000bps / 10000), capCents)` = `2000`, not `5000`.
4. Tax class "standard" at `7.25%` (`725` basis points) in the buyer's zone, applied to the
   **discounted** line amount, rounded half-up per line.
5. Shipping fee is itself taxable in a zone flagged `shippingTaxable: true` → an additional
   shipping-tax line, using the zone's shipping tax class.
6. Replaying the same checkout `idempotencyKey` (crash/retry) yields the **same** totals
   breakdown and does **not** double-redeem the coupon or double-charge tax.
7. A coupon at `maxUses` returns `COUPON_EXHAUSTED` deterministically; concurrent attempts
   at the boundary never over-redeem (mirrors the no-oversell contract — see §5).
8. Editing a tax rate or shipping rate **after** an order exists never changes that order's
   stored breakdown (extends the Phase 4 order-immutability invariant to totals).

### Property test design

New package/dev-dependency: **`fast-check`**, added to the `catalog:` pins (not present
before Phase 6 — flag in the changeset). Runs inside `@otta-sh/domain`'s vitest suite via
`fc.assert(fc.property(...))`.

**Generators (arbitraries):**

- `currency: fc.constantFrom("USD", "EUR", "INR", ...)` — one currency per test run, held
  fixed across the whole generated cart (see currency-consistency invariant below).
- `lineItem: fc.record({ unitPriceCents: fc.integer({ min: 0, max: 100_000_00 }), qty:
  fc.integer({ min: 1, max: 20 }), taxClassId: fc.constantFrom("standard", "reduced",
  "zero", "digital") })`, `lines: fc.array(lineItem, { minLength: 1, maxLength: 20 })`.
- `taxRateBps: fc.integer({ min: 0, max: 10_000 })` per tax class (0%–100%, integer basis
  points — never a float rate).
- `shippingFeeCents: fc.integer({ min: 0, max: 50_000_00 })`, `shippingTaxable:
  fc.boolean()`.
- `coupon: fc.option(fc.oneof(` `fc.record({ type: fc.constant("fixed_amount"),
  amountCents: fc.integer({ min: 0, max: 100_000_00 }) }),` `fc.record({ type:
  fc.constant("percentage"), bps: fc.integer({ min: 0, max: 10_000 }), capCents:
  fc.option(fc.integer({ min: 0, max: 100_000_00 })) })` `))`.

**Invariants asserted on every generated input (the actual property, not example-based):**

- **Sum-of-parts:** `subtotal - discount + shipping + tax === grandTotal` — checked against
  the *returned* breakdown fields, not recomputed independently, so an implementation that
  satisfies the identity by construction (not by rounding luck) is what's being tested.
- **Non-negative totals:** every field (`subtotal`, `discount`, `shipping`, `tax`,
  `grandTotal`) is a non-negative safe integer (`Number.isSafeInteger` and `>= 0`).
- **Discount bounds:** `0 <= discount <= subtotal` always (never discounts past zero,
  never exceeds the cap for percentage coupons).
- **Currency consistency:** the breakdown's `currency` equals the single input `currency`;
  constructing a cart with mixed-currency lines is a **type-level** impossibility (each
  line and the coupon share one branded `Currency`), so the property test itself cannot
  generate a mixed-currency case — that's the point (illegal states unrepresentable).
- **No float drift:** every intermediate (`allocateCents`, `computeLineTax`,
  `computeCouponDiscount`) returns `Cents` (an integer-branded type); a fast-check
  post-condition additionally re-runs `computeTotals` twice on the same input and asserts
  **bit-identical** output (determinism — no `Date.now()`/`Math.random()` leaking into
  money math).
- **Allocation exactness:** `Σ allocateCents(total, weights) === total` for arbitrary
  `total` and `weights` (the pro-rata discount-across-lines helper, §4) — its own focused
  property test, since it's the one place rounding remainders are reconciled.

Example-based (golden) tests pin 3–4 hand-computed WooCommerce-style cases for regression
readability alongside the property tests — properties catch drift, golden cases catch "the
math itself is wrong from day one."

---

## 2. Scope

### In (v1)

- **Shipping:** zone → method → flat rate. Methods: `flat_rate`, `free_shipping` (with an
  optional minimum-subtotal threshold). One method selected per checkout.
- **Tax:** tax classes (e.g. `standard`, `reduced`, `zero`, `digital`) × zone → a single
  flat rate in basis points. Optional "shipping is taxable" flag per zone. No compounding,
  no priority stacking, no VAT-inclusive display pricing.
- **Coupons — minimal v1 set (recommended):**
  - `fixed_amount` — off the cart subtotal, currency-matched, clamped at subtotal.
  - `percentage` — off the cart subtotal, with an optional `maxDiscountCents` cap.
  - Shared constraints on both: `minSubtotalCents`, `startsAt`/`expiresAt`, `maxUses`
    (global), `maxUsesPerCustomer` (optional, only if a customer id is present — Phase 5
    dependency, degrade gracefully to global-only if absent).
  - **One coupon per order.** No stacking.
- Rules engines are **pure functions in `@otta-sh/domain`** — config/data in, `Cents` totals
  out. IO (loading zones/rates/coupons) stays in stores, called by the checkout use-case
  *before* the pure engine runs.
- Order snapshots the full totals breakdown immutably (extends Phase 4's snapshot
  invariant from "price + title" to "price + title + totals breakdown").

### Out (deferred, explicitly not v1)

- **Third-party tax providers** (TaxJar, Avalara, stripe tax) — behind a port so a
  provider adapter is a drop-in later (§8 draft-ADR). Built-in engine is not
  compliance-grade (no nexus tracking, no VAT MOSS, no marketplace-facilitator rules).
- **Real-time carrier rates** (UPS/FedEx/USPS live quotes) — same port-based deferral.
- **Free-shipping coupon type** and **coupon stacking / tiered / BOGO coupons** — v1 is
  fixed-amount + percentage-with-cap only, matching the "minimal set" instruction.
- **Per-line discounts** (only cart-level discount in v1 — no "buy X get Y off").
- **Tax-inclusive pricing** (prices shown with tax baked in) — v1 is tax-exclusive,
  computed at checkout.
- **Variations** — already deferred repo-wide (design-decisions.md §6); rules engines
  don't need to know about them.
- **Multi-currency carts** — one currency per checkout (existing Phase 0–4 assumption).

---

## 3. Dependencies

### Reused from Phases 0–5

- `Cents`, `Currency`, `IdempotencyKey` branded types and the "a `number` reaching a money
  field is a type error" discipline (Phase 0.2).
- The **contract-suite pattern** (`xStoreContract(makeStore, { dialect })`) and dual-dialect
  (SQLite/Postgres) test wrapper (Phase 0.3–0.4) — reused verbatim for the three new
  stores.
- The **atomic single-statement conditional-UPDATE** pattern from `InventoryStore.reserve`
  (Phase 0.4–0.5) — reused for coupon redemption (§5).
- Phase 3's cart line items (qty, sku, snapshot unit price) as the input to the pipeline.
- Phase 4's order/order-item schema and its **price-snapshot invariant**, plus its
  **canonical order schema** (§4 of the Phase-4 plan): `orders` carries **no money column**;
  `order_totals` (keyed `order_id`) is the **sole** totals home, created by Phase 4's
  migration and populated there with a stub (`subtotal_cents = total_cents = Σ line`,
  `discount_cents = shipping_cents = tax_cents = 0`, nullable columns `NULL`). This phase
  adds a sibling invariant (totals-breakdown snapshot) and **replaces the stub values**
  already sitting in `order_totals`'s existing columns, inside the Phase 4 checkout
  use-case; it does not touch payment/webhook code, and adds **no new table or column** for
  totals.
- Phase 5's customer id (optional) for `maxUsesPerCustomer` — soft dependency, not blocking.
- `@otta-sh/service`'s "REST mirrors ports 1:1" rule and live-server HTTP contract test
  pattern.

### Provided to Phase 7 (reports/settings)

Per the Phase-4 **"Canonical order schema (authoritative for Phases 5–7)"** subsection,
`order_totals` is the **sole** authoritative home for order totals — `orders` carries no
money column at all, so there is no second place a fresh engineer could mistakenly read
from. Phase 4 populates `order_totals` with a stub at order creation; this phase
**overwrites those same columns, in the same row**, with the real computed breakdown:
`currency`, `subtotal_cents`, `discount_cents`, `shipping_cents`, `tax_cents`,
`total_cents`, `applied_coupon_code`, `shipping_method_snapshot` (jsonb), `tax_breakdown`
(jsonb — carrying tax lines by class and the shipping-tax line, i.e. the per-line detail
that doesn't have its own `order_items` column). No new table, no new column, no
ambiguity: Phase 7's reporting queries `SUM(...)` **off `order_totals` only**, never off
`orders`.

---

## 4. Totals pipeline design

### Ordering (recommended, with justification)

```
1. line subtotal      = unitPriceCents × qty                         (per line, snapshot)
2. cart subtotal       = Σ line subtotal
3. discount            = computeCouponDiscount(cart subtotal, coupon)  clamped [0, subtotal]
4. discounted lines    = allocateCents(cart subtotal − discount, weights = line subtotals)
                         (pro-rata, largest-remainder — see below)
5. shipping fee        = resolveShippingRate(zone, method, cart subtotal − discount)
                         (free-shipping threshold checked against the DISCOUNTED subtotal)
6. per-line tax        = Σ computeLineTax(discounted line amount, rate[taxClassId, zone])
7. shipping tax        = computeLineTax(shipping fee, rate[shippingTaxClass, zone])
                         IF zone.shippingTaxable ELSE 0
8. tax total            = per-line tax + shipping tax
9. grand total          = (cart subtotal − discount) + shipping fee + tax total
```

**Why discount before tax:** taxing the pre-discount amount overcharges tax relative to
what the buyer actually pays — standard practice (WooCommerce, Shopify) and the only choice
consistent with "tax is computed on money that actually changes hands."

**Why shipping is computed independently of the tax-on-discount step, but *after*
discount for its own free-shipping threshold:** shipping is not itself discounted by a
cart-level coupon in v1 (no free-shipping coupon type), but a merchant's free-shipping
*method* threshold should reflect what the customer is actually spending, so it's evaluated
against the discounted subtotal. This is called out explicitly because it's a genuine
judgment call — flagged again in §8 as one to revisit if a free-shipping coupon type is
added later (its threshold-vs-discount interaction would need its own rule).

**Why pro-rate the discount across lines at all**, given tax is computed per tax-class
line: because different lines can carry different tax classes (e.g. one `zero`-rated
digital item and one `standard`-rated physical item in the same cart with a $5 cart-wide
coupon) — the discount must be allocated to the lines it reduces the taxable base of,
line-by-line, or the per-class tax total is wrong. This is exactly why `allocateCents` is a
separately-named, separately-tested pure function rather than an inline calculation.

**`allocateCents(total: Cents, weights: number[]): Cents[]`** — largest-remainder
apportionment: give each bucket `floor(total × weight / Σweights)`, then distribute the
`total − Σfloor(...)` leftover cents one-by-one to the buckets with the largest fractional
remainder (ties broken by input order, for determinism). Guarantees `Σ result === total`
exactly, always, for any integer `total ≥ 0` and any non-negative integer weights — this is
the mechanism that makes the sum-of-parts invariant hold *by construction* rather than by
hoping rounding cancels out.

### Rounding strategy — recommendation

- **Unit:** integer minor units throughout; rates as **integer basis points** (`bps`,
  0–10000+ meaning 0%–100%+), never a float percentage. `Cents × bps` computed as
  `(cents * bps)` (safe-integer range for realistic cart sizes) then divided with an
  explicit rounding function — never native `/` left un-rounded, never `toFixed`.
- **Granularity: per-line, not per-cart-total.** Tax is computed once per (line ×
  tax-class-rate) and once for shipping, each rounded independently, then summed. This
  matches WooCommaerce's default ("round tax at subtotal level" is the non-default
  WooCommerce option) and keeps each line individually auditable on an invoice.
- **Rounding rule: half-up (round-half-away-from-zero), not banker's rounding.** Tax
  authorities and merchants overwhelmingly expect classic half-up rounding on customer-
  facing amounts; banker's rounding (round-half-to-even) exists to avoid *statistical* bias
  over many aggregated float operations, which is not the concern here — the concern is
  matching what a human expects on a receipt. Implement as pure integer math: `divRoundHalfUp(numerator, denominator) = floor((numerator + denominator/2) / denominator)`
  for positive numerators (money is never negative pre-rounding here).
- **Discount allocation** uses largest-remainder (§ above) rather than rounding, since it
  must hit an exact target sum, not just "round each share reasonably."

### Pure-function shape in `@otta-sh/domain`

```ts
// @otta-sh/domain/pricing — IO-free, no store imports
interface TotalsInput {
  currency: Currency;
  lines: ReadonlyArray<{ unitPriceCents: Cents; qty: number; taxClassId: string }>;
  coupon?: Coupon; // already validated/loaded (dates, min-subtotal) — pure data
  shipping: { zoneId: string; methodId: string };
  rules: RulesSnapshot; // shipping rates, tax rates, all already fetched — no IO here
}
interface TotalsBreakdown {
  currency: Currency;
  subtotalCents: Cents;
  discountCents: Cents;
  shippingCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  lineBreakdown: ReadonlyArray<{ discountedCents: Cents; taxCents: Cents }>;
  shippingTaxCents: Cents;
  appliedCouponCode?: string;
}
function computeTotals(input: TotalsInput): TotalsBreakdown; // pure, deterministic
```

`RulesSnapshot` is plain data (arrays/records), fetched by the checkout use-case via the
store ports *before* calling `computeTotals` — the engine itself never touches a store,
clock, or network call, matching the domain-purity rule.

---

## 5. Rules data model

All three schemas are forward-only migrations added to the existing commerce Postgres
schema (Phase 0's dialect-agnostic Kysely pattern — SQLite locally, Postgres in CI).

### Shipping

```
shipping_zones      (id, name, regions jsonb)            -- country/state/postal match list
shipping_methods    (id, zone_id, name, type)            -- type: 'flat_rate' | 'free_shipping'
shipping_rates      (method_id, currency, amount_cents,
                      min_subtotal_cents nullable)        -- threshold for free_shipping
```

### Tax

```
tax_classes  (id, name)                                   -- 'standard' | 'reduced' | 'zero' | ...
tax_rates    (id, tax_class_id, zone_id, rate_bps,
              applies_to_shipping boolean)
```

### Coupons

```
coupons              (id, code UNIQUE, type, amount_cents nullable,
                       rate_bps nullable, cap_cents nullable,
                       currency, min_subtotal_cents nullable,
                       starts_at nullable, expires_at nullable,
                       max_uses nullable, max_uses_per_customer nullable,
                       uses_count integer default 0)
coupon_redemptions   (id, coupon_id, order_id, customer_id nullable,
                       idempotency_key, UNIQUE(coupon_id, idempotency_key))
```

### Concurrency: coupon max-uses is the same shape as inventory

Redemption is the atomic op, single statement, guarded by the idempotency key, exactly
mirroring `InventoryStore.reserve`:

```sql
UPDATE coupons SET uses_count = uses_count + 1
 WHERE id = :id AND (max_uses IS NULL OR uses_count < max_uses)
RETURNING uses_count;
-- 0 rows returned = COUPON_EXHAUSTED. No lock, no oversell-equivalent ("over-redeem").
```

paired with an `INSERT INTO coupon_redemptions (..., idempotency_key) ON CONFLICT DO
NOTHING`-guarded record (or a plain insert against the `UNIQUE(coupon_id,
idempotency_key)` constraint, mirroring the reservations table) so a replay of the same
checkout idempotency key is a no-op re-read, not a second decrement.

**Lifecycle mirrors reserve/commit/release, with the release trigger now decided** (both
reviewers should-fixed this as a genuinely open design question in the prior draft — it is
resolved here, not deferred to §8): redeem at order-creation time (like `reserve`), a
completed/paid order leaves it redeemed (like `commit` — no explicit action needed since
`uses_count` already incremented). Release is **two-layered**, mirroring how Phase 3
handles the equivalent inventory-hold problem:

1. **Synchronous path (the common case).** The checkout use-case wraps redemption + order
   creation in one call; if order creation throws *after* `redeem()` succeeded, the same
   use-case catches it and calls `releaseCoupon(redemptionId)` before propagating the
   error. No process boundary is crossed, so this is a plain catch-and-release, not a saga.
2. **Crash-recovery path (process dies mid-request, between `redeem()` and the order
   becoming durable).** A reconciliation cron — the same pattern as Phase 3's reservation
   sweep — scans `coupon_redemptions` rows older than a fixed grace period (recommend
   matching the checkout hold window, e.g. 15 min) that have **no corresponding durable
   `orders` row** for their `order_id`, and releases them. This is a **required** contract
   case (see §7 step 9), not an aside.

`releaseCoupon(redemptionId)` decrements `uses_count` and deletes the redemption row,
guarded by the same idempotency discipline as `redeem`: releasing an already-released or
never-redeemed id is a no-op, not an error.

**No-over-redeem contract test** (mirrors Phase 0.5 exactly): seed `max_uses = M`, fire `N`
concurrent `redeem()` calls (`N > M`) on independent connections, assert exactly `M`
succeed and `uses_count === M` — **Postgres-required**, same reasoning as inventory
(`better-sqlite3` serializes writes in-process and cannot exercise the race).

---

## 6. New service surface

### Ports (in `@otta-sh/domain/ports`)

- `ShippingRulesStore` — `listZones`, `listMethods(zoneId)`, `getRate(methodId, currency)`.
- `TaxRulesStore` — `getRate(taxClassId, zoneId)`.
- `CouponStore` — `findByCode(code)`, `redeem(couponId, orderId, idempotencyKey)`,
  `release(redemptionId)`.

Each gets its own contract-test suite (`shippingRulesStoreContract`,
`taxRulesStoreContract`, `couponStoreContract`), run against the in-memory fake first, then
SQLite, then Postgres — same pattern as `inventoryStoreContract`.

### REST endpoints (mirror the ports 1:1, per `adapter-architecture.md` §2 rule 2)

Admin/config CRUD (no bespoke semantics beyond the store's methods):

```
POST/GET/PATCH  /admin/shipping/zones
POST/GET/PATCH  /admin/shipping/zones/:id/methods
POST/GET/PATCH  /admin/shipping/methods/:id/rates
POST/GET/PATCH  /admin/tax/classes
POST/GET/PATCH  /admin/tax/rates
POST/GET/PATCH  /admin/coupons
```

Checkout-facing:

```
POST /checkout/quote      -- pure preview: cart + zone/method + coupon code -> TotalsBreakdown
                             (does NOT redeem the coupon; read-only, safe to call repeatedly)
POST /checkout/orders     -- (Phase 4's canonical create-order endpoint, extended here) now
                             also accepts shippingMethodId + couponCode, redeems the coupon
                             atomically alongside order creation (same idempotency key
                             covers both), and persists the full breakdown into the
                             already-existing `order_totals` row. NOT renamed
                             `/checkout/complete` — see the Phase-4 canonical schema note.
```

`/checkout/quote` matters because it lets the storefront show live totals before the buyer
commits — and it is the natural home for the HTTP contract test that asserts wire ⇄ port
fidelity for `computeTotals` without mutating any state.

### Order snapshot storage

`order_totals` is **not created by this phase.** Per the Phase-4 canonical schema, Phase
4's migration already creates this 1:1 table (keyed `order_id`) and populates a stub row
at order creation (`subtotal_cents = total_cents = Σ line`, `discount_cents =
shipping_cents = tax_cents = 0`, nullable columns `NULL`). `orders` itself carries **no
money column** — nothing there needs extending either.

```
order_totals (order_id, currency, subtotal_cents, discount_cents, shipping_cents,
              tax_cents, total_cents, applied_coupon_code nullable,
              shipping_method_snapshot jsonb, tax_breakdown jsonb)
```

This phase adds **no migration** for `order_totals`. It writes the full computed
`TotalsBreakdown` into these same columns, in the same row, as part of the same
order-creation write Phase 4 already performs — a richer computation feeding an existing
write path, not a second write. Written **once**; never recomputed or rewritten by later
rate/coupon edits. This is the direct extension of Phase 4's "orders snapshot price +
title at purchase time" invariant, now covering the totals breakdown too.

---

## 7. Ordered red→green steps

Pure engine tests first (fast, no IO, property-based) → store contract tests (SQLite, then
Postgres) → coupon concurrency (Postgres-required) → service/HTTP contract → checkout
integration replacing the Phase 4 stub. Each step names its test file/name before any code,
per `DEVELOPMENT.md` §1.

1. **`packages/domain/src/pricing/allocate.test.ts`**
   - `"allocateCents: sum of allocated buckets equals total, for arbitrary total and weights"`
     (property test).
   - `"allocateCents: assigns remainder cents to largest-remainder buckets, ties broken by input order"` (example test, e.g. `allocateCents(100, [1,1,1]) → [34,33,33]`).
   - ✅ green when both pass. Write `allocateCents` only after the property test is red.

2. **`packages/domain/src/pricing/tax.test.ts`**
   - `"computeLineTax: rounds half-up on arbitrary cents and basis-point rate"` (property:
     result is a non-negative safe integer, `computeLineTax(0, anyRate) === 0`,
     `computeLineTax(anyAmount, 0) === 0`).
   - `"computeLineTax: known example — 999 cents at 725bps rounds to 72"` (golden case).

3. **`packages/domain/src/pricing/coupon.test.ts`**
   - `"computeCouponDiscount: fixed_amount clamps at subtotal"`.
   - `"computeCouponDiscount: percentage applies bps to subtotal, capped by maxDiscountCents"`.
   - `"computeCouponDiscount: discount is always within [0, subtotal]"` (property test).

4. **`packages/domain/src/pricing/shipping.test.ts`**
   - `"resolveShippingRate: flat_rate returns the configured rate for the zone/method"`.
   - `"resolveShippingRate: free_shipping returns 0 once discounted subtotal meets minSubtotalCents, else falls back / errors"`.

5. **`packages/domain/src/checkout/computeTotals.test.ts`**
   - `"computeTotals: sum-of-parts identity holds for arbitrary carts, coupons, shipping, tax rates"` (the headline property test — assembles §1's generators).
   - `"computeTotals: all breakdown fields are non-negative safe integers"` (property).
   - `"computeTotals: calling twice on the same input is bit-identical"` (determinism property).
   - `"computeTotals: known WooCommerce-style worked example"` (2–3 golden cases).
   - ✅ green when `computeTotals` composes steps 1–4 correctly; this is the headline test
     from the Phases table.

6. **Contract suites (IO, still against fakes first):**
   - `shippingRulesStoreContract`, `taxRulesStoreContract`, `couponStoreContract` — each
     passes against an in-memory fake first (proves the port shape), matching Phase 0.3.

7. **`packages/store-postgres` — dual-dialect:**
   - Migrations for the six new tables (§5).
   - Run all three contract suites against SQLite and Postgres via the
     `describeEachDialect`-style wrapper.
   - `couponStoreContract` includes: `"redeem replayed with the same idempotencyKey returns the same redemption and increments uses_count once"` (mirrors inventory's replay test);
     `"releaseCoupon decrements uses_count and deletes the redemption row"`; `"releaseCoupon on an already-released or never-redeemed id is a no-op, not an error"`.
   - ✅ green when all three suites pass on both dialects.

8. **`packages/store-postgres/test/coupon-no-over-redeem.pg.test.ts`** (Postgres-required,
   named/tagged as such per DEVELOPMENT.md §2):
   - `"fires N concurrent redeem() at maxUses M (M<N); exactly M succeed, uses_count === M"`.
   - ✅ green when it passes repeatedly on Postgres — this is Phase 6's analogue of the
     Phase 0.5 gate.

9. **`packages/domain/src/checkout/couponRelease.test.ts` and
   `packages/store-postgres/test/coupon-reconciliation.test.ts`** — the release-on-failure
   design decided in §5 (was an open question in the prior draft; now a required contract
   case per both reviewers):
   - `"releaseCoupon is called and succeeds after a simulated order-creation failure
     following a successful redeem"` (synchronous path).
   - `"the reconciliation sweep releases a redemption whose order never became durable
     within the grace window, and leaves alone a redemption whose order does exist"`
     (crash-recovery path, mirrors Phase 3's reservation-sweep test).
   - ✅ green when both paths are covered on SQLite and Postgres.

10. **`packages/service` — HTTP contract:**
    - `POST /checkout/quote` against a live test server, same behavioral cases as step 5,
      asserting wire ⇄ port fidelity (no status-code-as-logic).
    - Admin CRUD endpoints get a thin pass/fail contract test each (they're 1:1 store
      reflections, not novel logic).

11. **Checkout integration — replace the Phase 4 stub:**
    - `packages/domain/src/checkout/checkout.test.ts` — extend Phase 4's suite:
      `"checkout total reflects coupon/shipping/tax, not a naive sum of snapshot line prices"`.
    - `"order_totals is written once at order creation and is unchanged by later edits to tax rates, shipping rates, or the coupon"` (extends the Phase 4 price-snapshot invariant).
    - `"coupon redemption and inventory reservation both happen atomically as part of the same checkout idempotency key; a replay does not double-redeem or double-reserve"`.
    - ✅ green when checkout no longer calls the Phase 4 stub sum anywhere (grep-check as
      part of PR review) and the full pipeline is wired end-to-end against Postgres.

---

## 8. Risks & open questions

| # | Question | Recommendation |
| --- | --- | --- |
| 1 | **Tax: built-in engine vs external provider** (TaxJar/Avalara). | **Draft-ADR: built-in flat-rate engine for v1**, strictly behind a `TaxRulesStore`/`computeTotals` port boundary so a provider adapter (calling out via the existing `network:request`/`allowedHosts` egress pattern) is a future adapter swap, not a rewrite — mirrors ADR-0002's storage/transport seam philosophy. Explicitly **not** compliance-grade (no nexus determination, no nexus tracking, no nexus thresholds, no nexus-by-state remittance); document this limitation in the ADR so it isn't mistaken for a finished tax feature. |
| 2 | **Shipping: built-in flat zones vs real-time carrier rates.** | Same shape: built-in flat-rate for v1 behind `ShippingRulesStore`; a `CarrierRateShippingEngine` (UPS/FedEx/EasyPost) implements the same port later. Recommend filing both as one combined draft-ADR ("built-in rules engines now, provider adapters later") since the port-based reasoning is identical for tax and shipping. |
| 3 | **Discount proration correctness under mixed tax classes.** | Addressed by design (§4's `allocateCents`), not left open — but flag as a risk area for review since it's the single trickiest piece of arithmetic in the phase; extra golden-case coverage recommended (e.g. a cart with a `zero`-rated and a `standard`-rated line plus a coupon). |
| 4 | **Rounding: half-up vs banker's.** | Recommend **half-up**, reasoning in §4. Flag as reversible if a specific tax jurisdiction later requires banker's rounding — keep `divRoundHalfUp` as a single named function so swapping the strategy is a one-function change, not a scattered refactor. |
| 5 | **Free-shipping threshold: checked pre- or post-coupon-discount?** | Recommend **post-discount** (§4), but this is a genuine judgment call with no single industry standard — revisit if/when a free-shipping coupon type is added (deferred, §2), since that combination changes the semantics again. |
| 6 | **Coupon redemption release-on-failure.** | **Decided (§5), not left open.** Synchronous catch-and-release within the same request for the common failure case, plus a Phase-3-style reconciliation cron for the crash-mid-request case (redemption exists, order never became durable). Both paths call the same `releaseCoupon(redemptionId)`; both are required contract cases (§7 step 9). |
| 7 | **Currency mismatch between coupon and cart.** | Reject at `computeCouponDiscount` input validation (coupon has a fixed `currency` for `fixed_amount` type); percentage coupons are currency-agnostic and don't need this check. Not a deep risk, but worth an explicit negative test. |
| 8 | **`maxUsesPerCustomer` without a customer id** (guest checkout, or Phase 5 not yet wired). | Recommend degrading gracefully to global-`maxUses`-only enforcement when no customer id is present, rather than blocking guest checkout — flagged since it's a soft Phase 5 dependency, not a hard blocker. |

---

## 9. Definition of done

Per `CLAUDE.md`'s verification policy ("the contract suite is the spec," domain/adapter/
service tasks verified end-to-end before merge):

- [ ] `computeTotals` and its component pure functions (`allocateCents`, `computeLineTax`,
      `computeCouponDiscount`, `resolveShippingRate`) are green, including the property
      tests (`fast-check`, run at a sufficient iteration count to be a meaningful gate, not
      just the default) — **no float ever appears in a money field** (type-level guarantee
      plus the determinism property).
- [ ] `shippingRulesStoreContract`, `taxRulesStoreContract`, `couponStoreContract` all green
      against the in-memory fake, SQLite, **and** Postgres.
- [ ] The coupon no-over-redeem concurrency test is green **on Postgres**, run repeatedly
      (flagged/skipped without `PG_CONNECTION_STRING`, named as Postgres-required per
      DEVELOPMENT.md §2), with the passing run recorded in the PR.
- [ ] Coupon release-on-failure is green: both the synchronous catch-and-release path and
      the reconciliation-sweep crash-recovery path (§5, §7 step 9) pass on SQLite and
      Postgres — this was an open question in the prior draft; it is now a DoD gate, not
      deferred.
- [ ] `/checkout/quote` HTTP contract test passes against a live test server — wire format
      matches the port, no status-code-as-logic. `/checkout/orders` (Phase 4's canonical
      endpoint) is confirmed extended in place, not shadowed by a new `/checkout/complete`.
- [ ] Checkout integration test confirms the Phase 4 stub sum is fully replaced, and the
      order-immutability test (rate edits after order creation don't change `order_totals`)
      passes.
- [ ] `@otta-sh/domain` still imports nothing with IO (`pnpm lint` boundary rule green) — the
      three engines and `computeTotals` are pure.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format` all clean.
- [ ] Forward-only migrations added for `shipping_zones/methods/rates`, `tax_classes/rates`,
      `coupons`, `coupon_redemptions` (seven tables). `order_totals` needs **no** new
      migration here — per the Phase-4 canonical schema it already exists; this phase only
      writes richer values into its existing columns.
- [ ] Changeset added (new `fast-check` dependency + any published package changes) noting
      the new dev-dependency addition to the toolchain.
- [ ] Draft-ADR content from §8 (#1–#2) promoted to a real `adr/000X-*.md` in its own PR
      (per `adr/README.md`'s "queued" convention) — **not** bundled into this phase's PR,
      keeping scope discipline (one PR = one thing).

---

## 10. Revision log

Revised after Reviewer A and Reviewer B both **APPROVE**d with should-fixes, and after the
authoritative revision of Phase 4 fixed the canonical order schema. Changes below align
this plan to that canonical schema and resolve the should-fixes both reviewers agreed on.

| Finding | Resolution |
| --- | --- |
| **Totals home ambiguous / two sources of truth** (A §CP-2 + Phase-6 §1; B C1 + Phase-6 §1) — this plan previously hedged between `orders` and a new `order_totals` table, and told Phase 7 to `SUM` off either. | Adopted the Phase-4 canonical schema verbatim: `orders` has **no money column**; `order_totals` is the **sole** totals home. Rewrote §3 "Reused from Phases 0–5" and "Provided to Phase 7," and §6 "Order snapshot storage," to state that `order_totals` **already exists** (created + stub-populated by Phase 4) and this phase only **overwrites the same columns in the same row** — no new table, no new migration. Removed `order_totals` from the §9 migrations checklist accordingly. |
| **Endpoint name drift** `/checkout/complete` vs Phase 4's `/checkout/orders` (A §6 endpoint ref; B Phase-6 §2, C3). | §6 checkout-facing endpoint list now reads `POST /checkout/orders` (Phase 4's canonical create-order endpoint, extended), matching Phase 4's canonical subsection exactly. Added a DoD line confirming it isn't shadowed by a new route. |
| **Coupon release-on-failure left open** (A Phase-6 §2; B Phase-6 §3) — release mechanism (synchronous vs cron) was flagged as a genuine open question for the implementer. | Decided, not deferred: a synchronous catch-and-release in the same request for the common case, plus a Phase-3-style reconciliation cron for the crash-mid-request case. Rewrote §5's lifecycle paragraph, updated risk #6 in §8 from "open question" to "decided," added a new red→green step (§7 step 9, renumbering old 9→10, 10→11) with required contract cases for both paths, and added a DoD gate. |
| **Money-column naming drift repo-wide** `price_amount` (P1) / `_minor` (P4) / `_cents` (P6/P7) (A §CP-1; B C1/C4). | This plan already used `_cents` throughout and needed no column renames. Confirmed alignment with Phase 4's now-canonical repo-wide `*_cents` convention; no action required in this file beyond the totals-home fix above. |
| Discount-proration correctness under mixed tax classes (A/B §8 risk #3), rounding strategy (risk #4), free-shipping-threshold timing (risk #5), currency-mismatch check (risk #7), `maxUsesPerCustomer` without a customer id (risk #8). | **Not changed.** Both reviewers treated these as already correctly addressed by design (`allocateCents`, half-up rounding, post-discount threshold) or as reasonable, explicitly-flagged judgment calls — no should-fix or blocker was raised against them. Retained as-is. |
