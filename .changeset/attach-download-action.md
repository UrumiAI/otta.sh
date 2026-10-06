---
"@otta-sh/plugin": minor
---

New console write `products:attach-download` (issue #376, increment 4). The product
editor's Download file card sends it after the site's upload endpoint has stored a file:
`{productId, expectedUpdatedAt, key, filename, contentType, size}` as flat strings. It is a
sparse edit of `downloadAsset` alone, under the product's watermark, with a content-derived
idempotency key, so the same attach sent twice writes once. A refused descriptor reads
"This file wasn't attached" with a sentence for the sub-field (for example, only a Digital
product can have a download file). `PRODUCTS_ACTION_IDS` gains the id.
