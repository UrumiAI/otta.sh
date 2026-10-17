# @otta-sh/store-emdash

Commerce store adapters over EmDash's plugin-storage primitives. Each commerce aggregate (inventory, cart, order, product-commerce, coupon, rules, identity, entitlement, payment events, settings, reporting) is one document, written with conditional-write primitives so concurrent writers cannot corrupt it.

## Install

```sh
pnpm add @otta-sh/store-emdash
```

Requires a host that carries the conditional-write primitives (`updateIf`, `getVersioned`, `compareAndSet`, `compareAndDelete`): `emdash` `~1.0.1`.

Published entry point: `@otta-sh/store-emdash` (ESM-only). Peer dependency: `emdash` `~1.0.1`. Part of [Otta](https://github.com/UrumiAI/otta.sh#readme).

## Usage

The adapters are written against a structural `StorageAccess` port (`src/storage-access.ts`) and never import host code at runtime. In production, inject the plugin's `ctx.storage`; in tests, build a real repository with the dialect harness in this repo, `test/describe-each-dialect.ts` (in-memory SQLite, and Postgres when `PG_CONNECTION_STRING` is set). It is not a published subpath.

## Design notes

Document models, index and claim design, contention budget, crash seams and the D1 test tier are in [docs/store-emdash/design-notes.md](https://github.com/UrumiAI/otta.sh/blob/main/docs/store-emdash/design-notes.md). The decision record is [ADR-0019](https://github.com/UrumiAI/otta.sh/blob/main/adr/0019-commerce-aggregates-are-one-document-each.md).

MIT licensed.
