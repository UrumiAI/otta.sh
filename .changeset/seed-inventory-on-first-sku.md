---
"@urumi/domain": patch
"@urumi/service": patch
"@urumi/plugin": patch
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

This is visible in the CMS **Product data** panel, not only to integrators. The panel's Stock
input is independent of its SKU input, and its label invites "set the SKU and price now, enter
stock on the next save" — under this release that later stock figure does not move real stock,
while the panel keeps redisplaying the number the merchant typed. Set stock on the same save that
first sets the SKU, or use **Restock** on Pricing & inventory, which now always has a record to
add to. Nothing is lost, and the panel itself is removed in the next release.

The discard is deliberate: the seed must never overwrite a live or already-decremented count.

The seed is attempted on every save with a known SKU, never gated on "the SKU just changed", so a
retry after a failed seed heals the record rather than stranding the product. On the edit path
that is safe because a same-key retry is classified as a *replay* ahead of the staleness check, so
it returns `ok` and the seed runs again; a merchant re-saving carries a fresh watermark and heals
through the ordinary compare-and-set instead.
