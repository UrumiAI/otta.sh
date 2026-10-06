---
"@otta-sh/plugin": patch
---

Text that is not well formed — a lone UTF-16 surrogate or U+0000, which Postgres
cannot store — is refused at every input boundary (security review R3-B, X1),
instead of reaching storage and breaking every order query on Postgres.

- `storefront/checkout/place`: such text in a ship-to field is
  `INVALID_SHIPPING_ADDRESS` (the buyer retypes the address, as for an over-long
  field); in the buyer's email, coupon code or any id it is `INVALID_INPUT`. Both
  before anything is read or written.
- `storefront/checkout/summary`, the cart, account and download routes refuse it as
  their existing `INVALID_INPUT`; `storefront/order` answers `ORDER_NOT_FOUND`, as it
  does for any string that cannot be an order id.
- The in-process commerce and admin clients refuse it in every free-text field
  (`requireBoundedText`, titles, skus, product ids, variant keys, idempotency keys)
  with `CommerceInputError` — so zone, method and tax-class names, coupon codes,
  order notes, refund and cancellation reasons and fulfilment details are refused
  with the admin's existing "not saved" refusal, which now says "contains a
  character that cannot be saved (a broken emoji or an invisible NUL) — retype it".
- The CMS sync REPAIRS a product or variant title holding such text to U+FFFD (it
  is the CMS's text, already saved, and the hook cannot send the editor back), and
  skips — with a logged problem — a variant row whose KEY holds it, since a repaired
  identifier would name a different variant.

No route's result union changes.

The cron sweep's query-budget proxy exposes the collection it meters to the storage
guard's repair walk (`UNMETERED_COLLECTION`), so on Postgres a legacy order deep in
the collection is healed and expired on the next tick instead of the walk being cut
off by the expiry leg's budget every minute.
