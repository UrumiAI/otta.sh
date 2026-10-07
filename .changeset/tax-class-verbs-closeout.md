---
"@otta-sh/domain": minor
"@otta-sh/plugin": minor
---

Increment 3 closeout slice — three small, independently-motivated fixes the
#72/#73/#75 reviews flagged as the last gaps before the tax/shipping/coupons
admin surface is done:

1. **Tax-class rename/delete wiring** (the core). `#72` found that
   `TaxRulesStore` had create/list/delete but no rename at all, and that
   `deleteTaxClass` (the cross-aggregate delete-in-use guard, contract-tested
   since Increment 2 slice 5) had never been wired to a caller — the tax admin
   screen shipped list+create only, with an honest "not available" note.
   - **Domain**: `TaxRulesStore.updateClass(id, {name})` — last-writer-wins,
     the same `updateZone`/`updateMethod` precedent (#71): a class carries no
     money, its `id` is the immutable referent rates/products resolve by, so
     a rename never orphans anything. `TaxRulesStore.countRatesByClass(id)`
     is new too — `deleteTaxClass`'s two in-use refusals now carry an honest
     `count` (products via the existing `countByTaxClass`, rates via this new
     method, queried only on the refusal path) instead of a bare boolean.
   - **Plugin**: the tax classes level gets a rename form + delete button per
     row (danger-confirm). A class delete answers with its own result type
     carrying the count, unlike the generic zone/method/coupon
     `RulesDeleteResult`, so the screen renders an in-use conflict as "N
     products/N rates reference this class" — never a bare refusal. The old
     "renaming/deleting is not available yet" note is gone.
2. **Blank-economics guard below the form** (`#75` review finding). The
   "a fixed_amount coupon can't null `amountCents`; a percentage coupon can't
   null `rateBps`" rule previously lived ONLY in the plugin's form parser — any
   other caller of the coupon update could blank a live coupon's
   discount. `type` isn't on the edit input (it's the coupon's immutable kind,
   stored on the record), so the update now reads the coupon first to learn
   its type, then validates before writing: refused, nothing written, on a
   violation.
3. **Staging descriptor nav** (`#72`/`#73` finding). Tax, Shipping, and
   Coupons all shipped working admin screens in prior slices but were never
   added to `sites/staging/src/otta-plugin-descriptor.ts`'s `adminPages` —
   each was fully wired yet unreachable from the admin nav. Added, pinned by
   `site-config.test.ts`.
