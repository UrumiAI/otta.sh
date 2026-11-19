/**
 * ADR-0047: building an agent session's cart and quoting it, through the commerce
 * client the storefront itself uses. NOTHING here computes money: lines are
 * validated against the catalog batch, added with `addCartLine` (which holds
 * stock and refuses what cannot be sold), and every amount comes verbatim from
 * `quoteCheckout` — the domain pricing the checkout summary shows. This module
 * only says which parts of that quote were really calculated (as the summary's
 * totals block does) and maps refusals to typed messages.
 */
import {
	cents,
	currency as toCurrency,
	isProductSellable,
	productId as toProductId,
	signedCents,
	sku as toSku,
	type AgentSessionLine,
	type AgentSessionQuote,
	type Currency,
} from "@urumi.ai/otta-domain";
import { parseCommerceBatchItem } from "../catalog/commerce-view.js";
import type {
	CommerceClient,
	DestinationRequestWire,
	QuoteFailureReason,
	QuoteRequestWire,
	QuoteResult,
} from "../product-commerce/commerce-client.js";
import {
	isCouponSelectionReason,
	isDestinationSelectionReason,
	isShippingSelectionReason,
	isSilentSelectionReason,
} from "../storefront/checkout-view-model.js";

/** One line as the agent asked for it (already shape-checked). */
export interface AgentLineRequest {
	productId: string;
	/** Optional: the sku the agent expects; refused when it is not the product's. */
	sku?: string;
	quantity: number;
}

/** What the agent asked to quote with (already shape-checked). */
export interface AgentSelection {
	destination?: DestinationRequestWire;
	shippingMethodId?: string;
	couponCode?: string;
}

/**
 * A typed message about one refused part of the request (UCP `messages[]`).
 * `code` is a token, never English; `path` names the request field. Carries no
 * shopper data.
 */
export interface AgentMessage {
	code: string;
	path: string;
}

export interface BuiltCart {
	cartId: string;
	currency: Currency;
	lines: AgentSessionLine[];
	messages: AgentMessage[];
}

/** The line's cart idempotency key: unique per cart and product. */
function lineKey(cartId: string, productId: string): string {
	return `agentic:${cartId}:line:${productId}`;
}

/**
 * Add `requested` to `cartId` (already created), each line checked against the
 * catalog batch first: an unknown, unsellable or other-currency product, a sku
 * that is not the product's, or a product named twice is refused with a message,
 * as is any line `addCartLine` refuses (out of stock, over the line cap). Only the
 * lines the cart took come back.
 */
export async function addAgentLines(
	client: CommerceClient,
	cartId: string,
	cartCurrency: string,
	requested: readonly AgentLineRequest[],
): Promise<{ lines: AgentSessionLine[]; messages: AgentMessage[] }> {
	const messages: AgentMessage[] = [];
	const lines: AgentSessionLine[] = [];
	const ids = [...new Set(requested.map((line) => line.productId))];
	const rows = ids.length === 0 ? [] : await client.getCommerceBatch(ids);
	const byId = new Map(rows.map((row) => [row.productId, parseCommerceBatchItem(row)]));
	const seen = new Set<string>();
	for (const [index, line] of requested.entries()) {
		const path = `lines[${String(index)}]`;
		if (seen.has(line.productId)) {
			messages.push({ code: "DUPLICATE_LINE", path });
			continue;
		}
		seen.add(line.productId);
		const row = byId.get(line.productId);
		if (row === undefined || !isProductSellable(row)) {
			messages.push({ code: "PRODUCT_UNAVAILABLE", path });
			continue;
		}
		if (line.sku !== undefined && line.sku !== row.sku) {
			messages.push({ code: "SKU_MISMATCH", path });
			continue;
		}
		if (row.price.currency !== cartCurrency) {
			messages.push({ code: "CURRENCY_MISMATCH", path });
			continue;
		}
		const added = await client.addCartLine(
			cartId,
			row.sku,
			line.productId,
			line.quantity,
			lineKey(cartId, line.productId),
		);
		if (!added.ok) {
			messages.push({ code: added.reason, path });
			continue;
		}
		lines.push({
			productId: toProductId(line.productId),
			sku: toSku(row.sku),
			quantity: line.quantity,
		});
	}
	return { lines, messages };
}

/**
 * Create the session's cart under `cartKey` (idempotent: a retried write lands in
 * the same cart) and add the requested lines. The cart's currency is the store's
 * (or `currency`, when the agent named one).
 */
export async function buildAgentCart(
	client: CommerceClient,
	cartKey: string,
	requested: readonly AgentLineRequest[],
	currency: string | undefined,
): Promise<BuiltCart | { failed: "CART_UNAVAILABLE" }> {
	const { cartId } = await client.createCart(currency, cartKey);
	const read = await client.getCart(cartId);
	if (!read.ok) return { failed: "CART_UNAVAILABLE" };
	const cartCurrency = read.cart.currency;
	const { lines, messages } = await addAgentLines(client, cartId, cartCurrency, requested);
	return { cartId, currency: toCurrency(cartCurrency), lines, messages };
}

/** The selection fields a refusal drops, as the checkout summary drops them. */
function dropRefused(
	selection: AgentSelection,
	reason: QuoteFailureReason,
): { next: AgentSelection; message: AgentMessage | null } | null {
	const next: AgentSelection = { ...selection };
	if (isCouponSelectionReason(reason) && selection.couponCode !== undefined) {
		delete next.couponCode;
		return { next, message: { code: reason, path: "couponCode" } };
	}
	if (isDestinationSelectionReason(reason) && selection.destination !== undefined) {
		delete next.destination;
		delete next.shippingMethodId;
		return { next, message: { code: reason, path: "destination" } };
	}
	if (isShippingSelectionReason(reason) && selection.shippingMethodId !== undefined) {
		delete next.shippingMethodId;
		return { next, message: { code: reason, path: "shippingMethodId" } };
	}
	if (isSilentSelectionReason(reason) && selection.shippingMethodId !== undefined) {
		delete next.shippingMethodId;
		return { next, message: null };
	}
	return null;
}

/** At most this many quotes: each round drops at least one selection field. */
const MAX_QUOTES = 4;

/**
 * Quote `cartId` with the agent's selection. A refusal that blames the selection
 * (a coupon, the destination, the method) is reported and the cart is quoted
 * again without it — the summary's own fallback — so a bad coupon costs a
 * message, not the quote. Any other refusal (an empty cart, an unpriced product)
 * means no quote; the reason comes back as a message.
 */
export async function quoteAgentCart(
	client: CommerceClient,
	cartId: string,
	selection: AgentSelection,
	nowIso: string,
): Promise<{ quote: AgentSessionQuote | undefined; messages: AgentMessage[] }> {
	const messages: AgentMessage[] = [];
	let current = selection;
	for (let round = 0; round < MAX_QUOTES; round++) {
		const request: QuoteRequestWire = {
			cartId,
			...(current.destination !== undefined ? { destination: current.destination } : {}),
			...(current.shippingMethodId !== undefined
				? { shippingMethodId: current.shippingMethodId }
				: {}),
			...(current.couponCode !== undefined ? { couponCode: current.couponCode } : {}),
		};
		const result = await client.quoteCheckout(request);
		if (result.ok) {
			return { quote: toSessionQuote(result, current, nowIso), messages };
		}
		const dropped = dropRefused(current, result.reason);
		if (dropped === null) {
			// An empty cart has nothing to quote; it is not an error to report.
			if (result.reason !== "CART_EMPTY") messages.push({ code: result.reason, path: "cart" });
			return { quote: undefined, messages };
		}
		if (dropped.message !== null) messages.push(dropped.message);
		current = dropped.next;
	}
	return { quote: undefined, messages };
}

/**
 * The quote's amounts, verbatim, with each part's "was it calculated" decided as
 * the checkout summary's totals block decides it: shipping only when a method
 * was priced (or the cart ships nothing), tax only when a zone matched, the
 * calculator located it, or tax is switched off. A part not calculated is `null`
 * (never zero), and then so is the total.
 */
function toSessionQuote(
	quote: Extract<QuoteResult, { ok: true }>,
	selection: AgentSelection,
	nowIso: string,
): AgentSessionQuote {
	const b = quote.breakdown;
	const fulfillment =
		selection.shippingMethodId !== undefined
			? cents(b.shippingCents)
			: quote.requiresShipping
				? null
				: cents(b.shippingCents);
	const taxKnown =
		b.tax?.enabled === false || quote.destination.status === "matched" || b.tax?.located === true;
	const tax = taxKnown ? cents(b.taxCents) : null;
	return {
		currency: toCurrency(b.currency),
		subtotal: cents(b.subtotalCents),
		discount: cents(b.discountCents),
		fulfillment,
		tax,
		...(b.roundingCents !== undefined ? { rounding: signedCents(b.roundingCents) } : {}),
		total: fulfillment !== null && tax !== null ? cents(b.totalCents) : null,
		quotedAt: nowIso,
	};
}
