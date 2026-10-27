# @urumi.ai/otta-plugin

The EmDash plugin: the storefront routes, the sync hooks, the Block Kit admin
screens — and, increasingly, commerce itself. Sandbox-clean by construction, which
is the constraint everything below is shaped by: no DB driver, no `node:` builtin,
no host import, one declared egress (`ctx.http` plus `allowedHosts`), and exactly
three declared capabilities (`content:read`, `network:request`, and `email:send` for the
host's `ctx.email`, ADR-0031).

## Install

```sh
pnpm add @urumi.ai/otta-plugin
```

ESM-only, for an EmDash site on `emdash` `^1.3.1` (a peer dependency, the same range `@urumi.ai/otta-store-emdash` requires). `@urumi.ai/otta-store-emdash`, `@urumi.ai/otta-domain`, `@urumi.ai/otta-payments-stripe` and `@urumi.ai/otta-admin-presentation` come with it as dependencies, and the plugin's types import domain's, so a `TaxCalculator` written against `@urumi.ai/otta-domain` is the one `createOttaPlugin` takes. Published entry points:

| Import | What it is |
|---|---|
| `@urumi.ai/otta-plugin` | The plugin's public surface: ids, capabilities, `COMMERCE_STORAGE_COLLECTIONS`, `resolveAllowedHosts`, `PAYMENT_SECRET_SETTINGS_SCHEMA`, the admin page constants. |
| `@urumi.ai/otta-plugin/plugin` | The sandboxed plugin (`createOttaPlugin`). |
| `@urumi.ai/otta-plugin/sandbox-entry` | The entry for running it in the sandbox (`createSandboxWorker`). |
| `@urumi.ai/otta-plugin/trusted` | The same plugin with `trustedHost` on, for a site that registers it in-process. |
| `@urumi.ai/otta-plugin/subdivisions` | English subdivision names for a storefront's region pick list (kept out of the sandbox bundle). |
| `@urumi.ai/otta-plugin/testing` | Test helpers, e.g. `recordingEmailProvider`. |

The package exports no descriptor; each site writes its own, as the reference site does in [`sites/staging/src/otta-plugin-descriptor.ts`](https://github.com/UrumiAI/otta.sh/blob/main/sites/staging/src/otta-plugin-descriptor.ts). That descriptor **must** declare `settingsSchema: { ...PAYMENT_SECRET_SETTINGS_SCHEMA }` and the host must set `EMDASH_ENCRYPTION_KEY`: without the schema the Stripe keys are stored as plain text, and the plugin cannot detect it ([ADR-0037](https://github.com/UrumiAI/otta.sh/blob/main/adr/0037-payment-secrets-are-encrypted-at-rest.md)). See the [repo README](https://github.com/UrumiAI/otta.sh#readme).

## The commerce transport

Everything that touches commerce goes through the `CommerceClient` port and
obtains it from **one** composition root, `src/commerce/make-commerce-client.ts`.
There is one implementation behind that port, `InProcessCommerceClient`: the
domain's use-cases composed over the `@urumi.ai/otta-store-emdash` adapters, bound to the
plugin's own document store. There is no service, no HTTP transport and no mode
flag (ADR-0020). Any egress it makes goes over `ctx.http`; the composition root
wires the payment gateway — Stripe (`src/payments/stripe-wiring.ts`) — only
when fully configured, and a method with no gateway fails loudly rather than minting an order nobody can pay for.

### Where commerce truth lives

`ctx.storage` — the per-plugin document store the host builds from the
descriptor's declared collections and injects on every invocation. It needs no
capability: the host builds it on an always-available path and there is no
`storage` capability string to declare (ADR-0018), so the declared capabilities
stay exactly `content:read`, `network:request` and `email:send`.

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

One gap in the in-process transport is still open, and stays listed here until it closes.
(The other, "`requestLoginLink` dispatches no mail", closed with issue #306: the magic link
is emailed through `CtxEmailSender` over the EmDash host's `ctx.email` (ADR-0031), pointing
at the sign-in page the operator saves on Store settings → General
(`settings:loginLinkUrl`, required; never the request's origin). With no EmDash email provider, or no sign-in link URL, it still
answers the same generic success and logs once server-side.)

- **The checkout hold ignores the hold TTL setting.** The "Cart hold time (minutes)" field on
  Store settings → General (`holdTtlMinutes` in the settings aggregate; there is no
  environment variable for it) now drives the CART hold end to end: add-to-cart and
  adjust stamp it, the lazy expiry on cart read measures against it, and the
  `expire-holds` sweep leg reaps by it (#318). The CHECKOUT hold — the window a
  `pending` order keeps its adopted stock — does not read it: `createOrder` passes no
  `ttlMs`, so it is always the domain's fifteen-minute `DEFAULT_CHECKOUT_TTL_MS`.

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

The behavioural spec lives in `test/contracts/commerce-client-contract.ts` and runs
against the in-process client. It must be green; a case that fails is a defect in
the client, never a case to soften.

```bash
# In-process, over a real document store on SQLite.
pnpm --filter @urumi.ai/otta-plugin exec vitest run test/commerce-client-contract.in-process.test.ts
```

## The workerd suites

`test/sandbox/harness.ts` boots the plugin's own bundle inside a **real `workerd`
process** and mirrors the host's side of the bridge: `ctx.http` with the
`allowedHosts` gate, `ctx.kv`, and `ctx.storage`. It copies `src/` into a scratch
tree and overwrites exactly two modules in the copy — `manifest.ts` (the test's
allowed hosts) and `sandbox-storage.ts` (the document-store bridge) — so the real
sources are never test-specific and the shipped bundle stays self-contained.

MIT licensed.
