# Architecture Decision Records

This folder records the **actual architecture decisions** for Urumi — the ones we commit
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

- [0001. Plugin + separate commerce service](./0001-plugin-plus-commerce-service.md) — accepted
- [0002. Adapter-based split (boundary is a deployment choice)](./0002-adapter-based-split.md) — accepted, refines 0001
- [0003. Storefront pages are plugin-owned public routes](./0003-storefront-plugin-routes.md) — accepted, refines 0001
- [0004. Storefront customer auth is magic-link](./0004-customer-auth-mechanism.md) — accepted, refines 0001
- [0005. The commerce service sends transactional email directly](./0005-transactional-email-transport.md) — accepted, refines 0002
- [0006. First-party deployments may register the plugin trusted (in-process)](./0006-trusted-in-process-deployment.md) — accepted, refines 0001/0003
- [0007. The machine write-gate token uses a dedicated `X-Service-Token` header](./0007-dedicated-service-token-header.md) — accepted, refines the `SERVICE_API_TOKEN` write gate

## Queued (to promote from draft-plans)

Decisions already made that should each become an ADR:

- Hybrid product model (content in CMS, commerce in service)
- Separate commerce database (no cross-DB joins)
- Backend-agnostic atomic inventory via single-statement conditional UPDATE
- Pluggable payments (Stripe + x402 in parallel)
- On-screen commercial editing via a Block Kit field widget
- Customer accounts owned by the commerce service (not EmDash `ctx.users`)
