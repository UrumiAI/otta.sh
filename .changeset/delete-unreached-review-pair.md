---
"@otta-sh/plugin": minor
"@otta-sh/admin-react": patch
---

Delete the unreached two-step `-review` pair from the Orders write path.

The Orders write-path extraction carried a staged→confirm flow across from the
retired Block Kit screen: `orders:refund-review`, `orders:cancel-review`, the
`OrdersStaged` / `OrdersDraft` types and the `staged` / `draft` members of
`OrdersActionResult`. No surviving surface calls them — the React order detail
composes its own confirm and posts `orders:refund` / `orders:cancel` /
`orders:cancel-<reason>` directly — so all of it is removed, together with
`orders:cancel-other`, whose reason is offered only by the note form that posts
`orders:cancel`.

BREAKING for consumers of the package's type exports: `OrdersStaged` and
`OrdersDraft` are no longer exported, and an `OrdersActionResult` is now a
notice and nothing else.

THREE safety checks are deleted with the pair — the full list, not a sample —
and **none had a reachable caller**: the refund-ceiling bound check against the
just-re-read live ceiling; the unparseable-amount refusal whose draft carried
the operator's raw text verbatim; and the `REFUND_BY_REQUIRED` guard that
refused a blank `Refunded by`. All three lived only on the refund review step.
The reachable refund confirm keeps its stale-watermark refusal (re-read the
ledger, refuse on a mismatch, refuse a missing watermark fail-closed) and its
money validation (integer minor units, a positive amount, no float laundered
into cents); an over-ceiling amount is refused by the service as
`REFUND_EXCEEDS_TOTAL` / `REFUND_EXCEEDS_CAPTURED`. Re-introducing a
server-side two-step confirm means writing all three against that flow's shape,
not restoring them.

Refund attribution is consequently enforced by the console alone: a blank
`Refunded by` is recorded as `admin`, and the console's own check does not
cover its full-remaining-balance button. That gap is pre-existing and is not
introduced here; ADR-0015's amendment records it rather than leaving it to be
found.

The vocabulary the console renders its one-click cancel buttons from is now
**shipped by the plugin** as `ConsoleVocabulary.oneClickCancellationReasons`,
derived from the same constant the per-reason action ids are derived from,
instead of being re-derived console-side by excluding `other`. With
`orders:cancel-other` gone, a drift between the two copies would post an
unregistered id and refuse a perfectly cancellable order. A test pins set
equality in both directions.

ADR-0015 is amended accordingly — Decision 3, plus a note that Decision 2's
"staged state a two-step flow needs" clause is moot rather than unaffected.
Every other decision in it, including the stale-watermark requirement, stands
unchanged.
