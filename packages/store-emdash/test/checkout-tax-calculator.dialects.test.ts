import { checkoutTaxCalculatorCases } from "./checkout-tax-calculator-cases.js";
import { COUPON_LIFECYCLE_LAYOUT } from "./coupon-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";

describeEachDialect("checkout through a tax calculator (PR 1)", (ctx) => {
	checkoutTaxCalculatorCases(ctx.useStorage(COUPON_LIFECYCLE_LAYOUT));
});
