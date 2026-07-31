# Architecture Decision Records

This folder records the **actual architecture decisions** for Otta — the ones we commit
to. Unlike [`../draft-plans/`](../draft-plans/) (private, gitignored), ADRs are part of
the public repo: they explain *why* the system is the way it is, for contributors and our
future selves.

## Format

One file per decision: `NNNN-short-title.md`, numbered in order. Each record:

```
# NNNN. Title

- Status: proposed | accepted | superseded by ADR-XXXX
- Date: YYYY-MM-DD

## Context
What forces are at play — the problem, constraints, options considered.

## Decision
What we decided, stated plainly.

## Consequences
What becomes easier, what becomes harder, what we accept as a tradeoff.
```

Keep them short and durable. Amend by adding a new ADR that supersedes an old one, rather
than rewriting history.

## Records

- [0001. Plugin + separate commerce service](./0001-plugin-plus-commerce-service.md) — accepted, amended 2026-07-29 (the product-data field widget was removed), extended 2026-07-30 (the title projection became ADR-0013)
- [0002. Adapter-based split (boundary is a deployment choice)](./0002-adapter-based-split.md) — accepted, refines 0001
- [0003. Storefront pages are plugin-owned public routes](./0003-storefront-plugin-routes.md) — accepted, refines 0001
- [0004. Storefront customer auth is magic-link](./0004-customer-auth-mechanism.md) — accepted, refines 0001
- [0005. The commerce service sends transactional email directly](./0005-transactional-email-transport.md) — accepted, refines 0002
- [0006. First-party deployments may register the plugin trusted (in-process)](./0006-trusted-in-process-deployment.md) — accepted, refines 0001/0003
- [0007. The machine write-gate token uses a dedicated `X-Service-Token` header](./0007-dedicated-service-token-header.md) — accepted, refines the `SERVICE_API_TOKEN` write gate; refined by 0010
- [0008. Order refunds are an append-only ledger + a gateway `refund` verb](./0008-order-refunds.md) — accepted, refines 0001/0002 (pluggable payments)
- [0009. Checkout captures an immutable shipping-address snapshot on the order](./0009-checkout-address-capture.md) — accepted, refines 0001/0004
- [0010. The admin read surface requires `X-Internal-Token`](./0010-admin-read-surface-requires-internal-token.md) — accepted, refines 0007
- [0011. `GET /entitlements/check` authenticates each scope (close the email existence oracle)](./0011-entitlement-check-authentication.md) — accepted, refines 0001, builds on 0004/0007
- [0012. The storefront checkout loads Stripe Elements in the buyer's browser](./0012-storefront-checkout-loads-stripe-elements-in-the-browser.md) — accepted, refines 0003, builds on 0006/0009/0010
- [0013. Product title is CMS-owned; `product_commerce.title` is a derived single-writer cache](./0013-product-title-is-cms-owned.md) — accepted, refines 0001/0002 (the hybrid product model); promotes the queued "one home per field" decision, and completes the 2026-07-29 amendment on ADR-0001 (commercial fields are edited only in the admin console)

## Queued (to promote from draft-plans)

Decisions already made that should each become an ADR:

- Hybrid product model (content in CMS, commerce in service)
- Separate commerce database (no cross-DB joins)
- Backend-agnostic atomic inventory via single-statement conditional UPDATE
- Pluggable payments (Stripe + x402 in parallel)
- Customer accounts owned by the commerce service (not EmDash `ctx.users`)
