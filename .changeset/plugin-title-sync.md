---
"@urumi/plugin": patch
"@urumi/domain": patch
---

Fix: products created through the CMS were unpurchasable — the plugin never synced their title.

Every product synced by the plugin was born with `product_commerce.title = NULL`, and an order
line snapshots the product title at purchase time, so `createOrderFromCart` rejected the checkout
with `PRODUCT_NOT_PRICED`. The buyer saw a checkout failure on a product the storefront had
happily shown as in stock and priced. The service, its request schema and the store all handled
`title` correctly the whole time; the plugin's derive simply never sent it.

The sync now sends the title on every commerce upsert, read from the collection's own **Title
field** — the same value the storefront heading renders, which the merchant already edits at the
top of the product editor. Because it lives in the shared derive, both `content:afterSave` and
`content:afterPublish` carry it.

- **There is deliberately no title input in the Product data panel.** A second place to type a
  product name would drift from the content title, and a buyer would see one name on the product
  page and a different one on the order. A hand-written `commerce.title` in the stored field JSON
  is ignored; the content title always wins. It is trimmed before it is sent.
- **A title problem never blocks the rest of the sync.** If a product has no usable title — blank,
  or a collection that names its title field something other than `title` — the upsert still
  carries SKU, price, kind and stock; only the title is omitted, with a specific warning logged
  naming `data.title`. Vetoing the upsert instead would mean such a collection silently loses
  *all* commerce sync, a worse failure than an untitled product. The title is never sent as an
  empty or over-long string either: both are 400s at the service, and a 400 is a transport
  failure, which at publish fails closed and skips the activation.
- Omitting is also safe against data loss: the store preserves a stored title when the field is
  absent from the body, so a momentarily blank title can never blank a good one.

**Known limitation — a failed title UPDATE keeps the old one, silently.** Preserve-on-omit protects
a good title, but it also masks a rejected change: rename an already-synced product to something
over 500 characters and the upsert omits the title, the store keeps the previous value, and the
"Pricing & inventory" console still shows that old, valid-looking name — no `(untitled)`, no
merchant-visible signal — while the storefront heading already renders the new one. That is the
storefront/order-line drift this change exists to prevent, arriving through a failed update rather
than a second input field. Narrow (it needs an already-titled product edited past the limit) and
not a regression against today's behaviour, but it is the sharp edge of preserve-on-omit and is
worth a test plus a merchant-visible signal in a follow-up.

**Known limitation — an untitled product still looks purchasable.** `joinProduct` derives
`purchasable` from `commerce !== null && commerce.active` and does not consider the title, while
`createOrderFromCart` rejects a null title. So a priced, active, title-less product renders with a
price and an Add to cart button and only fails at the last step of checkout. This predates the
change — it applied to every product before it — but fixing the common case turns a uniform failure
into a rare one, which is harder to reproduce. Gating `joinProduct` on the title is a follow-up.

**Existing NULL-title products heal themselves — on the next save or publish, not automatically.**
The upsert preserves a stored title only when the field is omitted, and it is sent whenever the
content has one, so the next sync writes it. EmDash bumps `updatedAt` on every content write,
which yields a fresh idempotency key, so the write applies. Concretely: a product that is not live
heals on its next **Save**; a live product heals on its next **Publish changes** (a save of live
content sends nothing, by publish atomicity). A merely redelivered hook does not heal — same
`updatedAt`, same key, deduped. There is no reconcile job, so a merchant with affected products
must re-save or re-publish each one.

`@urumi/domain`: test-only. `@urumi/domain/testing`'s `productCommerceStoreContract` gains one case
pinning that store-side heal — a row upserted without a title takes the title from any later
upsert that carries one — so the self-healing claim above is verified against every store adapter
rather than asserted from reading SQL.
