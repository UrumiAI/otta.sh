---
"@otta-sh/domain": minor
---

A signed-in shopper's orders are theirs at once, and their list leads with the newest
(ADR-0004, amended 2026-10-02).

- **`CreateOrderInput.customerId`** (optional): an order can be owned from birth.
  `createOrderFromCart` now writes its `customerId` onto the order, not only into the
  coupon redemption. A same-key replay never re-owns an order (the owner is written
  once, with the order).
- **`checkoutOwner({ sessionStore, customerStore, onError? }, { sessionToken, buyerRef })`**:
  the customer the session resolves to when the order is placed under their own email
  (case-insensitive, the guest-linking fold), otherwise `undefined` — a different email,
  or an unknown/expired/revoked session, stays a guest order. Never throws: a failed read
  is reported through `onError` and the order is a guest order.
- **`listCustomerOrders({ customerStore, orderStore, onClaimError? }, customerId)`**:
  claims the guest orders placed under the customer's email (`linkGuestOrders`, the
  sign-in's own rule — a live session proves the inbox), then lists. `null` for a
  customer that does not exist. A failed claim is reported through `onClaimError` and
  the owned orders are listed anyway. One customer read plus one indexed query per call
  once nothing is left to claim; idempotent.
- **Coupons:** a signed-in, same-email checkout now passes its `customerId`, so a
  coupon's `maxUsesPerCustomer` is enforced for it (`COUPON_MAX_PER_CUSTOMER`). Guest
  checkouts, and signed-in checkouts under another email, are not counted per customer.
- **BREAKING (port semantics):** `OrderStore.listForCustomer` is now NEWEST FIRST
  (`createdAt DESC, id DESC`), pinned by `orderStoreContract`. It was oldest first. An
  out-of-tree `OrderStore` must reorder, and must persist `CreateOrderInput.customerId`
  on a fresh insert (and ignore it on a replay).
