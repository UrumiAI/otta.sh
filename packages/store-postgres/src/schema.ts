// Kysely table typings for the Phase-0 inventory schema (§6) plus the Phase-3
// cart schema. Portable types only (text/integer) so the same DDL and queries
// serve better-sqlite3 and pg.

import type { ColumnType } from "kysely";

export type ReservationState = "pending" | "held" | "committed" | "released" | "failed";

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
	created_at: string;
	updated_at: string;
}

export interface Database {
	inventory: InventoryTable;
	reservations: ReservationsTable;
	product_commerce: ProductCommerceTable;
	carts: CartsTable;
	cart_lines: CartLinesTable;
	cart_mutations: CartMutationsTable;
}
