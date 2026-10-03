---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

One order expiry costs 13 storage calls instead of 22 (a three-line order 23 instead of
40), so the Workers Free sweep budget expires lapsed orders several times faster (QA2 M2).

- **`expireOrdersBatch` no longer re-reads the order or releases its holds a second
  time.** It asks the store for the flip and the expired order in one call, releases
  the holds in ONE batched, order-scoped call only when the store has not already done
  so, and frees the coupon only for an order that carried one (`appliedCouponCode`).
  It also takes an optional pre-listed `due` set (`ExpireOrdersBatchOptions`), so the
  sweep's "is there any work?" read is not paid twice.
- **New required port methods.** `OrderStore.expireWithOrder(orderId, now)` answers
  `null` for a lost flip, else `{ order, holdsReleased }`. `InventoryStore.releaseAdoptedMany(ids, orderId)`
  is `releaseAdopted` for many ids (same per-id rule; grouped per SKU). Any custom
  `OrderStore` or `InventoryStore` must add them; the in-memory fakes and the document
  store implement both.
- **Document store:** the expiry's release completion reuses the document and revision
  the flip wrote (one compare-and-set to close the intent, no re-read), and releases per
  SKU with one aggregate read and one prune. `completeHoldRelease` uses the same batched
  release. The reporting rollup no longer pre-reads the claim before creating it (the
  create-if-absent is the once-only gate), one call fewer on every order transition.
