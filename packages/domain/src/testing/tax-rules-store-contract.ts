import { describe, expect, test } from "vitest";
import type { TaxRate, TaxRulesStore } from "../ports/tax-rules-store.js";

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
	/**
	 * Store a rate WITHOUT the one-per-(class, zone) check — the duplicates a store
	 * may still hold from before the rule. Only the legacy-duplicate cases use it.
	 */
	seedUncheckedRate(rate: TaxRate): Promise<void>;
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
		test("hasAnyRate: false on an empty store, true once any rate exists, false after the last is deleted", async () => {
			const { store } = await makeStore();
			expect(await store.hasAnyRate()).toBe(false);
			await store.createClass({ id: "standard", name: "Standard" });
			expect(await store.hasAnyRate()).toBe(false);
			await seedRate(store);
			expect(await store.hasAnyRate()).toBe(true);
			await store.deleteRate("r1");
			expect(await store.hasAnyRate()).toBe(false);
		});

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

		// -- updateClass: LWW rename, id stays the referent rates/products use ---

		test("updateClass renames a class (LWW); unknown id is not_found", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			const res = await store.updateClass("standard", { name: "Standard rate" });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.class).toEqual({ id: "standard", name: "Standard rate" });
			expect((await store.listClasses()).find((c) => c.id === "standard")?.name).toBe(
				"Standard rate",
			);
			expect(await store.updateClass("missing", { name: "X" })).toEqual({
				ok: false,
				reason: "not_found",
			});
		});

		test("updateClass is idempotent under replay (set-value, not a delta)", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			const first = await store.updateClass("standard", { name: "Renamed" });
			const replay = await store.updateClass("standard", { name: "Renamed" });
			expect(first.ok && replay.ok).toBe(true);
			if (!first.ok || !replay.ok) return;
			expect(replay.class).toEqual(first.class); // no drift on re-apply
		});

		test("a rename never orphans a rate — the class id is the referent, not the name", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});
			const res = await store.updateClass("standard", { name: "Renamed" });
			expect(res.ok).toBe(true);
			// The rate still resolves by id — a rename touches only the name column.
			expect((await store.getRate("standard", "z-us"))?.rateBps).toBe(725);
			expect((await store.listRatesForZone("z-us"))[0]?.taxClassId).toBe("standard");
		});

		// -- countRatesByClass: the delete-in-use honest count -------------------

		test("countRatesByClass counts every rate referencing the class, 0 otherwise", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await store.createRate({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});
			await store.createRate({
				id: "r2",
				taxClassId: "standard",
				zoneId: "z-eu",
				rateBps: 2000,
				appliesToShipping: false,
			});
			await store.createRate({
				id: "r3",
				taxClassId: "zero",
				zoneId: "z-us",
				rateBps: 0,
				appliesToShipping: false,
			});
			expect(await store.countRatesByClass("standard")).toBe(2);
			expect(await store.countRatesByClass("zero")).toBe(1);
			expect(await store.countRatesByClass("missing")).toBe(0);
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

		// -- one rate per (class, zone) ----------------------------------------------

		test("createRate refuses a second rate for the same (class, zone), naming the existing one", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await seedRate(store);
			const err = await store
				.createRate({
					id: "r2",
					taxClassId: "standard",
					zoneId: "z-us",
					rateBps: 900,
					appliesToShipping: true,
				})
				.then(
					() => null,
					(e: unknown) => e,
				);
			expect(err).toMatchObject({
				code: "TAX_RATE_DUPLICATE",
				taxClassId: "standard",
				zoneId: "z-us",
				existingRateId: "r1",
				existingRateBps: 725,
			});
			// Nothing was written: the existing rate is untouched and alone in its slot.
			expect(await store.getRate("standard", "z-us")).toEqual({
				id: "r1",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 725,
				appliesToShipping: false,
			});
			expect((await store.listRatesForZone("z-us")).map((r) => r.id)).toEqual(["r1"]);
			expect(await store.countRatesByClass("standard")).toBe(1);
			// The refused id was never kept: it is free for a rate in another slot.
			const elsewhere = await store.createRate({
				id: "r2",
				taxClassId: "standard",
				zoneId: "z-eu",
				rateBps: 2000,
				appliesToShipping: false,
			});
			expect(elsewhere.zoneId).toBe("z-eu");
			expect(
				await store.updateRate("r2", { rateBps: 1900, appliesToShipping: false }, 2000),
			).toMatchObject({ ok: true });
		});

		test("a rate id is unique store-wide: a create reusing a live id is refused, in any slot", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			for (const slot of [
				{ taxClassId: "standard", zoneId: "z-us" },
				{ taxClassId: "standard", zoneId: "z-eu" },
				{ taxClassId: "reduced", zoneId: "z-us" },
			]) {
				await expect(
					store.createRate({ id: "r1", ...slot, rateBps: 900, appliesToShipping: false }),
				).rejects.toMatchObject({ code: "TAX_RATE_ID_COLLISION" });
			}
			// Nothing moved: r1 is where it was, unchanged and alone.
			expect(await store.getRate("standard", "z-us")).toMatchObject({ id: "r1", rateBps: 725 });
			expect(await store.listRatesForZone("z-eu")).toEqual([]);
		});

		test("the same class in another zone, or another class in the same zone, is not a duplicate", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			await store.createRate({
				id: "r2",
				taxClassId: "standard",
				zoneId: "z-eu",
				rateBps: 2000,
				appliesToShipping: false,
			});
			await store.createRate({
				id: "r3",
				taxClassId: "reduced",
				zoneId: "z-us",
				rateBps: 500,
				appliesToShipping: false,
			});
			expect((await store.listRatesForZone("z-us")).map((r) => r.id).toSorted()).toEqual([
				"r1",
				"r3",
			]);
		});

		test("once the slot's rate is deleted, a new rate for that slot can be created", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			expect(await store.deleteRate("r1")).toEqual({ ok: true });
			await store.createRate({
				id: "r2",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 800,
				appliesToShipping: false,
			});
			expect((await store.getRate("standard", "z-us"))?.id).toBe("r2");
		});

		test("concurrent creates for one (class, zone): exactly one succeeds, the rest are duplicates", async () => {
			const { store } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			const crowd = 8;
			const settled = await Promise.allSettled(
				Array.from({ length: crowd }, (_unused, i) =>
					store.createRate({
						id: `race-${String(i)}`,
						taxClassId: "standard",
						zoneId: "z-us",
						rateBps: 700 + i,
						appliesToShipping: false,
					}),
				),
			);
			const won = settled.filter((r) => r.status === "fulfilled");
			expect(won).toHaveLength(1);
			for (const lost of settled.filter((r) => r.status === "rejected")) {
				expect(lost.reason).toMatchObject({ code: "TAX_RATE_DUPLICATE" });
			}
			const listed = await store.listRatesForZone("z-us");
			expect(listed).toHaveLength(1);
			expect(listed[0]?.id).toBe(won[0]?.status === "fulfilled" ? won[0].value.id : undefined);
			expect(await store.countRatesByClass("standard")).toBe(1);
		});

		test("updateRate keeps a rate in its slot, so an edit never makes a duplicate", async () => {
			const { store } = await makeStore();
			await seedRate(store);
			await store.createRate({
				id: "r2",
				taxClassId: "standard",
				zoneId: "z-eu",
				rateBps: 2000,
				appliesToShipping: false,
			});
			const res = await store.updateRate("r2", { rateBps: 725, appliesToShipping: true }, 2000);
			expect(res.ok && { classId: res.rate.taxClassId, zoneId: res.rate.zoneId }).toEqual({
				classId: "standard",
				zoneId: "z-eu",
			});
			expect((await store.listRatesForZone("z-us")).map((r) => r.id)).toEqual(["r1"]);
		});

		// -- duplicates stored before the rule: kept, resolved, editable, deletable ---

		test("legacy duplicates: the greatest id applies; both are listed; neither is deleted", async () => {
			const { store, seedUncheckedRate } = await makeStore();
			await store.createClass({ id: "standard", name: "Standard" });
			await seedUncheckedRate({
				id: "dup-b",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 900,
				appliesToShipping: false,
			});
			await seedUncheckedRate({
				id: "dup-a",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 700,
				appliesToShipping: true,
			});
			expect((await store.getRate("standard", "z-us"))?.id).toBe("dup-b");
			expect((await store.listRatesForZone("z-us")).map((r) => r.id).toSorted()).toEqual([
				"dup-a",
				"dup-b",
			]);
			expect(await store.countRatesByClass("standard")).toBe(2);
			// A third create into the slot is refused, naming the rate that applies.
			await expect(
				store.createRate({
					id: "dup-c",
					taxClassId: "standard",
					zoneId: "z-us",
					rateBps: 100,
					appliesToShipping: false,
				}),
			).rejects.toMatchObject({ code: "TAX_RATE_DUPLICATE", existingRateId: "dup-b" });
		});

		test("legacy duplicates stay editable and deletable — the merchant is never trapped", async () => {
			const { store, seedUncheckedRate } = await makeStore();
			await seedUncheckedRate({
				id: "dup-a",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 700,
				appliesToShipping: false,
			});
			await seedUncheckedRate({
				id: "dup-b",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 900,
				appliesToShipping: false,
			});
			// Either one can be edited (the ignored one too) …
			expect(
				await store.updateRate("dup-a", { rateBps: 750, appliesToShipping: false }, 700),
			).toMatchObject({ ok: true });
			expect(
				await store.updateRate("dup-b", { rateBps: 950, appliesToShipping: false }, 900),
			).toMatchObject({ ok: true });
			// … and deleting the one that applies hands the slot to the survivor.
			expect(await store.deleteRate("dup-b")).toEqual({ ok: true });
			expect(await store.getRate("standard", "z-us")).toMatchObject({ id: "dup-a", rateBps: 750 });
			expect((await store.listRatesForZone("z-us")).map((r) => r.id)).toEqual(["dup-a"]);
		});
	});
}
