import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { type Currency, cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	AccordionBlock,
	AdminPageConfig,
	BannerBlock,
	Block,
	BlockResponse,
	FormBlock,
	RouteHandler,
	StatItem,
	TableBlock,
} from "../types.js";
import { carriedForm, decodeCarrier, failClosedResponse } from "./scaffold/index.js";
import { INTERNAL_TOKEN_KEY } from "./settings-form.js";
import {
	type LowStockWire,
	type OperationalSettingsWire,
	ReportingSettingsClient,
	type RevenueBucketWire,
	type StatusCountWire,
	type TopProductWire,
} from "./reporting-client.js";

/** The admin Reports page's `admin.pages` manifest entry (§4.1). The page
 *  renders numbers and tables, NOT a chart.
 *
 *  Block Kit does ship a charting primitive — `chart` is ECharts-backed and has
 *  been dispatched by the renderer since ≤0.15.0 (an earlier version of this
 *  comment claimed otherwise and was wrong). The reason it is unused here is
 *  narrower and load-bearing: the renderer strips `formatter`, `rich`,
 *  `graphic` and `axisPointer` as XSS vectors, so a series cannot carry a money
 *  formatter — axis ticks and tooltips would print raw integer minor units
 *  (9900, not $99.00), which is exactly the money-display rule this console is
 *  built around. A continuous, formatted two-column table shows the same shape
 *  and states every figure in its currency. A chart over a NON-money series is
 *  a different question and is not ruled out by this.
 *
 *  Rendered by the single `admin` dispatch route (see `admin-route.ts`). */
export const REPORTS_PAGE: AdminPageConfig = { path: "/reports", label: "Reports", icon: "chart" };

/** Trailing 30 days (UTC), the plugin-side default — SURFACED, never silent:
 *  every KPI label says "last 30 days" and the subtitle states the two absolute
 *  dates it resolved to. (A UX nicety only — the service enforces the 400-day
 *  cap regardless, §4.4.) */
const DEFAULT_RANGE_DAYS = 30;

/** The service's own cap (§4.4). Checked here so a too-wide range renders THIS
 *  page with a banner naming the limit, instead of three 400s collapsing into
 *  the generic "Reports are unavailable" fail-closed screen — same outcome for
 *  the operator either way (a 200 with a banner), but only one of them says
 *  what to do next. */
const MAX_RANGE_DAYS = 400;

/** R-16 caps a `stats` block at 4 items. */
const MAX_STATS_ITEMS = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The order states the SERVICE counts as revenue (`REVENUE_COUNTING_STATES` in
 * the domain's reporting port: payment confirmed and not reversed). Mirrored
 * here — like every other wire fact this package uses — because the plugin
 * never imports `@otta-sh/domain`.
 *
 * Used for ONE thing: the denominator of the average-order-value tile, so AOV
 * divides revenue by the orders that actually produced it rather than by every
 * order placed (which includes `failed`/`expired`/`cancelled`). If the service
 * ever widens its allow-list, this list going stale would move AOV's
 * denominator only — which is why the tile states its own denominator in its
 * description instead of leaving the operator to infer it.
 */
const REVENUE_COUNTING_STATES: ReadonlySet<string> = new Set([
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
]);

/** Day-first date rendering (`1 Jul 2026`), so a range reads as
 *  `1 Jul – 31 Jul 2026` rather than `Jul 1 – Jul 31, 2026`. Localization comes
 *  from Intl, never from hand-assembled month names (G6). */
const DATE_LOCALE = "en-GB";
const MONEY_LOCALE = "en-US";

/**
 * The one page action every table on this screen sets (T-6/R-21: the
 * authoritative `TableBlock.page_action_id` is REQUIRED, even though nothing
 * on this screen can page — no `next_cursor`, no `sortable` column). It must
 * be registered as a no-op in the SAME change as the tables that set it:
 * `admin-route.ts` dispatches `SETTINGS_ACTION_IDS`/`ORDERS_ACTION_IDS`/etc.
 * but had NO `REPORTS_ACTION_IDS`, so a reports page action that ever fired
 * fell through to the dispatcher's `{blocks: []}` fallback — a blank console.
 * Nothing can fire this today (a sort needs `sortable`, forbidden by T-3; a
 * load-more needs `next_cursor`, never set here), which is exactly why it was
 * a LATENT trap rather than a failing test — it arms itself the instant
 * someone adds a `next_cursor` or a `sortable` column without also touching
 * this registration.
 */
export const REPORTS_PAGE_ACTION_ID = "reports:page";

/**
 * The From/To period form's submit. It is a REAL action — unlike
 * {@link REPORTS_PAGE_ACTION_ID} it fires on every period change — so the
 * registration below is not a latent precaution: an unregistered id falls
 * through the dispatcher to `{blocks: []}`, and the operator's period change
 * would blank the console. Pinned by the sandbox suite, which fires this id and
 * asserts the response still renders the page.
 */
export const REPORTS_RANGE_ACTION_ID = "reports:apply-range";

export const REPORTS_ACTION_IDS: ReadonlySet<string> = new Set([
	REPORTS_PAGE_ACTION_ID,
	REPORTS_RANGE_ACTION_ID,
]);

export interface ReportsPageInput {
	from?: unknown;
	to?: unknown;
	interval?: unknown;
	/** A `form_submit` carries its fields here (em-dash's `BlockInteraction`),
	 *  which is where the period form's `from`/`to` arrive. The top-level
	 *  `from`/`to` above stay supported: they are the shape a `page_load` can
	 *  carry. */
	values?: unknown;
	/** The originating form's `block_id`, echoed back on submit — the invisible
	 *  channel the period form carries `interval` through (there is no visible
	 *  field for it, and none is wanted). */
	block_id?: unknown;
}

/**
 * The period this render is answering for, resolved ONCE and threaded into
 * every read, every KPI label and the subtitle — the whole point of the
 * increment is that these three can never disagree.
 *
 * `from`/`to` are the ISO instants sent to the service; `fromDay`/`toDay` are
 * the `YYYY-MM-DD` values the `date_input`s prefill with. `isDefault` is what
 * lets a label say "last 30 days" (true, and useful) rather than repeating the
 * absolute dates the subtitle already states. `problem` is set when the
 * operator submitted something unusable — the range falls back to the default
 * and the page renders the reason as a banner (never a 4xx: G5).
 */
interface ResolvedRange {
	from: string;
	to: string;
	fromDay: string;
	toDay: string;
	isDefault: boolean;
	problem?: string;
}

/**
 * The trailing-30-day default, built from WHOLE DAYS through the same
 * {@link rangeFromDays} the form's own submit uses.
 *
 * It used to be instant-based (`now - 30d` → `now`), and every surface above it
 * presents days: the subtitle said `1 Jul – 31 Jul 2026` while the query ran
 * `…T17:54:33Z` to `…T17:54:33Z`, so re-submitting the untouched prefill —
 * which resolves to whole days — returned DIFFERENT figures under an identical
 * subtitle; the zero-fill drew a ~6-hour partial first day as a whole-day row
 * that could read `$0.00`; and "last 30 days" spanned 31 day-rows. Whole days
 * make the default and a hand-entered identical period the SAME query, and
 * `DEFAULT_RANGE_DAYS` day-rows exactly (today counts as one of them).
 */
function defaultRange(problem?: string): ResolvedRange {
	const toDay = dayOf(new Date());
	const fromDay = dayOf(
		new Date(Date.parse(`${toDay}T00:00:00.000Z`) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS),
	);
	return {
		...rangeFromDays(fromDay, toDay),
		isDefault: true,
		...(problem !== undefined ? { problem } : {}),
	};
}

/** A day pair → the resolved instants, `from` at the start of its day and `to`
 *  at the end of its. The ONE place a period becomes a query, so a default
 *  period and a typed one can never resolve differently. */
function rangeFromDays(fromDay: string, toDay: string): Omit<ResolvedRange, "isDefault"> {
	return {
		from: `${fromDay}T00:00:00.000Z`,
		to: `${toDay}T23:59:59.999Z`,
		fromDay,
		toDay,
	};
}

/** The `YYYY-MM-DD` (UTC) a moment falls on.
 *
 *  TWIN: `orders-page.ts`'s `dayOf`/`startOfDay`/`endOfDay` say the same three
 *  things — the two screens now share ONE date-bounds convention (whole days,
 *  both ends inclusive) and each keeps a private copy. The shared timestamp
 *  formatter increment is where both should land. */
function dayOf(at: Date): string {
	return at.toISOString().slice(0, 10);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A submitted bound → an instant. A `date_input` yields `YYYY-MM-DD`, which is
 * a DAY, not an instant: the `to` bound therefore resolves to the END of that
 * day, because the service's window is inclusive and `2026-07-31T00:00:00Z`
 * would silently drop every order placed on the last day the operator asked
 * for. A full ISO string (the `page_load` shape) is taken as given.
 */
function parseBound(value: string, edge: "from" | "to"): Date | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const raw = DAY_PATTERN.test(trimmed)
		? `${trimmed}${edge === "from" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`
		: trimmed;
	const at = new Date(raw);
	return Number.isNaN(at.getTime()) ? undefined : at;
}

/** A `from`/`to` pair from wherever this interaction carried it: a form submit's
 *  `values`, else the route input itself. */
function readBounds(input: ReportsPageInput): { from?: string; to?: string } {
	const values =
		typeof input.values === "object" && input.values !== null
			? (input.values as Record<string, unknown>)
			: {};
	const from = values["from"] ?? input.from;
	const to = values["to"] ?? input.to;
	return {
		...(typeof from === "string" ? { from } : {}),
		...(typeof to === "string" ? { to } : {}),
	};
}

/**
 * Resolve the period, falling back to the trailing-30-day default with a stated
 * reason on anything unusable. EVERY branch returns a range: this handler has no
 * failure mode that is allowed to be a non-2xx (G5), and a period the operator
 * cannot see is the defect this page is being fixed for — so a rejected range
 * announces itself instead of silently answering a different question.
 */
function resolveRange(input: ReportsPageInput): ResolvedRange {
	const bounds = readBounds(input);
	const hasFrom = bounds.from !== undefined && bounds.from.trim().length > 0;
	const hasTo = bounds.to !== undefined && bounds.to.trim().length > 0;
	if (!hasFrom && !hasTo) return defaultRange();
	if (!hasFrom || !hasTo) {
		return defaultRange("Enter both a From and a To date to report on a custom period.");
	}
	const from = parseBound(bounds.from ?? "", "from");
	const to = parseBound(bounds.to ?? "", "to");
	if (from === undefined || to === undefined) {
		return defaultRange("Enter both dates as a calendar date, then update the period.");
	}
	// Snap to whole days FIRST, then judge the snapped period — this screen has
	// no surface that presents a time of day, so a period carrying one would be a
	// window the operator can neither see nor reproduce, and every check has to
	// run on the window actually queried.
	const fromDay = dayOf(from);
	const toDay = dayOf(to);
	if (fromDay > toDay) {
		return defaultRange("The From date falls after the To date. Swap them, then update again.");
	}
	// Judged on the SNAPPED span, never the raw one: `2025-01-01T23:59Z` to
	// `2026-02-05T00:01Z` is 399 raw days but 401 whole days, so a raw check
	// waved it through, the service answered 400 to all three reads, and the page
	// collapsed into the generic fail-closed banner — which names a service
	// connection or a console bug, never the cap the operator actually hit.
	if (dayCount(fromDay, toDay) > MAX_RANGE_DAYS) {
		return defaultRange(
			`A reporting period covers up to ${MAX_RANGE_DAYS} days. Choose a shorter one.`,
		);
	}
	return { ...rangeFromDays(fromDay, toDay), isDefault: false };
}

/** Whole days from `fromDay` to `toDay` INCLUSIVE — the unit the service caps,
 *  the table rows, and the labels all count in. */
function dayCount(fromDay: string, toDay: string): number {
	const start = Date.parse(`${fromDay}T00:00:00.000Z`);
	const end = Date.parse(`${toDay}T00:00:00.000Z`);
	return Math.round((end - start) / DAY_MS) + 1;
}

/**
 * The bucket granularity, from the route input or — on a period submit, which
 * carries no route input — from the form's own carrier.
 *
 * A `form_submit` replaces the whole interaction: without the carrier, changing
 * the period on a weekly report silently dropped it back to daily, and nothing
 * on screen said so. The form has no visible interval field (and wants none),
 * so it rides in `block_id`, which is the one thing a form echoes back.
 */
function resolveInterval(input: ReportsPageInput): "day" | "week" | "month" {
	const carried = decodeCarrier(input.block_id)?.["interval"];
	const raw = input.interval ?? carried;
	return raw === "week" || raw === "month" ? raw : "day";
}

/** `1 Jul` / `1 Jul 2026` (UTC), through Intl so the console stays localizable
 *  and RTL-safe (G6). */
function formatDay(day: string, withYear: boolean): string {
	const at = new Date(`${day}T00:00:00.000Z`);
	return new Intl.DateTimeFormat(DATE_LOCALE, {
		timeZone: "UTC",
		day: "numeric",
		month: "short",
		...(withYear ? { year: "numeric" as const } : {}),
	}).format(at);
}

/** The period in ABSOLUTE dates — `1 Jul – 31 Jul 2026`. The year is stated
 *  once when both ends share it, twice when they do not. */
function absolutePeriod(range: ResolvedRange): string {
	const sameYear = range.fromDay.slice(0, 4) === range.toDay.slice(0, 4);
	return `${formatDay(range.fromDay, !sameYear)} – ${formatDay(range.toDay, true)}`;
}

/** What a KPI label says the figure covers. The default range names itself
 *  ("last 30 days" — shorter, and it tells the operator the period is the
 *  default rather than something they chose); a chosen range states its dates,
 *  because "last 30 days" would then be a lie. */
function periodSuffix(range: ResolvedRange): string {
	return range.isDefault ? `last ${DEFAULT_RANGE_DAYS} days` : absolutePeriod(range);
}

/**
 * The Reports page (§4.1 skeleton; `docs/admin/ADMIN-CONSOLE.md` §12.5).
 * Composes four Block Kit sections, each backed by one `/reports/*` call over
 * `ctx.http` via `ReportingSettingsClient`. Fails CLOSED: any `ctx.http` error
 * (allowlist rejection or a non-2xx) renders the E-7 fail-closed banner rather
 * than throwing into the host. Also handles the (currently unreachable)
 * `reports:page` no-op action by re-rendering the page unchanged, and the
 * period form's `reports:apply-range` submit by re-rendering it for the
 * submitted period — this function reads its range from `routeCtx.input`
 * (top-level, or a form submit's `values`) regardless of which of the three
 * interaction types delivered it.
 */
export function createReportsPageHandler(): RouteHandler<ReportsPageInput> {
	return async (routeCtx, ctx) => {
		const range = resolveRange(routeCtx.input);
		const interval = resolveInterval(routeCtx.input);
		// Cosmetic label from ctx.kv (never the service) — the display-only tier.
		const displayName = (await ctx.kv.get<string>("settings:storeDisplayName")) ?? "Store";

		// The guarded /reports/* reads need X-Internal-Token, but em-dash's
		// page_load carries NO token — source it from write-only kv (set via the
		// Settings form's masked secret field), never from the interaction.
		const adminToken = (await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? undefined;
		const client = new ReportingSettingsClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(adminToken !== undefined ? { adminToken } : {}),
		});
		try {
			const [revenue, statuses, top, low, settings] = await Promise.all([
				client.getRevenue(range, interval),
				client.getOrdersByStatus(range),
				client.getTopProducts(range, "revenue", 10),
				client.getLowStock(),
				// The low-stock THRESHOLD is a label, not a figure: a settings read
				// that fails must not take the whole screen down with it, so this one
				// read degrades to an unlabelled "Low stock (3)" instead of joining
				// the fail-closed set above.
				client.getSettings().catch(() => undefined),
			]);
			return buildReportsBlocks({
				displayName,
				interval,
				range,
				revenue,
				statuses,
				top,
				low,
				...(settings !== undefined ? { lowStockThreshold: settings.lowStockThreshold } : {}),
			});
		} catch {
			// Fail CLOSED with E-7's normative copy — never leak the raw HTTP
			// status/URL (e.g. an auth 401 from a missing/expired admin token), and
			// never claim a single external cause: this path also catches a bug in
			// this console's own code, so the copy says so.
			return failClosedResponse({
				header: `${displayName} — Reports`,
				title: "Reports are unavailable",
				description:
					"Reports could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
				toast: "Could not load reports",
			});
		}
	};
}

interface ReportsData {
	displayName: string;
	interval: "day" | "week" | "month";
	/** The period every figure on this page covers. */
	range: ResolvedRange;
	revenue: RevenueBucketWire[];
	statuses: StatusCountWire[];
	top: TopProductWire[];
	low: LowStockWire[];
	/** From `GET /settings` — the threshold the low-stock rows were selected by,
	 *  so its group label can state it. Absent when that read failed. */
	lowStockThreshold?: number;
}

export function buildReportsBlocks(data: ReportsData): BlockResponse {
	const totalByCurrency = new Map<string, number>();
	for (const b of data.revenue) {
		totalByCurrency.set(b.currency, (totalByCurrency.get(b.currency) ?? 0) + b.revenueCents);
	}
	// §12.5's listing asks for these cards ranked "by the most orders" — but
	// `RevenueBucketWire` carries only `revenueCents`, no per-currency order
	// count, and `StatusCountWire.orderCount` is bucketed by ORDER STATUS, not
	// by currency. Director ruling: the ranking is scoped OUT — and that means
	// no comparison across currencies at all, not a different comparison.
	// Sorting by revenue instead of orders was tried and REJECTED on review:
	// it still numerically compares incommensurable units (JPY minor units vs
	// USD) to decide both selection and order, so it reinstates the exact
	// defect (a low-price, high-volume currency can read as ranked below a
	// high-price, low-volume one, confidently wrong, operator can't tell) with
	// a different axis. Single-currency stores never trigger it, which is
	// exactly why it looked fine in review. The fix: select AND order by a
	// NON-COMPARATIVE, deterministic rule — alphabetical ISO currency code.
	// This is reported as an N-1 spec defect (§12.5's listing), and the gap is
	// also disclosed to the OPERATOR below, not only in the PR body (DA-7).
	const byCurrencyCode = [...totalByCurrency.entries()].toSorted((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const period = periodSuffix(data.range);
	// EVERY tile states the period it covers. The subtitle states it too, in
	// absolute dates — a KPI read out of the corner of an eye is the exact thing
	// that used to be read as "all time" or "today", and a figure is only as
	// good as the question it answers.
	const revenueTiles: StatItem[] =
		byCurrencyCode.length === 0
			? [{ label: `Revenue — ${period}`, value: "—", description: "No paid orders in this period" }]
			: byCurrencyCode.map(([currencyCode, revenueCents]) => ({
					label: `Revenue (${currencyCode}) — ${period}`,
					value: formatMoney(toCents(revenueCents), toCurrency(currencyCode), MONEY_LOCALE),
				}));
	// DA-7: no control can fix this (there is nothing to click), so one honest
	// line names the gap and the remedy — rendered, not just disclosed in a
	// PR body. Conditioned on there actually BEING more than one currency
	// (T-8a's discipline: a caveat that cannot apply is noise, not honesty).
	const multiCurrency = byCurrencyCode.length > 1;
	const rankingGapNote =
		"Cards are ordered alphabetically by currency code, not by order volume — the wire carries no per-currency order count. Ranking by volume needs a service change.";

	// Top products' wire (`TopProductWire`) carries `revenueCents` but NO
	// currency field at all — a second, independent wire gap from the stats
	// ranking above. `formatMoney` requires a currency, so this can only be
	// formatted correctly when the whole range is genuinely single-currency
	// (the common case). Multi-currency ranges fall back to "—": a wrong
	// number is worse than a missing one (M-1), and inventing a currency here
	// would be the same category of mistake the stats ranking was scoped out
	// to avoid.
	const singleCurrency =
		byCurrencyCode.length === 1 ? toCurrency(byCurrencyCode[0]![0]) : undefined;

	// The other three tiles (DESIGNER §6: one number in one bordered card, 1 of
	// 4 slots used, ~700px of empty card beside it). Order is Revenue, Orders,
	// AOV, Refunded and the list is TRUNCATED to R-16's four — so a
	// single-currency store (the ordinary case) gets exactly those four, and a
	// multi-currency one spends the slots on the revenue it cannot combine into
	// one figure.
	const orderCount = data.statuses.reduce((sum, s) => sum + s.orderCount, 0);
	const paidOrderCount = data.statuses.reduce(
		(sum, s) => (REVENUE_COUNTING_STATES.has(s.status) ? sum + s.orderCount : sum),
		0,
	);
	const ordersTile: StatItem = {
		label: `Orders — ${period}`,
		value: String(orderCount),
		// Names the paid subset, because Revenue ÷ Orders does NOT equal the AOV
		// beside it: this count includes cancelled, failed and expired orders,
		// which produce no revenue. Without the second number the two tiles read
		// as an arithmetic error.
		description: `Every status; ${paidOrderCount} paid`,
	};
	const aovTile = averageOrderValueTile(byCurrencyCode, singleCurrency, paidOrderCount, period);
	const refundedTile = refundedTileFor(data.statuses, singleCurrency, period);
	const allTiles: StatItem[] = [...revenueTiles, ordersTile, aovTile, refundedTile];
	const items: StatItem[] = allTiles.slice(0, MAX_STATS_ITEMS);
	// R-16's cap is four cards. A multi-currency window spends them on revenue it
	// cannot combine into one figure, so the tiles that fall off the end are
	// NAMED — a card that vanishes without a word is the same silence this
	// increment exists to remove (DA-7).
	const droppedTileNames = allTiles.slice(MAX_STATS_ITEMS).map((tile) => tileName(tile.label));

	const topRevenueSuppressed = singleCurrency === undefined && data.top.length > 0;
	const topRows = data.top.map((t) => ({
		titleSnapshot: t.titleSnapshot,
		qtySold: t.qtySold,
		revenue:
			singleCurrency === undefined
				? "—"
				: formatMoney(toCents(t.revenueCents), singleCurrency, MONEY_LOCALE),
	}));

	// Bucket boundaries are date-only bounds (M-6), and the wire's
	// millisecond-precision ISO string would otherwise trip X-13 — trim to
	// YYYY-MM-DD. Each row's revenue is formatted through ITS OWN bucket
	// currency (never summed across rows), so a range spanning several
	// currencies still reads correctly without a per-currency Currency column
	// (M-2 forbids one) and without the per-currency accordion split the
	// listing describes, whose ordering depends on the same order-count data
	// the stats ranking above does not have.
	//
	// Days with no orders are EMITTED, at zero, so the series is continuous
	// (DESIGNER §6): the wire returns only days that had revenue, which made a
	// month of steady sales and a month with a three-week hole render as the
	// same four rows. A zero row is data — it is the shape a table can show
	// without a chart.
	const series = revenueSeries(data);
	const revenueRows = series.points.map(({ day, currencyCode, revenueCents }) => ({
		bucketStart: day,
		revenue: formatMoney(toCents(revenueCents), toCurrency(currencyCode), MONEY_LOCALE),
	}));

	const revenueTable: TableBlock = {
		type: "table",
		block_id: "reports:revenue-table",
		columns: [
			{ key: "bucketStart", label: "Period" },
			{ key: "revenue", label: "Revenue" },
		],
		rows: revenueRows,
		page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
		empty_text: "No revenue in range.",
	};
	const revenueAccordion: AccordionBlock = {
		type: "accordion",
		block_id: "reports:revenue",
		// No "(N buckets)": a bucket is this codebase's word for a GROUP BY, not
		// the operator's word for anything, and with the series now continuous the
		// count was only ever restating the length of the range.
		label: `Revenue by ${data.interval}`,
		default_open: true, // S-3: the one open group on this screen
		blocks: [
			...(multiCurrency ? [{ type: "context" as const, text: rankingGapNote }] : []),
			// A sparse series is never left to look continuous: when the fill is
			// declined the group says so, in one line, above the rows (DA-7).
			...(series.filled ? [] : [{ type: "context" as const, text: SPARSE_SERIES_NOTE }]),
			revenueTable,
		],
	};

	const statusesTable: TableBlock = {
		type: "table",
		block_id: "reports:statuses-table",
		columns: [
			{ key: "status", label: "Status", format: "badge" },
			{ key: "orderCount", label: "Orders", format: "number" },
		],
		rows: data.statuses.map((s) => ({ ...s })),
		page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
		empty_text: "No orders in range.",
	};
	const statusesAccordion: AccordionBlock = {
		type: "accordion",
		block_id: "reports:statuses",
		label: `Orders by status (${data.statuses.length})`,
		default_open: false,
		blocks: [statusesTable],
	};

	const topTable: TableBlock = {
		type: "table",
		block_id: "reports:top-table",
		columns: [
			{ key: "titleSnapshot", label: "Product" },
			{ key: "qtySold", label: "Qty", format: "number" },
			{ key: "revenue", label: "Revenue" },
		],
		rows: topRows,
		page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
		empty_text: "No sales in range.",
	};
	const topAccordion: AccordionBlock = {
		type: "accordion",
		block_id: "reports:top",
		label: `Top products (${data.top.length})`,
		default_open: false,
		blocks: topRevenueSuppressed
			? [
					{
						type: "context",
						text: "Revenue is not shown per product because this range spans more than one currency and the wire carries no per-product currency — a service change is needed to attribute it correctly.",
					},
					topTable,
				]
			: [topTable],
	};

	const lowTable: TableBlock = {
		type: "table",
		block_id: "reports:low-table",
		columns: [
			{ key: "title", label: "Title" },
			{ key: "sku", label: "SKU", format: "code" },
			{ key: "onHand", label: "On hand" },
		],
		rows: data.low.map((r) => ({
			// CMS-owned, same as the products list (products-page.ts) — `null`
			// means no live product claims the sku, which is a different fact
			// from the sku itself, so it renders "(untitled)" and never the sku.
			title: r.title ?? "(untitled)",
			sku: r.sku,
			onHand: lowStockOnHandLabel(r.onHand),
		})),
		page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
		empty_text: "Nothing low on stock.",
	};
	const lowAccordion: AccordionBlock = {
		type: "accordion",
		block_id: "reports:low",
		// The count alone ("Low stock (3)") never said low COMPARED TO WHAT, and
		// the threshold lives in Settings, two screens away. `GET /settings`
		// already returns it, so the label states it. Omitted — never guessed —
		// when that read failed.
		label:
			data.lowStockThreshold === undefined
				? `Low stock (${data.low.length})`
				: `Low stock (${data.low.length}) — at or below ${data.lowStockThreshold}`,
		default_open: false,
		blocks: [lowTable],
	};

	const blocks: Block[] = [
		{ type: "header", text: `${data.displayName} — Reports` },
		{
			type: "context",
			// The period FIRST, in absolute dates: the screen used to state the
			// definition of revenue and never the window it applied it to, so a
			// figure covering 30 days read equally well as all-time or as today.
			text: `${absolutePeriod(data.range)} (UTC) · Revenue is net order totals on paid-and-later orders, bucketed by order time.`,
		},
		...(data.range.problem !== undefined ? [rangeProblemBanner(data.range)] : []),
		rangeForm(data.range, data.interval),
		{ type: "stats", items },
		...(droppedTileNames.length > 0
			? [
					{
						type: "context" as const,
						text: `${listPhrase(droppedTileNames)} ${droppedTileNames.length === 1 ? "is" : "are"} not shown: the four cards are taken by one revenue card per currency.`,
					},
				]
			: []),
		revenueAccordion,
		statusesAccordion,
		topAccordion,
		lowAccordion,
	];
	return { blocks };
}

/**
 * `0` reads as "Out of stock", the low band as "Low" — the exact wording
 * from the stock-visibility increment's (INC-04) own verification note in
 * the spec (`0 / Out of stock`, `1 / Low`), which is the vocabulary source
 * here. NOT a mirror of `products-page.ts`'s `On hand` column: that
 * increment hasn't merged as of this change, so there is no shipped column
 * to copy from — when it lands, its column becomes this one's SIBLING (same
 * vocabulary, independently derived), not the source.
 *
 * Deliberately plain text, not `format: "badge"`, even though the same
 * words badge there: every row in this table already sits at or below SOME
 * threshold — that is what selected it into `GET /reports/low-stock` — so a
 * badge column here could legitimately render the identical value on every
 * row (all-zero or all-low is a normal shape for this report). Block
 * Kit's `format:"badge"` on a column whose value is constant within one
 * rendered response is `ADMIN-CONSOLE.md`'s X-4 (T-5): "A column of
 * identical badges … or more than one badge column in a table." Plain text
 * carries the same two words without tripping it. The raw count stays in
 * the cell alongside the word: a bare "Out of stock" would make an
 * operator re-derive whether that means 0 or "some, but running low," and
 * the count is the fact this column is named for.
 */
function lowStockOnHandLabel(onHand: number): string {
	return onHand === 0 ? `${onHand} / Out of stock` : `${onHand} / Low`;
}

/**
 * The period control (P0-3: the page hardcoded a trailing 30 days, read
 * `from`/`to` from its route input, and shipped no UI that could ever supply
 * them). Two `date_input`s, prefilled with the period being rendered, whose
 * submit re-enters this same handler through {@link REPORTS_RANGE_ACTION_ID}.
 *
 * `carriedForm` (never a hand-rolled `block_id`): Block Kit inputs are
 * uncontrolled, so the fields pick up a new `initial_value` only when the form
 * REMOUNTS — and the prefill digest in the token is what makes the key change
 * whenever the rendered period does. Without it, a rejected range would fall
 * back to the default while the fields still showed the rejected dates.
 */
function rangeForm(range: ResolvedRange, interval: "day" | "week" | "month"): FormBlock {
	return carriedForm({
		namespace: "reports:range",
		// The granularity the page is currently rendering, carried invisibly so a
		// period change does not silently reset a weekly report to daily.
		context: { interval },
		form: {
			type: "form",
			fields: [
				{
					type: "date_input",
					action_id: "from",
					label: "From (inclusive)",
					initial_value: range.fromDay,
				},
				{
					type: "date_input",
					action_id: "to",
					label: "To (inclusive)",
					initial_value: range.toDay,
				},
			],
			submit: { label: "Update period", action_id: REPORTS_RANGE_ACTION_ID },
		},
	});
}

/** A tile's name without its currency and period — `Refunded (USD) — last 30
 *  days` → `Refunded` — for naming the cards that did not fit. */
function tileName(label: string): string {
	return (label.split("—")[0] ?? label).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** `Orders, AOV and Refunded` — an English list. Kept here rather than in a
 *  shared helper because this is its only caller. */
function listPhrase(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** An unusable range renders the page for the default period plus this — a 200
 *  with a banner, never a 4xx (G5), and never a silent substitution. */
function rangeProblemBanner(range: ResolvedRange): BannerBlock {
	return {
		type: "banner",
		variant: "alert",
		title: `Showing the last ${DEFAULT_RANGE_DAYS} days`,
		description: range.problem ?? "",
	};
}

/**
 * Average order value — revenue ÷ the orders that produced it.
 *
 * Two ways this must NOT render: `$0.00` when there were no orders (a division
 * with no answer is not zero, and "free" is not what happened), and a figure at
 * all when the period spans several currencies (dividing a sum of USD and JPY
 * minor units by a currency-less order count produces a number that means
 * nothing). Both render "—" with the reason in the description.
 */
function averageOrderValueTile(
	byCurrencyCode: ReadonlyArray<readonly [string, number]>,
	singleCurrency: Currency | undefined,
	paidOrderCount: number,
	period: string,
): StatItem {
	const label = `AOV${singleCurrency === undefined ? "" : ` (${singleCurrency})`} — ${period}`;
	if (singleCurrency === undefined) {
		return {
			label,
			value: "—",
			description:
				byCurrencyCode.length === 0
					? "Average order value — no paid orders in this period"
					: "Average order value — orders in this period span several currencies",
		};
	}
	if (paidOrderCount === 0) {
		return { label, value: "—", description: "Average order value — no paid orders to average" };
	}
	const totalCents = byCurrencyCode[0]?.[1] ?? 0;
	return {
		label,
		value: formatMoney(
			toCents(Math.round(totalCents / paidOrderCount)),
			singleCurrency,
			MONEY_LOCALE,
		),
		description: `Average order value across ${paidOrderCount} paid ${paidOrderCount === 1 ? "order" : "orders"}`,
	};
}

/**
 * Refunded money for the period — a KNOWN GAP, rendered as one.
 *
 * The reporting wire carries no refunded amount: `/reports/revenue` EXCLUDES
 * refunded orders from its allow-list rather than reporting them, and
 * `/reports/orders-by-status` carries counts only. Two wrong answers were
 * available and both are refused — summing nothing to `$0.00` (a partial refund
 * leaves the order in its previous state, so even "no refunded orders" does not
 * mean "no money went back"), and quietly relabelling the tile as a count so it
 * looks full. So the tile states its currency, renders "—", and says what is
 * known and what would fix it (DA-7 — the same disclosure the top-products
 * revenue column already makes). Closing it is a service change: a
 * `refundedCents` alongside `revenueCents` on the revenue wire.
 */
function refundedTileFor(
	statuses: StatusCountWire[],
	singleCurrency: Currency | undefined,
	period: string,
): StatItem {
	const refundedOrders = statuses.find((s) => s.status === "refunded")?.orderCount ?? 0;
	const known =
		refundedOrders === 0
			? "No fully refunded orders"
			: `${refundedOrders} fully refunded ${refundedOrders === 1 ? "order" : "orders"}`;
	return {
		label: `Refunded${singleCurrency === undefined ? "" : ` (${singleCurrency})`} — ${period}`,
		value: "—",
		description: `${known}; refunded amount not yet reported`,
	};
}

/** One row of the revenue table: a day, a currency, and that day's revenue in
 *  it — zero included. */
interface RevenuePoint {
	day: string;
	currencyCode: string;
	revenueCents: number;
}

/** The rows, plus whether the gaps were actually filled — a sparse series must
 *  never be presented as a continuous one. */
interface RevenueSeries {
	points: RevenuePoint[];
	filled: boolean;
}

/**
 * The widest period whose day series is worth drawing row by row. A quarter of
 * daily rows is already a long table; past that, the zero rows stop showing
 * shape and start being the table. Beyond it the wire's own sparse series is
 * rendered instead, with the omission stated.
 */
const MAX_ZERO_FILL_DAYS = 92;

/** Rendered under the group label whenever the fill was declined. Names the
 *  omission, never the reasoning behind it. "Periods", not "Days": this group
 *  also renders weekly and monthly buckets, and the table's own first column is
 *  labelled `Period`. */
const SPARSE_SERIES_NOTE = "Periods with no revenue are omitted for this range.";

/**
 * The revenue series with its gaps filled in: every day of the period, in day
 * order — but only when filling is both cheap and unambiguous.
 *
 * THREE CASES PASS THROUGH UNFILLED, each stated to the operator rather than
 * silently drawn as continuous:
 *  - `interval` week/month — filling would have to reproduce the adapter's own
 *    bucket-start arithmetic to know which buckets are missing, and inventing a
 *    boundary that disagrees with the one the data was grouped by is worse than
 *    the gap. (Nothing in the UI selects an interval today.)
 *  - a period longer than {@link MAX_ZERO_FILL_DAYS}.
 *  - more than one currency in the window: a filled multi-currency series is a
 *    day × currency cross product, so a quiet currency contributes a column of
 *    `$0.00` rows that outnumber the real ones and read as activity that never
 *    happened.
 */
function revenueSeries(data: ReportsData): RevenueSeries {
	const passthrough = (filled: boolean): RevenueSeries => ({
		points: data.revenue.map((b) => ({
			day: b.bucketStart.slice(0, 10),
			currencyCode: b.currency,
			revenueCents: b.revenueCents,
		})),
		filled,
	});
	// An empty window has no gaps to fill and no rows to mislead anyone: the
	// table's own `empty_text` covers it, so it is "filled" as far as the
	// disclosure is concerned.
	if (data.revenue.length === 0) return passthrough(true);
	if (data.interval !== "day") return passthrough(false);

	const byDay = new Map<string, number>();
	const currencies = new Set<string>();
	for (const b of data.revenue) {
		currencies.add(b.currency);
		const day = b.bucketStart.slice(0, 10);
		byDay.set(day, (byDay.get(day) ?? 0) + b.revenueCents);
	}
	const currencyCode = currencies.size === 1 ? [...currencies][0] : undefined;
	if (currencyCode === undefined) return passthrough(false);

	const days = daysBetween(data.range.fromDay, data.range.toDay);
	// A data day outside the requested window would be dropped by a strict fill,
	// so fall back rather than lose a row.
	const daySet = new Set(days);
	if (
		days.length === 0 ||
		days.length > MAX_ZERO_FILL_DAYS ||
		data.revenue.some((b) => !daySet.has(b.bucketStart.slice(0, 10)))
	) {
		return passthrough(false);
	}
	return {
		points: days.map((day) => ({ day, currencyCode, revenueCents: byDay.get(day) ?? 0 })),
		filled: true,
	};
}

/** Every `YYYY-MM-DD` from `fromDay` to `toDay` inclusive (UTC). */
function daysBetween(fromDay: string, toDay: string): string[] {
	const start = Date.parse(`${fromDay}T00:00:00.000Z`);
	const end = Date.parse(`${toDay}T00:00:00.000Z`);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
	const out: string[] = [];
	for (let at = start; at <= end; at += DAY_MS) {
		out.push(new Date(at).toISOString().slice(0, 10));
	}
	return out;
}

/** Re-export for the settings label helper — the reporting widget's title uses
 *  the same kv-backed display name. */
export type { OperationalSettingsWire };
