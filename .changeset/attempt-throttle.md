---
"@otta-sh/domain": minor
"@otta-sh/store-emdash": minor
---

**New `AttemptThrottle` port** (`admit(key)`: at most N attempts per key in a sliding window),
with `InMemoryAttemptThrottle` and `attemptThrottleContract` in `@otta-sh/domain/testing`, and
**`EmdashAttemptThrottle`** in `@otta-sh/store-emdash` — the sign-in throttle's own slot window
(`login_challenge_claims`, `liveSlots`), namespaced `attempt:` so it never shares a document
with an address's sign-in window. No new collection.
