---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Capture an immutable shipping-address snapshot on the order at checkout (ADR-0009).
An order previously had no idea where it shipped — checkout captured no address, and
the admin surfaced only the customer's mutable *profile* address book behind a "NOT
the ship-to" disclaimer. This flips it to the Shopify model: the checkout OWNS the
ship-to, snapshotted onto the order and frozen, with the profile book demoted to
prefill/context. Deliberately narrower than the industry models: a single ship-to
(no billing split), and NO address→zone matching (#73) — the address rides alongside
the already-explicit zone.

This is the **capture + snapshot + display** slice. Per ADR-0009's sequencing the
optional snapshot lands first; the **required-for-physical enforcement flip is
deliberately deferred** until the storefront checkout UI actually collects the
address (enforcing "required" before the UI collects it would 400 every physical
checkout). Capture is therefore optional this slice — a physical order with no
address is still accepted.

- **Domain (`[Domain]`).** New `OrderAddress` model — a single immutable slot
  (`name`/`line1`/`line2`/`city`/`region`/`postalCode`/`country` + optional
  `email`/`phone`), mirroring the profile `Address` minus its concerns
  (`id`/`customerId`/`isDefault`/`kind`). `Order.shippingAddress: OrderAddress | null`
  is written ONCE by `createFromCart` and never rewritten — the line-item snapshot
  precedent, a frozen copy, never a live pointer into the mutable profile book.
  `CreateOrderCommand` gains `shippingAddress?: OrderAddressInput`; the use-case
  validates + trims it (`normalizeOrderAddress`, required fields non-empty + bounded
  lengths) and rejects a malformed one with a new `INVALID_SHIPPING_ADDRESS` failure
  before minting anything. The customer-context `addresses` doc is retired from "NOT a
  per-order snapshot" to "profile book — prefill/context; the order's own ship-to
  lives on `Order.shippingAddress`".
- **Adapters (`[Adapters]`).** New forward-only migration `0019_order_shipping_address`
  — a 1:1 `order_shipping_address` table (PK/FK `order_id`), mirroring `order_totals`.
  The Kysely adapter writes it in the SAME guarded transaction as the order + totals
  (a replay re-inserts nothing — carried exactly once) and left-joins it on load;
  historical orders read `null`. Insert-once — no code path UPDATEs it (immutability is
  structural). Green against the extended `orderStoreContract` on better-sqlite3 and
  Postgres.
- **Service (`[Service]`).** `POST /checkout/orders` accepts an optional validated
  `shippingAddress` and forwards it (a logged-in checkout may prefill from the profile
  book, but the order copies the SUBMITTED value). `INVALID_SHIPPING_ADDRESS` → 400.
  `serializeOrder` (both the public order read and the admin detail) gains
  `shippingAddress` and a display-only `totals.shippingZoneId` — the chosen zone read
  off the totals' method snapshot, for the admin juxtaposition.
- **Plugin (`[Plugin]`).** The admin order detail gains a "Shipping address" section:
  the captured ship-to when present (with the country rendered next to the chosen
  shipping zone — display-only, no matching, so a human spots a "domestic zone /
  foreign country" mismatch), or an honest "No shipping address captured (order
  predates capture / digital)" when absent. The customer panel's profile-book banner
  is reworded from "NOT the address this order shipped to" to "prefill/context only —
  the ship-to is shown above". Sandbox-clean.

Deliberately deferred (own decisions per ADR-0009): the required-for-physical
enforcement flip, the storefront checkout UI that collects the address, address→zone
matching, a billing/shipping split, and PII retention/erasure.
