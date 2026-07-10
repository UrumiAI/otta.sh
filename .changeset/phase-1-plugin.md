---
"@urumi/plugin": minor
"@urumi/service": patch
---

Phase 1 — `@urumi/plugin`, the first Urumi EmDash plugin package: sandbox-clean
(workerd, Block Kit, no React), proven under a real `workerd` process, not
trusted in-process.

- `CommerceClient` transport port (ADR-0002 §3) + `HttpCommerceClient`, the
  only adapter this phase builds — a straight 1:1 mirror of
  `@urumi/service`'s `PUT`/`GET`/`DELETE /products/:id/commerce` (money as
  integer + ISO-4217 string, `Idempotency-Key` header, structured
  `CommerceClientError` on any non-2xx response). Proven against the real,
  Postgres-backed `@urumi/service` over a live test server
  (`http-commerce-client.test.ts`) — the wire has not drifted from the port.
- A from-scratch workerd-on-Node sandbox test harness
  (`test/sandbox/harness.ts`): boots the real public `workerd` binary as a
  child process (not Node `vm`/`worker_threads`, not trusted in-process),
  bundles `src/sandbox-entry.ts` fresh per test via tsdown, and dispatches
  `POST /hook/<name>` / `POST /route/<name>` to the plugin's hooks/routes —
  mirroring EmDash's own `WorkerdSandboxedPlugin` wire shape. `ctx.http`
  enforces `allowedHosts` in JS (mirrors EmDash's `createHttpAccess`/
  `isHostAllowed`) before ever calling the real `fetch`; a fetch to a
  disallowed host is rejected end-to-end under the real sandbox.
- Content lifecycle sync hooks: `content:afterSave` upserts a bare
  `product_commerce` row keyed by the CMS id (idempotency key derived from
  `${collection}:${id}:${content.updatedAt}` — the only stable field EmDash
  exposes to a plugin); replay with the same `updatedAt` dedupes; a failure
  (network/5xx) is logged, never thrown into the CMS save path.
  `content:afterDelete` soft-deletes. Both are collection-scoped to
  `products` and no-op otherwise.
- The "Product data" Block Kit `fieldWidget` (SKU/price/currency/stock/
  product kind/tax class/shipping dims + Save) and its non-public
  `product-commerce` route: "create then price" is enforced at both layers
  — the widget renders every field disabled with no save action for an
  unsaved product, and the route independently rejects a missing
  `productId` (`MISSING_PRODUCT_ID`) before any commercial write, so a
  hand-crafted request can't bypass the UX. The Stock field is create-only
  (disabled once a sku exists — Phase 3 owns all further stock movement). A
  `panel-state` route serves the live, state-aware element tree.
- Sandbox-clean guard: the manifest declares EXACTLY `content:read` +
  `network:request` (no `network:request:unrestricted`, no storage/kv/db
  capability) — asserted both at runtime
  (`product-data-widget.sandbox.test.ts`) and structurally via a new
  `plugin-is-sandbox-clean` dependency-cruiser rule (`.dependency-cruiser.cjs`,
  wired into `pnpm lint`) forbidding any DB/storage/filesystem import in
  `packages/plugin/src`.
- `@urumi/service` additively exports `./app` (`createApp`) so the plugin's
  own tests can boot a live, Postgres-backed instance without duplicating
  route-mounting logic.

Deferred (plan §6 step 9 / §2, both explicitly optional/out-of-scope this
phase): the reconcile cron and `content:afterPublish` → `activate` — the
`ProductCommerceStore` port stays exactly the three methods §7 specifies.
