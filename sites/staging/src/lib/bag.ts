/**
 * The chrome's bag — the cart's lines, read for a theme whose CHROME draws them
 * outside `/cart` (e.g. a bag drawer or a bag strip). Opt-in:
 * `layouts/Storefront.astro` calls this only when the active theme sets
 * `chrome.cartLines`, and never on the checkout flow, so no other theme and no
 * other page pays for it.
 *
 * ONE cart read (the same public `storefront/cart/read` `/cart` makes) and, when
 * the cart has lines, ONE batched, request-cached content read for their names
 * and pictures — the cart page's own pattern, capped the same way. ONE means
 * one: the read is dispatched WITHOUT the dispatcher's BUSY retry
 * (`dispatchOttaRouteOnce`), because a contended bag is merely "unreadable" and
 * a retry would only slow the page it decorates.
 *
 * IT FAILS SOFT, AND THAT IS THE WHOLE CONTRACT. The bag is chrome: it decorates
 * a page that has its own job, so nothing here may turn that page into an error.
 *  - a read that fails, throws, or answers BUSY is `state: "unreadable"` — the
 *    drawer then offers the way to `/cart`, which says what went wrong. BUSY is
 *    NOT mapped to a 503 here (`markBusy`), and NOT retried: the product page a
 *    shopper is on answered, and a contended cart read must not un-answer it;
 *  - a content read that fails leaves the SKU standing, exactly as on `/cart`.
 *
 * Holds are stated as STATIC wall-clock copy ("Held for you until 2:10 pm UTC"):
 * the countdown script is `/cart`'s alone (ADR-0012), and a frozen "14:32" would
 * be true for one second. UTC is named for the reason `absoluteExpiry` gives —
 * the server cannot know the shopper's zone — and the minute is FLOORED, so the
 * copy never promises time the shopper does not have.
 */
import {
	CART_COOKIE_NAME,
	STOREFRONT_CART_READ_ROUTE,
	totalQty,
	type CartReadRouteResult,
} from "@otta-sh/plugin";
import { getEmDashCollection } from "emdash";
import { getPublicPluginApiRouteHandler } from "emdash/plugin-utils";
import type { BagLineModel, BagModel } from "../themes/contract.js";
import {
	isCartPricingDegraded,
	isCartTerminal,
	lineMoneyText,
	PRICED_AT_CHECKOUT_CELL,
} from "./cart-view.js";
import { holdView, wallClock } from "./hold.js";
import { dispatchOttaRouteOnce } from "./otta-api.js";
import { productImage, productKey, type ProductEntryData } from "./products.js";

/** The cart page's bound, for the cart page's reason (`cart/index.astro`). */
export const BAG_CONTENT_ID_CAP = 50;

export interface BagRequest {
	cookies: { get(name: string): { value: string } | undefined };
	locals: Parameters<typeof getPublicPluginApiRouteHandler>[0];
	url: URL;
}

/** `2:10 pm UTC` — defined beside the countdown it complements (`lib/hold.ts`). */
export { wallClock };

/** A line's hold, as words that stay true for as long as the page is open. */
export function bagHold(expiresAt: string | null, now: Date = new Date()): BagLineModel["hold"] {
	const view = holdView(expiresAt, now);
	if (view === null || expiresAt === null) return null;
	if (view.state === "released") return { state: "released", text: "Hold released" };
	const until = wallClock(expiresAt);
	if (until === null) return null;
	return view.state === "expiring"
		? { state: "expiring", text: `Held until ${until}. Check out to keep it.` }
		: { state: "held", text: `Held for you until ${until}` };
}

const UNREADABLE: BagModel = {
	state: "unreadable",
	count: null,
	lines: [],
	subtotal: null,
	partial: false,
};

const EMPTY: BagModel = { state: "empty", count: 0, lines: [], subtotal: null, partial: false };

export async function readBag(request: BagRequest): Promise<BagModel> {
	const cartId = request.cookies.get(CART_COOKIE_NAME)?.value;
	if (cartId === undefined || cartId.length === 0) return EMPTY;

	let result: CartReadRouteResult | null;
	try {
		result = await dispatchOttaRouteOnce<CartReadRouteResult>(
			getPublicPluginApiRouteHandler(request.locals),
			STOREFRONT_CART_READ_ROUTE,
			{ cartId },
			request.url,
		);
	} catch (cause) {
		console.error("[site-staging] bag cart read threw:", cause);
		return UNREADABLE;
	}

	// BUSY lands here too (it is `ok: false`): unreadable, and deliberately no
	// 503 — see the note at the top.
	if (result === null || !result.ok) {
		// A cart that no longer exists is an empty bag, not an outage.
		return result !== null && "reason" in result ? EMPTY : UNREADABLE;
	}

	const { cart, pricing } = result;
	if (isCartTerminal(cart.state)) {
		return { state: "checkedOut", count: null, lines: [], subtotal: null, partial: false };
	}
	if (cart.lines.length === 0) return EMPTY;

	const pricingDegraded = isCartPricingDegraded(pricing);
	const contentById = await lineContent(
		cart.lines.map((line) => line.productId).filter((id): id is string => id !== null),
	);
	const now = new Date();

	const lines = cart.lines.map((line): BagLineModel => {
		const content = line.productId === null ? null : (contentById.get(line.productId) ?? null);
		const linePricing = pricing?.lines.find((entry) => entry.lineId === line.lineId) ?? null;
		return {
			lineId: line.lineId,
			sku: line.sku,
			qty: line.qty,
			title: content?.title ?? null,
			name: content?.title ?? line.sku,
			image: content === null ? null : productImage(content),
			artKey: content === null ? (line.productId ?? line.sku) : productKey(content),
			money: lineMoneyText(linePricing?.lineTotal?.formatted, pricingDegraded),
			hold: bagHold(line.expiresAt, now),
			expiresAt: line.expiresAt,
			updateKey: crypto.randomUUID(),
			removeKey: crypto.randomUUID(),
		};
	});

	const total = pricing?.total ?? null;
	return {
		state: "lines",
		count: totalQty(cart),
		lines,
		subtotal:
			total !== null
				? total.formatted
				: pricingDegraded
					? "Unavailable right now"
					: PRICED_AT_CHECKOUT_CELL,
		partial: total !== null && pricing !== null && pricing !== undefined && !pricing.allLinesPriced,
	};
}

/** Names and pictures for the lines: one `WHERE id IN (…)`, request-cached. */
async function lineContent(ids: readonly string[]): Promise<Map<string, ProductEntryData>> {
	const byId = new Map<string, ProductEntryData>();
	const productIds = [...new Set(ids)].slice(0, BAG_CONTENT_ID_CAP);
	if (productIds.length === 0) return byId;
	try {
		const { entries, error } = await getEmDashCollection("products", {
			where: { id: productIds },
			limit: BAG_CONTENT_ID_CAP,
		});
		if (error !== undefined && error.name !== "LiveEntryNotFoundError") {
			console.error("[site-staging] bag line content lookup failed:", error);
		}
		for (const entry of entries) {
			const data = entry.data as unknown as ProductEntryData;
			byId.set(data.id, data);
		}
	} catch (cause) {
		console.error("[site-staging] bag line content lookup threw:", cause);
	}
	return byId;
}
