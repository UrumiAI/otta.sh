---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Add merchant-standard commercial fields to the product data model and the #67
edit form — compare-at price, unit cost, tax class (registry-referenced), and
inventory policy (admin-UX Increment 2, slice 5). Data model + admin edit only;
no storefront rendering, and NO change to reservation semantics.

- `@otta-sh/domain`: `ProductCommerce` / `UpdateProductCommerceFieldsInput` gain
  `compareAtPrice` (optional `Money`), `unitCost` (optional, admin-only `Money`),
  and `inventoryPolicy` (a `"deny"`-only union — see below). All three are
  EDIT-ONLY (set via `updateCommerceFields`, never the CMS-sync `upsert`, which
  defaults + preserves them). Currency integrity is atomic on two layers: the
  `updateProductCommerceFields` use-case rejects a within-edit mixed-currency
  save (`InvalidProductFieldError`, 400) before any write, and the store's
  compare-and-set extends `currency_mismatch` so compare-at / cost must match the
  product's price currency (which can never change once set) — including the
  "not priced yet" case (nothing to match). `compareAtPrice >= price` is allowed
  (a warning, not a block). `inventoryPolicy` is a one-value union: `"deny"` is
  the only behavior — the no-oversell invariant is untouched, backorders are a
  future slice + ADR. Adds `ProductCommerceStore.countByTaxClass` and
  `TaxRulesStore.deleteClass` (own-grain rate guard) plus the `deleteTaxClass`
  use-case: a delete-in-use guard spanning both aggregates so a tax class a live
  product (or a rate) references can never be deleted. Fakes + contract suites pin
  every case (round-trip/replay/clear, currency integrity, `countByTaxClass`
  live-only, registry delete-in-use) plus two fast-follow pins: a soft-deleted row
  is always inactive, and keyset pagination works under the archive (`deleted`)
  view.
- `@otta-sh/store-postgres`: forward-only migration `0017` adds
  `compare_at_cents`/`compare_at_currency`, `unit_cost_cents`/`unit_cost_currency`
  (nullable, `>= 0` CHECK), and `inventory_policy text NOT NULL DEFAULT 'deny'`,
  additively (no backfill). The Kysely store rows/edits carry the new fields and
  the extended currency guards, dialect-identical on better-sqlite3 and Postgres;
  `KyselyTaxRulesStore.deleteClass` and `countByTaxClass` implement the guards.
- `@otta-sh/service`: `PATCH /admin/products/:id` accepts the new fields;
  `editProductCommerceBody` bounds compare-at/cost (non-negative money) and
  `inventoryPolicy` (`"deny"` enum). The internal-token admin detail serializes
  unit cost; the PUBLIC `GET /products/:id/commerce` (an un-gated, storefront-
  reachable GET) and the catalog view DELIBERATELY OMIT unit cost — admin-only
  margin data never reaches a buyer, pinned by a test.
- `@otta-sh/plugin`: the product edit form surfaces the four fields via Block Kit —
  compare-at + unit cost as TEXT money inputs (integer-string parsed, never a
  float), a tax-class SELECT sourced from the live registry (`GET
  /admin/tax/classes`, static-seeded fallback, best-effort so a registry read
  failure degrades rather than breaks the detail), and a DENY-ONLY inventory-
  policy select. Sandbox-clean (local wire types, `ctx.http`-only egress).
