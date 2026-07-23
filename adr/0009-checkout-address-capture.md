# 0009. Checkout captures an immutable shipping-address snapshot on the order

- Status: accepted — second-expert concurrence, unconditional (two non-blocking recommendations
  folded in as notes, 2026-07-23: the admin display-only country-vs-zone juxtaposition, and the
  operational resolution of zone/address divergence via refunds — see ADR-0008)
- Date: 2026-07-22 (amended 2026-07-23 per review of PR #77)
- Refines: ADR-0001/0004 (the commerce service owns customer identity + the profile address book).
  Relates to `create-order-from-cart.ts`, `ports/address-store.ts`, `orders/customer-context.ts`
  (#62), the order snapshot invariant (`orders/model.ts`), and shipping zones (#73).

## Context

An order in Urumi today has **no idea where it shipped**. The reality on disk:

- **Checkout captures no address.** `CreateOrderCommand` carries `buyerRef`, `paymentMethod`,
  `shippingZoneId`, `shippingMethodId`, `couponCode`, `customerId` — and **no address**
  (`create-order-from-cart.ts`). The order snapshots line price + title + totals and nothing else
  about the buyer's destination.
- **The admin order page shows the *profile* address book with a disclaimer.**
  `getOrderCustomerContext` surfaces `AddressStore.list(customerId)` as *"the customer's CURRENT
  saved address book — NOT a per-order shipping snapshot"* (`customer-context.ts`), and the plugin
  renders it under a prominent banner: *"Profile address book — NOT the address this order shipped
  to. Orders do not capture a shipping address."* (`admin/orders-page.ts:427`). The disclaimer is
  correct and load-bearing — support must not read a mutable profile row as a ship-to.
- **The profile book is the wrong home for a ship-to.** `AddressStore` rows are per-customer,
  mutable, `billing|shipping`-kinded, with `isDefault` (`customers/model.ts`). Editing one
  **retroactively changes** what any past order would appear to have shipped to — the exact
  opposite of the order snapshot invariant. And **guests have no profile book at all**
  (`customer_id = NULL`), so for guest orders there is not even a wrong address to show.
- **Shipping zones do not do address matching.** `shippingZoneId` is opaque merchant-reference
  config; regions are opaque strings with **no address→zone resolution** (#73). The zone is chosen
  explicitly at checkout, not derived from where the buyer lives.
- **The snapshot invariant is the model to copy.** `order_items`/`order_totals` freeze price +
  title at purchase so a later product edit never rewrites them (`model.ts`). An address belongs
  in exactly this category.

### The Shopify / WooCommerce lens

- **Shopify: the checkout OWNS the address.** The order captures `shipping_address` +
  `billing_address` as **immutable snapshots** taken at checkout, independent of any saved customer
  address. The customer address book is a **prefill convenience only**; the order's address is
  frozen forever.
- **WooCommerce:** a **billing (required) + shipping (optional, defaults to billing)** split, both
  stored as immutable order meta.

Both industry models put the ship-to's **home on the order, snapshotted**, with the profile book as
prefill. Urumi today has *only* the profile book and *no* order snapshot — precisely backwards. This
ADR flips it to the Shopify model, deliberately narrower (one address, no billing split).

## Decision

**Capture a shipping address at checkout and snapshot it onto the order, immutably** — a new member
of the frozen order snapshot, never sourced from and never rewritten by the mutable profile book.

1. **`Order.shippingAddress: OrderAddress | null`** — a single-slot **immutable** record written
   **at creation** (unlike `fulfillment`/`cancellation`, which the admin writes later). Fields
   mirror `Address` **minus the profile concerns** (`id`/`customerId`/`isDefault`/`kind`) plus a
   contact channel: `{ name, line1, line2, city, region, postalCode, country, email? , phone? }`.
   Persisted as part of the order snapshot (a 1:1 `order_shipping_address`, mirroring
   `order_totals`), written **once** by `OrderStore.createFromCart`, **never** rewritten — the
   line-item snapshot precedent exactly.

2. **`CreateOrderCommand` gains `shippingAddress?: OrderAddressInput`; the checkout session route
   collects it.** The snapshotted value is **whatever checkout submitted** (Shopify model), for
   guests and logged-in buyers alike. A logged-in checkout MAY prefill the form from a saved
   `AddressStore` row, but prefill is a client convenience — the order copies the *submitted*
   value, not a live pointer to the profile row.

3. **Required for physical, optional for digital.** The `fulfillmentKind === "physical"` signal
   already exists per line. The use-case enforces: **an order with ≥1 physical line and no address
   is rejected** (new `MISSING_SHIPPING_ADDRESS` failure); a digital-only order may omit it (no
   destination to ship to). This is the honest minimal rule — no ship-to fabricated where none is
   meaningful.

4. **Shipping only — no billing/shipping split (narrower than Woo).** Stripe collects its own
   billing details in its payment sheet; x402 has no billing concept (a wallet). A second on-order
   billing address would be redundant or empty, so v1 captures a **single ship-to**.

5. **The address is a *record* artifact, not a *pricing* input — this increment.** The captured
   address does **not** select or validate the shipping zone: `shippingZoneId` stays an explicit
   checkout choice because **no address→zone matching exists** (#73), and building one is a separate
   decision. The address rides alongside the (already explicit) zone; coupling them is future work.

6. **Historical orders keep `shippingAddress = null` — no backfill.** An order minted before this
   slice has an honest *"no ship-to on file"* state (exactly like a cancelled-without-reason order).
   We **cannot** invent a historical ship-to, and the profile book is explicitly **not** it. The
   admin page renders `order.shippingAddress` as the authoritative ship-to when present; when null
   it keeps today's disclaimer. The profile book stays on the page but is **demoted to prefill /
   context**, its banner reworded from *"orders capture no address"* to *"profile book — the order's
   own ship-to is shown above"*.

## Consequences

- **Orders become fulfillable and auditable.** The admin/warehouse reads the ship-to off the order
  itself; a later profile edit can never rewrite a shipped order's destination.
- **The "NOT the ship-to" disclaimer stops being a permanent apology** and becomes a
  present/absent branch: real captured address vs the null-legacy fallback.
- **The rollout is order-sensitive and must be sequenced** (the discipline of ADR-0007's
  deploy-ordering): the OPTIONAL snapshot column + capture path lands FIRST (slices 1–2); the
  **required-for-physical enforcement flips only once the storefront checkout UI actually collects
  the address** (slice 3). Enforcing "required" before the UI collects it would 400 every physical
  checkout — the enforcement is gated behind the UI, never ahead of it.
- **Zone/address divergence is possible and unguarded** in v1: a buyer can pick a "domestic" zone
  and type an international address; nothing cross-checks them (there is no matcher, #73). Accepted
  for this increment — the address is a record, the zone is the priced choice — and flagged as the
  motivating case for a future address→zone resolution decision. Two reviewer-recommended
  mitigations (non-blocking, folded in):
  - **Display-only juxtaposition on the admin order page:** render the captured ship-to's
    `country` directly next to the order's chosen shipping zone (from
    `order_totals.shippingMethodSnapshot`'s `zoneId`). No matching logic, no validation — just
    putting the two facts side by side so a human spots a "domestic zone / foreign country"
    mismatch at a glance before packing the box.
  - **Divergence resolves operationally via refunds (cross-ref ADR-0008).** When a mismatch does
    slip through — under-charged international shipping the merchant won't honor — the recovery
    path is not an order edit (the snapshot is frozen) but the ADR-0008 refund flow: cancel/refund
    (full, driving `→ refunded`) or a partial refund recorded on the ledger, then re-order
    correctly. Address capture (this ADR) plus refunds (0008) together make the divergence case
    *recoverable*, which is what lets it stay unguarded at checkout time in v1.
- **PII surface grows.** The order now stores a name + postal address (+ optional contact). It sits
  under the same admin-token / service-token gates as the rest of the order, but it is new
  personal data at rest on the order — retention/erasure is a follow-up to note, not solve here.
- Implementable as **1–3 vertical slices**: (a) domain `OrderAddress` snapshot + `createFromCart`
  threading + migration; (b) service checkout route validation + admin order-page rendering +
  reworded disclaimer; (c) storefront checkout UI collects it, then flip required-for-physical.

## Alternatives considered

- **Snapshot the customer's *default* profile address onto the order at checkout.** Rejected: it
  breaks the Shopify/Woo model (checkout owns the address, not the profile), fails guests entirely
  (no book), and silently ships to a stale default the buyer never confirmed for *this* order.
- **Point the order at a profile `AddressStore` row by id (a live reference).** Rejected outright:
  a reference is mutable — editing or deleting the profile row rewrites/dangles history, the direct
  violation of the snapshot invariant. The whole point is a frozen copy.
- **Billing + shipping split (full Woo).** Rejected for v1: Stripe/x402 already own billing
  (card sheet / wallet), so a second on-order address is redundant. One ship-to now; a billing
  snapshot is an additive follow-up if a gateway ever stops carrying it.
- **Derive the shipping zone from the captured address (Shopify-style zone matching).** Rejected as
  out of scope: `#73` established regions as opaque with no matching engine; coupling capture to
  zone selection would drag an address-normalization/geo-matching dependency into a data-capture
  slice. Kept explicitly decoupled.
- **Require the address for *every* order (incl. digital).** Rejected: a digital-only order has no
  destination; forcing a ship-to there is a fiction and needless checkout friction.

## Status rationale — **ACCEPTED (sequenced rollout; unconditional reviewer concurrence)**

Capturing the ship-to is a straight application of the invariant the codebase already lives by
(freeze it on the order, like price + title), and both industry models we're measured against agree
the order — not the profile book — is its home. The only real hazard is *ordering*: the enforcement
must trail the storefront UI, not lead it. Accepting with that explicit sequence (optional snapshot
first, required-for-physical flipped last) lets the change land without breaking live checkout,
kills the standing "orders capture no address" disclaimer, and unblocks fulfillment — while
deferring the genuinely separate problems (address→zone matching, billing split, PII retention) to
their own decisions.

**Riskiest assumption (for the reviewing expert to attack):** that a single snapshotted ship-to,
**decoupled from shipping-zone selection**, is safe. Because nothing reconciles the typed address
against the chosen zone (#73), a buyer can be quoted/charged a "domestic" shipping rate while
entering an out-of-zone address — the order captures both, contradictorily, and ships (or refuses)
downstream with no checkout-time guard. Whether address capture can honestly ship *before* any
address→zone validation exists is the crux.
