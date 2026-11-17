import { z } from "zod";
import { defineTool } from "../tool.js";
import { instantInput, MONEY_NOTE, readOrRefuse } from "./common.js";

const RANGE = "The range is half-open: `from` is included, `to` is not. At most 400 days wide.";

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
			const items = await readOrRefuse(() =>
				clients.reporting.getRevenue({ from: input.from, to: input.to }, input.granularity),
			);
			return { items };
		},
	}),
	defineTool({
		name: "reports_orders_by_status",
		description: `How many orders were placed in a date range, per order state. ${RANGE}`,
		input: z.object({ from: instantInput("Start"), to: instantInput("End") }).strict(),
		async run({ clients, input }) {
			const items = await readOrRefuse(() =>
				clients.reporting.getOrdersByStatus({ from: input.from, to: input.to }),
			);
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
			const items = await readOrRefuse(() =>
				clients.reporting.getTopProducts(
					{ from: input.from, to: input.to },
					"revenue",
					input.limit,
				),
			);
			return { items };
		},
	}),
];
