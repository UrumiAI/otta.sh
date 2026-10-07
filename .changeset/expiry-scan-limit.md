---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
"@otta-sh/plugin": patch
---

`OrderStore.listExpirable` takes `scanLimit`: the most lapsed pending orders it reads, listed
or left out, before it answers with what it listed. Reaching it is an answer, not an error. An
order it did not reach is not listed, so it is never expired before its intents are checked.

The scheduled sweep's expiry due check passes 100. Under a backlog of abandoned Stripe
checkouts whose intents were still due, that check used to read the whole backlog a small
page at a time (13 queries for 150 orders on the Free preset); it now reads one page (issue
#364). ADR-0022 records it.

**For out-of-tree stores:** an `OrderStore` should honour `scanLimit`. One that ignores it is
still correct, only unbounded, as before.
