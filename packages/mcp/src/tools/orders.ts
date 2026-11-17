import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import {
	cursorInput,
	limitInput,
	MONEY_NOTE,
	readOrRefuse,
	refuseRejectedCursor,
} from "./common.js";

export const ORDER_TOOLS = [
	defineTool({
		name: "orders_list",
		description: `List orders, newest first: one summary per order (id, orderNumber, state, currency, buyerRef, totalCents, createdAt, reconciliationFlag). Use it to find an order; call orders_get for the full picture. \`status\` filters on one order state (for example paid, fulfilled, cancelled, refunded); \`query\` searches by text such as the buyer email or order number. Page with \`nextCursor\`. ${MONEY_NOTE}`,
		input: z
			.object({
				status: z.string().min(1).optional().describe("One order state to filter on."),
				query: z.string().min(1).optional().describe("Free-text search (buyer, order number)."),
				limit: limitInput,
				cursor: cursorInput,
			})
			.strict(),
		async run({ clients, input }) {
			const filter = {
				...(input.status === undefined ? {} : { states: [input.status] }),
				...(input.query === undefined ? {} : { search: input.query }),
			};
			const page = await readOrRefuse(() =>
				clients.orders.listOrders(filter, {
					limit: input.limit,
					...(input.cursor === undefined ? {} : { cursor: input.cursor }),
				}),
			);
			refuseRejectedCursor(page);
			return {
				items: page.orders,
				nextCursor: page.nextCursor,
				...(page.total === undefined ? {} : { total: page.total }),
			};
		},
	}),
	defineTool({
		name: "orders_get",
		description: `Read one order in full by id: the order (lines, totals, addresses, state), \`allowedTransitions\`, \`customer\`, \`timeline\`, \`notes\` and \`refunds\`. \`refunds.refundedSoFarCents\` is the money already refunded and finalized: pass it back unchanged when refunding so a retry cannot refund twice. \`refunds.remainingCents\` is what can still be refunded. ${MONEY_NOTE} Fails with NOT_FOUND for an unknown id.`,
		input: z
			.object({ orderId: z.string().min(1).describe("The order id from orders_list.") })
			.strict(),
		async run({ clients, input }) {
			const detail = await clients.orders.getOrder(input.orderId);
			if (detail === null) toolFailure("NOT_FOUND", `No order ${input.orderId}.`);
			const [customer, timeline, refunds, notes] = await Promise.all([
				clients.orders.getCustomerContext(input.orderId),
				clients.orders.getTimeline(input.orderId),
				clients.orders.getRefunds(input.orderId),
				clients.orders.listNotes(input.orderId),
			]);
			return {
				...detail,
				customer,
				timeline,
				notes,
				refunds:
					refunds === null ? null : { ...refunds, refundedSoFarCents: refunds.finalizedTotalCents },
			};
		},
	}),
];
