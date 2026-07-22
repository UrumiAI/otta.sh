import type {
	CreateTaxClassInput,
	CreateTaxRateInput,
	DeleteTaxClassStoreResult,
	TaxClass,
	TaxRate,
	TaxRulesStore,
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
}
