/**
 * The Reports page's charts and KPI deltas — pure builders over the report reads.
 *
 * HOW A CHART STATES MONEY WITHOUT A FORMATTER. em-dash's chart renderer strips
 * every `formatter` (with `rich`, `graphic` and `axisPointer`) as an XSS vector,
 * and a Block Kit response is JSON, so no function could cross anyway. Left alone,
 * an axis and a tooltip would print raw minor units (9900, not $99.00). So every
 * money figure a chart SHOWS is a string already formatted by `formatMoney`, and
 * the numbers it PLOTS stay integer minor units:
 *
 *  - the tooltip and bar labels read a third data dimension holding the formatted
 *    string (`encode: { tooltip: 2 }` / `label: 2`), which ECharts prints as is;
 *  - the money axis is a CATEGORY axis of formatted tick labels laid over the
 *    hidden value axis — with `boundaryGap: false` its N labels sit exactly on the
 *    value axis's N ticks, because both run 0..max in equal steps
 *    ({@link moneyAxis} picks the step, in integer minor units).
 *
 * No float ever touches a money value here; the only arithmetic on money is
 * integer addition and the round-step search over integer minor units.
 *
 * WHAT THE RENDERER CAN DRAW. `@emdash-cms/blocks` registers LineChart, BarChart
 * and PieChart with the Aria, AxisPointer, Grid and Tooltip components — no
 * legend, title, dataset or markLine. So a series' meaning is stated in a
 * `context` line beside the chart, never in a legend that would not render.
 *
 * COLOURS work on both themes: the Kumo palette's blue (identical in light and
 * dark) for the current period, and a mid grey for the comparison — the renderer
 * switches ECharts to its dark theme for axis text and grid lines on its own.
 */
import { formatDay, minorUnitDigits, orderStateCell } from "@urumi.ai/otta-admin-presentation";
import { formatMoney } from "../presentation/format-money.js";
import { type Currency, cents as toCents } from "../presentation/money.js";
import type { ChartBlock } from "../types.js";
import type {
	RevenueBucketWire,
	StatusCountWire,
	TopProductWire,
} from "./reporting-settings-surface.js";
import { dayCount, type ReportPeriod, shiftDay } from "./reports-period.js";

const MONEY_LOCALE = "en-US";

/** Kumo's categorical blue — the same hex in both themes. */
const BLUE = "#4290F0";
/** The comparison series: readable on white and on the dark admin, and quieter
 *  than any palette colour. */
const MUTED = "#A3A3A3";

/** Past this many days a day per point stops showing shape; the series folds into
 *  7-day groups instead (≤ 58 points at the 400-day cap). */
export const MAX_DAILY_POINTS = 92;

// -- KPI deltas --------------------------------------------------------------

export type Trend = "up" | "down" | "neutral";

/**
 * The change from `previous` to `current`, as a card description — "+12% vs
 * previous 30 days" — and the arrow it earns.
 *
 * NO DIVISION BY ZERO, and no percentage that is not one: nothing then and
 * nothing now is "No change"; something now over nothing then has no
 * percentage at all ("No data in previous 30 days"), and an UNKNOWN previous
 * figure (a read that failed, or an average whose previous revenue is in another
 * currency) says so. An average over no previous orders is not passed here at
 * all: the card states "No data in …" itself rather than averaging nothing.
 * A change that rounds to 0% is neutral and unsigned, never "+0%".
 */
export function periodChange(
	current: number,
	previous: number | undefined,
	phrase: string,
): { description: string; trend?: Trend } {
	if (previous === undefined) return { description: "No comparison available" };
	if (previous === 0) {
		return current === 0
			? { description: `No change vs ${phrase}`, trend: "neutral" }
			: { description: `No data in ${phrase}` };
	}
	const percent = Math.round(((current - previous) / previous) * 100);
	if (percent === 0) return { description: `0% vs ${phrase}`, trend: "neutral" };
	return percent > 0
		? { description: `+${percent}% vs ${phrase}`, trend: "up" }
		: { description: `−${Math.abs(percent)}% vs ${phrase}`, trend: "down" };
}

// -- the over-time series ----------------------------------------------------

export interface TimePoint {
	/** The first day the point covers (`YYYY-MM-DD`). */
	startDay: string;
	/** Revenue in the charted currency, integer minor units. */
	revenueCents: number;
	/** Orders behind the revenue, across every currency (counts are comparable
	 *  across currencies; money is not). */
	orders: number;
}

export interface TimeSeries {
	granularity: "day" | "week";
	points: TimePoint[];
	/** False when any bucket came without `revenueOrderCount` — an older reader.
	 *  The orders chart then states the gap instead of drawing zeros. */
	ordersKnown: boolean;
}

/**
 * The period's buckets as a continuous series: one point per day — or per 7-day
 * group from the period's first day past {@link MAX_DAILY_POINTS} — with every
 * empty point at zero.
 *
 * Zero-filling is this renderer's job: the report OMITS an empty period, and its
 * silence is exactly what says which points are zero. Groups start at the
 * period's own first day (not an ISO Monday), so a period and its equal-length
 * comparison fold into the same number of points, index for index.
 */
export function timeBuckets(
	period: Pick<ReportPeriod, "fromDay" | "toDay">,
	buckets: readonly RevenueBucketWire[],
	currencyCode: string | undefined,
): TimeSeries {
	const days = dayCount(period.fromDay, period.toDay);
	const step = days > MAX_DAILY_POINTS ? 7 : 1;
	const points: TimePoint[] = [];
	for (let offset = 0; offset < days; offset += step) {
		points.push({ startDay: shiftDay(period.fromDay, offset), revenueCents: 0, orders: 0 });
	}
	let ordersKnown = true;
	for (const bucket of buckets) {
		const offset = dayCount(period.fromDay, bucket.bucketStart.slice(0, 10)) - 1;
		const point = points[Math.floor(offset / step)];
		if (offset < 0 || point === undefined) continue;
		if (bucket.currency === currencyCode) point.revenueCents += bucket.revenueCents;
		if (bucket.revenueOrderCount === undefined) ordersKnown = false;
		else point.orders += bucket.revenueOrderCount;
	}
	return { granularity: step === 1 ? "day" : "week", points, ordersKnown };
}

// -- the money axis ----------------------------------------------------------

/**
 * A money value axis — 0 to `max` in equal steps of `interval` minor units — and
 * its tick labels, each formatted as currency. The step is the smallest of
 * 1, 2, 2.5 or 5 × 10ⁿ minor units that splits the data into about four, so the
 * labels read as round amounts ($25, $50, not $21.25); a whole-unit label drops
 * its zero fraction ("$25", not "$25.00"). An all-zero series gets $0–$100.
 */
export function moneyAxis(
	maxCents: number,
	currency: Currency,
): { max: number; interval: number; labels: string[] } {
	const unit = 10 ** minorUnitDigits(currency);
	const empty = maxCents <= 0;
	const target = empty ? 100 * unit : maxCents;
	const interval = roundStep(target / 4);
	// Headroom: the top tick sits above the highest point, never on it.
	const ticks = empty ? 4 : Math.floor(target / interval) + 1;
	const labels: string[] = [];
	for (let i = 0; i <= ticks; i++) labels.push(axisMoney(i * interval, currency));
	return { max: ticks * interval, interval, labels };
}

/** The smallest 1/2/2.5/5 × 10ⁿ step (an integer, ≥ 1) at or above `raw`. */
function roundStep(raw: number): number {
	if (raw <= 1) return 1;
	const magnitude = 10 ** Math.floor(Math.log10(raw));
	for (const multiple of [1, 2, 2.5, 5, 10]) {
		const step = multiple * magnitude;
		if (Number.isInteger(step) && step >= raw) return step;
	}
	return 10 * magnitude;
}

/** `formatMoney`, minus a zero fraction: "$25.00" → "$25", "$2.50" stays. */
function axisMoney(amount: number, currency: Currency): string {
	const formatted = formatMoney(toCents(amount), currency, MONEY_LOCALE);
	return formatted.replace(/\.0+(?=\D*$)/, "");
}

// -- charts ------------------------------------------------------------------

/** The day a point is labelled with on the axis: "10 Jul". */
function axisDay(day: string): string {
	return formatDay(day, false);
}

/** Show about six x labels whatever the point count. */
function labelInterval(points: number): number {
	return Math.max(0, Math.ceil(points / 6) - 1);
}

const CATEGORY_X = {
	type: "category",
	axisTick: { show: false },
	axisLine: { show: false },
} as const;

/**
 * Total sales over time: the current period as a blue line over a gradient fill,
 * and the previous period as a grey dashed line laid onto the SAME points (point
 * i of each), so the two read against each other day for day. Each tooltip row
 * states its money formatted, and the comparison row names its own date.
 */
export function salesChart(args: {
	current: TimeSeries;
	previous: TimeSeries;
	currency: Currency;
}): ChartBlock {
	const { current, previous, currency } = args;
	const money = (amount: number): string => formatMoney(toCents(amount), currency, MONEY_LOCALE);
	const top = Math.max(
		0,
		...current.points.map((p) => p.revenueCents),
		...previous.points.map((p) => p.revenueCents),
	);
	const axis = moneyAxis(top, currency);
	const single = current.points.length <= 2;
	const line = {
		type: "line",
		showSymbol: single,
		symbolSize: 6,
		smooth: 0.25,
		smoothMonotone: "x",
		dimensions: ["point", "amount", "label"],
		encode: { x: 0, y: 1, tooltip: 2 },
	};
	return {
		type: "chart",
		block_id: "reports:sales-chart",
		config: {
			chart_type: "custom",
			height: 300,
			options: {
				aria: { enabled: true },
				grid: { left: gridLeft(axis.labels), right: 24, top: 16, bottom: 28 },
				tooltip: { trigger: "axis" },
				xAxis: {
					...CATEGORY_X,
					data: current.points.map((p) => axisDay(p.startDay)),
					boundaryGap: false,
					axisLabel: { interval: labelInterval(current.points.length) },
				},
				yAxis: [
					{
						type: "value",
						min: 0,
						max: axis.max,
						interval: axis.interval,
						axisLabel: { show: false },
						splitLine: { lineStyle: { type: "dashed" } },
					},
					{
						type: "category",
						data: axis.labels,
						position: "left",
						boundaryGap: false,
						axisLine: { show: false },
						axisTick: { show: false },
						splitLine: { show: false },
					},
				],
				series: [
					{
						...line,
						name: "This period",
						z: 3,
						color: BLUE,
						lineStyle: { width: 2.5 },
						areaStyle: {
							color: {
								type: "linear",
								x: 0,
								y: 0,
								x2: 0,
								y2: 1,
								colorStops: [
									{ offset: 0, color: "rgba(66, 144, 240, 0.32)" },
									{ offset: 1, color: "rgba(66, 144, 240, 0)" },
								],
							},
						},
						data: current.points.map((p, i) => [i, p.revenueCents, money(p.revenueCents)]),
					},
					{
						...line,
						name: "Previous period",
						z: 2,
						color: MUTED,
						lineStyle: { width: 2, type: "dashed" },
						data: previous.points.map((p, i) => [
							i,
							p.revenueCents,
							`${money(p.revenueCents)} · ${previousLabel(p.startDay, previous.granularity)}`,
						]),
					},
				],
			},
		},
	};
}

function previousLabel(day: string, granularity: "day" | "week"): string {
	return granularity === "day" ? axisDay(day) : `week of ${axisDay(day)}`;
}

/** Room for the widest money tick label (≈7px a character at 12px). */
function gridLeft(labels: readonly string[]): number {
	return 16 + 7 * Math.max(...labels.map((l) => l.length));
}

/** Orders over time: one bar per point, the orders behind that point's revenue. */
export function ordersChart(current: TimeSeries): ChartBlock {
	return {
		type: "chart",
		block_id: "reports:orders-chart",
		config: {
			chart_type: "custom",
			height: 260,
			options: {
				aria: { enabled: true },
				grid: { left: 40, right: 16, top: 16, bottom: 28 },
				tooltip: { trigger: "axis" },
				xAxis: {
					...CATEGORY_X,
					data: current.points.map((p) => axisDay(p.startDay)),
					axisLabel: { interval: labelInterval(current.points.length) },
				},
				yAxis: {
					type: "value",
					minInterval: 1,
					splitLine: { lineStyle: { type: "dashed" } },
				},
				series: [
					{
						type: "bar",
						name: "Paid orders",
						color: BLUE,
						barMaxWidth: 24,
						itemStyle: { borderRadius: [3, 3, 0, 0] },
						data: current.points.map((p) => p.orders),
					},
				],
			},
		},
	};
}

/** A colour per order state: live states in the palette, dead ends grey. */
const STATUS_COLOURS: Readonly<Record<string, string>> = {
	pending: "#F5B647",
	paid: BLUE,
	processing: "#8D58EE",
	shipped: "#50C3B6",
	delivered: "#00A63E",
	completed: "#00A63E",
	refunded: "#E8649D",
	partially_refunded: "#E8649D",
	failed: MUTED,
	cancelled: MUTED,
	expired: MUTED,
};

/**
 * Orders by status as a donut, largest slice first. Each slice is named in the
 * Orders screen's own words (`orderStateCell`) with its count, so the numbers
 * are on the chart rather than only in a tooltip.
 */
export function statusChart(statuses: readonly StatusCountWire[]): ChartBlock {
	const slices = statuses
		.filter((s) => s.orderCount > 0)
		.toSorted((a, b) => b.orderCount - a.orderCount || a.status.localeCompare(b.status));
	return {
		type: "chart",
		block_id: "reports:statuses-chart",
		config: {
			chart_type: "custom",
			height: 260,
			options: {
				aria: { enabled: true },
				tooltip: { trigger: "item" },
				series: [
					{
						type: "pie",
						name: "Orders",
						radius: ["50%", "75%"],
						center: ["50%", "50%"],
						padAngle: 2,
						itemStyle: { borderRadius: 4 },
						label: { show: true },
						data: slices.map((s) => ({
							name: `${orderStateCell(s.status)} (${s.orderCount})`,
							value: s.orderCount,
							...(STATUS_COLOURS[s.status] !== undefined
								? { itemStyle: { color: STATUS_COLOURS[s.status] } }
								: {}),
						})),
					},
				],
			},
		},
	};
}

/**
 * Top products as horizontal bars, best first, each labelled with what it sold.
 *
 * Ranked and labelled by revenue when the period has ONE currency. The products
 * report carries no currency of its own, so with several there is no honest
 * money figure to state per product: the bars then measure units sold and the
 * labels say only that.
 */
export function topProductsChart(
	products: readonly TopProductWire[],
	currency: Currency | undefined,
): ChartBlock {
	const label = (p: TopProductWire): string =>
		currency === undefined
			? `${p.qtySold} sold`
			: `${formatMoney(toCents(p.revenueCents), currency, MONEY_LOCALE)} · ${p.qtySold} sold`;
	return {
		type: "chart",
		block_id: "reports:top-chart",
		config: {
			chart_type: "custom",
			height: Math.max(140, 40 * products.length + 24),
			options: {
				aria: { enabled: true },
				grid: { left: 8, right: 132, top: 8, bottom: 8, containLabel: true },
				tooltip: { trigger: "item" },
				xAxis: { type: "value", show: false },
				yAxis: {
					type: "category",
					inverse: true,
					data: products.map((p) => p.titleSnapshot),
					axisTick: { show: false },
					axisLine: { show: false },
					axisLabel: { width: 160, overflow: "truncate" },
				},
				series: [
					{
						type: "bar",
						name: currency === undefined ? "Units sold" : "Sales",
						color: BLUE,
						barMaxWidth: 20,
						itemStyle: { borderRadius: [0, 4, 4, 0] },
						label: { show: true, position: "right" },
						dimensions: ["amount", "product", "label"],
						encode: { x: 0, y: 1, label: 2, tooltip: 2 },
						data: products.map((p, i) => [
							currency === undefined ? p.qtySold : p.revenueCents,
							i,
							label(p),
						]),
					},
				],
			},
		},
	};
}
