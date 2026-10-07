---
"@otta-sh/domain": patch
"@otta-sh/plugin": patch
---

Re-adding a sku that is already in the cart now adds to that line's quantity
on the line's own stock hold. Previously `addLine` reserved the new quantity
afresh and the cart store replaced the existing line with it, so the line
showed only the latest add's quantity and the earlier reservation was
orphaned. That stock stayed held until the 15-minute sweep reclaimed it. The
re-add now runs as a delta adjust of the existing line (`line.qty + qty`)
under the add's idempotency key, which keeps one reservation per line. A
replay of the re-add returns the recorded line and moves no stock. A re-add
that exceeds the available stock reports `OUT_OF_STOCK` and leaves the line
unchanged. The plugin bundles `@otta-sh/domain`, so its storefront
`storefront/cart/lines/add` route gets the fix too.
