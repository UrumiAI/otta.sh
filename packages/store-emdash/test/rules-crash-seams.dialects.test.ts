/**
 * The crash seams of the two rules adapters, opened on REAL storage with
 * `test/helpers/fault-injection.ts`.
 *
 * Both stores have exactly one multi-document step, and it is the same step twice:
 * a child id is CLAIMED store-wide before the child is embedded in its parent, and
 * the claim is RELEASED after the child is removed. Everything else — every zone,
 * method, rate, class and tax-rate write — is a single-document compare-and-set,
 * so there is no other window to open.
 *
 * Two kinds of case live here:
 *
 * - **The claim seams.** A crash in either window leaves an ORPHANED claim: an id
 *   that is held but whose parent does not hold the child. The rule is that an
 *   orphan misleads no reader (every id-taking method answers exactly as it would
 *   for an id that was never created) and strands no id (the next create of that
 *   id takes the claim over). Each case reads the documents back before replaying,
 *   so the state being healed is the state the store really leaves behind.
 * - **The retry-then-re-verify rule.** A money compare-and-set that loses its
 *   revision must RE-READ and RE-COMPARE the expected value, not re-submit its
 *   decision. `test/rules-cas-race.pg.test.ts` drives that with a crowd; here it is
 *   pinned deterministically, on every dialect, by parking the losing write while a
 *   peer commits the change the loser should see.
 */
import { cents, currency } from "@otta-sh/domain";
import { expect, test } from "vitest";
import { normalizeZoneDoc, type StorageAccess } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	isUpdateWrite,
	onId,
	parkCall,
	settleOne,
	withCollection,
	type CallMatcher,
} from "./helpers/fault-injection.js";
import { SHIPPING_RULES_LAYOUT, TAX_RULES_LAYOUT } from "./rules-collections.js";
import { makeShippingRulesHarness, makeTaxRulesHarness } from "./rules-harness.js";

const USD = currency("USD");

/** The claim RELEASE — the second half of a delete's two-document step. */
const isRelease: CallMatcher = (call) => call.method === "compareAndDelete";

describeEachDialect("EmdashShippingRulesStore crash seams", (ctx) => {
	const bound = ctx.useStorage(SHIPPING_RULES_LAYOUT);

	test("(a) the method id was claimed, the zone embed never ran — the orphan heals", async () => {
		const raw = bound.storage;
		const plain = makeShippingRulesHarness(raw);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });

		// The claim lands; the write that would embed the method never happens.
		const crashed = failCall(raw["shipping_zones"] ?? never(), onId("z-us", isUpdateWrite), {
			mode: "instead",
		});
		const wounded = makeShippingRulesHarness(raw, {
			storageForStore: withCollection(raw, "shipping_zones", crashed.collection),
		});
		const err = await settleOne(
			wounded.store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" }),
		);
		expect(err).toBeInstanceOf(InjectedCrashError);

		// The state the store really left behind: a claim with no method.
		expect(await plain.methodOwners.get("m-flat")).not.toBeNull();
		expect(normalizeZoneDoc((await plain.zones.get("z-us")) ?? never()).methods).toEqual({});

		// No reader is misled by it.
		expect(await plain.store.getMethod("m-flat")).toBeNull();
		expect(await plain.store.listMethods("z-us")).toEqual([]);
		expect(await plain.store.updateMethod("m-flat", { name: "X", type: "flat_rate" })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await plain.store.deleteMethod("m-flat")).toEqual({ ok: false, reason: "not_found" });
		// And the zone is childless, so it is still deletable — the orphan claim does
		// not forbid what no method forbids.
		expect(await plain.store.getRate("m-flat", USD)).toBeNull();

		// The replay completes it exactly once.
		const method = await plain.store.createMethod({
			id: "m-flat",
			zoneId: "z-us",
			name: "Flat",
			type: "flat_rate",
		});
		expect(method.zoneId).toBe("z-us");
		expect((await plain.store.listMethods("z-us")).map((m) => m.id)).toEqual(["m-flat"]);
	});

	test("(b) an orphaned claim is taken over by a create in ANOTHER zone", async () => {
		const raw = bound.storage;
		const plain = makeShippingRulesHarness(raw);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });
		await plain.store.createZone({ id: "z-eu", name: "EU", regions: null });

		const crashed = failCall(raw["shipping_zones"] ?? never(), onId("z-us", isUpdateWrite), {
			mode: "instead",
		});
		const wounded = makeShippingRulesHarness(raw, {
			storageForStore: withCollection(raw, "shipping_zones", crashed.collection),
		});
		await settleOne(
			wounded.store.createMethod({ id: "m-x", zoneId: "z-us", name: "X", type: "flat_rate" }),
		);
		expect((await plain.methodOwners.get("m-x"))?.zoneId).toBe("z-us");

		const method = await plain.store.createMethod({
			id: "m-x",
			zoneId: "z-eu",
			name: "X",
			type: "flat_rate",
		});
		expect(method.zoneId).toBe("z-eu");
		expect((await plain.methodOwners.get("m-x"))?.zoneId).toBe("z-eu");
		expect((await plain.store.getMethod("m-x"))?.zoneId).toBe("z-eu");
		expect(await plain.store.listMethods("z-us")).toEqual([]);
	});

	test("(c) a LIVE method's id is never taken over — the collision is loud", async () => {
		const plain = makeShippingRulesHarness(bound.storage);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });
		await plain.store.createZone({ id: "z-eu", name: "EU", regions: null });
		await plain.store.createMethod({ id: "m-x", zoneId: "z-us", name: "X", type: "flat_rate" });

		const err = await settleOne(
			plain.store.createMethod({ id: "m-x", zoneId: "z-eu", name: "X", type: "flat_rate" }),
		);
		expect((err as { code?: unknown }).code).toBe("SHIPPING_METHOD_ID_COLLISION");
		expect((await plain.store.getMethod("m-x"))?.zoneId).toBe("z-us");
		expect(await plain.store.listMethods("z-eu")).toEqual([]);
	});

	test("(d) the method was removed, its claim was never released — the orphan heals", async () => {
		const raw = bound.storage;
		const plain = makeShippingRulesHarness(raw);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });
		await plain.store.createMethod({ id: "m-x", zoneId: "z-us", name: "X", type: "flat_rate" });

		// The removal lands; the release never runs.
		const crashed = failCall(raw["shipping_method_owners"] ?? never(), isRelease, {
			mode: "instead",
		});
		const wounded = makeShippingRulesHarness(raw, {
			storageForStore: withCollection(raw, "shipping_method_owners", crashed.collection),
		});
		expect(await settleOne(wounded.store.deleteMethod("m-x"))).toBeInstanceOf(InjectedCrashError);

		expect(await plain.methodOwners.get("m-x")).not.toBeNull();
		expect(normalizeZoneDoc((await plain.zones.get("z-us")) ?? never()).methods).toEqual({});
		expect(await plain.store.getMethod("m-x")).toBeNull();
		expect(await plain.store.deleteMethod("m-x")).toEqual({ ok: false, reason: "not_found" });
		// The id is reusable, which is the point of taking an orphan over.
		const again = await plain.store.createMethod({
			id: "m-x",
			zoneId: "z-us",
			name: "X2",
			type: "flat_rate",
		});
		expect(again.name).toBe("X2");
	});

	test("(e) the claim lands BEFORE the embed — pinned from the other side", async () => {
		const raw = bound.storage;
		const plain = makeShippingRulesHarness(raw);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });

		// Park the embed. While it is parked the claim must ALREADY be there: an embed
		// that ran first would be a method no id-taking method could reach.
		const parked = parkCall(raw["shipping_zones"] ?? never(), onId("z-us", isUpdateWrite));
		const store = makeShippingRulesHarness(raw, {
			storageForStore: withCollection(raw, "shipping_zones", parked.collection),
		}).store;
		const inFlight = store.createMethod({
			id: "m-flat",
			zoneId: "z-us",
			name: "Flat",
			type: "flat_rate",
		});
		await parked.arrived;
		expect(await plain.methodOwners.get("m-flat")).not.toBeNull();
		expect(await plain.store.getMethod("m-flat")).toBeNull();
		parked.release();
		await inFlight;
		expect((await plain.store.getMethod("m-flat"))?.name).toBe("Flat");
	});

	test("(f) a money edit that LOSES its revision re-reads and is refused as stale", async () => {
		const raw = bound.storage;
		const plain = makeShippingRulesHarness(raw);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });
		await plain.store.createMethod({ id: "m-flat", zoneId: "z-us", name: "Flat", type: "flat_rate" });
		await plain.store.createRate({
			methodId: "m-flat",
			currency: USD,
			amountCents: cents(599),
			minSubtotalCents: null,
		});

		// A's write is held open at the revision it read; B then commits 599 → 650.
		const parked = parkCall(raw["shipping_zones"] ?? never(), onId("z-us", isUpdateWrite));
		const slow = makeShippingRulesHarness(raw, {
			storageForStore: withCollection(raw, "shipping_zones", parked.collection),
		}).store;
		const a = slow.updateRate(
			"m-flat",
			USD,
			{ amountCents: cents(900), minSubtotalCents: null },
			cents(599),
		);
		await parked.arrived;
		const b = await plain.store.updateRate(
			"m-flat",
			USD,
			{ amountCents: cents(650), minSubtotalCents: null },
			cents(599),
		);
		expect(b.ok).toBe(true);
		parked.release();

		// A's compare-and-set is refused, and its RETRY re-reads: the expected 599 is
		// gone, so A is stale and carries B's value. A store that re-submitted its
		// decision instead would persist 900 and lose B's edit.
		const result = await a;
		expect(result.ok).toBe(false);
		if (result.ok || result.reason !== "stale") throw new Error("expected stale");
		expect(result.current.amountCents).toBe(650);
		expect((await plain.store.getRate("m-flat", USD))?.amountCents).toBe(650);
	});

	test("(g) a zone delete racing a method create refuses rather than orphaning", async () => {
		const raw = bound.storage;
		const plain = makeShippingRulesHarness(raw);
		await plain.store.createZone({ id: "z-us", name: "US", regions: null });

		// The delete reads an empty zone, then its guarded delete is parked while the
		// method lands. The delete must lose and the retry must report the child.
		const parked = parkCall(raw["shipping_zones"] ?? never(), isRelease);
		const slow = makeShippingRulesHarness(raw, {
			storageForStore: withCollection(raw, "shipping_zones", parked.collection),
		}).store;
		const deleting = slow.deleteZone("z-us");
		await parked.arrived;
		await plain.store.createMethod({ id: "m-x", zoneId: "z-us", name: "X", type: "flat_rate" });
		parked.release();
		expect(await deleting).toEqual({ ok: false, reason: "in_use_by_methods" });
		expect(await plain.store.getZone("z-us")).not.toBeNull();
		expect((await plain.store.getMethod("m-x"))?.zoneId).toBe("z-us");
	});
});

describeEachDialect("EmdashTaxRulesStore crash seams", (ctx) => {
	const bound = ctx.useStorage(TAX_RULES_LAYOUT);

	test("(a) the rate id was claimed, the class embed never ran — the orphan heals", async () => {
		const raw = bound.storage;
		const plain = makeTaxRulesHarness(raw);
		await plain.store.createClass({ id: "standard", name: "Standard" });

		const crashed = failCall(raw["tax_classes"] ?? never(), onId("standard", isUpdateWrite), {
			mode: "instead",
		});
		const wounded = makeTaxRulesHarness(raw, {
			storageForStore: withCollection(raw, "tax_classes", crashed.collection),
		});
		expect(
			await settleOne(
				wounded.store.createRate({
					id: "r1",
					taxClassId: "standard",
					zoneId: "z-us",
					rateBps: 725,
					appliesToShipping: false,
				}),
			),
		).toBeInstanceOf(InjectedCrashError);

		expect(await plain.rateOwners.get("r1")).not.toBeNull();
		expect(await plain.store.getRate("standard", "z-us")).toBeNull();
		expect(await plain.store.countRatesByClass("standard")).toBe(0);
		expect(
			await plain.store.updateRate("r1", { rateBps: 1, appliesToShipping: false }, 725),
		).toEqual({ ok: false, reason: "not_found" });
		expect(await plain.store.deleteRate("r1")).toEqual({ ok: false, reason: "not_found" });
		// The class is childless, so it is still deletable.
		expect(await plain.store.deleteClass("standard")).toEqual({ ok: true });

		// And the id is reusable: the replay lands exactly one rate.
		await plain.store.createClass({ id: "standard", name: "Standard" });
		await plain.store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		expect(await plain.store.countRatesByClass("standard")).toBe(1);
	});

	test("(b) the rate was removed, its claim was never released — the orphan heals", async () => {
		const raw = bound.storage;
		const plain = makeTaxRulesHarness(raw);
		await plain.store.createClass({ id: "standard", name: "Standard" });
		await plain.store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});

		const crashed = failCall(raw["tax_rate_owners"] ?? never(), isRelease, { mode: "instead" });
		const wounded = makeTaxRulesHarness(raw, {
			storageForStore: withCollection(raw, "tax_rate_owners", crashed.collection),
		});
		expect(await settleOne(wounded.store.deleteRate("r1"))).toBeInstanceOf(InjectedCrashError);

		expect(await plain.rateOwners.get("r1")).not.toBeNull();
		expect(await plain.store.getRate("standard", "z-us")).toBeNull();
		expect(await plain.store.deleteRate("r1")).toEqual({ ok: false, reason: "not_found" });
		await plain.store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-eu",
			rateBps: 2000,
			appliesToShipping: false,
		});
		expect((await plain.store.getRate("standard", "z-eu"))?.rateBps).toBe(2000);
	});

	test("(c) a LIVE rate's id is never taken over — the collision is loud", async () => {
		const plain = makeTaxRulesHarness(bound.storage);
		await plain.store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		const err = await settleOne(
			plain.store.createRate({
				id: "r1",
				taxClassId: "zero",
				zoneId: "z-us",
				rateBps: 0,
				appliesToShipping: false,
			}),
		);
		expect((err as { code?: unknown }).code).toBe("TAX_RATE_ID_COLLISION");
		expect(await plain.store.countRatesByClass("zero")).toBe(0);
		expect(await plain.store.countRatesByClass("standard")).toBe(1);
	});

	test("(d) the claim lands BEFORE the embed — pinned from the other side", async () => {
		const raw = bound.storage;
		const plain = makeTaxRulesHarness(raw);
		await plain.store.createClass({ id: "standard", name: "Standard" });

		const parked = parkCall(raw["tax_classes"] ?? never(), onId("standard", isUpdateWrite));
		const store = makeTaxRulesHarness(raw, {
			storageForStore: withCollection(raw, "tax_classes", parked.collection),
		}).store;
		const inFlight = store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		await parked.arrived;
		expect(await plain.rateOwners.get("r1")).not.toBeNull();
		expect(await plain.store.getRate("standard", "z-us")).toBeNull();
		parked.release();
		await inFlight;
		expect((await plain.store.getRate("standard", "z-us"))?.rateBps).toBe(725);
	});

	test("(e) a money edit that LOSES its revision re-reads and is refused as stale", async () => {
		const raw = bound.storage;
		const plain = makeTaxRulesHarness(raw);
		await plain.store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});

		const parked = parkCall(raw["tax_classes"] ?? never(), onId("standard", isUpdateWrite));
		const slow = makeTaxRulesHarness(raw, {
			storageForStore: withCollection(raw, "tax_classes", parked.collection),
		}).store;
		const a = slow.updateRate("r1", { rateBps: 1000, appliesToShipping: false }, 725);
		await parked.arrived;
		expect((await plain.store.updateRate("r1", { rateBps: 900, appliesToShipping: false }, 725)).ok)
			.toBe(true);
		parked.release();

		const result = await a;
		expect(result.ok).toBe(false);
		if (result.ok || result.reason !== "stale") throw new Error("expected stale");
		expect(result.current.rateBps).toBe(900);
		expect((await plain.store.getRate("standard", "z-us"))?.rateBps).toBe(900);
	});

	test("(f) a class delete racing a rate create refuses rather than orphaning", async () => {
		const raw = bound.storage;
		const plain = makeTaxRulesHarness(raw);
		await plain.store.createClass({ id: "standard", name: "Standard" });

		const parked = parkCall(raw["tax_classes"] ?? never(), isRelease);
		const slow = makeTaxRulesHarness(raw, {
			storageForStore: withCollection(raw, "tax_classes", parked.collection),
		}).store;
		const deleting = slow.deleteClass("standard");
		await parked.arrived;
		await plain.store.createRate({
			id: "r1",
			taxClassId: "standard",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		parked.release();
		expect(await deleting).toEqual({ ok: false, reason: "in_use_by_rates" });
		expect((await plain.store.listClasses()).map((c) => c.id)).toContain("standard");
		expect(await plain.store.countRatesByClass("standard")).toBe(1);
	});

	test("(g) a rate whose class was never declared is reachable, and its document is not a class", async () => {
		const plain = makeTaxRulesHarness(bound.storage);
		await plain.store.createRate({
			id: "r1",
			taxClassId: "ghost",
			zoneId: "z-us",
			rateBps: 725,
			appliesToShipping: false,
		});
		// The SQL had no foreign key here, so this is parity, not leniency.
		expect((await plain.store.getRate("ghost", "z-us"))?.rateBps).toBe(725);
		expect(await plain.store.countRatesByClass("ghost")).toBe(1);
		expect(await plain.store.listClasses()).toEqual([]);
		expect(await plain.store.deleteClass("ghost")).toEqual({ ok: false, reason: "not_found" });
		expect(await plain.store.updateClass("ghost", { name: "Ghost" })).toEqual({
			ok: false,
			reason: "not_found",
		});
		// Declaring it afterwards adopts the document rather than colliding with it.
		expect(await plain.store.createClass({ id: "ghost", name: "Ghost" })).toEqual({
			id: "ghost",
			name: "Ghost",
		});
		expect((await plain.store.listClasses()).map((c) => c.id)).toEqual(["ghost"]);
		expect((await plain.store.getRate("ghost", "z-us"))?.rateBps).toBe(725);
		// And the last rate leaving an UNDECLARED class takes its document with it.
		await plain.store.createRate({
			id: "r2",
			taxClassId: "ghost2",
			zoneId: "z-us",
			rateBps: 100,
			appliesToShipping: false,
		});
		expect(await plain.store.deleteRate("r2")).toEqual({ ok: true });
		expect(await plain.classes.get("ghost2")).toBeNull();
	});
});

/** A collection the layout declares is always present; this is the type narrowing. */
function never(): never {
	throw new Error("the declared collection is missing from the bound storage");
}
