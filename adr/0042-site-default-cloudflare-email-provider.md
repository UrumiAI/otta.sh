# 0042. The reference site registers EmDash's Cloudflare email provider when `OTTA_EMAIL_FROM` is set

- Status: accepted
- Date: 2026-11-03
- Refines: [ADR-0031](./0031-email-through-emdash-host.md) (email goes through the host's
  `ctx.email`; otta core ships no provider). Nothing in 0031 is reversed.

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
3. `wrangler.jsonc` declares the unrestricted `send_email` binding `EMAIL`. The sender
   address is a build variable, not a secret and not a `vars` entry.
4. The **playground** does not get it. `buildEmdashOptions` takes the sender as a parameter
   and never reads the environment, and the playground never passes one.
5. Core stays vendor-free: no email code in `packages/*`, no new Otta `allowedHosts`.
   Other vendors remain the documented bring-your-own path
   (`docs/email-providers.md`, `examples/email-provider/`).

## Consequences

- A merchant on Workers Paid with a domain on Cloudflare sets one variable and onboards the
  domain; the Free plan has no outbound Email Sending, so it cannot use this default
  (DEPLOYMENT.md §3, Email).
- The site depends on EmDash's provider and its `EMAIL` binding name; an EmDash change to
  either is a site change, not a core change.
- With the provider plus `astro dev`'s console provider, two providers are active; select one
  in EmDash Settings > Email.
