---
"@otta-sh/plugin": patch
---

Every list says how many, and a filter narrowed to nothing says so and offers
the way back — on Orders, Pricing & inventory and Coupons.

**The intro line carries the count.** `17 orders · Filter, open an order, and
move it through its status flow.` The count is pluralized through
`Intl.PluralRules` on the console's one pinned locale — the same constant the
date dialect uses — so `1 order` and `17 orders` come from one place and a
future viewer locale moves one knob.

**The count is honest about what it counted, because the wire is thin.** Every
list port answers `{items, nextCursor}` — a page and a way to ask for the next
one — and no screen has a total. So `17 orders` renders only when the page IS
the set: the first page of its filter, with no next cursor. Everywhere else the
same count reads `25 orders on this page`, which is the smaller claim and the
true one. Page 3 of 3 knows nothing about pages 1 and 2 (keyset paging carries
no running offset, and the scaffold deliberately does not accumulate one across
stateless interactions), so it stays page-scoped too. A whole-store total needs
the service to return one alongside `nextCursor`; until it does, a number an
operator would reconcile against must not be invented here.

**Zero renders no count at all.** Never `0 orders` — at zero the state below
says it in words, and a count line repeating it is "unknown rendered as 0" in a
costume.

**Two zero states, and they no longer read alike.** A collection that is simply
empty is not the operator's doing and is not addressed as though it were:
`No orders yet — Orders appear here as buyers check out.` A filter narrowed to
nothing is a different event and now gets a designed state of its own —
heading, body copy, and a **Clear filters** button — where it used to get one
line of `empty_text` under a table that was not rendered. The undo is attached
to the state that needs it and to no other: an empty catalog offers nothing to
clear, because there is no filter to blame.

**The whole-collection wording is gated on `firstPage`, exactly as the count
is.** "No orders yet" is a claim about the collection, and page 2 of a scan has
no standing to make one — page 1 had rows. It is reachable in a live store, not
only in theory: the look-ahead read that minted the cursor and the read that
follows it straddle a concurrent delete, and the second comes back empty. A
non-first-page zero falls through to page-scoped wording (`Nothing on this
page`) offering nothing to click, since nothing was filtered.

**`Clear filters` is one act with one builder — across the three screens this
touches.** It was already the accessory on the active-filter summary section;
that call site and the new zero-state button now come from the same builder, so
the label, the verb and the payload cannot drift apart *on Orders, Pricing &
inventory and Coupons*. `tax-page.ts:620` and `shipping-page.ts:1102` still
hand-roll a byte-identical button of their own and are deliberately untouched
here (one PR, one thing); they are the next-touch consolidation onto
`clearFiltersButton`. The builder fires a BARE `apply-filter` — no values, so
the scaffold rebuilds the level's default filter — and carries the drill path in
the button's own `value`, which is what keeps the re-render on the level the
operator was standing on rather than bouncing them to the root.

**A page with another page behind it never claims to be the end.** The pinned
renderer short-circuits a zero-row table carrying `empty_text` to a bare `<p>`
and takes the "Load more" button with it, so a mid-scan page narrowed to zero
must keep a headers-only table and say the scan can continue. That was
established for the low-stock filter and is now the shared rule for every
screen, in one place, rather than something each list has to rediscover.

**It is built once.** `listResult` in `scaffold/list-detail.ts` decides which
outcome a render is in; the three screens supply their own wording and nothing
else. The list level's `render` now also receives `firstPage`, which is the one
fact neither the honest-count rule nor the whole-collection gate can be derived
without.

**Two containment fixes carried along.** A keyset cursor minted before the
products filter grew its page-context wrapper used to arrive as a bare filter
form and throw on the way into `render` — this screen's fail-closed banner in
place of the page asked for. It now self-heals: the bare shape IS the form, so
the operator's filter survives the deploy instead of being dropped, and an
unreadable one degrades to "no filter set" rather than to an exception. And the
cursor encoding is documented for what it actually carries: `fetchPage` and
`render` share one filter object, so page context written during the fetch rides
the next-page cursor too — which is fine while it is overwritten on every fetch,
and a stale value on screen the moment it is merged instead.
