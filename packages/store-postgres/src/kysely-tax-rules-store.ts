import type {
	CreateTaxClassInput,
	CreateTaxRateInput,
	DeleteTaxClassStoreResult,
	DeleteTaxRateResult,
	TaxClass,
	TaxRate,
	TaxRulesStore,
	UpdateTaxRateInput,
	UpdateTaxRateResult,
} from "@urumi/domain";
import type { Kysely, Selectable } from "kysely";
import type { Database, TaxRatesTable } from "./schema.js";

/** `TaxRulesStore` over Kysely — dialect-agnostic (better-sqlite3 + pg). */
export class KyselyTaxRulesStore implements TaxRulesStore {
	readonly #db: Kysely<Database>;

	constructor(options: { db: Kysely<Database> }) {
		this.#db = options.db;
	}

	async createClass(input: CreateTaxClassInput): Promise<TaxClass> {
		await this.#db.insertInto("tax_classes").values({ id: input.id, name: input.name }).execute();
		return { id: input.id, name: input.name };
	}

	async listClasses(): Promise<TaxClass[]> {
		const rows = await this.#db.selectFrom("tax_classes").selectAll().orderBy("id").execute();
		return rows.map((r) => ({ id: r.id, name: r.name }));
	}

	/**
	 * Delete a tax class (port doc), with the store's own-grain delete-in-use
	 * guard: the DELETE is conditioned on NO `tax_rate` referencing the class, so
	 * a concurrent rate insert can never orphan onto a just-deleted class. Zero
	 * rows deleted ⇒ a fresh read classifies why (unknown id vs still-referenced),
	 * mirroring the product-commerce store's no-op-then-reread pattern. The
	 * PRODUCT-reference guard is the `deleteTaxClass` use-case's job (a different
	 * aggregate).
	 */
	async deleteClass(id: string): Promise<DeleteTaxClassStoreResult> {
		const res = await this.#db
			.deleteFrom("tax_classes")
			.where("id", "=", id)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("tax_rates")
							.select("id")
							.whereRef("tax_rates.tax_class_id", "=", "tax_classes.id"),
					),
				),
			)
			.executeTakeFirst();
		if (Number(res.numDeletedRows) > 0) return { ok: true };
		// Zero rows: either the class does not exist, or a rate still references it.
		const exists = await this.#db
			.selectFrom("tax_classes")
			.select("id")
			.where("id", "=", id)
			.executeTakeFirst();
		if (exists === undefined) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "in_use_by_rates" };
	}

	async createRate(input: CreateTaxRateInput): Promise<TaxRate> {
		await this.#db
			.insertInto("tax_rates")
			.values({
				id: input.id,
				tax_class_id: input.taxClassId,
				zone_id: input.zoneId,
				rate_bps: input.rateBps,
				applies_to_shipping: input.appliesToShipping ? 1 : 0,
			})
			.execute();
		return { ...input };
	}

	async getRate(taxClassId: string, zoneId: string): Promise<TaxRate | null> {
		const r = await this.#db
			.selectFrom("tax_rates")
			.selectAll()
			.where("tax_class_id", "=", taxClassId)
			.where("zone_id", "=", zoneId)
			.executeTakeFirst();
		return r === undefined ? null : toRate(r);
	}

	async listRatesForZone(zoneId: string): Promise<TaxRate[]> {
		const rows = await this.#db
			.selectFrom("tax_rates")
			.selectAll()
			.where("zone_id", "=", zoneId)
			.orderBy("id")
			.execute();
		return rows.map(toRate);
	}

	/**
	 * Guarded edit (port doc): optimistic CAS on the money-bearing `rate_bps`. The
	 * UPDATE is conditioned on `rate_bps = expectedRateBps`; zero rows updated ⇒ a
	 * fresh read classifies unknown id (`not_found`) vs a concurrent change
	 * (`stale`), mirroring `deleteClass`'s no-op-then-reread pattern.
	 */
	async updateRate(
		id: string,
		input: UpdateTaxRateInput,
		expectedRateBps: number,
	): Promise<UpdateTaxRateResult> {
		const updated = await this.#db
			.updateTable("tax_rates")
			.set({
				rate_bps: input.rateBps,
				applies_to_shipping: input.appliesToShipping ? 1 : 0,
			})
			.where("id", "=", id)
			.where("rate_bps", "=", expectedRateBps)
			.returningAll()
			.executeTakeFirst();
		if (updated !== undefined) return { ok: true, rate: toRate(updated) };
		const current = await this.#db
			.selectFrom("tax_rates")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (current === undefined) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "stale", current: toRate(current) };
	}

	/** Leaf delete (port doc). Zero rows ⇒ `not_found` (idempotent no-op). */
	async deleteRate(id: string): Promise<DeleteTaxRateResult> {
		const res = await this.#db.deleteFrom("tax_rates").where("id", "=", id).executeTakeFirst();
		return Number(res.numDeletedRows) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
	}
}

function toRate(r: Selectable<TaxRatesTable>): TaxRate {
	return {
		id: r.id,
		taxClassId: r.tax_class_id,
		zoneId: r.zone_id,
		rateBps: r.rate_bps,
		appliesToShipping: r.applies_to_shipping === 1,
	};
}
