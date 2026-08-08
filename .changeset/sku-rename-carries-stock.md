---
"@otta-sh/domain": patch
"@otta-sh/store-postgres": patch
---

Fix: renaming a product's SKU silently abandoned its stock.

Inventory is keyed by the SKU itself, so a SKU was never just a label. Changing one wrote the new
value onto the product and then created a **fresh, empty** stock record under it — while the old
record kept every unit, now attached to no product and reachable from no screen. A product with
120 units on the shelf reported zero the moment it was renamed, Restock started counting up from
nothing, and the real 120 stayed lost until someone went looking in the database. Nothing warned
anybody, and no test covered a rename's effect on stock.

A rename now **moves the units**, in the same transaction as the rename itself, so the two can
never come apart:

- the count is carried onto the new SKU;
- the old record is kept, emptied — stock records are never deleted, because reservations and
  placed orders still point at them;
- if the new SKU **already has a stock record of its own**, the rename is refused outright with a
  new `SkuStockConflictError` naming both SKUs, and nothing is written on either side. Merging two
  counts would invent a stock figure nobody counted, and picking one would throw the other away,
  so the choice stays with the operator.

The refusal does not look at how much the other record holds: a record sitting at zero is still a
record — a known SKU that is out of stock, which is a different fact from a SKU that has never
existed — and it may already carry reservations and order lines. One consequence worth knowing:
because the old record is kept rather than deleted, a SKU that has ever held stock cannot be
renamed *onto* later, including undoing a rename. Rename to a SKU that has never been used.

Both writers of the field behave identically — the admin **Pricing & inventory** edit and the
integrator `PUT /products/:id/commerce` — because the rule belongs to the field, not to one
caller. Writes that change nothing (a re-submitted identical SKU, a double-submitted save, an
out-of-order CMS sync, a rejected edit) move no stock at all, so a double-click moves the units
exactly once. The always-attempt stock-record seed that follows every save is unchanged and still
unconditional; it simply finds the carried record already there and leaves it alone.

`SkuStockConflictError` currently surfaces as a generic failure at the HTTP boundary; mapping it
to a structured response and a legible message in the admin console is a follow-up.
