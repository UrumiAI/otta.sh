/**
 * The domain's `shippingRulesStoreContract` and `taxRulesStoreContract` against
 * `EmdashShippingRulesStore` / `EmdashTaxRulesStore`, on every Node dialect.
 *
 * The contract suites ARE the spec: the same cases the fake and the SQL adapter
 * run, with no skips and no narrowing. What they exercise here that they cannot
 * exercise against SQL is that the parent/child guards, the store-wide child ids
 * and the money compare-and-set survive being reassembled out of an aggregate
 * document plus an id claim, with no transaction between them and no index to
 * read either one by.
 */
import { shippingRulesStoreContract, taxRulesStoreContract } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { describeEachDialect } from "./describe-each-dialect.js";
import { SHIPPING_RULES_LAYOUT, TAX_RULES_LAYOUT } from "./rules-collections.js";
import { makeShippingRulesHarness, makeTaxRulesHarness } from "./rules-harness.js";

describeEachDialect("EmdashShippingRulesStore", (ctx) => {
	const bound = ctx.useStorage(SHIPPING_RULES_LAYOUT);
	shippingRulesStoreContract(async () => makeShippingRulesHarness(bound.storage), {
		dialect: ctx.dialect,
	});
});

describeEachDialect("EmdashTaxRulesStore", (ctx) => {
	const bound = ctx.useStorage(TAX_RULES_LAYOUT);
	taxRulesStoreContract(async () => makeTaxRulesHarness(bound.storage), { dialect: ctx.dialect });
});

// A method embedded before `taxable` existed has no such key at all (PR 2b). It
// must read as taxable — today's behaviour — with no migration, and an edit that
// does not name the flag must not write one it never had a value for.
describeEachDialect("EmdashShippingRulesStore taxable on an older method", (ctx) => {
	const bound = ctx.useStorage(SHIPPING_RULES_LAYOUT);

	test("a method without the field reads taxable; an edit can switch it off", async () => {
		const h = makeShippingRulesHarness(bound.storage);
		await h.store.createZone({ id: "z-old", name: "Old", regions: null });
		await h.store.createMethod({ id: "m-old", zoneId: "z-old", name: "Flat", type: "flat_rate" });
		const stored = await h.zones.getVersioned("z-old");
		if (stored === null) throw new Error("no zone document");
		const method = stored.value.methods["m-old"];
		if (method === undefined) throw new Error("no embedded method");
		const { taxable: _dropped, ...older } = method as typeof method & { taxable?: boolean };
		await h.zones.compareAndSet("z-old", stored.revision, {
			...stored.value,
			methods: { "m-old": older },
		});
		expect("taxable" in ((await h.zones.get("z-old"))?.methods["m-old"] ?? {})).toBe(false);

		expect((await h.store.getMethod("m-old"))?.taxable).toBe(true);
		expect((await h.store.listMethods("z-old"))[0]?.taxable).toBe(true);
		const kept = await h.store.updateMethod("m-old", { name: "Flat 2", type: "flat_rate" });
		expect(kept.ok && kept.method.taxable).toBe(true);
		const off = await h.store.updateMethod("m-old", {
			name: "Flat 2",
			type: "flat_rate",
			taxable: false,
		});
		expect(off.ok && off.method.taxable).toBe(false);
		expect((await h.store.getMethod("m-old"))?.taxable).toBe(false);
	});
});
