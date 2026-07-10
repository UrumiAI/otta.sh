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

export interface Database {
	inventory: InventoryTable;
	reservations: ReservationsTable;
}
