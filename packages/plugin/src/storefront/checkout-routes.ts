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
import { isIdToken } from "../commerce/commerce-input.js";
import { makeCommerceClient } from "../commerce/make-commerce-client.js";
import type { CatalogProductCommerce } from "../catalog/commerce-view.js";
import type {
	CartFailureReason,
	CartWire,
	CheckoutFailureReason,
	ClientActionWire,
	PublicOrderWire,
	QuoteBreakdownWire,
	QuoteDestinationWire,
	QuoteFailureReason,
	QuoteRequestWire,
	QuoteResult,
} from "../product-commerce/commerce-client.js";
import type { RouteHandler } from "../types.js";
import {
	buildCartPricing,
	DEGRADED_CART_PRICING,
	type CartMoneyWire,
	type CartPricingWire,
} from "./cart-pricing.js";
import {
	exceedsAddressBounds,
	parseCheckoutPlaceInput,
	parseCheckoutSummaryInput,
	parseOrderRouteInput,
	type CheckoutSelection,
} from "./checkout-route-input.js";
import {
	buildCheckoutLines,
	buildCheckoutTotals,
	buildOrderLines,
	buildOrderTotal,
	buildOrderView,
	buildShippingOptionsView,
	checkoutIdempotencyKey,
	isAlreadyPlaced,
	isCouponSelectionReason,
	isDestinationSelectionReason,
	isShippingSelectionReason,
	isSilentSelectionReason,
	lockedCheckoutPhase,
	orderTotalsFlags,
	uncalculatedReasonFor,
	type CheckoutLineView,
	type CheckoutTotalsView,
	type CouponSelectionReason,
	type DestinationSelectionReason,
	type LockedCheckoutPhase,
	type PublicOrderView,
	type ShippingOptionView,
	type ShippingSelectionReason,
	type UncalculatedReason,
} from "./checkout-view-model.js";
import { createCommerceLoader, renderGuard, type RenderGuardFailure } from "./pdp-route.js";

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
	/** Trimmed, case kept (lookup is case-sensitive); blank ⇒ no coupon. */
	couponCode?: unknown;
	shippingMethodId?: unknown;
	/** `{ country, region? }` — ISO codes (ADR-0021). The coarse ship-to the
	 *  review is priced for; the zone is derived from it. Never a street address. */
	destination?: unknown;
	// There is deliberately NO `shippingZoneId`: the tax zone is never the
	// client's to choose. A body that carries one is read for nothing.
}

export interface CheckoutPlaceRouteInput {
	cartId?: unknown;
	buyerRef?: unknown;
	/** From the rendered form, forwarded verbatim — the route never invents one
	 *  (`checkoutIdempotencyKey` is how the summary derives it). */
	idempotencyKey?: unknown;
	shippingAddress?: unknown;
	/** The same selection the summary priced — see {@link CheckoutSummaryRouteInput}. */
	couponCode?: unknown;
	shippingMethodId?: unknown;
	/** For `total.formatted` only — the same `sanitizeLocale` default the other
	 *  two routes take, so the amount on the pay button reads exactly like the
	 *  total the buyer just approved on the review page. */
	locale?: unknown;
	/** The signed-in shopper's session (the theme reads its own cookie — the
	 *  route is cookie-blind). The order is theirs from birth when the buyer
	 *  email is their own; otherwise, or without one, it is a guest order. */
	sessionToken?: unknown;
}

export interface OrderRouteInput {
	orderId?: unknown;
	locale?: unknown;
}

/** What the totals were computed WITH — the form echoes it, so the place
 *  prices exactly what the buyer reviewed. `null` ⇒ not applied. */
export interface CheckoutSelectionView {
	couponCode: string | null;
	shippingMethodId: string | null;
	/** The destination the totals were priced for (uppercased codes; region
	 *  as given, `CA` or `US-CA`), or `null` when none was. */
	destination: { country: string; region: string | null } | null;
}

/**
 * A selection the quote REFUSED. Reported beside totals computed without it, so
 * a mistyped coupon costs the buyer a notice, never a bounce to `/cart`. The
 * reasons are derived from the wire union (`Extract<>`), so they cannot drift.
 */
export interface CheckoutSelectionErrors {
	/** `code` is the code AS TYPED, so the page can put it back for correcting. */
	coupon?: { code: string; reason: CouponSelectionReason };
	shippingMethod?: { reason: ShippingSelectionReason };
	/** The destination was refused (ADR-0021) — it and the method were dropped. */
	destination?: { reason: DestinationSelectionReason };
}

/**
 * Delivery, as the review can offer it (ADR-0021). `status` is the quote's
 * zone resolution; `options` are the MATCHED zone's methods (empty otherwise)
 * and `noOptions` says the zone matched but offers nothing priced — the buyer
 * cannot place, and the page says why.
 */
export interface CheckoutShippingView {
	status: QuoteDestinationWire["status"];
	/** `US-CA` / `US` — the code the zone matched on. */
	matchedRegion: string | null;
	noOptions: boolean;
	options: ShippingOptionView[];
}

/** The order a cart already became — see `lockedCheckoutPhase`. */
export interface CheckoutLockedOrderView {
	id: string;
	state: string;
	phase: LockedCheckoutPhase;
}

interface CheckoutSummaryViewBase {
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
	selection: CheckoutSelectionView;
	selectionErrors: CheckoutSelectionErrors;
	/** Whether any line ships. */
	requiresShipping: boolean;
	shipping: CheckoutShippingView;
	/** The page must collect an address (a physical cart in a zoned store). */
	addressRequired: boolean;
	/**
	 * The ONE answer to "may the page offer the place button?". Unlocked: the
	 * cart ships nothing, or the store has no zones, or a zone matched and a
	 * method is selected. Locked: the order is still payable.
	 */
	readyToPlace: boolean;
	/** Why the total leaves something out (`null` when it leaves nothing out). */
	uncalculatedReason: UncalculatedReason | null;
}

export type CheckoutSummaryView = CheckoutSummaryViewBase &
	(
		| { orderCreated: false; order: null }
		/** LOCKED: the cart has already become this order. Totals, lines and
		 *  selection are the ORDER's, and any selection in the input is ignored —
		 *  the same-key place replays the order and re-prices nothing. */
		| { orderCreated: true; order: CheckoutLockedOrderView }
	);

export type CheckoutSummaryRouteResult =
	| CheckoutSummaryView
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: CartFailureReason | QuoteFailureReason }
	| RenderGuardFailure;

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
	| { ok: false; reason: CheckoutFailureReason }
	/**
	 * The idempotency key is not this cart's `checkout:<cartId>` — a page reviewed
	 * for some other cart, or a caller trying to bind another cart's key to this
	 * one. Nothing was minted, adopted or asked of the payment provider.
	 */
	| { ok: false; reason: "CHECKOUT_STALE" }
	| RenderGuardFailure;

export type OrderRouteResult =
	| { ok: true; order: PublicOrderView }
	| { ok: false; error: "INVALID_INPUT" }
	| { ok: false; reason: "ORDER_NOT_FOUND" }
	| RenderGuardFailure;

/**
 * The selection → the quote/checkout request's pricing fields. ONE function used
 * by both the summary and the place route, so the review and the order can never
 * be priced from different selections. There is no zone to forward: the domain
 * DERIVES it (ADR-0021) — from `destination` on the summary, from the ship-to
 * address on the place (whose parser never sets `destination`). A
 * client-supplied zone never reaches here: the parsers do not read one.
 */
function quoteSelection(
	selection: CheckoutSelection,
): Pick<QuoteRequestWire, "couponCode" | "shippingMethodId" | "destination"> {
	return {
		...(selection.couponCode !== undefined ? { couponCode: selection.couponCode } : {}),
		...(selection.shippingMethodId !== undefined
			? { shippingMethodId: selection.shippingMethodId }
			: {}),
		...(selection.destination !== undefined ? { destination: selection.destination } : {}),
	};
}

/** `selection` without the named keys. */
function without(
	selection: CheckoutSelection,
	...keys: ReadonlyArray<keyof CheckoutSelection>
): CheckoutSelection {
	const next: CheckoutSelection = { ...selection };
	for (const key of keys) delete next[key];
	return next;
}

/**
 * `GET /carts/:id` + `POST /catalog/commerce/batch` + `POST /checkout/quote` →
 * one review view model. Three calls, in that order, one batch regardless of
 * line count — plus, when the buyer's selection is refused, a bounded re-quote
 * without the refused part (at most three quotes in all).
 *
 * A cart that has ALREADY become an order is not quoted at all: the review is
 * LOCKED to that order (see `lockedSummary`).
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

			if (cart.orderId !== null) {
				const order = await client.getPublicOrder(cart.orderId);
				// DEGRADED, and defined: the cart names an order that cannot be read
				// (purged, or restored from an older backup). It can never be paid —
				// a same-key place finds no order and the cart is no longer active —
				// so the buyer is told what IS true: the cart has been checked out.
				// `/cart` renders that state and offers the way on.
				if (!order.ok) return { ok: false as const, reason: "CART_CHECKED_OUT" as const };
				return lockedSummary(cart, order.order, input.locale);
			}

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
			// Hoisted out of the try: the same batch names the lines (each row's
			// title cache, the string the order will snapshot). A failed lookup
			// leaves it empty, so the lines go nameless rather than the page down.
			let commerceById = new Map<string, CatalogProductCommerce | null>();
			try {
				if (productIds.length > 0) {
					const loader = await createCommerceLoader(ctx);
					commerceById = await loader.loadMany(productIds);
				}
				pricing = buildCartPricing(cart.lines, commerceById, cart.currency, input.locale);
			} catch (err) {
				console.error(`[otta] ${STOREFRONT_CHECKOUT_SUMMARY_ROUTE} pricing join failed:`, err);
				pricing = DEGRADED_CART_PRICING;
			}

			// The quote is the authority on every total — and on whether this cart
			// can be ordered at all: CART_EMPTY / PRODUCT_NOT_PRICED /
			// CURRENCY_MISMATCH arrive here as TYPED reasons the theme turns into a
			// redirect or honest copy, never a half-rendered payable page.
			//
			// A refusal that blames the buyer's SELECTION is different: it is
			// recorded, and the cart is quoted again WITHOUT that part, so a typo in
			// a coupon costs a notice rather than the checkout. A DESTINATION
			// refusal drops the method with it (a method only means something in
			// the zone it belongs to); a method on a cart that ships nothing is
			// dropped silently (D10). Each round drops at least one field, so this
			// ends — BOUNDED at three quotes because `computeQuote` (domain
			// pricing/quote.ts) checks destination → method → coupon in that order,
			// and a destination refusal drops the method too. Reordering those
			// checks there would change this bound. The single-option preselect
			// below may add a fourth.
			let selection = input.selection;
			const selectionErrors: CheckoutSelectionErrors = {};
			const quoteWith = (current: CheckoutSelection): Promise<QuoteResult> =>
				client.quoteCheckout({ cartId: input.cartId, ...quoteSelection(current) });
			let quote = await quoteWith(selection);
			while (!quote.ok) {
				const reason = quote.reason;
				if (isCouponSelectionReason(reason) && selection.couponCode !== undefined) {
					selectionErrors.coupon = { code: selection.couponCode, reason };
					selection = without(selection, "couponCode");
				} else if (isDestinationSelectionReason(reason) && selection.destination !== undefined) {
					selectionErrors.destination = { reason };
					selection = without(selection, "destination", "shippingMethodId");
				} else if (isShippingSelectionReason(reason) && selection.shippingMethodId !== undefined) {
					selectionErrors.shippingMethod = { reason };
					selection = without(selection, "shippingMethodId");
				} else if (isSilentSelectionReason(reason) && selection.shippingMethodId !== undefined) {
					selection = without(selection, "shippingMethodId");
				} else {
					return { ok: false as const, reason };
				}
				quote = await quoteWith(selection);
			}

			// The matched zone's delivery options — read ONCE per render (D12), after
			// the last fallback quote, from the quote's OWN reply: the zone id and
			// the subtotal never come from route input.
			const destination = quote.destination;
			const options =
				destination.status === "matched" && destination.zoneId !== null
					? await client.listShippingOptions({
							zoneId: destination.zoneId,
							currency: quote.breakdown.currency,
							discountedSubtotalCents: quote.discountedSubtotalCents,
						})
					: [];

			// PRESELECT (D4): a zone with exactly ONE option, priced in the cart's
			// currency, and no method chosen ⇒ choose it — there is nothing to
			// choose between. Never over an explicit method, never on the locked
			// page (which returned above). One more quote at most; if it fails, the
			// review keeps the previous result.
			const only = options.length === 1 ? options[0] : undefined;
			if (
				only !== undefined &&
				only.amountCents !== null &&
				selection.shippingMethodId === undefined
			) {
				const withMethod = { ...selection, shippingMethodId: only.methodId };
				const preselected = await quoteWith(withMethod);
				if (preselected.ok) {
					quote = preselected;
					selection = withMethod;
					// The explicit method was dropped because the destination moved to
					// another zone, and the one option there now fills it: the
					// "Delivery: {method} ({price})" line states the truth, so a
					// "delivery options changed" notice would only be noise.
					if (selectionErrors.shippingMethod?.reason === "SHIPPING_METHOD_NOT_IN_ZONE") {
						delete selectionErrors.shippingMethod;
					}
				}
			}

			const methodSelected = selection.shippingMethodId !== undefined;
			const status = quote.destination.status;
			const shipping: CheckoutShippingView = {
				status,
				matchedRegion: quote.destination.matchedRegion,
				noOptions: status === "matched" && !options.some((o) => o.amountCents !== null),
				options: buildShippingOptionsView(options, {
					currency: quote.breakdown.currency,
					locale: input.locale,
					selected: selection.shippingMethodId ?? null,
				}),
			};

			return {
				ok: true as const,
				cartId: cart.cartId,
				currency: cart.currency,
				lines: buildCheckoutLines(
					cart.lines,
					pricing,
					new Map([...commerceById].map(([id, commerce]) => [id, commerce?.title ?? null])),
				),
				totals: buildCheckoutTotals(quote.breakdown, {
					locale: input.locale,
					// Shipping was calculated iff a method was priced (a free-threshold
					// method is a COMPUTED zero); tax iff a zone matched (ADR-0021).
					shippingSelected: methodSelected,
					taxZoneSelected: status === "matched",
				}),
				idempotencyKey: checkoutIdempotencyKey(cart.cartId),
				hasUnpricedLines: !pricing.allLinesPriced,
				selection: {
					couponCode: selection.couponCode ?? null,
					shippingMethodId: selection.shippingMethodId ?? null,
					destination:
						selection.destination !== undefined
							? {
									country: selection.destination.country,
									region: selection.destination.region ?? null,
								}
							: null,
				},
				selectionErrors,
				requiresShipping: quote.requiresShipping,
				shipping,
				addressRequired: quote.requiresShipping && status !== "no_zones",
				readyToPlace:
					!quote.requiresShipping ||
					status === "no_zones" ||
					(status === "matched" && methodSelected),
				uncalculatedReason: uncalculatedReasonFor(status, methodSelected),
				orderCreated: false as const,
				order: null,
			};
		});
}

/**
 * The review of a cart that has ALREADY become an order — locked to it.
 *
 * A same-key place replays that order and never re-prices it
 * (`createOrderFromCart`'s idempotency short-circuit), so a review re-quoted
 * from the cart with a new coupon would show a figure nobody will charge. The
 * page states the ORDER instead: its totals, its line snapshot (so a product
 * unpublished since still renders), its coupon. The order's state decides what
 * the page may offer (`lockedCheckoutPhase`).
 */
function lockedSummary(
	cart: CartWire,
	order: PublicOrderWire,
	locale: string,
): CheckoutSummaryView {
	const totals: QuoteBreakdownWire = order.totals;
	const phase = lockedCheckoutPhase(order.state);
	// What the ORDER was priced with, read off its own snapshot: a zone ⇒ it
	// matched; no zone and a physical line ⇒ a store with no zones then; every
	// line digital ⇒ nothing shipped.
	const requiresShipping = order.lines.some((line) => line.fulfillmentKind === "physical");
	const status: QuoteDestinationWire["status"] =
		order.totals.shippingZoneId !== null
			? "matched"
			: requiresShipping
				? "no_zones"
				: "not_required";
	return {
		ok: true,
		cartId: cart.cartId,
		currency: order.currency,
		lines: buildOrderLines(order, locale),
		totals: buildCheckoutTotals(totals, { locale, ...orderTotalsFlags(order.totals) }),
		idempotencyKey: checkoutIdempotencyKey(cart.cartId),
		hasUnpricedLines: false,
		selection: {
			couponCode: order.totals.appliedCouponCode,
			shippingMethodId: order.totals.shippingMethodId,
			// The order's ship-to is private (the public projection omits it), and
			// nothing here may be changed anyway.
			destination: null,
		},
		selectionErrors: {},
		requiresShipping,
		// Nothing to choose: no options are read and none are offered. The
		// order's method is stated by its totals.
		shipping: { status, matchedRegion: null, noOptions: false, options: [] },
		// Nothing to collect: a same-key place replays the order before any
		// address or method is looked at (createOrderFromCart's I1).
		addressRequired: false,
		// The ONE source for the locked page: a pending order can still be paid.
		readyToPlace: phase === "payable",
		uncalculatedReason:
			status === "matched" ? null : status === "no_zones" ? "no_zones" : "digital_only",
		orderCreated: true,
		order: { id: order.id, state: order.state, phase },
	};
}

/**
 * `POST /checkout/orders` — mints the order, holds stock for the TTL, creates
 * the payment intent. Exactly one upstream call.
 */
export function createCheckoutPlaceRouteHandler(): RouteHandler<CheckoutPlaceRouteInput> {
	return (routeCtx, ctx): Promise<CheckoutPlaceRouteResult> =>
		renderGuard(STOREFRONT_CHECKOUT_PLACE_ROUTE, async () => {
			const input = parseCheckoutPlaceInput(routeCtx.input);
			if (input === null) {
				// Everything else is well-formed and only the ship-to has a field over
				// the domain's bound: that is the buyer's address being too long, the
				// typed INVALID_SHIPPING_ADDRESS the domain would give — not a malformed
				// call (QA U-6).
				const { shippingAddress, ...rest } = routeCtx.input;
				if (exceedsAddressBounds(shippingAddress) && parseCheckoutPlaceInput(rest) !== null) {
					return { ok: false as const, reason: "INVALID_SHIPPING_ADDRESS" as const };
				}
				return { ok: false, error: "INVALID_INPUT" } as const;
			}
			// The key is `checkout:<cartId>` BY CONSTRUCTION (the summary derives it),
			// and this route — public, reachable directly — now enforces that rather
			// than trusting its caller (QA T1-10). Taken as given, a caller could
			// place its own cart under `checkout:<another cart>`; that key would then
			// name the wrong order, and the other cart's real checkout would fail
			// IDEMPOTENCY_KEY_REUSED for good. Refused, not rewritten: the key is also
			// the review page's statement of which cart it priced, so a mismatch is a
			// stale page, and placing this cart against it would charge totals the
			// buyer never saw.
			if (input.idempotencyKey !== checkoutIdempotencyKey(input.cartId)) {
				return { ok: false as const, reason: "CHECKOUT_STALE" as const };
			}

			const client = await makeCommerceClient(ctx);
			const result = await client.createOrder(
				{
					cartId: input.cartId,
					paymentMethod: PAYMENT_METHOD,
					buyerRef: input.buyerRef,
					...quoteSelection(input.selection),
					...(input.shippingAddress !== undefined
						? { shippingAddress: input.shippingAddress }
						: {}),
				},
				input.idempotencyKey,
				input.sessionToken !== undefined ? { sessionToken: input.sessionToken } : {},
			);
			if (!result.ok) {
				// A same-key PaymentIntent request still in flight (a double-submitted
				// checkout) is not a failure: the first request is about to land, and
				// a retry with this same key returns its intent. So it is answered as
				// the storefront's retryable BUSY — "try again in a few seconds" — not
				// as PAYMENT_INTENT_FAILED's "we couldn't start a payment" (QA T1-9).
				if (result.reason === "PAYMENT_INTENT_IN_FLIGHT") {
					return { ok: false as const, error: "BUSY" as const, retryable: true as const };
				}
				return { ok: false as const, reason: result.reason };
			}

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
 * `GET /orders/:orderId` — the unauthenticated capability read that drives the
 * confirmation page. The order id is a `crypto.randomUUID()`, i.e. an
 * unguessable capability, and the service answers `serializePublicOrder`'s
 * whitelist to anyone without `X-Internal-Token` — a header this path never
 * sends (ADR-0010 §2).
 */
export function createOrderRouteHandler(): RouteHandler<OrderRouteInput> {
	return (routeCtx, ctx): Promise<OrderRouteResult> =>
		renderGuard(STOREFRONT_ORDER_ROUTE, async () => {
			// Not a string at all is a malformed CALL (no URL produces one):
			// INVALID_INPUT. Any string that cannot be an order id — blank,
			// over-long, carrying whitespace or a control character — names no order:
			// ORDER_NOT_FOUND, which the page renders as "not found". Before, such ids
			// were INVALID_INPUT or threw out of the client as RENDER_FAILED, both
			// "Something went wrong" on the page (QA U-6).
			if (typeof routeCtx.input.orderId !== "string") {
				return { ok: false, error: "INVALID_INPUT" } as const;
			}
			const input = parseOrderRouteInput(routeCtx.input);
			if (input === null || !isIdToken(input.orderId)) {
				return { ok: false, reason: "ORDER_NOT_FOUND" } as const;
			}

			const client = await makeCommerceClient(ctx);
			const result = await client.getPublicOrder(input.orderId);
			if (!result.ok) return { ok: false as const, reason: result.reason };

			return { ok: true as const, order: buildOrderView(result.order, input.locale) };
		});
}
