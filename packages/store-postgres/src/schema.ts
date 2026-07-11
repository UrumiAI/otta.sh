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
	/** Set when settle loses an adopted hold → manual reconciliation (§5). */
	reconciliation_flag: ColumnType<string | null, string | null | undefined, string | null>;
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

export interface Database {
	inventory: InventoryTable;
	reservations: ReservationsTable;
	product_commerce: ProductCommerceTable;
	carts: CartsTable;
	cart_lines: CartLinesTable;
	cart_mutations: CartMutationsTable;
	inventory_adjustments: InventoryAdjustmentsTable;
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
}
