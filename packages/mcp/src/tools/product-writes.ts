/**
 * The product WRITE tools: the commerce edit and the two stock movements. Each
 * validates its input, calls the plugin's admin OPERATION (`editProduct`,
 * `restock`, `removeStock` — never a surface write: the operation owns the
 * per-intent nonce key, the live re-read after a replay, the DA-3a watermark on a
 * removal and the new-currency guard on an edit), and turns the operation's
 * outcome into success data or a `toolFailure` with a stable code.
 */
import type {
	ProductEditOutcome,
	ProductEditWire,
	ProductKind,
	ProductTaxStatus,
	StockRemovalResult,
} from "@urumi.ai/otta-plugin";
import { editProduct, NONCE_PATTERN, removeStock, restock } from "@urumi.ai/otta-plugin";
import { z } from "zod";
import { toolFailure } from "../errors.js";
import { defineTool } from "../tool.js";
import { defined, MONEY_NOTE, operate } from "./common.js";
import { type Complete, type KeysWithin, unhandled } from "./unhandled.js";

/** The domain's `ProductKind`. */
const PRODUCT_KINDS = ["physical", "digital"] as const satisfies readonly ProductKind[];
/** The domain's `ProductTaxStatus`. */
const TAX_STATUSES = [
	"taxable",
	"shipping_only",
	"none",
] as const satisfies readonly ProductTaxStatus[];
const productKindsComplete: Complete<ProductKind, typeof PRODUCT_KINDS> = true;
const taxStatusesComplete: Complete<ProductTaxStatus, typeof TAX_STATUSES> = true;
void [productKindsComplete, taxStatusesComplete];

const productIdInput = z.string().min(1).describe("The productId from products_list.");

const moneyInput = z.object({
	amount: z.number().int().nonnegative().describe("Integer minor units (1999 = 19.99)."),
	currency: z.string().length(3).describe("ISO-4217 code, e.g. USD."),
});

const dimension = (what: string) =>
	z.number().int().nonnegative().nullable().optional().describe(`${what}; null clears it.`);

const NONCE_NOTE =
	"`idempotencyKey`: generate a fresh one (a UUID) for each decision to move stock, and reuse it unchanged if you retry that same decision (after a timeout, say). A retry with the same key is answered from the ledger and moves nothing again; a NEW key is a NEW movement.";

const movementInput = z.object({
	productId: productIdInput,
	onHand: z
		.number()
		.int()
		.nonnegative()
		.describe("The product's `onHand` exactly as products_get returned it."),
	qty: z.number().int().positive().describe("How many units, a positive whole number."),
	idempotencyKey: z
		.string()
		.regex(NONCE_PATTERN)
		.describe("A UUID minted for this decision (16-64 letters, digits or dashes)."),
});

/**
 * The operation's `moved` / `failed` arms are typed with the surface's whole
 * result union, so an `ok` that disagrees with its arm is possible in type only;
 * it is refused as internal rather than answered.
 */
const inconsistent = (): never => toolFailure("INTERNAL_ERROR", "Inconsistent stock outcome.");

/**
 * STRICT: a key the edit does not know (say `priceCents`, the READ shape) is
 * refused by name rather than dropped, which would leave an empty edit reported
 * as `updated`.
 */
const editInput = z
	.object({
		productId: productIdInput,
		expectedUpdatedAt: z
			.string()
			.min(1)
			.describe("The product's `updatedAt` exactly as products_get returned it."),
		sku: z.string().min(1).optional().describe("A new sku (renames the product's stock)."),
		price: moneyInput
			.optional()
			.describe("The price; products_get reports it as `priceCents` + `currency`."),
		compareAtPrice: moneyInput
			.nullable()
			.optional()
			.describe(
				"The was-price shown struck through; null clears it. products_get reports it as `compareAtCents` + `compareAtCurrency`.",
			),
		unitCost: moneyInput
			.nullable()
			.optional()
			.describe(
				"What one unit costs you (admin-only); null clears it. products_get reports it as `unitCostCents` + `unitCostCurrency`.",
			),
		taxClass: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe("A tax class id from tax_classes_list; null for the standard rate."),
		taxStatus: z.enum(TAX_STATUSES).optional(),
		productKind: z.enum(PRODUCT_KINDS).optional(),
		weightGrams: dimension("Weight in grams"),
		lengthMm: dimension("Length in millimetres"),
		widthMm: dimension("Width in millimetres"),
		heightMm: dimension("Height in millimetres"),
	})
	.strict();

const editKeysKnown: KeysWithin<z.infer<typeof editInput>, ProductEditWire, "productId"> = true;
void editKeysKnown;

const stockChanged = (liveOnHand: number | null): never =>
	toolFailure(
		"STOCK_CHANGED",
		"The stock is no longer the count you passed. Nothing moved; read the product again with products_get and decide again.",
		{ liveOnHand },
	);

/** A stock movement's refusal (any arm but `ok`) → its code. */
function stockRefusal(result: Exclude<StockRemovalResult, { ok: true }>, productId: string): never {
	switch (result.reason) {
		case "not_found":
			return toolFailure("NOT_FOUND", `No product ${productId}. Nothing moved.`);
		case "no_sku":
			return toolFailure(
				"NO_SKU",
				"The product has no sku, so it has no stock to move. Give it a sku with products_update first.",
			);
		case "no_inventory_row":
			return toolFailure(
				"NO_INVENTORY_RECORD",
				"The product's sku has no inventory record (its onHand is null). Nothing moved.",
			);
		case "stale_on_hand":
			return stockChanged(result.onHand);
		case "insufficient_stock":
			return toolFailure(
				"INSUFFICIENT_STOCK",
				"That is more units than are on hand. Nothing moved.",
				{ onHand: result.onHand },
			);
		case "invalid":
			return toolFailure("INVALID_INPUT", "The stock movement was refused as invalid.");
		case "error":
			return toolFailure("STOCK_MOVE_FAILED", "The stock was not moved.");
		default:
			return unhandled(result);
	}
}

/** An edit's outcome → success data, or its code. */
function editAnswer(outcome: ProductEditOutcome, productId: string): unknown {
	switch (outcome.kind) {
		case "unsupported_currency":
			return toolFailure(
				"UNSUPPORTED_CURRENCY",
				`The store does not support ${outcome.currency}. Nothing was changed.`,
				{ currency: outcome.currency },
			);
		case "result":
			break;
		default:
			return unhandled(outcome);
	}
	const { result } = outcome;
	if (result.ok) return { status: "updated", updatedAt: result.updatedAt };
	switch (result.reason) {
		case "not_found":
			return toolFailure("NOT_FOUND", `No product ${productId}. Nothing was changed.`);
		case "stale":
			return toolFailure(
				"PRODUCT_CHANGED",
				"The product changed since you read it. Nothing was changed; read it again with products_get and pass its new updatedAt.",
				{ currentUpdatedAt: result.currentUpdatedAt },
			);
		case "currency_mismatch":
			return toolFailure(
				"CURRENCY_MISMATCH",
				"Every amount must be in the product's own currency. Nothing was changed.",
				{ currency: result.currency },
			);
		case "sku_taken":
			return toolFailure("SKU_TAKEN", "Another product already has that sku.", {
				sku: result.sku,
			});
		case "sku_stock_conflict":
			return toolFailure(
				"SKU_STOCK_CONFLICT",
				"The new sku already has stock of its own, and stock is never merged between skus. Nothing was changed.",
				{ fromSku: result.fromSku, toSku: result.toSku },
			);
		case "sku_held_stock":
			return toolFailure(
				"SKU_HELD_STOCK",
				"Open carts or orders still hold stock under the current sku. Try the rename again once they finish.",
				{ sku: result.sku, liveHolds: result.liveHolds },
			);
		case "invalid":
			return toolFailure("INVALID_INPUT", "A field was refused. Nothing was changed.", {
				field: result.field,
			});
		case "error":
			return toolFailure("PRODUCT_UPDATE_FAILED", "The product was not updated.");
		default:
			return unhandled(result);
	}
}

export const PRODUCT_WRITE_TOOLS = [
	defineTool({
		name: "products_update",
		description: `Change a product's commerce fields: sku, price, compare-at price, unit cost, tax class and status, kind, weight and dimensions. Send only the fields to change, and at least one; null clears a clearable one. An unknown key (such as products_get's \`priceCents\`) is refused INVALID_INPUT, never ignored. Pass the product's \`updatedAt\` from products_get as \`expectedUpdatedAt\`: if it changed since, nothing is written and the call fails PRODUCT_CHANGED. Sending the same edit twice is one write. Every amount must share the product's currency. Returns \`{status: "updated", updatedAt}\`. Refusals: NOT_FOUND, PRODUCT_CHANGED, UNSUPPORTED_CURRENCY, CURRENCY_MISMATCH, SKU_TAKEN, SKU_STOCK_CONFLICT, SKU_HELD_STOCK, INVALID_INPUT (details.field). ${MONEY_NOTE}`,
		input: editInput,
		async run({ clients, input }) {
			const { productId, expectedUpdatedAt, ...fields } = input;
			const changes = defined(fields);
			if (Object.keys(changes).length === 0) {
				return toolFailure(
					"INVALID_INPUT",
					"nothing to change: send at least one field besides productId and expectedUpdatedAt.",
				);
			}
			const wire: ProductEditWire = { expectedUpdatedAt, ...changes };
			const outcome = await operate(() => editProduct(clients.products, productId, wire));
			return editAnswer(outcome, productId);
		},
	}),
	defineTool({
		name: "products_restock",
		description: `Add units to a product's stock (a delivery came in). Pass the product's \`onHand\` from products_get; a restock is not refused if it moved since (adding is safe either way). ${NONCE_NOTE} Returns \`{status: "restocked", onHand}\`, or \`{status: "replayed", liveOnHand}\` when this key already moved the stock (liveOnHand is the count now; null if it could not be read). Refusals: NOT_FOUND, NO_SKU, NO_INVENTORY_RECORD, INVALID_INPUT.`,
		input: movementInput,
		async run({ clients, input }) {
			const outcome = await operate(() =>
				restock(clients.products, {
					productId: input.productId,
					onHand: input.onHand,
					qty: input.qty,
					nonce: input.idempotencyKey,
				}),
			);
			switch (outcome.kind) {
				case "moved":
					if (!outcome.result.ok) return inconsistent();
					return { status: "restocked", onHand: outcome.result.onHand };
				case "replayed":
					return { status: "replayed", liveOnHand: outcome.liveOnHand };
				case "failed":
					if (outcome.result.ok) return inconsistent();
					return stockRefusal(outcome.result, input.productId);
				default:
					return unhandled(outcome);
			}
		},
	}),
	defineTool({
		name: "products_remove_stock",
		description: `Remove units from a product's stock (damaged, lost, shrinkage). Pass the product's \`onHand\` exactly as products_get returned it: if the count moved since, nothing is removed and the call fails STOCK_CHANGED (details.liveOnHand; null means the sku has no inventory record any more). Stock never goes below zero: removing more than is on hand fails INSUFFICIENT_STOCK. ${NONCE_NOTE} Returns \`{status: "removed", onHand}\`, or \`{status: "replayed", liveOnHand}\`. Other refusals: NOT_FOUND, NO_SKU, INVALID_INPUT.`,
		destructive: true,
		input: movementInput,
		async run({ clients, input }) {
			const outcome = await operate(() =>
				removeStock(clients.products, {
					productId: input.productId,
					onHand: input.onHand,
					qty: input.qty,
					nonce: input.idempotencyKey,
				}),
			);
			switch (outcome.kind) {
				case "moved":
					if (!outcome.result.ok) return inconsistent();
					return { status: "removed", onHand: outcome.result.onHand };
				case "replayed":
					return { status: "replayed", liveOnHand: outcome.liveOnHand };
				case "stock_changed":
					return stockChanged(outcome.liveOnHand);
				case "failed":
					if (outcome.result.ok) return inconsistent();
					return stockRefusal(outcome.result, input.productId);
				default:
					return unhandled(outcome);
			}
		},
	}),
];
