import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	AccordionBlock,
	AdminPageConfig,
	Block,
	BlockResponse,
	RouteHandler,
	StatItem,
	TableBlock,
} from "../types.js";
import { failClosedResponse } from "./scaffold/index.js";
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
 *  renders numbers and tables — Block Kit ships no charting primitive that can
 *  format money (R-19, §2), so a graphical dashboard is a future trusted-React
 *  surface. Rendered by the single `admin` dispatch route (see
 *  `admin-route.ts`). */
export const REPORTS_PAGE: AdminPageConfig = { path: "/reports", label: "Reports", icon: "chart" };

/** Trailing 30 days (UTC), the plugin-side default (a UX nicety only — the
 *  service enforces the 400-day cap regardless, §4.4). */
const DEFAULT_RANGE_DAYS = 30;

/** R-16 caps a `stats` block at 4 items. */
const MAX_STATS_ITEMS = 4;

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
export const REPORTS_ACTION_IDS: ReadonlySet<string> = new Set([REPORTS_PAGE_ACTION_ID]);

export interface ReportsPageInput {
	from?: unknown;
	to?: unknown;
	interval?: unknown;
}

function resolveRange(input: ReportsPageInput): { from: string; to: string } {
	if (typeof input.from === "string" && typeof input.to === "string") {
		return { from: input.from, to: input.to };
	}
	const to = new Date();
	const from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
	return { from: from.toISOString(), to: to.toISOString() };
}

function resolveInterval(input: ReportsPageInput): "day" | "week" | "month" {
	return input.interval === "week" || input.interval === "month" ? input.interval : "day";
}

/**
 * The Reports page (§4.1 skeleton; `docs/admin/ADMIN-CONSOLE.md` §12.5).
 * Composes four Block Kit sections, each backed by one `/reports/*` call over
 * `ctx.http` via `ReportingSettingsClient`. Fails CLOSED: any `ctx.http` error
 * (allowlist rejection or a non-2xx) renders the E-7 fail-closed banner rather
 * than throwing into the host. Also handles the (currently unreachable)
 * `reports:page` no-op action by re-rendering the page unchanged — this
 * function reads only `routeCtx.input`'s range/interval fields regardless of
 * whether the interaction was a `page_load` or a `block_action`.
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
			const [revenue, statuses, top, low] = await Promise.all([
				client.getRevenue(range, interval),
				client.getOrdersByStatus(range),
				client.getTopProducts(range, "revenue", 10),
				client.getLowStock(),
			]);
			return buildReportsBlocks({ displayName, interval, revenue, statuses, top, low });
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
	revenue: RevenueBucketWire[];
	statuses: StatusCountWire[];
	top: TopProductWire[];
	low: LowStockWire[];
}

export function buildReportsBlocks(data: ReportsData): BlockResponse {
	const totalByCurrency = new Map<string, number>();
	for (const b of data.revenue) {
		totalByCurrency.set(b.currency, (totalByCurrency.get(b.currency) ?? 0) + b.revenueCents);
	}
	// §12.5's listing asks for these cards ranked "by the most orders" — but
	// `RevenueBucketWire` carries only `revenueCents`, no per-currency order
	// count, and `StatusCountWire.orderCount` is bucketed by ORDER STATUS, not
	// by currency. Approximating an order-count rank from revenue would let a
	// low-price, high-volume currency read as ranked below a high-price,
	// low-volume one — inverted, while the card still claims to be "the three
	// currencies with the most orders" (confidently wrong, and an operator
	// cannot tell). Director ruling: this is scoped OUT, reported here as an
	// N-1 spec defect. Ranking by revenue instead uses only data the wire
	// actually carries — no invented semantic, and the single-currency case
	// (every fixture, and every store today) is unaffected either way.
	const byRevenueDesc = [...totalByCurrency.entries()].toSorted((a, b) => b[1] - a[1]);
	const items: StatItem[] =
		byRevenueDesc.length === 0
			? [{ label: "Revenue", value: "—", description: "No orders in range" }]
			: byRevenueDesc.slice(0, MAX_STATS_ITEMS).map(([currencyCode, revenueCents]) => ({
					label: `Revenue (${currencyCode})`,
					value: formatMoney(toCents(revenueCents), toCurrency(currencyCode), "en-US"),
				}));

	// Top products' wire (`TopProductWire`) carries `revenueCents` but NO
	// currency field at all — a second, independent wire gap from the stats
	// ranking above. `formatMoney` requires a currency, so this can only be
	// formatted correctly when the whole range is genuinely single-currency
	// (the common case). Multi-currency ranges fall back to "—": a wrong
	// number is worse than a missing one (M-1), and inventing a currency here
	// would be the same category of mistake the stats ranking was scoped out
	// to avoid.
	const singleCurrency = byRevenueDesc.length === 1 ? toCurrency(byRevenueDesc[0]![0]) : undefined;
	const topRows = data.top.map((t) => ({
		titleSnapshot: t.titleSnapshot,
		qtySold: t.qtySold,
		revenue:
			singleCurrency === undefined
				? "—"
				: formatMoney(toCents(t.revenueCents), singleCurrency, "en-US"),
	}));

	// Bucket boundaries are date-only bounds (M-6), and the wire's
	// millisecond-precision ISO string would otherwise trip X-13 — trim to
	// YYYY-MM-DD. Each row's revenue is formatted through ITS OWN bucket
	// currency (never summed across rows), so a range spanning several
	// currencies still reads correctly without a per-currency Currency column
	// (M-2 forbids one) and without the per-currency accordion split the
	// listing describes, whose ordering depends on the same order-count data
	// the stats ranking above does not have.
	const revenueRows = data.revenue.map((b) => ({
		bucketStart: b.bucketStart.slice(0, 10),
		revenue: formatMoney(toCents(b.revenueCents), toCurrency(b.currency), "en-US"),
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
		label: `Revenue by ${data.interval} (${data.revenue.length} bucket${data.revenue.length === 1 ? "" : "s"})`,
		default_open: true, // S-3: the one open group on this screen
		blocks: [revenueTable],
	};

	const statusesTable: TableBlock = {
		type: "table",
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
		blocks: [topTable],
	};

	const lowTable: TableBlock = {
		type: "table",
		columns: [
			{ key: "sku", label: "SKU", format: "code" },
			{ key: "onHand", label: "On hand", format: "number" },
		],
		rows: data.low.map((r) => ({ ...r })),
		page_action_id: REPORTS_PAGE_ACTION_ID, // never fires: no next_cursor, no sortable column
		empty_text: "Nothing low on stock.",
	};
	const lowAccordion: AccordionBlock = {
		type: "accordion",
		block_id: "reports:low",
		label: `Low stock (${data.low.length})`,
		default_open: false,
		blocks: [lowTable],
	};

	const blocks: Block[] = [
		{ type: "header", text: `${data.displayName} — Reports` },
		{
			type: "context",
			text: "Revenue is net order totals on paid-and-later orders, bucketed by order time (UTC).",
		},
		{ type: "stats", items },
		revenueAccordion,
		statusesAccordion,
		topAccordion,
		lowAccordion,
	];
	return { blocks };
}

/** Re-export for the settings label helper — the reporting widget's title uses
 *  the same kv-backed display name. */
export type { OperationalSettingsWire };
