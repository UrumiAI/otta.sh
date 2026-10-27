import { describe, expect, test } from "vitest";
import { currency as toCurrency } from "../src/presentation/money.js";
import type { RevenueBucketWire } from "../src/admin/reporting-settings-surface.js";
import {
	moneyAxis,
	ordersChart,
	periodChange,
	salesChart,
	statusChart,
	timeBuckets,
	topProductsChart,
} from "../src/admin/reports-charts.js";
import { periodFromDays } from "../src/admin/reports-period.js";

const USD = toCurrency("USD");

function day(
	d: string,
	revenueCents: number,
	revenueOrderCount = 1,
	currency = "USD",
): RevenueBucketWire {
	return {
		bucketStart: `${d}T00:00:00.000Z`,
		currency,
		revenueCents,
		revenueOrderCount,
		refundedCents: 0,
	};
}

/** The option's series, typed loosely — the option is raw ECharts JSON. */
function series(options: Record<string, unknown>): Array<Record<string, unknown>> {
	return options["series"] as Array<Record<string, unknown>>;
}

describe("periodChange: the KPI delta against the previous period", () => {
	test("a rise is a signed whole percentage, trending up", () => {
		expect(periodChange(12_000, 10_000, "previous 30 days")).toEqual({
			description: "+20% vs previous 30 days",
			trend: "up",
		});
	});

	test("a fall carries a true minus sign and trends down", () => {
		expect(periodChange(8_000, 10_000, "previous 7 days")).toEqual({
			description: "−20% vs previous 7 days",
			trend: "down",
		});
	});

	test("a change that rounds to nothing is neutral, never +0% / -0%", () => {
		expect(periodChange(10_049, 10_000, "previous day")).toEqual({
			description: "0% vs previous day",
			trend: "neutral",
		});
		expect(periodChange(9_951, 10_000, "previous day")).toEqual({
			description: "0% vs previous day",
			trend: "neutral",
		});
	});

	test("nothing then and nothing now is no change, not a division by zero", () => {
		expect(periodChange(0, 0, "previous 30 days")).toEqual({
			description: "No change vs previous 30 days",
			trend: "neutral",
		});
	});

	test("something now over nothing then has no percentage to state", () => {
		const change = periodChange(500, 0, "previous 30 days");
		expect(change).toEqual({ description: "No data in previous 30 days" });
		expect(change.description).not.toMatch(/Infinity|NaN|%/);
	});

	test("an unknown previous value (a figure that cannot be computed) says so", () => {
		expect(periodChange(500, undefined, "previous 30 days")).toEqual({
			description: "No comparison available",
		});
	});

	test("a drop to zero is -100%", () => {
		expect(periodChange(0, 2_500, "previous 30 days")).toEqual({
			description: "−100% vs previous 30 days",
			trend: "down",
		});
	});
});

describe("moneyAxis: tick labels for a money axis, formatted as currency", () => {
	test("picks a round step from 1/2/2.5/5 and states every tick in the currency", () => {
		expect(moneyAxis(8_500, USD)).toEqual({
			max: 10_000,
			interval: 2_500,
			labels: ["$0", "$25", "$50", "$75", "$100"],
		});
	});

	test("an all-zero series still gets a readable axis", () => {
		expect(moneyAxis(0, USD).labels).toEqual(["$0", "$25", "$50", "$75", "$100"]);
	});

	test("a step below one major unit keeps its cents", () => {
		expect(moneyAxis(300, USD)).toEqual({
			max: 400,
			interval: 100,
			labels: ["$0", "$1", "$2", "$3", "$4"],
		});
		expect(moneyAxis(900, USD).labels).toEqual(["$0", "$2.50", "$5", "$7.50", "$10"]);
	});

	test("a zero-decimal currency steps in whole yen", () => {
		const axis = moneyAxis(12_345, toCurrency("JPY"));
		expect(axis.interval).toBe(5_000);
		expect(axis.labels).toEqual(["¥0", "¥5,000", "¥10,000", "¥15,000"]);
		expect(axis.max).toBe(15_000);
	});

	test("the steps are integer minor units, never a float", () => {
		for (const max of [1, 3, 7, 99, 1_234, 98_765, 12_345_678]) {
			const axis = moneyAxis(max, USD);
			expect(Number.isSafeInteger(axis.interval)).toBe(true);
			expect(Number.isSafeInteger(axis.max)).toBe(true);
			expect(axis.max).toBeGreaterThanOrEqual(max);
		}
	});
});

describe("timeBuckets: the over-time series, zero-filled and aligned to the period", () => {
	test("daily for a short period: one point per day, gaps at zero", () => {
		const buckets = timeBuckets(
			periodFromDays("2026-07-10", "2026-07-12"),
			[day("2026-07-10", 3_000, 1), day("2026-07-11", 5_500, 2)],
			"USD",
		);
		expect(buckets.granularity).toBe("day");
		expect(buckets.ordersKnown).toBe(true);
		expect(buckets.points).toEqual([
			{ startDay: "2026-07-10", revenueCents: 3_000, orders: 1 },
			{ startDay: "2026-07-11", revenueCents: 5_500, orders: 2 },
			{ startDay: "2026-07-12", revenueCents: 0, orders: 0 },
		]);
	});

	test("92 days is still daily; 93 folds into 7-day groups from the period's first day", () => {
		expect(timeBuckets(periodFromDays("2026-05-01", "2026-07-31"), [], "USD").points).toHaveLength(
			92,
		);
		const weekly = timeBuckets(
			periodFromDays("2026-04-30", "2026-07-31"),
			[day("2026-04-30", 100), day("2026-05-06", 200), day("2026-05-07", 400)],
			"USD",
		);
		expect(weekly.granularity).toBe("week");
		// 93 days = 13 full weeks + 2 days.
		expect(weekly.points).toHaveLength(14);
		expect(weekly.points[0]).toEqual({ startDay: "2026-04-30", revenueCents: 300, orders: 2 });
		expect(weekly.points[1]).toEqual({ startDay: "2026-05-07", revenueCents: 400, orders: 1 });
	});

	test("revenue counts only the charted currency; orders count across currencies", () => {
		const buckets = timeBuckets(
			periodFromDays("2026-07-10", "2026-07-10"),
			[day("2026-07-10", 3_000, 1, "USD"), day("2026-07-10", 9_999, 2, "EUR")],
			"USD",
		);
		expect(buckets.points).toEqual([{ startDay: "2026-07-10", revenueCents: 3_000, orders: 3 }]);
	});

	test("a wire without the order count says the orders are unknown rather than zero", () => {
		const { revenueOrderCount: _omitted, ...legacy } = day("2026-07-10", 3_000);
		const buckets = timeBuckets(periodFromDays("2026-07-10", "2026-07-10"), [legacy], "USD");
		expect(buckets.ordersKnown).toBe(false);
	});
});

describe("salesChart: the line chart's option carries money as formatted strings", () => {
	const current = timeBuckets(
		periodFromDays("2026-07-10", "2026-07-12"),
		[day("2026-07-10", 3_000), day("2026-07-11", 5_500)],
		"USD",
	);
	const previous = timeBuckets(
		periodFromDays("2026-07-07", "2026-07-09"),
		[day("2026-07-08", 1_250)],
		"USD",
	);
	const block = salesChart({ current, previous, currency: USD });
	const options = block.config.options;

	test("is a custom chart (the only config that can show currency)", () => {
		expect(block).toMatchObject({ type: "chart", block_id: "reports:sales-chart" });
		expect(block.config.chart_type).toBe("custom");
	});

	test("the current series is integer minor units on the day axis, with a currency tooltip", () => {
		const [now] = series(options);
		expect(now?.["name"]).toBe("This period");
		expect(now?.["data"]).toEqual([
			[0, 3_000, "$30.00"],
			[1, 5_500, "$55.00"],
			[2, 0, "$0.00"],
		]);
		expect(now?.["encode"]).toEqual({ x: 0, y: 1, tooltip: 2 });
		// The gradient fill under the current line.
		expect(now?.["areaStyle"]).toBeDefined();
		expect((options["xAxis"] as { data: string[] }).data).toEqual(["10 Jul", "11 Jul", "12 Jul"]);
	});

	test("the previous period is aligned day-by-day onto the current days, muted and dashed, naming its own date", () => {
		const [, before] = series(options);
		expect(before?.["name"]).toBe("Previous period");
		expect(before?.["data"]).toEqual([
			[0, 0, "$0.00 · 7 Jul"],
			[1, 1_250, "$12.50 · 8 Jul"],
			[2, 0, "$0.00 · 9 Jul"],
		]);
		expect(before?.["lineStyle"]).toMatchObject({ type: "dashed" });
	});

	test("the money axis is a category axis of formatted ticks over a hidden value axis", () => {
		const [values, ticks] = options["yAxis"] as Array<Record<string, unknown>>;
		expect(values).toMatchObject({ type: "value", min: 0, max: 6_000, interval: 2_000 });
		expect(ticks).toMatchObject({ type: "category", data: ["$0", "$20", "$40", "$60"] });
	});

	test("carries no key the renderer strips, and no float", () => {
		const json = JSON.stringify(options);
		for (const key of ["formatter", "rich", "graphic", "axisPointer"]) {
			expect(json).not.toContain(`"${key}"`);
		}
		for (const s of series(options)) {
			for (const point of s["data"] as Array<[number, number, string]>) {
				expect(Number.isSafeInteger(point[1])).toBe(true);
			}
		}
	});
});

describe("chart day labels carry the year only when the period crosses a calendar year", () => {
	const labels = (from: string, to: string): string[] => {
		const current = timeBuckets(periodFromDays(from, to), [], "USD");
		const block = salesChart({ current, previous: undefined, currency: USD });
		return (block.config.options["xAxis"] as { data: string[] }).data;
	};

	test('within one year → "10 Jul"', () => {
		expect(labels("2026-07-10", "2026-07-12")).toEqual(["10 Jul", "11 Jul", "12 Jul"]);
	});

	test("across New Year → every label names its year", () => {
		expect(labels("2025-12-30", "2026-01-02")).toEqual([
			"30 Dec 2025",
			"31 Dec 2025",
			"1 Jan 2026",
			"2 Jan 2026",
		]);
	});

	test("the previous period crossing New Year puts the year on BOTH series, so a tooltip never mixes formats", () => {
		// 10–30 Jan 2026 sits inside one year; the 21 days before it do not.
		const current = timeBuckets(periodFromDays("2026-01-10", "2026-01-30"), [], "USD");
		const previous = timeBuckets(periodFromDays("2025-12-20", "2026-01-09"), [], "USD");
		const options = salesChart({ current, previous, currency: USD }).config.options;
		expect((options["xAxis"] as { data: string[] }).data[0]).toBe("10 Jan 2026");
		const [, before] = series(options);
		const tooltips = before?.["data"] as Array<[number, number, string]> | undefined;
		expect(tooltips?.[0]?.[2]).toBe("$0.00 · 20 Dec 2025");
	});

	test("the orders chart agrees", () => {
		const current = timeBuckets(periodFromDays("2025-12-31", "2026-01-01"), [], "USD");
		expect((ordersChart(current).config.options["xAxis"] as { data: string[] }).data).toEqual([
			"31 Dec 2025",
			"1 Jan 2026",
		]);
	});
});

describe("ordersChart / statusChart / topProductsChart", () => {
	test("orders over time is a bar per day of paid orders", () => {
		const current = timeBuckets(
			periodFromDays("2026-07-10", "2026-07-11"),
			[day("2026-07-10", 3_000, 4)],
			"USD",
		);
		const block = ordersChart(current);
		const [bars] = series(block.config.options);
		expect(bars).toMatchObject({ type: "bar", data: [4, 0] });
	});

	test("orders by status is a donut, largest first, in the Orders screen's words with the count", () => {
		const block = statusChart([
			{ status: "failed", orderCount: 2 },
			{ status: "paid", orderCount: 12 },
		]);
		const [pie] = series(block.config.options);
		expect(pie?.["type"]).toBe("pie");
		expect(pie?.["radius"]).toEqual(["50%", "75%"]);
		expect(
			((pie?.["data"] ?? []) as Array<{ name: string; value: number }>).map((d) => [
				d.name,
				d.value,
			]),
		).toEqual([
			["paid (12)", 12],
			["failed · closed (2)", 2],
		]);
	});

	test("top products is a horizontal bar by revenue, labelled with money and units", () => {
		const block = topProductsChart(
			[
				{ productId: "p1", titleSnapshot: "Gadget", qtySold: 4, revenueCents: 4_000 },
				{ productId: "p2", titleSnapshot: "Widget", qtySold: 1, revenueCents: 1_500 },
			],
			USD,
		);
		const options = block.config.options;
		expect((options["yAxis"] as { data: string[]; inverse: boolean }).data).toEqual([
			"Gadget",
			"Widget",
		]);
		const [bars] = series(options);
		expect(bars?.["data"]).toEqual([
			[4_000, 0, "$40.00 · 4 sold"],
			[1_500, 1, "$15.00 · 1 sold"],
		]);
		expect(bars?.["encode"]).toEqual({ x: 0, y: 1, label: 2, tooltip: 2 });
	});

	test("without a single currency, top products ranks by units and states no money", () => {
		const block = topProductsChart(
			[{ productId: "p1", titleSnapshot: "Gadget", qtySold: 4, revenueCents: 4_000 }],
			undefined,
		);
		const [bars] = series(block.config.options);
		expect(bars?.["data"]).toEqual([[4, 0, "4 sold"]]);
	});
});
