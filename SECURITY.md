# Security Policy

## Supported versions

Otta is pre-1.0. Only `main` / the latest published version is supported; there are no LTS
branches yet.

## Reporting a vulnerability

Please report suspected security vulnerabilities **privately** — do not open a public
GitHub issue. Email **support@urumi.ai** with details and, if possible, steps to reproduce.

This is a solo-maintainer project, so response times are best-effort, not SLA'd:
acknowledgement within a few business days is a reasonable expectation, not a commitment.

## Scope

Because Otta is a commerce/money system, correctness bugs that break its core invariants
are in scope even if they don't look like a classic vulnerability — for example, a race that
lets a buyer oversell stock, double-charge, or otherwise defeat idempotency. See
[`DEVELOPMENT.md` §4](./DEVELOPMENT.md#4-commerce-invariants-rules-emdash-doesnt-need) for
the full list of invariants. If you find a way to break one of them, please report it
through the same private channel above.

We don't currently run a bug-bounty program or offer safe-harbor legal terms — this is a
pre-1.0 open-source project without a legal review budget behind it.
