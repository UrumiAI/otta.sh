/**
 * The order-note document: one per note, in a CHILD collection of its own.
 *
 * ADR-0019 §4 listed per-order notes among the four ledgers that "collapse inside
 * their aggregate", and `order-documents.ts` records why that one does not hold: a
 * note is operator-supplied free text with no natural bound, appended for as long as
 * an order is discussed, so embedding it would make the size of the hot money-path
 * document a function of how much support wrote about it. The order document
 * therefore has no `notes[]`, and notes live here.
 *
 * | Document | What it is |
 * |---|---|
 * | `order_notes/{idempotencyKey}` | one note; its id is the once-only guard |
 *
 * **The document id is the note's idempotency key, not its note id.** The SQL's
 * once-only was `order_notes.idempotency_key` UNIQUE — table-wide, not per order —
 * and ADR-0019's own `uniqueIndexes` mapping says that constraint "becomes the
 * document id of its claim". So the key IS the id, `append` is one
 * create-if-absent, and a replay is a refused write and a read back. The note's own
 * `id` is minted by the store and kept as a field, exactly as the SQL kept it as a
 * column: nothing looks a note up by it.
 *
 * That is the ONE deviation this file makes from §4's row, which read
 * `order_notes/{orderId}:{noteId}`, and the §4 table now carries the corrected
 * form. A composite id would have needed a second document — a claim keyed by the
 * idempotency key, pointing at the note — and with it a crash seam between the two,
 * to buy nothing: the note id is not a key any caller holds. Worse, keying on
 * `{orderId}:{noteId}` alone would make one idempotency key admissible once PER
 * ORDER, which is weaker than the constraint it replaces.
 *
 * **`orderId` is the only declared index, and the append order is applied in code.**
 * The port reads notes one order at a time and returns them `createdAt ASC, id ASC`.
 * That pair has to be sorted together or the tie-break is not a tie-break, and a
 * note's id has no meaning to a reader on its own, so the ordering is done after a
 * bounded paged read on the `orderId` index — the same shape as the session
 * history's.
 */
import type { OrderNote } from "@otta-sh/domain";
import { orderId as toOrderId } from "@otta-sh/domain";

/** Collection name: one note per idempotency key. */
export const ORDER_NOTES_COLLECTION = "order_notes";

/** One collection as the plugin descriptor declares it. */
export interface OrderNotesCollectionIndexDeclaration {
	readonly indexes?: readonly string[];
	readonly uniqueIndexes?: readonly string[];
}

/**
 * The one collection the notes store owns. `orderId` is declared because
 * `listForOrder` filters on it; nothing else is, because nothing else is queried.
 */
export const ORDER_NOTES_COLLECTIONS: Readonly<
	Record<string, OrderNotesCollectionIndexDeclaration>
> = {
	[ORDER_NOTES_COLLECTION]: { indexes: ["orderId"] },
};

/** `order_notes/{idempotencyKey}` — one append-only merchant annotation. */
export interface OrderNoteDoc {
	/** The note's own id, minted by the store. Not the document id. */
	readonly noteId: string;
	readonly orderId: string;
	readonly author: string;
	readonly body: string;
	readonly createdAt: string;
}

/** The port's shape. */
export function toOrderNote(doc: OrderNoteDoc): OrderNote {
	return {
		id: doc.noteId,
		orderId: toOrderId(doc.orderId),
		author: doc.author,
		body: doc.body,
		createdAt: doc.createdAt,
	};
}

/**
 * Append order: `createdAt ASC`, then the note id as the tie-break.
 *
 * `createdAt` is fixed-width ISO-8601 UTC, so a lexical comparison IS chronological
 * — the same property the SQL relied on to make its `ORDER BY` dialect-identical.
 * The id tie-break is what makes two notes written at the same instant come back in
 * a deterministic order; under the deterministic id source a suite uses, that order
 * is insertion order, and under a random one it is stable but arbitrary, exactly as
 * it was in SQL.
 */
export function sortOrderNotes(docs: readonly OrderNoteDoc[]): OrderNoteDoc[] {
	return docs.toSorted((a, b) => {
		if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
		if (a.noteId === b.noteId) return 0;
		return a.noteId < b.noteId ? -1 : 1;
	});
}
