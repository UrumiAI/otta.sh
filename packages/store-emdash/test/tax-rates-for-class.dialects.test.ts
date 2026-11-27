/** `tax-rates-for-class-cases.ts` on every Node dialect (#744). */
import { describeEachDialect } from "./describe-each-dialect.js";
import { TAX_RULES_LAYOUT } from "./rules-collections.js";
import { taxRatesForClassCases } from "./tax-rates-for-class-cases.js";

describeEachDialect("EmdashTaxRulesStore.listRatesForClass", (ctx) => {
	taxRatesForClassCases(ctx.useStorage(TAX_RULES_LAYOUT));
});
