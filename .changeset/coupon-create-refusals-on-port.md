---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": patch
"@otta-sh/plugin": patch
---

`CouponStore.create`'s two refusals are declared on the port (ADR-0025):
`CouponCodeConflictError` (`code: "COUPON_CODE_CONFLICT"`, a code a live coupon holds,
compared case-folded) and `CouponIdCollisionError` (`COUPON_ID_COLLISION`), with
`isCouponCodeConflictError` / `isCouponIdCollisionError` and the one `foldCouponCode`, all
exported from `@otta-sh/domain`. The document store re-exports them under their old names;
the in-memory store now throws them (it used to throw a bare `Error` on a case-variant and
silently overwrite a duplicate id), including from its `seedCouponRow` restore path. The
admin rules client matches the port's errors instead of the document store's.
