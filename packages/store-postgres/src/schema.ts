// Kysely table typings for the Phase-0 inventory schema (§6). Portable types
// only (text/integer) so the same DDL and queries serve better-sqlite3 and pg.

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
	created_at: string;
	updated_at: string;
}

export interface Database {
	inventory: InventoryTable;
	reservations: ReservationsTable;
	product_commerce: ProductCommerceTable;
}
