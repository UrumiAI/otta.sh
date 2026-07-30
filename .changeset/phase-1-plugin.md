---
"@otta-sh/plugin": minor
"@otta-sh/service": minor
---

Phase 1 — `@otta-sh/plugin`, the first Urumi EmDash plugin package: sandbox-clean
(workerd, Block Kit, no React), proven under a real `workerd` process, not
trusted in-process.

- `CommerceClient` transport port (ADR-0002 §3) + `HttpCommerceClient`, the
  only adapter this phase builds — a straight 1:1 mirror of
  `@otta-sh/service`'s `PUT`/`GET`/`DELETE /products/:id/commerce` (money as
  integer + ISO-4217 string, `Idempotency-Key` header, structured
  `CommerceClientError` on any non-2xx response). Proven against the real,
  Postgres-backed `@otta-sh/service` over a live test server
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
- `@otta-sh/service` additively exports `./app` (`createApp`) — new public
  export surface, hence the minor bump — so the plugin's own tests can boot
  a live, Postgres-backed instance without duplicating route-mounting logic.
- Review round 1: the panel Save route derives a STABLE content-derived
  idempotency key (hash of productId + submitted form state — em-dash's
  `FormSubmit` exposes no event/delivery id), so a host retry/double-submit
  of the same click dedupes to one applied write; the route returns
  structured `INVALID_FIELDS` per-field errors for bad numerics/currency/
  floats instead of an opaque 500; `content:afterSave` forwards
  `contentUpdatedAt` as the sync-ordering watermark (a delayed out-of-order
  older save is a stale no-op at the service); and the sandbox-clean guard
  now also forbids undici/node-fetch/axios/ws/hono imports AND direct
  `fetch`/`globalThis.fetch`/`self.fetch`/`window.fetch`/`XMLHttpRequest`
  usage in plugin src outside the sanctioned `ctx.http` implementation
  (grep-guard test). The panel route surfaces a service 409 `SKU_TAKEN`
  (live-SKU conflict — the most likely merchant input error) as a
  structured per-field error next to the SKU input, and `content:afterSave`
  normalizes the CMS `updatedAt` to strict `Date.toISOString()` form before
  sending it as the sync watermark (the service now validates that format
  hard at the boundary).

Deferred (plan §6 step 9 / §2, both explicitly optional/out-of-scope this
phase): the reconcile cron and `content:afterPublish` → `activate` — the
`ProductCommerceStore` port stays exactly the three methods §7 specifies.
