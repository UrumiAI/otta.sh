import type { IdempotencyKey, OrderId } from "../money/ids.js";
import type { OrderNote, OrderNotesStore } from "../ports/order-notes-store.js";
import type { OrderStore } from "../ports/order-store.js";

export interface AppendOrderNoteDeps {
	orderNotesStore: OrderNotesStore;
	/** Used to reject a note on a non-existent order — a note must hang off a real
	 *  order (the append-only annotation has no meaning otherwise). */
	orderStore: OrderStore;
}

export interface AppendOrderNoteCommand {
	orderId: OrderId;
	author: string;
	body: string;
	/** Every command carries one (CLAUDE.md); the store enforces once-only on it. */
	idempotencyKey: IdempotencyKey;
}

export type AppendNoteFailure = "ORDER_NOT_FOUND" | "EMPTY_AUTHOR" | "EMPTY_BODY";

export type AppendNoteOutcome =
	| { ok: true; appended: boolean; note: OrderNote }
	| { ok: false; reason: AppendNoteFailure };

/**
 * Append a merchant note to an order (admin-UX Increment 0). Pure orchestration —
 * no IO of its own: it validates the command, confirms the order exists, then
 * delegates the once-only insert to the store. `author`/`body` are trimmed and
 * required non-empty (a blank note is meaningless); the trimmed values are what
 * get persisted. Idempotency is the store's: a replayed `idempotencyKey` yields
 * the already-stored note with `appended:false`.
 */
export async function appendOrderNote(
	deps: AppendOrderNoteDeps,
	cmd: AppendOrderNoteCommand,
): Promise<AppendNoteOutcome> {
	const author = cmd.author.trim();
	const body = cmd.body.trim();
	if (author.length === 0) return { ok: false, reason: "EMPTY_AUTHOR" };
	if (body.length === 0) return { ok: false, reason: "EMPTY_BODY" };

	const order = await deps.orderStore.getById(cmd.orderId);
	if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };

	const { appended, note } = await deps.orderNotesStore.append({
		orderId: cmd.orderId,
		author,
		body,
		idempotencyKey: cmd.idempotencyKey,
	});
	return { ok: true, appended, note };
}

/** List an order's notes in append order (thin read-through — the ordering
 *  guarantee lives in the store). Kept alongside the append use-case so the
 *  service/plugin read the notes surface through the domain, not the port. */
export async function listOrderNotes(
	deps: Pick<AppendOrderNoteDeps, "orderNotesStore">,
	orderId: OrderId,
): Promise<OrderNote[]> {
	return deps.orderNotesStore.listForOrder(orderId);
}
