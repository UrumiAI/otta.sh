# 0025. Coupon codes match case-insensitively, and are printable ASCII

- Status: accepted
- Date: 2026-10-02
- Reverses: the documented choice in `EmdashCouponStore.findByCode` that "the match stays
  case-SENSITIVE" (comparing the claim's stored spelling, to keep the SQL adapter's
  `WHERE code = ?`). Recorded here because it was a decision, not an accident.

## Context

A coupon code is something a shopper types. Three parts of the system disagreed about it:

- the document store already made codes **unique after case folding** (`coupon_codes/{folded}`),
  so `SAVE5` and `save5` could never both exist;
- the admin list's search was **case-insensitive** ("Code (exact match, case-insensitive)");
- checkout's `findByCode` was **case-sensitive**.

QA (2026-10-02) created `QAADMIN5`, typed `qaadmin5` at checkout, and was told the coupon did not
exist — while the console had promised case did not matter. The in-memory store matched exactly and
did not enforce folded uniqueness at all, so the contract suite could not even state one rule.

## Decision

1. **`CouponStore.findByCode` folds case.** One fold, `foldCouponCode` in `@otta-sh/domain`, used by
   every adapter. Because codes are unique after folding, a folded lookup names at most one coupon.
2. **The record keeps the merchant's spelling.** The applied code — and the order's
   `appliedCouponCode` snapshot — is the coupon's own `code`, never what the shopper typed.
3. **`create` refuses a case-variant and a duplicate id with the PORT's errors** —
   `CouponCodeConflictError` (`code: "COUPON_CODE_CONFLICT"`) and `CouponIdCollisionError`
   (`COUPON_ID_COLLISION`), declared in `@otta-sh/domain` and thrown by both stores. The contract
   asserts the codes, not merely a rejection; callers (the admin rules client) match them
   structurally without importing an adapter.
4. **New codes are printable ASCII with no whitespace** (the ID charset, `isIdToken`), enforced by
   the admin rules client and the Coupons console. `toLowerCase` is an exact case fold only on
   ASCII; on other scripts "the same code" would depend on Unicode normalisation the shopper's
   keyboard need not share. Existing codes are immutable and keep working as issued.

## Consequences

- Behaviour change for API callers: a lower-cased code that used to be `COUPON_NOT_FOUND` now
  applies. Changesets call it out.
- No migration: the document store's claims were already keyed by the folded code.
- A code minted earlier with non-ASCII letters is still reachable by its `toLowerCase` fold, but
  not under every Unicode-equivalent spelling. NFKC normalisation was considered and not taken:
  restricting new codes is simpler and leaves no stored ambiguity.
- Postgres and D1 runs of `couponStoreContract` are required in CI before this merges (only the
  SQLite dialect and the fake ran locally).
