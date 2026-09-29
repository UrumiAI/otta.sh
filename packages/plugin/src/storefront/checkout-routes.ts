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
import { makeCommerceClient } from "../commerce/make-commerce-client.js";
import type { CatalogProductCommerce } from "../catalog/commerce-view.js";
import type {
	CartFailureReason,
	CheckoutFailureReason,
	CheckoutPreviewResult,
	ClientActionWire,
	QuoteFailureReason,
} from "../product-commerce/commerce-client.js";
import type { RouteHandler } from "../types.js";
import {
	buildCartPricing,
	DEGRADED_CART_PRICING,
	type CartMoneyWire,
	type CartPricingWire,
} from "./cart-pricing.js";
import {
	parseCheckoutPlaceInput,
	parseCheckoutSummaryInput,
	parseOrderRouteInput,
} from "./checkout-route-input.js";
import {
	buildCheckoutLines,
	buildCheckoutTotals,
	buildCouponView,
	buildOrderTotal,
	buildOrderView,
	buildShippingView,
	checkoutIdempotencyKey,
	isAlreadyPlaced,
	totalsOptionsFor,
	type CheckoutCouponView,
	type CheckoutLineView,
	type CheckoutShippingView,
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
	/** The ship-to as far as the buyer has filled it in; only `country` and
	 *  `region` are read (they derive the zone). */
	shippingAddress?: unknown;
	/** A method from the DERIVED zone's offered list. */
	shippingMethodId?: unknown;
	couponCode?: unknown;
	// NO zone field, deliberately (issue #305): a body that carries one has it
	// ignored — the zone is derived from `shippingAddress`, server-side.
}

export interface CheckoutPlaceRouteInput {
	cartId?: unknown;
	buyerRef?: unknown;
	/** From the rendered form, forwarded verbatim — the route never invents one
	 *  (`checkoutIdempotencyKey` is how the summary derives it). */
	idempotencyKey?: unknown;
	shippingAddress?: unknown;
	/** The method the buyer chose on the review page. It must be one the zone
	 *  DERIVED from `shippingAddress` offers; there is no zone field to send. */
	shippingMethodId?: unknown;
	couponCode?: unknown;
	/** For `total.formatted` only — the same `sanitizeLocale` default the other
	 *  two routes take, so the amount on the pay button reads exactly like the
	 *  total the buyer just approved on the review page. */
	locale?: unknown;
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
			/** The derived zone, its methods priced for this cart, and the choice. */
			shipping: CheckoutShippingView;
			coupon: CheckoutCouponView;
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
			/**
			 * The order's OWN total, from the reply that created it — the figure
			 * the PaymentIntent was minted for, formatted here (§4.6's boundary).
			 *
			 * It is on THIS result and not re-read later because it is a snapshot,
			 * not live data: the cart it came from stays mutable, and the pay step
			 * must state the amount that will actually be charged.
			 *
			 * OPTIONAL, and the optionality is load-bearing: ABSENT when the reply's
			 * totals could not be formatted. The order exists by then, its stock is
			 * held and its client secret is in hand, so a totals block this package
			 * cannot read (missing, a lowercase currency, a non-integer amount) must
			 * cost the button its amount and nothing else — the label is never worth
			 * the payment. A healthy reply always carries it, replays included.
			 */
			total?: CartMoneyWire;
	  }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: CheckoutFailureReason | QuoteFailureReason | CheckoutShippingRefusal }
	| { ok: false; error: "RENDER_FAILED" };

/**
 * Why `place` refused before any order existed, on shipping grounds (issue
 * #305). Each is checked against the zone DERIVED from the submitted address:
 *  - `SHIPPING_ADDRESS_REQUIRED` — a cart that ships, in a store that has
 *    shipping zones, sent no address;
 *  - `SHIPPING_UNAVAILABLE_FOR_ADDRESS` — no zone lists that address (or its
 *    zone has no method priced in the cart's currency);
 *  - `SHIPPING_METHOD_REQUIRED` — the zone offers methods and none was chosen;
 *  - `SHIPPING_METHOD_NOT_AVAILABLE` — the chosen method is not one this
 *    address's zone offers.
 */
export type CheckoutShippingRefusal =
	| "SHIPPING_ADDRESS_REQUIRED"
	| "SHIPPING_UNAVAILABLE_FOR_ADDRESS"
	| "SHIPPING_METHOD_REQUIRED"
	| "SHIPPING_METHOD_NOT_AVAILABLE";

export type OrderRouteResult =
	| { ok: true; order: PublicOrderView }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: "ORDER_NOT_FOUND" }
	| { ok: false; error: "RENDER_FAILED" };

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

			const client = await makeCommerceClient(ctx);
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
				console.error(`[otta] ${STOREFRONT_CHECKOUT_SUMMARY_ROUTE} pricing join failed:`, err);
				pricing = DEGRADED_CART_PRICING;
			}

			// The preview is the authority on every total — and on whether this cart
			// can be ordered at all: CART_EMPTY / PRODUCT_NOT_PRICED /
			// CURRENCY_MISMATCH arrive here as TYPED reasons the theme turns into a
			// redirect or honest copy, never a half-rendered payable page. It
			// derives the shipping zone from the address (issue #305) — never from
			// the request — and prices tax in that same zone.
			const preview = await client.previewCheckout({
				cartId: input.cartId,
				...(input.destination !== undefined ? { destination: input.destination } : {}),
				...(input.shippingMethodId !== undefined
					? { shippingMethodId: input.shippingMethodId }
					: {}),
				...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
			});
			if (!preview.ok) return { ok: false as const, reason: preview.reason };

			return {
				ok: true as const,
				cartId: cart.cartId,
				currency: cart.currency,
				lines: buildCheckoutLines(cart.lines, pricing),
				// A component the preview did not compute (no method chosen, no zone
				// derived, nothing configured) is reported as uncomputed rather than
				// rendering the pipeline's synthetic zeros as "Free" / "$0.00".
				totals: buildCheckoutTotals(
					preview.breakdown,
					totalsOptionsFor(preview.shipping, input.locale),
				),
				idempotencyKey: checkoutIdempotencyKey(cart.cartId),
				hasUnpricedLines: !pricing.allLinesPriced,
				shipping: buildShippingView(preview.shipping, preview.breakdown.currency, input.locale),
				coupon: buildCouponView(preview.coupon, preview.breakdown.currency, input.locale),
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

			const client = await makeCommerceClient(ctx);

			// Issue #305: derive the zone from the SUBMITTED address, server-side —
			// the body has no zone field and a spoofed one is never read — and check
			// the chosen method against that zone before anything is minted. The
			// coupon is deliberately NOT previewed here: `createOrder` validates and
			// redeems it itself, AFTER its idempotency short-circuit, so a replay of
			// a checkout that used a coupon's last redemption still returns its
			// order instead of COUPON_EXHAUSTED.
			const address = input.shippingAddress;
			const preview = await client.previewCheckout({
				cartId: input.cartId,
				...(address !== undefined
					? {
							destination: {
								country: address.country,
								...(address.region !== undefined ? { region: address.region } : {}),
							},
						}
					: {}),
				...(input.shippingMethodId !== undefined
					? { shippingMethodId: input.shippingMethodId }
					: {}),
			});
			if (!preview.ok) return { ok: false as const, reason: preview.reason };
			const refusal = shippingRefusal(preview.shipping);
			if (refusal !== null) return { ok: false as const, reason: refusal };
			const { shippingZoneId, shippingMethodId } = preview.selection;

			const result = await client.createOrder(
				{
					cartId: input.cartId,
					paymentMethod: PAYMENT_METHOD,
					buyerRef: input.buyerRef,
					...(address !== undefined ? { shippingAddress: address } : {}),
					...(shippingZoneId !== null ? { shippingZoneId } : {}),
					...(shippingMethodId !== null ? { shippingMethodId } : {}),
					...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
				},
				input.idempotencyKey,
			);
			if (!result.ok) return { ok: false as const, reason: result.reason };

			// CONTAINED, deliberately. `buildOrderTotal` runs `cents()`/`currency()`,
			// which THROW, over a reply this client has only envelope-checked — and
			// we are past `createOrder`, so an escaping throw would hit `renderGuard`
			// and return RENDER_FAILED for an order that already exists, whose stock
			// is held, and whose client secret is in this very reply. The site would
			// 303 back to /checkout and the idempotent replay would fail identically,
			// forever. Formatting is a label; the payment is not.
			let total: CartMoneyWire | undefined;
			try {
				total = buildOrderTotal(result.order, input.locale);
			} catch (err) {
				console.error(`[otta] ${STOREFRONT_CHECKOUT_PLACE_ROUTE} total format failed:`, err);
			}

			// PROJECT, never forward: the create reply is the FULL serializeOrder
			// (buyerRef, customerId, the ship-to snapshot). Only these fields
			// leave the plugin — and `total` is derived from the reply's own
			// `totals` block, never from the cart, which is still live.
			return {
				ok: true as const,
				orderId: result.order.id,
				state: result.order.state,
				alreadyPlaced: isAlreadyPlaced(result.intent),
				clientAction: result.intent.clientAction,
				...(total !== undefined ? { total } : {}),
			};
		});
}

/**
 * The shipping precondition `place` enforces, or null when the order may be
 * minted. Only a `resolved` zone with an offered method chosen ships; a
 * digital-only cart (`not_required`) and a store with no zones at all
 * (`not_configured`) keep today's behaviour and need neither.
 */
function shippingRefusal(
	shipping: Extract<CheckoutPreviewResult, { ok: true }>["shipping"],
): CheckoutShippingRefusal | null {
	switch (shipping.status) {
		case "not_required":
		case "not_configured":
			return null;
		case "address_required":
			return "SHIPPING_ADDRESS_REQUIRED";
		case "unavailable":
			return "SHIPPING_UNAVAILABLE_FOR_ADDRESS";
		case "resolved":
			if (shipping.selectionError !== null) return "SHIPPING_METHOD_NOT_AVAILABLE";
			return shipping.selectedMethodId === null ? "SHIPPING_METHOD_REQUIRED" : null;
	}
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

			const client = await makeCommerceClient(ctx);
			const result = await client.getPublicOrder(input.orderId);
			if (!result.ok) return { ok: false as const, reason: result.reason };

			return { ok: true as const, order: buildOrderView(result.order, input.locale) };
		});
}
