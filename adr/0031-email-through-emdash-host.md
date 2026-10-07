# 0031. Email goes through the EmDash host's `ctx.email`; otta ships no email provider

- Status: accepted
- Date: 2026-10-07
- Supersedes: [ADR-0005](./0005-transactional-email-transport.md) **the transport decision
  only** ("the commerce layer sends email itself, not via EmDash's `email:send`") and its
  2026-10-05 provider amendment. The outbox, its exactly-once enqueue and claim, and its
  at-least-once delivery all stand.
- Amends: [ADR-0006](./0006-trusted-in-process-deployment.md) and
  [ADR-0018](./0018-plugin-owns-commerce-truth-in-process.md) — the plugin declares a
  **third** capability, `email:send`. It widens no host: `allowedHosts` is Stripe's API host
  plus the x402 facilitator when one is configured.
- Relates to: [ADR-0004](./0004-customer-auth-mechanism.md) (the sign-in email, its 3 s cap
  and throttle are unchanged).
- Numbered 0031 because 0030 is reserved by the tax-calculator branch (PR #414).

## Context

otta carried its own email vendors: a Resend-shaped HTTP sender, an SMTP2GO sender, their
write-only API keys, a from-address setting, a provider and region choice, and their hosts
on `allowedHosts`. That is third-party integration code in core, against the product
principles (lean, global, no vendor code in core; payments are the one exemption for now).

EmDash already owns email providers. A site installs one provider plugin (the `email:deliver`
exclusive hook, registered with the `email:provide` capability) and selects it in EmDash's
Settings > Email. Any plugin that declares `email:send` gets `ctx.email.send(message)`, and
the host runs `email:beforeSend` hooks, the selected provider, then `email:afterSend` hooks.

Facts verified against emdash 0.38.0 (installed):

- `EmailMessage` is `{ to, subject, text, html? }`. There is **no `from`** and **no
  idempotency key**.
- **Trusted mode:** `ctx.email` is `undefined` unless a provider is selected.
- **Sandboxed:** `ctx.email` is always present once `email:send` is declared. With no
  provider, `send` rejects. The sandbox bridge says "Email is not configured. No email
  provider is available."; the host pipeline throws `EmailNotConfiguredError`, "No email
  provider is configured. …". A bridge rebuilds a plain `Error`, so only the message is
  reliable.
- A `beforeSend` hook can cancel a send; `send` then resolves as if it went.
- Providers that ship with EmDash: `cloudflareEmail({ from })` (needs a `send_email`
  binding) and, in dev only, a console provider.

## Decision

1. **One adapter, no vendors.** `CtxEmailSender` (`packages/plugin/src/email/ctx-email-sender.ts`)
   implements the unchanged `EmailSender` port: it renders with the existing renderer (the
   storefront's money, the store name — "Store display name", else the EmDash site name —
   and the order page link) and calls `ctx.email.send`. Every email-vendor file, setting,
   secret, key shape and host is removed from core.
2. **No provider fails closed, and spends nothing.**
   - Trusted: `ctx.email` absent ⇒ no sender; the cron leg reports `skipped` and claims
     nothing; the inline send reports `unconfigured`; the sign-in request answers its
     generic success and issues no challenge.
   - Sandboxed: both "not configured" messages (and the error name) become the domain's
     `EmailTransportUnavailableError`. The dispatcher releases the row **uncounted**, due
     again after `TRANSPORT_UNAVAILABLE_RETRY_MS` (5 min), and stops the drain. The cron leg
     and the inline send report it as unconfigured. The answer is also recorded in kv
     (`state:emailTransportUnavailableAt`); while it is fresh (5 min) the cron leg, the
     inline send and the sign-in request stop **before** claiming a row or minting a
     challenge, and Settings shows "no provider". After that one send tries again. Pinned by
     the domain contract suite (`emailRecipientContract`, every dialect) and by
     `ctx-email-sender.test.ts`, which pins both strings verbatim.
3. **At-least-once, bounded — a deliberate change.** `ctx.email` takes no idempotency key and no abort signal, so
   the send is raced against the existing ceilings (3 s login, 3 s inline, 5 s sweep) and a
   timeout is re-thrown as a **counted** attempt (`countTimeoutsAsAttempts`, outermost).
   Duplicates are bounded by the row's `maxAttempts` (5). Before, a timeout on the
   Resend-shaped sender was uncounted (up to ten, backed off) because Resend deduped the
   retry; with no idempotency key that would multiply duplicates, so a slow provider now
   parks a row `failed` after five timed-out sends. The uncounted-timeout path in the
   domain stays for other callers; the plugin no longer uses it. A query-ceiling refusal
   while building the sender (before any send) is still released uncounted.
4. **The extension point is EmDash's.** otta adds no provider registry of its own. A store
   that wants a provider EmDash does not ship writes a small EmDash email-provider plugin;
   `docs/email-providers.md`, an example and a test helper are the supported path. The
   admin Settings screen shows one line: "sent via EmDash's email provider", or "no EmDash
   email provider … see docs/email-providers.md".
5. **Stale credentials.** The keys earlier builds stored (`settings:emailApiKey`,
   `settings:emailSmtp2goApiKey` and their save generations) are no longer read. They are
   purged once, behind a marker key (a separate, droppable change).

## Consequences

- Live stores that sent through SMTP2GO or a Resend-shaped URL go quiet until the site
  selects an EmDash provider. Rows queue without spending attempts. When a provider is
  selected the backlog goes out, including old status mail; there is no max age.
- Lost: the per-store from-address setting (now the provider's), and Resend's 24 h
  idempotency (dedup becomes bounded duplicates).
- In a sandboxed host the plugin cannot tell "no provider" until it sends. Until the first
  refused send (and again once each 5-minute record lapses) one outbox row is claimed and
  released uncounted, or one sign-in request mints a challenge (spending a throttle slot)
  before its send is refused; the Settings line reads as configured until then. The
  `order-emails` leg pays one kv read per tick with an email due to check the record.
- **Trust widening (security).** The sign-in link carries a bearer token. Through `ctx.email`
  it now passes every installed plugin's `email:beforeSend`/`email:afterSend` hooks and the
  provider plugin, not only otta's own sender. EmDash's dev console provider prints part of
  the text and keeps the message (dev only). A site must treat email hooks as trusted code.
- The "not configured" detection matches host error messages. An EmDash upgrade that rewords
  them fails `ctx-email-sender.test.ts` rather than silently spending attempts; re-verify on
  EmDash 1.x.
