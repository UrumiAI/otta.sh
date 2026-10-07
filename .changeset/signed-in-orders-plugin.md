---
"@otta-sh/plugin": minor
---

An order placed while signed in is in "Your orders" at once (ADR-0004, amended 2026-10-02).

- **`storefront/checkout/place` takes an optional `sessionToken`** (the theme reads its
  own `otta_session` cookie). `CommerceClient.createOrder` gains a third argument,
  `opts.sessionToken`; the in-process client resolves the customer FROM the session
  (domain `checkoutOwner`) and makes them the order's owner only when `buyerRef` is their
  own email (case-insensitive). Another email, an unusable or malformed session, or a
  session read that fails places a guest order — a session never refuses a checkout.
- **Coupons:** that owner is also passed to the coupon redemption, so `maxUsesPerCustomer`
  now binds a signed-in same-email checkout (`COUPON_MAX_PER_CUSTOMER`).
- **`listMyOrders` claims the guest orders placed under the session's email** before
  listing (the session proves the inbox, as the sign-in does), and lists newest first. A
  claim that fails is logged (message only) and the owned orders are listed anyway; a
  session whose customer no longer exists is `UNAUTHENTICATED`.
