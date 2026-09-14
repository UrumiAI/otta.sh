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
