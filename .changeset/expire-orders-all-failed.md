---
"@otta-sh/domain": minor
"@otta-sh/plugin": patch
---

`expireOrdersBatch` now answers `allFailed: true` when it attempted at least one order and every
flip it attempted threw (#447), and the scheduled sweep fails its `expire-orders` leg on it
(`ok: false` and a FAILED line) instead of reporting a healthy tick during a storage outage. One
failing order among good ones does not fail the leg, and the per-order back-off is unchanged, so a
poison order is still read past while it waits.
