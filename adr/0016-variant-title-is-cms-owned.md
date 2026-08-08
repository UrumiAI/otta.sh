# 0016. A variant's name is CMS-owned; `product_variants.title` is a derived single-writer cache

- Status: accepted
- Date: 2026-08-08
- Refines 0001/0002 (the hybrid product model), and applies
  [ADR-0013](./0013-product-title-is-cms-owned.md) one level down — clause for clause, not as an
  amendment to it

## Context

A product that sells in several sizes has no honest single row. Stock and price are **SKU-level
facts** — one size can be sold out while another is not, and two sizes can be priced
differently — so a sellable unit is a row, and a product with three sizes is three rows keyed by
the product plus a stable variant key.

That immediately re-opens the question ADR-0013 answered for the product: **where does the
customer-facing name live, and who may write it?** "Large" is content. It is translated, it is
the label on the storefront picker, and it is the string an order line has to freeze at purchase
time so a receipt still says which size was bought a year later.

The forces are the same ones ADR-0013 weighed, one level down:

- The CMS `products` collection owns product content; a variant's name belongs in it, as a
  repeater whose rows carry exactly two sub-fields — a **stable key** and a **display name** —
  and nothing commercial.
- The commerce database owns sku, price and stock, and there are no cross-database joins.
- `createOrderFromCart` snapshots a title onto every order line, and that snapshot must be
  readable from the commerce database alone.

And one force ADR-0013 did not have: **ordering**. Lines already render the sku beside the frozen
title, and under variants the sku is the variant's. If variants ship before a per-variant name
cache exists, every line written in the interval freezes the *product's* title and permanently
loses the size — the snapshot rule forbids rewriting it afterwards, so there is no repair. The
cache is therefore not a later refinement of the variant model; it is part of the first
increment of it.

### Two shapes, and why the second one wins for the same reasons it won before

Either the commerce row carries **no name** and an order line sources it from the CMS at purchase
time, or it carries a **cache with exactly one writer**.

The first was priced in ADR-0013 and rejected on evidence: `ContentAccess` — the API a plugin
actually gets, in both trusted and sandboxed mode — is `get(collection, id)` and
`list(collection, options)` with no batch-by-id and no search. Nothing about variants improves
that; it makes it worse. A picker renders every size of a product, so the checkout path would
take N sequential content reads *per line* rather than per product, and an admin variants table
would take one per row. The analysis does not need re-running, only re-pointing.

## Decision

**A variant's name is owned by the CMS repeater row. `product_variants.title` is a DERIVED CACHE
written through exactly ONE channel: `UpsertProductVariantInput.title`.**

ADR-0013's clauses, restated at variant grain:

- **The sync channel is the only writer of the name.** `upsertVariant` — the CMS-sync declare —
  carries `title` and nothing commercial. It is also what brings a variant into existence: a
  variant exists exactly while the CMS declares its key.
- **The admin edit has no `title` field.** `UpdateProductVariantFieldsInput` carries `sku` and
  `price` only, so re-adding a name input and wiring it through **does not compile**. The console
  renders the variant name as read-only text, exactly as it renders the product's — this is rule
  F-2b, applied again rather than re-derived.
- **The two channels are disjoint by construction.** The sync cannot write sku or price; the
  admin cannot write the name. Neither writer can reach the other's column, so the divergence
  that motivated ADR-0013 — two writers, one field, the loser silently reverted — is not
  possible here at all rather than merely discouraged.
- **The column exists so an order line can freeze the size without a cross-database read**, and
  for no other reason. It is never merchant-editable, and it is eventually consistent: a failed
  sync leaves a stale name until the next save of that document.

### Two clauses ADR-0013 had no need for

**The variant key is the identity, and it is immutable.** `(product_id, variant_key)` is the
primary key; the key appears in no `SET` clause in any adapter, and neither write input carries a
field that could change it, so a re-key is unrepresentable rather than discouraged. A key that
mutates in the CMS therefore looks to the commerce side like a new variant plus a dropped one —
which is a real loss of the size's sku, price and stock, and is why the sync's save-time hook
must refuse a mutated or reused key **inside the CMS editor**, where it can still be explained to
the person doing it. A refusal that only reaches a log is not a refusal.

**Removal is deactivation, never deletion.** Deleting a CMS repeater row orphans a commerce
variant that may hold stock and may sit on live order lines. The sync sets an orphan tombstone;
the row keeps its sku, its price and its inventory, and the console must render the orphaned
state distinctly rather than hide it. This is the same class of loss the SKU-rename rule exists
to prevent, and it gets the same answer: retain, refuse to guess, and make the state visible.
The one asymmetry with the product's soft-delete tombstone is deliberate — a re-declared key
**resurrects** the variant, because an orphan records the CMS's own statement rather than a
merchant decision, and refusing would strand the units behind a key nobody can re-declare.

**A resurrect revalidates; it does not assert.** These two clauses interact, and the interaction
has a consequence that has to be written down rather than discovered. An orphaned variant's sku
is *freed for reuse* — that is what the partial unique index means — so by the time the CMS
declares the key again, another live variant or another live product may legitimately hold it.
The declare states a fact about the CMS and **cannot be refused**: the commerce database does not
get a vote on whether a size exists, and a sync that raised a unique-index violation would be an
opaque 500 on a hook no merchant can see. So the row gives way instead. On the way back in:

- the stored **sku is kept when it is still free, and cleared to absent when it is not**. An
  orphan cannot reclaim what was legitimately reused. This is the only case in the model where a
  sku returns to null after being set, and it is not an edit doing it — no writer can clear a sku
  — it is the row losing a claim it no longer has. The operator re-prices the size exactly as
  they would a newly declared one.
- the stored **price is cleared when its currency no longer matches the product's**, on the same
  integrity axis and for the same reason: a price the product can no longer honour is not a
  price. Absent, never coerced, never zero.
- **the inventory row is never touched.** A kept sku keeps its units; a cleared sku leaves its
  stock row exactly where it stands, and re-assigning that sku later adopts the row, units and
  all, under the first-sku rule the product level already uses. Nothing is stranded and nothing
  is invented.

**Presence moves only on an ordered, strictly newer delivery.** The name is an unordered cache, so
a watermark-less save may refresh it. Presence has two opposing transitions arriving as
independent fire-and-forget POSTs, so it gets the treatment the publish gate already gets: a
resurrect applies only when the incoming content watermark is present and strictly newer than the
stored one, and a drop is refused when its own key has already been applied. Together those make
a redelivered drop unable to un-sell a size the CMS currently lists, and a redelivered or
watermark-less declare unable to bring back one it has since removed.

### The migration

One forward-only migration adds `product_variants`. `product_commerce` is untouched: no column is
added, dropped or re-keyed, and with no variant rows every existing statement, projection and
keyset cursor is byte-identical. The live catalog declares no variants, so this lands inert.

## Consequences

### What enforces this, in the order it will be hit

As in ADR-0013, this file is the explanation an engineer finds **after** being stopped, not the
guard:

1. **The port types.** `title` is absent from `UpdateProductVariantFieldsInput`, and `sku`/`price`
   are absent from `UpsertProductVariantInput`. Each writer is missing the other's fields, so
   crossing the line does not compile in either direction.
2. **Compile-time type tests** — `packages/domain/test/product-commerce.type-test.ts` pins both
   directions with `@ts-expect-error`, plus the money rule at variant grain (a raw `number` price,
   and a raw-number `amount`), and states the positive halves beside them so the file records the
   asymmetry rather than half of it. Checked by `pnpm typecheck`: a directive that stops erroring
   is itself an error, so these cannot rot into decoration.
3. **The contract suite**, on all three adapters: a declare writes the name and leaves sku and
   price null; an edit changes sku and price and leaves the name byte-identical.
4. **A doc comment on each input**, positioned where someone is already standing, naming this file.

### Accepted costs

- **The merchant leaves the console to rename a size**, exactly as they already do to rename a
  product. Accepted for the same reason: the alternative is a field that appears to work and does
  not.
- **A re-declare is the steady state, and it now costs a transaction and two row locks.** Every CMS
  save re-declares every key the repeater still carries, and each of those takes the product row's
  lock and then the variant row's, inside one transaction — the price of a resurrect that can
  revalidate without corrupting. A *first* declare of a new key is still a single insert. The cost
  lands on a document save, never on a checkout or a catalog read, which is why it was accepted
  rather than optimised around.
- **The cache is eventually consistent and there is still no reconcile job.** ADR-0013 recorded
  this for the product title; variants inherit it unchanged, and multiply it by the number of
  sizes. A sync that fails leaves a stale size name until the next save, and an order placed in
  that window freezes the stale one.
- **A collection whose repeater sub-fields are named something else syncs no names**, the variant
  twin of ADR-0013's one genuine capability regression. The failure is quieter here: an untitled
  product is rejected at checkout, while an untitled *variant* would sell perfectly well and
  simply print a blank size on the receipt. Whichever increment wires the sync must decide
  whether a null variant name blocks the line the way a null product title does; this ADR records
  the question rather than pretending it does not exist.
- **A sku still names exactly one live sellable unit**, and "live sellable unit" now spans both
  live product rows and live variant rows — **in both directions**. The variant writer refuses a
  sku a live product holds, and both product-level writers refuse a sku a live variant holds, with
  the same typed refusal. Uniqueness across a pair of tables holds in both directions or in
  neither: checking one way leaves the other open, and two sellable units over one inventory row
  is exactly the state a later rename of either one silently drains.

  Two consequences are worth stating plainly. Moving a 1:1 product's sku *down* onto its own first
  variant is not expressible through either write surface, because it is a two-row movement; it
  needs its own transactional verb and does not have one yet. And the cross-table half cannot be
  an index — no dialect indexes across two tables — so the two writers serialize on the target
  sku's inventory row instead, which covers every sku that has ever been stocked. A sku that has
  never had a stock row has nothing to serialize on, so two writers assigning that same never-used
  sku in the same instant can still both pass. Committed state is arbitrated correctly on every
  adapter; closing the remainder needs a row to contend on, which means either making a first sku
  claim its stock row (the first-sku rule deliberately says a first sku is not a stock movement)
  or a dedicated claim table. Both are their own decision.

- **Currency integrity is bidirectional too.** A variant's price must agree with the product's —
  the parent's own price currency, or, for a product whose sizes carry the money, its siblings' —
  and a product repricing that would leave a live size in another currency is refused with the
  same `currency_mismatch` outcome. Without the second direction the first is bypassed by
  repricing the product instead of the size. The two resolve under one lock ordering, so they
  cannot both pass by reading each other's "before" state. `upsert` is deliberately **not** given
  this guard: it has never had a currency guard on any axis, so adding a cross-row one there would
  refuse the cross-row case while still permitting the same-row case in the same call — giving it
  one means giving it both, which is a change to its own documented last-writer-wins semantics and
  belongs to its own decision.

### What would change this decision

The same upstream change ADR-0013 named: a `ContentAccess` that gains both an id-set predicate (or
a `getMany`) and a search option, projected through the plugin bridge. Variants raise the price of
the alternative rather than lowering it, so if that day comes, ADR-0013 is the one to re-price
first and this record follows it.
