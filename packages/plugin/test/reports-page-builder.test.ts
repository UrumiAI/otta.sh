import { describe, expect, test } from "vitest";
import type {
	RevenueBucketWire,
	StatusCountWire,
	TopProductWire,
} from "../src/admin/reporting-settings-surface.js";
import { buildReportsBlocks, type ReportsData } from "../src/admin/reports-page.js";
import { periodFromDays, previousPeriod } from "../src/admin/reports-period.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { findBlocks, sectionBlocks, type LooseBlock } from "./helpers/blocks.js";

/**
 * `buildReportsBlocks` — the pure `ReportsData → BlockResponse` half of the
 * Reports page — for the rules that are a function of the reads alone: the AOV
 * comparison's per-currency denominator, a failed previous-period read, the
 * empty period's axis currency, the units ranking of a multi-currency period's
 * top products, and the partial last week of a folded series.
 */

function rangeOf(fromDay: string, toDay: string): ReportsData["range"] {
	return {
		...periodFromDays(fromDay, toDay),
		preset: "custom",
		isDefault: false,
		previous: previousPeriod({ fromDay, toDay }),
	};
}

/** 10–12 Jul; its previous period is 7–9 Jul. */
const RANGE = rangeOf("2026-07-10", "2026-07-12");

function bucket(
	day: string,
	revenueCents: number,
	revenueOrderCount: number | undefined,
	currency = "USD",
	refundedCents = 0,
): RevenueBucketWire {
	return {
		bucketStart: `${day}T00:00:00.000Z`,
		currency,
		revenueCents,
		refundedCents,
		...(revenueOrderCount === undefined ? {} : { revenueOrderCount }),
	};
}

function render(overrides: Partial<ReportsData>): LooseBlock[] {
	const blocks = buildReportsBlocks({
		displayName: "Test Store",
		range: RANGE,
		revenue: [],
		statuses: [],
		top: [],
		low: [],
		...overrides,
	}).blocks as unknown as LooseBlock[];
	assertBlockContract(blocks, { screen: "reports", level: "list" });
	return blocks;
}

function statItems(blocks: readonly LooseBlock[]): Array<Record<string, unknown>> {
	const stats = findBlocks(blocks, "stats")[0] as { items?: Array<Record<string, unknown>> };
	return stats?.items ?? [];
}

function tile(blocks: readonly LooseBlock[], label: string): Record<string, unknown> | undefined {
	return statItems(blocks).find((i) => i.label === label);
}

function chartOptions(blocks: readonly LooseBlock[], id: string): Record<string, unknown> {
	const chart = findBlocks(blocks, "chart").find((b) => b.block_id === id) as
		| { config?: { options?: Record<string, unknown> } }
		| undefined;
	return chart?.config?.options ?? {};
}

function sectionTexts(blocks: readonly LooseBlock[], id: string): string[] {
	return sectionBlocks(blocks, id)
		.filter((b) => b.type === "context")
		.map((b) => String(b.text));
}

/** $30.00 from 1 order and $55.00 from 2 — $85.00 over 3 USD orders. */
const USD_CURRENT = [bucket("2026-07-10", 3000, 1), bucket("2026-07-11", 5500, 2)];
/** 10 paid orders across EVERY currency — not the 3 that produced the USD revenue. */
const STATUSES: StatusCountWire[] = [{ status: "paid", orderCount: 10 }];

describe("reports builder: average order value divides by the CURRENCY's own orders", () => {
	test("the denominator is Σ revenueOrderCount for the currency, not every paid order", () => {
		const blocks = render({ revenue: USD_CURRENT, statuses: STATUSES });
		// $85.00 / 3 = $28.33 — never $85.00 / 10 = $8.50.
		expect(tile(blocks, "Average order value")?.value).toBe("$28.33");
	});

	test("the comparison uses the previous period's own per-currency count", () => {
		const blocks = render({
			revenue: USD_CURRENT,
			statuses: STATUSES,
			previousRevenue: [bucket("2026-07-08", 6000, 3)],
			previousStatuses: [{ status: "paid", orderCount: 40 }],
		});
		// 2833 vs 6000 / 3 = 2000 → +42%; by the 40 paid orders it would be +467%.
		expect(tile(blocks, "Average order value")).toMatchObject({
			value: "$28.33",
			description: "+42% vs previous 3 days",
			trend: "up",
		});
	});

	test.each([
		[
			"several revenue currencies",
			[bucket("2026-07-08", 6000, 3), bucket("2026-07-08", 4000, 2, "EUR")],
		],
		["a different single currency", [bucket("2026-07-08", 6000, 3, "EUR")]],
		["no per-currency order count on the wire", [bucket("2026-07-08", 6000, undefined)]],
	])("previous period with %s → no comparison", (_name, previousRevenue) => {
		const blocks = render({
			revenue: USD_CURRENT,
			statuses: STATUSES,
			previousRevenue,
			previousStatuses: [{ status: "paid", orderCount: 5 }],
		});
		expect(tile(blocks, "Average order value")?.description).toBe("No comparison available");
	});

	// No orders before is a KNOWN fact, stated like every other card's — never a
	// percentage over a zero (or over an average that has no answer).
	test.each([
		["no paid orders at all", []],
		["only refunds", [bucket("2026-07-08", 0, 0, "USD", 500)]],
		["only free orders", [bucket("2026-07-08", 0, 0)]],
	])("previous period with %s → no data in it", (_name, previousRevenue) => {
		const blocks = render({ revenue: USD_CURRENT, statuses: STATUSES, previousRevenue });
		expect(tile(blocks, "Average order value")).toMatchObject({
			value: "$28.33",
			description: "No data in previous 3 days",
		});
		expect(tile(blocks, "Average order value")?.trend).toBeUndefined();
	});
});

describe("reports builder: a failed previous-period read keeps the page", () => {
	test("current figures render, every card says no comparison, and the chart says why", () => {
		const blocks = render({
			revenue: USD_CURRENT,
			statuses: [{ status: "paid", orderCount: 3 }],
			top: [{ productId: "p1", titleSnapshot: "Gadget", qtySold: 4, revenueCents: 4000 }],
		});
		expect(statItems(blocks)).toEqual([
			{ label: "Total sales", value: "$85.00", description: "No comparison available" },
			{ label: "Orders", value: "3", description: "No comparison available" },
			{ label: "Average order value", value: "$28.33", description: "No comparison available" },
			{ label: "Refunded", value: "$0.00", description: "No comparison available" },
		]);
		expect(findBlocks(blocks, "chart").map((c) => c.block_id)).toEqual([
			"reports:sales-chart",
			"reports:orders-chart",
			"reports:statuses-chart",
			"reports:top-chart",
		]);
		expect(
			sectionTexts(blocks, "reports:sales").some((t) =>
				t.includes("The previous period could not be loaded."),
			),
		).toBe(true);
		// The dashed line has nothing to draw: the previous series is all zero.
		const series = chartOptions(blocks, "reports:sales-chart")["series"] as Array<{
			data: Array<[number, number, string]>;
		}>;
		expect(series[1]?.data.every(([, amount]) => amount === 0)).toBe(true);
	});
});

/** The sales chart's formatted money tick labels (the category axis). */
function axisLabels(blocks: readonly LooseBlock[]): string[] {
	const yAxis = chartOptions(blocks, "reports:sales-chart")["yAxis"] as Array<{ data?: string[] }>;
	return yAxis[1]?.data ?? [];
}

describe("reports builder: an empty period's money axis is in the store's currency", () => {
	test("nothing earned now or before → the saved store currency, not USD", () => {
		expect(axisLabels(render({ previousRevenue: [], storeCurrency: "EUR" }))[1]).toBe("€25");
	});

	test("a refund-only previous bucket does not pick the axis currency", () => {
		const blocks = render({
			previousRevenue: [bucket("2026-07-08", 0, 0, "GBP", 500)],
			storeCurrency: "EUR",
		});
		expect(axisLabels(blocks)[1]).toBe("€25");
	});

	test("an ambiguous previous period (several revenue currencies) does not pick it either", () => {
		const blocks = render({
			previousRevenue: [bucket("2026-07-08", 100, 1, "GBP"), bucket("2026-07-08", 100, 1, "JPY")],
			storeCurrency: "EUR",
		});
		expect(axisLabels(blocks)[1]).toBe("€25");
	});

	test("a single previous revenue currency still names the axis, so its dashed line shows", () => {
		const blocks = render({
			previousRevenue: [bucket("2026-07-08", 9900, 1, "GBP")],
			storeCurrency: "EUR",
		});
		expect(axisLabels(blocks)[0]).toBe("£0");
	});

	test("no saved currency (or an unusable one) falls back to USD", () => {
		expect(axisLabels(render({ previousRevenue: [] }))[1]).toBe("$25");
		expect(axisLabels(render({ previousRevenue: [], storeCurrency: "dollars" }))[1]).toBe("$25");
	});
});

describe("reports builder: a multi-currency period's top products are ranked by UNITS", () => {
	const byRevenue: TopProductWire[] = [
		{ productId: "a", titleSnapshot: "Atlas", qtySold: 1, revenueCents: 90_000 },
		{ productId: "b", titleSnapshot: "Bolt", qtySold: 5, revenueCents: 500 },
		{ productId: "c", titleSnapshot: "Cog", qtySold: 3, revenueCents: 100 },
	];
	const multi = [bucket("2026-07-10", 3000, 1), bucket("2026-07-10", 1000, 1, "EUR")];

	function titles(blocks: readonly LooseBlock[]): string[] {
		return (chartOptions(blocks, "reports:top-chart")["yAxis"] as { data: string[] }).data;
	}

	test("several currencies → the revenue list re-sorted by units, and the copy says so", () => {
		const blocks = render({ revenue: multi, top: byRevenue });
		expect(titles(blocks)).toEqual(["Bolt", "Cog", "Atlas"]);
		expect(sectionTexts(blocks, "reports:top")[0]).toMatch(/^Ranked by units/);
	});

	test("one currency → the revenue ranking", () => {
		const blocks = render({ revenue: USD_CURRENT, top: byRevenue });
		expect(titles(blocks)).toEqual(["Atlas", "Bolt", "Cog"]);
		expect(sectionTexts(blocks, "reports:top")[0]).toMatch(/^By revenue/);
	});
});

describe("reports builder: average order value with a bucket lacking revenueOrderCount", () => {
	test("falls back to the paid-order count rather than a partial sum", () => {
		const blocks = render({
			revenue: [bucket("2026-07-10", 3000, 1), bucket("2026-07-11", 5500, undefined)],
			statuses: STATUSES,
		});
		// $85.00 / 10 paid orders = $8.50 — never $85.00 / 1.
		expect(tile(blocks, "Average order value")?.value).toBe("$8.50");
	});
});

describe("reports builder: a folded series states its partial last week", () => {
	// 365 days = 52 weeks + 1 day: the 53rd point covers ONE day, and without a
	// word it reads as a cliff.
	const YEAR = rangeOf("2025-10-21", "2026-10-20");
	const revenue = [bucket("2026-10-20", 3000, 1)];

	test("365 days → the sales and orders notes say the last point covers 1 day", () => {
		const blocks = render({ range: YEAR, revenue, previousRevenue: [] });
		expect(
			sectionTexts(blocks, "reports:sales").some((t) =>
				t.endsWith("One point per week; the last point covers 1 day."),
			),
		).toBe(true);
		expect(sectionTexts(blocks, "reports:orders")).toContain(
			"Paid orders per week · 1 in this period. The last point covers 1 day.",
		);
	});

	test("93 days → the last point covers 2 days", () => {
		const blocks = render({ range: rangeOf("2026-04-30", "2026-07-31"), previousRevenue: [] });
		expect(
			sectionTexts(blocks, "reports:sales").some((t) =>
				t.endsWith("One point per week; the last point covers 2 days."),
			),
		).toBe(true);
	});

	test("whole weeks (364 days) and daily periods say nothing about a partial point", () => {
		for (const range of [rangeOf("2025-10-22", "2026-10-20"), RANGE]) {
			const texts = [
				...sectionTexts(render({ range, revenue, previousRevenue: [] }), "reports:sales"),
				...sectionTexts(render({ range, revenue, previousRevenue: [] }), "reports:orders"),
			];
			expect(texts.some((t) => t.includes("last point"))).toBe(false);
		}
	});
});
