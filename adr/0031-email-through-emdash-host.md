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
- Numbered 0031 because 0030 is the tax-calculator ADR (PR #414).

## Context

otta carried its own email vendors: a Resend-shaped HTTP sender, an SMTP2GO sender, their
write-only API keys, a from-address setting, a provider and region choice, and their hosts
on `allowedHosts`. That is third-party integration code in core, against the product
principles (lean, global, no vendor code in core; payments are the one exemption for now).

EmDash already owns email providers. A site installs one provider plugin (the `email:deliver`
exclusive hook, registered with the `hooks.email-transport:register` capability;
`email:provide` is its deprecated alias, warned at bundle time and refused at publish) and selects it in EmDash's
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
     the domain contract suite (`emailRecipientContract`, every dialect).
   - The match is EXACT: the error name `EmailNotConfiguredError`, or a message equal to
     one of EmDash's two texts. Never a substring: a provider's own error may quote the
     recipient, and a buyer chooses the recipient (security review F1).
3. **At-least-once, bounded — a deliberate change.** `ctx.email` takes no idempotency key and no abort signal, so
   the send is raced against the existing ceilings (3 s login, 3 s inline, 5 s sweep) and a
   timeout is re-thrown as a **counted** attempt (`countTimeoutsAsAttempts`, outermost).
   Duplicates are bounded by the row's `maxAttempts` (5). Before, a timeout on the
   Resend-shaped sender was uncounted (up to ten, backed off) because Resend deduped the
   retry; with no idempotency key that would multiply duplicates, so a slow provider now
   parks a row `failed` after five timed-out sends — including a send the sweep itself
   cut short because the tick was running out of time (it may have been delivered too).
   An inline send starts only with at least 1 s of its wait left (`MIN_INLINE_SEND_MS`,
   the sweep's `MIN_SEND_MS` counterpart); otherwise the row is released untried and
   uncounted for the cron, so a near-zero allowance never turns into a delivered "timeout"
   that is then repeated (PR #418 review).
   `onRepeatedTimeouts` therefore no longer fires for the plugin's sender. The uncounted-timeout path in the
   domain stays for other callers; the plugin no longer uses it. A query-ceiling refusal
   while building the sender (before any send) is still released uncounted.
4. **The extension point is EmDash's.** otta adds no provider registry of its own. A store
   that wants a provider EmDash does not ship writes a small EmDash email-provider plugin;
   `docs/email-providers.md`, an example and a test helper are the supported path. The
   admin Settings screen shows one line in three states: "sent via EmDash's email
   provider" once the host has accepted a send (`state:emailLastSentAt`, newer than any
   "no provider" answer), "provider not confirmed" until then, or "no EmDash email
   provider"; the last two point at docs/email-providers.md.
5. **Stale credentials.** The keys earlier builds stored (`settings:emailApiKey`,
   `settings:emailSmtp2goApiKey` and their save generations) are no longer read. A cron
   tick purges them once, behind a marker key, but only after the host's provider has
   accepted a send: until then a rollback to the earlier build still finds them (PR #418
   review). Known limit: on a sandboxed host, an installed plugin whose `email:beforeSend`
   hook CANCELS otta's message makes `send()` resolve before EmDash checks for a provider,
   so that counts as a confirmed send and the purge can run with no provider selected (the
   cancelled order email is marked sent as well). Only an admin installing such a plugin
   can cause it; a buyer cannot. Trusted mode is unaffected (`ctx.email` exists only once
   a provider is selected).
6. **Old email is not sent (user decision, 2026-10-07).** An outbox row older than 72 hours
   (`OUTBOX_EMAIL_MAX_AGE_MS`, from when it was enqueued) is completed WITHOUT a send when
   the dispatcher claims it: terminal (`skipped`), no attempt spent, for every template.
   So a store that had no provider for days does not mail its buyers stale "shipped" or
   "cancelled" news the moment one is selected. A sign-in link never enters the outbox;
   it expires on its own (15 min). Pinned by `emailRecipientContract` on every store.

## Consequences

- Live stores that sent through SMTP2GO or a Resend-shaped URL go quiet until the site
  selects an EmDash provider. Rows queue without spending attempts. When a provider is
  selected the backlog goes out — only the last 72 hours of it (Decision 6).
- Lost: the per-store from-address setting (now the provider's), and Resend's 24 h
  idempotency (dedup becomes bounded duplicates).
- In a sandboxed host the plugin cannot tell "no provider" until it sends. Until the first
  refused send (and again once each 5-minute record lapses) one outbox row is claimed and
  released uncounted, or one sign-in request mints a challenge (spending a throttle slot)
  before its send is refused; the Settings line reads "provider not confirmed" until a send
  goes through. The
  `order-emails` leg pays one kv read per tick with an email due to check the record.
  After an operator selects a provider on a sandboxed host, allow up to 5 minutes for the
  record to lapse: until then order emails stay queued and a sign-in request sends nothing
  (it answers its generic success).
- **Trust widening (security).** The sign-in link carries a bearer token. Through `ctx.email`
  it now passes every installed plugin's `email:beforeSend`/`email:afterSend` hooks and the
  provider plugin, not only otta's own sender: any of them can read, log or forward it,
  and a provider's own delivery logs may keep it. EmDash's dev console provider prints the
  text and keeps the message (dev only). A site must treat every plugin with email hooks,
  and its provider, as able to sign in as any customer who requests a link. This amends
  ADR-0004's promise that the token travels nowhere a provider log could print it.
- The "not configured" detection matches host error texts exactly. Both are pinned against
  EmDash itself, not against copies: the sandbox bridge's text by
  `emdash-sandbox-rpc.sandbox.test.ts`, which calls EmDash's real `PluginBridge.emailSend`
  over the real Workers RPC; the pipeline's text by `ctx-email-sender.test.ts`, which reads
  it from the installed package's source. An EmDash upgrade that rewords either fails CI
  rather than silently spending attempts. Both texts are unchanged in EmDash 1.0.1.
