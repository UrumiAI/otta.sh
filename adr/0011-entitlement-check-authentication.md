# 0011. `GET /entitlements/check` authenticates each scope (close the email existence oracle)

- Status: accepted
- Date: 2026-07-14
- Amended: 2026-10-05 — **the plugin's `entitlements/download` route only** (issue #376,
  downloads increment 2). The route takes the `orderId` as its one capability, ignores a
  session, and no longer has a session-only scope. The scope rules for the entitlement check
  itself are unchanged. See "Amended 2026-10-05" at the end of this record.
- Closes: #33 (Phase-4 follow-up, security). Builds on ADR-0004 (customer session mechanism) and ADR-0007 (the `X-Service-Token` write gate).

## Context

`GET /entitlements/check` authorizes a digital download: it returns `{ok, active}` where
`active` is true iff an `active` entitlement row matches the query. As first shipped (Phase 4,
PR #11) it accepted `?sku` plus **either** `orderId` **or** `buyerRef` — and `buyerRef` is the
checkout email. With no auth and no rate limit, anyone could probe *"does email X own SKU Y"*:
an unauthenticated **existence oracle over email**. An in-code "ACCEPTED RISK" comment deferred
the fix to Phase 5's claim tokens; Phase 5 shipped sessions but never re-keyed the check, so
the oracle survived (#33).

The write gate (ADR-0007) does not help: it deliberately leaves GET/HEAD open as the storefront
read surface, so a GET is past the gate regardless of the service token.

Constraints: the domain stays IO-free; no new secret if an existing one suffices; existing
legitimate callers must keep working. The only in-repo caller is the plugin's public
`entitlements/download` route, which forwarded **untrusted public route input** straight into
`buyerRef` — so it is the same oracle one hop upstream and must change here too.

## Decision

`GET /entitlements/check` resolves a scope by **presence-based precedence** and authenticates
each scope independently. The precedence is keyed on what the request *contains*, evaluated top
to bottom — never on which scope the request best "fits":

1. **`buyerRef` present anywhere ⇒ operator auth required** (`X-Internal-Token`, via the
   existing `requireInternalToken`: unset ⇒ **503** "disabled, never silently open"; mismatch
   ⇒ **401**). On success the full query (an accompanying `orderId` is ANDed, as the store
   already does) is forwarded. Intended consumer: **admin/support tooling** — the same audience
   and same secret as `/admin/*`, `/reports/*`, `/settings`, and `/entitlements/grant`.
2. **else `orderId` present ⇒ open bearer-capability check.** The order id is a
   `crypto.randomUUID()` (122 random bits); possession is proof of a purchase receipt, delivered
   on the confirmation page and in status emails. A `Bearer` accompanying an orderId-only query
   is **ignored** — with no email in the query there is no oracle, and the capability must keep
   working for a guest who later created an unrelated account.
3. **else valid `Authorization: Bearer <session>` ⇒ session scope.** The `buyerRef` checked is
   the session customer's **own** email, derived server-side from `SessionStore.validate` +
   `CustomerStore.get` — never the query. Structural isolation identical to `/me/*`: a customer
   can only ever probe their own entitlements.
4. **else ⇒ 401.** This includes a sku-only request carrying a valid `X-Internal-Token`: the
   internal token gates the `buyerRef` **parameter**, it is not itself a scope (no principal to
   check).

`sku` remains the one always-required field (400 if absent). The plugin download route drops
`buyerRef` entirely and gains an optional `sessionToken` (threaded from the theme's
first-party cookie layer, exactly like the account routes); its client normalizes a 401 to a
typed `UNAUTHENTICATED`. (Superseded for that route by the 2026-10-05 amendment: the session
is now ignored.)

### Why `X-Internal-Token`, not the service token or a minted claim token

- **Not `X-Service-Token`:** the service token is provisioned **to the plugin** via kv (ADR-0007).
  Gating email probes with it would hand the probe capability to the exact sandbox surface we are
  stripping it from. The internal token is never given to the plugin.
- **Not a minted signed claim token** (the issue's suggestion): it would need a new secret, an
  HMAC mint step around `settleOrder`, and a delivery channel (status emails carry only
  `orderId`). But `orderId` is *already* an unguessable bearer capability, and sessions already
  provide revocable, expiring, hashed-at-rest identity — a claim token would duplicate both while
  adding key-rotation burden.

### Case-folding is a hard prerequisite of the session scope

`Email` is normalized lowercase, but `orders.buyer_ref` / `entitlements.buyer_ref` store the
checkout-entered string verbatim, and `checkoutBody.buyerRef` is only `z.string().min(1).max(320)`
— not email-validated (the port doc says "Email/session claim token"). So the session scope's
lower-normalized email would false-negative against a mixed-case checkout ref. `EntitlementStore.check`
therefore matches `buyerRef` **case-insensitively** (`lower(buyer_ref) = lower(?)`, mirroring
`OrderStore.linkGuestOrders`), enforced through the shared contract suite so every adapter complies.
Assumption stated: **`buyer_ref` carries email semantics — a case-distinct ref is the same
principal**. Folding is **not** injective in general (`lower` is many-to-one by construction —
e.g. `"A"` and `"a"` fold to the same key), so if a non-email `buyer_ref` (a hex wallet address,
an opaque x402 token) ever collided with another principal's ref under case-folding alone, this
check would conflate them. That risk is bounded, not eliminated, by *where* folding is allowed to
apply: only the operator-gated scope (1, behind `X-Internal-Token`) and the server-derived
session scope (3, `buyerRef` comes from `CustomerStore`, never client input) ever fold a
`buyer_ref` for matching. Scope 2 (`orderId`) never touches `buyer_ref` at all. So a folding
collision could only ever let an **authenticated operator** or a **customer's own verified
session** match a differently-cased ref — never an unauthenticated caller, and never a caller
supplying an arbitrary `buyerRef` of their choosing outside those two gated paths. The
non-email-ref case is a latent correctness risk worth tracking, not a new oracle.

The SQL `lower()` (both adapters) vs JS `String.prototype.toLowerCase()` (`kysely-entitlement-store.ts`
computes `query.buyerRef.toLowerCase()` in JS, then compares against `lower(buyer_ref)` in SQL) are
**not the same function**: SQLite's `lower()` is ASCII-only; Postgres's default (`C` collation)
`lower()` is likewise not full-Unicode-aware; JS `toLowerCase()` is full Unicode, including
locale-sensitive cases like Turkish dotted/dotless I (`İ`/`I` vs `i`/`ı`) that ASCII `lower()`
does not fold the same way. Where the two diverge, the failure mode is **fail-closed**: the JS
side folds a code point the SQL side does not (or vice versa), the two computed keys no longer
match, and `check` returns `false` for what should be an active entitlement — a false negative
(denied delivery to an entitled buyer), never a false positive (no unentitled buyer is ever
granted access). This is the same divergence already accepted for `OrderStore.linkGuestOrders`;
the contract fixture stays ASCII-cased because the adapters cannot be made to agree on
non-ASCII folding without a shared collation, and fail-closed is the safe default.

## Consequences

- **Wire break, called out in the changesets.** Any caller probing by email now needs
  `X-Internal-Token` (401/503 otherwise); the plugin `entitlements/download` route input drops
  `buyerRef` for `sessionToken` (since the 2026-10-05 amendment the route requires `orderId` and
  ignores the session); the client's `checkEntitlement` returns a typed `UNAUTHENTICATED`.
  Grep confirms the plugin was the only in-repo consumer.
- **The `internalToken`-disabled path returns 503, and that is expected-not-incident.** Local dev
  and any intentionally-token-disabled deploy will see 503 on a buyerRef-scoped check. 5xx
  monitoring/paging must treat this as by-design (the `requireInternalToken` contract, identical
  to `/entitlements/grant`), not an outage.
- **The token-gated raw-buyerRef scope has zero in-repo consumers** after the plugin drops it. It
  is kept deliberately for admin/support tooling. The **first real admin/support caller should
  confirm the wire shape end-to-end** — it ships covered only by the contract suite, not by a
  production caller. (Alternative considered: delete the scope until a consumer lands; rejected as
  a one-line re-add later, and support queries are a concrete near-term need.)
- **Session-scope under-reporting gap (tracked: issue #89).** Entitlements are keyed to the checkout
  email; `linkGuestOrders` re-keys **orders** to `customerId` at login but never entitlement rows. So a
  *logged-in* customer who checks out with a *different* delivery email gets an entitlement invisible
  to their session forever — recoverable only via the `orderId` capability. Not an open question — a
  known, bounded gap with a recovery path, tracked at
  https://github.com/UrumiAI/otta.sh/issues/89.
- **The orderId bearer-capability call is auditable.** Residual `orderId` exposure lands only in
  trusted/operator channels: GET query strings in server/proxy access logs, Stripe webhook metadata,
  the admin UI. The plugin invokes the download check as a **POSTed route input**, keeping the id out
  of browser history and `Referer`. This is what makes treating `orderId` as a bearer capability
  defensible.
- **Parity constraint with `GET /orders/:id` (tracked: issue #90).** That endpoint is *already* a
  full-order-content `orderId` bearer capability (the checkout redirect poll) — and it is the
  **higher-value** half: it serializes `buyerRef` (the email) to any order-id holder, leaking
  identity, not just a yes/no. So issue #89 above must not be read as implying `/entitlements/check`
  is the primary residual oracle; any future tightening of orderId-as-capability must cover **both
  endpoints together**, with `/orders/:id` the priority. Tracked at
  https://github.com/UrumiAI/otta.sh/issues/90.

## Alternatives considered

- **Minted signed claim token** — rejected (new secret + mint step + delivery channel; duplicates
  the orderId capability and the session).
- **Gate the buyerRef scope with `X-Service-Token`** — rejected (kv-provisioned to the plugin; would
  re-arm the oracle on the sandbox side).
- **Rate-limit instead of authenticate** — rejected as the primary fix (a limiter slows a probe but
  does not close the oracle); with buyerRef gated and orderId at 122 bits, a limiter adds ops
  complexity without closing anything further. A possible future addition, not a substitute.
- **Delete the raw-buyerRef scope outright** — deferred; kept for the near-term admin/support need.

## Amended 2026-10-05 — the download route is order-scoped only

Issue #376 (downloads increment 2) turned `entitlements/download` from a yes/no check into the
delivery gate: it answers the file to stream only when the grant is active, the order is in a
state that kept its money, the product is digital and its file is bound to it. That gate reads
one named order, which changes how the route uses this record's scopes. The entitlement check's
own scope rules above are unchanged.

- **`orderId` is required, and holding it is the authorization** — scope 2, as decided above.
- **A `sessionToken` sent with it is ignored**, exactly as scope 2 already rules for a Bearer
  next to an `orderId`. So a guest who later signs in to an unrelated account keeps access.
- **The session-only scope (scope 3) is gone from this route.** "Any order of mine" names no
  order for the gate to read, so such a request is now `INVALID_INPUT`. The account page links
  with the order's own id and loses nothing.
- **The route's old fallback is removed.** It tried the order id, then, if that order had no
  grant, the session's own entitlements. Once delivery is per order, that let one buyer's
  session authorize a download on another buyer's order id, with the other order deciding what
  was served. A contract case pins that this is now refused.
- Every data-dependent refusal is one `NOT_FOUND`; `NOT_ENTITLED` and `UNAUTHENTICATED` are no
  longer answered by the route.

The Consequences bullet on the wire break and the Decision's note on the download route's
`sessionToken` describe the route as it was before this amendment.
