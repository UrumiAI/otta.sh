---
"@otta-sh/store-postgres": patch
---

Add two missing `orders` indices: a composite partial index on `(customer_id,
created_at, id) WHERE customer_id IS NOT NULL` (the storefront order-history
lookup, which fans out per order and sorts by `created_at, id`) and a
functional index on `lower(buyer_ref)` matching the case-folded predicate
every buyer-ref lookup already uses. Both order lookups by customer and by
buyer reference go from a full table scan to an index scan as order volume
grows, and the customer lookup's sort now comes off the index for free.
Internal adapter perf only: no port, wire-format, or return-shape change.
