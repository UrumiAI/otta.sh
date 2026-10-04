---
"@otta-sh/domain": patch
---

The intent-cancel sweep withdraws an order's payment intent at the order's hold
deadline, whether or not the expiry has reached the order yet (QA2 M1a). It used to
push the cancel back five minutes at a time while the order was still `pending`, so an
order whose expiry lagged was expired with its intent still payable, and a tab left
open could charge the buyer (who was then refunded). An order still `pending` past its
hold now has its intent withdrawn and keeps its stock until the expiry runs; a payment
that was already under way when the withdrawal reached the provider settles it
normally, because the stock was still held.

Each cancel attempt now carries its own idempotency key (`cancel-intent:<id>` for the
first, `cancel-intent:<id>:<n>` after). Stripe saves the first result for a key,
failures included, and replays it, so a retry under the same key could never get past
a transient error.
