---
"@otta-sh/store-emdash": minor
---

Apply each reporting rollup event as ONE guarded numeric delta instead of a
compare-and-set retry loop on the day document (ADR-0022).

Every order created on a day in a currency shares one `reporting_daily`
document, and the order store awaits the rollup inline, so every checkout,
settle and refund that day contended on it. Nothing refuses a reporting writer,
so the retry depth grew with the crowd: at 200 concurrent events on one day,
120–176 writers exhausted the 24-attempt budget (`StorageContentionError`,
swallowed by the order path as an under-count) after up to a second of backoff
each. Now each event is one `updateIf` whose numeric `delta` is applied in SQL,
so writers queue on the row lock rather than retrying. At N=200 nothing is
refused, every event takes one attempt, and the totals are exact.

Exactly-once and reconcile safety are unchanged. The per-event claim is still
the once-only gate. The day document gains two guards: `seq`, bumped by every
delta and pinned by a recompute's commit, and `epoch`, bumped by that commit and
guarding every delta. A delta whose event a recompute has absorbed is therefore
refused and skipped, and a delta landing mid-recompute forces the recompute to
re-scan. The host's `updateIf` never moves the revision, so neither guard could
be the revision.

The stored layout changes, additively and forward-only. Counters are stored flat
(`state_<state>` fields) alongside the two guards. Existing documents in the old
nested `stateCounts` shape are read as they stand and migrated forward by the
first write that has a reason to touch them. `ReportingDailyDoc`, which every
reader sees, is unchanged, and so is the `ReportingStore` port. New export: the
`ReportingDailyStoredDoc` type (the stored shape, current or legacy), which
`normalizeReportingDailyDoc` now accepts. `ReportingAnomaly` becomes a union of
the existing `floored` kind and a new `tainted` kind (below), so an `onAnomaly`
observer that reads `counter` must now narrow on `kind` first.

**Deploy atomically.** The host's `updateIf` never moves a document's revision,
so a Worker running the PREVIOUS version alongside this one (a gradual rollout)
or after a rollback can compare-and-set over a current day document:

- Its **rollup** spreads the document it read and adds a nested `stateCounts`
  map holding only its own state move. Events counted since its read are lost.
  The next event on that day clears the nested map in one guarded write, moves
  the epoch, reports a `tainted` anomaly through `onAnomaly`, and applies its
  own delta against the flat counters. It does not recompute the day inline.
- Its **reconcile** writes the old nested shape back, which the next write
  migrates forward again.

Either way the day's figures can be wrong (almost always low; a rare race during
the overlap can count one event twice) until a reconcile covering the day runs,
and the scheduled one reaches a day only once it has closed. Nothing outside reporting is affected. `DEPLOYMENT.md` §5 says so.
