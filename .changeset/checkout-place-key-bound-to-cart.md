---
"@otta-sh/plugin": minor
---

**A stricter route contract (hence minor):** `storefront/checkout/place` now
refuses a request it used to accept. A caller that sent any idempotency key other
than the cart's own `checkout:<cartId>` was placed before; it is now refused.

`storefront/checkout/place` refuses an idempotency key that is not the cart's own
`checkout:<cartId>` with the typed `{ ok: false, reason: "CHECKOUT_STALE" }`, before
anything is minted, adopted or asked of the payment provider.

The route is public, and it forwarded the caller's key as given: a caller could
place its own cart under `checkout:<another cart>`, binding that key to the wrong
order, after which the other cart's real checkout failed `IDEMPOTENCY_KEY_REUSED`
for good. The key is derived by the summary route, so every honest caller already
sends exactly this one; a mismatch is a page reviewed for another cart, and is
refused rather than rewritten so a cart is never placed against totals nobody
reviewed. `IDEMPOTENCY_KEY_REUSED` stays in the union (the domain still guards it),
but the place route can no longer produce it.
