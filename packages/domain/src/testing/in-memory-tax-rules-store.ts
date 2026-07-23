import type {
	CreateTaxClassInput,
	CreateTaxRateInput,
	DeleteTaxClassStoreResult,
	DeleteTaxRateResult,
	TaxClass,
	TaxRate,
	TaxRulesStore,
	UpdateTaxClassInput,
	UpdateTaxClassResult,
	UpdateTaxRateInput,
	UpdateTaxRateResult,
} from "../ports/tax-rules-store.js";

/** IO-free `TaxRulesStore` fake — the first adapter to pass the contract. */
export class InMemoryTaxRulesStore implements TaxRulesStore {
	#classes = new Map<string, TaxClass>();
	#rates = new Map<string, TaxRate>();

	async createClass(input: CreateTaxClassInput): Promise<TaxClass> {
		const cls: TaxClass = { id: input.id, name: input.name };
		this.#classes.set(cls.id, cls);
		return { ...cls };
	}

	async listClasses(): Promise<TaxClass[]> {
		return [...this.#classes.values()].map((c) => ({ ...c }));
	}

	/** Delete-in-use guard at the store's own grain (port doc): a class still
	 *  referenced by any rate cannot be deleted; an unknown id is not_found. */
	async deleteClass(id: string): Promise<DeleteTaxClassStoreResult> {
		if (!this.#classes.has(id)) return { ok: false, reason: "not_found" };
		for (const r of this.#rates.values()) {
			if (r.taxClassId === id) return { ok: false, reason: "in_use_by_rates" };
		}
		this.#classes.delete(id);
		return { ok: true };
	}

	/** LWW rename (port doc): unknown id → not_found; otherwise sets `name`. */
	async updateClass(id: string, input: UpdateTaxClassInput): Promise<UpdateTaxClassResult> {
		const cls = this.#classes.get(id);
		if (cls === undefined) return { ok: false, reason: "not_found" };
		cls.name = input.name;
		return { ok: true, class: { ...cls } };
	}

	/** Count of rates referencing a class (port doc) — the in-use-by-rates
	 *  refusal's honest count. */
	async countRatesByClass(id: string): Promise<number> {
		let count = 0;
		for (const r of this.#rates.values()) {
			if (r.taxClassId === id) count++;
		}
		return count;
	}

	async createRate(input: CreateTaxRateInput): Promise<TaxRate> {
		const rate: TaxRate = {
			id: input.id,
			taxClassId: input.taxClassId,
			zoneId: input.zoneId,
			rateBps: input.rateBps,
			appliesToShipping: input.appliesToShipping,
		};
		this.#rates.set(rate.id, rate);
		return { ...rate };
	}

	async getRate(taxClassId: string, zoneId: string): Promise<TaxRate | null> {
		for (const r of this.#rates.values()) {
			if (r.taxClassId === taxClassId && r.zoneId === zoneId) return { ...r };
		}
		return null;
	}

	async listRatesForZone(zoneId: string): Promise<TaxRate[]> {
		return [...this.#rates.values()].filter((r) => r.zoneId === zoneId).map((r) => ({ ...r }));
	}

	/** Optimistic CAS on `rateBps` (port doc): not_found → stale → apply. */
	async updateRate(
		id: string,
		input: UpdateTaxRateInput,
		expectedRateBps: number,
	): Promise<UpdateTaxRateResult> {
		const rate = this.#rates.get(id);
		if (rate === undefined) return { ok: false, reason: "not_found" };
		if (rate.rateBps !== expectedRateBps) {
			return { ok: false, reason: "stale", current: { ...rate } };
		}
		rate.rateBps = input.rateBps;
		rate.appliesToShipping = input.appliesToShipping;
		return { ok: true, rate: { ...rate } };
	}

	/** Leaf delete — idempotent no-op for an unknown id. */
	async deleteRate(id: string): Promise<DeleteTaxRateResult> {
		if (!this.#rates.has(id)) return { ok: false, reason: "not_found" };
		this.#rates.delete(id);
		return { ok: true };
	}
}
