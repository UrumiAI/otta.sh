---
"@otta-sh/plugin": minor
---

The two React admin lists gain a `Refresh` that re-reads the pages on screen and keeps the
operator's depth — the act that did not exist. Until now a list could be made current or an
accumulated scan could be kept, never both: `Apply filters` nulled the cursor and collapsed
every gathered page back to page one, and `Retry` re-read only the page at the current
cursor, leaving everything above it exactly as stale as it was. The ruling is
[ADR-0017](../adr/0017-list-refresh-semantics.md).

- **A refresh is a WALK, anchored where the window opens.** It re-requests the page the
  window starts on — no token at all when the walk began at page one, the address's own
  cursor when it did not — and then follows each response's `nextCursor` to the same depth.
  Only the anchor is a token the list already held; every boundary inside the window is
  re-derived from the responses as they come back. Replaying the held cursors instead would
  parallelize, and was rejected: those boundaries stop lining up with each other the moment
  rows are inserted above them, leaving a hole in the middle of the window that nothing on
  screen could report. The cost is `depth` serial round trips, and `depth` is 1 for a page
  reached by paging.
- **The window is replaced, not merged into**, and committed in one transition. A row in
  none of the refreshed pages — deleted, or no longer matching the filter — stops being
  shown. That is the one act allowed to remove a row, and it is safe precisely because the
  operator asked for it: focus is on the control, which survives its own click, so nothing
  is stranded inside a row that vanishes.
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
  and merging it would silently relocate a window that opens elsewhere.
- **`Retry` after a refresh re-issues the whole walk**, not one page. The paging-stopped
  state is answered by a refresh, which is now what its sentence names first. On Pricing &
  inventory a grounded walk's first response is page one, so a refresh may raise the
  low-stock banner and may clear it, while its continuations inherit that verdict as before.
- **One read at a time.** Every in-flight read makes the control unavailable and it refuses
  its own click; a refresh cancels a pending read rather than overlapping it. It is drawn
  with `aria-disabled` rather than `disabled`, so the control the operator's focus is on
  keeps its tab stop, and it states its cost before the click. History records a correction,
  never a journey: the entry is replaced with the page the window now ends on and the stack
  that produced it.

No service or plugin API changes — a refresh is built from requests the service already
answers, and the browser still never parses a cursor. The Block Kit lists replace rather
than accumulate and are untouched.
