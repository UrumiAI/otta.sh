---
"@otta-sh/admin-presentation": minor
"@otta-sh/plugin": patch
---

A product with a download file stays Digital (issue #376; the product owner's rule: a
file is replaced, never removed, so past buyers never lose access). Saving such a product
as Physical was already refused by the store; the plugin's save now says why ("This product
stays Digital — this product has a download file…") instead of the price and measurement
copy a generic invalid field got. `@otta-sh/admin-presentation` exports the shared words,
`DIGITAL_WITH_FILE_TITLE` and `DIGITAL_WITH_FILE`, which the product editor also shows
beside its disabled Physical choice.
