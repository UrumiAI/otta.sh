---
"@otta-sh/plugin": patch
---

The `product-orphans` sweep now tombstones at most 25 products in any 24 hours, on top of its
5-per-tick cap (#447). The per-tick cap alone let a systematic false positive tombstone about 300
an hour. The window lives in the leg's kv state; a product whose last strike finds it full is left
live with its strikes kept and judged again on a later pass.
