# 0008. `GET /entitlements/check` authenticates each scope (close the email existence oracle)

- Status: accepted
- Date: 2026-07-14
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
`buyerRef` entirely and gains an optional `sessionToken` (threaded from the theme's first-party
cookie layer, exactly like the account routes); its client normalizes a 401 to a typed
`UNAUTHENTICATED`.

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
principal**; for the non-email refs that could appear (hex wallet addresses / opaque x402 tokens)
lowercasing is **injective**, so folding never conflates distinct principals. The SQLite `lower()`
(ASCII-only) vs JS `toLowerCase` (full Unicode) divergence is the same one already accepted for
`linkGuestOrders`; the contract fixture is ASCII-cased.

## Consequences

- **Wire break, called out in the changesets.** Any caller probing by email now needs
  `X-Internal-Token` (401/503 otherwise); the plugin `entitlements/download` route input drops
  `buyerRef` for `sessionToken`; the client's `checkEntitlement` returns a typed `UNAUTHENTICATED`.
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
- **Session-scope under-reporting gap (tracked).** Entitlements are keyed to the checkout email;
  `linkGuestOrders` re-keys **orders** to `customerId` at login but never entitlement rows. So a
  *logged-in* customer who checks out with a *different* delivery email gets an entitlement invisible
  to their session forever — recoverable only via the `orderId` capability. Filed as a tracked
  follow-up: *"[Domain] Re-key entitlements to customerId at login (linkGuestOrders parity)"*. Not an
  open question — a known, bounded gap with a recovery path.
- **The orderId bearer-capability call is auditable.** Residual `orderId` exposure lands only in
  trusted/operator channels: GET query strings in server/proxy access logs, Stripe webhook metadata,
  the admin UI. The plugin invokes the download check as a **POSTed route input**, keeping the id out
  of browser history and `Referer`. This is what makes treating `orderId` as a bearer capability
  defensible.
- **Parity constraint with `GET /orders/:id`.** That endpoint is *already* a full-order-content
  `orderId` bearer capability (the checkout redirect poll) — and it is the **higher-value** half:
  it serializes `buyerRef` (the email) to any order-id holder, leaking identity, not just a yes/no.
  So the tracked follow-up above must not imply `/entitlements/check` is the primary residual oracle;
  any future tightening of orderId-as-capability must cover **both endpoints together**, with
  `/orders/:id` the priority.

## Alternatives considered

- **Minted signed claim token** — rejected (new secret + mint step + delivery channel; duplicates
  the orderId capability and the session).
- **Gate the buyerRef scope with `X-Service-Token`** — rejected (kv-provisioned to the plugin; would
  re-arm the oracle on the sandbox side).
- **Rate-limit instead of authenticate** — rejected as the primary fix (a limiter slows a probe but
  does not close the oracle); with buyerRef gated and orderId at 122 bits, a limiter adds ops
  complexity without closing anything further. A possible future addition, not a substitute.
- **Delete the raw-buyerRef scope outright** — deferred; kept for the near-term admin/support need.
