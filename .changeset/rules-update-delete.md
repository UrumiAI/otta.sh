---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Rules UPDATE/DELETE capabilities + a typed plugin rules-client (admin-UX
Increment 3, slice 1). Closes the capability gap the admin audit flagged:
tax/shipping/coupon config was create/read-only, blocking every tax & shipping
admin screen. This slice adds the missing domain/service mutations plus one
sandbox-clean plugin client; the drill-down UIs consume it in later slices (no
UI here).

Per-entity design (decision table, with rationale):

- **shipping zone** — UPDATE last-writer-wins (structural, money-free rename);
  DELETE forbid-if-methods (`in_use_by_methods`), an atomic guard mirroring
  `deleteTaxClass`.
- **shipping method** — UPDATE LWW; DELETE forbid-if-rates (`in_use_by_rates`).
- **shipping rate** — UPDATE optimistic CAS on the money-bearing `amount_cents`
  (`stale` on a lost race, never a silent clobber); DELETE is a leaf no-op.
- **tax rate** — UPDATE CAS on the money-bearing `rate_bps`; DELETE is a leaf
  no-op.
- **coupon** — UPDATE LWW (documented exception to "prefer CAS": economics are
  effectively fixed at issue, no non-null money scalar to CAS on cleanly, and
  `uses_count` — the one field under real concurrency — is never touched by an
  edit); DELETE forbid-if-redeemed (`in_use_by_redemptions`), preserving the FK
  + reconciliation trail.

Referential deletes are ATOMIC (`DELETE ... WHERE NOT EXISTS child`, FK-backed
for methods/rates/redemptions) so a concurrent child insert can never orphan.
The CAS money edits are once-only under replay (a blind retry is reported
`stale`, never double-applied) and verified by a Postgres N-way race
(exactly-one-winner, the no-oversell analogue for admin edits). Deletes are
idempotent (`not_found` no-op).

Snapshot invariant: an order snapshots its totals at creation, so deleting a
rate/coupon never rewrites an existing order; an in-flight cart recomputes on its
next quote/checkout and sees the deletion (a deleted rate resolves to 0 bps /
unavailable). No schema change (forward-only migrations untouched) — the CAS
tokens are existing readable columns.

Service adds PATCH/PUT + DELETE routes mirroring the ports 1:1 under the write
gate; the plugin gains `AdminRulesClient` (discriminated results, admin +
service token threading, 404/409 mapping) covering the full rules surface.
