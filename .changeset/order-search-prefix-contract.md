---
"@otta-sh/domain": minor
---

[Domain] Narrow the order-search contract to anchored prefix matches.

`OrderStore.listOrders`/`countOrders` now guarantee only what every store can
serve: an anchored PREFIX on the order id, an anchored PREFIX on the folded buyer
reference, an EXACT folded purchase-time line sku, with `%`, `_` and `\` in the
search string compared as characters. This is the ratified narrowing of ADR-0019
§6 — the buyer-reference arm is no longer guaranteed to match mid-string. An
adapter MAY match more (the SQL stores keep the unanchored substring as a
superset), so the contract suite asserts the floor and never asserts that a
mid-string fragment fails.

Also documents the outbox locate semantics: an adapter that cannot locate the
entry claimed by `claimNextEmail` must throw a typed retryable error from
`markEmailSent`/`rescheduleEmail` rather than silently succeed; a SQL store's
guarded update is the no-op form, a document store throws.
