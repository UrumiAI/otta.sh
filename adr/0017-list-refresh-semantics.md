# 0017. Refreshing a list re-walks the window on screen

- Status: accepted
- Date: 2026-08-09

## Context

The React admin lists accumulate. `Load more` merges the incoming page into the rows
already rendered — by identity, keeping arrival position, newer content winning — so an
operator scanning for low stock builds a window of several pages and reads it in one go.

Nothing put a fresh read under that window. The console had two acts that looked like
they might:

- **`Apply filters`** nulls the cursor, which classifies the response as a fresh load, so
  every accumulated page is discarded and the list collapses to page one. That is correct
  when the predicate changed and indefensible when it did not — and it was the only
  refresh-shaped control on the screen, so it was also what an operator pressed when they
  simply wanted current data.
- **`Retry`** re-issues the one request that failed. On a scan that means the page at the
  current cursor is re-read and pages 1…N−1 are left exactly as stale as they were.

So the screen could be made current, or it could keep the operator's depth, and never
both. That is already a defect for a merchant reading a stock column that moves under
them. It becomes a blocker the moment a detail panel writes to a record and has to
reconcile that row against the server: "re-read this row" has no honest implementation on
a list that can only re-read one page or throw the scan away, and any divergence notice
offering a `Refresh` needs this decision to exist first.

Keyset paging is what makes the question non-trivial. A cursor is a position, not a page
identity: it names "everything after this point", the collection moves underneath it, and
the browser deliberately never parses one — the token's shape belongs to the service.

## Decision

### 1. A refresh is a WALK from the window's anchor, not a replay of held cursors

The window on screen is `span` responses ending at the last entry of the client-side
cursor stack. A refresh re-requests the page the window **opens** on — no token at all
when the window opens on page one, the anchoring cursor when it opens anywhere else —
and then follows the `nextCursor` of each response to the same depth. Only the anchor is
a token this list already held; every boundary **inside** the window is re-derived from
the responses as they arrive.

**The anchor, and never the walk's grounding, is what says whether the first response is
page one.** They are different facts and conflating them mis-captions a deep page:
grounding records that the walk *started* at page one, which is what makes the page
*number* knowable, and an operator three `Next` presses in is grounded while standing on
page three. The wire decides, exactly as it does for every other response these lists
classify — a request that carried no token is page one, whoever asked for it. Getting it
wrong is two false captions: a refreshed deep page that comes back empty would claim the
whole collection is empty, and one from a service that sends no `total` would drop the
page-scoped hedge and state its rows as the entire set.

The alternative — re-request each held cursor, which parallelizes — was rejected because
the held boundaries stop lining up with each other the moment anything is inserted above
them. Page one re-read under three new rows ends three rows earlier than the token minted
from its old tail, and the rows in between are then covered by no request in the set: a
hole in the middle of the operator's window, silently. Re-deriving each boundary from the
response before it cannot produce a hole. The cost is that the requests are necessarily
serial — `depth` round trips, one at a time, `depth` being the number of responses on
screen, which is 1 for a page reached by paging.

The anchor is why this is not simply "walk from page one": a window opened by a link has
no page number, so walking `depth` pages from page one would land on a different set of
rows and caption them as a refresh of the ones being read.

No new request shape, no new endpoint, no service change: a refresh is requests the
service already answers.

### 2. The depth survives; the window is REPLACED, so a row that has gone, goes

The refreshed responses are merged into each other and committed as the whole answer, in
one transition. They are not merged into the rows that were on screen. Consequently a row
that is in none of the refreshed pages — deleted, or no longer matching the predicate —
stops being shown, and the window closes over it.

This is the one act allowed to remove a row, and the licence is not the control's — it is
an **obligation on any trigger**, so that a second one can take it up. A trigger may
replace the window only if it either **survives its own act** or **hands focus off before
the window is replaced**, and only if what it removed is **reported where the operator is
looking**. The list's own control satisfies all three: focus is on it, it keeps its tab
stop while it runs, and the partial-window notice takes the announcement. A notice-borne
`Refresh` — one that disappears with the notice it sits in — satisfies the first clause
by handing focus off rather than by surviving, which is the same discipline the Retry
already follows. A background reconcile satisfies none of them and is not what this is.

It does not contradict "mark a diverged row, never remove it", which governs a row a
**write** pushed out of the active filter: that row still exists, the operator has just
acted on it, and removing it destroys the working set they are holding. A refresh is the
escape hatch that finally lets such a row go, which is exactly why a divergence notice can
carry one.

Lingering was rejected: keeping a row the collection no longer has makes the screen assert
a record that is not there, at the exact moment the operator asked whether it still was,
and puts it in the count.

### 3. An unchanged predicate re-applied is a refresh; a changed one still collapses

Discarding an accumulated scan is licensed by exactly one thing — the predicate moved, so
the cursors underneath those pages describe a set the operator has left. When the
submitted filter is field-for-field the applied one, none of that is true: it is the same
query restated, and the only act it can honestly mean is the refresh above. Two controls
expressing one intent must not disagree about what it costs.

The comparison is structural, and only for this question. The applied filter object is
deliberately **not** replaced on a match, so no held cursor's identity test changes answer
— cursor validity remains a reference comparison, as it was.

### 4. The control sits with the count line

The paging bar answers "where am I"; the count line answers "when was this true", and it
is the sentence a refresh changes. The control is therefore rendered beside it, wrapping at
narrow widths, and it stays on screen in the states that withdraw the pager entirely —
which are the states an operator most wants to re-read from. It is drawn by the same
component as `Previous`/`Next`: `aria-disabled` rather than `disabled`, so it keeps its tab
stop and its focus ring while unavailable, and it states its cost (it re-reads every page
on screen; rows no longer in the list stop being shown) before the click rather than after.

Its wording lives beside the merge in the React tier, not in the shared copy package. That
package exists so the two rendering tiers cannot drift on wording they both render, and the
Block Kit lists do not accumulate, have no window and offer no refresh. If a second surface
ever grows these sentences, they move.

### 5. Interactions, decided rather than discovered

- **The stack.** Entries up to and including the anchor are untouched and stay valid — a
  cursor is a position, it does not expire, and `Previous` has always re-requested rather
  than replayed rows. The entries inside the window are replaced by the boundaries the walk
  established. Grounding is unchanged: whether a walk started at page one is not something a
  refresh can alter.
- **A walk that stops part-way.** What is on screen is what was re-read, and the stack is
  truncated with it: a window half reconciled would carry one count line over rows taken at
  two different moments, and a stack still claiming the old depth would number those rows
  wrongly. A one-line alert says the rest is no longer shown and names `Load more` as the way
  to gather it again — nothing is withdrawn, because the last page that answered carries a
  live cursor. **Unless the stop was a refusal**, and then that promise would be false: the
  committed window's own `nextCursor` *is* the token the service just rejected, so `Load
  more` would re-send it and land the operator in the paging-stopped state one click later.
  A refused stop therefore withdraws paging, **under its own sentence rather than the
  paging-stopped one**: that notice opens by promising the rows on screen are unaffected,
  and this walk has just replaced them with fewer pages. The third sentence states the
  three facts the operator is standing in — the list came back shorter, there is no way on
  from here, and a fresh walk is what can restore both. Both stop notices are announced
  rather than merely rendered, per the obligation in clause 2.
- **A walk that re-read NOTHING.** Nothing is replaced. The window on screen is still
  coherent — every boundary in it still lines up with the one before — so it is left entirely
  alone, and an inline card says the refresh did not happen. It is classified as a page-move
  failure (rows survive, card inline, `Retry` re-issues it) under its own title, because "that
  page could not be opened" would name a move the operator never made.
- **A page the service refuses mid-walk.** The client recovers a refused token by re-issuing
  page one. That payload is discarded rather than merged: it answers a different question, and
  merging it would silently relocate a window that opens somewhere else, under the word
  `Refresh`.
- **The plan is made from the stack the rows on screen were fetched by**, which is KEPT
  rather than derived. The stack moves on the click and the rows move on the answer, so after
  a page move that failed or was refused the two describe different places, and one entry of
  drift moves a refresh's anchor a whole page — answering "the same query restated" with a
  different query. Computing it as an offset from the current stack is not merely fragile, it
  is wrong in one direction outright: `Previous` pops *before* it asks, so subtracting an
  entry there lands two pages behind and turns page three into page one. What was true when
  the rows arrived is recorded when they arrive.
- **`Retry` after a refresh re-issues the whole walk**, not one page, because the walk is
  carried on the cursor the retry replays. The window it was planned for is captured at the
  click for the same reason: a truncated stack must not re-plan a shallower walk from a
  different anchor.
- **The paging-stopped state is answered by a refresh.** Its cause is a continuation the list
  can no longer follow, and every boundary in the window has just been re-derived from
  responses that did arrive, so the offer to page comes back.
- **The low-stock verdict.** Only a request carrying no cursor can say whether the low-stock
  predicate was applied — every continuation reports "available" by contract, because the
  predicate rode inside the opaque token. A walk that *opens on page one* therefore gets a
  real answer and may both raise that banner and clear it. A walk **anchored on any other
  page** cannot, and takes the pre-refresh verdict with it (and with it the withheld exact
  count) rather than believing a contractual value: otherwise the banner would vanish and the
  count reappear at the click of a control that has nothing to do with filtering, captioning
  every product as low stock. Steps after the first inherit the verdict, which is the existing
  rule unchanged.
- **One read at a time.** Every in-flight read makes the control unavailable, and so is
  `Apply filters` — it has two meanings now and both are reads, and left live over a pending
  request the refresh half was a silent no-op. Two refreshes would race two rebuilds of one
  window; a refresh launched over a pending `Load more` would rebuild the window and then
  have the older page land on top of it, merged against boundaries that no longer exist. In
  the other direction a refresh cancels a pending read rather than overlapping it.
- **History.** A refresh is a correction, never a journey: the entry is replaced, carrying the
  page the window now ends on and the stack that produced it. Pushing one would put a `Back`
  between the operator and the page they were already on.

## Consequences

Easier: an operator can keep a multi-page scan and make it current, which is what a stock
column needs. A write that has to reconcile a row against the server now has a defined act
to do it with, and a divergence notice has something real to offer. `Apply filters` stops
silently costing an operator their scan.

Harder, and accepted: a refresh of a deep window is N serial round trips, so it is
visibly slower than a page load and the control says nothing during it beyond its own busy
label — and for that whole time the list takes no other read, `Apply filters` included.
Rows can disappear at a moment the operator chose — that is the point, but it is still a
change under their eyes. A window can also come back shorter than it went in, and the two
reasons read differently: a collection that simply shrank is reported by the count line
alone, while a walk that stopped short says so in its own announced notice — one sentence
if the missing pages can still be gathered, a different one if the stop was a refusal and
paging went with it.

The walk itself is one function both lists call, not a shape each of them spells out:
which response is the window's own page, which boundaries get recorded, when to stop and
what the stop is called are one decision, and the two defects above were each found twice
while it was written twice.

Unchanged: no service or plugin surface moves; the browser still never parses a cursor;
the Block Kit lists, which replace rather than accumulate, have no refresh and need none.
