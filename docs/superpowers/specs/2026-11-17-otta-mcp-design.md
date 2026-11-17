# Otta MCP — design

Status: approved 2026-11-17 · 2026-11-17 · branch `feat/otta-mcp`

## Intent

Let a store developer or admin run an Otta store from an AI agent (Claude Code or
Claude Desktop) over MCP. Everything the Otta admin can do today should be possible
as an MCP tool call: products' commerce data, orders, refunds, coupons, shipping,
tax, reports and settings. Keep it simple and reuse existing code: the new code is
a thin layer over the admin code that already exists, not a second implementation.

## Goals

- Every admin capability of Otta is reachable as an MCP tool.
- It ships as a new monorepo package, `packages/mcp` → `@urumi.ai/otta-mcp`, layered
  **on top of** the Otta plugin. A site opts in. A site that doesn't opt in is unchanged.
- Agents are the primary client: short tool names, clear descriptions, compact JSON output.
- It's tested end to end on the VM store (otta.anubhav.fyi) **before** merging.

## Non-goals

- No new MCP server, transport, auth or hosting. EmDash already serves MCP at
  `/_emdash/api/mcp` with API-token login, role checks, per-plugin enable and consent.
- No storefront/shopper tools (cart, checkout). This is for admins and developers.
- No product *content* tools (create, delete, title, description, images). Products are
  EmDash content entries, and EmDash's built-in `content_*` MCP tools already cover them.
  Otta's sync hooks carry the commerce side along, as they do for the admin UI.
- No new business logic. If a tool needs behaviour the admin surfaces don't have, that's
  a separate change.

## Anti-goals (a failure even if it "works")

- Tools that bypass the domain: writing `ctx.storage` directly, skipping idempotency,
  or skipping the oversell and refund guards the admin clients already enforce.
- Reading payment secrets back out. They stay write-only, as in the Settings page.
- A second copy of validation or logic that drifts from the admin UI.
- Money as floats. Money in and out is integer minor units plus a currency, as everywhere else.

## Constraints found in EmDash (checked on 1.0.1 and 1.5.0, which the repo pins; same behaviour)

1. **A plugin's data is private to it.** `ctx.storage` is namespaced by plugin id, so a
   *separate* EmDash plugin can't read Otta's orders or products. The tools must run
   inside the Otta plugin's own id.
2. **A plugin MCP tool runs one of its plugin's own routes.** `mcp.tools[name] =
   { description, route, input (zod), output?, destructive? }`. EmDash only registers
   the tool if that route is **non-public**, a **JSON POST** contract, and declares a
   **`permission`** that is a real EmDash permission. The tool is exposed as
   `<pluginId>__<name>` (e.g. `otta__orders_list`).
3. **An admin must turn tools on.** They're live only after an admin enables MCP tools for
   the plugin and consents to the exact tool list (EmDash stores the consent, so a
   changed list needs consent again). A scoped API token also needs scope `mcp:tools:otta`.
4. EmDash never marks plugin tools read-only (only `destructiveHint` is passed), so **every**
   Otta tool, reads included, is blocked while a site export holds the write fence.
   That's accepted; changing it needs an EmDash change.
5. **The guards are not all in `AdminClients`.** Many live one layer up, in the Block Kit
   handlers: the refund ledger re-read and key derivation (`orders-actions.ts`
   `refundOrderAction`), stock keys built from the level the operator saw
   (`products-actions.ts`), coupon code/currency validation and whole-document replace
   (`coupons-page.ts`), the one-zone-per-region check (`shipping-page.ts`
   `checkZoneRegions`), and the settings saves with their two confirm steps (currency switch,
   shortening the cash-on-delivery window) inside `settings-form.ts`. Calling the surfaces
   directly would skip these guards.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | New package `@urumi.ai/otta-mcp` that **wraps** the Otta plugin object: `withMcp(plugin)` adds MCP routes plus `mcp.tools`, under the same plugin id | Feels like an add-on, no circular dependency, and reuses the admin clients. The site changes one entrypoint string to opt in |
| B | Tools inside `packages/plugin/src/mcp/` | Simplest, but the user wanted a separate add-on, and every site would ship it |
| C | Standalone MCP server process calling the store over HTTP | Its own auth, deploy and hosting. There's no admin JSON API to call. Most moving parts |

The user picked A.

## Design

### Package shape

```
packages/mcp/                      @urumi.ai/otta-mcp
  src/index.ts                     export { withMcp, OTTA_MCP_TOOLS }
  src/trusted.ts                   export default withMcp(createOttaPlugin({ trustedHost: true }))
  src/with-mcp.ts                  plugin → plugin + routes + mcp.tools
  src/tools/{products,orders,coupons,shipping,tax,reports,settings}.ts
  src/tool.ts                      the one helper every tool uses (below)
  test/…
```

- Depends on `@urumi.ai/otta-plugin` (one direction only).

### Step 1 (its own PR, no behaviour change): extract the admin operations

Because of constraint 5, the guards first move out of the Block Kit handlers into
plain functions in the plugin, `packages/plugin/src/admin/operations/*` (e.g. `refundOrder`,
`adjustStock`, `saveCoupon`, `saveShippingZone`, `saveSettings`). Each takes `(ctx, clients,
input)` and returns a typed result, including a `needs_confirmation` result for the two
confirm steps. The Block Kit handlers are rewired to call them. The plugin exports them, along with
`makeAdminClients` and `AdminClients`. This is the reuse: the admin UI and MCP share one
code path.

**Safety rules for Step 1 (agreed with the user: "won't break anything"):**
- **Tests first.** Before any code moves, characterization tests pin down today's behaviour
  of each guard that moves, and they must pass on the unchanged code. That covers refund
  retry and different-amount, stock keys from the seen level, coupon edits keeping fields
  that weren't sent, zone overlap, the currency-switch confirm, and the confirm for
  shortening the cash-on-delivery window.
- **One small PR per area, in this order:** 1a orders/refunds · 1b stock · 1c coupons ·
  1d shipping + tax · 1e settings (including the payment-secret and cash-on-delivery saves).
  Each moves only what MCP needs, each runs the full battery including `test:e2e`
  (OTTA_E2E_START_STACK=1), and each merges before the next starts.
- No behaviour change in Step 1. A test that has to change means the extraction is wrong.

### Step 2 (its own PR): `@urumi.ai/otta-mcp` on top
- **Opting in:** the site's Otta descriptor sets `entrypoint: "@urumi.ai/otta-mcp/trusted"`
  instead of `"@urumi.ai/otta-plugin/trusted"`. `@urumi.ai/otta-store` gets an
  `mcp?: boolean` option (default `false`) that switches it. `otta-mcp` is an **optional
  peer** of `otta-store`, checked only when `mcp: true`, so sites without it never ship it.
  Nothing else in the descriptor changes: same id, storage, capabilities and allowed hosts.
  Publishing to npm isn't part of this work; it goes out with the next release.

### One table drives everything

Each tool is one entry, so adding a tool is one entry:

```ts
defineTool({
  name: "orders_refund",                 // → otta__orders_refund
  description: "Refund all or part of a paid order …",
  permission: "settings:manage",
  destructive: true,
  input: z.object({ orderId: z.string(), amount: moneyInput.optional(), reason: z.string().optional(),
                    idempotencyKey: z.string().optional() }),
  run: (clients, input, key) => clients.orders.refundOrder(input.orderId, …, key),
})
```

`withMcp` turns the table into both halves EmDash needs: a route `mcp/<name>` (JSON POST,
non-public, `permission` as given, handler = validate → `makeAdminClients(ctx)` → the Step 1
operation, or a surface read → compact JSON) and the matching `mcp.tools` entry. Writes always
go through the Step 1 operations, never straight to a surface write method.

- **Permissions:** every tool needs `plugins:manage` (Admin), which is what the admin screens
  need today (the `admin` route declares none, so it falls back to that). Editors gain nothing.
- **Idempotency:** where the admin derives a key (refund: order + amount + refunded-so-far;
  stock: from the level seen), the MCP tool derives it **the same way, inside the shared
  operation**. A retry after a timeout replays instead of refunding twice, and a different
  amount is a new refund. Where Otta has no key today (shipping, tax, coupon rules,
  `retireCoupon`, `resolveUnverifiedRefund`), the tool has none either. Adding one would be
  new behaviour.
- **Confirm steps:** an operation that needs confirming returns
  `{ status: "needs_confirmation", message, affected }` and changes nothing. The agent calls
  again with `confirm: true`.
- **Coupon update:** the tool takes a partial edit, reads the coupon, merges, and writes the
  whole coupon through the shared operation, so fields that weren't sent are kept.
- **Results:** each surface's result union (`ok` / not found / conflict / validation…) maps to
  a success payload or a structured MCP error with a stable code (e.g. `NOT_FOUND`,
  `CONFLICT`, `REFUND_GATEWAY_UNAVAILABLE`). The surfaces' own codes are kept, never reworded.
- **Output size:** list tools take `limit`/`cursor` (the surfaces already paginate) and return
  summaries. A `*_get` tool returns the detail.

### Tool list (first cut, mirrors the admin surfaces 1:1)

All of these were in scope, including the risky ones the user explicitly allowed:
refunds, deletes and archives, payment settings, and tax, shipping and store settings.
Destructive tools carry `destructive: true`, so clients ask before running them.

- **Products (commerce side):** `products_list`, `products_get`, `products_update` (price,
  sale price, SKU, tax class, dimensions, variants…), `products_restock`,
  `products_remove_stock`, `products_low_stock`.
- **Orders:** `orders_list`, `orders_get` (with customer context, timeline, refunds and notes),
  `orders_transition`, `orders_record_fulfillment`, `orders_cancel`ᴰ, `orders_refund`ᴰ,
  `orders_resolve_unverified_refund`, `orders_resolve_reconciliation`, `orders_add_note`,
  `orders_revoke_download_access`ᴰ.
- **Coupons:** `coupons_list`, `coupons_get`, `coupons_create`, `coupons_update`,
  `coupons_retire`ᴰ, `coupons_delete`ᴰ.
- **Shipping:** zones, methods and rates, each list/create/update/delete (deletes ᴰ).
- **Tax:** `tax_settings_get`, `tax_settings_update`, tax classes and tax rates
  list/create/update/delete (deletes ᴰ).
- **Reports:** `reports_revenue`, `reports_orders_by_status`, `reports_top_products`.
- **Settings:** `settings_get` (operational settings, store name, which payment methods are
  enabled, and whether each payment secret is *set*, never its value), `settings_update`,
  `payments_set_secret`ᴰ (write-only, encrypted at rest as ADR-0037 requires),
  `payments_clear_secret`ᴰ, `payments_cod_set_enabled`ᴰ. Stripe has no on/off toggle: it's on
  when its secret key is set, as today.

ᴰ = `destructive: true`. The builder may merge or split tools where a surface method is
too fine-grained for an agent, but must not add behaviour.

### Testing

- **Unit (vitest, SQLite, real stores per the repo rules):** each tool through its route
  handler against `makeAdminClients` over the plugin's real test storage. Covers the happy
  path, not-found, validation, a replay test for every write tool that has a key, the refund
  double-retry and different-amount cases, and both confirm steps. Plus a `withMcp` test: every table entry yields a route that passes EmDash's
  registration checks (non-public, JSON POST, valid permission), so no tool silently drops.
- **Integration:** boot the EmDash MCP endpoint in the existing e2e stack, list tools with an
  API token, and call one read and one write.
- **The standard battery** before the PR: lint (including the dependency check, now with an
  `otta-mcp → otta-plugin` rule and no reverse edge), format, typecheck, build,
  `test:pack-types`, test, and `pack-build`.
- **VM store (otta.anubhav.fyi), before merging.** The user said this store is only for
  testing, so it's upgraded **in place**. Today it runs plugin 0.1.1 on EmDash 1.0.1, and this
  build needs 0.2.x on EmDash ≥1.5, so the upgrade includes EmDash's DB migrations and adding
  the `payments-cod` tarball.
  1. `pg_dump` `otta_store_prod`, and keep the current build (`dist` + `node_modules` +
     vendor) in `~/otta-store-backups/`, so rolling back is a restore plus one restart.
  2. Repack every `@urumi.ai/otta-*` tarball from the branch into `~/otta-store-prod/vendor`,
     bump `emdash` to the version the repo pins, and fix whatever the 0.1→0.2 upgrade needs
     (see `UPGRADING.md`).
  3. Point the descriptor at `@urumi.ai/otta-mcp/trusted`, rebuild, restart.
  4. Enable MCP tools for Otta in the admin and consent.
  5. Create a token scoped `mcp:tools:otta`.
  6. Connect Claude Code to `https://otta.anubhav.fyi/_emdash/api/mcp`.
  7. Exercise every tool on throwaway data (a test product, a test coupon, a
     cash-on-delivery order to refund), then clean it up.
  8. Record the transcript in the PR.

## Left to the builder

Exact tool descriptions and input schemas (derived from the surface wire types), the
error-code mapping table, how the settings save functions are exported from the plugin, and
whether the store integration's `mcp` option needs an ADR (the build should add a short one,
ADR-0046 "Admin MCP tools ship as a plugin wrapper", since this is a new public package
and an opt-in contract).

## Calls I made (please check)

- Tools run under the **Otta plugin's id** via a wrapper. A separate plugin id can't see the data.
- **Six PRs:** five small, test-first extractions (1a–1e, no behaviour change), then the MCP
  package on top.
- **Admin-only** (`plugins:manage`) for every tool, the same as the admin screens.
- Confirm steps use a `confirm: true` second call.
- There's no Stripe on/off tool, and no new retry protection where Otta has none today.
- **Product create/delete** is left to EmDash's existing content tools rather than duplicated.
- Opt-in per site. The default is off.
- Both PRs are tagged `[Plugin]`. The MCP PR merges after the VM test, and the live test store is upgraded in place.
