# 0005. The commerce service sends transactional email directly

- Status: proposed
- Date: 2026-07-11
- Refines: ADR-0002 (the plugin→service direction; host-agnostic service)

## Context

Phase 5 fires transactional emails (magic-link login, order-status transitions). component-map.md
left the tier open: EmDash's plugin `email:send` capability + hook pipeline, vs. the commerce
**service** sending mail itself (SMTP / transactional API).

## Decision

The **service sends email directly** — an `EmailSender` port with a concrete adapter
(`ConsoleEmailSender` as the dev default; `HttpEmailSender` for a transactional-API provider;
the vendor is an implementation detail behind the port) — **not** via EmDash's `email:send`.

Delivery is exactly-once via a service-owned **outbox**: the guarded state `UPDATE` and the
`order_emails_outbox` `INSERT` commit in one transaction (`UNIQUE(order_id, to_state)`), and a
cron dispatcher claims rows with an atomic conditional `UPDATE` (lease-based), so neither a crash
nor concurrent dispatchers can double-send.

## Consequences

- **Right dependency direction.** Most triggers originate service-side (a Stripe webhook, an
  admin REST call) and never pass through the plugin's request lifecycle; routing through
  `email:send` would invert the plugin→service direction ADR-0002 fixed the architecture around.
- The outbox is naturally commerce-service state; splitting "did we send" from "the sender"
  across the plugin boundary would add a synchronization problem with no benefit.
- **Host-agnostic** (ADR-0002): the service works for non-EmDash storefronts; an
  `email:send`-dependent design would pin transactional email to EmDash.
- Reuses the `PaymentGateway` precedent (a service-owned port, adapters swapped by deployment).
- The service needs its own outbound-email credentials/deliverability (SPF/DKIM) — an ops task.
  If EmDash's pipeline is preferred later, it is an additional `EmailSender` adapter, not a
  redesign.
- The plugin declares **no** `email:send` capability — confirmed by the sandbox capability-surface
  check (only `content:read` + `network:request`).

_Awaiting decision-maker sign-off (implemented per the Phase 5 plan §6 recommendation)._
