---
"@otta-sh/domain": minor
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
- the move is recorded as a pair of entries in the stock-movement ledger (one out of the old SKU,
  one into the new), so a rename is no longer the one way to move stock and leave nothing behind
  explaining where it went;
- if the new SKU **already has a stock record of its own**, the rename is refused outright with a
  new `SkuStockConflictError` naming both SKUs, and nothing is written on either side. Merging two
  counts would invent a stock figure nobody counted, and picking one would throw the other away,
  so the choice stays with the operator;
- if the old SKU still has **live reservations** against it, the rename is refused with a new
  `SkuHeldStockError` naming the SKU and how many. Reserved units are already out of the on-hand
  count and the reservation cannot follow the rename, so its units would return to the old SKU
  when the cart or order finished. Reservations are short-lived, so this is a "try again shortly".

Both writers of the field behave identically — the admin **Pricing & inventory** edit and the
integrator `PUT /products/:id/commerce` — because the rule belongs to the field, not to one
caller. Writes that change nothing (a re-submitted identical SKU, a double-submitted save, an
out-of-order CMS sync, a rejected edit) move no stock at all, so a double-click moves the units
exactly once.

**Known consequences**, all deliberate:

- The refusal does not look at how much the other record holds: a record sitting at zero is still
  a record — a known SKU that is out of stock, which is a different fact from a SKU that has never
  existed. Because the old record is kept rather than deleted, **a SKU that has ever held stock
  cannot be renamed *onto* later, including undoing a rename.** Rename to a SKU that has never
  been used.
- Every emptied old record still counts as a stocked SKU for **Reports → Low stock**, which lists
  inventory rather than products: expect renamed-away SKUs to accumulate at the top of that report
  as zero-stock entries with no product title. The report's own predicate is untouched here (one
  change, one thing); teaching it to hide product-less rows is a follow-up.
- Setting a product's **first** SKU is not a rename, and still adopts an existing stock record for
  that SKU, units and all — the long-standing behaviour that lets a product re-linked to a SKU it
  used to own recover its stock. Renames refuse; first assignment adopts.
- `initialOnHand` on the integrator PUT is create-only, as before, and a rename claims the new
  SKU's record as part of the move — so a PUT that both renames and supplies `initialOnHand` lands
  the carried count (or zero, if the old SKU had no record), never the supplied figure. Add stock
  with **Restock** instead.
- `SkuStockConflictError` and `SkuHeldStockError` currently surface as generic failures at the
  HTTP boundary; mapping them to structured responses and legible messages in the admin console is
  a follow-up.
