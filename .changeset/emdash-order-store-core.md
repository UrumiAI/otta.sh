---
"@otta-sh/store-emdash": minor
---

Add `EmdashOrderStore` — the domain's `OrderStore` over EmDash plugin storage, on
one aggregate document per order. This is the first of three increments on that
port: creation, the guarded transitions, the audit spine, order expiry and the
cross-aggregate hold intents.

Creation is a claim, then a create-if-absent, then a promotion, in that order. The
`order_keys/{idempotencyKey}` claim is written first and carries the WHOLE prepared
document, so a replayer finishes an interrupted create byte for byte — the same
order id and the same minted line ids, never a second set — and the claim is
promoted to its terminal record only after the order document exists, because a
terminal key over a missing order would read as "already minted" and lose the
checkout. Both halves of that window are healed by ordinary calls rather than
tolerated.

Snapshot immutability stops being a discipline and becomes structural: the line
snapshot is a `readonly` array of `readonly` fields, written only by the creating
write, and every later write carries it by reference. A product edit after checkout
cannot reach it, and neither can a future method, without a compile error.

Each state transition is ONE conditional write: the flip guarded on the revision and
on the current state, the appended audit event, and the first-wins outbox entry for
that target state all commit together, so "flipped but no event" is unreachable and
the outbox stays once-only per (order, target state). Order expiry adds the deadline
to the same guard and then releases the order's adopted holds.

Adopting, committing and releasing reservations spans N inventory documents, which no
primitive can bracket with the order write, so each is an intent recorded on the order
document before any per-SKU write, followed by per-id idempotent writes and a
completion any replayer can run. The commit completion drives the singular `commit`
per id rather than re-running `commitMany`, because the batch skips an
already-committed id and a reservation caught between its terminal record and its
prune is finished only by the singular call.

Two collections beside the aggregate, and both are corrections to ADR-0019 §4 (to be
recorded when that ADR is next amended). `payment_refs/{providerRef}` restores the
GLOBAL once-only that `payments.provider_ref` UNIQUE was — the ADR mapped it onto a
per-order check, which would let a mis-routed redelivery be recorded against two
orders while the refund ceiling reads the captured sum — and a reference held by
another order is refused with a typed error rather than recorded. And per-order NOTES
do not go in the order document: a note is operator-supplied free text with no natural
bound, so the notes adapter gets a child collection,
`order_notes/{orderId}:{noteId}` indexed on `orderId`.

The three hold intents are findable rather than merely recorded: one declared index,
`holdsPendingAt`, carries the earliest outstanding intent's timestamp and clears when
the last one closes, because the filter algebra can neither reach inside a field nor
OR three together. Each completion is guarded on the order's state — adoption only
while pending, commit only while paid, release only while expired — and closes the
intent stamp-only otherwise: after a paid order's holds are committed and pruned, a
re-adoption would report every id lost and hand a sweeper a stock anomaly that never
happened. The commit completion folds both a lost hold and an unknown reservation id
into its `lost` list rather than throwing, so one bad id cannot wedge the sweeper on
one order forever.

`recordPayment` and `flagReconciliation` land here although they belong to the refunds
increment's area: both are on `settleOrder`'s path, so the checkout races and the
end-to-end flow cannot run without them. `recordPayment` also throws rather than
silently doing nothing when the order document is absent — there are no foreign keys
here, and money recorded nowhere with the call reporting success is the one outcome a
payments ledger must not have. `listExpirable` likewise refuses to truncate: a scan
that exhausts its page budget throws a typed, retryable signal, because an order past
its deadline that no sweep can see is stock held out of sale forever.

Methods the next two increments own (refunds, the reconciliation resolution,
fulfillment, cancellation; then the lists, search, customer view and outbox lease)
throw a typed `NotImplementedInIncrementError` naming their increment — a loud
refusal rather than a plausible empty answer — while their fields and declared
indexes are already part of the document shape, so neither increment reshapes a
collection holding live orders.

The staging has one piece of scaffolding worth naming, because it is scheduled for
deletion: `packages/store-emdash/test/order-contract-b2.ts` holds a semantically
verbatim COPY of the 22 contract cases this increment owns (helper renames only),
because the domain's suites register every case for the whole port and import `test`
themselves, so no per-case filter exists. A second test reads those domain suites as
text and asserts the copy's titles plus its todo names cover their case set exactly,
so a domain-side edit fails here rather than drifting silently. Both files go when
INC-B4 lands the last method and the suites can be called directly.

Also narrows `HoldDeadlineStamper.stampHoldDeadline`'s `expiresAt` to non-null. A
stamp is always the attach of a line to a live hold, and adoption is scoped
`expires_at > now`, so a deadline-less hold is precisely the one checkout would
classify as lost; the domain never asks for one, and the type now says so.
