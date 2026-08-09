---
"@otta-sh/domain": minor
"@otta-sh/store-postgres": minor
"@otta-sh/service": minor
"@otta-sh/plugin": minor
---

Add a WooCommerce-style admin Orders console — VIEW + STATUS-TRANSITION only
(orders remain immutable snapshots; nothing here edits a line item or a total).

- `@otta-sh/domain`: adds `OrderStore.listOrders(filter, page)` returning a
  lightweight, keyset-paginated `OrderSummary` PROJECTION (no per-row
  line/totals fan-out). Ordering is `created_at DESC, id DESC`; the date window
  is HALF-OPEN `[from, to)` (deliberately unlike `ReportingStore`'s inclusive
  `BETWEEN`); `search` matches an order id OR a case-insensitive `buyer_ref`,
  both exact as introduced here and widened to an id PREFIX / buyer_ref
  SUBSTRING later in this same release. Adds `legalNextStates(from)` for the
  console's transition buttons. The `InMemoryOrderStore` fake and the contract
  suite pin the spec (empty, single/multi state, date boundary, search,
  pagination no-overlap/no-gap, identical-`created_at` tie-break, limit
  boundary).
- `@otta-sh/store-postgres`: implements `listOrders` as a single
  `orders → order_totals` SELECT with a grouped keyset predicate, dialect-identical
  on better-sqlite3 and Postgres. Adds forward-only migration `0009` (a
  `orders(created_at, id)` index for the keyset order).
- `@otta-sh/service`: adds the internal-token-guarded `GET /admin/orders` (filters +
  an OPAQUE base64url keyset cursor that embeds the active filter so it survives
  paging; a malformed/tampered cursor fails CLOSED to 400 and the decoded limit is
  re-clamped) and `GET /admin/orders/:id` (full order + `allowedTransitions` from
  the domain state machine; 404 when absent). `serializeOrder` gains `createdAt` +
  `customerId` additively.
- `@otta-sh/plugin`: adds the Orders admin page (list with a status/date/search
  filter form, keyset "Load more", open-order → detail with line items, totals,
  and legal transition buttons — destructive cancel/refund guarded by a confirm
  dialog). A new `AdminOrdersClient` reaches the service only via `ctx.http` +
  `allowedHosts` with the write-only kv admin token; the plugin defines its own
  local wire types and never imports `@otta-sh/domain` (now enforced by the
  dependency-cruiser sandbox-clean rule). The staging trusted descriptor
  registers the new page.

FOLLOW-UP: the widened local Block Kit `BannerBlock`/`TableBlock` types are a
backward-compatible superset so the Phase-7 Reports/Settings pages keep
typechecking; migrate those pages to the em-dash-correct banner
(`title`/`description`) + table `page_action_id` shapes and then tighten the
local types.
