---
"@otta-sh/plugin": minor
---

Delete the HTTP transport, and with it the last two packages that only existed
to serve it.

**`@otta-sh/service` and `@otta-sh/store-postgres` are removed from the
workspace and will not be published again.** Neither can be named in this
changeset's frontmatter — changesets refuses a release plan for a package whose
directory is gone — so their removal is recorded here, in the prose of the
package that outlived them. The commerce use-cases they wrapped were folded into
the plugin in the preceding slices: `@otta-sh/store-emdash` holds the state the
Kysely adapter used to hold, and the in-process clients answer the calls the
Hono app used to answer. Nothing was dropped on the way across; what is deleted
is the transport and its two homes, not the behaviour.

Anyone still depending on either package should stop: there is no successor
published under those names. The last published versions remain installable but
are frozen, and their migrations no longer track the schema `@otta-sh/store-emdash`
writes.

**`minor`, not `patch`: the package index loses public exports.** Six names are
gone from `@otta-sh/plugin`'s entry point, all of them the HTTP clients or their
options:

- `HttpCommerceClient`
- `AdminOrdersClient`
- `AdminProductsClient`
- `AdminRulesClient`
- `ReportingSettingsClient`
- the `AdminRulesClientOptions` type

Each had an in-process twin that has been the only implementation constructed
since the mode collapse, so no plugin code path changes. Only an importer that
reached past `makeCommerceClient(ctx)` / `makeAdminClients(ctx)` for a concrete
class is affected, and that importer should be taking the factory instead — it
returns the port, which is what the call sites were always typed against.

The wire tests, the live-service test harness and the REST route surface they
exercised go with the clients. The behavioural contract they enforced does not:
it still runs, against the in-process clients, in the same shared suite. The two
Postgres-required concurrency races the deleted adapter suite held — a
once-only note append under a shared idempotency key, and a single audit event
under racing state flips — were re-pointed at `@otta-sh/store-emdash`'s own
stores rather than retired with it.
