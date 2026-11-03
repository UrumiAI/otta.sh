# 0043. The reference site registers EmDash's Cloudflare email provider when `OTTA_EMAIL_FROM` is set

- Status: accepted
- Date: 2026-11-03
- Refines: [ADR-0031](./0031-email-through-emdash-host.md) (email goes through the host's
  `ctx.email`; otta core ships no provider). The decision that core ships no provider stands.
  What changes is the site's default and one failure mode: a provider that is selected but
  broken takes 0031's provider-FAILURE path (counted attempts, rows parked `failed`), not its
  no-provider path (nothing spent, mail waits). See Consequences.

## Context

ADR-0031 left a freshly deployed store with no email provider, so magic-link sign-in and
order email did nothing until the merchant wrote or installed a plugin. One-click deploy
needs email to work on day one. EmDash's `@emdash-cms/cloudflare` already ships a
first-party provider, `cloudflareEmail({ from, binding })`, which sends through a Workers
`send_email` binding (Cloudflare Email Sending) and is auto-selected when it is the only
active provider.

## Decision

1. The **reference site** (`sites/staging`), not `packages/*`, registers `cloudflareEmail`
   when the build variable `OTTA_EMAIL_FROM` is set (optionally `OTTA_EMAIL_FROM_NAME`). It is
   appended after the two Otta descriptors (`plugins[0]` stays the Block Kit descriptor).
   The value is validated at build time (`src/lib/email-from.ts`); a malformed one fails
   the build.
2. When unset, **nothing is registered**: today's fail-closed "no provider" state (ADR-0031).
3. `wrangler.jsonc` carries the unrestricted `send_email` binding `EMAIL` COMMENTED OUT
   (opt-in, like `ratelimits`): an unrestricted binding is not verified to deploy on a
   Workers Free account with no Email Sending set up. The sender address is a build variable,
   not a secret and not a `vars` entry.
4. A BUILD GUARD ties the two together: with `OTTA_EMAIL_FROM` set, the wrangler config the
   build uses (`wrangler.local.jsonc` if present, else `wrangler.jsonc`) must declare
   `send_email` named `EMAIL`, or the build throws naming the file
   (`src/lib/email-binding.ts`). It also refuses a binding that sets `destination_address` or
   `allowed_destination_addresses` (blocked buyer sends are counted attempts too) or an
   `allowed_sender_addresses` that omits the sender.
5. The **playground** does not get it. `buildEmdashOptions` takes the sender as a parameter
   and never reads the environment, and the playground never passes one.
6. Core stays vendor-free: no email code in `packages/*`, no new Otta `allowedHosts`.
   Other vendors remain the documented bring-your-own path
   (`docs/email-providers.md`, `examples/email-provider/`).

## Consequences

- A merchant on Workers Paid with a domain on Cloudflare sets one variable and onboards the
  domain; the Free plan has no outbound Email Sending, so it cannot use this default
  (DEPLOYMENT.md §3, Email).
- The site depends on EmDash's provider and its `EMAIL` binding name; an EmDash change to
  either is a site change, not a core change.
- In `astro dev` with the provider registered, a fresh local D1 auto-selects neither it nor
  the console provider, so dev mail is not captured until one is picked in EmDash Settings >
  Email; an existing D1 keeps its saved selection. Keep `OTTA_EMAIL_FROM` out of
  `sites/staging/.env` for local dev (DEPLOYMENT.md §3).
- **Selected-but-broken is worse than unset.** EmDash auto-selects the only provider and
  persists the choice. With the binding missing, the domain not active, or Workers Free,
  every send throws a plain Error (not `EmailNotConfiguredError`). Each is a counted attempt,
  so order-email rows park `failed` after five tries (about 25 minutes) with no re-queue, and
  sign-in links never arrive. Hence the build guard, the opt-in binding, and the ordering in
  DEPLOYMENT.md §3 (domain active, Paid, test send succeeds, THEN set `OTTA_EMAIL_FROM`).
  The guard cannot see the plan or the domain state; those stay an operator checklist.
- **PII in logs.** The provider logs `to` and `subject` with `ctx.log.info` on every send, and
  Workers Logs are persisted (the repo disabled invocation logs for the same reason). Buyer
  addresses are retained in Worker logs. Documented in DEPLOYMENT.md §3; not mitigated in code.
- **The playground build imports `astro.config.ts`**, so a malformed `OTTA_EMAIL_FROM` also
  fails the playground build. Accepted. The playground never registers the provider.
- **Bring-your-own provider while `OTTA_EMAIL_FROM` is set:** two providers are active; unset
  the variable, or re-select in Settings > Email (a persisted selection sticks).
