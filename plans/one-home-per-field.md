# Plan — "one home per field"

Branch: `refactor/commerce-bag-single-home` (worktree `/home/azureuser/otta-wt-commerce-bag`,
branched from `origin/main` @ `1413ca9`).
Status: **plan only** — no source edits in this worktree.
Revision 3. Revision 1 was reviewed by two principal engineers (both REQUEST CHANGES on the
prescriptive half); revision 2 absorbed those findings; revision 3 reflects the user's decision
after the capability spike returned. §10 records what I disagree with or would refine.

**Disposition of this file:** it lives in the tracked `plans/` directory alongside the eight
phase plans, and should be **committed as the first commit on this branch**, tagged `[Docs]`.
The phase plans are tracked and referenced from PR bodies; this is the same kind of artefact.

---

## 0. The decision, and what was rejected

### 0.1 What we are building

Three merges. `product_commerce.title` **stays**, as an explicitly-labelled **derived,
single-writer cache** whose only writer is the CMS content sync.

| # | Tag | Merge |
|---|---|---|
| **1a** | `[Domain]` | Seed a zero inventory row whenever a product has a SKU |
| **1b** | `[Plugin]` | Remove the commerce bag from CMS content |
| **1c** | `[Domain]` | Make the CMS sync title's sole writer |

Commercial fields (sku, price, stock, kind, tax class, dimensions, compare-at, unit cost,
inventory policy) end up owned solely by `product_commerce`, edited solely from the admin's
Pricing & inventory page. Content fields (title, description, images, slug) end up owned solely
by the CMS, with `title` additionally *projected* into `product_commerce` by the sync because the
order pipeline needs a snapshot source that does not require a cross-database read.
`order_items.title` is untouched throughout — it is an immutable purchase-time snapshot, not a
duplicate of current state.

### 0.2 What was considered and rejected, and why

An earlier revision of this plan scoped a second phase that would have **dropped
`product_commerce.title`** and made order-line titles caller-supplied: a plugin CMS content-read
surface, a `lineTitles` checkout wire, a cross-store search rework, and a forward-only
`DROP COLUMN`. **All of that is rejected and out of scope.** The reason is a capability gap,
established empirically by a spike against real workerd and the real EmDash bridge:

- **The capability blocker people expected did not apply.** Otta does not deploy sandboxed — it
  registers **trusted in-process** per ADR-0006 (`sites/staging/src/emdash-options.ts:12-16`,
  which deliberately declares no `sandboxed:` and no `sandboxRunner:`), and on that path
  `ctx.content` is available today with the canonical `content:read` the manifest already
  declares (`~/em-dash/packages/core/src/plugins/context.ts:1096-1100`).
- **The gap that actually kills it is the shape of the API, in *both* modes.** `ContentAccess` is
  `get(collection, id)` and `list(collection, {limit, cursor, orderBy, where})`, where `where` is
  only `{ status?, locale? }` (`~/em-dash/packages/core/src/plugins/types.ts:225-230,296-305`).
  There is **no batch-by-id and no search**. FTS and `findManyByIdOrSlug` exist only on the
  internal repository layer and the REST API; neither is projected to plugins.
- **Consequences of dropping the column, priced.** Admin product search would become
  exact-SKU-only — losing title search, which is the primary way a merchant finds a product. The
  admin list render and the checkout path would each take N sequential `content.get` calls. And
  order-line titles would become caller-supplied on an endpoint whose write gate is documented as
  open by default (`DEPLOYMENT.md:87,249,478`), turning a structural guarantee into a paragraph.

**A capability regression that severe, to fix a duplication problem, is a bad trade.** Removing
the second writer achieves the actual goal — divergence becomes structurally impossible — at a
fraction of the cost and with no capability loss. The column survives as a cache with one writer.

**This rejection needs to be written down**, which is why §2 proposes an ADR. Without it, the next
engineer sees a denormalised column beside an admin form conspicuously missing a Title field and
"fixes" it.

### 0.3 The findings that shaped what remains

1. **A title-free `afterSave` would break checkout.** `createOrderFromCart` rejects a null-title
   line (`packages/domain/src/orders/create-order-from-cart.ts:204-206`). Under the original
   brief this was a sequencing hazard; under the decision it is simply why the title sync is
   permanent. 1b writes it up as the design, not as a temporary measure.
2. **A new product can never get its first stock.** `initialOnHand` is the only caller of
   `seedOnHand` (`packages/domain/src/product-commerce/use-cases.ts:51-54`), the admin edit path
   never touches inventory, and restock 409s `NO_INVENTORY_ROW`
   (`packages/service/src/routes/admin.ts:420-422`). Remove the bag without fixing this and no
   new product can ever be stocked. → **1a**, and 1b must not land before it.
3. **Existing databases keep a stale, unbound `commerce` field.** EmDash's seed applier
   updates-or-creates fields and **never deletes** one absent from the seed
   (`~/em-dash/packages/core/src/seed/apply.ts:189-216`), and an unbound `json` field falls back
   to a raw JSON textarea (pinned today by `sites/staging/test/seed.test.ts:125`). → §4.6.
4. **The quickstart strands, before and after.** The seed applier creates content through
   `ContentRepository` directly and **fires no content hooks** (`apply.ts:457-607` contains no
   hook invocation), so the three demo products never produce a `product_commerce` row — true on
   `main` today and unchanged by 1b. → §4.7.
5. **1b introduces a spurious CAS conflict**, and with the title sync now permanent it never goes
   away. → §4.5.
6. **1b silently starts activating products it previously skipped.** → §4.4.

---

## 1. Findings — verified in this worktree

### 1.1 The bag, and the bug already pinned in the contract

**Writer A — the CMS content document.** The Block Kit field widget
(`packages/plugin/src/admin/product-data-widget.ts:72-134`) declares ten inline inputs whose
`action_id`s key a JSON bag; bound to the products collection's `commerce` json field at
`sites/staging/seed/seed.json:39-44`; registered at
`sites/staging/src/otta-plugin-descriptor.ts:46`; persisted by the editor's native Save to
`content.data.commerce`; validated at
`packages/plugin/src/product-commerce/parse-commerce-fields.ts:100-160`; derived into an upsert at
`packages/plugin/src/sync/hooks.ts:171-184`.

**Writer B — the admin console.** `packages/plugin/src/admin/products-page.ts:509-660` writes the
same fields directly to `product_commerce` via `PATCH /admin/products/:id`
(`packages/service/src/routes/admin.ts:280-340`). No write-back to the CMS.

**The clobber is already a failing-by-design contract case:**
`packages/domain/src/testing/product-commerce-store-contract.ts:1061-1117` —
`"KNOWN GAP (F4): a watermarked upsert overwrites the shared fields of a prior
updateCommerceFields edit — remove this case when #93 (F4) lands"`. It asserts a console reprice
to 5000 reverting to the widget's 9900 on the next publish. **1b is issue #93.** Deleting that
case and replacing it with its inverse is the clearest proof 1b works.

Second bug, confirmed: a CMS product with no sku never gets a row at all (`hooks.ts:176` —
`if (body.sku === undefined) return { kind: "skip" }`), so it is invisible in Pricing & inventory.

### 1.2 Title: three writers today, one after 1c

- **CMS sync** — `readContentTitle` (`hooks.ts:70-75`) reads `content.data.title`, validated by
  `parseProductTitle` (`parse-commerce-fields.ts:63-78`), attached in the shared derive
  (`hooks.ts:181-183`) so both `afterSave` and `afterPublish` carry it. **This one survives, and
  becomes the sole writer.**
- **Admin edit form** — an editable `text_input` at `products-page.ts:547-552`, read at
  `:753-754`, folded into the idempotency key at `:858`, sent at `:905`; wire type at
  `packages/plugin/src/admin/admin-products-client.ts:100`; schema at
  `packages/service/src/schemas.ts:401`; applied at `packages/service/src/routes/admin.ts:310`;
  port field at `packages/domain/src/ports/product-commerce-store.ts:200`. **Removed by 1c.**
- **Integrator PUT** — `upsertProductCommerceBody.title` (`schemas.ts:325-326`) →
  `routes/product-commerce.ts:60` → `UpsertProductCommerceInput.title`
  (`product-commerce-store.ts:151-157`). **Stays** — it *is* the sync's channel.

The admin page's own help text at `products-page.ts:409` already says *"Titles/images are also
managed in the CMS"*, three lines above the editable Title input. 1c makes the UI honest.

### 1.3 `active` is the precedent for a read-only display row

`UpdateProductCommerceFieldsInput` already excludes `active` deliberately, with the reasoning
written out at `product-commerce-store.ts:182-191`: it is the CMS publish gate, *"a merchant
toggle here would be silently overwritten by the next publish/unpublish sync, so `active` is NOT
a domain-owned editable field — it is edited by publishing the CMS document, not on this page."*
That is word-for-word the argument for `title` after 1c. In the UI, `active` appears as a
read-only row (`products-page.ts:365`, `{ label: "Status", value: statusLabel(p) }`) and has no
form field. Title should land in exactly that shape.

### 1.4 `product_kind` is `NOT NULL` with no DB default

`packages/store-postgres/src/migrations/0002_product_commerce.ts:51`; the domain supplies
`"physical"` when omitted (contract case at `product-commerce-store-contract.ts:975`). So after
1b a bare row created by a CMS save is **physical by default**, and a merchant selling a digital
product must set the kind in Pricing & inventory. That is a real step in the new merchant flow →
it belongs in the manual walk (§8).

### 1.5 The service boundary rejects float money at runtime

The product-price money schemas are `packages/service/src/schemas.ts:321`
(`upsertProductCommerceBody.price.amount`, `z.number().int().nonnegative()`), `:397`
(`editProductCommerceBody.price.amount`, `int().positive()`), and `:409` / `:413`
(`compareAtPrice` / `unitCost`, `int().nonnegative()`). A float price is a **400 before any
domain code runs**. This is what makes the CMS-path money assertions safe to delete in 1b (§7.2)
— `product-commerce.type-test.ts` is compile-time and could never have covered a float arriving
as JSON, which was the right thing to be suspicious of.

**Do not cite `schemas.ts:294`** — that is `x402ProofBody.amount`, the x402 settle body, not a
product price. An earlier revision of this plan cited it; the conclusion was unaffected but the
citation was wrong, and §7.2 asks the implementer to copy these line numbers into the PR body
verbatim.

### 1.6 The admin edit's idempotency key is content-derived, client-side

`products-page.ts:852-869` (`deriveEditIdempotencyKey`) hashes a canonical JSON of the whole wire
— **including `wire.title` at `:858`** — and `admin-products-client.ts:198` sends it as
`Idempotency-Key`. The service prefers that header and only falls back to
`admin:product-edit:${productId}:${expectedUpdatedAt}` when it is absent
(`routes/admin.ts:296-299`). Both paths are deterministic per submission. This matters twice: it
is the load-bearing link in 1a's self-heal argument (§3.2), and the `title` component must come
out of the canonical payload in 1c (§5).

### 1.7 Where the brief was wrong

| Brief said | Actual |
|---|---|
| "Initial stock: verify the restock path works from a bare zero-stock row" | It does **not** — the row does not exist and nothing else creates it (§0.3.2). → 1a |
| "every CMS product appears there, unpriced, ready to be priced" | True for **editor-saved** products only. Seeded content fires no hooks (§0.3.4), so the demo products still produce no row |
| "content:afterSave becomes lifecycle-only… no commercial data" | Correct for *commercial* data; the **title keeps flowing**, permanently (§0.3.1) |
| "`products-page.ts:547-552`" | Confirmed exact; the read is `:753-754`, the key component `:858`, the send `:905` |
| "`create-order-from-cart.ts` ~line 197/219" | The null-title reject is `:204-206`; the assignment `:226`; the bulk fetch `:195-200` |

---

## 2. ADR-0013 — proposed

**Title:** *Product title is CMS-owned; `product_commerce.title` is a derived single-writer cache.*
**Status:** proposed, to land with 1c (or ahead of it).
**Numbering:** next free after `adr/0012-storefront-checkout-loads-stripe-elements-in-the-browser.md`.

**Must record:**

1. **The decision.** Title is owned by the CMS `products` collection. `product_commerce.title` is
   a *derived cache* maintained by exactly one writer — the `content:afterSave` /
   `content:afterPublish` sync. It exists so `createOrderFromCart` can snapshot a title without a
   cross-database read, which the architecture forbids (README: separate databases, no cross-DB
   joins). It is never merchant-editable.
2. **Why the alternative — dropping the column — was rejected**, with the spike's findings cited:
   `ContentAccess` has no batch-by-id and no search in either trusted or sandboxed mode
   (`~/em-dash/packages/core/src/plugins/types.ts:225-230,296-305`); FTS and
   `findManyByIdOrSlug` live on the internal repository and the REST API and are not projected to
   plugins; so dropping the column would reduce admin product search to exact-SKU-only and put N
   sequential `content.get` calls on both the admin render and the checkout path. Also record
   that caller-supplied order-line titles would have removed a structural guarantee on an endpoint
   whose write gate is documented as open by default (`DEPLOYMENT.md:87,249,478`).
3. **What would change the decision:** an upstream `ContentAccess` gaining an id-set predicate on
   `list` (or a `getMany`) plus a search option. Name it, so a future reader knows what to watch
   for rather than re-deriving the analysis.
4. **The consequence for the admin UI:** the Pricing & inventory page shows Title as a read-only
   row, exactly as it shows Status, for the reason already written at
   `product-commerce-store.ts:182-191`.

   **This paragraph is the explanation, not the guard.** Nobody reads `adr/` before editing a
   Block Kit form. The actual enforcement, in the order it will be hit, is:
   (i) the **port type** — `title` is absent from `UpdateProductCommerceFieldsInput`, so re-adding
   the input does not compile;
   (ii) the **re-add guard test** (§7.3), which fails if the wire starts accepting it;
   (iii) the **"Deliberately EXCLUDES" bullet** in
   `packages/domain/src/ports/product-commerce-store.ts:182-191`, which is the doc a developer is
   already reading when they touch the type — reference it by literal path, never as "see the
   ADR";
   (iv) **a one-line comment beside the read-only Title row at
   `packages/plugin/src/admin/products-page.ts:354`**, pointing at this ADR. That is the only
   guard that lives in the file someone would actually be editing, and it is the cheapest of the
   four. It must not be skipped.
5. **The residual divergence window:** the cache is eventually consistent. A failed sync leaves a
   stale title until the next save/publish, and there is no reconcile cron
   (`hooks.ts:264-266`). Honest, unchanged by this work, and worth stating in the ADR rather than
   only in a code comment.

No other ADR is required by this scope. (Revision 2 proposed two more — one for a plugin
content-read surface, one for caller-supplied titles — both moot.)

---

## 3. PR 1a `[Domain]` — seed a zero inventory row whenever a product has a SKU

### 3.1 The invariant

*A product with a SKU has an inventory row.* Make it true of the **type**, not of one caller:
both write paths seed. Today neither does unless a stock figure is supplied, which after 1b means
never.

### 3.2 The safety argument — name the mechanism

The rationale is inherited from `upsertProductCommerce` (`use-cases.ts:22-35`: two IO calls, no
shared transaction, so always-attempt a create-if-absent seed rather than gating on "the sku was
just set"). But `updateCommerceFields` is a **CAS, not an upsert**: if the edit commits and the
seed then throws, `updated_at` has already moved, so a naive retry would be `stale` and the
product would be permanently stranded with a SKU and no inventory row.

It self-heals, but only through a three-link chain that must be stated in the code and the PR
body, because **this chain is the entire safety argument**:

1. `kysely-product-commerce-store.ts:310-320` — when the guarded UPDATE matches zero rows, a
   follow-up SELECT classifies the no-op in a fixed order: **`not_found` → replay → stale →
   currency_mismatch**. The fake mirrors it, and the port doc pins the order
   (`product-commerce-store.ts:396-433`).
2. So a **same-key** retry hits the *replay* branch and returns `ok` **ahead of** the staleness
   check, carrying the stored row.
3. And a retry of the same submission **is** same-key: the plugin derives the key from the wire's
   content (`products-page.ts:852-869`) and sends it as `Idempotency-Key`
   (`admin-products-client.ts:198`); a client that sends no header gets the service's
   deterministic fallback `admin:product-edit:${productId}:${expectedUpdatedAt}`
   (`routes/admin.ts:296-299`).

Result: the retry returns `ok`, the always-attempt seed runs again, and it lands. Encode this as
a test (§7.1), not just a comment.

**Be precise about *which* retry this is, in both the comment and the test name.** The merchant
clicking Save again is **not** the same-key path: `deriveEditIdempotencyKey` includes
`expectedUpdatedAt` (`products-page.ts:855`), and the save handler calls `showLeaf`, which
reloads the fresh detail (`:905-907`) — so the re-submit carries a *new* watermark, hence a *new*
key, and heals through the ordinary CAS path instead. The **replay** branch covers a double-click
or a transport-level retry of the byte-identical request. Both routes heal, so the conclusion
stands either way; but a comment implying "Save again" is the same-key path would send the next
reader looking for behaviour that is not there, and the test should be named for a double-submit.

### 3.3 Files, in dependency order

1. **Tests first** — `packages/domain/test/product-commerce-use-cases.test.ts`, red before code.
   Cases in §7.1.
2. `packages/domain/src/product-commerce/use-cases.ts`:
   - `:51-54` → seed unconditionally when a sku is known:
     `if (seedSku !== undefined) await deps.inventory.seedOnHand(seedSku, initialOnHand ?? 0);`
     One line. `seedOnHand` is a single-statement `INSERT … ON CONFLICT (sku) DO NOTHING`
     (`packages/domain/src/ports/inventory-store.ts:94`), contract-proven never to clobber an
     existing or decremented `on_hand`, so `?? 0` cannot damage a stocked product. This closes
     the integrator hole: `PUT /products/:id/commerce` with a sku and no `initialOnHand` no
     longer mints a SKU with no inventory row.
   - `updateProductCommerceFields` takes `ProductCommerceDeps` (store + inventory) instead of a
     bare `ProductCommerceStore`, and after an `ok` result seeds `row.sku` at `0` when non-null.
     Always-attempt; never gated on "the sku changed".
   - Document the §3.2 chain in the function doc.
3. `packages/service/src/routes/admin.ts:302` — pass
   `{ productCommerce: deps.productCommerce, inventory: deps.inventoryStore }`.
   **The field is `inventoryStore`** — confirmed at `admin.ts:83-85`, whose doc comment ("never
   used by the list") now needs a second sentence.
4. `packages/plugin/src/admin/products-page.ts:1032-1038` — rewrite the `no_inventory_row` copy.
   It currently reads *"Initial stock is set when the product is first priced in the CMS"*, which
   after 1b describes a flow that does not exist. The state becomes a should-never-happen; keep
   the branch as defence and say so.

### 3.4 Rejected alternative

Fixing it in the restock route (`admin.ts:391-422`) by seeding-then-adding would be two
non-atomic writes behind one endpoint and would leave `updateCommerceFields` still able to mint a
SKU with no inventory row. The invariant should hold for the data, not for one caller.

### 3.5 Known gap deliberately not fixed

Renaming a SKU seeds a fresh zero-stock row and strands the old one.
`upsertProductCommerce` already behaves this way, so 1a does not introduce it — but 1a does make
it slightly more reachable, since the console becomes the only SKU writer. Name it in the PR body
and file it (§9.7 issue 2).

### 3.6 1a's PR checklist

Beyond the standard gate (tests, lint, format, changeset), 1a carries one extra line item:

- [ ] **All four follow-up issues in §9.7 are filed** — CAS churn, SKU-rename stranding,
      priced-but-untitled, quote/place asymmetry. They are deliberate scope exclusions, and they
      become artefacts here, before the first merge, rather than prose that evaporates when this
      plan is archived.

---

## 4. PR 1b `[Plugin]` — remove the commerce bag from CMS content

### 4.1 Tag, and why

The merge spans `packages/plugin` + `sites/staging` + several `*.md`, which CLAUDE.md's table
maps to `[Plugin]`, `[Site]` and `[Docs]`. **Use `[Plugin]`**, and justify it in the PR body: the
plugin change is the decision; the site and docs changes are strictly consequential — the seed
field and the descriptor entry exist *only* to feed the widget, and the doc edits only stop
describing a deleted thing. Naming the choice keeps it from reading as tag sloppiness.

### 4.2 Scope statement for the PR body

The CMS stops storing **commercial** data. It continues to own and sync the **title** —
permanently, as the sole writer once 1c lands (ADR-0013). Pricing & inventory becomes the sole
editor of sku, price, currency, stock, kind, tax class, dimensions, compare-at, unit cost and
inventory policy.

### 4.3 Files, in dependency order

**A. Kill the bag validator, keep the title validator.**

1. **New** `packages/plugin/src/sync/parse-product-title.ts` — move `parseProductTitle`,
   `ParsedProductTitle` and `TITLE_MAX_LENGTH` verbatim from
   `packages/plugin/src/product-commerce/parse-commerce-fields.ts:34-78`. It belongs in `sync/`:
   it is purely a content-sync concern and its current home is about to stop existing.
2. **Delete** `packages/plugin/src/product-commerce/parse-commerce-fields.ts` (`CommerceFieldBag`
   `:18-29`, `parseCommerceFields` `:80-160`). Only importer today is `sync/hooks.ts:11-14`.

**B. Kill the widget.**

3. **Delete** `packages/plugin/src/admin/product-data-widget.ts`.
4. `packages/plugin/src/index.ts:4` — remove the
   `buildProductDataElements, productDataWidget` export, and fix the barrel header at `:1-3`,
   which advertises "the widget's pure element-builder".
5. `sites/staging/src/otta-plugin-descriptor.ts` — remove the import, the `fieldWidgets` property
   (`:46`) and the comment at `:40-45`. Drop the `FieldWidgetConfig` import if now unused.
6. `sites/staging/seed/seed.json` — delete the `commerce` field object (`:39-44`) and rewrite
   `meta.description` (`:6`), which advertises the widget.

**C. Rewrite the hooks.**

7. `packages/plugin/src/sync/hooks.ts`:
   - delete `COMMERCE_FIELD` (`:28`), `readCommerceField` (`:34-41`), `DerivedCommerce`
     (`:137-148`), `deriveCommerce` (`:171-184`);
   - add `deriveTitle(content)` → `{ title } | { problem }` from `readContentTitle` +
     `parseProductTitle`. `readContentTitle` (`:70-75`) and the `TITLE_FIELD` doc block
     (`:43-64`) stay — that doc is now *more* load-bearing, because `data.title` becomes the
     single source of the cache;
   - `createAfterSaveHandler` (`:268-349`): the `hasPendingDraft` early return stays **exactly as
     is** (§6.3). The `invalid` branch (`:294-300`) and the `skip` branch (`:303`) go — with no
     bag there is no validation rejection and no no-sku skip. The body becomes `{}` or
     `{ title }`, plus `contentUpdatedAt`. The `titleProblem` warning (`:308-312`) stays. The
     activate block (`:335-341`) stays — **but see §4.4, it is not behaviour-neutral**;
   - `createAfterPublishHandler` (`:427-504`): same edits. The two failure postures documented at
     `:401-425` collapse to one — there is no validation failure left, so only the fail-closed
     transport branch (`:485-494`) survives. Ordering (upsert first, then activate) unchanged and
     still load-bearing: it is what guarantees the row exists before `activate`, which no-ops on
     an unknown id (`product-commerce-store.ts:469-473`);
   - `createAfterUnpublishHandler` (`:529-559`) and `createAfterDeleteHandler` (`:357-367`):
     unchanged;
   - **rewrite the module docs.** ~180 lines of prose describe a mechanism being deleted. In this
     repo those comments are treated as load-bearing; a merge that deletes the mechanism and
     leaves the prose is worse than one that does neither.

**D. The watermarks.**

- `contentUpdatedAt` (sync-ordering, `UpsertProductCommerceInput.contentUpdatedAt` →
  `product_commerce.content_updated_at`): **stays load-bearing permanently.** The upsert still
  carries a real field — the title — and out-of-order hook delivery must not reinstate an older
  one. (Revision 2 planned to retire it; with the column staying, it stays.) **This is also why
  the sync idempotency key must stay distinct per save — see §4.5**, which is the whole reason
  the CAS churn cannot be fixed by keying on the payload.
- The **publish-gate** watermark (`active_updated_at`, `migrations/0004_*`): untouched.
  Opposing flips on one boolean delivered by independent fire-and-forget POSTs
  (`product-commerce-store.ts:449-483`; contract cases `:871-937`).
- `normalize-watermark.ts` survives.

### 4.4 State the activation change

Today `afterSave` returns before the activate when the derive skips, and `afterPublish`'s
activate no-ops on a nonexistent row. After 1b the row always exists first, so **every published,
unpriced, sku-less CMS product becomes `active: true`** — a state that could not previously
occur.

Verified benign for purchasability: `listCommerceByIds` filters commerce-incomplete rows in SQL
(`packages/store-postgres/src/kysely-product-commerce-store.ts:265-271` —
`sku is not null`, `price_cents is not null`, `price_currency is not null`), so such a product is
absent from the catalog wire and `joinProduct` reports `purchasable: false`.

**Not** benign for the admin's status column, which will now show "Active" for a product that
cannot be sold. So: put it in the PR body, pin it with the test in §7.2, and change `statusLabel`
to distinguish the state — "active (not priced)" or equivalent. That copy change is in scope
precisely because 1b creates the state.

**Size it honestly before starting.** `statusLabel` today is
`(p: { active: boolean; deletedAt: string | null })` (`products-page.ts:158-161`) and has **no
access to price or sku**, so this is a signature change plus every call site, not a one-line
string edit. Its own doc comment names three consumers — the list table, the "Open product"
picker (`:290`), and the detail fields row (`:365`) — and it exists precisely so those three
cannot disagree. The data it needs is already on `ProductSummary` (`price`, `sku`), so widening
the parameter is mechanical; just do not discover it mid-implementation.

### 4.5 The CAS churn is a filed issue, NOT scope — and the keys do not change

**Keep `deriveSaveIdempotencyKey` exactly as it is** (`derive-idempotency-key.ts:53-63`),
including the emdash-#2143 `version` component and the reasoning at `:12-51`, which stays as
live code documentation rather than becoming PR-body prose. `derivePublish` /
`deriveUnpublish` / `deriveDelete`: unchanged. **No idempotency-key change in 1b.**

**The symptom.** After 1b the only sync payload is the title, so a description edit or an image
swap still mints a new key (because `version` moves on every save), applies a no-change upsert,
bumps `product_commerce.updated_at`, and invalidates the `expectedUpdatedAt` carrier in any open
Pricing & inventory form (`products-page.ts:540-546`) — a spurious "This product changed since
you opened it" that does not occur today. Real, and with the title sync permanent it does not
age out.

**Why the obvious fix is wrong, recorded so nobody re-proposes it.** An earlier revision of this
plan proposed a *payload-derived* key (hash the title, so an unchanged title replays and no-ops).
Both reviewers independently derived the same data-corruption failure from it, and the mechanism
is verified at `packages/store-postgres/src/kysely-product-commerce-store.ts:134-181`:

Guard 1 (`.where("product_commerce.idempotency_key", "!=", key)`, `:171`) and Guard 2 (the
watermark comparison, `:176-178`) are two `.where()` clauses on the **same**
`onConflict().doUpdateSet()`. They are ANDed, so a Guard-1 hit no-ops the **whole** statement —
including `content_updated_at: eb.ref("excluded.content_updated_at")` inside the SET block at
`:165-167`. A title-unchanged save would therefore leave the stored watermark **behind real
time, permanently**.

The failure sequence:

1. stored `title="A"`, `key=K(A)`, `content_updated_at=T1`;
2. merchant renames to `"B"` at T2, then back to `"A"` at T3;
3. delivery reorders — T3 arrives first. `K(A) == K(A)` ⇒ Guard 1 fails ⇒ **total no-op**, the
   watermark stays at T1;
4. the delayed T2 lands. `K(B) != K(A)` passes Guard 1, and `T2 >= T1` passes Guard 2 ⇒ it
   **applies**;
5. final cached title `"B"`; CMS truth `"A"`. Nothing self-heals — the cache is only rewritten on
   the next title change, and there is no reconcile cron (`hooks.ts:264-266`).

That value is the snapshot source for `order_items.title`, so it reaches receipts, admin order
views, emails and the Stripe PaymentIntent description. It also directly contradicts §4.3 D,
which calls `contentUpdatedAt` load-bearing *permanently* for exactly this reordering scenario:
the payload-derived key would have disarmed the guard it depends on. Today's key is distinct per
save, so Guard 1 always passes and the watermark always advances — **the churn is the price of
that correctness.**

**What to do instead.** File the churn as an issue (§9.7 lists owner and timing). Record in it
the recommended future fix: make `updated_at` in the `DO UPDATE SET` conditional on an *owned
column genuinely differing*, while `content_updated_at` continues to advance unconditionally.
That is the correct seam — it fixes the console-edit path too — but it is an `[Adapters]` +
contract change needing cases on both dialects and a SQLite portability answer (no
`IS DISTINCT FROM`), so it does not belong in 1b.

Two facts for the issue, both verified: `idempotency_key` is `text NOT NULL` with **no length
bound** on either dialect (`packages/store-postgres/src/migrations/0002_product_commerce.ts:54`),
so key width never constrained the design; and the row's single shared `idempotency_key` column
(`product-commerce-store.ts:302-304`) means an intervening `activate` or console edit overwrites
the stored key, which any future keying scheme has to account for.

**In the 1b PR body:** state that the churn is known, that its recovery verb is reloading the
form, and link the issue.

### 4.6 The stale `commerce` field on existing databases

Removing the field from `seed.json` does not remove it from a database that already has it:
`~/em-dash/packages/core/src/seed/apply.ts:189-216` iterates `collection.fields` and
updates-or-creates only. The field survives, loses its widget binding, and — per the behaviour
`sites/staging/test/seed.test.ts:125` pins today — falls back to EmDash's default editor: a raw
JSON textarea labelled "Commerce" holding the old sku/price bag. Editable, silently ignored,
strictly worse than the confusion being removed.

**The cleanup is settled, not an open question.** `SchemaRegistry.deleteField`
(`~/em-dash/packages/core/src/schema/registry.ts:834-877`) does **all three** things in one
transaction: deletes the `_emdash_fields` record, re-syncs the FTS triggers, and **drops the
column from the content table**. So it does cascade to stored values — the old bag is gone, not
orphaned. It is reachable against **deployed** CF staging, because the CLI client is HTTP
(`~/em-dash/packages/core/src/client/client-factory.ts:51-56` — `--url` / `EMDASH_URL` plus a
token):

```bash
emdash schema remove-field products commerce --url https://<staging-host>
```

**On a fresh install the command is a safe no-op** (there is no such field to remove), so the
same sentence serves both audiences and the note does not need to branch. Say that explicitly —
otherwise every new user wonders whether it applies to them.

**Disposition — do all three:**

1. **Ship the cleanup step** in the PR body and in a short `## Upgrading` note.
2. **Run it on CF staging as part of the merge**, and say so in the PR body. Our own staging is an
   existing site and would otherwise carry the artefact.
3. **Ship this release-note sentence** (drafted here so it gets reviewed rather than written at
   merge time):

   > If your site was seeded before this release, the Products collection keeps an unused
   > "Commerce" JSON field showing the old pricing data. It is ignored — pricing now lives in
   > **Pricing & inventory**. Remove it with
   > `emdash schema remove-field products commerce` (a no-op on a fresh install).

### 4.7 Own the merchant flow — the quickstart

The three seeded demo products produce no `product_commerce` row today and will not after 1b: the
seed applier creates content through `ContentRepository` directly and fires no hooks
(`~/em-dash/packages/core/src/seed/apply.ts:457-607`). So the headline "every CMS product appears
in Pricing & inventory" is true only for **editor-saved** products, and a naive README rewrite
would send a new user to a page where the demo products are absent — turning today's one-step
pricing into six steps with an unguessable "open each demo product and save it once to fire the
hook" in the middle.

**Fix: a small script — and it is SIX calls per product-set, not three.** Pricing alone leaves
the demo products **not purchasable**: `upsert` inserts with `active: 0`
(`packages/store-postgres/src/kysely-product-commerce-store.ts:126`) and the port doc is explicit
that it "deliberately never touches `active`" (`product-commerce-store.ts:443-447`), while
purchasability is `commerce !== null && commerce.active`
(`packages/plugin/src/catalog/join-product.ts:60-62`). Three `PUT`s would produce three priced,
listed, **unbuyable** products — precisely the outcome this section exists to escape.

So each product needs two calls:

1. `PUT /products/:id/commerce` — body `{ sku, price, initialOnHand }`, header
   `Idempotency-Key` (`routes/product-commerce.ts:34-82`);
2. `POST /products/:id/commerce/activate` — its **own** `Idempotency-Key` header **and** a body
   `{ contentUpdatedAt }` in strict `Date.toISOString()` form, which
   `lifecycleProductCommerceBody` validates by regex (`packages/service/src/schemas.ts:365-372`)
   — a loose date string is a 400.

**Both are non-GET**, so they need `X-Service-Token` if the reader set `SERVICE_API_TOKEN`
(`packages/service/src/auth.ts:54-70`). Say so in the script and the README step; a reader who
followed the deployment guide will have set it.

**Write it as a script under `sites/staging/`, not as curls in the README**, and **derive the
three content ids from `seed/seed.json`** rather than hard-coding them. Hard-coded ids drift
silently and reproduce the empty page this section exists to prevent; reading them from the seed
makes drift fail loudly. (The current ids are `product:otta-tee`, `product:otta-mug`,
`product:otta-stickers` — `seed/seed.json:62,71,80` — but the script should not know that.)

That restores the quickstart to "boot, seed, browse, **buy**", and it exercises the integrator
path we are keeping alive, which is a bonus.

Alternatives weighed and rejected for this merge: *sourcing the Pricing & inventory list from the
CMS* would make the admin list a cross-store join and needs the content surface the spike ruled
out; *adding a "create commerce row" admin entry point* is new UI for a problem ten lines of seed
script solves.

**§8's manual walk must reproduce the quickstart path**, not just the editor path.

### 4.8 Documentation

**Rewrite:** `README.md:19` ("an on-screen 'Product data' panel"), `README.md:67-68` (per §4.7),
`DEVELOPMENT.md:86` (the Block-Kit-not-React rule survives; the example does not),
**`DEPLOYMENT.md:315`** ("via the Product data panel"),
**`adr/0001-plugin-plus-commerce-service.md`** ("on-screen product-data field widget", `:34`) —
**append a marked `Amended YYYY-MM-DD` block pointing at ADR-0013; do NOT edit the original
Decision prose.** The original must stay legible as what was decided at the time, which is the
principle `adr/README.md` already states. A silent in-place edit destroys the record; an
amendment block preserves it,
**`packages/plugin/src/plugin.ts:73`** (names `admin/product-data-widget.ts` as a source of truth,
alongside a reference to the long-retired `panel-state-route.ts`),
`packages/plugin/src/index.ts:1-4` (per B), `products-page.ts:409` (add that stock is now set
here).

**Deliberately NOT rewritten**, and say so in the PR body: `plans/phase-1-*.md:21,64,241,346,348,475`,
`plans/phase-2-*.md:95`, `plans/phase-7-*.md:13`. Those are **historical records** — phase plans
that were executed. Editing them to match a later refactor falsifies the record.

> **Correction, applied during 1b's implementation.** The paragraph above originally also listed
> `.changeset/plugin-title-sync.md:19` and `.changeset/publish-atomicity.md:32` as historical
> records, on the reasoning that "changesets are release notes for shipped versions". **That
> premise is false in this repository and was wrong when written.** No package here has a
> `CHANGELOG.md`, every package is at `0.0.1`, and `.changeset/` holds 60+ **unconsumed**
> changesets. They have not shipped: they will all be concatenated into the first CHANGELOG entry
> this project ever emits, alongside 1b's own. Leaving them would make one release note say both
> "the Product data panel now shows…" and "the panel is deleted", and — worse —
> `publish-atomicity.md` hands a merchant a recovery verb pointing at a UI that will not exist in
> the release it ships in. Nothing is falsified by fixing them, because nothing has shipped.
>
> **The rule for this repo:** an *unconsumed* changeset is pending release copy and must stay
> true of the release it will ship in; a *consumed* one (once a `CHANGELOG.md` exists) is a
> record and must not be edited. Phase plans in `plans/` are records either way.
>
> 1b therefore corrected all three affected changesets: `publish-atomicity.md`,
> `seed-inventory-on-first-sku.md` (PR 1a's own, written days earlier — pending notes, not
> history) and `plugin-title-sync.md`. The last was nearly left on the grounds that it records a
> *decision* rather than an instruction, but the rule above lands on it squarely and exempting it
> would make the rule's first application an exception to itself. The decision it records survives
> 1b intact, so it needed only a phrase: "no title input in the Product data panel" became "no
> second place to type a product name".

**This file is one of them.** Once `plans/one-home-per-field.md` merges it becomes a historical
record too: the plan as approved, including the options weighed and rejected. Later refactors
should supersede it with a new plan and an ADR, not edit it to match what the code became. The
same rule, applied to itself.

---

## 5. PR 1c `[Domain]` — make the CMS sync title's sole writer

### 5.1 Shape

Title becomes a read-only display row on the Pricing & inventory page, exactly as `active`/Status
is today (§1.3), and the write path is removed at every layer. `UpsertProductCommerceInput.title`
**stays** — that is the sync's channel.

### 5.2 Files, in dependency order

1. **ADR-0013** (§2) — land it with this merge, or ahead of it.
2. `packages/domain/src/ports/product-commerce-store.ts`:
   - remove `UpdateProductCommerceFieldsInput.title` (`:200`);
   - extend the "Deliberately EXCLUDES" list at `:182-191` with `title`, using the same reasoning
     the `active` bullet uses — a merchant edit here would be silently overwritten by the next
     CMS sync — and point at ADR-0013;
   - relabel `ProductCommerce.title` (`:277-278`) from *"Snapshot source for an order line's
     title"* to name it a **derived cache with a single writer (the content sync)**, and make the
     same edit on `UpsertProductCommerceInput.title` (`:151-157`), which currently calls it
     "the commercial projection of the CMS content title" — nearly right, but it should say
     explicitly that this is the only channel that may write it.
3. `packages/domain/src/testing/in-memory-product-commerce-store.ts:257` — drop the `title` branch
   from the update path (the upsert path at `:133,:154` stays).
4. `packages/store-postgres/src/kysely-product-commerce-store.ts:337` — drop
   `if (input.title !== undefined) set.title = input.title;` from `updateCommerceFields`. The
   upsert's title handling (`:93,:111,:145`), the list projection (`:530,:579`) and `toDomain`
   (`:623`) all stay.
5. `packages/service/src/schemas.ts:401` — remove `title` from `editProductCommerceBody`.
   `upsertProductCommerceBody.title` (`:325-326`) stays.
6. `packages/service/src/routes/admin.ts:310` — remove the `title` branch from the PATCH.
7. `packages/plugin/src/admin/admin-products-client.ts:100` — remove `title` from
   `ProductEditWire`.
8. `packages/plugin/src/admin/products-page.ts`:
   - delete the Title `text_input` (`:547-552`);
   - delete the read (`:753-754`);
   - **delete `wire.title ?? null` from the canonical payload in `deriveEditIdempotencyKey`
     (`:858`)** — easy to miss, and leaving it would keep a removed field in the key derivation;
   - the read-only display rows at `:354` (`{ label: "Title", … }`) and the detail header at
     `:376` **stay** — that is the `active`/Status precedent;
   - update the form's help copy at `:409`, which already says titles are CMS-managed; it can now
     say so without contradicting the form beneath it.

### 5.3 Reject a `title` in the PATCH — and say why in the schema

Zod's default object behaviour **strips** unknown keys, so simply deleting `title` from
`editProductCommerceBody` makes a stale client's title vanish silently behind a 200 — the failure
mode most likely to be misread as "it saved". Reject instead.

**Compatibility is verified, not assumed:** `editProductCommerceBody`'s key set is exactly
`ProductEditWire`'s (`packages/plugin/src/admin/admin-products-client.ts:97-112`), including
`inventoryPolicy`, and the schema has a single consumer (`packages/service/src/routes/admin.ts:285`).
So `.strict()` breaks nothing today.

**Two things to decide and write down rather than leave to luck:**

1. **The upgrade cliff.** `.strict()` *plus* the removal of `title` means an **old plugin bundle
   sending `title` gets a 400 on every edit**, not only on title edits. That is moot for
   `sites/staging`, where the plugin and the site deploy together from one build — but it is a
   real constraint for any deployment that versions them separately, and it should read as a
   decision in the PR body, not as an accident. If the sharper error is wanted *without* the
   cliff, the alternative is `.strict()` **plus an explicit `title: z.never()`**: a precise
   "title is not editable here" rejection for the one removed field, while other unknown keys
   still fail loudly. Either is defensible; pick one and say which.
2. **The asymmetry with `upsertProductCommerceBody`.** That schema is **deliberately NOT strict**
   and deliberately **keeps `title`** (`packages/service/src/schemas.ts:325-326`) — it is the
   sync's channel, the one writer ADR-0013 sanctions. Put a one-line comment on each schema
   saying so, so the difference reads as intent rather than as an inconsistency someone
   "tidies up".

**Add a one-line comment at `editProductCommerceBody` stating that the strictness is deliberate
and why** — otherwise the next reader deletes it as noise, and the guard evaporates without a
test failing (nothing breaks when `.strict()` is removed; things merely start passing silently).

The test asserts **the stored value is unchanged after the PATCH**, not just the status code —
see §7.3.

### 5.4 Sequencing note

1c is genuinely independent of 1a and 1b: it touches the *admin edit* path, while 1a touches the
*inventory seed* and 1b touches the *sync*. It could land first. **I recommend 1a → 1b → 1c
anyway**, for two reasons. (i) 1b is the merge with the merchant-visible artefacts (§4.6, §4.7)
and the manual walk; doing it while the admin form still has a Title input means the walk exercises
the *old* admin surface, and any breakage is attributable to 1b alone. (ii) 1c's headline
justification — "the CMS sync is the sole writer" — is only *true* once 1b has landed and the bag
is gone; landing 1c first would put an ADR into the tree asserting something the code does not yet
do. If the manager wants 1c first for scheduling reasons it is safe, but ADR-0013 should then land
with 1b.

---

## 6. Decisions carried forward

### 6.1 `PUT /products/:id/commerce` — KEEP

It is the plugin's own sync channel and the only row-create path (`updateCommerceFields` refuses
to mint — `product-commerce-store.ts:396-403`); it is the only `initialOnHand` seed and now the
quickstart's demo-row path (§4.7); it is 1:1 with the port, which is DEVELOPMENT.md §3's rule; and
deleting it would delete the upsert half of the store contract — real coverage of idempotent
replay, field-partial preservation, stale-watermark rejection and the live-SKU partial index. It
keeps `title`, which is the whole point of 1c.

### 6.2 Idempotency keys

| Key | Change |
|---|---|
| `deriveSaveIdempotencyKey` | **unchanged**, `version` component included — a payload-derived key would disarm the watermark guard and corrupt the cache (§4.5) |
| `derivePublish` / `deriveUnpublish` / `deriveDelete` | unchanged |
| `deriveEditIdempotencyKey` (admin) | **1c:** drop the `title` component (`products-page.ts:858`) |

The only idempotency-key change in the whole scope is 1c's one-line removal.

### 6.3 `hasPendingDraft` — out of scope, permanently

Revision 1 proposed narrowing it and contradicted itself doing so. Nothing in "one home per field"
requires touching this predicate; it is pinned by `has-pending-draft.test.ts` and 19 real-workerd
cases in `publish-atomicity.sandbox.test.ts`. With the column staying, there is no longer even a
later merge that would touch it. **Left exactly as written.** If it should change, that is its own
change with its own reasoning.

---

## 7. Test strategy

### 7.0 Inventory of what exists on this surface

**Contract suites** (`packages/domain/src/testing/*-contract.ts`), run against the fake by
`packages/domain/test/*.fake.test.ts` and against better-sqlite3 + pg by
`packages/store-postgres/test/*.dialects.test.ts` (`describe-each-dialect.ts:31`, pg gated on
`PG_CONNECTION_STRING`).

`product-commerce-store-contract.ts` — 1735 lines, ~80 cases. Relevant here:
`:125` (`upsert HEALS a NULL title`), **`:1061-1117` (`KNOWN GAP (F4)`)**, `:243-674` (the
`updateCommerceFields` block, many cases carrying `title` in fixtures — notably `:243`
applies-when-CAS-matches, `:262` partial-update/null-clears, `:281` replay, `:303` stale,
`:431` never-touches-active-or-tombstone), `:975` (productKind defaults to physical),
`:993-1058` (watermark ordering), `:1434`/`:1461` (list projections including a null-title
"create then price" row), `:1596-1649` (search), `:1662-1707` (paging + filter composition).

**Snapshot invariant — untouched by this scope, and green there is the evidence:**
`packages/domain/test/orders/product-edit-snapshot-regression.test.ts:22-78`;
`packages/store-postgres/test/order-flow.dialects.test.ts:48-74`;
`packages/domain/test/orders/create-order-intent-description.test.ts:63-177`;
`packages/service/test/checkout-intent.http.pg.test.ts:114-132` (asserts Stripe receives
`description: "1 × Widget"` — a live commercial constraint: an India-based Stripe account refuses
a card confirm without a PaymentIntent description); `order-store-contract.ts:71-150,283-291`;
`reporting-store-contract.ts:17-36,124-129,155-179` (`titleSnapshot` — `order_items`).
**Note:** `product-edit-snapshot-regression.test.ts:51-67` renames the product *via*
`updateProductCommerceFields`, so **1c changes its mechanism** — see §7.3.

**Plugin:** `sync-hooks.sandbox.test.ts` (639 lines, 20 cases — asserts the exact PUT body at
`:133`, key derivation and the frozen-`updatedAt` regression at `:165,:201`, float-price `:253`,
bad-currency `:267`, missing-sku skip `:280`, no-commerce-field skip `:300`, stock-not-clobbered
`:313`, the title-sync block `:354-521`, activation `:524-591`, non-throwing failure `:592`,
delete `:605`, collection guard `:621`); `publish-atomicity.sandbox.test.ts` (519 lines, T1–T19);
`has-pending-draft.test.ts` (72 lines); `derive-idempotency-key.test.ts` (49 lines);
`product-data-widget.sandbox.test.ts` (97 lines); `products-page.sandbox.test.ts` (13 title refs;
`:234-267` filter/archive wiring); `product-edit-money.test.ts`.

**Service:** `admin-product-edit-http.test.ts` (`:51-64` seed, `:66-80` price+title edit, `:82-96`
stale-edit, `:98-115` replay, `:135-149` SKU collision, `:150-158` 404, `:159-168` 401, `:240-252`
write gate); `admin-products-http.test.ts` (`:98-118` list, `:120-152` search, `:154-170` cursor,
`:172-188` detail); `admin-restock-http.test.ts`; `product-commerce-http.test.ts` (no title refs).

**Site:** `seed.test.ts:93,98,108,118,125,137`; `site-config.test.ts:64,72,76`.

**Harnesses:** `packages/store-postgres/test/order-harness.ts:71-190`
(`seedPhysical`/`seedDigital`/`editProduct`) and `describe-each-dialect.ts:146` both carry
`title` — **both keep working**, since the upsert channel survives. `editProduct` needs checking
in 1c only if it routes titles through `updateCommerceFields` rather than `upsert` (it uses
`upsert`, so it is fine — confirm).

**False positives to save the next reader time:** `entitlement-store-contract.ts`'s ~15 "title"
hits are the substring inside "en**title**ment".

**Pre-existing gaps:** nothing tests "priced but untitled ⇒ `PRODUCT_NOT_PRICED`"
(`create-order-from-cart.ts:204`, price half covered, title half not); nothing pins the
`/checkout/quote` vs `/checkout/orders` asymmetry (`routes/orders.ts:148` checks price only).
Both are out of scope but should be filed — with the column staying, they remain live gaps.
`parse-commerce-fields.ts` and `normalize-watermark.ts` have **no dedicated unit tests**.

### 7.1 PR 1a

**NEW** (`packages/domain/test/product-commerce-use-cases.test.ts`), written red first:

- `updateProductCommerceFields` setting the first SKU on a bare row creates an inventory row at
  `on_hand = 0`;
- a second edit does **not** reset a stock level that has since moved (create-if-absent);
- an edit on a still-sku-less row performs no inventory write;
- `not_found` / `stale` / `currency_mismatch` perform **no** inventory write — only `ok` seeds;
- **the self-heal case (§3.2)** — name it for what it models, e.g. *"a double-submit after the
  seed threw is classified as a replay, returns ok, and the seed lands"*. The seed throws after
  the CAS committed; the byte-identical **same-key** retry hits the *replay* branch and returns
  `ok`, so the always-attempt seed runs again and succeeds. Assert the **classification path**
  explicitly, not just the end state — a test that only checks the final inventory row would
  still pass if someone reordered the guards and it healed by accident. (A merchant re-clicking
  Save is the *other*, new-key path — §3.2. Worth a second, cheaper case that it also heals.)
- `upsertProductCommerce` with a sku and **no** `initialOnHand` seeds `0`;
- `upsertProductCommerce` with `initialOnHand: 7` still seeds `7`, and a re-upsert of `7` over a
  decremented `on_hand` still does not clobber.

**NEW (HTTP)** in `packages/service/test/admin-restock-http.test.ts`: PATCH sets a SKU on a bare
row, then `POST /products/:id/restock` succeeds. Must be an HTTP test — the wiring in
`routes/admin.ts` is half the bug.

**CHANGE:** callers passing a bare store to `updateProductCommerceFields`. **DELETE:** nothing.

### 7.2 PR 1b

**DELETE, each with its justification:**

- `packages/plugin/test/product-data-widget.sandbox.test.ts` (97 lines) — subject deleted. Its one
  transferable assertion (the capability guard, `:84`) is duplicated in
  `sandbox-clean-guard.test.ts` and `site-config.test.ts:64`. **No coverage loss.**
- `sites/staging/test/seed.test.ts:108,118,125` — the widget binding, the editor mount, and
  "an unbound json field falls back to the default editor". Note that `:125` tests an *EmDash*
  behaviour Otta no longer relies on — **but it is exactly what a stale field will now do on an
  existing site (§4.6)**, so quote it in the upgrade note even as the test goes.
- `sites/staging/test/site-config.test.ts:72` — replaced by the inverse (the descriptor declares
  **no** field widgets), so a reintroduction is caught. **No coverage loss.**
- `product-commerce-store-contract.ts:1061-1117` (`KNOWN GAP (F4)`) — **replaced, not deleted.**
  See NEW.
- The bag-shaped cases in `sync-hooks.sandbox.test.ts`: `:253` (float price), `:267` (bad
  currency), `:280` (missing sku), `:300` (no commerce field), `:313` (stock not clobbered).

  **The money question, resolved — do not defer this.** `:253`/`:267` are the only tests asserting
  that a float price never reaches a money field *on the CMS path*, and that path carries no money
  after 1b. The surviving paths are covered at **runtime**, not merely at compile time: the
  service boundary rejects a non-integer at `packages/service/src/schemas.ts:321` (the sync/
  integrator PUT price), `:397` (the edit price), and `:409`/`:413` (compare-at / unit cost), so a
  float is a 400 before any domain code runs; the admin form parses minor units by exact integer
  string math and is covered by `packages/plugin/test/product-edit-money.test.ts`; and `Cents` is
  branded. `product-commerce.type-test.ts` is compile-time and never covered a float arriving as
  JSON — which is precisely why the runtime check had to be verified rather than assumed.
  **Deletion approved on that evidence; copy those four citations into the PR body verbatim** so
  the next reader does not redo the analysis. (`:294` is the x402 settle body — not a product
  price, and not evidence here. See §1.5.)

**CHANGE:**

- `sync-hooks.sandbox.test.ts` — drop the bag fixtures. Surviving and added assertions:
  (a) **every** save of a products document upserts, including one with no sku and no commercial
  data (the invisible-product fix); (b) the upsert body contains **only**
  `{ title?, contentUpdatedAt }`, asserted as a **strict key set** — "no
  sku/price/initialOnHand/productKind/taxClass/dimension key on the wire". That strict assertion is
  the real regression guard for this merge; (c) the title-sync block (`:354-521`) unchanged;
  (d) activation (`:524-591`), delete (`:605`) and the collection guard (`:621`) unchanged.
- `publish-atomicity.sandbox.test.ts` — T7 (stock defers) deleted; T10 (validation failure ⇒
  content still activates) deleted with the validation path; T3/T17/T18 lose their price
  assertions and keep their title/ordering assertions; T1/T2/T15/T16 survive with a bag-free body.
  Everything else stands.
- `has-pending-draft.test.ts` — **unchanged** (§6.3).
- `derive-idempotency-key.test.ts` — **unchanged.** The keys do not change in 1b (§4.5), and the
  `version` component stays live.
- `seed.test.ts:98` — assert `commerce` is **absent** from the field set.
- `products-page.sandbox.test.ts` — copy assertions, if `:409`/`statusLabel` change.

**NEW:**

- **The F4 replacement**, in `product-commerce-store-contract.ts`: a console
  `updateCommerceFields` reprice, then a **title-only** sync upsert carrying a newer
  `contentUpdatedAt`, leaves `price`, `compareAtPrice`, `unitCost`, `inventoryPolicy`, `sku`,
  `taxClass` and the dimensions byte-identical — **and updates the title**, which is the positive
  half that pins the surviving channel. Fake + better-sqlite3 + pg. **This is the money-integrity
  test of 1b** and the single most important new test in the sequence.
- **No CAS-churn test.** An earlier revision proposed one asserting that two same-title saves
  produce a single applied upsert with `updated_at` unmoved. **That test would have blessed the
  data-corruption bug in §4.5** — the no-op it asserts is exactly the state in which
  `content_updated_at` stops advancing. It is not merely out of scope; writing it would pin the
  defect. Recorded here so it is not "helpfully" re-added.
- `sync-hooks.sandbox.test.ts` — **the activation test (§4.4):** a published, bag-less product
  yields a row with `active: true` that is **absent from `listCommerceByIds`**.
- `packages/plugin/test/parse-product-title.test.ts` — a dedicated unit test for the moved
  `parseProductTitle` (absent / null / non-string / empty / whitespace / 500 / 501 chars). Closes
  a pre-existing gap at the moment the function moves, which is when a silent regression is
  cheapest to introduce — and the function is now permanent, so it earns the test.
- `packages/service/test/admin-products-http.test.ts` — a product with no sku appears in the admin
  list. Today it cannot exist.

### 7.3 PR 1c

**CHANGE:**

- **`packages/domain/test/orders/product-edit-snapshot-regression.test.ts:51-67`** — this is a
  CLAUDE.md non-negotiable and 1c changes its **mechanism**: it currently renames the product via
  `updateProductCommerceFields({ price, title })`. After 1c that call cannot carry a title.
  Rewrite the rename half to go through `upsertProductCommerce` (the surviving channel) and keep
  the price half on `updateProductCommerceFields` — which is *better* coverage than today, because
  it then exercises both writers against one order. **Do not weaken it to a price-only test.**
- `packages/service/test/admin-product-edit-http.test.ts:66-80` — becomes a price-only edit.
  `:82-96` (stale-edit never clobbers) must keep asserting that *some* field survived — switch it
  to `sku` or `taxClass` so the lost-update guard keeps its teeth.
- `product-commerce-store-contract.ts` — the `updateCommerceFields` cases at `:243`, `:262`,
  `:281`, `:303`, `:431` that carry `title` in their input drop it; several use it as the
  "field that changed", so pick another (`taxClass` is nullable and unencumbered).
- `packages/store-postgres/test/order-harness.ts` — **verified unaffected**: `editProduct` routes
  through `upsert` (`:179-188`), the surviving channel. And no other test passes `title` to
  `updateCommerceFields`, so the CHANGE list above is complete — no "confirm before assuming"
  left on this item.

**NEW:**

- **The re-add guard (§5.3):** a `PATCH /admin/products/:id` body carrying `title` is rejected
  (400 naming the field, if `.strict()` is chosen) **and the stored title is unchanged**. The
  stored-value assertion is the part that matters — a test that only checks the status code would
  pass against a schema that silently strips.
- The port type no longer admits `title` — a compile-time case in
  `packages/domain/test/product-commerce.type-test.ts`, alongside the existing raw-`number`-price
  case.
- The admin detail still **renders** the title as a read-only row and the header still uses it —
  a `products-page.sandbox.test.ts` case, so nobody deletes the display along with the input.
- A sync upsert still writes the title after 1c (the surviving channel), asserted end-to-end in
  `sync-hooks.sandbox.test.ts` — cheap, and it is the positive statement of ADR-0013.

### 7.4 Invariant ledger

| Invariant | Where it lives after 1a/1b/1c |
|---|---|
| No float reaches a money field | Service zod `int()` — `schemas.ts:321` (sync/integrator price), `:397` (edit price), `:409`/`:413` (compare-at / unit cost) — plus `product-edit-money.test.ts` and branded `Cents`. CMS-path guards deleted in 1b **only because that path carries no money** (§7.2). Not `:294`, which is the x402 settle body (§1.5) |
| A console edit is never clobbered by a CMS sync | **NEW** F4-replacement contract case (1b), replacing the deleted `KNOWN GAP` |
| A live product with a SKU has an inventory row | **NEW** 1a use-case + HTTP cases, on **both** write paths |
| The CAS self-heals if the seed throws | **NEW** 1a replay-classification case (§3.2) |
| The title cache converges under out-of-order hook delivery | `product-commerce-store-contract.ts:993-1058` (the watermark cases) — untouched, and the reason the sync key must stay distinct per save (§4.5) |
| An unpriced published product is active but unsellable | **NEW** 1b activation test (§4.4) |
| Title has exactly one writer | **NEW** 1c re-add guard + type test; ADR-0013 carries the reasoning |
| Orders snapshot price + title at purchase time | `product-edit-snapshot-regression.test.ts` (**mechanism updated in 1c, coverage strengthened**), `order-flow.dialects.test.ts:48-74`, `create-order-intent-description.test.ts` — all otherwise untouched |
| The title reaches the payment provider | `checkout-intent.http.pg.test.ts:114-132` — untouched, must stay green |
| No oversell under concurrency | `no-oversell*.pg.test.ts` — untouched; still run (§8) |
| A stale sync never resurrects a tombstone | `product-commerce-store-contract.ts:742,808,938` — untouched |
| Out-of-order publish/unpublish converges | `product-commerce-store-contract.ts:871-937` — untouched |

---

## 8. Verification

Local Postgres: **`postgres://postgres:postgres@127.0.0.1:55432/otta_test`** (container
`otta-pg-test`, confirmed listening; documented at `sites/staging/README.md:21`).
**Port 5432 tunnels to a production Azure database and must never appear in any command, test,
migration or script.** `vitest.config.ts:16` serialises test files whenever
`PG_CONNECTION_STRING` is set — the no-oversell race alone opens ~54 connections.

**Baseline, recorded in the first PR:**

```bash
cd /home/azureuser/otta-wt-commerce-bag
pnpm install && pnpm lint && pnpm typecheck && pnpm test
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta_test pnpm test
```

**Every merge:**

```bash
pnpm lint            # oxlint + the domain-purity dependency-cruiser check
pnpm typecheck && pnpm format && pnpm test
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta_test pnpm test
```

**1a additionally:**

```bash
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta_test \
  pnpm vitest run packages/domain/test/product-commerce-use-cases.test.ts \
                  packages/service/test/admin-restock-http.test.ts \
                  packages/store-postgres/test/no-oversell.pg.test.ts \
                  packages/store-postgres/test/restock-concurrency.pg.test.ts
```

**1b additionally:**

```bash
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta_test \
  pnpm vitest run packages/domain/test/product-commerce-store-contract.fake.test.ts \
                  packages/store-postgres/test/product-commerce-store-contract.dialects.test.ts
pnpm vitest run packages/plugin/test/sync-hooks.sandbox.test.ts \
                packages/plugin/test/publish-atomicity.sandbox.test.ts \
                packages/plugin/test/sandbox-clean-guard.test.ts \
                packages/plugin/test/has-pending-draft.test.ts \
                packages/plugin/test/derive-idempotency-key.test.ts
pnpm vitest run sites/staging/test/seed.test.ts sites/staging/test/site-config.test.ts
```

**1b manual walk — reproduce the QUICKSTART path, screenshotted** (CLAUDE.md requires a screenshot
for plugin/storefront-UI work). Follow `README.md:39-56` verbatim as a new user would,
**including the §4.7 demo-row step**, then:

1. boot the service and `sites/staging`; apply the seed via the dev bypass (`README.md:63`);
2. run the demo-row step, then **add a demo product to the cart and complete a checkout.**
   Asserting that `/products` renders a listing is *not* asserting the front door works — an
   inactive row lists and prices perfectly well and cannot be bought (§4.7). The checkout is the
   only assertion that catches a missing `activate`;
3. open a demo product in the CMS editor — **assert the "Product data" panel is gone**;
4. **on a database seeded before this change**, assert §4.6's prediction (a raw "Commerce" JSON
   textarea), run the documented `deleteField` cleanup, assert it is gone. **Screenshot both
   states** — this is the merchant-visible artefact and it belongs in the PR;
5. create a **new** product with a title only, save — assert it appears in Pricing & inventory,
   unpriced;
6. set SKU + price; **set kind to `digital`** (§1.4 — a bare row defaults to physical) and save;
   add stock — assert the restock succeeds (the 1a fix);
7. publish an unpriced product — assert the row shows as active but is absent from `/products`
   (§4.4);
8. reprice in Pricing & inventory, then save **and publish** the CMS document — **assert the price
   does not revert** (F4, the headline fix);
9. add the step-5 product to the cart and check out; assert the order line's title and price.

There is deliberately **no** step asserting the absence of a CAS conflict after a
description-only CMS save: that churn is known, out of scope, and filed (§4.5, §9.7). A walk step
asserting it would fail.

**1c additionally:**

```bash
PG_CONNECTION_STRING=postgres://postgres:postgres@127.0.0.1:55432/otta_test \
  pnpm vitest run packages/domain/test/orders/product-edit-snapshot-regression.test.ts \
                  packages/service/test/admin-product-edit-http.test.ts \
                  packages/domain/test/product-commerce-store-contract.fake.test.ts \
                  packages/store-postgres/test/product-commerce-store-contract.dialects.test.ts
pnpm vitest run packages/plugin/test/products-page.sandbox.test.ts \
                packages/plugin/test/sync-hooks.sandbox.test.ts
```

Plus a short manual pass: the Pricing & inventory detail shows Title as a read-only row beside
Status; renaming in the CMS updates it after a save; there is no way to change it from the admin.

**Changesets.** `.changeset/` is active. Each merge changes a published-in-name package; 1a
(signature) and 1c (`UpdateProductCommerceFieldsInput`, the PATCH wire) are breaking. One
changeset per merge, naming the break.

---

## 9. Risks

**9.1 — 1b's merchant-visible artefact on existing databases** (§4.6). The stale unbound
`commerce` field is the highest-risk merchant-facing item in the whole scope, because it appears
without any action on the merchant's part and looks like a working input. Cleanup step, staging
run, and an honest release-note line — all three, not one.

**9.2 — The quickstart is the project's front door** (§4.7). Getting it wrong is worse than most
code bugs here: this is v0.0.1's first-run experience and it is in the README with a screenshot.

**9.3 — Harness/prose volume in 1b.** `sync/hooks.ts` carries ~180 lines of prose about the
mechanism being deleted, and `publish-atomicity.sandbox.test.ts` is 19 real-workerd cases, each
booting workerd. Sequence the edits so that suite is touched once, not per-file.

**9.4 — The title cache is eventually consistent, with no reconcile cron** (`hooks.ts:264-266`).
A failed sync leaves a stale `product_commerce.title` until the next save or publish, and an order
placed in that window snapshots the stale name. Unchanged by this work and structurally inherent
to a cache, but ADR-0013 should say it out loud rather than leaving it in a code comment.

**9.5 — Two pre-existing gaps remain live** (§7.0): nothing tests "priced but untitled ⇒
rejected", and nothing pins the `/checkout/quote` vs `/checkout/orders` title asymmetry
(`routes/orders.ts:148` vs `create-order-from-cart.ts:204`) — a priced-but-untitled product 200s
at quote and 409s at place. With the column staying, these stay reachable. Out of scope; filed
per §9.7.

**9.6 — Upstream, unrelated but discovered here, and worth filing today.** In
`~/em-dash/packages/workerd/src/sandbox/bridge-handler.ts`, `requireCapability` compares against
the **deprecated** capability spellings — `:246` gates `http/fetch` on `network:fetch` and
`:163,166` gate `content/*` on `read:content` — while manifests are canonicalised to
`network:request` / `content:read` before reaching the runner
(`packages/plugin-types/src/index.ts:107-162` → `packages/core/src/plugins/adapt-sandbox-entry.ts:262`
→ `packages/workerd/src/sandbox/runner.ts:627`), and EmDash's own comment at
`packages/core/src/plugins/context.ts:1093-1095` states deprecated names never appear downstream.
**This does not affect Otta's shipping deployment**, which registers trusted in-process
(ADR-0006, `sites/staging/src/emdash-options.ts:12-16`), and it does not affect Otta's own test
harness, which hand-builds `ctx` (`packages/plugin/src/sandbox-entry.ts:121-123`) and never
touches EmDash's capnp bridge. But CLAUDE.md and DEVELOPMENT.md §5 name the workerd sandbox as the
**binding contract**, so if the analysis holds, a sandboxed deployment of this plugin would get no
egress at all. **File it upstream; do not fold it into this scope.** Repo convention for an
upstream contribution: author as `Vedanshu <vedanshu@otta.sh>` (not the machine's default git
identity), follow the upstream PR template, and note that a human must sign the CLA.

### 9.7 — Issues to file, with owner and timing

All four are **out of scope by decision, not by omission**, and all four must exist as tracked
artefacts rather than as paragraphs in this plan. **Owner: the engineer who picks up 1a. Timing:
filed before 1a merges** — this is a line item on 1a's PR checklist, so the follow-ups are real
before the first merge lands, not after the last one.

| # | Issue | Source |
|---|---|---|
| 1 | **CAS churn on content-only CMS saves** — a description/image edit bumps `product_commerce.updated_at` and shows a spurious "This product changed since you opened it". Recommended fix in the issue: make `updated_at` in the `DO UPDATE SET` conditional on an owned column genuinely differing, while `content_updated_at` advances unconditionally. `[Adapters]` + contract, both dialects, needs a SQLite answer for the absent `IS DISTINCT FROM`. **Record why the payload-derived-key fix is wrong** (§4.5) so it is not re-proposed. | §4.5 |
| 2 | **SKU rename strands inventory** — renaming a SKU seeds a fresh zero-stock row and orphans the old one. Pre-existing in `upsertProductCommerce`; 1a makes it marginally more reachable by making the console the only SKU writer. | §3.5 |
| 3 | **"Priced but untitled ⇒ rejected" is untested** — `create-order-from-cart.ts:204`'s price half is covered, the title half is not. | §7.0, §9.5 |
| 4 | **`/checkout/quote` vs `/checkout/orders` title asymmetry** — `routes/orders.ts:148` checks price only, so a priced-but-untitled product 200s at quote and 409s at place. Nothing pins it. | §7.0, §9.5 |

Issue 1 must be linked from the 1b PR body (§4.5). The upstream capability filing (§9.6) is
tracked separately, on the `emdash` repo rather than ours.

---

## 10. Notes and disagreements

**10.0 — The revision-3 defect, accepted without reservation.** Both reviewers independently
derived a data-corruption failure from my proposed payload-derived idempotency key, and the
mechanism is exactly as described: `.where()` at
`packages/store-postgres/src/kysely-product-commerce-store.ts:171` and `:176-178` are both on the
same `onConflict().doUpdateSet()`, so a Guard-1 hit suppresses the entire SET block — including
`content_updated_at` at `:165-167`. A title-unchanged save would have frozen the watermark, and a
rename-and-rename-back under reordered delivery would have left the cache permanently wrong on
the value that feeds `order_items.title`. It also contradicted my own §4.3 D two sections earlier,
and the test I proposed in §7.2 would have pinned the bug rather than caught it. §4.5 now records
the failure sequence so the "obvious" fix is not re-proposed, and §7.2 records why the test must
not be written. This was the right catch and I had no counter-argument.

**10.1 — I accept the decision and the reviewers' findings.** Everything I re-checked in
revisions 2 and 3 was accurate: the cursor rebuild (`routes/admin.ts:204-233`), the 1000-char
cursor bound (`schemas.ts:630`), `CAPABILITY_RENAMES` and the dedupe
(`plugin-types/src/index.ts:107-162`), the `http/fetch` gate (`bridge-handler.ts:246`), the
canonicalisation path, `ContentListWhere` (`types.ts:225-230`), the bridge's `where`-ignoring
`contentList` (`:687-717`), seed fields never being deleted (`seed/apply.ts:189-216`), the seed
firing no hooks (`:457-607`), the CAS classification order
(`kysely-product-commerce-store.ts:310-320`), `deps.inventoryStore` (`admin.ts:83-85`), the
commerce-incomplete filter (`:265-271`), the DEPLOYMENT posture (`:87,:249,:478`), and
`product_kind` NOT NULL (`0002_product_commerce.ts:51`). The decision to keep the column is, in my
view, correct on the evidence.

**10.2 — Refinement to 1a's safety argument.** The manager's brief attributes the same-key
property to `admin.ts:299`'s deterministic fallback. That fallback is real but it is the
**secondary** path: the plugin sends its own content-derived `Idempotency-Key`
(`products-page.ts:852-869,904-905` → `admin-products-client.ts:198`), and the service prefers the
header (`admin.ts:296-299`). The fallback covers a client that sends none. Both are deterministic
per submission, so the conclusion holds either way — but the plan and the code comment should cite
the primary path, because that is the one our own admin actually exercises, and a test written
against the fallback would not cover it.

**10.3 — Pushback: "four missed 'Product data' references" is right; twelve would be wrong.**
Beyond the four named (`DEPLOYMENT.md:315`, `adr/0001:34`, `plugin.ts:73`, `index.ts:4`) there are
eight more in `plans/phase-1-*.md`, `plans/phase-2-*.md`, `plans/phase-7-*.md` and two
`.changeset/*.md`. The **phase plans** must not be edited — they record what was decided and
executed. ADR-0001 is the exception and gets a **dated amendment** rather than a silent deletion,
because an ADR states the current architecture. Recorded in §4.8.

> **Correction, applied during 1b's implementation.** The half of this note that extended the
> same protection to `.changeset/*.md` — "changesets are release notes for shipped versions" — is
> **wrong for this repo**. Nothing has shipped: no `CHANGELOG.md` exists, every package is
> `0.0.1`, and all 60+ changesets are unconsumed and will land in one first release entry
> together with 1b's. See the correction block in §4.8 for the rule that replaces it and for
> which files 1b actually fixed. The phase-plan half of this pushback stands.

**10.3a — And a third citation in this plan was wrong.** §4.7 says to "derive the three content
ids from `seed/seed.json`" and names `product:otta-tee` / `product:otta-mug` /
`product:otta-stickers` at `seed/seed.json:62,71,80`. Those strings are in the file, but they are
**not the stored ids**: em-dash's seed applier generates a ULID per entry and keeps the declared id
only as a seed-local reference (`seedIdMap: seed id -> real entry id`,
`~/em-dash/packages/core/src/seed/apply.ts:116,535,543,606`). Pricing against the declared id
"succeeds" — the upsert mints a row for any id — and creates orphan rows no CMS product joins to,
so the storefront reads "Not currently available for purchase" with no error anywhere. 1b's script
resolves ids from the CMS content API instead, matched by the slugs the seed declares. Two review
rounds verified the citation without checking its semantics; the walk caught it.

**10.4 — Mild disagreement on sequencing.** The brief offers 1c first if cleaner. I recommend
against it (§5.4): 1c's central claim — the CMS sync is title's sole writer — is only *true* once
1b lands, so landing 1c first would put ADR-0013 into the tree asserting something the code does
not yet do, and it would make 1b's manual walk exercise an admin surface that is about to change.
If scheduling forces 1c first, it is technically safe; ADR-0013 should then land with 1b instead.

**10.5 — `.strict()` on the PATCH schema: now specified, with its cost named.** §5.3 carries the
verified compatibility check, the deliberate asymmetry with the non-strict
`upsertProductCommerceBody`, the required explanatory comment, and the consequence neither review
round had written down: `.strict()` plus removing `title` means an **old plugin bundle sending
`title` gets a 400 on every edit**, not just title edits. Moot for `sites/staging`, where plugin
and site deploy together — but it should be a decision in the PR body, not luck. The
`title: z.never()` variant is offered there as the version that gives the precise error without
the cliff.

**10.6 — Four things filed rather than fixed** (§9.7), with an owner and a hard deadline of
"before 1a merges", on 1a's checklist (§3.6): the CAS churn, the SKU-rename inventory stranding,
and the two untested invariants. The CAS-churn issue carries the §4.5 analysis, so the rejected
fix is documented where the next person will look for it.

**10.7 — One residual I want visible rather than buried.** With §4.5 out of scope, 1b ships a
known, merchant-visible annoyance: a description-only CMS save can show a spurious "This product
changed since you opened it" on an open Pricing & inventory form. That is the correct trade — the
alternative corrupts order records — but it is a regression against today's behaviour, not a
neutral omission, and the 1b PR body should say so in those words rather than only linking the
issue.
