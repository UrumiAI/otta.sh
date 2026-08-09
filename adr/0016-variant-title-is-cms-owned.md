# 0016. A variant's name is CMS-owned; `product_variants.title` is a derived single-writer cache

- Status: accepted
- Date: 2026-08-08
- Amended: 2026-08-09 — the enforcement clause only ("the sync's save-time hook must refuse a
  mutated or reused key inside the CMS editor"). Every other clause is reaffirmed unchanged. See
  "Amendment 2026-08-09" at the end of this record.
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
which is why this record originally required the sync's save-time hook to refuse a mutated or
reused key **inside the CMS editor**, where it can still be explained to the person doing it.
That requirement is superseded: the CMS offers no way to express it. See "Amendment 2026-08-09"
below for the verified API facts and the posture adopted in its place. The identity rule itself is
unchanged — the key is still immutable, and a re-key is still unrepresentable through either write
input.

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
  twin of ADR-0013's one genuine capability regression. It syncs no names — it does not ERASE
  them: an absent name sub-field omits the field from the declare, so the store preserves whatever
  it holds. That distinction is load-bearing rather than pedantic, because the name is a cache with
  a single writer, so treating "absent" as "cleared" would blank every stored variant name on every
  save of such a collection, and every order line placed afterwards would freeze the blank
  permanently. Only an explicit null, or an emptied name, clears. The failure is quieter here than
  at the product level: an untitled product is rejected at checkout, while an untitled *variant*
  sells perfectly well and simply prints a blank size on the receipt. The question this ADR left
  open — whether a null variant name should block the line the way a null product title does — is
  answered NO by the sync: a nameless size is declared and sellable, because refusing it would hide
  a sellable unit from the operator who would fix it.
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

## Amendment 2026-08-09 — the variant key is enforced by recovery, not by refusal

This record originally required the sync to refuse a mutated or reused variant key at save time,
inside the CMS editor, and said that a refusal reaching only a log is not a refusal. That
requirement is withdrawn. It cannot be expressed against the CMS the plugin runs on, and the
alternative it was protecting against is not the loss it was written to prevent.

### What the CMS API actually offers

Verified against the pinned CMS, stated neutrally because these are facts about someone else's
API rather than complaints about it:

- **The save hook returns a replacement, not a verdict.** `content:beforeSave`'s handler contract
  resolves to a content bag or to nothing. There is no cancel token and no `false` return, so the
  only expressible refusal is a thrown error. The sibling delete hook does honour a `false` return
  as a veto; the save hook has no equivalent in either dispatch path.
- **A sandboxed hook has no way to signal failure to the editor** — the save proceeds regardless
  of the hook's outcome.
- **The event carries no prior document.** The save event is the incoming content, the collection
  and a new-or-not flag. There is no pre-save document, and on an update no id, so "did this key
  change?" is not answerable at that point — and this plugin holds no content-read surface it
  could answer it with.
- **The field editor cannot express the rule either.** A repeater sub-field is declared with a
  slug, a type, a label, a required flag and an optional option list. No uniqueness or
  immutability rule is expressible for a repeater sub-field, and sub-field rules are editor
  affordances.

Any of the four alone would be sufficient; together they mean an editor-legible refusal is
available only through a change to the CMS itself.

### The posture adopted instead

**A mutated key resolves as deactivate-plus-declare, and is recoverable.** The save that changes a
key reads to the commerce side as one variant dropped and another declared. The dropped one is
**deactivated, never deleted**: it keeps its sku, its price and its inventory, and its stock stays
where it is, under the sku it was already keyed by. Restoring the original key in the CMS
**resurrects** that same row under the resurrect rules already specified above — a kept sku keeps
its units, and a sku legitimately reused in the interval is cleared rather than reclaimed. So the
outcome of the mistake is a recoverable state with nothing destroyed, rather than a silent loss.
This is the same answer the SKU-rename rule gives, arrived at from the other direction: retain,
refuse to guess, and make the state visible.

**The repair verb is publish, and this needs stating precisely rather than as "just save it
again".** Presence moves only on a strictly newer watermark — that is the resurrect rule above, and
it is what stops a redelivered declare from reviving a size a newer save retired. On a
revision-supporting collection a draft-only save can be a column no-op that leaves the content's
`updatedAt` frozen, so restoring the key while the document sits in the draft window produces a
declare whose watermark is not strictly newer, and the variant stays orphaned until **Publish
changes**. A bare re-save repairs it only where the CMS genuinely bumps the watermark. This is the
same asymmetry publish atomicity already relies on, reaching one level down; it is a recovery that
always exists, not one that is always one click.

**A reused key resolves first-row-wins, and is logged.** Two repeater rows claiming one key
describe one sellable unit twice, with two names, and the document does not say which is meant.
The sync declares the first occurrence and reports the rest. Declaring both would make the stored
name depend on request ordering; declaring neither would orphan a live size over a typo.

**The admin variant list is therefore obligated to surface orphaned rows distinctly.** This was
already required by the removal clause; the amendment makes it load-bearing rather than merely
good practice. With no save-time refusal, the orphan row is the *only* place a mistaken re-key
becomes visible to the person who made it, and it is what makes the mistake recoverable rather
than merely survivable. A list that filters orphans out, or renders them as ordinary rows, breaks
the enforcement story this amendment substitutes — it is not a display preference.

### Consequences

- The merchant is told late rather than early. A re-key is discovered when the operator sees an
  orphaned size holding stock, not when they save the document.
- Nothing is lost silently, and no repair is manual: the CMS re-declaring the key is the repair.
- One observation worth recording for the day the CMS side is revisited: an editor-legible refusal
  needs a sandboxed save-hook veto whose message survives into the CMS's own error envelope.
  Registering the save hook also requires a content-write capability, which this plugin does not
  hold and does not want — it writes no CMS content — so the hook would be a capability widening
  bought for a guard that could not fire.

### What would change this amendment

A sandboxed save hook that can refuse a write and have its message rendered by the editor. That
would restore the original clause exactly as written, and the recovery posture would remain
underneath it as the second line rather than the only one.
