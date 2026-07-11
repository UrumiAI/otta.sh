# 0004. Storefront customer auth is magic-link (behind a two-port split)

- Status: proposed
- Date: 2026-07-11
- Refines: ADR-0001 (the commerce service owns a customer identity separate from EmDash `ctx.users`)

## Context

Phase 5 needs a storefront **customer** identity — separate from EmDash's admin/staff
`ctx.users` — with login, sessions, saved addresses, and order history. component-map.md and
design-decisions.md left the mechanism open (password / magic-link / passkey), noting it "can
mirror `@emdash-cms/auth` patterns" but must be a **separate identity**. The mechanism-specific
part had to be isolated so the rest of the phase (sessions, `/me`, address book, account pages)
could proceed independent of the still-open decision.

## Decision

Ship **magic-link (passwordless email link)** as the v1 mechanism, behind a **two-port split**:

- `CustomerCredentialVerifier` — mechanism-specific (`issueChallenge` / `verifyChallenge`).
- `SessionStore` — mechanism-agnostic (`create` / `validate` / `revoke`), opaque DB-backed
  tokens (not JWT), stored only as a hash.

Everything downstream of `SessionStore.validate` depends **only** on `SessionStore`, never on
the verifier. Sessions are opaque and DB-backed so revocation actually works.

## Consequences

- **No password-storage liability** and no "forgot password" flow before v1 ships; the
  `EmailSender` port exists on day one (login email + status emails share it — see ADR-0005).
- Matches the sandbox constraint (no client-side WebAuthn crypto to test under workerd).
- Swapping to passkey/password later means a new `CustomerCredentialVerifier` adapter and its
  two `/auth/*` routes only — zero changes to sessions, authorization, or account pages.
- A customer without immediate email access can't log in; mitigated by a long-lived session.
- **Guest-order linking** (§9 Risk 3): a successful magic-link login proves inbox ownership, so
  guest orders with a matching `buyer_ref` are claimed automatically at login. This linkage
  depends on the mechanism proving email ownership — revisit if the mechanism (this ADR)
  changes to one that doesn't (e.g. plain password).

_Awaiting decision-maker sign-off (implemented per the Phase 5 plan §4 recommendation)._
