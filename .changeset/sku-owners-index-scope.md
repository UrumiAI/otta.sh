---
"@otta-sh/store-emdash": patch
---

Fix add-to-cart failing with a D1 unique-constraint error on the second request for any given SKU.

`sku_owners` and `customer_emails` declared their natural key as a `uniqueIndexes` entry, documented as "a lookup plan, never the enforcement — no physical index exists in any tier." On the host's current release that is no longer true: a declared unique index materializes as one physical index per plugin, keyed on `(plugin_id, collection, <field>)` with no per-collection scoping. Any other collection under the same plugin that also carries a same-named top-level field collides on that same index — `reservation_keys` and `reservation_index` both carry `sku` (one row per reserve attempt, many rows legitimately sharing a sku), so the first reserve for a SKU succeeded and every later one for that SKU threw a raw `SQLITE_CONSTRAINT_UNIQUE`, surfacing to shoppers as "Something went wrong" on Add to cart.

Both collections now declare their natural key as a plain (non-unique) `indexes` entry. The create-if-absent compare-and-set against the sku/email-as-document-id was always the real enforcement; the index was redundant for its own collection and actively unsafe for its neighbors.
