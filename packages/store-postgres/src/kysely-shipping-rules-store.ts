import {
	cents,
	currency as toCurrency,
	type Cents,
	type Currency,
	type CreateShippingMethodInput,
	type CreateShippingRateInput,
	type CreateShippingZoneInput,
	type DeleteShippingMethodResult,
	type DeleteShippingRateResult,
	type DeleteShippingZoneResult,
	type ShippingMethod,
	type ShippingMethodType,
	type ShippingRate,
	type ShippingRulesStore,
	type ShippingZone,
	type UpdateShippingMethodInput,
	type UpdateShippingMethodResult,
	type UpdateShippingRateInput,
	type UpdateShippingRateResult,
	type UpdateShippingZoneInput,
	type UpdateShippingZoneResult,
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

	/** LWW edit (port doc). Zero rows updated ⇒ `not_found`. */
	async updateZone(
		zoneId: string,
		input: UpdateShippingZoneInput,
	): Promise<UpdateShippingZoneResult> {
		const updated = await this.#db
			.updateTable("shipping_zones")
			.set({
				name: input.name,
				regions:
					input.regions === null || input.regions === undefined
						? null
						: JSON.stringify(input.regions),
			})
			.where("id", "=", zoneId)
			.returningAll()
			.executeTakeFirst();
		if (updated === undefined) return { ok: false, reason: "not_found" };
		return {
			ok: true,
			zone: { id: updated.id, name: updated.name, regions: parseRegions(updated.regions) },
		};
	}

	/**
	 * Forbid-if-children delete (port doc): the DELETE is conditioned on NO
	 * `shipping_method` referencing the zone, so a concurrent method insert can
	 * never orphan onto a just-deleted zone. Zero rows ⇒ classify unknown id vs
	 * still-referenced (mirrors `TaxRulesStore.deleteClass`).
	 */
	async deleteZone(zoneId: string): Promise<DeleteShippingZoneResult> {
		const res = await this.#db
			.deleteFrom("shipping_zones")
			.where("id", "=", zoneId)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("shipping_methods")
							.select("id")
							.whereRef("shipping_methods.zone_id", "=", "shipping_zones.id"),
					),
				),
			)
			.executeTakeFirst();
		if (Number(res.numDeletedRows) > 0) return { ok: true };
		const exists = await this.#db
			.selectFrom("shipping_zones")
			.select("id")
			.where("id", "=", zoneId)
			.executeTakeFirst();
		if (exists === undefined) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "in_use_by_methods" };
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

	/** LWW edit (port doc). Zero rows updated ⇒ `not_found`. */
	async updateMethod(
		methodId: string,
		input: UpdateShippingMethodInput,
	): Promise<UpdateShippingMethodResult> {
		const updated = await this.#db
			.updateTable("shipping_methods")
			.set({ name: input.name, type: input.type })
			.where("id", "=", methodId)
			.returningAll()
			.executeTakeFirst();
		if (updated === undefined) return { ok: false, reason: "not_found" };
		return { ok: true, method: toMethod(updated) };
	}

	/** Forbid-if-children delete (port doc): conditioned on NO `shipping_rate`
	 *  referencing the method. Zero rows ⇒ unknown id vs still-referenced. */
	async deleteMethod(methodId: string): Promise<DeleteShippingMethodResult> {
		const res = await this.#db
			.deleteFrom("shipping_methods")
			.where("id", "=", methodId)
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("shipping_rates")
							.select("method_id")
							.whereRef("shipping_rates.method_id", "=", "shipping_methods.id"),
					),
				),
			)
			.executeTakeFirst();
		if (Number(res.numDeletedRows) > 0) return { ok: true };
		const exists = await this.#db
			.selectFrom("shipping_methods")
			.select("id")
			.where("id", "=", methodId)
			.executeTakeFirst();
		if (exists === undefined) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "in_use_by_rates" };
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
		return r === undefined ? null : toRate(r);
	}

	/**
	 * Guarded edit (port doc): optimistic CAS on the money-bearing `amount_cents`.
	 * Zero rows updated ⇒ a fresh read classifies unknown `(methodId, currency)`
	 * (`not_found`) vs a concurrent price change (`stale`).
	 */
	async updateRate(
		methodId: string,
		currency: Currency,
		input: UpdateShippingRateInput,
		expectedAmountCents: Cents,
	): Promise<UpdateShippingRateResult> {
		const updated = await this.#db
			.updateTable("shipping_rates")
			.set({ amount_cents: input.amountCents, min_subtotal_cents: input.minSubtotalCents })
			.where("method_id", "=", methodId)
			.where("currency", "=", currency)
			.where("amount_cents", "=", expectedAmountCents)
			.returningAll()
			.executeTakeFirst();
		if (updated !== undefined) return { ok: true, rate: toRate(updated) };
		const current = await this.#db
			.selectFrom("shipping_rates")
			.selectAll()
			.where("method_id", "=", methodId)
			.where("currency", "=", currency)
			.executeTakeFirst();
		if (current === undefined) return { ok: false, reason: "not_found" };
		return { ok: false, reason: "stale", current: toRate(current) };
	}

	/** Leaf delete (port doc). Zero rows ⇒ `not_found` (idempotent no-op). */
	async deleteRate(methodId: string, currency: Currency): Promise<DeleteShippingRateResult> {
		const res = await this.#db
			.deleteFrom("shipping_rates")
			.where("method_id", "=", methodId)
			.where("currency", "=", currency)
			.executeTakeFirst();
		return Number(res.numDeletedRows) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
	}
}

function toMethod(r: { id: string; zone_id: string; name: string; type: string }): ShippingMethod {
	return { id: r.id, zoneId: r.zone_id, name: r.name, type: r.type as ShippingMethodType };
}

function toRate(r: {
	method_id: string;
	currency: string;
	amount_cents: number;
	min_subtotal_cents: number | null;
}): ShippingRate {
	return {
		methodId: r.method_id,
		currency: toCurrency(r.currency),
		amountCents: cents(r.amount_cents),
		minSubtotalCents: r.min_subtotal_cents === null ? null : cents(r.min_subtotal_cents),
	};
}

function parseRegions(value: string | null): unknown {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
