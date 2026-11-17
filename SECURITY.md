# Security Policy

## Supported versions

Otta is pre-1.0. Only `main` and the latest `0.x` release on npm are supported; there are no LTS
branches yet. `@urumi.ai/otta-plugin@0.1.0` is deprecated on npm: a site that bundled it shipped
its own build environment variables inside its Worker. Upgrade to `0.2.0` or later and redeploy;
if a sensitive value was in that build environment, rotate it. The other packages' `0.1.0` releases are not affected.

## Reporting a vulnerability

Please report suspected security vulnerabilities **privately** — do not open a public
GitHub issue. Email **vedanshu@urumi.ai** with details and, if possible, steps to
reproduce. You can also use GitHub's private vulnerability reporting on this repository:
[**Report a vulnerability**](https://github.com/UrumiAI/otta.sh/security/advisories/new).

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
