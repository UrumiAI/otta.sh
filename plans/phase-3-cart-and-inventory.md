# Phase 3 — Cart + Inventory (implementation plan)

_Status: plan only, no code. Author: principal-eng plan pass. Depends on Phases 0–2._

Turns implementation-plan.md Phases-table row 3 ("Cart routes, atomic reserve, hold-expiry
cron") into a TDD-sequenced red→green build. Governing rule (DEVELOPMENT.md §1): **write the
failing test against the port first, then the code**; the contract suite is the spec; real
DBs, never mocks; the no-oversell concurrency test is **Postgres-required**.

Headline test (implementation-plan.md): _adding to cart reserves via the port; an expired hold
is released and its stock returns; the no-oversell guarantee holds **end-to-end through a
cart**._

---

## 1. Goal & headline test

**Goal.** A shopper can build a cart whose lines hold **live inventory reservations**, backed
by the Phase-0 atomic authority, with a TTL so abandoned holds return their stock. Cart truth
lives in the commerce service (tier ③); the plugin (tier ②) only carries a cart token and
proxies over `ctx.http`. No checkout, no payment, no price snapshot yet (Phase 4).

**Behavioral cases (each a named test, written before code):**

Domain / store contract (run against fake · SQLite · Postgres):
1. **add reserves** — adding `{sku, qty}` to a cart calls the inventory port and decrements
   `on_hand` by `qty`; the cart line records the returned `reservationId`.
2. **add out-of-stock** — adding `qty > on_hand` returns `OUT_OF_STOCK`, writes **no** cart
   line, and leaves `on_hand` unchanged.
3. **add is idempotent** — replaying the same add command (same `idempotencyKey`) returns the
   same line/`reservationId` and decrements **once** (double-click safety).
4. **increase qty (delta reserve)** — raising a line from `a`→`b` (`b>a`) atomically reserves
   the delta `b−a`; on insufficient stock the line stays at `a` and reports `OUT_OF_STOCK`.
5. **increase is idempotent** — replayed increase applies the delta once (a retried "+1" must
   not become "+2").
6. **decrease qty (partial release)** — lowering `a`→`b` (`b<a`) returns `a−b` to `on_hand` and
   **always succeeds** (no re-reserve race).
7. **remove line** — deleting a line releases the whole reservation; `on_hand` returns; the
   line is gone; double-remove is a no-op.
8. **expired hold released** — a line whose reservation is past its TTL is released; `on_hand`
   returns; the line is marked expired/removed; the release is **not double-applied** even if
   both a lazy read and the sweep hit the same reservation.

Concurrency (**Postgres-required**, tagged/skipped without `PG_CONNECTION_STRING`, like
Phase-0 §0.5):
9. **no oversell through a cart** — seed stock `M`; fire `N` concurrent add-to-cart requests
   (`N > M`, independent connections, `Promise.all`) each adding qty 1 of the same sku; assert
   **exactly `M`** carts get a line and `N−M` get `OUT_OF_STOCK`, and final `on_hand == 0`.
   This is the Phase-3 acceptance gate — the whole point is that the guarantee survives the
   cart layer, not just the raw `reserve` endpoint.

---

## 2. Scope

**In:**
- `@urumi/domain` cart use-cases + a new `CartStore` port; a minimal **additive** extension to
  `InventoryStore` for reservation quantity adjustment.
- `@urumi/store-postgres` cart tables (forward-only migration) + Kysely `CartStore` adapter +
  the inventory `adjust`/partial-release statements, dialect-parameterized (SQLite + pg).
- `@urumi/service` cart REST endpoints (1:1 with the cart use-cases) + the hold-expiry sweep
  job wiring.
- `@urumi/plugin` storefront cart routes + `HttpCommerceClient` cart methods + a Block Kit
  add-to-cart page fragment, exercised under the workerd-on-Node sandbox.
- Contract-suite extension: `cartStoreContract`, an inventory `adjust` contract, an HTTP cart
  contract, the no-oversell-through-cart Postgres test.

**Out (explicitly deferred):**
- **Checkout, order creation, payment, price snapshots, entitlements → Phase 4.** Cart lines
  do **not** snapshot price; the cart shows the **live** price read from `product_commerce`.
  `commit`ting reservations happens at checkout, not here.
- **Coupons / discounts / shipping / tax → Phase 6.** Cart totals are a plain sum of
  `live_unit_price × qty` in integer minor units — no discount, no tax, no shipping.
- **Customer accounts / cart-merge-on-login → Phase 5.** Carts are anonymous here; identity is
  designed so a `customer_id` column can attach later without reshaping.
- **Variations** — out of v1 entirely; a line keys on a single sku/product.
- **Digital goods' cart path is an open cross-phase gap, not resolved here — see §8 Risk 9.**
  This phase's design (every add-to-cart line reserves via `InventoryStore.reserve`) implicitly
  assumes every line is a reservable physical SKU; Phase 1's `product_commerce.product_kind`
  already distinguishes `physical`/`digital`, and Phase 4 declares digital goods "unlimited, no
  reservation." Phase 3 does not yet branch on `product_kind`; this must be decided before
  Phase 4 is built (primary owner: Phase 4, since that's where the no-reservation semantics
  are declared), but Phase 3's cart use-cases are the layer that would need the branch.

---

## 3. Dependencies

**Reused from Phase 0 (verbatim, unchanged):**
- `InventoryStore.reserve(sku, qty, key) → ReserveResult` — the atomic
  `UPDATE inventory SET on_hand = on_hand - :q WHERE sku=:s AND on_hand >= :q RETURNING` gate.
- `InventoryStore.commit(reservationId)` / `release(reservationId)` — release is **idempotent**
  (double-release is a no-op); relied on for expiry.
- `ReserveResult = { ok: true; reservationId } | { ok: false; reason: "OUT_OF_STOCK" }`.
- `Clock`, `IdGen` ports; branded `Cents`, `Currency`, `Sku`, `IdempotencyKey`, `ProductId`.
- `inventoryStoreContract` + the `describeEachDialect` wrapper; the Postgres per-test schema
  isolation harness; the live-test-server HTTP harness; the boundary lint (domain imports no
  IO).

**Reused from Phase 1–2:** `product_commerce` (price, currency, sku, active flag) for live cart
pricing and purchasability; the storefront routing + `page:fragments` mechanism for the
add-to-cart button; `HttpCommerceClient` scaffolding.

**Provided to Phase 4:** a **cart with live reservations ready to commit** — Phase 4's checkout
reads a cart, snapshots each line's price+title into order line items, then `commit`s the
line's reservation(s) (converting held stock to sold) via the existing `commit` port. Nothing
in Phase 4 needs to re-reserve.

---

## 4. Cart design

### Where cart state lives — **service DB (Postgres), not plugin `ctx.kv`**

Recommend the commerce service DB, unambiguously:
- A cart line is a claim on stock (it carries a `reservationId`); it must be consistent with
  inventory truth, which lives only in the service DB. Splitting cart across `ctx.kv` and stock
  across Postgres is a distributed-consistency problem with no upside.
- `ctx.kv` / `ctx.storage` have **no atomicity, no CAS, and no enforced uniqueness** (platform
  notes: `put` is an unconditional upsert, declared `uniqueIndexes` are silently downgraded) —
  so they cannot dedupe an add-to-cart or guard a reservation. Idempotency requires the
  service's unique constraint.
- Money is integer minor units in a typed domain; that belongs in `@urumi/domain` + Postgres,
  not a JSON KV blob. `ctx.kv` stays reserved for **non-secret plugin settings** (component-map
  §2), nothing money- or stock-linked.
- Cart is a tier-③ concern in every source doc (component-map §2 "Cart | ③", design-decisions
  §7).

The plugin holds **only the cart token** (a cookie) and proxies mutations to the service.

### Cart identity for anonymous shoppers — opaque token in an httpOnly cookie

- The service mints a **128-bit unguessable `cartId`** (via `IdGen`) on first `POST /carts`.
- The plugin storefront route sets it as a cookie: `httpOnly`, `Secure`, `SameSite=Lax`,
  path-scoped to the storefront; the token is a **bearer capability** to that anonymous cart
  (guessing it = accessing someone's cart, hence 128-bit random). No PII in the token.
- The service treats `cartId` purely as a parameter — the transport (cookie) is the plugin's
  concern, keeping the REST API a clean 1:1 reflection of the port.
- **Forward-compat for Phase 5:** `carts` gets a nullable `customer_id`; login later associates
  the anonymous cart to a customer (merge logic is Phase 5, not built now).

### Schemas (forward-only migration)

- `carts (id PK, customer_id NULL, state NOT NULL DEFAULT 'active', currency, created_at,
  updated_at)` — `state ∈ {'active', 'checked_out'}`. A cart flips `active → checked_out` when
  Phase 4 adopts its reservations into an order (Phase 4 §5); a `checked_out` cart **rejects all
  mutations** (see "Cart mutations are fenced" below). **`checked_out` is terminal — no
  transition ever flips it back to `active`.** Recovery after a failed/expired checkout is
  always a **new** cart, never a reactivation of this one: reactivating would re-open the
  adopted-hold fence the `checked_out` guard exists to close. The column lands here,
  forward-only, so Phase 4 needs no cart-schema ALTER.
- `cart_lines (id PK, cart_id FK, product_id, sku, qty, reservation_id NULL, expires_at NULL,
  created_at, updated_at, UNIQUE(cart_id, sku))` — one line per sku; one reservation per
  **physical** line (see §4 quantity semantics). `reservation_id` and `expires_at` are
  **explicitly nullable**: a digital line carries no reservation (Phase 4 §6 / Risk 9), so both
  are `NULL` for it — declared nullable here so Phase 4's digital-line design needs **no
  forward-only ALTER**. **No price column** — price is read live at display/checkout; cart never
  snapshots (that invariant is an *order* invariant, Phase 4).
- A **dedicated cart-mutation idempotency ledger — required, not an "or".** Phase-0's
  `reservations.idempotency_key UNIQUE` guards only the *original* `reserve` call; it cannot
  also guard `adjust`, because many adjusts happen over a line's lifetime against the same
  reservation row, and that column already holds the original reserve's key. Add
  `cart_mutations (idempotency_key TEXT PRIMARY KEY, cart_id, line_id, kind, resulting_qty,
  created_at)` — one row per accepted `add`/`adjust`/`remove`, keyed uniquely on the client's
  `idempotencyKey`; a replay looks up the row and returns its recorded result instead of
  re-applying. This is the single mechanism for all three mutation kinds (uniform replay
  path), not a case-by-case "reuse the reservation's key when it happens to map 1:1."

### Idempotency of add / update / remove

- Every cart mutation carries an `idempotencyKey` (CLAUDE.md non-negotiable). The client (the
  add-to-cart form / Block Kit action) generates a fresh key per user action; the plugin
  forwards it as the `Idempotency-Key` header; the service threads it into the domain command
  and down to the store. **All three kinds below are recorded uniformly in the
  `cart_mutations` ledger (§4 Schemas)** — a `UNIQUE(idempotency_key)` on that table enforces
  once-only and a replay returns the **prior recorded result**, rather than each kind
  inventing its own replay mechanism:
- **add**: the underlying `reserve` also carries the same key into Phase-0's
  `reservations.idempotency_key UNIQUE` (that guard still applies to the reserve itself); the
  `cart_mutations` row additionally records the resulting line — replay = same line, one
  decrement.
- **update (delta)**: this is the load-bearing case — a retried "+1" must apply once. There is
  no reservation-level key to reuse here (one reservation absorbs many adjusts), so this is
  exactly what the dedicated ledger exists for: the `cart_mutations` row records the applied
  key and resulting qty; a replay is a no-op returning that recorded qty.
- **remove**: recorded in the ledger too, for a uniform replay path; `release` itself is also
  independently idempotent (double-release is a no-op), so double-remove is safe either way.

### Quantity-update semantics — **delta reserve / partial release**, not release+re-reserve

Recommend **delta**, and reject release+re-reserve:
- *release+re-reserve* (release the whole reservation, then reserve the new qty) has a **race
  window**: between the two statements a concurrent shopper can grab the freed stock, so a mere
  **decrease** can spuriously fail to re-reserve. Unacceptable — reducing a cart must never
  fail. It also briefly under-holds stock the shopper already owned.
- **delta** keeps one reservation per line and moves it atomically:
  - **increase by `d`**: **guard-first** — verify the cart is `active` and the line's
    reservation is still `state='held'` (the same check as the fence below) *before* touching
    inventory; only then run the single conditional `UPDATE inventory SET on_hand = on_hand - :d
    WHERE sku=:s AND on_hand >= :d RETURNING` → may return `OUT_OF_STOCK`; on success bump
    `reservation.qty` and `cart_lines.qty` by `d`. Guard-first, not guard-last: checking the
    fence only after decrementing inventory would let a checkout that adopts the reservation
    concurrently interleave between the decrement and the (now-failing) guard, leaking a
    decrement against a hold the cart no longer owns.
  - **decrease by `d`**: single `UPDATE inventory SET on_hand = on_hand + :d WHERE ...` (always
    succeeds) → drop `reservation.qty`/`cart_lines.qty` by `d`.
  - **to zero / remove**: full `release(reservationId)`.
  Each direction is a single-statement conditional write → portable to D1, no `FOR UPDATE`, no
  interactive transaction (adapter-architecture rule #4).

This requires **one additive `InventoryStore` method** (see §6): `adjust(reservationId,
newQty, key)`. It does not alter `reserve/commit/release`, so Phase-0's contract is untouched.

### Cart mutations are fenced to `held` (cart-owned) reservations

A cart mutation may only touch a reservation the cart still owns. Once Phase 4 adopts a hold
into an order (`held → adopted`), the reservation belongs to the order, not the cart — a stray
cart remove/decrement must **never** release or shrink it, or stock would be resold under a
pending order (oversell; the paid order's later `commit` would find nothing). Two guards, both
in the guarded-flip idiom already used for expiry:

- **Reservation-state guard (primary).** Every cart-initiated release/adjust is scoped to
  `state='held'`: `removeLine`'s release runs
  `UPDATE reservations SET state='released' WHERE id=:id AND state='held' RETURNING qty` and the
  delta `adjust` guards `… WHERE reservation_id=:id AND state='held' …`. **0 rows ⇒ typed
  `LINE_CHECKED_OUT`** (the hold is `adopted`/`committed`, no longer the cart's to touch) — never
  a blind release/decrement. Cart mutations therefore use the **`held`-only** flip; they must
  **not** call the `adopted`-accepting variant of `release` that Phase 4 uses for settle/expiry.
  This is what makes an adopted hold structurally untouchable by the cart, mirroring how the
  sweep (also `held`-scoped) already ignores it.
- **Cart-state guard (secondary).** The cart use-cases reject a mutation on a non-`active` cart
  up front (`carts.state='checked_out'`) with a typed `CART_CHECKED_OUT`, so a post-checkout
  mutation fails loudly at the cart layer before it reaches any reservation. Phase 4 sets
  `checked_out` via a guarded write at order creation (Phase 4 §5).

Both guards are additive to the delta model above and change no single-statement/portability
property.

---

## 5. Hold-expiry design

### TTL

- Each reservation carries an `expires_at`. Default TTL **15 minutes**, configurable (service
  env; surfaced later via settings). `expires_at = clock.now() + TTL`, recomputed on every
  mutation of the line (any add/adjust **resets** the hold so an active shopper isn't reaped).

### Sweep strategy — **lazy-on-read for correctness + a scheduled sweep to reclaim**

Recommend **both**, with distinct jobs:
- **Lazy expiry on read** is the *correctness* mechanism: `GET /carts/:id` (and any mutation)
  first runs `expireHolds` for that cart's lines, so a shopper never sees or acts on stock they
  no longer hold. Cheap, no scheduler dependency.
- **Scheduled sweep** is the *reclaim* mechanism: lazy alone leaks stock from abandoned carts
  nobody ever reads again. A periodic job releases all globally-expired holds so stock returns
  to the shelf.

Both call the **same idempotent domain use-case** `expireHolds(now)`; they differ only in
scope (one cart vs all expired).

**Where the sweep runs:** in the **service** (tier ③ owns stock). Two wirings, pick by
deployment:
- Long-running Node service → a self-scheduled interval task.
- Serverless / Worker service (can't self-schedule) → the **plugin `cron` hook** (platform
  notes: `cron` exists) hits an internal `POST /internal/expire-holds` over `ctx.http`. The
  plugin cron is a *trigger only*; it holds no stock logic. Recommend shipping the internal
  endpoint from day one so both wirings work; default to the plugin-cron trigger since the
  target includes Worker deployments.

### Atomicity of release-on-expiry — must not double-release

Model expiry as a **guarded state transition**, mirroring the reserve pattern:
```
UPDATE reservations SET state='released'
 WHERE id=:id AND state='held' AND expires_at <= :now
RETURNING qty;                       -- 0 rows ⇒ already committed/released; do nothing
```
Only the caller that **wins the flip** (gets a row back) then runs
`UPDATE inventory SET on_hand = on_hand + :qty`. Because the flip is the single conditional
statement that can only succeed once, the on_hand increment happens **exactly once** per
reservation — a lazy read and the sweep racing the same hold cannot double-return stock. This
is the same "0 rows = someone else won" discipline as the Phase-0 decrement, and it composes
with the port's already-idempotent `release`.

### Clock handling via the Clock port

- All TTL math uses `Clock.now()` — never SQL `now()` — so tests are deterministic and SQLite
  and Postgres behave identically. The domain reads `now` from `Clock` and **passes it down**
  to the store's expiry method as a parameter (`expire(now)`), keeping the store dialect-neutral
  and the "now" value single-sourced.
- Tests inject a **fake Clock** to fast-forward past the TTL (no real sleeping) and assert the
  hold releases and stock returns.

---

## 6. New service surface

### New domain ports

- **`CartStore`** (new): `create(currency) → cartId`, `get(cartId) → Cart | null`,
  `upsertLine(cartId, sku, productId, qty, reservationId, expiresAt, key)`,
  `adjustLine(cartId, lineId, newQty, expiresAt, key)`, `removeLine(cartId, lineId, key)`,
  `listExpired(now) → line[]`. Expresses **intent, never SQL** (adapter-architecture §2).
- **`InventoryStore.adjust(reservationId, newQty, key) → ReserveResult`** (additive): atomic
  delta as in §4 — increase = conditional decrement (can be `OUT_OF_STOCK`), decrease =
  unconditional increment (always `ok`). Added to the inventory contract suite; leaves
  `reserve/commit/release` unchanged.

The **cart use-cases** in `@urumi/domain` orchestrate `CartStore` + `InventoryStore` + `Clock`
+ `IdGen`, IO-free. Partial-failure between "reserve succeeded" and "cart line written" is
healed by idempotency (retry recovers) + TTL (a dangling reservation is reaped) — no
cross-store interactive transaction (D1 can't). *(Adapter-internal option: the Postgres
adapter may co-locate the reserve + line write on one connection; the domain contract does not
assume it.)*

### Cart REST endpoints (1:1 with the use-cases, no extra semantics)

- `POST /carts` → `{ cartId }`.
- `GET /carts/:cartId` → lines with **live** unit price (from `product_commerce`), qty, line +
  cart totals in **integer minor units**, and per-line expiry; runs lazy-expiry first.
- `POST /carts/:cartId/lines` — body `{ sku, qty }`, `Idempotency-Key` header → reserves;
  returns the line or `OUT_OF_STOCK`.
- `PATCH /carts/:cartId/lines/:lineId` — body `{ qty }`, `Idempotency-Key` → delta
  adjust; returns the line or `OUT_OF_STOCK`.
- `DELETE /carts/:cartId/lines/:lineId` — `Idempotency-Key` → releases + removes.
- `POST /internal/expire-holds` (not public; auth'd/internal) → runs the global sweep.

No status-code-as-logic: `OUT_OF_STOCK` is a typed body, not an HTTP error (adapter-arch rule
#2), matching how `reserve` reflects `ReserveResult`.

### Contract-suite extension

- `cartStoreContract(makeStore, { dialect })` — cases 1–8 from §1, run against fake · SQLite ·
  pg via `describeEachDialect`.
- Inventory `adjust` cases folded into the existing `inventoryStoreContract`.
- HTTP cart contract — the same behavioral cases against a **live test server** (Postgres) so
  the wire ⇄ port fidelity can't drift.

### Expiry job wiring

- Domain `expireHolds(now)` use-case; service internal endpoint; the self-interval **or**
  plugin-`cron`→endpoint trigger; all sharing the guarded-flip release.

---

## 7. Ordered red→green steps

Each step: **failing named test first, then the minimum code to green.** Domain (fakes) →
store (real DBs) → HTTP → plugin (sandbox) → e2e concurrency.

**A. Domain — inventory `adjust` (extend Phase-0 port)**
- A1 `packages/domain/test/inventory/adjust.contract.ts` :: _"adjust up reserves the delta"_,
  _"adjust up beyond stock returns OUT_OF_STOCK, no change"_, _"adjust down returns stock and
  always succeeds"_, _"adjust replay applies delta once"_ — run against the in-memory fake.
- A2 Add `adjust` to the `InventoryStore` interface + fake impl; green.

**B. Domain — cart use-cases against fakes**
- B1 `packages/domain/test/cart/cart.usecases.test.ts` :: _"add-to-cart reserves and records
  reservationId"_, _"add OUT_OF_STOCK writes no line"_, _"add is idempotent (one decrement)"_,
  _"increase delta-reserves"_, _"increase is idempotent"_, _"decrease partial-releases"_,
  _"remove releases whole reservation"_.
- B2 Define `CartStore` port + in-memory fake; write cart use-cases orchestrating
  `CartStore`+`InventoryStore`+`Clock`+`IdGen`; green. **Boundary lint must stay green** (no IO
  import in `@urumi/domain`). Add a type-level assertion that a `number` can't reach a money
  field.
- B3 `packages/domain/test/cart/cart-store.contract.ts` — lift B1's expectations into the
  reusable `cartStoreContract`; the fake is the first adapter to pass it.
- B4 `packages/domain/test/cart/expiry.test.ts` :: _"expired hold is released and stock
  returns (fake clock fast-forward)"_, _"double expiry does not double-release"_ — against fake
  + fake Clock.
- **B5 (required, not optional — see §8 Risk 2)**
  `packages/domain/test/cart/reserve-cart-line-crash.test.ts` :: _"a reservation that
  succeeded but whose cart-line write never happened (simulated crash between the two) is
  healed: a replay of the same add-to-cart idempotency key completes the cart line without a
  second decrement, and — if never replayed — the dangling `held` reservation is reclaimed by
  the normal TTL/sweep path like any other expired hold, returning its stock."_ Drive this
  against the fake by injecting the failure between the two writes directly (no real crash
  needed to exercise the fake); the same case is re-run against real stores in step C2/D1.
  This is the cart layer's analogue of Phase 0's crash-window contract case (§0.5) and gates
  the phase — it is listed in §9's Definition of Done, not left as an aside.
- **B6 (required — cart-fence guards, §4 "Cart mutations are fenced")**
  `packages/domain/test/cart/cart-fence.test.ts` :: _"removeLine/adjustLine against a
  reservation not in `held` state (simulating a Phase-4 `adopted` hold) returns
  `LINE_CHECKED_OUT` and does not release or shrink stock"_, _"any mutation on a `checked_out`
  cart is rejected `CART_CHECKED_OUT` before touching a reservation"_ — against the fake
  (seed a reservation in a non-`held` state / a cart in `checked_out`). These pin the guards
  Phase 4 relies on to fence an adopted hold from the live cart (Phase 4 §5 / B New-1); re-run
  against real stores in C-series.

**C. Store-postgres — real DBs, both dialects**
- C1 Forward-only migration `packages/store-postgres/src/migrations/00X_cart.ts`: `carts`
  (incl. `state NOT NULL DEFAULT 'active'`), `cart_lines` (UNIQUE(cart_id,sku), `reservation_id`
  and `expires_at` **nullable**); **adds `expires_at` to Phase-0's existing `reservations`
  table** (`state` already exists there from Phase 0 — this migration does not redeclare it,
  only adds the new column); a dedicated cart-mutation idempotency ledger (§4, not a reuse of
  `reservations.idempotency_key` — see that section for why).
- C5 (required) Re-run B6's cart-fence cases against real SQLite + Postgres: a cart-initiated
  release/adjust against a non-`held` reservation matches 0 rows → `LINE_CHECKED_OUT` (stock and
  reservation qty unchanged); a mutation on a `checked_out` cart returns `CART_CHECKED_OUT`.
- C2 `packages/store-postgres/test/cart-store.contract.test.ts` — run `cartStoreContract` +
  inventory `adjust` cases via `describeEachDialect` (SQLite always; pg when
  `PG_CONNECTION_STRING`). Implement Kysely `CartStore` + `adjust`/partial-release +
  guarded-flip expiry as **single-statement conditional writes**; green on **both** dialects.
- C3 `packages/store-postgres/test/hold-expiry.test.ts` — expiry via injected `now`: released,
  stock returns, no double-release under a simulated lazy+sweep race.
- C4 (required) Re-run B5's reserve↔cart-line crash case against real SQLite + Postgres: seed
  a `held` reservation with no corresponding `cart_lines` row (simulating the crash directly,
  since a real process kill isn't reproducible in CI); assert a replayed add-to-cart with the
  original idempotency key completes the line without a second decrement, and that an
  unreplayed dangling reservation is reclaimed by C3's expiry path once its TTL passes.

**D. Service — HTTP mirrors the port**
- D1 `packages/service/test/carts.http.contract.test.ts` — the cart behavioral cases against a
  **live test server** on an ephemeral port, Postgres-backed; `Idempotency-Key` header →
  domain key; `OUT_OF_STOCK` as typed body. Implement the cart routes; green.
- D2 `packages/service/test/expire-holds.test.ts` — `POST /internal/expire-holds` reclaims
  globally-expired holds; wire the sweep (self-interval + endpoint).

**E. Plugin — under the workerd-on-Node sandbox**
- E1 `packages/plugin/test/cart-routes.sandbox.test.ts` (run **sandboxed**, not trusted
  in-process) :: _"add-to-cart route proxies to service and sets cart cookie"_, _"cart read
  returns live totals"_, _"plugin reaches service only via ctx.http + allowedHosts"_ (assert no
  other egress/DB surface). Implement storefront cart routes + `HttpCommerceClient` cart
  methods + a **Block Kit** add-to-cart page fragment (not React); green under the sandbox.
- E2 (if storefront e2e exists from Phase 2) Playwright: add-to-cart → cart page shows the
  line; attach screenshot to the PR.

**F. End-to-end acceptance — Postgres only**
- F1 `packages/store-postgres/test/no-oversell-cart.pg.test.ts` (tagged Postgres-required,
  skipped without `PG_CONNECTION_STRING`) :: _"N concurrent add-to-carts across stock M never
  oversell"_ — seed `M`, fire `N>M` concurrent adds on independent connections, assert exactly
  `M` lines created, `N−M` `OUT_OF_STOCK`, final `on_hand==0`. Run repeatedly. **This is the
  Phase-3 gate.** Optionally also drive it through the live HTTP server to prove the guarantee
  survives the full cart path end-to-end.

---

## 8. Risks & open questions (with recommended resolutions)

1. **Port extension for adjust** — does adding `InventoryStore.adjust` violate "add adapters
   only when a second impl exists"? _No_ — it's an additive **method on an existing port**, not
   a new adapter; it's contract-tested and keeps the single-statement rule. **Resolution:** add
   it; leave `reserve/commit/release` byte-for-byte.
2. **Cross-store atomicity (reserve ↔ cart line)** without interactive transactions. **Resolve
   via idempotency + TTL healing** (a reserved-but-unlinked hold is reaped; a retry recovers);
   allow the Postgres adapter to co-locate both writes on one connection as an internal
   optimization, but don't let the domain assume it. **The crash-between-window test is
   required, not optional** — see B5/C4 (§7) and the corresponding §9 DoD item; this is the
   same class of gap as Phase 0's replay/crash-window contract case (§0.5 there) and the
   whole layer's correctness rests on it being exercised, not merely reasoned about.
3. **TTL reset semantics** — should touching a cart extend all lines' holds or only the touched
   line? **Recommend reset the mutated line's hold on each mutation**, default 15 min,
   configurable; document that an idle cart's holds expire even if other lines were recently
   touched (per-line `expires_at`). Revisit if merchants want whole-cart TTL.
4. **Sweep in serverless/Worker service** — no self-scheduler. **Recommend** the plugin `cron`
   hook → `POST /internal/expire-holds` as the portable trigger, self-interval as the Node
   convenience; ship both. Keep lazy-on-read so correctness never depends on the scheduler.
5. **Cart token security** — the cookie is a bearer capability. **Recommend** 128-bit random,
   httpOnly/Secure/SameSite=Lax; no cart enumeration endpoint. Sufficient for anonymous carts;
   real ownership binds at Phase-5 login.
6. **Live price vs snapshot** — an item's price can change while in-cart. **Intended:** the cart
   shows the live price; the snapshot is taken only at checkout (Phase 4). Document so it isn't
   mistaken for a bug; surface a "price changed" hint at checkout later.
7. **Cart merge on login** — anonymous → customer. **Deferred to Phase 5**; the nullable
   `customer_id` column is the only forward hook added now.
8. **Idempotency-key generation** — where does the client key come from? **Recommend** the
   add-to-cart form/Block Kit action embeds a fresh UUID per render/click; the plugin forwards
   it. Prevents double-submit from decrementing twice. (Open: exact generation point in the
   Block Kit action lifecycle — verify against the sandbox in step E1.)
9. **Digital goods vs. this phase's unconditional `reserve` on every add (cross-phase gap,
   §CP-4 in both review reports).** Every behavioral case in §1 assumes an add-to-cart line
   reserves stock and records a `reservationId`; Phase 1 already models
   `product_commerce.product_kind ∈ {physical, digital}`, and Phase 4 declares v1 digital
   goods "unlimited — no reserve/commit, straight to entitlement." As written, neither phase
   says how a digital line gets through Phase 3's cart: it would either need a real
   `inventory` row (contradicting "unlimited") or fail `OUT_OF_STOCK`/on a missing row.
   **Recommendation:** the cart's `add`/`increase` use-cases must branch on
   `product_commerce.product_kind` — for `digital`, skip `InventoryStore.reserve`/`adjust`
   entirely and write a cart line with `reservationId: null`, carrying `product_kind` (or a
   `fulfillmentKind`) through to the line so Phase 4's checkout can branch the same way on
   commit vs. grant. **This phase does not implement the branch** (no digital-goods behavioral
   case is added to §1/§7) — it is called out here so whichever of Phase 3 or Phase 4 lands
   second implements it consistently rather than each assuming the other already did.

---

## 9. Definition of done (CLAUDE.md verification policy)

- [ ] `cartStoreContract` **green on both dialects** (SQLite + Postgres) via
      `describeEachDialect`.
- [ ] Inventory `adjust` cases green on both dialects; `reserve/commit/release` contract still
      green (no Phase-0 regression).
- [ ] **No-oversell-through-cart concurrency test green on Postgres**, run repeatedly; passing
      run recorded in the PR (better-sqlite3 verifies the SQL, not the race).
- [ ] Hold-expiry proven: expired hold released, stock returns, **no double-release** under a
      lazy+sweep race; all TTL math via the injected `Clock`.
- [ ] HTTP cart contract suite green against a **live Postgres-backed test server**; wire ⇄ port
      fidelity holds; `OUT_OF_STOCK` is a typed body, not a status code.
- [ ] Plugin cart routes exercised **under the workerd-on-Node sandbox** (not trusted
      in-process); egress is **only** `ctx.http` + `allowedHosts` (guarded by a test); the
      add-to-cart fragment is **Block Kit, not React**. Playwright screenshot attached if
      storefront e2e exists.
- [ ] Domain purity: `@urumi/domain` cart use-cases import nothing with IO — **boundary lint
      green**.
- [ ] Money is **integer minor units** everywhere; no float touches a line/cart total (type-level
      + property assertion).
- [ ] Idempotency replay tested for **add, adjust (delta), and remove**, all via the dedicated
      `cart_mutations` ledger (§4) — not an ad-hoc reuse of `reservations.idempotency_key`.
- [ ] **Reserve↔cart-line crash-window case is green — required, not optional** (B5/C4, §7):
      a reservation with no corresponding cart line (simulated crash) is healed by idempotent
      replay and, failing that, by ordinary TTL/sweep expiry.
- [ ] **Cart-fence guards green** (B6/C5, §4/§7): a cart-initiated release/adjust is scoped to
      `state='held'` (typed `LINE_CHECKED_OUT`, no stock moved, when the hold is `adopted`), and
      a mutation on a `checked_out` cart is rejected `CART_CHECKED_OUT` — so an adopted hold is
      untouchable by the live cart (Phase 4 §5 relies on this). `cart_lines.reservation_id` and
      `expires_at` are nullable; `carts.state` present, forward-only.
- [ ] Migrations forward-only; **changeset added** (domain, store-postgres, service, plugin all
      changed → published-package bumps).
- [ ] `pnpm lint` clean · `pnpm typecheck` clean · `pnpm format` (tabs) applied · `pnpm test`
      green (+ `test:pg` in CI).
- [ ] Branch `feat/phase-3-cart-and-inventory`; PRs tagged per changed area (`[Domain]`,
      `[Adapters]`, `[Service]`, `[Plugin]`, `[Test]`) — scope-disciplined, one thing each;
      never pushed to `main` (merge is user-gated).

---

## 10. Revision log (post-approval review fold-in)

- **Reserve↔cart-line crash-window test was only "recommended," not required (Reviewer B
  should-fix; task directive).** Resolution: promoted to a required step (§7 B5, re-run
  against real stores as C4), referenced explicitly from §8 Risk 2, and added as its own §9 DoD
  line so it cannot be quietly dropped from a PR's test run.
- **C1's migration described `reservations.state`/`expires_at` as both new, but `state`
  already exists from Phase 0 (Reviewer A should-fix).** Resolution: reworded C1 to say the
  migration adds `expires_at` to the existing `reservations` table and does not redeclare
  `state`.
- **Idempotency ledger for cart mutations was "a ledger, or reuse
  `reservations.idempotency_key`" (Reviewer B nit).** Resolution: made it definitive — a
  dedicated `cart_mutations` ledger is required for all of add/adjust/remove, since `adjust`
  cannot be guarded by the reservation's single, already-used key column. Updated §4's Schemas
  and Idempotency subsections and the §9 DoD line accordingly.
- **Digital goods have no defined path through this phase's unconditional `reserve`
  (Reviewer A should-fix / cross-phase §CP-4, owned by Phase 4).** Resolution: added an
  explicit scope caveat (§2) and Risk 9 (§8) documenting the gap and the recommended branch
  (skip reserve for `product_kind='digital'`, carry the kind onto the line), without
  implementing it here — Phase 4 is the declared owner of the no-reservation semantics, but
  Phase 3 should not silently claim "every line has a reservation" while the gap is open.
- **Round 2 — `cart_lines.reservation_id`/`expires_at` not declared nullable (Reviewer A
  NEW-2, should-fix; Reviewer B New-3, nit).** Phase 4's digital-line design assumes both
  columns are nullable, but Phase-3's schema didn't say so. Resolution: marked both
  **explicitly nullable** in §4 Schemas (a digital line carries no reservation), so Phase 4
  needs no forward-only ALTER.
- **Round 2 — cart-fence for Phase 4's adopted holds (Reviewer B New-1, blocker; owned by
  Phase 4, small explicit change made here).** Phase 4's `held → adopted` closes the sweep seam
  but left the cart-mutation seam open: a post-checkout cart remove/adjust could `release`/shrink
  an adopted hold → oversell. Resolution (this file): added `carts.state ∈ {active, checked_out}`
  (§4 Schemas), a new "**Cart mutations are fenced to `held` reservations**" subsection (§4)
  scoping cart-initiated release/adjust to `state='held'` (typed `LINE_CHECKED_OUT`, distinct
  from the `adopted`-accepting `release` Phase 4 uses at settle) and rejecting mutations on a
  `checked_out` cart (`CART_CHECKED_OUT`), a required B6/C5 test pair (§7), a §9 DoD line, and
  the `carts.state`/nullable columns in the C1 migration. Phase 4 §5 sets `checked_out` at
  adoption and treats a 0-row settle `commit` as a loud anomaly.
- **Reservation adopted by a Phase-4 order still carries the cart's `expires_at`
  (Reviewer A nit) — resolved in Phase 4.** Phase 4 §5's `held → adopted` flip re-points
  `expires_at` to the order hold and takes the reservation out of this phase's `held`-scoped
  sweep; no change needed here (the sweep already filters on `held`).
- **Risks 1, 3–8 — no change.** Reviewed against both reports; no should-fix or nit was raised
  against the `adjust`-as-additive-method framing, TTL reset semantics, sweep wiring, cart
  token security, live-price-vs-snapshot intent, cart-merge deferral, or idempotency-key
  generation point. Kept as-is.
- **Round 3 — `checked_out` has no return transition (Reviewer A nit); `adjustLine` increase
  guard ordering (Reviewer B nit).** Resolution: §4 schema now states `carts.state='checked_out'`
  is terminal and why (mirrors Phase 4's Revision log); §4 "Quantity-update semantics" now
  specifies guard-first ordering for `adjustLine` increases (verify `active`/`held` before
  reserving the delta) so a raced checkout can't interleave a new reserve.
