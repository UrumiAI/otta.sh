---
"@otta-sh/service": minor
---

A cursor that disagrees with the request's own filter params is now a 400 on both admin
list routes (`GET /admin/orders`, `GET /admin/products`), instead of a 200 whose rows
answer a different question than the address asked.

The opaque cursor carries the filter it was minted under, so paging preserves it. But a
request may also spell that filter out in the query string, and the two arms never met:
whenever a cursor was present the routes took the predicate SOLELY from the token and
never read the query's filter params at all. An unfiltered token sent beside
`?states=paid` answered 200 with the unfiltered set — four orders under an address
claiming only the paid ones, with nothing in the response admitting the substitution.
That is fine while the only client sends the cursor alone; it stops being fine the
moment a console keeps the cursor in a shareable URL beside the filter params, where
editing one param by hand (or a stale link, or a back button) makes the pair reachable.
Resolving the contradiction silently in the token's favour is the one outcome nobody can
audit, so it now fails closed.

- **Present params must agree; absent ones claim nothing.** A cursor-alone request is
  untouched — byte-identical to before, which is what every current client sends. A
  cursor beside AGREEING params is byte-identical to that same cursor alone: agreeing
  params are redundant, not a second opinion. A cursor beside DISAGREEING params is
  `400 {"error":"cursor filter mismatch"}`, the same envelope as the neighbouring
  invalid-cursor and invalid-states-filter 400s, with its own value so a client can tell
  "your cursor is garbage" from "your cursor is not the one for this address" and drop
  the cursor rather than the filter. A request with no cursor at all is unchanged.
- **Compared as predicates, not as spelling.** Both sides go through the same
  normalization the token's filter went through when it was minted, so an agreeing
  request cannot 400 by accident: key order is irrelevant, an absent axis and an
  `undefined` one are the same thing, an OR-able array is a SET (`states=paid,cancelled`
  and `states=cancelled,paid,paid` select the same rows and so agree), and a window
  bound is an INSTANT rather than a string (`...T00:00:00Z` agrees with
  `...T00:00:00.000Z`). Case is deliberately not folded — the store's case-insensitivity
  is the store's business, and a token round-trips whatever the query said.
- **A subset is not agreement.** A URL naming only `states` while the token also carries
  a date window is a disagreement, not a narrowing: the rows are tighter than the
  address describes, which is the same invisible divergence in a quieter form.
- **Every axis participates**, including the products list's low-stock threshold — `0`
  is a real threshold and is compared as one, never read as "absent".
- **The page size is compared too.** An address asking for 50 rows while the token says
  25 is the same lie in a different field. It is checked against the EFFECTIVE limit
  (after the existing server-side re-clamp), so a token whose limit is out of range —
  where the query's own value is what ends up being honored — is not a spurious
  disagreement.

The cursor's contents and the way it pages are unchanged; this only adds the comparison.
Both routes' four quadrants (cursor alone, cursor + agreeing, cursor + disagreeing,
params alone) are pinned by HTTP contract tests against a live server.
