---
"@otta-sh/domain": patch
---

A checkout replay or payment resume no longer reads the order's recorded payment intents
when the order was placed outside the buyer-address requirement (`buyerAddressRequired:
false`): its payment never carries a provider Customer, so there is nothing to read back.
That is every order on a store whose Stripe account does not need a Customer. When the
read is made and fails, the checkout now answers `PAYMENT_INTENT_FAILED` (logged as an
intent failure, nothing asked of the gateway) instead of letting the store's error escape;
the buyer's same-key retry reads again.
