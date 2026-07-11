---
"@urumi/service": minor
"@urumi/store-postgres": minor
---

Cloudflare Worker deploy entry for `@urumi/service`, plus the sqlite-free
`@urumi/store-postgres/pg` subpath it bundles from. Additive — the Node entry
and every existing consumer are behavior-identical.

- **`@urumi/service/worker`** (`src/worker.ts`): `createWorker(overrides?)`
  factory returning `{ fetch, scheduled }`, with `export default
  createWorker()` for wrangler. Per-event pg Pool/Kysely/stores/app
  (`{ max: 5, idleTimeoutMillis: 0 }`, destroyed via `ctx.waitUntil` in a
  `finally` on every path — a cross-request pool is a bug on workerd);
  closure-scoped memos for parsed config and lazy first-event migrations
  (rejection clears the memo so the next event retries); pre-app failures
  surface as the standard `{ok:false,error:"internal_error"}` 500. The
  `scheduled` cron handler calls the `expireHolds` AND (Phase 4) `expireOrders`
  domain use-cases directly (no HTTP self-call, no secret dependency), logging
  and never throwing — on Workers this cron is order expiry's production
  driver (it is clock-driven, unlike lazy-on-read hold expiry). Phase 4
  gateways wire from env bindings exactly like the Node bin (`wrangler secret
  put STRIPE_WEBHOOK_SECRET` etc.; x402 keeps its fail-closed test-facilitator
  opt-in), memoized per isolate.
- **`SERVICE_API_TOKEN` write gate**: new optional `AppDeps.serviceToken`; a
  Hono middleware registered first in `createApp` — when set, GET/HEAD (and
  `/health`) stay open and every other method on every path requires
  `Authorization: Bearer <token>` (401 with `WWW-Authenticate: Bearer`);
  unset preserves today's fully-open behavior. `tokenMatches` (constant-time
  compare) moved to `src/auth.ts` — the single implementation, shared with the
  `X-Internal-Token` guards (`routes/internal-auth.ts` and `routes/carts.ts`);
  with both secrets set, `POST /internal/expire-holds`, `POST
  /internal/expire-orders`, and `POST /entitlements/grant` need both headers.
  **Exactly one exemption** (exact-path allowlist, default deny):
  `POST /webhooks/stripe`, which Stripe calls directly and authenticates with
  its own `Stripe-Signature` HMAC over the raw body — Stripe cannot carry our
  Bearer token. Every other Phase 4 mutating route (checkout included) is
  gated. Deploy ordering note: set `SERVICE_API_TOKEN` on the deployed Worker
  only AFTER the CMS-side plugin threads the same token, or storefront cart
  writes will 401.
- **`src/config.ts`**: pure `parseHoldTtlMs`/`resolveServiceConfig` shared by
  both entries; the Node bin (`index.ts`) now reads env through it (no
  behavior change).
- **`wrangler.jsonc`**: worker `urumi-service`, `nodejs_compat`, Hyperdrive
  binding `HYPERDRIVE` (no `PG_CONNECTION_STRING` secret on Workers), cron
  `*/15 * * * *` (janitor only — hold expiry stays lazy-on-read).
- **`@urumi/store-postgres/pg`**: sqlite-free subpath re-exporting the pg
  dialect factories, all six Kysely stores (incl. the Phase 4
  order/entitlement/payment-event stores), `migrateToLatest`, `uuidIdGen`
  (now in `src/id-gen.ts`), and the schema types — nothing that touches the
  `better-sqlite3` native addon, so wrangler/esbuild can bundle it. The root
  barrel API is unchanged (`dialects.ts` is now a re-export shim over
  `dialects-pg.ts`/`dialects-sqlite.ts`).
