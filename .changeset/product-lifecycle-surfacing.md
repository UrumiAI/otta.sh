---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Product lifecycle surfacing (admin-UX Increment 2, slice 4): make a product's
active/inactive/deleted state honest and browsable on the admin Products console,
without adding a new mutating command.

Ownership discovery (decisive for scope): activate/deactivate are ALREADY
CMS-owned and already wired (`content:afterPublish`/`afterUnpublish` →
`ProductCommerceStore.activate`/`deactivate`, landed alongside the sync hooks) and
soft-delete is ALREADY CMS-owned and already wired (`content:afterDelete` →
`softDeleteProductCommerce`, on both trash and permanent delete). There is no
undiscovered domain-owned lifecycle command left to build — the gap was purely on
the READ side, called out verbatim in the existing code: "there is no admin surface
for browsing/restoring a soft-deleted product yet." This slice closes exactly that
gap; it adds no new writer of `active`/`deletedAt`.

- **Domain** — `ProductListFilter` gains `deleted?: boolean` (the tombstone axis,
  a strict two-value equality filter mirroring `active`): omitted/`false` is the
  ORIGINAL default (`deleted_at IS NULL`, unchanged for every existing caller);
  `true` is the new archive view (`deleted_at IS NOT NULL`, mutually exclusive
  with the live view — never both on one page). `ProductSummary` gains
  `deletedAt: string | null`, present on every row (null on a live row, set only
  in the archive view) so a consumer never has to guess whether the field exists.
- **Adapters** — the fake and every `ProductCommerceStore` adapter flip the same
  base `deleted_at` predicate the filter now parameterizes, contract-pinned
  (`listProducts filter.deleted:true is the archive view`, `...composes with
  active/productKind/search like every other axis`).
- **Admin reads** — the archive view is the `deleted` flag on the admin products
  list filter; reading a soft-deleted product by id no longer collapses into the
  SAME not-found an unknown id gets — it now answers with `deletedAt` set (the
  honest read-only tombstone), while the WRITES (update, restock, remove stock)
  still refuse a deleted row via their own pre-existing not-found guards — this
  is visibility only, never a path back to editability.
- **Plugin** — the Products console's "Status" filter gets a 4th, mutually
  exclusive option, "Archived (deleted)", so a merchant can never combine it with
  Active/Inactive into a filter contradiction. A `deletedAt`-outranks-`active`
  status label ("deleted" over "inactive") is shared by the list table, the "Open
  product" picker, and the detail fields. Opening a soft-deleted product renders
  a read-only tombstone banner (deletion timestamp + a note that existing orders
  are unaffected, since an order snapshots price/title at purchase time) with NO
  edit form and NO stock forms — editing or restocking a deleted product is
  meaningless, and the writes would refuse it anyway.

Known, deliberately out-of-scope gap this slice surfaces but does not fix: restoring
a CMS document from the trash does NOT undo a soft delete — `upsert` (the
`content:afterSave` handler) never touches `deletedAt`/`active` by design, so a
restored CMS document stays commerce-tombstoned with no self-heal. That is a new
domain-owned RESTORE command, a separate, larger change (its own idempotency /
ordering-watermark story), not a read-surfacing slice; flagged here for a follow-up
decision, not built.

Verification: the full `productCommerceStoreContract` (130 tests, incl. the new
archive-filter and tombstone-detail cases and the write-still-blocked-for-deleted
regression) and the plugin's workerd-on-Node sandbox
(`products-page.sandbox.test.ts`, incl. the archived-filter query and the
no-edit/no-stock-forms tombstone render) all pass. No new mutating command exists to
race checkout, so no new concurrency test was needed; `listCommerceByIds`
already omits soft-deleted rows (pre-existing, unchanged) so a deleted product was
already unpurchasable before this change.
