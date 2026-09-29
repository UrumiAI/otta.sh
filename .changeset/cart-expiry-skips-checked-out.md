---
"@otta-sh/store-emdash": patch
---

The cart-expiry sweep stops re-reading checked-out carts forever. `checkout` flips a
cart's `state` but leaves its denormalized `holdExpiresAt`, so every checked-out cart
in history stayed a `listExpired` candidate: each tick re-listed every order line and
`expireHold` spent its storage reads per line only to find the hold `adopted` and
return false. The sweep's cost grew linearly with lifetime order lines and, on a
per-invocation query budget, starved the cron legs that run after it.

`listExpired` now narrows a checked-out cart to the lines it still owes the sweep — a
hold still `held`, a claimed-but-unfinished expiry, an outstanding `add` claim that
may still own stock — and persists the recomputed deadline, so a cart that owes
nothing drops out of the index after one pass. An `add` decided OUT_OF_STOCK (whose
claim the domain leaves incomplete forever, but whose once-only reserve key can never
mint a hold) does not count as owed. A checked-out cart whose narrowing hits storage
contention falls back to being listed in full for that tick, so it can never stop
the rest of the sweep from reaping; any other error still fails the sweep. It is deliberately not a `state = active` filter nor a clear in
`checkout`: a line that raced the checkout (never adopted by the order) and a crashed
add on a checked-out cart are still `held`, the cart sweep is their only reaper, and
both stay reapable. Existing checked-out carts heal on the first sweep that fetches
them; no backfill or migration.
