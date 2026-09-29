/**
 * The day document's stored shapes on the Node dialects. The cases live in
 * `reporting-stored-shape-cases.ts`, shared with the D1 tier.
 */
import { describeEachDialect } from "./describe-each-dialect.js";
import { REPORTING_LAYOUT } from "./reporting-collections.js";
import { reportingStoredShapeCases } from "./reporting-stored-shape-cases.js";

describeEachDialect("EmdashReportingStore stored day-document shapes", (ctx) => {
	reportingStoredShapeCases(ctx.useStorage(REPORTING_LAYOUT));
});
