import type {
	CreateShippingMethodInput,
	CreateShippingRateInput,
	CreateShippingZoneInput,
	DeleteShippingMethodResult,
	DeleteShippingRateResult,
	DeleteShippingZoneResult,
	ShippingMethod,
	ShippingRate,
	ShippingRulesStore,
	ShippingZone,
	UpdateShippingMethodInput,
	UpdateShippingMethodResult,
	UpdateShippingRateInput,
	UpdateShippingRateResult,
	UpdateShippingZoneInput,
	UpdateShippingZoneResult,
} from "../ports/shipping-rules-store.js";
import type { Cents, Currency } from "../money/cents.js";

/** IO-free `ShippingRulesStore` fake — the first adapter to pass the contract. */
export class InMemoryShippingRulesStore implements ShippingRulesStore {
	#zones = new Map<string, ShippingZone>();
	#methods = new Map<string, ShippingMethod>();
	/** Keyed `${methodId} ${currency}`. */
	#rates = new Map<string, ShippingRate>();

	async createZone(input: CreateShippingZoneInput): Promise<ShippingZone> {
		const zone: ShippingZone = { id: input.id, name: input.name, regions: input.regions };
		this.#zones.set(zone.id, zone);
		return { ...zone };
	}

	async listZones(): Promise<ShippingZone[]> {
		return [...this.#zones.values()].map((z) => ({ ...z }));
	}

	async getZone(zoneId: string): Promise<ShippingZone | null> {
		const z = this.#zones.get(zoneId);
		return z === undefined ? null : { ...z };
	}

	/** LWW edit of a zone's structural fields (port doc). */
	async updateZone(
		zoneId: string,
		input: UpdateShippingZoneInput,
	): Promise<UpdateShippingZoneResult> {
		const zone = this.#zones.get(zoneId);
		if (zone === undefined) return { ok: false, reason: "not_found" };
		zone.name = input.name;
		zone.regions = input.regions;
		return { ok: true, zone: { ...zone } };
	}

	/** Forbid-if-children: a zone with ≥1 method cannot be deleted (port doc). */
	async deleteZone(zoneId: string): Promise<DeleteShippingZoneResult> {
		if (!this.#zones.has(zoneId)) return { ok: false, reason: "not_found" };
		for (const m of this.#methods.values()) {
			if (m.zoneId === zoneId) return { ok: false, reason: "in_use_by_methods" };
		}
		this.#zones.delete(zoneId);
		return { ok: true };
	}

	async createMethod(input: CreateShippingMethodInput): Promise<ShippingMethod> {
		const method: ShippingMethod = {
			id: input.id,
			zoneId: input.zoneId,
			name: input.name,
			type: input.type,
			taxable: input.taxable ?? true,
		};
		this.#methods.set(method.id, method);
		return { ...method };
	}

	async listMethods(zoneId: string): Promise<ShippingMethod[]> {
		return [...this.#methods.values()].filter((m) => m.zoneId === zoneId).map((m) => ({ ...m }));
	}

	async getMethod(methodId: string): Promise<ShippingMethod | null> {
		const m = this.#methods.get(methodId);
		return m === undefined ? null : { ...m };
	}

	/** LWW edit of a method's structural fields (port doc). */
	async updateMethod(
		methodId: string,
		input: UpdateShippingMethodInput,
	): Promise<UpdateShippingMethodResult> {
		const method = this.#methods.get(methodId);
		if (method === undefined) return { ok: false, reason: "not_found" };
		method.name = input.name;
		method.type = input.type;
		if (input.taxable !== undefined) method.taxable = input.taxable;
		return { ok: true, method: { ...method } };
	}

	/** Forbid-if-children: a method with ≥1 rate cannot be deleted (port doc). */
	async deleteMethod(methodId: string): Promise<DeleteShippingMethodResult> {
		if (!this.#methods.has(methodId)) return { ok: false, reason: "not_found" };
		for (const r of this.#rates.values()) {
			if (r.methodId === methodId) return { ok: false, reason: "in_use_by_rates" };
		}
		this.#methods.delete(methodId);
		return { ok: true };
	}

	async createRate(input: CreateShippingRateInput): Promise<ShippingRate> {
		const rate: ShippingRate = {
			methodId: input.methodId,
			currency: input.currency,
			amountCents: input.amountCents,
			minSubtotalCents: input.minSubtotalCents,
		};
		this.#rates.set(key(input.methodId, input.currency), rate);
		return { ...rate };
	}

	async getRate(methodId: string, currency: Currency): Promise<ShippingRate | null> {
		const r = this.#rates.get(key(methodId, currency));
		return r === undefined ? null : { ...r };
	}

	/** Optimistic CAS on `amountCents` (port doc): not_found → stale → apply. */
	async updateRate(
		methodId: string,
		currency: Currency,
		input: UpdateShippingRateInput,
		expectedAmountCents: Cents,
	): Promise<UpdateShippingRateResult> {
		const rate = this.#rates.get(key(methodId, currency));
		if (rate === undefined) return { ok: false, reason: "not_found" };
		if (rate.amountCents !== expectedAmountCents) {
			return { ok: false, reason: "stale", current: { ...rate } };
		}
		rate.amountCents = input.amountCents;
		rate.minSubtotalCents = input.minSubtotalCents;
		return { ok: true, rate: { ...rate } };
	}

	/** Leaf delete — idempotent no-op for an unknown (methodId, currency). */
	async deleteRate(methodId: string, currency: Currency): Promise<DeleteShippingRateResult> {
		const k = key(methodId, currency);
		if (!this.#rates.has(k)) return { ok: false, reason: "not_found" };
		this.#rates.delete(k);
		return { ok: true };
	}
}

function key(methodId: string, currency: string): string {
	return `${methodId} ${currency}`;
}
