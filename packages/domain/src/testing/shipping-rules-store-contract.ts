import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import type { ShippingRulesStore } from "../ports/shipping-rules-store.js";

export interface ShippingRulesStoreHarness {
	store: ShippingRulesStore;
}

export interface ShippingRulesStoreContractOptions {
	dialect: string;
}

const USD = currency("USD");
const EUR = currency("EUR");

/** Behavioral spec for every `ShippingRulesStore` adapter (Phase 6 §6). */
export function shippingRulesStoreContract(
	makeStore: () => Promise<ShippingRulesStoreHarness>,
	opts: ShippingRulesStoreContractOptions,
): void {
	describe(`shippingRulesStoreContract [${opts.dialect}]`, () => {
		test("create + list + get zones", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: ["US"] });
			await store.createZone({ id: "z-eu", name: "EU", regions: ["FR", "DE"] });
			const zones = await store.listZones();
			expect(zones.map((z) => z.id).toSorted()).toEqual(["z-eu", "z-us"]);
			expect((await store.getZone("z-us"))?.name).toBe("US");
			expect(await store.getZone("missing")).toBeNull();
		});

		test("create + list methods scoped to a zone", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createZone({ id: "z-eu", name: "EU", regions: null });
			await store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
			await store.createMethod({
				id: "m-free",
				zoneId: "z-us",
				name: "Free",
				type: "free_shipping",
			});
			await store.createMethod({ id: "m-eu", zoneId: "z-eu", name: "EU", type: "flat_rate" });
			const methods = await store.listMethods("z-us");
			expect(methods.map((m) => m.id).toSorted()).toEqual(["m-flat", "m-free"]);
			expect((await store.getMethod("m-free"))?.type).toBe("free_shipping");
		});

		test("getRate returns the rate for a method+currency, null otherwise", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
			await store.createRate({
				methodId: "m-flat",
				currency: USD,
				amountCents: cents(599),
				minSubtotalCents: null,
			});
			const rate = await store.getRate("m-flat", USD);
			expect(rate?.amountCents).toBe(599);
			expect(rate?.minSubtotalCents).toBeNull();
			expect(await store.getRate("m-flat", EUR)).toBeNull();
			expect(await store.getRate("missing", USD)).toBeNull();
		});

		test("free_shipping rate carries a nullable min-subtotal threshold", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createMethod({
				id: "m-free",
				zoneId: "z-us",
				name: "Free",
				type: "free_shipping",
			});
			await store.createRate({
				methodId: "m-free",
				currency: USD,
				amountCents: cents(0),
				minSubtotalCents: cents(50_00),
			});
			expect((await store.getRate("m-free", USD))?.minSubtotalCents).toBe(50_00);
		});

		// -- zone: LWW update + forbid-if-methods delete -------------------------

		async function seedZoneMethodRate(store: ShippingRulesStore): Promise<void> {
			await store.createZone({ id: "z-us", name: "US", regions: ["US"] });
			await store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
			await store.createRate({
				methodId: "m-flat",
				currency: USD,
				amountCents: cents(599),
				minSubtotalCents: null,
			});
		}

		test("updateZone edits name + regions (last-writer-wins); unknown id is not_found", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: ["US"] });
			const res = await store.updateZone("z-us", { name: "United States", regions: ["US", "PR"] });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.zone.name).toBe("United States");
			expect(res.zone.regions).toEqual(["US", "PR"]);
			expect((await store.getZone("z-us"))?.name).toBe("United States");
			expect(await store.updateZone("missing", { name: "X", regions: null })).toEqual({
				ok: false,
				reason: "not_found",
			});
		});

		test("deleteZone is forbidden while a method still references it (in_use_by_methods)", async () => {
			const { store } = await makeStore();
			await seedZoneMethodRate(store);
			expect(await store.deleteZone("z-us")).toEqual({ ok: false, reason: "in_use_by_methods" });
			expect(await store.getZone("z-us")).not.toBeNull(); // untouched
		});

		test("deleteZone succeeds once childless; is an idempotent not_found no-op after", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-empty", name: "Empty", regions: null });
			expect(await store.deleteZone("z-empty")).toEqual({ ok: true });
			expect(await store.deleteZone("z-empty")).toEqual({ ok: false, reason: "not_found" });
			expect(await store.deleteZone("never")).toEqual({ ok: false, reason: "not_found" });
		});

		// -- method: LWW update + forbid-if-rates delete -------------------------

		test("updateMethod edits name + type (LWW); unknown id is not_found", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
			const res = await store.updateMethod("m-flat", { name: "Standard", type: "free_shipping" });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.method.name).toBe("Standard");
			expect(res.method.type).toBe("free_shipping");
			expect((await store.getMethod("m-flat"))?.zoneId).toBe("z-us"); // zone identity untouched
			expect(await store.updateMethod("missing", { name: "X", type: "flat_rate" })).toEqual({
				ok: false,
				reason: "not_found",
			});
		});

		test("deleteMethod is forbidden while a rate still references it (in_use_by_rates)", async () => {
			const { store } = await makeStore();
			await seedZoneMethodRate(store);
			expect(await store.deleteMethod("m-flat")).toEqual({ ok: false, reason: "in_use_by_rates" });
			expect(await store.getMethod("m-flat")).not.toBeNull();
		});

		test("deleteMethod succeeds once rate-free; idempotent not_found no-op after", async () => {
			const { store } = await makeStore();
			await store.createZone({ id: "z-us", name: "US", regions: null });
			await store.createMethod({ id: "m-x", zoneId: "z-us", name: "X", type: "flat_rate" });
			expect(await store.deleteMethod("m-x")).toEqual({ ok: true });
			expect(await store.deleteMethod("m-x")).toEqual({ ok: false, reason: "not_found" });
		});

		// -- rate: CAS on amount_cents + leaf delete -----------------------------

		test("updateRate applies a new amount + threshold when the CAS matches", async () => {
			const { store } = await makeStore();
			await seedZoneMethodRate(store);
			const res = await store.updateRate(
				"m-flat",
				USD,
				{ amountCents: cents(699), minSubtotalCents: cents(75_00) },
				cents(599),
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.rate.amountCents).toBe(699);
			expect(res.rate.minSubtotalCents).toBe(75_00);
			expect((await store.getRate("m-flat", USD))?.amountCents).toBe(699);
		});

		test("updateRate is not_found for an unknown (method, currency)", async () => {
			const { store } = await makeStore();
			await seedZoneMethodRate(store);
			expect(
				await store.updateRate(
					"m-flat",
					EUR,
					{ amountCents: cents(10), minSubtotalCents: null },
					cents(0),
				),
			).toEqual({ ok: false, reason: "not_found" });
		});

		test("updateRate is stale when amount_cents moved (and replay is once-only)", async () => {
			const { store } = await makeStore();
			await seedZoneMethodRate(store);
			const first = await store.updateRate(
				"m-flat",
				USD,
				{ amountCents: cents(650), minSubtotalCents: null },
				cents(599),
			);
			expect(first.ok).toBe(true);
			const stale = await store.updateRate(
				"m-flat",
				USD,
				{ amountCents: cents(700), minSubtotalCents: null },
				cents(599), // still holding the pre-edit price
			);
			expect(stale.ok).toBe(false);
			if (stale.ok || stale.reason !== "stale") return;
			expect(stale.current.amountCents).toBe(650);
		});

		test("deleteRate removes the leaf; a subsequent read is null (recompute sees it)", async () => {
			const { store } = await makeStore();
			await seedZoneMethodRate(store);
			expect(await store.deleteRate("m-flat", USD)).toEqual({ ok: true });
			expect(await store.getRate("m-flat", USD)).toBeNull();
			// Idempotent replay.
			expect(await store.deleteRate("m-flat", USD)).toEqual({ ok: false, reason: "not_found" });
		});
	});
}
