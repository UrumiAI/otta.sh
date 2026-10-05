---
"@otta-sh/domain": patch
"@otta-sh/store-emdash": patch
---

A cart line's `productId` is never cleared by a later write that carries none (#373).

- **`@otta-sh/store-emdash`.** `EmdashCartStore.upsertLine` keeps the stored `productId` when the
  incoming one is null. Two first adds of the same sku can race past the "already in the cart"
  check, and the second, sent without a `productId`, used to null the line's — after which
  checkout refused it (`PRODUCT_NOT_PRICED`). The line is re-read on every compare-and-set
  attempt, so a write that loses the race and retries keeps the winner's `productId` too.
- **`@otta-sh/domain`.** The in-memory `CartStore` fake follows the same rule, and
  `cartStoreContract` pins it: a null `productId` never overwrites a non-null one, a non-null
  one still fills a line written without one, and two concurrent first adds keep the
  `productId` whichever lands last.
