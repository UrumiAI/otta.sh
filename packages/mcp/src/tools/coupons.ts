import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { cursorInput, limitInput, MONEY_NOTE, readOrRefuse } from "./common.js";

export const COUPON_TOOLS = [
	defineTool({
		name: "coupons_list",
		description: `List discount coupons, one summary each (id, code, type, value, window, uses). Use it to see what promotions exist; call coupons_get for one coupon in full. \`query\` is a case-insensitive EXACT match on the code, not a substring search. Page with \`nextCursor\`. ${MONEY_NOTE} Percentages are basis points (1000 = 10%).`,
		input: z.object({
			query: z.string().min(1).optional().describe("A coupon code, matched exactly (any case)."),
			limit: limitInput,
			cursor: cursorInput,
		}),
		async run({ clients, input }) {
			const page = await readOrRefuse(() =>
				clients.rules.listCoupons(input.query === undefined ? {} : { search: input.query }, {
					limit: input.limit,
					...(input.cursor === undefined ? {} : { cursor: input.cursor }),
				}),
			);
			return {
				items: page.coupons,
				nextCursor: page.nextCursor,
				...(page.total === undefined ? {} : { total: page.total }),
			};
		},
	}),
	defineTool({
		name: "coupons_get",
		description: `Read one coupon in full by its code: type, amount or rate, cap, currency, minimum spend, start and end dates, usage limits and uses so far. Use it before editing or retiring a coupon. ${MONEY_NOTE} Percentages are basis points. Fails with NOT_FOUND for an unknown code.`,
		input: z.object({ code: z.string().min(1).describe("The coupon code.") }),
		async run({ clients, input }) {
			const coupon = await clients.rules.getCoupon(input.code);
			if (coupon === null) toolFailure("NOT_FOUND", `No coupon ${input.code}.`);
			return coupon;
		},
	}),
];
