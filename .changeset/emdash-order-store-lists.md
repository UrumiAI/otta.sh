---
"@otta-sh/store-emdash": minor
---

[Adapters] `EmdashOrderStore` serves the admin Orders list, the counts, the customer
view, guest linking and the outbox settle path — the last four methods the port was
missing.

The list, the search and the keyset cursor are where a document store with no OR in its
filter algebra diverges most from the SQL it replaces, so the shape is explicit:

- **the search's order-id PREFIX arm** rides one declared index, `searchKey`
  (`orderId.toLowerCase()`), as a single `startsWith` — anchored and folded on both
  sides, with a whole id its own prefix and the empty string matching everything;
- **the search's line-sku arm** rides a new derived collection,
  `order_sku_index/{foldedSku}:{orderId}`, indexed on `sku`. The pair is the document
  id, so an order with two lines of one sku owns ONE pointer and the port's "one row per
  order" is structural; `countOrders` adds the arm as a set difference so a count cannot
  disagree with the page it captions;
- **the search's `buyer_ref` SUBSTRING arm is narrowed to a PREFIX**, on the
  `buyerRefLower` index. That is the ratified narrowing (ADR-0019 §6.1): the filter algebra
  has no substring operator, so the arm is anchored. An operator can still type an address
  or its local part; what is lost is the mid-string reach — a domain, or any fragment that
  does not start the address, returns nothing. Four contract cases stay registered as named
  todos saying exactly that (the mid-string fragment, a bare `%`/`_`, a bare `\`, and the
  count under the substring predicate); widening the port back out is a separate `[Domain]`
  change;
- **the customer key keeps its UNION** and now needs a second declared index,
  `buyerRefLower`: a contract case pins the edge ADR-0019 R3 left conditional (a
  `buyerRef`-only key must also return an order already linked to a customer id). The two
  arms are merged for the list and taken by inclusion–exclusion for the count, so an
  order matching both halves is counted once;
- **the keyset cursor is re-derived from the port's value position**, not round-tripped
  through the host's opaque token, whose seek re-reads the cursor row. A deleted cursor
  row is therefore not a paging fault, and the same property is what makes merging arms
  exact. The adapter's total order is code-unit `createdAt DESC, id DESC`, while the host
  breaks ties under the database's collation — so every arm is drained to the end of its
  boundary tie group before the page is sliced. Without that, a page boundary inside a
  `createdAt` tie group silently drops a row on Postgres and not on SQLite.

`markEmailSent` / `rescheduleEmail` now raise the typed, retryable
`OutboxEntryUnlocatableError` when neither the locator nor the fallback walk can find the
entry, instead of returning quietly: an already-drained entry always has a locator, so a
quiet return could only ever have hidden a still-`sending` entry whose lease would lapse
into a double send. Both pointer collections read a refused create-if-absent back and raise
`DerivedPointerConflictError` if the incumbent names another order.

**One intentional divergence from the SQL adapter**, pending a port-docstring tightening:
`markEmailSent` / `rescheduleEmail` raise `OutboxEntryUnlocatableError` for an entry id
neither the locator nor the bounded walk can resolve, where the SQL adapter's guarded
`UPDATE … WHERE id = :id` matches 0 rows and no-ops. The port documents the no-op; on a
document store it cannot be distinguished from a still-`sending` entry whose locator was
lost, and that one lapses into a double send.

`NotImplementedInIncrementError` is **removed**: every `OrderStore` method now has a real
implementation, so the class had zero throw sites. Anything importing it (nothing in this
repo did) should expect it to be gone from the public surface.

`markEmailSent` / `rescheduleEmail` now find their entry through a locator document,
`outbox_keys/{entryId} → { orderId }`, instead of walking the `emailDueAt` index. The
locator is bracketed after the flip that enqueues the entry, and the walk survives as a
one-shot heal that writes the locator it found.
