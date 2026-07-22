import type { OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGen } from "../ports/id-gen.js";
import type {
	AppendOrderNoteInput,
	AppendOrderNoteResult,
	OrderNote,
	OrderNotesStore,
} from "../ports/order-notes-store.js";

/**
 * IO-free `OrderNotesStore` fake — the first adapter to pass
 * `orderNotesStoreContract`. Models the real Kysely adapter: an
 * `idempotency_key`-guarded append (a replay returns the existing note, inserting
 * nothing) and a `created_at ASC, id ASC` append-ordered list. Deterministic and
 * synchronous — the id comes from the injected `IdGen`, the timestamp from the
 * injected `Clock` — so the replay / append-order cases run here first.
 */
export class InMemoryOrderNotesStore implements OrderNotesStore {
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #notes: OrderNote[] = [];
	readonly #byKey = new Map<string, OrderNote>();

	constructor(options: { idGen: IdGen; clock: Clock }) {
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async append(input: AppendOrderNoteInput): Promise<AppendOrderNoteResult> {
		const existing = this.#byKey.get(input.idempotencyKey);
		if (existing !== undefined) return { appended: false, note: { ...existing } };

		const note: OrderNote = {
			id: this.#idGen.newId(),
			orderId: input.orderId,
			author: input.author,
			body: input.body,
			createdAt: this.#clock.now().toISOString(),
		};
		this.#notes.push(note);
		this.#byKey.set(input.idempotencyKey, note);
		return { appended: true, note: { ...note } };
	}

	async listForOrder(orderId: OrderId): Promise<OrderNote[]> {
		// created_at ASC, id ASC — the SAME code-unit ordering the SQL adapter uses
		// (createdAt is fixed-width ISO-8601, ids are opaque ASCII), so fake and SQL
		// agree byte-for-byte.
		return this.#notes
			.filter((n) => n.orderId === orderId)
			.toSorted((a, b) =>
				a.createdAt === b.createdAt
					? codeUnitAsc(a.id, b.id)
					: codeUnitAsc(a.createdAt, b.createdAt),
			)
			.map((n) => ({ ...n }));
	}
}

/** Ascending code-unit string comparison (`<` first) — plain byte order, never
 *  `localeCompare` (matches the store's ORDER BY). */
function codeUnitAsc(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
