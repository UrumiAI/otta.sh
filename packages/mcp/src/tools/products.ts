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

export const PRODUCT_TOOLS = [
	defineTool({
		name: "products_list",
		description: `List the store's products, newest page first: one summary per product (productId, sku, title, priceCents + currency, productKind, active, onHand). Use it to find a product or scan the catalogue; call products_get for one product in full. \`query\` searches by text; page with \`nextCursor\`. ${MONEY_NOTE} \`onHand\` is a unit count; null means the sku has no inventory record, which is not zero.`,
		input: z.object({
			query: z.string().min(1).optional().describe("Free-text search over products."),
			limit: limitInput,
			cursor: cursorInput,
		}),
		async run({ clients, input }) {
			const page = await readOrRefuse(() =>
				clients.products.listProducts(input.query === undefined ? {} : { search: input.query }, {
					limit: input.limit,
					...(input.cursor === undefined ? {} : { cursor: input.cursor }),
				}),
			);
			refuseRejectedCursor(page);
			return {
				items: page.products,
				nextCursor: page.nextCursor,
				...(page.total === undefined ? {} : { total: page.total }),
			};
		},
	}),
	defineTool({
		name: "products_get",
		description: `Read one product in full by productId: price, stock, tax class, kind and the other commerce fields, plus the \`updatedAt\` watermark. Use it before changing a product. ${MONEY_NOTE} Fails with NOT_FOUND for an unknown productId (get ids from products_list).`,
		input: z.object({ productId: z.string().min(1).describe("The productId from products_list.") }),
		async run({ clients, input }) {
			const product = await clients.products.getProduct(input.productId);
			if (product === null) toolFailure("NOT_FOUND", `No product ${input.productId}.`);
			return product;
		},
	}),
	defineTool({
		name: "products_low_stock",
		description:
			"List skus whose on-hand stock is at or below a threshold: sku, onHand (a unit count) and the live product title (null when no live product uses the sku). Use it to decide what to restock. `threshold` defaults to the store's configured low-stock threshold (see settings_get).",
		input: z.object({
			threshold: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe("Units. Defaults to the store's configured threshold."),
		}),
		async run({ clients, input }) {
			const items = await readOrRefuse(() => clients.reporting.getLowStock(input.threshold));
			return { items };
		},
	}),
];
