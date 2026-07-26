---
"@urumi/plugin": minor
"@urumi/domain": patch
---

Publish atomicity: a published product's price now changes when you publish, not when you save.

Editing a **published** product used to push the draft's commerce data live the moment you hit
Save, while the content itself correctly waited behind "Publish changes" — so a rename + reprice
put the **new price on the storefront under the old title**. EmDash stages an edit to live content
as a pending draft and deliberately hands `content:afterSave` the *draft* data, and the sync hook
pushed it verbatim. It happened on every draft save, not just the first.

Now the rule is: **commerce data for content that is currently LIVE is not pushed on save. It is
derived and pushed at publish, in the same operation that makes the content live.**

- `content:afterSave` detects that a save staged a pending draft over live content and sends
  nothing live-affecting — neither the commerce upsert nor the activation. Detection uses EmDash's
  revision pointers (`liveRevisionId` / `draftRevisionId`), plus a second clause for rows that are
  live by `status` but carry no live-revision pointer (an API / CLI / importer
  create-with-`status:"published"` produces exactly that shape).
- `content:afterPublish` now derives and upserts the commerce bag before activating, keyed and
  watermarked by the publish's own `updatedAt`, so content and price land together and a row is
  never made purchasable ahead of its price.
- Products that are **not** live are unaffected: a never-published draft still syncs on every save
  (its row must exist for the Pricing & inventory console to list it), and a collection without
  draft revisions still syncs on save, because there a save *is* the live change.
- `@urumi/domain`: test-only. `@urumi/domain/testing`'s `productCommerceStoreContract` gains one
  characterization case pinning the known gap below (and, just as importantly, pinning its limits).

**Merchant-facing behavior you should know about.** Price, SKU, product kind, tax class and
dimensions edited in Pricing & inventory are overwritten by the product's Product data panel the
next time that product is published. Compare-at price, unit cost, inventory policy and stock are
not affected. For the shared fields, edit them in the panel and publish, or re-apply them in the
console after publishing.

That vector is pre-existing in kind — before this change any CMS *save* already reverted the same
fields, for the same reason (the console's edit carries no content watermark, so the next sync
always wins the ordering gate). This change re-times it to publish, where it is rarer but more
surprising. Reconciling the two edit surfaces is tracked in
[#93](https://github.com/UrumiAI/otta.sh/issues/93); the contract case is labelled to be deleted
when that lands.

**Honest consequences, both directions:**

- If the commerce write fails in transit at publish, the change **fails closed**: the product is
  not activated. On a publish of pending changes the row is already active, so nothing is
  deactivated — the content goes live with the **stale** price (the safe direction: an old price,
  not a wrong new one). On a first publish the product is content-live but **not purchasable**
  until it is published again.
- A **validation** failure behaves differently on purpose: an invalid price (a decimal, a bad
  currency) or a missing SKU leaves commerce unchanged but still publishes and activates the
  content — refusing to activate would let a pricing typo silently unpublish a live product.
  Without a valid price the product simply is not purchasable.
- **The recovery verb is now publish, not save.** A product left content-live but unpurchasable by
  a lost sync used to heal on the merchant's next save; now a save of live content sends nothing,
  so the fix is one click on "Publish changes". There is still no automatic repair — tracked in
  [#95](https://github.com/UrumiAI/otta.sh/issues/95).
- A redelivered publish hook re-applies the commerce write on a first-publish row (the row carries
  a single "last applied key" column and activation overwrites it). No commerce **field** changes,
  but the row's `updated_at` moves, which can invalidate an admin's open Pricing & inventory edit
  form as a spurious `STALE_EDIT` 409, and re-triggers the overwrite described above. Tracked in
  [#94](https://github.com/UrumiAI/otta.sh/issues/94).

**Rows that already diverged are not migrated.** A product whose `product_commerce` holds a price
from a never-published draft **self-corrects the next time it is published**. The one case that
does not self-heal is a leaked price whose draft was subsequently **discarded** — discarding a
draft fires no plugin hook, so that row keeps the leaked price until the product is published
again. To correct such a product: fix the values in the product's **Product data panel, then
publish the product** — not in the Pricing & inventory console, which the next publish would
revert. Use the console for stock movements, which the publish-time write never touches.
