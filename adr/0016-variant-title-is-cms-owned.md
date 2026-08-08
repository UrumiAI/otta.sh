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
2. **The contract suite**, on every adapter: a declare writes the name and leaves sku and price
   null; an edit changes sku and price and leaves the name byte-identical.
3. **A doc comment on each input**, positioned where someone is already standing, naming this file.

### Accepted costs

- **The merchant leaves the console to rename a size**, exactly as they already do to rename a
  product. Accepted for the same reason: the alternative is a field that appears to work and does
  not.
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
  live product rows and live variant rows. One consequence is worth stating plainly: moving a 1:1
  product's sku down onto its own first variant is not expressible through either write surface,
  because it is a two-row movement. It needs its own transactional verb, and does not have one
  yet.

### What would change this decision

The same upstream change ADR-0013 named: a `ContentAccess` that gains both an id-set predicate (or
a `getMany`) and a search option, projected through the plugin bridge. Variants raise the price of
the alternative rather than lowering it, so if that day comes, ADR-0013 is the one to re-price
first and this record follows it.
