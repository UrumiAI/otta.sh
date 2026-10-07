/** `checkout-tax-calculator-cases.ts` on **D1** — only the storage binding differs. */
import { checkoutTaxCalculatorCases } from "../checkout-tax-calculator-cases.js";
import { COUPON_LIFECYCLE_LAYOUT } from "../coupon-collections.js";
import { useD1Storage } from "./describe-d1.js";

checkoutTaxCalculatorCases(useD1Storage(COUPON_LIFECYCLE_LAYOUT));
