---
"@otta-sh/domain": minor
"@otta-sh/admin-presentation": minor
"@otta-sh/plugin": patch
---

A product with a download file stays Digital (issue #376; the product owner's rule: a
file is replaced, never removed, so past buyers never lose access). Saving such a product
as Physical was already refused by the store; the plugin's save now says why ("This product
stays Digital" — nothing was saved: it has a download file, which can be replaced but never
removed) instead of the price and measurement
copy a generic invalid field got. `@otta-sh/admin-presentation` exports the shared words:
`DIGITAL_WITH_FILE_TITLE` and `DIGITAL_WITH_FILE_REASON` for the refusal, and
`DIGITAL_WITH_FILE`, which the product editor shows beside its disabled Physical choice.

**Behaviour change in the domain:** `updateProductCommerceFields` now refuses
`downloadAsset: null` on a product whose stored row has a file, with
`InvalidProductFieldError("downloadAsset")` — a file can be replaced, never removed.
Detaching from a product with no file stays a harmless no-op. A stale watermark still gets
the store's `stale` answer.
