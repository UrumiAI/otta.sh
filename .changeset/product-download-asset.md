---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": minor
---

A digital product can carry a download file (issue #376, increment 1). This adds the
pointer only. Nothing serves bytes yet.

- **Domain.** `ProductCommerce.downloadAsset: DownloadAsset | null`, with
  `DownloadAsset = { key, filename, contentType, size, sha256? }`. It is set through the
  guarded admin edit (`UpdateProductCommerceFieldsInput.downloadAsset`, where `null`
  detaches) and never through the CMS-sync `upsert`. `updateProductCommerceFields` checks
  it with `validateDownloadAsset`, which accepts or refuses and never rewrites:
  - the key must be `dl/{productId}/{ULID}` for this product;
  - the filename is 1–255 characters of well-formed text, with no control, quote,
    slash, backslash, line-separator or bidi characters and no leading or trailing
    spaces;
  - the content type is a bare lowercase `type/subtype`: `text/plain` or `text/csv`
    within `text/*`, and elsewhere never `*+xml` (SVG, XHTML), `application/xml`, a
    JavaScript type or `multipart/x-mixed-replace`;
  - the size is a non-negative safe integer;
  - `sha256`, when present, is 64 lowercase hex characters.

  The store refuses a file on a physical product inside the edit's compare-and-set. That
  covers both attaching a file to a physical product and switching a product that has a
  file to physical. Each refusal is an `InvalidProductFieldError` naming the sub-field.
- **Store.** Additive, with no migration: a document written before the field existed
  reads `null`.
- **Plugin.** `ProductEditWire.downloadAsset` is parsed strictly: unknown keys and wrong
  types are refused as `invalid` with no field. `ProductDetailWire.downloadAsset` returns
  the descriptor. No form sends it yet.

**BREAKING for out-of-tree `ProductCommerceStore` implementations:** `ProductCommerce`
gains a required `downloadAsset` field, and `updateCommerceFields` must refuse a file on a
physical product.

**BREAKING for consumers of the plugin's admin wire types:** `ProductDetailWire` gains a
REQUIRED `downloadAsset: DownloadAssetWire | null`. Code that builds a
`ProductDetailWire` (a fake admin client, a test fixture) must now supply it; code that
only reads one is unaffected.
