# @otta-sh/plugin

The EmDash plugin: the storefront routes, the sync hooks, the Block Kit admin
screens — and, increasingly, commerce itself. Sandbox-clean by construction, which
is the constraint everything below is shaped by: no DB driver, no `node:` builtin,
no host import, one declared egress (`ctx.http` plus `allowedHosts`), and exactly
two declared capabilities.

## The commerce transport

Everything that touches commerce goes through the `CommerceClient` port and
obtains it from **one** composition root, `src/commerce/make-commerce-client.ts`.
There are two implementations behind that port:

- `HttpCommerceClient` — the commerce service over `ctx.http`. Transitional.
- `InProcessCommerceClient` — the domain's use-cases composed over the
  `@otta-sh/store-emdash` adapters, bound to the plugin's own document store.
  No service, no egress at all.

The build-time mode picks one. It is pinned to the HTTP transport, and the flag,
the branch and the HTTP client are all removed once the in-process client has
replaced them — **nothing may be designed around the flag.**

### Where commerce truth lives

`ctx.storage` — the per-plugin document store the host builds from the
descriptor's declared collections and injects on every invocation. It needs no
capability: the host builds it on an always-available path and there is no
`storage` capability string to declare (ADR-0018), so the declared capabilities
stay exactly `content:read` and `network:request`.

Three bindings, one shape (`StorageAccess`, the adapters' own structural port):

| Where | What binds it |
|---|---|
| A deploy | the host injects `ctx.storage` |
| The client contract's in-process tier | a real `PluginStorageRepository` per collection, on in-memory SQLite |
| The workerd suites | the same, held in the test process and reached over the harness's own loopback bridge — the isolate has no driver and must never acquire one |

The collection set is assembled in `src/commerce/commerce-storage.ts` by spreading
the adapter modules' own per-aggregate declarations, and no collection name or
index is ever restated: a declared index is a **read contract** — a `where` or
`orderBy` on an undeclared field is a runtime error, not a slow query — so the list
a deployment declares and the list the adapters query have to be one object.

### Two rules the in-process client is built on

**Identity comes from the session, never from an argument.** Every method with
"my" semantics resolves the customer by handing the bearer session token to the
session store and using what it returns. No method accepts a customer id, so the
isolation is structural rather than a filter, and a foreign or unknown order is
`NOT_FOUND` rather than a refusal — the answer leaks no existence either.

**No status codes, in either direction.** Where the port declares a typed result,
a refusal *is* that value; where it declares none, the domain's or the adapter's
own error surfaces as an awaited rejection carrying its structural `code`
untouched. A compare-and-set budget exhausted under contention reaches the caller
as the retryable error it is — a caller has to be able to see that.

### Not yet wired

Two gaps in the in-process transport are deliberate, and each is pinned by a test so
it stays visible until it closes:

- **`createOrder` has no payment gateway.** It composes an EMPTY gateway map, so
  every payment method fails loudly rather than minting an order nobody can pay for.
  The gateways move in-process with the payment adapters.
- **`requestLoginLink` dispatches no mail.** It records the challenge — the login
  itself works if you hold the token — and sends nothing, because the outbound mail
  path moves in-process with the rest of the outbound topology. The reply is the same
  generic success either way, so the surface is still no account oracle.

Two hold TTLs are also not configurable in this transport: the cart hold's and the
checkout hold's take the domain's own defaults. Nothing in the plugin reads a TTL
from anywhere, and a knob whose only value is the default would be a knob with no
caller; when a deployment needs to move them they belong in the settings the store
already holds.

### Narrower, never wider

Two responses carry FEWER fields in this transport, deliberately, and neither can
carry more by accident:

- a customer's own order omits `createdAt`, the buyer reference, the customer id and
  the ship-to snapshot — the account pages render none of them;
- the raw commerce read omits the snapshot title, the compare-at price and the
  inventory policy — no storefront consumer reads them off this port, and the title's
  single writer is the content sync.

The rule in both cases is that a projection is a whitelist: a field added to a model
later stays private until someone adds it here on purpose.

### Running the proof

The behavioural spec lives in `test/contracts/commerce-client-contract.ts` and is
run by both tiers from the same cases. Both must be green; a case that fails on one
transport is a defect in that transport, never a case to soften.

```bash
# In-process, over a real document store on SQLite.
pnpm --filter @otta-sh/plugin exec vitest run test/commerce-client-contract.in-process.test.ts

# The HTTP transport, against a live service on Postgres.
PG_CONNECTION_STRING=... pnpm --filter @otta-sh/plugin exec vitest run test/commerce-client-contract.http.test.ts
```

## The workerd suites

`test/sandbox/harness.ts` boots the plugin's own bundle inside a **real `workerd`
process** and mirrors the host's side of the bridge: `ctx.http` with the
`allowedHosts` gate, `ctx.kv`, and `ctx.storage`. It copies `src/` into a scratch
tree and overwrites exactly two modules in the copy — `manifest.ts` (the test's
allowed hosts) and `sandbox-storage.ts` (the document-store bridge) — so the real
sources are never test-specific and the shipped bundle stays self-contained.
