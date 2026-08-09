---
"@otta-sh/admin-react": patch
---

The two React admin lists gain a `Refresh` that re-reads the pages on screen and keeps the
operator's depth — the act that did not exist. Until now a list could be made current or an
accumulated scan could be kept, never both: `Apply filters` nulled the cursor and collapsed
every gathered page back to page one, and `Retry` re-read only the page at the current
cursor, leaving everything above it exactly as stale as it was. The ruling is
[ADR-0017](../adr/0017-list-refresh-semantics.md).

- **A refresh is a WALK, anchored where the window opens.** It re-requests the page the
  window starts on — no token at all when the window opens on page one, the anchoring
  cursor when it opens anywhere else — and then follows each response's `nextCursor` to the
  same depth. The anchor, never the walk's grounding, is what says whether that first
  response *is* page one: grounding only makes the page number knowable, and an operator
  three `Next` presses in is grounded while standing on page three.
  Only the anchor is a token the list already held; every boundary inside the window is
  re-derived from the responses as they come back. Replaying the held cursors instead would
  parallelize, and was rejected: those boundaries stop lining up with each other the moment
  rows are inserted above them, leaving a hole in the middle of the window that nothing on
  screen could report. The cost is `depth` serial round trips, and `depth` is 1 for a page
  reached by paging.
- **The window is replaced, not merged into**, and committed in one transition. A row in
  none of the refreshed pages — deleted, or no longer matching the filter — stops being
  shown. That is the one act allowed to remove a row, under an obligation any trigger has
  to meet: it survives its own act or hands focus off before the window is replaced, and
  what it removed is reported where the operator is looking.
- **`Apply filters` over an unchanged predicate is now a refresh, not a collapse.**
  Discarding a scan is licensed by the predicate moving; when the submitted filter is
  field-for-field the applied one, none of that holds and the scan stays. A changed
  predicate still collapses to page one, unchanged. The applied filter object is
  deliberately kept on a match, so cursor validity stays a reference comparison.
- **A walk that stops part-way keeps what it re-read and says the rest is not shown**, with
  the stack truncated to match — a window half reconciled would carry one count line over
  rows read at two different moments, and a stack claiming the old depth would number them
  wrongly. A walk that re-read *nothing* leaves the window entirely alone under its own
  title, because the rows on screen are still coherent. A page the service refuses mid-walk
  is discarded rather than merged: the recovered first page answers a different question,
  and merging it would silently relocate a window that opens elsewhere — and because the
  committed window then ends on the very token that was refused, paging is withdrawn there
  rather than promised.
- **`Retry` after a refresh re-issues the whole walk**, not one page. The paging-stopped
  state is answered by a refresh, which is now what its sentence names first. On Pricing &
  inventory only a walk that opens on page one can answer for the low-stock predicate, so
  such a walk may raise the banner and may clear it, while one anchored deeper carries the
  pre-refresh verdict (and the withheld exact count) in rather than believing the value a
  continuation reports by contract.
- **A walk that was REFUSED gets its own sentence.** It ends on a window with fewer pages
  than it had *and* on the token the service just rejected, so neither of the other two
  notices may stand there: the paging-stopped one opens by promising the rows on screen are
  unaffected, and the partial-refresh one ends by naming `Load more`, which would re-send
  that token. Both stop notices are announced, because either way rows the operator had are
  no longer on screen.
- **One read at a time.** Every in-flight read makes the control unavailable and it refuses
  its own click — and so is `Apply filters`, which now has two meanings and both are reads.
  The control is drawn with `aria-disabled` rather than `disabled`, so the one the
  operator's focus is on keeps its tab stop; it states its cost when pressing it would incur
  one and why it is dimmed when it would not. The plan is made from the stack the rows on
  screen were fetched by, which is not the same stack after a page move that failed. History
  records a correction, never a journey: the entry is replaced with the page the window now
  ends on and the stack that produced it.

**Named follow-up — a deep walk freezes the filter panel for as long as it runs.** The
walk is `depth` serial round trips and `Apply filters` is unavailable for all of them, so
a merchant who scanned twenty pages and pressed Refresh cannot change their filters until
it finishes, with no way to abandon it. Neither remedy belongs in this change: bounding
the walk trades depth for latency, and letting Apply cancel it needs a rule for what the
half-rebuilt window then shows. Reachable today only at depths no fixture exercises;
recorded so it is a decision rather than a discovery.

No service or plugin API changes — a refresh is built from requests the service already
answers, and the browser still never parses a cursor. The Block Kit lists replace rather
than accumulate and are untouched.
