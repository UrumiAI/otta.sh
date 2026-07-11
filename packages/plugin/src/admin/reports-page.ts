import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type { AdminPageConfig, Block, BlockResponse, RouteHandler } from "../types.js";
import {
	type LowStockWire,
	type OperationalSettingsWire,
	ReportingSettingsClient,
	type RevenueBucketWire,
	type StatusCountWire,
	type TopProductWire,
} from "./reporting-client.js";

/** The admin Reports page route + its `admin.pages` manifest entry (§4.4). The
 *  page renders numbers and tables — Block Kit ships no charting primitive
 *  (§2), so a graphical dashboard is a future trusted-React surface. */
export const REPORTS_ROUTE = "admin/reports";
export const REPORTS_PAGE: AdminPageConfig = { path: "/reports", label: "Reports", icon: "chart" };

/** Trailing 30 days (UTC), the plugin-side default (a UX nicety only — the
 *  service enforces the 400-day cap regardless, §4.4). */
const DEFAULT_RANGE_DAYS = 30;

export interface ReportsPageInput {
	from?: unknown;
	to?: unknown;
	interval?: unknown;
	/** Admin token forwarded to the guarded /reports/* reads (review J5). Arrives
	 *  as transient route input (cookie-blind bearer-as-input); never persisted. */
	adminToken?: unknown;
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
 * The Reports page (plan §6 Step 6). Composes four Block Kit sections, each
 * backed by one `/reports/*` call over `ctx.http` via `ReportingSettingsClient`.
 * Fails CLOSED: any `ctx.http` error (allowlist rejection or a non-2xx) renders
 * an error banner rather than throwing into the host.
 */
export function createReportsPageHandler(): RouteHandler<ReportsPageInput> {
	return async (routeCtx, ctx) => {
		const range = resolveRange(routeCtx.input);
		const interval = resolveInterval(routeCtx.input);
		// Cosmetic label from ctx.kv (never the service) — the display-only tier.
		const displayName = (await ctx.kv.get<string>("settings:storeDisplayName")) ?? "Store";

		const adminToken =
			typeof routeCtx.input.adminToken === "string" ? routeCtx.input.adminToken : undefined;
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
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const response: BlockResponse = {
				blocks: [
					{ type: "header", text: `${displayName} — Reports` },
					{ type: "banner", variant: "error", text: `Reports are unavailable: ${message}` },
				],
				toast: { message: "Could not load reports", type: "error" },
			};
			return response;
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
	const blocks: Block[] = [
		{ type: "header", text: `${data.displayName} — Reports` },
		{
			type: "context",
			text: "Revenue = net order_totals (post-discount, incl. shipping+tax) on paid/processing/shipped/delivered/completed orders, bucketed by order-creation time (UTC). Top products = gross item revenue.",
		},
		{
			type: "stats",
			items:
				totalByCurrency.size === 0
					? [{ label: "Revenue", value: "0", description: "no orders in range" }]
					: [...totalByCurrency.entries()].map(([currency, cents]) => ({
							label: `Revenue (${currency})`,
							value: String(cents),
							description: "integer minor units",
						})),
		},
		{ type: "divider" },
		{ type: "section", text: `Revenue by ${data.interval}` },
		{
			type: "table",
			columns: [
				{ key: "bucketStart", label: "Period" },
				{ key: "currency", label: "Currency", format: "badge" },
				{ key: "revenueCents", label: "Revenue (minor units)", format: "number" },
			],
			rows: data.revenue.map((b) => ({ ...b })),
			empty_text: "No revenue in range",
		},
		{ type: "section", text: "Orders by status" },
		{
			type: "table",
			columns: [
				{ key: "status", label: "Status", format: "badge" },
				{ key: "orderCount", label: "Orders", format: "number" },
			],
			rows: data.statuses.map((s) => ({ ...s })),
			empty_text: "No orders in range",
		},
		{ type: "section", text: "Top products (by revenue)" },
		{
			type: "table",
			columns: [
				{ key: "titleSnapshot", label: "Product" },
				{ key: "qtySold", label: "Qty", format: "number" },
				{ key: "revenueCents", label: "Revenue (minor units)", format: "number" },
			],
			rows: data.top.map((t) => ({ ...t })),
			empty_text: "No sales in range",
		},
		{ type: "section", text: "Low stock" },
		{
			type: "table",
			columns: [
				{ key: "sku", label: "SKU", format: "code" },
				{ key: "onHand", label: "On hand", format: "number" },
			],
			rows: data.low.map((r) => ({ ...r })),
			empty_text: "Nothing low on stock",
		},
	];
	return { blocks };
}

/** Re-export for the settings label helper — the reporting widget's title uses
 *  the same kv-backed display name. */
export type { OperationalSettingsWire };
