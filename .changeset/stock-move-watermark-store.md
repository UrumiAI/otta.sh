---
"@otta-sh/store-emdash": minor
---

`EmdashInventoryStore.removeStock` honours the new `expectedOnHand` option. The watermark is
recorded on the movement claim and judged inside the inventory document's compare-and-set,
so a stale removal is a `STALE_ON_HAND` (key consumed) and can never race the check.

Claims written before this release carry no watermark and are honoured as recorded: an
applied one echoes its answer, and a pending one completes unconditionally. A worker still
on the previous release ignores the member, so during a gradual deploy it may complete a
pending pinned claim unconditionally. `restock` is unchanged.

A success answered from the ledger (the claim's recorded answer, or the applied-movement
ring's witness after a crash) now carries `replayed: true`. The recorded answer itself is
unchanged and never stores the flag.
