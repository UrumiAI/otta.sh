---
"@urumi/domain": minor
"@urumi/store-postgres": minor
"@urumi/service": minor
"@urumi/plugin": minor
---

Increment 3 closeout slice — three small, independently-motivated fixes the
#72/#73/#75 reviews flagged as the last gaps before the tax/shipping/coupons
admin surface is done:

1. **Tax-class rename/delete wiring** (the core). `#72` found that
   `TaxRulesStore` had create/list/delete but no rename at all, and that
   `deleteTaxClass` (the cross-aggregate delete-in-use guard, contract-tested
   since Increment 2 slice 5) had never been routed to HTTP — the tax admin
   screen shipped list+create only, with an honest "not available" note.
   - **Domain**: `TaxRulesStore.updateClass(id, {name})` — last-writer-wins,
     the same `updateZone`/`updateMethod` precedent (#71): a class carries no
     money, its `id` is the immutable referent rates/products resolve by, so
     a rename never orphans anything. `TaxRulesStore.countRatesByClass(id)`
     is new too — `deleteTaxClass`'s two in-use refusals now carry an honest
     `count` (products via the existing `countByTaxClass`, rates via this new
     method, queried only on the refusal path) instead of a bare boolean.
   - **Service**: `PUT /admin/tax/classes/:id` (rename) and
     `DELETE /admin/tax/classes/:id` (wiring `deleteTaxClass`, 409 with
     `{reason, count}` on an in-use refusal).
   - **Client**: `AdminRulesClient.updateTaxClass`/`deleteTaxClass` (the
     latter a dedicated result type carrying the count, unlike the generic
     zone/method/coupon `RulesDeleteResult`).
   - **Plugin**: the tax classes level gets a rename form + delete button per
     row (danger-confirm), rendering an in-use conflict as "N products/N
     rates reference this class" — never a bare refusal. The screen's old
     "renaming/deleting is not available yet" note is gone.
2. **Server-side blank-economics guard** (`#75` review finding). The
   "a fixed_amount coupon can't null `amountCents`; a percentage coupon can't
   null `rateBps`" rule previously lived ONLY in the plugin's form parser — a
   direct `PUT /admin/coupons/:id` caller could blank a live coupon's
   discount. `type` isn't on the edit body (it's the coupon's immutable kind,
   stored on the record), so the route now fetches the coupon first to learn
   its type, then validates before writing: 400, nothing written, on a
   violation.
3. **Staging descriptor nav** (`#72`/`#73` finding). Tax, Shipping, and
   Coupons all shipped working admin screens in prior slices but were never
   added to `sites/staging/src/urumi-plugin-descriptor.ts`'s `adminPages` —
   each was fully wired yet unreachable from the admin nav. Added, pinned by
   `site-config.test.ts`.
