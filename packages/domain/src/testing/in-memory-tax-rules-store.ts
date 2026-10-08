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
import {
	appliedTaxRate,
	TaxRateDuplicateError,
	taxRateSlotOccupant,
} from "../pricing/tax-rate-uniqueness.js";

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

	/**
	 * A rate id is unique store-wide, and a (class, zone) holds one rate — checked
	 * in that order, as the emdash adapter does (id claim, then slot). Single-
	 * threaded, so both checks ARE atomic here.
	 */
	async createRate(input: CreateTaxRateInput): Promise<TaxRate> {
		const taken = this.#rates.get(input.id);
		if (taken !== undefined) {
			// The emdash adapter's `TaxRateIdCollisionError`, by its structural code.
			throw Object.assign(
				new Error(`tax rate id ${input.id} is already held by class ${taken.taxClassId}`),
				{ code: "TAX_RATE_ID_COLLISION", rateId: input.id, heldBy: taken.taxClassId },
			);
		}
		const existing = taxRateSlotOccupant([...this.#rates.values()], input);
		if (existing !== null) throw new TaxRateDuplicateError(existing);
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
		const applied = appliedTaxRate([...this.#rates.values()], taxClassId, zoneId);
		return applied === null ? null : { ...applied };
	}

	async listRatesForZone(zoneId: string): Promise<TaxRate[]> {
		return [...this.#rates.values()].filter((r) => r.zoneId === zoneId).map((r) => ({ ...r }));
	}

	async hasAnyRate(): Promise<boolean> {
		return this.#rates.size > 0;
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

	/**
	 * TEST SEAM: store a rate WITHOUT the one-per-slot check — the shape of data
	 * written before the rule existed, which the contract's legacy-duplicate cases
	 * need on every adapter.
	 */
	seedUncheckedRate(rate: TaxRate): void {
		this.#rates.set(rate.id, { ...rate });
	}

	/** Leaf delete — idempotent no-op for an unknown id. */
	async deleteRate(id: string): Promise<DeleteTaxRateResult> {
		if (!this.#rates.has(id)) return { ok: false, reason: "not_found" };
		this.#rates.delete(id);
		return { ok: true };
	}
}
