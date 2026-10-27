import { formatDay } from "@urumi.ai/otta-admin-presentation";
import { DEFAULT_OPERATIONAL_SETTINGS } from "@urumi.ai/otta-domain";
import { formatMoney } from "../presentation/format-money.js";
import { type Currency, cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	AdminPageConfig,
	BannerBlock,
	Block,
	BlockResponse,
	FormBlock,
	RouteHandler,
	StatItem,
	TableBlock,
} from "../types.js";
import { carriedForm, failClosedResponse, section } from "./scaffold/index.js";
import { MAX_TOP_PRODUCTS_LIMIT } from "./in-process-reporting-settings-client.js";
import { makeAdminClients } from "./make-admin-clients.js";
import type {
	LowStockWire,
	OperationalSettingsWire,
	RevenueBucketWire,
	StatusCountWire,
	TopProductWire,
} from "./reporting-settings-surface.js";
import {
	MAX_DAILY_POINTS,
	ordersChart,
	periodChange,
	salesChart,
	statusChart,
	timeBuckets,
	topProductsChart,
	type TimeSeries,
} from "./reports-charts.js";
import {
	comparisonPhrase,
	DEFAULT_PRESET,
	presetValue,
	REPORTS_PERIOD_ACTION_ID,
	REPORTS_PRESETS,
	type ReportPeriod,
	type ResolvedRange,
	resolveReportsRange,
} from "./reports-period.js";

/** The admin Reports page's `admin.pages` manifest entry (§4.1): a Shopify-style
 *  analytics overview — a period picker, four KPI cards with their change against
 *  the previous period, and charts for sales, orders, statuses and top products.
 *
 *  The charts are em-dash `chart` blocks (ECharts). They state money as
 *  pre-formatted strings, never raw minor units — see `reports-charts.ts` for
 *  how, given that the renderer strips every `formatter` (ADR-0038).
 *
 *  Rendered by the single `admin` dispatch route (see `admin-route.ts`). */
export const REPORTS_PAGE: AdminPageConfig = { path: "/reports", label: "Reports", icon: "chart" };

/** R-16 caps a `stats` block at 4 items. */
const MAX_STATS_ITEMS = 4;

/** Products the page shows. */
const TOP_PRODUCTS_SHOWN = 10;

/**
 * Products the page READS: the surface's own cap (`MAX_TOP_PRODUCTS_LIMIT`, shared
 * so a lowered cap cannot make this read throw and fail the page closed). The store
 * groups every product in the one order scan it makes whatever the limit, so asking
 * for all of them costs no extra query, and the page can then pick its ten by the
 * metric it shows — by units on several currencies, where the store's revenue order
 * sums minor units across currencies and would drop a cheap best seller.
 */
const TOP_PRODUCTS_READ_LIMIT = MAX_TOP_PRODUCTS_LIMIT;

/**
 * The order states the SERVICE counts as revenue (`REVENUE_COUNTING_STATES` in
 * the domain's reporting port: payment confirmed and not reversed).
 *
 * Counts the "(N paid)" under the cards, and is the average-order-value card's
 * denominator only on a reader too old to carry the per-currency
 * `revenueOrderCount` — either way the orders that produced revenue, never every
 * order placed (which includes `failed`/`expired`/`cancelled`).
 */
const REVENUE_COUNTING_STATES: ReadonlySet<string> = new Set([
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
]);

const MONEY_LOCALE = "en-US";

/**
 * The one page action every table on this screen sets (T-6/R-21: the
 * authoritative `TableBlock.page_action_id` is REQUIRED, even though nothing on
 * this screen can page). Registered as a no-op re-render so that, should it ever
 * fire, it does not fall through the dispatcher to a blank `{blocks: []}`.
 */
export const REPORTS_PAGE_ACTION_ID = "reports:page";

/**
 * The custom From/To form's submit. A REAL action — it fires on every custom
 * period — so an unregistered id would blank the console. Pinned by the sandbox
 * suite, which fires this id and asserts the page still renders.
 */
export const REPORTS_RANGE_ACTION_ID = "reports:apply-range";

export { REPORTS_PERIOD_ACTION_ID };

export const REPORTS_ACTION_IDS: ReadonlySet<string> = new Set([
	REPORTS_PAGE_ACTION_ID,
	REPORTS_RANGE_ACTION_ID,
	REPORTS_PERIOD_ACTION_ID,
]);

export interface ReportsPageInput {
	type?: unknown;
	/** A `block_action`'s id — the period select fires {@link REPORTS_PERIOD_ACTION_ID}. */
	action_id?: unknown;
	/** A `block_action`'s value — the period select's chosen preset id. */
	value?: unknown;
	/** A preset id on a `page_load`. */
	preset?: unknown;
	from?: unknown;
	to?: unknown;
	/** A `form_submit` carries its fields here (em-dash `BlockInteraction`), which
	 *  is where the custom form's `from`/`to` arrive. */
	values?: unknown;
	block_id?: unknown;
}

/** The period in ABSOLUTE dates — `1 Jul – 31 Jul 2026`. The year is stated
 *  once when both ends share it, twice when they do not. */
function absolutePeriod(range: Pick<ReportPeriod, "fromDay" | "toDay">): string {
	const sameYear = range.fromDay.slice(0, 4) === range.toDay.slice(0, 4);
	return `${formatDay(range.fromDay, !sameYear)} – ${formatDay(range.toDay, true)}`;
}

/**
 * The Reports page. Seven reads on the surface `makeAdminClients` hands over —
 * revenue, orders-by-status, top products (one read, ranked on the page), low stock
 * and settings for the period, plus revenue and orders-by-status for the
 * PREVIOUS period. All but top
 * products and low stock read the `reporting_daily` rollup (day documents, never
 * a per-order scan), so the comparison costs two more range reads of the same
 * documents.
 *
 * Fails CLOSED: any error from a current-period read — including one raised while
 * the surface is CONSTRUCTED — renders the E-7 fail-closed banner rather than
 * throwing into the host. A failing PREVIOUS-period read only costs the deltas
 * ("No comparison available"); the period's own figures still render.
 */
export function createReportsPageHandler(): RouteHandler<ReportsPageInput> {
	return async (routeCtx, ctx) => {
		// Cosmetic label from ctx.kv (never the service) — the display-only tier.
		const displayName = (await ctx.kv.get<string>("settings:storeDisplayName")) ?? "Store";

		try {
			// Inside the try as defence in depth: the resolver refuses every bound it
			// cannot shift or label, but a throw here would otherwise escape into the
			// host rather than land on the fail-closed screen.
			const range = resolveReportsRange(routeCtx.input);
			// CONSTRUCTED INSIDE THE TRY, deliberately: the in-process branch builds
			// every commerce adapter over `ctx.storage` and THROWS at construction
			// when that store is absent.
			const { reporting: client } = await makeAdminClients(ctx);
			const settingsRead = client.getSettings().catch(() => undefined);
			const revenueRead = client.getRevenue(range, "day");
			const [revenue, statuses, top, low, settings, previousRevenue, previousStatuses] =
				await Promise.all([
					revenueRead,
					client.getOrdersByStatus(range),
					client.getTopProducts(range, "revenue", TOP_PRODUCTS_READ_LIMIT),
					// An explicit threshold avoids a second settings read inside the report.
					settingsRead.then((savedSettings) =>
						client.getLowStock(
							savedSettings?.lowStockThreshold ?? DEFAULT_OPERATIONAL_SETTINGS.lowStockThreshold,
						),
					),
					settingsRead,
					client.getRevenue(range.previous, "day").catch(() => undefined),
					client.getOrdersByStatus(range.previous).catch(() => undefined),
				]);
			return buildReportsBlocks({
				displayName,
				range,
				revenue,
				statuses,
				top,
				low,
				...(previousRevenue !== undefined ? { previousRevenue } : {}),
				...(previousStatuses !== undefined ? { previousStatuses } : {}),
				...(settings !== undefined ? { lowStockThreshold: settings.lowStockThreshold } : {}),
				...(settings?.currency !== undefined ? { storeCurrency: settings.currency } : {}),
			});
		} catch {
			// Fail CLOSED with E-7's normative copy — never leak a raw status/URL, and
			// never claim a single external cause: this path also catches a bug in
			// this console's own code, so the copy says so.
			return failClosedResponse({
				header: `${displayName} — Reports`,
				title: "Reports are unavailable",
				description:
					"Reports could not be loaded. Retry in a moment; if it keeps failing, this is a fault in the console itself — not your data.",
				toast: "Could not load reports",
			});
		}
	};
}

export interface ReportsData {
	displayName: string;
	/** The period every figure on this page covers, and its comparison period. */
	range: ResolvedRange;
	revenue: RevenueBucketWire[];
	statuses: StatusCountWire[];
	/** The products sold, ranked by revenue (the store's order), up to the surface's
	 *  1000-row cap. The page takes its ten: by revenue for one currency, by units
	 *  for several (or none), since a revenue ranking would sum minor units across
	 *  currencies. Rare edge: a period with more than 1000 distinct product/title
	 *  pairs is cut by the store's cross-currency revenue order before the page
	 *  ranks by units. */
	top: TopProductWire[];
	low: LowStockWire[];
	/** The previous period's reads. Absent when they failed: the deltas then say
	 *  "No comparison available" rather than comparing against nothing. */
	previousRevenue?: RevenueBucketWire[];
	previousStatuses?: StatusCountWire[];
	/** The threshold the low-stock rows were selected by, so its heading can state
	 *  it. Absent when the settings read failed. */
	lowStockThreshold?: number;
	/** The SAVED store currency, for the money axis of a period that earned nothing.
	 *  Absent when never saved or when the settings read failed. */
	storeCurrency?: string;
}

export function buildReportsBlocks(data: ReportsData): BlockResponse {
	const phrase = comparisonPhrase(data.range.days);
	// THE CURRENCY MODE OF THIS PAGE IS DECIDED BY REVENUE, NOT BY THE BUCKET
	// LIST (INC-23). A bucket exists when EITHER revenue or a refund contributes,
	// so a single fully-refunded EUR order in a USD store puts an EUR bucket on the
	// wire at `revenueCents: 0`. Read naively, that ONE row would flip the screen
	// into multi-currency: a phantom `€0.00` card, AOV and per-product revenue
	// dashed out, and the Refunded card truncated off R-16's cap. So a currency is
	// a REVENUE currency only when it has a revenue-bearing bucket; everything else
	// is refund-only and handled as refunds.
	const revenueCurrencies = new Set(data.revenue.filter(isRevenueBearing).map((b) => b.currency));
	const revenueBuckets = data.revenue.filter((b) => revenueCurrencies.has(b.currency));
	const refundOnlyCurrencies = [
		...new Set(
			data.revenue.filter((b) => !revenueCurrencies.has(b.currency)).map((b) => b.currency),
		),
	].toSorted((a, b) => a.localeCompare(b));

	const totalByCurrency = new Map<string, number>();
	for (const b of revenueBuckets) {
		totalByCurrency.set(b.currency, (totalByCurrency.get(b.currency) ?? 0) + b.revenueCents);
	}
	// Selected AND ordered by a NON-COMPARATIVE, deterministic rule — alphabetical
	// ISO code. Ranking by revenue would numerically compare incommensurable minor
	// units (JPY vs USD). The rule is disclosed to the operator.
	const byCurrencyCode = [...totalByCurrency.entries()].toSorted((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const multiCurrency = byCurrencyCode.length > 1;
	const singleCurrency =
		byCurrencyCode.length === 1 ? toCurrency(byCurrencyCode[0]![0]) : undefined;

	const previousTotal = (code: string): number | undefined =>
		data.previousRevenue === undefined
			? undefined
			: data.previousRevenue
					.filter((b) => b.currency === code)
					.reduce((sum, b) => sum + b.revenueCents, 0);

	const revenueTiles: StatItem[] =
		byCurrencyCode.length === 0
			? [{ label: "Total sales", value: "—", description: "No paid orders in this period" }]
			: byCurrencyCode.map(([currencyCode, revenueCents]) => ({
					label: multiCurrency ? `Total sales (${currencyCode})` : "Total sales",
					value: formatMoney(toCents(revenueCents), toCurrency(currencyCode), MONEY_LOCALE),
					...periodChange(revenueCents, previousTotal(currencyCode), phrase),
				}));

	const orderCount = data.statuses.reduce((sum, s) => sum + s.orderCount, 0);
	const paidOrderCount = paidOrders(data.statuses);
	const previousOrderCount = data.previousStatuses?.reduce((sum, s) => sum + s.orderCount, 0);
	const ordersTile: StatItem = {
		label: "Orders",
		value: String(orderCount),
		// NO TREND ARROW: the count covers every status (cancelled and refunded
		// included), so a rise is not good news; the signed delta still says which way.
		description: periodChange(orderCount, previousOrderCount, phrase).description,
	};
	const aovTile = averageOrderValueTile({
		byCurrencyCode,
		singleCurrency,
		// The orders behind THIS currency's revenue, not every paid order (which
		// spans every currency). A reader older than `revenueOrderCount` falls back
		// to the paid-status count, as this card always did.
		orderCount:
			singleCurrency === undefined
				? paidOrderCount
				: (revenueOrdersFor(revenueBuckets, singleCurrency) ?? paidOrderCount),
		previous:
			singleCurrency === undefined
				? { kind: "unknown" }
				: previousAverage(data.previousRevenue, singleCurrency),
		phrase,
	});
	// The Refunded card's currency: the revenue currency when there is exactly one,
	// else — when NOTHING earned but something came back — the single refund-only
	// currency. Anything genuinely plural stays "—".
	const refundedCurrency =
		singleCurrency ??
		(byCurrencyCode.length === 0 && refundOnlyCurrencies.length === 1
			? toCurrency(refundOnlyCurrencies[0]!)
			: undefined);
	const refundedTile = refundedTileFor({
		revenue: data.revenue,
		statuses: data.statuses,
		currency: refundedCurrency,
		previousRevenue: data.previousRevenue,
		phrase,
	});
	const allTiles: StatItem[] = [...revenueTiles, ordersTile, aovTile, refundedTile];
	const items: StatItem[] = allTiles.slice(0, MAX_STATS_ITEMS);
	// The cards that fall off R-16's cap are NAMED — a card that vanishes without a
	// word is a silence this page refuses (DA-7).
	const droppedTileNames = allTiles.slice(MAX_STATS_ITEMS).map((tile) => tileName(tile.label));

	const blocks: Block[] = [
		{ type: "header", text: `${data.displayName} — Reports` },
		{
			type: "context",
			// The period FIRST, in absolute dates, and the period it is compared with.
			text: `${absolutePeriod(data.range)} (UTC) · compared with ${absolutePeriod(data.range.previous)}`,
		},
		...(data.range.problem !== undefined ? [rangeProblemBanner(data.range.problem)] : []),
		periodPicker(data.range),
		...(data.range.preset === "custom" ? [customRangeForm(data.range)] : []),
		{ type: "stats", items },
		...(droppedTileNames.length > 0
			? [
					{
						type: "context" as const,
						text: `${listPhrase(droppedTileNames)} ${droppedTileNames.length === 1 ? "is" : "are"} not shown: the four cards are taken by one sales card per currency.`,
					},
				]
			: []),
		{
			type: "context",
			// What the cards count, said ONCE under them rather than crowding each card:
			// Orders ÷ Total sales is not the AOV beside it (AOV divides by PAID orders),
			// and the Refunded figure is retro-mutable and excludes refunds in flight.
			text: `Orders counts every status (${paidOrderCount} paid). Refunded is by order date: a later refund changes this figure; refunds in progress are excluded.`,
		},
		...refundOnlyNotes(data.revenue, refundOnlyCurrencies, refundedCurrency),
		...salesSection(data, revenueBuckets, singleCurrency, multiCurrency),
		{
			type: "columns",
			columns: [ordersSection(data), statusesSection(data.statuses)],
		},
		{
			type: "columns",
			columns: [topSection(data, singleCurrency), lowStockSection(data)],
		},
	];
	return { blocks };
}

function paidOrders(statuses: readonly StatusCountWire[]): number {
	return statuses.reduce(
		(sum, s) => (REVENUE_COUNTING_STATES.has(s.status) ? sum + s.orderCount : sum),
		0,
	);
}

/**
 * Total sales over time. A chart when the period has ONE revenue currency (or
 * none: an empty period draws a flat line at $0). With several, the series cannot
 * share a money axis — adding or overlaying JPY and USD minor units is the one
 * thing this screen never does — so the per-day figures render as a sparse
 * table, each row in its own currency, with the reason stated.
 */
function salesSection(
	data: ReportsData,
	revenueBuckets: RevenueBucketWire[],
	singleCurrency: Currency | undefined,
	multiCurrency: boolean,
): Block[] {
	const note = "Net order totals of paid-and-later orders, by order date (UTC).";
	if (multiCurrency) {
		const table: TableBlock = {
			type: "table",
			block_id: "reports:revenue-table",
			columns: [
				{ key: "bucketStart", label: "Day" },
				{ key: "revenue", label: "Sales" },
			],
			rows: revenueBuckets.map((b) => ({
				bucketStart: b.bucketStart.slice(0, 10),
				revenue: formatMoney(toCents(b.revenueCents), toCurrency(b.currency), MONEY_LOCALE),
			})),
			page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
			empty_text: "No sales in this period.",
		};
		return section({
			blockId: "reports:sales",
			title: "Total sales over time",
			blocks: [
				{
					type: "context",
					text: "This period spans several currencies, so sales are listed per day in each one rather than charted on one axis. Days with no sales are omitted.",
				},
				{
					type: "context",
					text: "Cards are ordered alphabetically by currency code: amounts in different currencies are never compared.",
				},
				table,
			],
		});
	}
	const previousCurrencies = [
		...new Set((data.previousRevenue ?? []).filter(isRevenueBearing).map((b) => b.currency)),
	];
	const currency = singleCurrency ?? emptyPeriodCurrency(data, previousCurrencies);
	const current = timeBuckets(data.range, data.revenue, currency);
	// An empty period over a previous period in SEVERAL currencies has no currency
	// to draw the previous line in, and drawing it in the store's would pass off
	// another currency's sales as its own: the line is left out, without a note.
	const omitPrevious = singleCurrency === undefined && previousCurrencies.length > 1;
	// A previous period that failed to load has no series either: an empty one
	// would draw a dashed zero line beside a legend saying it could not be loaded.
	const previous =
		omitPrevious || data.previousRevenue === undefined
			? undefined
			: timeBuckets(data.range.previous, data.previousRevenue, currency);
	const points = pointsNote(data.range.days);
	return section({
		blockId: "reports:sales",
		title: "Total sales over time",
		note,
		blocks: [
			salesChart({ current, previous, currency }),
			{
				type: "context",
				// The legend the renderer cannot draw (no LegendComponent is registered).
				text: omitPrevious
					? `Solid line: ${absolutePeriod(data.range)}. ${points}`
					: data.previousRevenue === undefined
						? `Solid line: ${absolutePeriod(data.range)}. ${points} The previous period could not be loaded.`
						: `Solid line: ${absolutePeriod(data.range)} · Dashed line: ${absolutePeriod(data.range.previous)} (previous period). ${points}`,
			},
		],
	});
}

/**
 * The currency an EMPTY period's money axis is drawn in (nothing earned, so no
 * revenue currency to take): the previous period's, when it earned in exactly
 * one — so its dashed line is on the axis — else the store's saved currency,
 * else USD (what a store that never saved one trades in). A refund-only or
 * multi-currency previous period names nothing.
 */
function emptyPeriodCurrency(data: ReportsData, previousCurrencies: readonly string[]): Currency {
	const candidates = [
		previousCurrencies.length === 1 ? previousCurrencies[0] : undefined,
		data.storeCurrency,
	];
	const usable = candidates.find(
		(code): code is string => code !== undefined && CURRENCY_CODE.test(code),
	);
	return toCurrency(usable ?? "USD");
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * How the over-time charts are bucketed, as a sentence. A folded series' LAST
 * point usually covers fewer than seven days (365 = 52 × 7 + 1), and drawn
 * without a word it reads as a cliff — so the note says how many it covers.
 */
function pointsNote(days: number): string {
	if (days <= MAX_DAILY_POINTS) return "One point per day.";
	const rest = partialLastPoint(days);
	return rest === undefined
		? "One point per week."
		: `One point per week; the last point covers ${dayPhrase(rest)}.`;
}

/** The days the LAST point of a weekly-folded series covers, or `undefined` when
 *  the series is daily or ends on a whole week. */
function partialLastPoint(days: number): number | undefined {
	if (days <= MAX_DAILY_POINTS) return undefined;
	const rest = days % 7;
	return rest === 0 ? undefined : rest;
}

function dayPhrase(days: number): string {
	return days === 1 ? "1 day" : `${days} days`;
}

function ordersSection(data: ReportsData): Block[] {
	const current: TimeSeries = timeBuckets(data.range, data.revenue, undefined);
	const total = current.points.reduce((sum, p) => sum + p.orders, 0);
	const unit = current.granularity === "day" ? "day" : "week";
	const rest = current.granularity === "week" ? partialLastPoint(data.range.days) : undefined;
	const partial = rest !== undefined ? ` The last point covers ${dayPhrase(rest)}.` : "";
	return section({
		blockId: "reports:orders",
		title: "Orders over time",
		blocks: current.ordersKnown
			? [
					ordersChart(current),
					{
						type: "context",
						text: `Paid orders per ${unit} · ${total} in this period.${partial}`,
					},
				]
			: [{ type: "context", text: "Orders over time is not reported by this store version." }],
	});
}

function statusesSection(statuses: StatusCountWire[]): Block[] {
	const total = statuses.reduce((sum, s) => sum + s.orderCount, 0);
	return section({
		blockId: "reports:statuses",
		title: `Orders by status (${statuses.length})`,
		blocks:
			total === 0
				? [{ type: "context", text: "No orders in this period." }]
				: [
						statusChart(statuses),
						{
							type: "context",
							text: `${total} ${total === 1 ? "order" : "orders"} placed, every status.`,
						},
					],
	});
}

function topSection(data: ReportsData, singleCurrency: Currency | undefined): Block[] {
	// One currency: the revenue ranking, labelled with money. Otherwise the UNITS
	// ranking, taken from the same read (a second quantity scan is the cost this
	// avoids), so "ranked by units" is true of both the selection and the order.
	const top = (
		singleCurrency !== undefined
			? data.top
			: data.top.toSorted((a, b) => b.qtySold - a.qtySold || a.productId.localeCompare(b.productId))
	).slice(0, TOP_PRODUCTS_SHOWN);
	const suppressed = singleCurrency === undefined && top.length > 0;
	return section({
		blockId: "reports:top",
		title: `Top products (${top.length})`,
		blocks:
			top.length === 0
				? [{ type: "context", text: "No sales in this period." }]
				: [
						topProductsChart(top, singleCurrency),
						{
							type: "context",
							text: suppressed
								? "Ranked by units: this period spans more than one currency and the products report carries no per-product currency, so no revenue is stated."
								: "By revenue, from the line prices frozen at purchase.",
						},
					],
	});
}

function lowStockSection(data: ReportsData): Block[] {
	const lowTable: TableBlock = {
		type: "table",
		block_id: "reports:low-table",
		columns: [
			{ key: "title", label: "Title" },
			{ key: "sku", label: "SKU", format: "code" },
			{ key: "onHand", label: "On hand" },
		],
		rows: data.low.map((r) => ({
			// `null` means no live product claims the sku, which is a different fact
			// from the sku itself, so it renders "(untitled)" and never the sku.
			title: r.title ?? "(untitled)",
			sku: r.sku,
			onHand: lowStockOnHandLabel(r.onHand),
		})),
		page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
		empty_text: "Nothing low on stock.",
	};
	return section({
		blockId: "reports:low",
		// The count alone ("Low stock (3)") never said low COMPARED TO WHAT, and
		// the threshold lives in Store settings, a page away. `GET /settings`
		// already returns it, so the heading states it. Omitted — never guessed —
		// when that read failed.
		title:
			data.lowStockThreshold === undefined
				? `Low stock (${data.low.length})`
				: `Low stock (${data.low.length}) — at or below ${data.lowStockThreshold}`,
		blocks: [lowTable],
	});
}

/**
 * The period picker — Shopify's date-range menu: a select whose change re-renders
 * the page at once (em-dash fires a `block_action` with the chosen value when a
 * select sits outside a form). Its `block_id` names the preset, so the
 * uncontrolled select REMOUNTS — and shows the new choice — whenever the period
 * changes.
 */
function periodPicker(range: ResolvedRange): Block {
	return {
		type: "actions",
		block_id: `reports:period-${range.preset}`,
		elements: [
			{
				type: "select",
				action_id: REPORTS_PERIOD_ACTION_ID,
				label: "Date range",
				// The VALUE is the label: the select's trigger shows the raw value
				// (R-17a), so "Last 30 days" — never "30d" — is what it reads.
				initial_value: presetValue(range.preset),
				options: REPORTS_PRESETS.map((p) => ({ label: p.label, value: presetValue(p.id) })),
			},
		],
	};
}

/**
 * The custom period's From/To form, shown while "Custom range" is selected, and
 * kept to a third of the width. `carriedForm` (never a hand-rolled `block_id`):
 * the fields pick up a new `initial_value` only when the form REMOUNTS, and the
 * prefill digest makes the key change whenever the rendered period does.
 */
function customRangeForm(range: ResolvedRange): Block {
	const form: FormBlock = carriedForm({
		namespace: "reports:range",
		form: {
			type: "form",
			fields: [
				{ type: "date_input", action_id: "from", label: "From", initial_value: range.fromDay },
				{ type: "date_input", action_id: "to", label: "To", initial_value: range.toDay },
			],
			submit: { label: "Apply", action_id: REPORTS_RANGE_ACTION_ID },
		},
	});
	return { type: "columns", columns: [[form], [], []] };
}

/** An unusable custom period renders the default period plus this — a 200 with a
 *  banner, never a 4xx (G5), and never a silent substitution. */
function rangeProblemBanner(problem: string): BannerBlock {
	const label = REPORTS_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "";
	return {
		type: "banner",
		variant: "alert",
		title: `Showing the ${label.toLowerCase()}`,
		description: problem,
	};
}

/**
 * Average order value — revenue ÷ the orders that produced it.
 *
 * Never `$0.00` when there were no paid orders (a division with no answer is not
 * zero), and no figure at all when the period spans several currencies. Both
 * render "—" with the reason in the description.
 */
function averageOrderValueTile(args: {
	byCurrencyCode: ReadonlyArray<readonly [string, number]>;
	singleCurrency: Currency | undefined;
	orderCount: number;
	previous: PreviousAverage;
	phrase: string;
}): StatItem {
	const { byCurrencyCode, singleCurrency, orderCount, previous, phrase } = args;
	const label = "Average order value";
	if (singleCurrency === undefined) {
		return {
			label,
			value: "—",
			description:
				byCurrencyCode.length === 0
					? "No paid orders in this period"
					: "Orders in this period span several currencies",
		};
	}
	if (orderCount === 0) {
		return { label, value: "—", description: "No paid orders to average" };
	}
	const averageCents = Math.round((byCurrencyCode[0]?.[1] ?? 0) / orderCount);
	const value = formatMoney(toCents(averageCents), singleCurrency, MONEY_LOCALE);
	switch (previous.kind) {
		case "unknown":
			return { label, value, ...periodChange(averageCents, undefined, phrase) };
		case "none":
			// No orders before is a known fact, said as every other card says it —
			// never a percentage over an average that has no answer.
			return { label, value, description: `No data in ${phrase}` };
		case "average":
			return { label, value, ...periodChange(averageCents, previous.averageCents, phrase) };
	}
}

/** What the AOV card compares with: a previous average, a previous period with
 *  no orders to average, or nothing knowable. */
type PreviousAverage =
	| { kind: "average"; averageCents: number }
	| { kind: "none" }
	| { kind: "unknown" };

/**
 * The previous period's average order value in `code` — its revenue ÷ the orders
 * behind that revenue (`revenueOrderCount`), both for that ONE currency.
 *
 * UNKNOWN (no comparison) when the read failed, when the previous period earned
 * in any other currency (its revenue is not the same kind of figure), or when a
 * bucket lacks the per-currency count. "none" when it earned nothing at all.
 */
function previousAverage(
	previousRevenue: readonly RevenueBucketWire[] | undefined,
	code: string,
): PreviousAverage {
	if (previousRevenue === undefined) return { kind: "unknown" };
	const earning = previousRevenue.filter(isRevenueBearing);
	const currencies = new Set(earning.map((b) => b.currency));
	if (currencies.size === 0) return { kind: "none" };
	if (currencies.size > 1 || !currencies.has(code)) return { kind: "unknown" };
	const orders = revenueOrdersFor(earning, code);
	if (orders === undefined) return { kind: "unknown" };
	if (orders === 0) return { kind: "none" };
	const revenue = earning.reduce((sum, b) => sum + b.revenueCents, 0);
	return { kind: "average", averageCents: Math.round(revenue / orders) };
}

/** Σ `revenueOrderCount` over `code`'s buckets, or `undefined` when any of them
 *  lacks it (a reader older than the field) — never a partial count. */
function revenueOrdersFor(buckets: readonly RevenueBucketWire[], code: string): number | undefined {
	let total = 0;
	for (const b of buckets) {
		if (b.currency !== code) continue;
		if (b.revenueOrderCount === undefined) return undefined;
		total += b.revenueOrderCount;
	}
	return total;
}

/**
 * The line a refund-only currency gets INSTEAD of a revenue card (INC-23).
 *
 * A currency that appears in the window only because money came back in it is
 * NOT a currency this store earned in, so it gets no `€0.00` Revenue card — that
 * card would be a phantom, and (via R-16's four-card cap) it would push the
 * Refunded card off the screen in exactly the case the Refunded card exists to
 * report. The money is still stated, in its OWN currency and never added to
 * another one, in one line under the cards.
 *
 * Emitted only for currencies whose figure is not already on a card: when the
 * whole window is a single refund-only currency, the Refunded card itself states
 * it and a second telling would be noise (T-8a).
 */
function refundOnlyNotes(
	revenue: RevenueBucketWire[],
	refundOnlyCurrencies: readonly string[],
	shownOnCard: Currency | undefined,
): Block[] {
	const parts: string[] = [];
	for (const code of refundOnlyCurrencies) {
		if (code === shownOnCard) continue;
		const currency = toCurrency(code);
		const amount = refundedFor(revenue, currency);
		if (amount === undefined || amount <= 0) continue;
		parts.push(formatMoney(toCents(amount), currency, MONEY_LOCALE));
	}
	if (parts.length === 0) return [];
	// ≤140 chars for a top-level context (X-11) — the amounts are short and the
	// sentence is fixed; a store with enough refund-only currencies to overrun it
	// would be well outside anything this console is built for.
	return [
		{
			type: "context",
			text: `Also refunded: ${listPhrase(parts)} — stated separately because this period earned nothing in ${parts.length === 1 ? "that currency" : "those currencies"}.`,
		},
	];
}

/**
 * `0` reads as "Out of stock", the low band as "Low" — the vocabulary of the
 * stock-visibility increment (INC-04), which the products list now ships as
 * `onHandCell`. THE SEPARATOR IS THAT COLUMN'S: this shipped `0 / Out of stock`
 * while the file was written against an unmerged sibling, and the sibling
 * landed with `0 · Out of stock`. One fact rendered two ways one screen apart
 * is the disagreement INC-10 is closing everywhere else in this pass, so it is
 * closed here too — toward the shipped spelling, not away from it.
 *
 * Deliberately plain text, not `format: "badge"`: every row in this table
 * already sits at or below SOME threshold — that is what selected it into
 * `GET /reports/low-stock` — so a badge column here could legitimately render
 * the identical value on every row (all-zero or all-low is a normal shape for
 * this report), which is X-4 (T-5). Plain text carries the same two words
 * without tripping it. The raw count stays in the cell alongside the word: a
 * bare "Out of stock" would make an operator re-derive whether that means 0 or
 * "some, but running low," and the count is the fact this column is named for.
 */
function lowStockOnHandLabel(onHand: number): string {
	return onHand === 0 ? `${onHand} · Out of stock` : `${onHand} · Low`;
}

/** A tile's name without its currency and period — `Refunded (USD) — last 30
 *  days` → `Refunded` — for naming the cards that did not fit. Exported for its
 *  own test only. */
export function tileName(label: string): string {
	return stripTrailingParenthetical(label.split("—")[0] ?? label).trim();
}

const WHITESPACE = /\s/;

/**
 * Drop a trailing `(…)` group — and the whitespace around it — from `text`.
 *
 * Exactly what `text.replace(/\s*\([^)]*\)\s*$/, "")` does, in linear time.
 * That regex is unanchored on the left, so the engine retries it from every
 * offset and each retry can scan to the end: quadratic on a long run of spaces
 * or of `(` (CodeQL js/polynomial-redos). The match it finds is fully
 * determined, so it is computed directly instead:
 *
 * - it must end the string, so it closes on the LAST `)` before any trailing
 *   whitespace;
 * - `[^)]*` cannot cross a `)`, so its `(` lies after the `)` before that one —
 *   and the leftmost match takes the FIRST such `(`;
 * - the leading `\s*` then reaches back over the whole whitespace run before it.
 */
function stripTrailingParenthetical(text: string): string {
	let end = text.length;
	while (end > 0 && WHITESPACE.test(text.charAt(end - 1))) end--;
	if (end === 0 || text.charAt(end - 1) !== ")") return text;
	const close = end - 1;
	const previousClose = close === 0 ? -1 : text.lastIndexOf(")", close - 1);
	const open = text.indexOf("(", previousClose + 1);
	if (open === -1 || open > close) return text;
	let start = open;
	while (start > 0 && WHITESPACE.test(text.charAt(start - 1))) start--;
	return text.slice(0, start);
}

/** `Orders, AOV and Refunded` — an English list. Kept here rather than in a
 *  shared helper because this is its only caller. */
function listPhrase(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Refunded money for the period — a real figure since the revenue wire started
 * carrying `refundedCents` (INC-23). This tile used to render "—" on every
 * store, because the amount existed nowhere on the wire: `/reports/revenue`
 * EXCLUDED refunded orders from its allow-list rather than reporting them, and
 * `/reports/orders-by-status` carries counts only.
 *
 * THE DASH IS NOW RESERVED FOR THE THREE CASES THAT GENUINELY HAVE NO ANSWER,
 * and `$0.00` is emitted the moment there is one:
 *
 *  - the buckets carry NO `refundedCents` key — a service older than the field.
 *    Detected by KEY PRESENCE, never by a zero value: `0` is the fact "nothing
 *    came back", and reading an absent field as `0` would turn "this service
 *    cannot tell you" into a confident "nothing was refunded", which is the
 *    exact failure this whole increment exists to remove;
 *  - the window spans several currencies (as AOV does — summing incommensurable
 *    minor units produces a number that means nothing);
 *  - the window has no orders at all, so there is no bucket to read a key from.
 *
 * Zero with the key present renders `$0.00`, because a period in which nothing
 * was refunded is a FACT a merchant is entitled to read as one.
 *
 * The description is the change against the previous period. The COHORT (orders
 * placed in the period, finalized refunds only, retro-mutable) is stated once in
 * the line under the cards, since it changes what the number means.
 */
function refundedTileFor(args: {
	revenue: RevenueBucketWire[];
	statuses: StatusCountWire[];
	currency: Currency | undefined;
	previousRevenue: RevenueBucketWire[] | undefined;
	phrase: string;
}): StatItem {
	const { revenue, statuses, currency, previousRevenue, phrase } = args;
	const refundedOrders = statuses.find((s) => s.status === "refunded")?.orderCount ?? 0;
	const label = "Refunded";
	if (currency === undefined) {
		return {
			label,
			value: "—",
			description:
				revenue.length === 0 ? "No orders in this period" : "This period spans several currencies",
		};
	}
	const totalCents = refundedFor(revenue, currency);
	if (totalCents === undefined) {
		// The pre-INC-23 wire. Say what IS known (the fully-refunded order count,
		// which `orders-by-status` has always carried) and what is missing — never
		// a zero standing in for an unknown (DA-7).
		const known =
			refundedOrders === 0
				? "No fully refunded orders"
				: `${refundedOrders} fully refunded ${refundedOrders === 1 ? "order" : "orders"}`;
		return { label, value: "—", description: `${known}; refunded amount not yet reported` };
	}
	// NO TREND ARROW: the renderer colours by direction (up green, down red), and
	// more money refunded is not good news. The signed delta still says which way.
	const { description } = periodChange(
		totalCents,
		previousRevenue === undefined ? undefined : refundedFor(previousRevenue, currency),
		phrase,
	);
	return { label, value: formatMoney(toCents(totalCents), currency, MONEY_LOCALE), description };
}

/**
 * Σ refunded for ONE currency across the window, or `undefined` when any of that
 * currency's buckets fails to carry a usable figure.
 *
 * Absent-or-unusable is ALL-OR-NOTHING on purpose: a partial sum would be a
 * number smaller than the truth wearing the same formatting as a complete one,
 * which is worse than the dash it falls back to (M-1).
 */
function refundedFor(revenue: RevenueBucketWire[], currency: Currency): number | undefined {
	let total = 0;
	for (const b of revenue) {
		if (b.currency !== currency) continue;
		const amount = readRefunded(b);
		if (amount === undefined) return undefined;
		total += amount;
	}
	return total;
}

/**
 * Whether a bucket is on the wire because of REVENUE (INC-23). Since the revenue
 * report started carrying refunds, a bucket exists when either half contributes,
 * so this is what separates "a day that earned" from "a day that only gave money
 * back" — and, one level up, a currency the store trades in from one that merely
 * appears in a refund.
 *
 * A bucket with no revenue AND no refunds is counted as revenue-bearing, not as
 * refund-only: it can only have come from the revenue half (a genuinely free
 * order at `total_cents: 0`), and — the case that matters far more — it is what
 * EVERY bucket looks like on a service that predates `refundedCents`, which must
 * keep behaving exactly as it did.
 */
function isRevenueBearing(b: RevenueBucketWire): boolean {
	return b.revenueCents > 0 || (readRefunded(b) ?? 0) === 0;
}

/**
 * Read one bucket's refunded amount off the wire, keeping ABSENT and ZERO apart
 * (the whole point of the field):
 *
 *  - a number — a known amount, `0` included;
 *  - `undefined` — the response carried no `refundedCents` at all, i.e. a
 *    service older than the field.
 *
 * A value that is present but UNUSABLE — not a number, not a safe integer (money
 * is integer minor units; `19.99` reaching a `Cents` field is the float bug this
 * codebase is built to refuse), or negative (a refund that gave money back to
 * the store is not a thing this page can render) — is read as `undefined` too,
 * so it lands on the same stated-gap path rather than being formatted. The
 * screen-level fail-closed banner still covers a genuinely broken response
 * shape; this is the narrower "the key is there and I cannot use it" case, and
 * a dash with a reason beats a confidently wrong money value (M-1).
 */
function readRefunded(b: RevenueBucketWire): number | undefined {
	const raw: unknown = (b as { refundedCents?: unknown }).refundedCents;
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return undefined;
	return raw;
}

/** Re-export for the settings label helper. */
export type { OperationalSettingsWire };
