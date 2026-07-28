/**
 * Checkout — PLUGIN-OWNED PUBLIC ROUTES (storefront-checkout plan §1.2, shape
 * per ADR-0003 §5, which pre-authorized exactly this: "checkout/confirmation
 * pages follow the same pattern: public plugin route owns the view model and
 * orchestration; a theme page renders it").
 *
 * The responsibility line, unchanged from ADR-0003/0006: the PLUGIN owns every
 * commerce call and the view model; the SITE owns HTML, cookies, redirects,
 * CSRF and the Stripe.js integration. The plugin never sees a cookie and never
 * emits `Set-Cookie` (it structurally cannot — see cart-routes.ts's
 * platform-verified deviation note); it returns values, the site applies them.
 *
 * `storefront/checkout/summary` is deliberately ONE route rather than a quote
 * route the page composes with a separate cart read: ADR-0003 §3 puts all
 * storefront intelligence in the route handler and keeps the theme shim a pure
 * view-model→markup mapping. It composes three upstream calls — cart read, ONE
 * commerce batch (never one per line), quote — and takes the QUOTE's breakdown
 * as authoritative for every total: the two are computed from the same
 * `product_commerce` rows, and if they ever disagree the quote wins, because it
 * is what `createOrderFromCart` will actually charge.
 *
 * ADR-0012: none of this changes `allowedHosts`. The browser→Stripe hops
 * (Stripe.js and `confirmPayment`) belong to the theme page, not to `ctx.http`
 * — which is why Stripe's script host appears NOWHERE in this package, a
 * property `sandbox-clean-guard.test.ts` asserts by scanning `src/`.
 */
import type { CatalogProductCommerce } from "../catalog/commerce-view.js";
import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import type {
	CartFailureReason,
	CheckoutFailureReason,
	ClientActionWire,
	QuoteFailureReason,
} from "../product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { buildCartPricing, DEGRADED_CART_PRICING, type CartPricingWire } from "./cart-pricing.js";
import {
	parseCheckoutPlaceInput,
	parseCheckoutSummaryInput,
	parseOrderRouteInput,
} from "./checkout-route-input.js";
import {
	buildCheckoutLines,
	buildCheckoutTotals,
	buildOrderView,
	checkoutIdempotencyKey,
	isAlreadyPlaced,
	type CheckoutLineView,
	type CheckoutTotalsView,
	type PublicOrderView,
} from "./checkout-view-model.js";
import { createCommerceLoader, renderGuard } from "./pdp-route.js";

// ── Public route names ──────────────────────────────────────────────────
/** The ONE summary route. There is deliberately no `storefront/checkout/quote`
 *  — the quote is an upstream call this handler makes, not a route of its own. */
export const STOREFRONT_CHECKOUT_SUMMARY_ROUTE = "storefront/checkout/summary";
export const STOREFRONT_CHECKOUT_PLACE_ROUTE = "storefront/checkout/place";
export const STOREFRONT_ORDER_ROUTE = "storefront/order";

/** The one payment method this slice offers. x402's `x402_challenge` client
 *  action is a second flow, out of scope (plan §7.2). */
const PAYMENT_METHOD = "stripe" as const;

export interface CheckoutSummaryRouteInput {
	cartId?: unknown;
	locale?: unknown;
}

export interface CheckoutPlaceRouteInput {
	cartId?: unknown;
	buyerRef?: unknown;
	/** From the rendered form, forwarded verbatim — the route never invents one
	 *  (`checkoutIdempotencyKey` is how the summary derives it). */
	idempotencyKey?: unknown;
	shippingAddress?: unknown;
}

export interface OrderRouteInput {
	orderId?: unknown;
	locale?: unknown;
}

export type CheckoutSummaryRouteResult =
	| {
			ok: true;
			cartId: string;
			currency: string;
			lines: CheckoutLineView[];
			totals: CheckoutTotalsView;
			/** `checkout:<cartId>` — STABLE per cart; the form embeds it. */
			idempotencyKey: string;
			/** true when at least one line has no live price. Such a cart cannot be
			 *  ordered at all (`PRODUCT_NOT_PRICED`), so the page must not offer a
			 *  payable-looking button on the strength of the totals alone. */
			hasUnpricedLines: boolean;
	  }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: CartFailureReason | QuoteFailureReason }
	| { ok: false; error: "RENDER_FAILED" };

export type CheckoutPlaceRouteResult =
	| {
			ok: true;
			orderId: string;
			state: string;
			/** The order had already left `pending` — the reply carried
			 *  `clientAction: none`. The site 303s to `/orders/<id>`; treating this
			 *  as an error would strand a buyer whose order is already PAID. */
			alreadyPlaced: boolean;
			/** Passed through UNMODIFIED — the plugin does not parse a client
			 *  secret, it hands it on. */
			clientAction: ClientActionWire;
	  }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: CheckoutFailureReason }
	| { ok: false; error: "RENDER_FAILED" };

export type OrderRouteResult =
	| { ok: true; order: PublicOrderView }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: "ORDER_NOT_FOUND" }
	| { ok: false; error: "RENDER_FAILED" };

/** One client per invocation (cart-routes.ts's request-scoped lifecycle). The
 *  two checkout POSTs are non-GET, so they genuinely need the ADR-0007
 *  write-gate token; `GET /orders/:id` is gate-exempt but carries it harmlessly
 *  rather than making a future reader reason about which verb needs what. */
async function createCommerceClient(ctx: PluginContext): Promise<HttpCommerceClient> {
	const serviceToken = await serviceTokenFromKv(ctx);
	return new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
}

/**
 * `GET /carts/:id` + `POST /catalog/commerce/batch` + `POST /checkout/quote` →
 * one review view model. Three calls, in that order, one batch regardless of
 * line count.
 */
export function createCheckoutSummaryRouteHandler(): RouteHandler<CheckoutSummaryRouteInput> {
	return (routeCtx, ctx): Promise<CheckoutSummaryRouteResult> =>
		renderGuard(STOREFRONT_CHECKOUT_SUMMARY_ROUTE, async () => {
			const input = parseCheckoutSummaryInput(routeCtx.input);
			if (input === null) return { ok: false, error: "INVALID_INPUT" } as const;

			const client = await createCommerceClient(ctx);
			const cartResult = await client.getCart(input.cartId);
			if (!cartResult.ok) return { ok: false as const, reason: cartResult.reason };
			const cart = cartResult.cart;

			const productIds = [
				...new Set(
					cart.lines.map((line) => line.productId).filter((id): id is string => id !== null),
				),
			];

			// The line-money join (informational display). Its OWN try/catch,
			// separate from renderGuard's: a pricing-lookup failure must not turn
			// the whole checkout into RENDER_FAILED — the quote below is the
			// authority on what the buyer pays, and it is a separate call.
			let pricing: CartPricingWire;
			try {
				let commerceById = new Map<string, CatalogProductCommerce | null>();
				if (productIds.length > 0) {
					const loader = await createCommerceLoader(ctx);
					commerceById = await loader.loadMany(productIds);
				}
				pricing = buildCartPricing(cart.lines, commerceById, cart.currency, input.locale);
			} catch (err) {
				console.error(`[urumi] ${STOREFRONT_CHECKOUT_SUMMARY_ROUTE} pricing join failed:`, err);
				pricing = DEGRADED_CART_PRICING;
			}

			// The quote is the authority on every total — and on whether this cart
			// can be ordered at all: CART_EMPTY / PRODUCT_NOT_PRICED /
			// CURRENCY_MISMATCH arrive here as TYPED reasons the theme turns into a
			// redirect or honest copy, never a half-rendered payable page.
			const quote = await client.quoteCheckout({ cartId: input.cartId });
			if (!quote.ok) return { ok: false as const, reason: quote.reason };

			return {
				ok: true as const,
				cartId: cart.cartId,
				currency: cart.currency,
				lines: buildCheckoutLines(cart.lines, pricing),
				totals: buildCheckoutTotals(quote.breakdown, {
					locale: input.locale,
					// No coupon or shipping-method selection is offered this slice
					// (plan §7.2), so nothing was passed to the quote and neither
					// component was computed — say so, rather than rendering the
					// pipeline's synthetic zeros as "Free" / "$0.00".
					shippingSelected: false,
					taxZoneSelected: false,
				}),
				idempotencyKey: checkoutIdempotencyKey(cart.cartId),
				hasUnpricedLines: !pricing.allLinesPriced,
			};
		});
}

/**
 * `POST /checkout/orders` — mints the order, holds stock for the TTL, creates
 * the payment intent. Exactly one upstream call.
 */
export function createCheckoutPlaceRouteHandler(): RouteHandler<CheckoutPlaceRouteInput> {
	return (routeCtx, ctx): Promise<CheckoutPlaceRouteResult> =>
		renderGuard(STOREFRONT_CHECKOUT_PLACE_ROUTE, async () => {
			const input = parseCheckoutPlaceInput(routeCtx.input);
			if (input === null) return { ok: false, error: "INVALID_INPUT" } as const;

			const client = await createCommerceClient(ctx);
			const result = await client.createOrder(
				{
					cartId: input.cartId,
					paymentMethod: PAYMENT_METHOD,
					buyerRef: input.buyerRef,
					...(input.shippingAddress !== undefined
						? { shippingAddress: input.shippingAddress }
						: {}),
				},
				input.idempotencyKey,
			);
			if (!result.ok) return { ok: false as const, reason: result.reason };

			// PROJECT, never forward: the create reply is the FULL serializeOrder
			// (buyerRef, customerId, the ship-to snapshot). Only these four fields
			// leave the plugin.
			return {
				ok: true as const,
				orderId: result.order.id,
				state: result.order.state,
				alreadyPlaced: isAlreadyPlaced(result.intent),
				clientAction: result.intent.clientAction,
			};
		});
}

/**
 * `GET /orders/:orderId` — the unauthenticated capability read that drives the
 * confirmation page. The order id is a `crypto.randomUUID()`, i.e. an
 * unguessable capability, and the service answers `serializePublicOrder`'s
 * whitelist to anyone without `X-Internal-Token` — a header this path never
 * sends (ADR-0010 §2).
 */
export function createOrderRouteHandler(): RouteHandler<OrderRouteInput> {
	return (routeCtx, ctx): Promise<OrderRouteResult> =>
		renderGuard(STOREFRONT_ORDER_ROUTE, async () => {
			const input = parseOrderRouteInput(routeCtx.input);
			if (input === null) return { ok: false, error: "INVALID_INPUT" } as const;

			const client = await createCommerceClient(ctx);
			const result = await client.getPublicOrder(input.orderId);
			if (!result.ok) return { ok: false as const, reason: result.reason };

			return { ok: true as const, order: buildOrderView(result.order, input.locale) };
		});
}
