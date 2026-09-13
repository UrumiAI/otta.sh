# @otta-sh/store-emdash

Commerce store adapters over EmDash's plugin-storage primitives.

## The host this needs

The port is written against the **conditional-write primitives** — `updateIf`,
`getVersioned`, `compareAndSet`, `compareAndDelete`. No published `emdash`
release carries them yet. The manifest's `emdash` specifier is the plain
registry version so that adopting a release is a one-line change, and until then
the workspace override redirecting it to the vendored build is **load-bearing**:
without it the package resolves a host that lacks the primitives, and the failure
is a type error against a real installed package rather than a missing dependency.

## The seam

`src/storage-access.ts` declares a **structural `StorageAccess` port**: the nine
methods the adapters use, written in terms of the host's own types via
`import type`. Nothing in `src/` imports host code at runtime — three
dependency-cruiser rules in `pnpm lint` enforce that, the react quarantine, and
the sandbox perimeter. Production injects `ctx.storage`, tests inject a real
repository; `collectionOf<T>` is the single audited narrowing between the untyped
map and a typed collection.

## The dialect harness

`test/describe-each-dialect.ts` builds the port out of **real
`PluginStorageRepository` instances** on in-memory SQLite, and on Postgres when
`PG_CONNECTION_STRING` is set. One database per test FILE; rows are cleared
between cases. Real databases, never mocks: only Postgres can lose a race, so the
concurrency case runs there alone.

The schema always comes from the host's `runMigrations`; never hand-create the
storage table. Revisions come from a trigger that migration creates — which is
also why cases reset by emptying the table rather than recreating it.

## Known gap: no physical indexes

Declared indexes reach a collection through the repository's `indexes`
constructor argument — indexes plus unique indexes, as the host composes them —
and that argument is only the **queryable-field allow-list**. The host's
index-materializing function is unexported, so neither tier creates a physical
index, and a `uniqueIndexes` declaration enforces **nothing** here. No adapter may
depend on the host to reject a duplicate: once-only has to be enforced by a
conditional write.
