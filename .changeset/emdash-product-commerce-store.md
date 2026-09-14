---
"@otta-sh/store-emdash": minor
---

`EmdashProductCommerceStore`: the product catalogue over the document primitives, with
variants embedded and the sku-rename stock carry as a completable intent.

- **One aggregate document per product, its variants inside it.** Every invariant that
  spans a product and its sizes is a currency invariant, and in SQL those were held
  together by a written-down lock order whose own docblock recorded that it was only
  mostly total. Embedded, the two writers contend for ONE document revision, so the
  interleaving the order existed to forbid is unreachable rather than merely ordered —
  and a variant pricing resolves the product's currency from the value it is about to
  write. Two sizes first-priced at once in disagreeing currencies is decided by the
  loser re-reading the winner's value; the crossing-rename pairs that used to deadlock
  now cannot, because there is no lock to order.
- **Live-sku uniqueness is a claim document.** `sku_owners/{sku}` names the one live
  sellable unit that holds a sku, across products and variants, and its `live` flag is
  what "unique among live rows only" means now that the two partial unique indexes are
  gone. A soft delete, an orphaning or a rename away releases it; the next claimant
  takes it over by compare-and-set. The claim is checked for BACKING before it refuses,
  so a claim written a round trip ahead of the row that will hold it never reports
  "another live product holds this sku" about a peer holding nothing.
- **The sku rename is an intent-claim, and the order of its steps is load-bearing.**
  The target is claimed create-if-absent and the source's live holds are refused BEFORE
  anything commits; the product write then records the carry it owes in the same write
  that commits the new sku; only then is the source zeroed and stamped, the target
  credited once by token, and the stamp cleared. Running the carry first — the obvious
  order — lets a write whose compare-and-set then loses strand the units under a sku the
  product does not hold, and makes the source read zero to a concurrent writer that
  strands them for good. The token is derived from the write's own idempotency key, so a
  replay recomputes it and adds nothing twice, and any replayer finishes a partial from
  the source document alone.
- **What cannot be made atomic is completable and swept.** A hold arriving between the
  decision and the move leaves the rename committed and the carry recorded: the units
  stay on the source, the record says where they are going, and `completeRecordedRenames`
  — which every later write on the product also runs — finishes it once the hold
  resolves. A new rename is refused with that same held-stock error while a carry is
  owed, so a product can never leave units queued for a sku it has since renamed away
  from. Stock is conserved at every seam, and the crash-seam suite asserts it mid-flight
  rather than only at rest.
- **Two forced deviations from the planned index list, both documented in the package
  README.** The publish gate is filtered through a text mirror, because a boolean cannot
  be bound as a filter value on one dialect and throws before any comparison runs; and
  `titleLower` is not declared, because the port's search is a substring and the filter
  algebra has no substring operator — so the title half is resolved in memory over the
  rows the indexed axes narrow, and the batch reads gain a `productId` index instead so
  a batch of ids is one query rather than one read per id.
