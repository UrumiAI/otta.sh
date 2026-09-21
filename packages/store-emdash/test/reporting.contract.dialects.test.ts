/**
 * The domain's reporting contract against the document adapter, on every Node
 * dialect — bound unchanged, with no skips and no narrowing.
 *
 * The contract suite IS the spec, and what it exercises here that it cannot
 * exercise against SQL is that four aggregates computed by ONE statement over
 * `orders` survive being reassembled out of precomputed day documents with no
 * transaction anywhere: the revenue allow-list applied at WRITE time to a bucket
 * keyed on the order's creation day, the refund union as a second pair of counters
 * in the same document, and the ISO-Monday and month boundaries as a fold over
 * days rather than a dialect-branched `date_trunc`.
 */
import { reportingStoreContract } from "@otta-sh/domain/testing";
import { expect, test } from "vitest";
import { isStorageQueryError } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	REPORTING_LAYOUT,
	REPORTING_LAYOUT_WITHOUT_DAILY_INDEXES,
} from "./reporting-collections.js";
import { makeReportingHarness } from "./reporting-harness.js";

describeEachDialect("EmdashReportingStore", (ctx) => {
	const bound = ctx.useStorage(REPORTING_LAYOUT);
	reportingStoreContract(async () => makeReportingHarness(bound.storage), { dialect: ctx.dialect });
});

describeEachDialect("EmdashReportingStore read contract", (ctx) => {
	const bare = ctx.useStorage(REPORTING_LAYOUT_WITHOUT_DAILY_INDEXES);

	test("the `date` index is load-bearing: without the declaration a window read throws", async () => {
		const h = makeReportingHarness(bare.storage);
		const failure = await h.store
			.revenueByPeriod({ from: "2026-07-10T00:00:00.000Z", to: "2026-07-12T23:59:59.999Z" }, "day")
			.then(
				() => null,
				(err: unknown) => err,
			);
		expect(isStorageQueryError(failure)).toBe(true);
	});
});
