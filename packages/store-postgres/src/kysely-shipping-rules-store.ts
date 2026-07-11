import {
	cents,
	currency as toCurrency,
	type Currency,
	type CreateShippingMethodInput,
	type CreateShippingRateInput,
	type CreateShippingZoneInput,
	type ShippingMethod,
	type ShippingMethodType,
	type ShippingRate,
	type ShippingRulesStore,
	type ShippingZone,
} from "@urumi/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/** `ShippingRulesStore` over Kysely — dialect-agnostic (better-sqlite3 + pg). */
export class KyselyShippingRulesStore implements ShippingRulesStore {
	readonly #db: Kysely<Database>;

	constructor(options: { db: Kysely<Database> }) {
		this.#db = options.db;
	}

	async createZone(input: CreateShippingZoneInput): Promise<ShippingZone> {
		await this.#db
			.insertInto("shipping_zones")
			.values({
				id: input.id,
				name: input.name,
				regions:
					input.regions === null || input.regions === undefined
						? null
						: JSON.stringify(input.regions),
			})
			.execute();
		return { id: input.id, name: input.name, regions: input.regions };
	}

	async listZones(): Promise<ShippingZone[]> {
		const rows = await this.#db.selectFrom("shipping_zones").selectAll().orderBy("id").execute();
		return rows.map((r) => ({ id: r.id, name: r.name, regions: parseRegions(r.regions) }));
	}

	async getZone(zoneId: string): Promise<ShippingZone | null> {
		const r = await this.#db
			.selectFrom("shipping_zones")
			.selectAll()
			.where("id", "=", zoneId)
			.executeTakeFirst();
		return r === undefined ? null : { id: r.id, name: r.name, regions: parseRegions(r.regions) };
	}

	async createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod> {
		await this.#db
			.insertInto("shipping_methods")
			.values({ id: input.id, zone_id: input.zoneId, name: input.name, type: input.type })
			.execute();
		return { id: input.id, zoneId: input.zoneId, name: input.name, type: input.type };
	}

	async listMethods(zoneId: string): Promise<ShippingMethod[]> {
		const rows = await this.#db
			.selectFrom("shipping_methods")
			.selectAll()
			.where("zone_id", "=", zoneId)
			.orderBy("id")
			.execute();
		return rows.map(toMethod);
	}

	async getMethod(methodId: string): Promise<ShippingMethod | null> {
		const r = await this.#db
			.selectFrom("shipping_methods")
			.selectAll()
			.where("id", "=", methodId)
			.executeTakeFirst();
		return r === undefined ? null : toMethod(r);
	}

	async createRate(input: CreateShippingRateInput): Promise<ShippingRate> {
		await this.#db
			.insertInto("shipping_rates")
			.values({
				method_id: input.methodId,
				currency: input.currency,
				amount_cents: input.amountCents,
				min_subtotal_cents: input.minSubtotalCents,
			})
			.execute();
		return { ...input };
	}

	async getRate(methodId: string, currency: Currency): Promise<ShippingRate | null> {
		const r = await this.#db
			.selectFrom("shipping_rates")
			.selectAll()
			.where("method_id", "=", methodId)
			.where("currency", "=", currency)
			.executeTakeFirst();
		if (r === undefined) return null;
		return {
			methodId: r.method_id,
			currency: toCurrency(r.currency),
			amountCents: cents(r.amount_cents),
			minSubtotalCents: r.min_subtotal_cents === null ? null : cents(r.min_subtotal_cents),
		};
	}
}

function toMethod(r: { id: string; zone_id: string; name: string; type: string }): ShippingMethod {
	return { id: r.id, zoneId: r.zone_id, name: r.name, type: r.type as ShippingMethodType };
}

function parseRegions(value: string | null): unknown {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
