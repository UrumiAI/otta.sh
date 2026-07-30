---
"@otta-sh/domain": patch
"@otta-sh/service": patch
"@otta-sh/plugin": patch
---

Fix: a product priced in the admin console could never be stocked.

Setting a SKU on the **Pricing & inventory** page wrote only `product_commerce` — nothing ever
created the product's inventory record. The merchant's next step, Restock, then failed with "No
stock record yet" (`NO_INVENTORY_ROW`), permanently, with no way forward from the admin UI.
`initialOnHand` on the integrator `PUT /products/:id/commerce` was the only thing in the whole
system that had ever created one.

The invariant is now **a product with a SKU has an inventory record**, held by the data rather
than by one caller, so *both* write paths seed it:

- the admin commerce edit seeds a zero record for the resulting SKU after an applied edit;
- `PUT /products/:id/commerce` seeds `0` when it carries a SKU and no `initialOnHand`, so the
  integrator path can no longer mint a SKU with nothing behind it either.

The seed is the existing create-if-absent `INSERT … ON CONFLICT (sku) DO NOTHING`, so it can
never clobber a live or already-decremented count.

**One behaviour change to know about: initial stock now only lands on the first save that carries
the SKU.** Because the seed is create-if-absent and now runs as soon as a SKU exists, an
`initialOnHand` sent on a *later* save is silently discarded — the record is already there at `0`.
Previously that later save was the only way to heal a product whose stock record had gone missing.

In practice this only affects the integrator `PUT /products/:id/commerce`: send `initialOnHand`
with the first SKU-bearing call, or add stock afterwards with **Restock** on Pricing & inventory,
which now always has a record to add to. Nothing is lost. (The CMS "Product data" panel also had a
Stock input with this hazard, but it is deleted in the same release — see "one home per field" —
so the only stock paths that ship are the integrator PUT and Restock.)

The discard is deliberate: the seed must never overwrite a live or already-decremented count.

The seed is attempted on every save with a known SKU, never gated on "the SKU just changed", so a
retry after a failed seed heals the record rather than stranding the product. On the edit path
that is safe because a same-key retry is classified as a *replay* ahead of the staleness check, so
it returns `ok` and the seed runs again; a merchant re-saving carries a fresh watermark and heals
through the ordinary compare-and-set instead.
