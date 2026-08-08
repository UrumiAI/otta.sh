---
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Variants reach the integrator API, and the cart stops taking a caller's word for what a
SKU is. The two ship together because the second is only safe once the first exists: a
product that hands out more than one SKU makes the add endpoint's missing check
reachable.

- **Four routes, one per writer.** `GET /products/:id/variants` reads a product's sizes;
  `PUT /products/:id/variants/:variantKey` is the CMS sync's declare; `PATCH` is the
  guarded admin edit; `POST …/deactivate` is the orphan transition. `PUT` and `PATCH`
  are not two spellings of one upsert — they are the two writers ADR-0016 keeps apart,
  and both bodies are `.strict()`, so a declare carrying `sku`/`price` and an edit
  carrying `title` are each a 400 that names the field rather than a 200 with it
  silently dropped. The variant key is a path segment because it is the identity:
  immutable, half the primary key, and unreachable from either body.
- **Every documented refusal is a typed envelope, never a 500.** The three SKU refusals
  answer the same `SKU_TAKEN` / `SKU_STOCK_CONFLICT` / `SKU_HELD_STOCK` 409s the product
  upsert already answers, carrying the operands an operator has to act on. The
  compare-and-set outcomes answer `VARIANT_NOT_FOUND` (404 — an edit is neither a create
  nor a resurrection), `STALE_EDIT` (409, with the watermark to reload from) and
  `CURRENCY_MISMATCH` (409). A missing variant key is the 400 its error's docblock has
  been asking for since it was written; previously it could only reach an in-process
  caller, and would have arrived as a 500 the moment a route existed.
- **Money is integer minor units plus a currency, and absent is absent.** A declared but
  unpriced size serializes `null` — never `0`, never a zero-amount object, never
  "Free". The list read publishes a coarse `inStock` rather than the exact on-hand
  count, for the same reason the commerce read omits unit cost: the write gate covers
  non-GET verbs only, so that read is storefront-reachable and a per-SKU stock figure is
  not a buyer's business.
- **The cart add endpoint now resolves its SKU instead of forwarding it.** An add that
  names a product must resolve that SKU to a live, priced sellable unit **of that
  product** — the product's own row, or one of its live variants. A SKU belonging to
  another product, to a soft-deleted product, to a product with no commerce row at all,
  or to a variant the CMS has since orphaned is refused `SKU_MISMATCH`; a unit nobody
  has priced is refused `PRODUCT_NOT_PRICED` at the Add button rather than at the quote.
  Rejected, never reinterpreted: the service does not substitute the SKU it thinks the
  caller meant.
- **Two halves that were open are now closed.** A `productId` with no commerce row used
  to be waved through as harmless, and a product whose SKUs live on its variants could
  never match at all. Both are reachable the moment a product has more than one SKU.
- **It costs nothing on the checkout path.** The resolution is at most two keyed reads
  per request — one on the storefront's hot path, which is the read the route already
  did — never per line, and it touches no inventory: it runs before the domain's add, so
  a refusal holds no stock and a replay of a refused add is refused identically rather
  than half-applied.
- **A bare add (no `productId`) is unchanged, deliberately.** Resolving a bare SKU means
  asking which live sellable unit anywhere holds it, and the commerce store has no
  by-SKU lookup — every read on it is keyed by product. Such a line is also unorderable
  by construction, since both checkout paths reject a null `productId` before pricing
  anything, so it can confer neither a price nor an entitlement. Closing the remainder
  needs a by-SKU resolver on the port.
- **`HttpCommerceClient` mirrors all of it**, with the variant refusals normalized onto
  `reason` like every other typed failure it returns, so a caller never branches on an
  HTTP status. Its cart methods gain `PRODUCT_NOT_PRICED` alongside `SKU_MISMATCH`.

Order lines are still priced and titled from the product row, so a variant line would
snapshot its parent's price and name. Nothing declares a variant today, and no
storefront surface offers one; wiring checkout to price and snapshot the resolved unit
is the prerequisite for either.
