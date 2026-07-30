# 0013. Product title is CMS-owned; `product_commerce.title` is a derived single-writer cache

- Status: accepted
- Date: 2026-07-30
- Refines 0001/0002 (the hybrid product model: content in the CMS, commerce in the service)

## Context

Urumi splits a product across two databases: the CMS `products` collection owns the content
(title, description, images, slug) and `product_commerce` owns the commercial fields (sku,
price, stock, kind, tax class, dimensions, compare-at, unit cost, inventory policy). The two
databases are separate by design and there are no cross-database joins.

`product_commerce` nevertheless carries a `title` column. It is there for one reason:
`createOrderFromCart` snapshots a title onto every order line at purchase time
(`packages/domain/src/orders/create-order-from-cart.ts` — a null title is a
`PRODUCT_NOT_PRICED` rejection), and that snapshot must be readable from the commerce database
alone.

Until the "one home per field" work, **three** things wrote that column:

1. the CMS content sync (`content:afterSave` / `content:afterPublish` →
   `PUT /products/:id/commerce`);
2. the CMS "Product data" Block Kit field widget, which stored a whole commerce bag on the
   content document (removed in PR 1b);
3. an editable **Title** input on the admin console's Pricing & inventory page, which wrote
   `product_commerce` directly through `PATCH /admin/products/:id`.

Writers 1 and 3 could disagree, and the loser was always writer 3: rename a product in the
console, then save the CMS document, and the console's title silently reverted. That is the
same failure class the commerce-bag removal existed to eliminate, surviving on one field.

Two shapes fix it. Either **drop the column** and make order-line titles come from the CMS at
purchase time, or **keep the column and remove the second writer**.

### The alternative — dropping the column — was considered and rejected

Dropping it was scoped in an earlier revision of the plan: a plugin content-read surface, a
`lineTitles` checkout wire, a cross-store search rework and a forward-only `DROP COLUMN`. It
was rejected on evidence from a capability spike run against **real workerd and EmDash's real
plugin bridge**, not from reading docs.

- **The blocker people expected did not apply.** Urumi deploys **trusted in-process**
  (ADR-0006, `sites/staging/src/emdash-options.ts` declares no `sandboxed:` and no
  `sandboxRunner:`), and on that path `ctx.content` is available today under the canonical
  `content:read` the manifest already declares.
- **The blocker that does apply is the shape of the API, in _both_ trusted and sandboxed
  mode.** `ContentAccess` (`~/em-dash/packages/core/src/plugins/types.ts`, `interface
  ContentAccess`) is exactly `get(collection, id)` and `list(collection, options)`, where
  `ContentListOptions.where` is `ContentListWhere` — `{ status?, locale? }` and nothing else.
  **There is no batch-by-id and no search.** Full-text search and `findManyByIdOrSlug` exist
  only on EmDash's internal repository layer and its REST API; neither is projected to
  plugins.
- **Priced, the consequences are severe.** Admin product search would collapse to
  exact-SKU-only, losing title search — the primary way a merchant finds a product. Both the
  admin list render and the **checkout hot path** would take N *sequential* `content.get`
  calls, one per product, because there is no way to ask for a set of ids. And order-line
  titles would become caller-supplied, on an endpoint whose write gate is documented as **open
  by default** while `SERVICE_API_TOKEN` is unset (`DEPLOYMENT.md` §4, "Posture"), turning a
  structural guarantee into a paragraph.

A capability regression that large, to fix a duplication problem, is a bad trade. Removing the
second writer achieves the actual goal — divergence becomes structurally impossible — at a
fraction of the cost and with no capability loss.

## Decision

**Title is owned by the CMS `products` collection. `product_commerce.title` is a DERIVED CACHE
written through exactly ONE channel: `UpsertProductCommerceInput.title`
(`PUT /products/:id/commerce`).**

That channel has **two callers, both sourcing the value from the CMS**, so they converge rather
than diverge:

1. the `content:afterSave` / `content:afterPublish` sync — the writer in steady state;
2. `sites/staging/scripts/seed-demo-commerce.ts`, the operator-run demo seed — the README
   quickstart and `DEPLOYMENT.md` §3 ("Smoke") both instruct operators to run it. It exists
   because EmDash's seed applier creates content through the repository directly and fires no
   content hooks, so the demo products would otherwise be born `title = NULL` and unbuyable. It
   reads each title from the CMS content API before writing it, so it can only ever write what
   the sync would have written.

A third caller sourcing a title from somewhere other than the CMS would break this decision; that
is the line, not the caller count.

The column exists so `createOrderFromCart` can snapshot a title without a cross-database read. It
is never merchant-editable. Concretely:

- `UpdateProductCommerceFieldsInput` — the guarded admin edit port — **has no `title` field**.
- `editProductCommerceBody`, the service's PATCH schema, is **`.strict()`**, so a body carrying
  `title` is a 400 that names the field rather than a 200 that silently strips it.
- `UpsertProductCommerceInput.title` and `upsertProductCommerceBody.title` **stay**, and
  `upsertProductCommerceBody` is deliberately **not** strict. The asymmetry is the decision.
- The Pricing & inventory page shows **Title as a read-only row labelled `Title (set in the CMS)`**,
  exactly as it shows Status. Generalised as rule **F-2b** in `docs/admin/ADMIN-CONSOLE.md` §7, so
  the next screen with a field another system owns finds the rule rather than this ADR.

The `active` flag already worked this way, for the identical reason, and its port doc already
said so: it is the CMS publish gate, so "a merchant toggle here would be silently overwritten
by the next publish/unpublish sync". Title is now the second field with that shape, not a
special case.

### No migration

The column stays. There is no schema change, forward-only or otherwise.

## Consequences

### What this paragraph is, and is not

**This ADR is the explanation an engineer finds AFTER being stopped — it is not the guard.**
Nobody reads `adr/` before adding a field to a Block Kit form. Four things actually enforce the
decision, listed in the order they will be hit, weakest last:

1. **The port type.** `title` is absent from `UpdateProductCommerceFieldsInput`
   (`packages/domain/src/ports/product-commerce-store.ts`), so re-adding a Title input and
   wiring it through **does not compile**.
2. **A compile-time type test** — `packages/domain/test/product-commerce.type-test.ts` pins
   both halves: `title` on the edit input is a `@ts-expect-error`, and `title` on the upsert
   input is valid.
3. **The `.strict()`-backed HTTP test** —
   `packages/service/test/admin-product-edit-http.test.ts` asserts that a PATCH carrying
   `title` is a 400 naming the field **and that the stored title is unchanged**. The
   stored-value half is the part that matters: a status-only test passes just as well against a
   schema that silently strips, and would prove nothing.
4. **Two doc comments, positioned where someone is already standing.** The "Deliberately
   EXCLUDES" list on `UpdateProductCommerceFieldsInput` gains a `title` bullet pointing at this
   file by name, and a comment sits beside the read-only Title row in
   `packages/plugin/src/admin/products-page.ts` — the only guard that lives in the file a
   person would actually be editing.

### Accepted costs

- **`.strict()` is an upgrade cliff.** A deployment that versions the plugin bundle and the
  service **separately** will see an old bundle still sending `title` get a 400 on *every*
  edit, not only on title edits. That is moot for `sites/staging`, where the plugin and the
  site deploy together from one build, and it is the deliberate price of not silently dropping
  a merchant's typing. The considered alternative — `.strict()` plus an explicit
  `title: z.never()` for a narrower error — was not taken: it buys a nicer message for one
  field and leaves a second spelling of the same rule to keep in sync.
- **The cache is eventually consistent, and there is no reconcile cron.** A sync that fails
  leaves a stale `product_commerce.title` until the next save or publish of that document, and
  an order placed in that window snapshots the stale name. The hooks log loudly and say so
  (`packages/plugin/src/sync/hooks.ts`). This is unchanged by this decision and inherent to a
  cache, but it belongs in the record rather than only in a code comment.
- **The merchant has to leave the console to rename a product.** Accepted: the alternative is a
  field that appears to work and does not.
- **THE ONE GENUINE CAPABILITY REGRESSION: a collection whose title field is not named `title`
  becomes permanently unsellable, with no merchant-side fix.** The sync reads the title from
  `content.data.title` — `TITLE_FIELD` is the literal `"title"`
  (`packages/plugin/src/sync/hooks.ts`). If a products collection names that field anything else
  (`name`, `heading`, `productTitle`), `deriveTitle` finds nothing, the upsert body omits the key
  on **every** save, `product_commerce.title` stays `NULL`, and `createOrderFromCart` rejects the
  line with `PRODUCT_NOT_PRICED`. The product lists, prices and adds to a cart; only checkout
  fails.

  Before this decision a merchant had a workaround — type a title into the console's Title input
  and it stuck. **This ADR removes that workaround, and replaces it with nothing on the merchant
  side.** The only repair is a CMS *schema* change (rename the field to `title`), and the only
  signal is a service log line: `synced WITHOUT a title (…) — checkout rejects an untitled product
  with PRODUCT_NOT_PRICED`. Nothing in the admin UI says so — worse, Pricing & inventory renders
  the product as a green "active", because its sellable predicate checks sku + price + currency and
  **not** title. Tracked as
  [#166](https://github.com/UrumiAI/otta.sh/issues/166), whose fix is to add `title !== null` to
  that predicate and to the service's mirrored commerce-complete predicate, so the state at least
  renders honestly as `active (not priced)`.

  This is accepted rather than solved here because the console input was never a *fix* — it papered
  over a misconfigured collection with a value the sync could not maintain, so the product broke
  again the moment anything else re-synced it. But it was a real capability, and removing it
  without saying so would make this list dishonest.
- **`order_items.title` is untouched by all of this.** It is an immutable purchase-time
  snapshot, not a duplicate of current state; editing or renaming a product never rewrites it
  (CLAUDE.md, pinned by
  `packages/domain/test/orders/product-edit-snapshot-regression.test.ts`, which after this
  change exercises one placed order against **both** writers).

### What would change this decision

An upstream `ContentAccess` that gains **(a)** an id-set predicate on `list` (or a `getMany`)
**and (b)** a search option, both projected through the sandbox bridge. That combination
removes the N-sequential-reads cost and restores merchant title search, at which point dropping
`product_commerce.title` and sourcing order-line titles from the CMS becomes worth re-pricing.
Named here so a future reader watches for the right upstream change instead of re-deriving this
analysis.
