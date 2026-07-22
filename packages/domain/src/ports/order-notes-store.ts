import type { IdempotencyKey, OrderId } from "../money/ids.js";

/**
 * The `OrderNotes` port — the admin-UX walking skeleton's smallest full slice
 * (Increment 0). An order note is an **append-only** merchant annotation on an
 * order's mutable envelope (never a line item / price — the snapshot invariant is
 * untouched). Notes carry an author, a body, and a server-assigned timestamp; a
 * note is never edited or deleted in this slice.
 *
 * Intent, never SQL: the Kysely adapter inserts one `order_notes` row guarded by
 * `idempotency_key` UNIQUE; the in-memory fake models the same behavior. `append`
 * is idempotent — replaying the same `idempotencyKey` returns the ALREADY-STORED
 * note (`appended:false`), inserting nothing (CLAUDE.md: every command carries an
 * `idempotencyKey`; the store enforces once-only).
 */
export interface OrderNotesStore {
	/**
	 * Append a note to an order. The id + `createdAt` are assigned by the store
	 * (idGen + clock), never client-supplied. Guarded by `idempotency_key` UNIQUE:
	 * a replay with the same key returns the existing note (`appended:false`) and
	 * writes nothing — so a double-submit or a retried request adds exactly one
	 * note.
	 */
	append(input: AppendOrderNoteInput): Promise<AppendOrderNoteResult>;

	/**
	 * Every note for an order, in APPEND ORDER — `created_at ASC, id ASC` (the id
	 * is the stable tie-break when two notes share a timestamp, so the order is
	 * deterministic under a fixed clock). An order with no notes returns `[]`.
	 * Scoped to the one order: a note on another order never leaks in.
	 */
	listForOrder(orderId: OrderId): Promise<OrderNote[]>;
}

/** A stored order note (append-only). Money-free — a plain merchant annotation. */
export interface OrderNote {
	id: string;
	orderId: OrderId;
	/** Who wrote the note (free text, resolved by the caller — the domain does not
	 *  model admin identity). */
	author: string;
	body: string;
	/** Server-assigned ISO-8601 UTC timestamp (from the store's clock). */
	createdAt: string;
}

/** The append command. `author`/`body` are already trimmed + validated non-empty
 *  by the use-case; the store persists them verbatim. */
export interface AppendOrderNoteInput {
	orderId: OrderId;
	author: string;
	body: string;
	idempotencyKey: IdempotencyKey;
}

/** `appended:false` ⇒ this was an idempotent replay; `note` is the previously
 *  stored note (nothing new was written). */
export type AppendOrderNoteResult = { appended: boolean; note: OrderNote };
