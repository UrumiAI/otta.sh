---
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Variants reach the integrator API as catalogue data, and the cart stops taking a caller's
word for what a SKU is. The two ship together because the second is what makes the first
safe to expose at all: a product that hands out more than one SKU makes the add
endpoint's missing check reachable.

- **Four routes, one per writer.** `GET /products/:id/variants` reads a product's sizes;
  `PUT /products/:id/variants/:variantKey` is the CMS sync's declare; `PATCH` is the
  guarded admin edit; `POST …/deactivate` is the orphan transition. `PUT` and `PATCH`
  are not two spellings of one upsert — they are the two writers ADR-0016 keeps apart,
  and all three write bodies are `.strict()`, so a declare carrying `sku`/`price` and an
  edit carrying `title` are each a 400 that names the field rather than a 200 with it
  silently dropped. The variant key is a path segment because it is the identity:
  immutable, half the primary key, and unreachable from any body.
- **This manages catalogue data ahead of the storefront wiring.** A merchant can declare,
  price, rename and discontinue sizes over HTTP. **Variant SKUs are not yet addable to a
  cart**, and that is a deliberate gate rather than a missing feature — see the guard
  below.
- **Every documented refusal is a typed envelope, never a 500.** The three SKU refusals
  answer the same `SKU_TAKEN` / `SKU_STOCK_CONFLICT` / `SKU_HELD_STOCK` 409s the product
  upsert already answers, carrying the operands an operator has to act on. The
  compare-and-set outcomes answer `VARIANT_NOT_FOUND` (404 — an edit is neither a create
  nor a resurrection), `STALE_EDIT` (409, with the watermark to reload from) and
  `CURRENCY_MISMATCH` (409, carrying the variant's OWN currency, which is null on the
  archetypal first pricing refused against the product's). A missing variant key is the
  400 its error's docblock has been asking for since it was written.
- **Money is integer minor units plus a currency, and absent is absent.** A declared but
  unpriced size serializes `null` — never `0`, never a zero-amount object, never
  "Free".
- **The variants read is unauthenticated, so it carries live rows only.** Orphans are
  filtered out: a discontinued size's name and its last price are the shape of a
  catalogue somebody stopped selling, and the caller this read exists for — the
  storefront picker — must not render them anyway. It publishes a coarse `inStock`
  rather than the exact on-hand count, for the reason the commerce read omits unit cost.
  Surfacing tombstones and counts is owed to the internal-token console surface.
- **The cart add endpoint now resolves its SKU instead of forwarding it.** An add that
  names a product must resolve that SKU to a live, priced sellable unit **of that
  product**. A SKU belonging to another product, to a soft-deleted product, or to a
  product with no commerce row at all is refused `SKU_MISMATCH`; a product nobody has
  priced is refused `PRODUCT_NOT_PRICED` at the Add button rather than at the quote.
  Rejected, never reinterpreted: the service does not substitute the SKU it thinks the
  caller meant.
- **A variant's SKU is resolved and then refused, until checkout can price it.**
  `createOrderFromCart` and `POST /checkout/quote` both read the snapshot price *and*
  title from the `product_commerce` row named by `productId`, and neither can reach a
  variant. Letting a size into a cart would therefore sell it at the parent's price under
  the parent's name — immutably, since an order line's snapshot is never rewritten — and
  a product whose sizes carry all the money would have no price at all and could not
  check out. The gate lifts when order pricing resolves the sellable unit rather than the
  product row; the resolution is already in place and its test is written to flip.
- **It costs nothing on the checkout path.** At most two keyed reads per request — one on
  the storefront's hot path, which is the read the route already did — never per line,
  and it touches no inventory: it runs before the domain's add, so a refused add holds no
  stock and a same-key retry of it is refused identically rather than half-applied. In
  the other direction the parity is deliberately not claimed: an accepted add whose unit
  is later orphaned, soft-deleted or unpriced answers 409 on a same-key retry instead of
  replaying the stored line, because the catalogue genuinely changed between the two
  requests. The original line and its hold are untouched.
- **A bare add (no `productId`) is unchanged, deliberately.** Resolving a bare SKU means
  asking which live sellable unit anywhere holds it, and the commerce store has no
  by-SKU lookup — every read on it is keyed by product. Such a line is also unorderable
  by construction, since both checkout paths reject a null `productId` before pricing
  anything.
- **`HttpCommerceClient` mirrors all of it**, with the variant refusals normalized onto
  `reason` like every other typed failure it returns. Every operand is nullable and none
  has a default: a `liveHolds` of `0` would deny the holds that caused the refusal, and
  an empty `currentUpdatedAt` would re-submit as a guaranteed second stale edit. Its
  cart methods gain `PRODUCT_NOT_PRICED` alongside `SKU_MISMATCH`.

**Named follow-up — a by-SKU resolver on `ProductCommerceStore`.** It is what a bare add
needs to resolve rather than be waved through, and there is a second, sharper motivation
already in the tree: the Postgres cart store's add upserts on `(cart_id, sku)` and its
`doUpdateSet` writes `product_id` from the incoming request, so a bare re-add of a SKU
already on the cart **degrades that line's `product_id` to null** — silently converting a
priced, orderable line into one checkout refuses. Guarding that properly needs the same
lookup. The store is deliberately unchanged here.
