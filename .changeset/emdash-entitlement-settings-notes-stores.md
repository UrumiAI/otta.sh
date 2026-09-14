---
"@otta-sh/store-emdash": minor
---

[Adapters] Entitlement, payment-event, settings and order-note stores over plugin storage

Four more ports over EmDash's document storage, across seven collections. `EntitlementStore`
keys each grant by its grant-idempotency key and answers the delivery gate from a pointer
document per authorization scope, re-validated against the grant it names and re-established
from the declared index when it does not resolve — so a crash between the grant and its
pointers costs one indexed read and never an unauthorized or a missed delivery. A check
carrying no scope at all is now a typed refusal rather than a silent `false`: nothing is
served either way, but a caller that lost its session is named instead of hidden.

`PaymentEventStore` keys the received-events audit row by its dedupe key and each anomaly by
a digest of its own fields, which makes an identical replay record once. `SettingsStore`
splits what a mutation DECIDED from what it LANDED: the claim carries the patch alone, and the
resulting settings are stamped onto it exactly once, after the write they describe commits. So
a recorded result is always a value that really was applied, two callers of one key cannot be
handed different answers, a replay of a landed mutation writes nothing at all, and a claim
whose write was lost is completed by the next caller with that key. `OrderNotesStore` writes
one document per note keyed by its idempotency key, in a child collection, so an order's
annotation trail never enlarges the document the money path writes.
