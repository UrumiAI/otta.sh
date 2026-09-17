import type {
	IdGen,
	OrderId,
	PaymentEventStore,
	PaymentMethod,
	RecordAnomalyInput,
} from "@otta-sh/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

export interface KyselyPaymentEventStoreOptions {
	db: Kysely<Database>;
	idGen: IdGen;
}

/**
 * `PaymentEventStore` over Kysely (§5). Dedupe is
 * `INSERT … ON CONFLICT (dedupe_key) DO NOTHING RETURNING` — a returned row is the
 * FIRST delivery; a conflict (no row) is a redelivery no-op. Anomalies are
 * separate rows (null `dedupe_key`, set `kind`/`detail`) — durably recorded,
 * never swallowed.
 */
export class KyselyPaymentEventStore implements PaymentEventStore {
	readonly #db: Kysely<Database>;
	readonly #idGen: IdGen;

	constructor(options: KyselyPaymentEventStoreOptions) {
		this.#db = options.db;
		this.#idGen = options.idGen;
	}

	async dedupe(
		dedupeKey: string,
		orderId: OrderId,
		gateway: PaymentMethod,
		now: string,
	): Promise<boolean> {
		const inserted = await this.#db
			.insertInto("payment_events")
			.values({
				id: this.#idGen.newId(),
				dedupe_key: dedupeKey,
				order_id: orderId,
				gateway,
				kind: null,
				detail: null,
				received_at: now,
			})
			.onConflict((oc) => oc.column("dedupe_key").doNothing())
			.returning("id")
			.executeTakeFirst();
		return inserted !== undefined;
	}

	/** The order a recorded `dedupe_key` names. Only the event rows have a
	 *  `dedupe_key` (anomalies write `null`), and it is UNIQUE, so this matches at
	 *  most one row. Asked only on the duplicate arm of `settleOrder`. */
	async orderForDedupeKey(dedupeKey: string): Promise<OrderId | null> {
		const row = await this.#db
			.selectFrom("payment_events")
			.select("order_id")
			.where("dedupe_key", "=", dedupeKey)
			.executeTakeFirst();
		return row === undefined ? null : (row.order_id as OrderId);
	}

	async recordAnomaly(input: RecordAnomalyInput): Promise<void> {
		await this.#db
			.insertInto("payment_events")
			.values({
				id: this.#idGen.newId(),
				dedupe_key: null,
				order_id: input.orderId,
				gateway: input.gateway,
				kind: input.kind,
				detail: input.detail,
				received_at: input.now,
			})
			.execute();
	}
}
