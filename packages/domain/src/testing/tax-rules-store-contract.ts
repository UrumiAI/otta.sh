import { describe, expect, test } from "vitest";
import type { TaxRulesStore } from "../ports/tax-rules-store.js";

async function seedRate(store: TaxRulesStore): Promise<void> {
	await store.createRate({
		id: "r1",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 725,
		appliesToShipping: false,
	});
}

export interface TaxRulesStoreHarness {
	store: TaxRulesStore;
}

export interface TaxRulesStoreContractOptions {
	dialect: string;
}

/** Behavioral spec for every `TaxRulesStore` adapter (Phase 6 §6). */
export function taxRulesStoreContract(
	makeStore: () => Promise<TaxRulesStoreHarness>,
	opts: TaxRulesStoreContractOptions,
): void {
	describe(`taxRulesStoreContract [${opts.dialect}]`, () => {
		test("create + list tax classes", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createClass({ id: "zero", name: "Zero-rated" });
			const classes = await store.listClasses();
			expect(classes.map((c) => c.id).toSorted()).toEqual(["standard", "zero"]);
		});

		test("deleteClass removes an unreferenced class", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "temp", name: "Temp" });
			const res = await store.deleteClass("temp");
			expect(res.ok).toBe(true);
			expect((await store.listClasses()).map((c) => c.id)).not.toContain("temp");
		});

		test("deleteClass is not_found for an unknown id", async () => {
			const { store } = await makeStore();
			const res = await store.deleteClass("nope");
			expect(res).toEqual({ ok: false, reason: "not_found" });
		});

		test("deleteClass refuses a class still referenced by a rate (in_use_by_rates)", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});
			const res = await store.deleteClass("standard");
			expect(res).toEqual({ ok: false, reason: "in_use_by_rates" });
			// The class is untouched.
			expect((await store.listClasses()).map((c) => c.id)).toContain("standard");
		});

		test("getRate returns the (class, zone) rate in integer bps, null otherwise", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});
			const rate = await store.getRate("standard", "z-us");
			expect(rate?.rateBps).toBe(725);
			expect(rate?.appliesToShipping).toBe(false);
			expect(await store.getRate("standard", "z-eu")).toBeNull();
			expect(await store.getRate("reduced", "z-us")).toBeNull();
		});

		test("listRatesForZone returns every class's rate and marks the shipping-tax class", async () => {
			const { store } = await makeStore();
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 1000,
				appliesToShipping: true,
			});
			await store.createRate({
				id: "r2",
				taxClassId: "zero",
				zoneId: "z-us",
				rateBps: 0,
				appliesToShipping: false,
			});
			await store.createRate({
				id: "r3",
				taxClassId: "standard",
				zoneId: "z-eu",
				rateBps: 2000,
				appliesToShipping: false,
			});
			const rates = await store.listRatesForZone("z-us");
			expect(rates.map((r) => r.taxClassId).toSorted()).toEqual(["standard", "zero"]);
			const shippingClass = rates.find((r) => r.appliesToShipping);
			expect(shippingClass?.taxClassId).toBe("standard");
		});

		// -- updateRate: optimistic CAS on the money-bearing rate_bps -------------

		test("updateRate applies a new rate + flag when the CAS matches", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			const res = await store.updateRate("r1", { rateBps: 825, appliesToShipping: true }, 725);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.rate.rateBps).toBe(825);
			expect(res.rate.appliesToShipping).toBe(true);
			expect((await store.getRate("standard", "z-us"))?.rateBps).toBe(825);
		});

		test("updateRate is not_found for an unknown id (an edit never mints a row)", async () => {
			const { store } = await makeStore();
			const res = await store.updateRate("nope", { rateBps: 100, appliesToShipping: false }, 0);
			expect(res).toEqual({ ok: false, reason: "not_found" });
		});

		test("updateRate is stale when rate_bps moved under a concurrent edit", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			// A first edit wins, moving rate_bps 725 → 900.
			const first = await store.updateRate("r1", { rateBps: 900, appliesToShipping: false }, 725);
			expect(first.ok).toBe(true);
			// A second editor still holding the stale 725 is refused, carrying the fresh row.
			const second = await store.updateRate("r1", { rateBps: 1000, appliesToShipping: false }, 725);
			expect(second.ok).toBe(false);
			if (second.ok) return;
			expect(second.reason).toBe("stale");
			if (second.reason !== "stale") return;
			expect(second.current.rateBps).toBe(900); // unchanged by the losing edit
		});

		test("updateRate replay: a blind retry with the same expected is stale, never double-applied", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			const first = await store.updateRate("r1", { rateBps: 800, appliesToShipping: false }, 725);
			expect(first.ok).toBe(true);
			const replay = await store.updateRate("r1", { rateBps: 800, appliesToShipping: false }, 725);
			expect(replay.ok).toBe(false); // once-only under replay
			expect((await store.getRate("standard", "z-us"))?.rateBps).toBe(800);
		});

		// -- deleteRate: leaf delete + snapshot/recompute invariant --------------

		test("deleteRate removes the rate; a subsequent read is null (recompute sees the deletion)", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			const res = await store.deleteRate("r1");
			expect(res).toEqual({ ok: true });
			// The checkout read the pure engine recomputes from now returns null ⇒
			// computeTotals treats the class as 0 bps (never a retroactive rewrite).
			expect(await store.getRate("standard", "z-us")).toBeNull();
			expect(await store.listRatesForZone("z-us")).toHaveLength(0);
		});

		test("deleteRate is an idempotent not_found no-op for unknown/already-deleted", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			expect(await store.deleteRate("r1")).toEqual({ ok: true });
			expect(await store.deleteRate("r1")).toEqual({ ok: false, reason: "not_found" });
			expect(await store.deleteRate("never")).toEqual({ ok: false, reason: "not_found" });
		});
	});
}
