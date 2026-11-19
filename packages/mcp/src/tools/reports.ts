import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { instantInput, MONEY_NOTE, readOrRefuse } from "./common.js";

const RANGE =
	"The range is half-open: `from` is included, `to` is not. At most 400 days wide; `from` after `to` is refused.";

/**
 * The range, refused before any read when `from` is after `to`: the reporting
 * surface answers such a range with an empty result, which reads as "no sales"
 * rather than as the caller's mistake. A value that is not an instant is left to
 * the surface's own refusal (INVALID_INPUT through `readOrRefuse`).
 */
function range(input: { from: string; to: string }): { from: string; to: string } {
	const from = Date.parse(input.from);
	const to = Date.parse(input.to);
	if (!Number.isNaN(from) && !Number.isNaN(to) && from > to) {
		toolFailure("INVALID_INPUT", "`from` is after `to`: the range is empty. Swap them.", {
			field: "from",
		});
	}
	return { from: input.from, to: input.to };
}

export const REPORT_TOOLS = [
	defineTool({
		name: "reports_revenue",
		description: `Revenue over a date range, bucketed by day, week or month: per bucket bucketStart, currency, revenueCents, revenueOrderCount and refundedCents (refunds are stated alongside revenue, never netted off). ${MONEY_NOTE} ${RANGE}`,
		input: z
			.object({
				from: instantInput("Start"),
				to: instantInput("End"),
				granularity: z.enum(["day", "week", "month"]).default("day"),
			})
			.strict(),
		async run({ clients, input }) {
			const window = range(input);
			const items = await readOrRefuse(() =>
				clients.reporting.getRevenue(window, input.granularity),
			);
			return { items };
		},
	}),
	defineTool({
		name: "reports_orders_by_status",
		description: `How many orders were placed in a date range, per order state. ${RANGE}`,
		input: z.object({ from: instantInput("Start"), to: instantInput("End") }).strict(),
		async run({ clients, input }) {
			const window = range(input);
			const items = await readOrRefuse(() => clients.reporting.getOrdersByStatus(window));
			return { items };
		},
	}),
	defineTool({
		name: "reports_top_products",
		description: `The best-selling products in a date range, ranked by revenue: productId, titleSnapshot, qtySold (units) and revenueCents. ${MONEY_NOTE} ${RANGE}`,
		input: z
			.object({
				from: instantInput("Start"),
				to: instantInput("End"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(10)
					.describe("How many products, 1-100 (default 10)."),
			})
			.strict(),
		async run({ clients, input }) {
			const window = range(input);
			const items = await readOrRefuse(() =>
				clients.reporting.getTopProducts(window, "revenue", input.limit),
			);
			return { items };
		},
	}),
];
