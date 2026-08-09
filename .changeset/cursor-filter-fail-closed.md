---
"@otta-sh/service": minor
---

A cursor that disagrees with the request's own filter params is now a 400 on both admin
list routes (`GET /admin/orders`, `GET /admin/products`), instead of a 200 whose rows
answer a different question than the request asked.

The opaque cursor carries the filter it was minted under, so paging preserves it. But a
request may also spell that filter out in the query string, and the two arms never met:
whenever a cursor was present the routes took the predicate SOLELY from the token and
never read the query's filter params at all. An unfiltered token sent beside
`?states=paid` answered 200 with the unfiltered set — four orders under a request naming
only the paid ones, with nothing in the response admitting the substitution.

Two reasons to close it. The first is defense in depth on a token-guarded REST surface:
a route that accepts two descriptions of one page and silently discards one of them can
only be relied on by callers that already know which half wins, and "the rows quietly
disagreed with the request" is the class of divergence nobody can see in a log. The
second is concrete and near: the admin console is about to start deriving its list
filters from the URL and sending them alongside the cursor it already sends, which turns
a disagreeing pair from something no client emits into something a stale link, a back
button or a hand-edited parameter produces routinely. Better that the service answer
before that lands than after.

- **Present params must agree; absent ones claim nothing.** A cursor-alone request is
  untouched — byte-identical to before, which is what every current client sends. A
  cursor beside AGREEING params is byte-identical to that same cursor alone: agreeing
  params are redundant, not a second opinion. A cursor beside DISAGREEING params is
  `400 {"error":"cursor filter mismatch"}`, the same envelope as the neighbouring
  invalid-cursor and invalid-states-filter 400s, with its own value so a client can tell
  "your cursor is garbage" from "your cursor is not the one for this request" and drop
  the cursor rather than the filter. A request with no cursor at all is unchanged.
- **Compared as predicates, not as spelling**, so an agreeing request cannot 400 by
  accident: key order is irrelevant, an absent axis and an `undefined` one are the same
  thing, an OR-able array is a SET (`states=paid,cancelled` and `states=cancelled,paid,paid`
  select the same rows and so agree), and a window bound is an INSTANT rather than a
  string (`...T00:00:00Z` agrees with `...T00:00:00.000Z`). Case is deliberately not
  folded — the store's case-insensitivity is the store's business, and a token
  round-trips whatever the query said.
- **`deleted=false` and an omitted `deleted` are one predicate, and agree.** The
  tombstone axis is `deleted_at IS NULL` for every value except `true`, so the two
  spellings issue identical SQL; comparing them as distinct would 400 one predicate
  written two ways. `active=false` is NOT that — the store emits a real `active = false`
  — so it keeps disagreeing with an omitted `active`. The asymmetry is the store's, and
  both halves are pinned.
- **A subset is not agreement.** A request naming only `states` while the token also
  carries a date window is a disagreement, not a narrowing: the rows are tighter than
  the request describes, which is the same invisible divergence in a quieter form.
- **Every axis participates**, including the products list's low-stock threshold — `0`
  is a real threshold and is compared as one, never read as "absent".
- **The page size is compared too**, against the EFFECTIVE limit — what the page will
  actually be. The existing re-clamp prefers the token's limit whenever it is a finite
  number and clamps it into range, consulting the query's only when the token's is
  missing or unusable. So a token carrying `999999` pages at 100 and a `?limit=50`
  beside it is a real disagreement, while a token carrying nothing usable pages at
  exactly the query's limit and agrees with it. It shares the one mismatch code because
  it has the one remedy: drop the cursor, re-issue the first page.
- **An unparseable `states` beside a cursor** is newly reachable and answers the
  invalid-filter 400 the no-cursor arm has always given — one rule, both arms.

The cursor's contents and the way it pages are unchanged; this only adds the comparison.
Both routes' four quadrants (cursor alone, cursor + agreeing, cursor + disagreeing,
params alone) are pinned by HTTP contract tests against a live server.

**Follow-up, not done here:** the coupons list in `rules-admin.ts` has the same cursor
shape and the same unclosed gap — its cursor arm still ignores the query's `search` and
`limit` — and is noted as such at the site. `canonicalFilter` and the `has*FilterParams`
predicates are deliberately file-local to `admin.ts` for now; closing coupons should
LIFT them into a shared module and reuse them, never fork a second copy, which would be
free to drift on exactly the canonicalization details they exist to pin.
