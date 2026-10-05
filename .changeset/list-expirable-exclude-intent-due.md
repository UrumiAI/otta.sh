---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

`OrderStore.listExpirable(now, { excludeIntentDue: true })` leaves out every order whose payment
intent is due for withdrawal and not yet withdrawn, so no order expires while the buyer can still
pay it (QA3 N1). `expireOrdersBatch` passes the option through. It defaults to false, so the use-case on
its own is unchanged; the plugin's sweep sets it and withdraws those intents first.
`listExpirable` now lists oldest deadline first.

**BREAKING for out-of-tree stores:** an `OrderStore` must honour `excludeIntentDue`. A store that
ignores it lets the scheduled sweep expire an order whose intent is still payable. The options
type is now `OrderExpiryListOptions` (it extends `ExpiryListOptions`).
