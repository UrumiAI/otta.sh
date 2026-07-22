import {
	type AppendOrderNoteInput,
	type AppendOrderNoteResult,
	type Clock,
	type IdGen,
	type OrderId,
	orderId as toOrderId,
	type OrderNote,
	type OrderNotesStore,
} from "@urumi/domain";
import type { Kysely, Selectable } from "kysely";
import type { Database, OrderNotesTable } from "./schema.js";

export interface KyselyOrderNotesStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
	clock: Clock;
}

/**
 * `OrderNotesStore` over Kysely (admin-UX Increment 0), dialect-agnostic across
 * better-sqlite3 and pg. `append` is a single INSERT guarded by
 * `order_notes.idempotency_key` UNIQUE via `ON CONFLICT DO NOTHING RETURNING`:
 * the first append wins and returns the new row; a replay (or a concurrent
 * duplicate-key race) inserts nothing and reloads the already-stored note — so
 * exactly one note lands per key even under concurrency. `listForOrder` reads the
 * one order's notes in append order (`created_at ASC, id ASC`; `created_at` is
 * fixed-width ISO-8601 text ⇒ lexical order IS chronological, so the comparison is
 * dialect-identical). Notes are insert-once: no code path updates a stored note.
 */
export class KyselyOrderNotesStore implements OrderNotesStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;

	constructor(options: KyselyOrderNotesStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
		this.#clock = options.clock;
	}

	async append(input: AppendOrderNoteInput): Promise<AppendOrderNoteResult> {
		const inserted = await this.#db
			.insertInto("order_notes")
			.values({
				id: this.#idGen.newId(),
				order_id: input.orderId,
				author: input.author,
				body: input.body,
				idempotency_key: input.idempotencyKey,
				created_at: this.#clock.now().toISOString(),
			})
			.onConflict((oc) => oc.column("idempotency_key").doNothing())
			.returningAll()
			.executeTakeFirst();

		if (inserted !== undefined) return { appended: true, note: toNote(inserted) };

		// Key already present ⇒ replay (or lost the insert race): reload the stored
		// note so both callers see the identical, once-only note.
		const existing = await this.#db
			.selectFrom("order_notes")
			.selectAll()
			.where("idempotency_key", "=", input.idempotencyKey)
			.executeTakeFirstOrThrow();
		return { appended: false, note: toNote(existing) };
	}

	async listForOrder(orderId: OrderId): Promise<OrderNote[]> {
		const rows = await this.#db
			.selectFrom("order_notes")
			.selectAll()
			.where("order_id", "=", orderId)
			.orderBy("created_at", "asc")
			.orderBy("id", "asc")
			.execute();
		return rows.map(toNote);
	}
}

function toNote(row: Selectable<OrderNotesTable>): OrderNote {
	return {
		id: row.id,
		orderId: toOrderId(row.order_id),
		author: row.author,
		body: row.body,
		createdAt: row.created_at,
	};
}
