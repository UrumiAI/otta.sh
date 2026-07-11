import type {
	CreateTaxClassInput,
	CreateTaxRateInput,
	TaxClass,
	TaxRate,
	TaxRulesStore,
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
