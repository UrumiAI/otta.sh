// Kysely table typings for the Phase-0 inventory schema (§6) plus the Phase-3
// cart schema. Portable types only (text/integer) so the same DDL and queries
// serve better-sqlite3 and pg.

import type { ColumnType } from "kysely";

export type ReservationState = "pending" | "held" | "committed" | "released" | "failed" | "adopted";

export interface InventoryTable {
	sku: string;
	on_hand: number;
}

export interface ReservationsTable {
	id: string;
	sku: string;
	qty: number;
	state: ReservationState;
	idempotency_key: string;
	created_at: string;
	// Phase 3: the cart stamps the hold deadline here (nullable — a reservation
	// created by a raw `reserve` before any cart write carries none). Omittable on
	// insert so Phase-0's `reserve` is left byte-for-byte.
	expires_at: ColumnType<string | null, string | null | undefined, string | null>;
	// Phase 4: the owning order once the hold is adopted (nullable; omittable on
	// insert so Phase-0/3 writes are byte-for-byte).
	order_id: ColumnType<string | null, string | null | undefined, string | null>;
}

export type CartState = "active" | "checked_out";

export interface CartsTable {
	id: string;
	customer_id: string | null;
	state: CartState;
	currency: string;
	created_at: string;
	updated_at: string;
}

export interface CartLinesTable {
	id: string;
	cart_id: string;
	product_id: string | null;
	sku: string;
	qty: number;
	reservation_id: string | null;
	expires_at: string | null;
	created_at: string;
	updated_at: string;
}

export type CartMutationKind = "add" | "adjust" | "remove";

export interface CartMutationsTable {
	idempotency_key: string;
	cart_id: string;
	line_id: string | null;
	kind: CartMutationKind;
	resulting_qty: number | null;
	/** 0 = claimed (pre-movement), 1 = completed. Claim-first: the row exists
	 *  BEFORE any inventory movement; a replay of an incomplete claim resumes. */
	completed: number;
	created_at: string;
}

export type AdjustOutcome = "ok" | "out_of_stock";

/**
 * Per-mutation claim ledger for `InventoryStore.adjust` — the adjust analogue of
 * `reservations.idempotency_key` (which is already consumed by the original
 * reserve and cannot guard the many adjusts over a hold's life). The claim
 * INSERT and the inventory movement commit in one short transaction, so exactly
 * one caller per key moves stock and a replay returns the recorded outcome.
 */
export interface InventoryAdjustmentsTable {
	idempotency_key: string;
	reservation_id: string;
	to_qty: number;
	outcome: AdjustOutcome;
	created_at: string;
}

export type StockMovementDirection = "restock" | "removal";
export type StockMovementOutcome = "ok" | "insufficient_stock";

/**
 * Per-mutation claim ledger for `InventoryStore.restock`/`removeStock` (admin-UX
 * Increment 2) — the admin stock-movement analogue of `inventory_adjustments`
 * (that ledger is reservation-scoped; this one is bare-sku-scoped). The claim
 * INSERT and the guarded inventory movement commit in ONE short transaction, so
 * exactly one caller per key moves stock and a replay returns the recorded
 * outcome. `direction`/`qty` are recorded so a key reused for a DIFFERENT
 * movement is rejected. `result_on_hand` is the on_hand recorded with the
 * outcome (after the movement for `ok`; the current count for
 * `insufficient_stock`) so a replay echoes the original result. An UNKNOWN_SKU
 * is NOT recorded here (the claim rolls back — key not consumed).
 */
export interface InventoryStockMovementsTable {
	idempotency_key: string;
	sku: string;
	direction: StockMovementDirection;
	qty: number;
	outcome: StockMovementOutcome;
	result_on_hand: number;
	created_at: string;
}

/**
 * Phase 1 (§4/§6 step 4): one row per product, keyed by the CMS content id.
 * `sku`/`price_*` are nullable — "create then price" (a bare afterSave sync
 * upsert may create the row before any commercial data exists).
 */
export interface ProductCommerceTable {
	product_id: string;
	sku: string | null;
	price_cents: number | null;
	price_currency: string | null;
	/** Phase 4 §4: the title an order line snapshots (nullable; added additively). */
	title: string | null;
	tax_class: string | null;
	weight_grams: number | null;
	length_mm: number | null;
	width_mm: number | null;
	height_mm: number | null;
	product_kind: string;
	/** Portable 0/1 (not SQL boolean — better-sqlite3 cannot bind a JS boolean). */
	active: number;
	deleted_at: string | null;
	idempotency_key: string;
	/** Sync-ordering watermark: last CMS `content.updatedAt` applied by a sync
	 *  upsert (ISO-8601 text; lexicographic = chronological). Null until a
	 *  sync ever carries one. */
	content_updated_at: string | null;
	/** Publish-GATE ordering watermark: the last CMS `content.updatedAt` a
	 *  winning `activate`/`deactivate` applied. DELIBERATELY separate from
	 *  `content_updated_at` — a plain `content:afterSave` advances that one
	 *  without being a lifecycle event, so sharing it would let a save poison
	 *  the gate and let a stale out-of-order publish/unpublish POST win. Null
	 *  until the first lifecycle transition; NULL is treated as `-infinity` so
	 *  the first transition always wins. ISO-8601 text (lexicographic =
	 *  chronological). */
	active_updated_at: string | null;
	created_at: string;
	updated_at: string;
}

/** Phase 4 §4 + Phase 5 §5: orders carry NO money column — keys / state / TTL /
 *  identity only. Phase 5 widens the `state` value set (a text column — no DDL
 *  change for the new values). */
export type OrderStateColumn =
	| "pending"
	| "paid"
	| "failed"
	| "expired"
	| "processing"
	| "shipped"
	| "delivered"
	| "completed"
	| "cancelled"
	| "refunded";

export interface OrdersTable {
	id: string;
	cart_id: string | null;
	currency: string;
	state: OrderStateColumn;
	idempotency_key: string;
	hold_expires_at: string;
	payment_method: string | null;
	buyer_ref: string;
	/** Phase-5 hook (added here forward-only, populated by Phase 5). */
	customer_id: ColumnType<string | null, string | null | undefined, string | null>;
	/** Set when settle loses an adopted hold → manual reconciliation (§5); CLEARED
	 *  back to null when an admin resolves it (admin-UX Increment 1). */
	reconciliation_flag: ColumnType<string | null, string | null | undefined, string | null>;
	/** The admin's disposition recorded on resolve (admin-UX Increment 1) —
	 *  'refunded' | 'fulfilled' | 'written_off'. Null while unflagged/unresolved. */
	reconciliation_outcome: ColumnType<string | null, string | null | undefined, string | null>;
	/** Free-text justification recorded on resolve; null while unresolved. */
	reconciliation_reason: ColumnType<string | null, string | null | undefined, string | null>;
	/** Who resolved the flag (free text); null while unresolved. */
	reconciliation_resolved_by: ColumnType<string | null, string | null | undefined, string | null>;
	/** ISO-8601 UTC resolve timestamp; null while unresolved. */
	reconciliation_resolved_at: ColumnType<string | null, string | null | undefined, string | null>;
	/** Shipping fulfillment (admin-UX Increment 1) — single-slot, written atomically
	 *  with the `processing → shipped` flip by `recordFulfillment`. All nullable +
	 *  omittable on insert (Phase-4/5 order creation carries none); `fulfillment_
	 *  recorded_at` is the presence witness. */
	fulfillment_carrier: ColumnType<string | null, string | null | undefined, string | null>;
	fulfillment_tracking_number: ColumnType<string | null, string | null | undefined, string | null>;
	fulfillment_tracking_url: ColumnType<string | null, string | null | undefined, string | null>;
	/** ISO-8601 UTC ship time (admin-supplied or the store clock). */
	fulfillment_shipped_at: ColumnType<string | null, string | null | undefined, string | null>;
	fulfillment_recorded_by: ColumnType<string | null, string | null | undefined, string | null>;
	/** ISO-8601 UTC record timestamp (store clock) — the presence witness. */
	fulfillment_recorded_at: ColumnType<string | null, string | null | undefined, string | null>;
	/** Structured cancellation (admin-UX Increment 1, "cancel with reason") —
	 *  single-slot, written atomically with the `{pending,paid,processing} →
	 *  cancelled` flip by `cancelOrder`. All nullable + omittable on insert;
	 *  `cancellation_cancelled_at` is the presence witness — a bare-transition
	 *  cancellation (back-compat) leaves these null even though `state =
	 *  'cancelled'`. */
	cancellation_reason: ColumnType<string | null, string | null | undefined, string | null>;
	cancellation_detail: ColumnType<string | null, string | null | undefined, string | null>;
	cancellation_cancelled_by: ColumnType<string | null, string | null | undefined, string | null>;
	/** ISO-8601 UTC record timestamp (store clock) — the presence witness. */
	cancellation_cancelled_at: ColumnType<string | null, string | null | undefined, string | null>;
	created_at: string;
	updated_at: string;
}

/** Insert-once (§4): price/title/currency are snapshots, never updated. */
export interface OrderItemsTable {
	id: string;
	order_id: string;
	product_id: string;
	sku: string;
	title: string;
	unit_price_cents: number;
	currency: string;
	quantity: number;
	fulfillment_kind: string;
	reservation_id: string | null;
}

/** 1:1 with orders — the authoritative totals home (§4). Phase 4 writes the stub. */
export interface OrderTotalsTable {
	order_id: string;
	currency: string;
	subtotal_cents: number;
	discount_cents: number;
	shipping_cents: number;
	tax_cents: number;
	total_cents: number;
	applied_coupon_code: string | null;
	/** jsonb in pg / text in sqlite — stored as a JSON string, null in Phase 4. */
	shipping_method_snapshot: string | null;
	tax_breakdown: string | null;
}

export interface PaymentsTable {
	id: string;
	order_id: string;
	gateway: string;
	provider_ref: string;
	amount_cents: number;
	currency: string;
	status: string;
	created_at: string;
}

/**
 * Webhook/settlement dedupe + anomaly log (§5). A DEDUPE row carries a non-null
 * `dedupe_key` (UNIQUE — redelivery is a no-op) and null `kind`; an ANOMALY row
 * carries a null `dedupe_key` (multiple nulls allowed under UNIQUE) and a set
 * `kind`/`detail`.
 */
export interface PaymentEventsTable {
	id: string;
	dedupe_key: string | null;
	order_id: string;
	gateway: string;
	kind: string | null;
	detail: string | null;
	received_at: string;
}

export interface EntitlementsTable {
	id: string;
	order_id: string;
	product_id: string | null;
	sku: string;
	buyer_ref: string;
	state: string;
	source: string;
	granted_at: string;
	grant_idempotency_key: string;
}

// -- Phase 5 (§4/§5): customers, addresses, sessions, login challenges, outbox --

/** Storefront customer identity — separate from EmDash `ctx.users` (§4). */
export interface CustomersTable {
	id: string;
	/** Unique, lower-normalized (the domain `Email` brand normalizes). */
	email: string;
	display_name: string | null;
	email_verified_at: string | null;
	created_at: string;
}

/** Opaque DB-backed sessions (§4/§9 decision 5). Only `token_hash` is stored —
 *  never the plaintext token. */
export interface CustomerSessionsTable {
	id: string;
	customer_id: string;
	token_hash: string;
	created_at: string;
	expires_at: string;
	revoked_at: string | null;
}

/** One-time magic-link challenges (§4). Token stored as a hash; single-use via
 *  `consumed_at`. */
export interface LoginChallengesTable {
	id: string;
	email: string;
	token_hash: string;
	created_at: string;
	expires_at: string;
	consumed_at: string | null;
}

export interface AddressesTable {
	id: string;
	customer_id: string;
	kind: string;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postal_code: string;
	country: string;
	/** Portable 0/1 (not SQL boolean — better-sqlite3 cannot bind a JS boolean). */
	is_default: number;
	created_at: string;
}

/**
 * Order-status email outbox (§5). The guarded state `UPDATE` and the outbox
 * `INSERT` commit in one transaction; `UNIQUE(order_id, to_state)` makes the
 * enqueue exactly-once, and the conditional claim (`status`/`lease_until`) makes
 * the CLAIM exactly-once (no two dispatchers hold the same row's lease at once).
 * Actual delivery is at-least-once: a crash between `EmailSender.send()` and
 * marking the row sent lets the lease expire and the row be re-claimed and
 * re-sent. Dedup to effectively-once relies on the provider's `Idempotency-Key`
 * (see `HttpEmailSender`).
 */
export interface OrderEmailsOutboxTable {
	id: string;
	order_id: string;
	to_state: string;
	/** pending | sending | sent | failed. */
	status: string;
	attempts: number;
	/** Claim lease deadline (nullable — set on claim, cleared on reschedule). */
	lease_until: string | null;
	sent_at: string | null;
	created_at: string;
}

/** Append-only merchant notes on an order (admin-UX Increment 0). Guarded by
 *  `idempotency_key` UNIQUE; listed `order_id` + `created_at ASC, id ASC`. */
export interface OrderNotesTable {
	id: string;
	order_id: string;
	author: string;
	body: string;
	idempotency_key: string;
	created_at: string;
}

/**
 * Append-only state-change audit (admin-UX Increment 1, timeline slice). One row
 * is INSERTed inside the SAME guarded-flip transaction that moves an order (the
 * `#flipAndEnqueue` choke point), so a row exists iff the flip won — no row for a
 * replayed/lost-race flip. Listed `order_id` + `at ASC, id ASC` (both fixed-width
 * text, so lexical order IS chronological — dialect-identical). `kind` is
 * currently always `'state_change'` (a text column, so new kinds need no DDL).
 */
export interface OrderEventsTable {
	id: string;
	order_id: string;
	/** ISO-8601 UTC — the store clock at the flip. */
	at: string;
	kind: string;
	from_state: string | null;
	to_state: string | null;
	actor: string | null;
}

// -- Phase 6 (§5): shipping / tax / coupons -----------------------------------

/** Country/state/postal match list is opaque JSON-as-text config. */
export interface ShippingZonesTable {
	id: string;
	name: string;
	regions: string | null;
}

export interface ShippingMethodsTable {
	id: string;
	zone_id: string;
	name: string;
	/** 'flat_rate' | 'free_shipping'. */
	type: string;
}

export interface ShippingRatesTable {
	method_id: string;
	currency: string;
	amount_cents: number;
	/** Free-shipping threshold; null = none. */
	min_subtotal_cents: number | null;
}

export interface TaxClassesTable {
	id: string;
	name: string;
}

export interface TaxRatesTable {
	id: string;
	tax_class_id: string;
	zone_id: string;
	rate_bps: number;
	/** Portable 0/1 (not SQL boolean — better-sqlite3 cannot bind a JS boolean). */
	applies_to_shipping: number;
}

export interface CouponsTable {
	id: string;
	code: string;
	type: string;
	amount_cents: number | null;
	rate_bps: number | null;
	cap_cents: number | null;
	currency: string | null;
	min_subtotal_cents: number | null;
	starts_at: string | null;
	expires_at: string | null;
	max_uses: number | null;
	max_uses_per_customer: number | null;
	uses_count: number;
}

/** One row per redemption; `UNIQUE(coupon_id, idempotency_key)` makes a replay of
 *  the same checkout a no-op re-read (mirrors `reservations.idempotency_key`). */
export interface CouponRedemptionsTable {
	id: string;
	coupon_id: string;
	order_id: string;
	customer_id: string | null;
	idempotency_key: string;
	created_at: string;
}

// -- Phase 7 (§5): operational settings (service-DB tier) ---------------------

/** Single-row typed operational settings (§7 Step 3). `id` is a fixed sentinel
 *  ('singleton') so there is at most one row; `get` returns defaults when absent. */
export interface SettingsTable {
	id: string;
	hold_ttl_minutes: number;
	low_stock_threshold: number;
	updated_at: string;
}

/** Idempotency ledger for `SettingsStore.update` — records the RESULTING settings
 *  per key so a replay returns the recorded snapshot without re-applying (a stale
 *  replay never clobbers a newer write). Mirrors `coupon_redemptions`'s claim. */
export interface SettingsMutationsTable {
	idempotency_key: string;
	hold_ttl_minutes: number;
	low_stock_threshold: number;
	created_at: string;
}

export interface Database {
	inventory: InventoryTable;
	reservations: ReservationsTable;
	product_commerce: ProductCommerceTable;
	carts: CartsTable;
	cart_lines: CartLinesTable;
	cart_mutations: CartMutationsTable;
	inventory_adjustments: InventoryAdjustmentsTable;
	inventory_stock_movements: InventoryStockMovementsTable;
	orders: OrdersTable;
	order_items: OrderItemsTable;
	order_totals: OrderTotalsTable;
	payments: PaymentsTable;
	payment_events: PaymentEventsTable;
	entitlements: EntitlementsTable;
	customers: CustomersTable;
	customer_sessions: CustomerSessionsTable;
	login_challenges: LoginChallengesTable;
	addresses: AddressesTable;
	order_emails_outbox: OrderEmailsOutboxTable;
	order_notes: OrderNotesTable;
	order_events: OrderEventsTable;
	// Phase 6:
	shipping_zones: ShippingZonesTable;
	shipping_methods: ShippingMethodsTable;
	shipping_rates: ShippingRatesTable;
	tax_classes: TaxClassesTable;
	tax_rates: TaxRatesTable;
	coupons: CouponsTable;
	coupon_redemptions: CouponRedemptionsTable;
	// Phase 7:
	settings: SettingsTable;
	settings_mutations: SettingsMutationsTable;
}
