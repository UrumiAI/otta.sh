/** `tax-rates-for-class-cases.ts` on **D1** (#744) — only the storage binding differs. */
import { TAX_RULES_LAYOUT } from "../rules-collections.js";
import { taxRatesForClassCases } from "../tax-rates-for-class-cases.js";
import { useD1Storage } from "./describe-d1.js";

taxRatesForClassCases(useD1Storage(TAX_RULES_LAYOUT));
