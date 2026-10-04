/**
 * A2 (storefront-checkout plan §3) — the pure checkout view model.
 *
 * Two properties carry the whole design:
 *
 *  1. **Honest zeros.** `computeQuote` substitutes a synthetic zero-shipping
 *     method when no `methodId` is passed and skips the tax lookup entirely
 *     when no `zoneId` is passed, so a store with nothing configured gets
 *     `shippingCents: 0` / `taxCents: 0` on the wire. Rendering that as "Free
 *     shipping" or "Tax: $0.00" would be a promise the store has not made.
 *     Not-computed components render a LABEL, never a money string; a
 *     component that genuinely WAS computed renders its money even at zero.
 *
 *  2. **The idempotency key is stable per cart.** `checkout:${cartId}`,
 *     deterministic — a fresh key per render would mint a second order that
 *     the `CART_CHECKED_OUT` fence then rejects, stranding the buyer.
 */
import type { OrderState } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import type { CartPricingWire } from "../src/storefront/cart-pricing.js";
import {
	buildCheckoutLines,
	buildCheckoutTotals,
	buildOrderLines,
	buildOrderTotal,
	buildOrderView,
	buildShippingOptionsView,
	checkoutIdempotencyKey,
	isAlreadyPlaced,
	isSilentSelectionReason,
	lockedCheckoutPhase,
	NOT_APPLICABLE_LABEL,
	NOT_CALCULATED_LABEL,
	selectionFieldFor,
	uncalculatedReasonFor,
	type LockedCheckoutPhase,
	type SelectionField,
} from "../src/storefront/checkout-view-model.js";
import type {
	CartLineWire,
	PublicOrderWire,
	QuoteFailureReason,
} from "../src/product-commerce/commerce-client.js";

const LOCALE = "en-US";

const BREAKDOWN = {
	currency: "USD",
	subtotalCents: 3998,
	discountCents: 0,
	shippingCents: 0,
	taxCents: 0,
	totalCents: 3998,
	appliedCouponCode: null,
};

describe("buildCheckoutTotals — money formatting", () => {
	test("formats every computed money field through formatMoney (integer minor units in, strings out)", () => {
		const totals = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: false,
			taxZoneSelected: false,
		});
		expect(totals.subtotal.money).toEqual({ amount: 3998, currency: "USD", formatted: "$39.98" });
		expect(totals.subtotal.label).toBe("$39.98");
		expect(totals.total.money).toEqual({ amount: 3998, currency: "USD", formatted: "$39.98" });
		expect(totals.total.label).toBe("$39.98");
	});

	test("never emits a float anywhere in the view model", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN, subtotalCents: 105, totalCents: 105 },
			{ locale: LOCALE, shippingSelected: false, taxZoneSelected: false },
		);
		expect(Number.isInteger(totals.subtotal.money!.amount)).toBe(true);
		expect(totals.subtotal.money!.formatted).toBe("$1.05");
	});
});

describe("buildCheckoutTotals — honest zeros (§1.4)", () => {
	test('with NO shipping method selected, shipping is "Not calculated" — never "Free", never "$0.00"', () => {
		const totals = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: false,
			taxZoneSelected: false,
		});
		expect(totals.shipping.money).toBeNull();
		expect(totals.shipping.label).toBe(NOT_CALCULATED_LABEL);
		expect(totals.shipping.label).not.toMatch(/free/i);
		expect(totals.shipping.label).not.toContain("$0.00");
	});

	test('with NO tax zone selected, tax is "Not calculated" — never "$0.00"', () => {
		const totals = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: false,
			taxZoneSelected: false,
		});
		expect(totals.tax.money).toBeNull();
		expect(totals.tax.label).toBe(NOT_CALCULATED_LABEL);
		expect(totals.tax.label).not.toContain("$0.00");
	});

	test("with no coupon applied, discount renders as absent — not a $0.00 discount", () => {
		const totals = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: false,
			taxZoneSelected: false,
		});
		expect(totals.discount.money).toBeNull();
		expect(totals.discount.label).toBe(NOT_APPLICABLE_LABEL);
		expect(totals.appliedCouponCode).toBeNull();
	});

	test("a component that genuinely WAS computed renders its money, even at zero (a real free-shipping method is a real promise)", () => {
		const totals = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: true,
			taxZoneSelected: true,
		});
		expect(totals.shipping.money).toEqual({ amount: 0, currency: "USD", formatted: "$0.00" });
		expect(totals.shipping.label).toBe("$0.00");
		expect(totals.tax.money).toEqual({ amount: 0, currency: "USD", formatted: "$0.00" });
	});

	test("an applied coupon renders the discount as real money plus its code", () => {
		const totals = buildCheckoutTotals(
			{ ...BREAKDOWN, discountCents: 500, totalCents: 3498, appliedCouponCode: "SAVE5" },
			{ locale: LOCALE, shippingSelected: false, taxZoneSelected: false },
		);
		expect(totals.discount.money).toEqual({ amount: 500, currency: "USD", formatted: "$5.00" });
		expect(totals.appliedCouponCode).toBe("SAVE5");
	});

	test("totalExcludesUncalculated is true while either shipping or tax is uncomputed, and false once both are", () => {
		const neither = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: false,
			taxZoneSelected: false,
		});
		expect(neither.totalExcludesUncalculated).toBe(true);

		const shippingOnly = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: true,
			taxZoneSelected: false,
		});
		expect(shippingOnly.totalExcludesUncalculated).toBe(true);

		const both = buildCheckoutTotals(BREAKDOWN, {
			locale: LOCALE,
			shippingSelected: true,
			taxZoneSelected: true,
		});
		expect(both.totalExcludesUncalculated).toBe(false);
	});
});

describe("buildCheckoutLines", () => {
	const lines: CartLineWire[] = [
		{
			lineId: "line-1",
			sku: "SKU-1",
			productId: "prod-1",
			qty: 2,
			reservationId: "res-1",
			expiresAt: "2099-01-01T00:00:00.000Z",
		},
		{
			lineId: "line-2",
			sku: "SKU-2",
			productId: null,
			qty: 1,
			reservationId: null,
			expiresAt: null,
		},
	];

	const pricing: CartPricingWire = {
		degraded: false,
		lines: [
			{
				lineId: "line-1",
				unitPrice: { amount: 1999, currency: "USD", formatted: "$19.99" },
				lineTotal: { amount: 3998, currency: "USD", formatted: "$39.98" },
			},
			{ lineId: "line-2", unitPrice: null, lineTotal: null },
		],
		total: { amount: 3998, currency: "USD", formatted: "$39.98" },
		allLinesPriced: false,
	};

	/** The degraded lookup's shape: the batch read failed, so nothing is named. */
	const NO_TITLES: ReadonlyMap<string, string | null> = new Map();

	test("joins each cart line to its pricing row by lineId", () => {
		const view = buildCheckoutLines(lines, pricing, NO_TITLES);
		expect(view).toEqual([
			{
				lineId: "line-1",
				sku: "SKU-1",
				title: null,
				qty: 2,
				unitPrice: { amount: 1999, currency: "USD", formatted: "$19.99" },
				lineTotal: { amount: 3998, currency: "USD", formatted: "$39.98" },
			},
			{ lineId: "line-2", sku: "SKU-2", title: null, qty: 1, unitPrice: null, lineTotal: null },
		]);
	});

	test("names each line by its product's title — the name the order will snapshot", () => {
		const view = buildCheckoutLines(lines, pricing, new Map([["prod-1", "Otta Mug"]]));
		expect(view[0]!.title).toBe("Otta Mug");
	});

	test("a line the store cannot name (no productId, no title cached) is null — never the sku dressed as a name", () => {
		const view = buildCheckoutLines(
			lines,
			pricing,
			new Map<string, string | null>([["prod-1", null]]),
		);
		expect(view.map((line) => line.title)).toEqual([null, null]);
	});

	test("an unpriced line carries nulls — never a fabricated zero", () => {
		const view = buildCheckoutLines(lines, pricing, NO_TITLES);
		expect(view[1]!.unitPrice).toBeNull();
		expect(view[1]!.lineTotal).toBeNull();
	});

	test("a degraded pricing join (no rows at all) leaves every line unpriced rather than throwing", () => {
		const view = buildCheckoutLines(
			lines,
			{
				degraded: true,
				lines: [],
				total: null,
				allLinesPriced: false,
			},
			NO_TITLES,
		);
		expect(view).toHaveLength(2);
		expect(view.every((l) => l.unitPrice === null && l.lineTotal === null)).toBe(true);
	});
});

describe("buildOrderLines — the locked review states the ORDER's snapshot", () => {
	test("each row carries the title the order froze at purchase time", () => {
		const order = {
			id: "order-1",
			lines: [
				{
					sku: "OTTA-MUG",
					title: "Otta Mug",
					unitPriceCents: 1800,
					currency: "USD",
					quantity: 2,
					fulfillmentKind: "physical",
				},
			],
		} as unknown as PublicOrderWire;
		expect(buildOrderLines(order, LOCALE)).toEqual([
			{
				lineId: "order-1:0",
				sku: "OTTA-MUG",
				title: "Otta Mug",
				qty: 2,
				unitPrice: { amount: 1800, currency: "USD", formatted: "$18.00" },
				lineTotal: { amount: 3600, currency: "USD", formatted: "$36.00" },
			},
		]);
	});
});

describe("checkoutIdempotencyKey", () => {
	test("is `checkout:<cartId>` — the service's own documented fallback, sent explicitly", () => {
		expect(checkoutIdempotencyKey("cart-1")).toBe("checkout:cart-1");
	});

	test("is STABLE across calls for the same cart (a fresh key per render would mint a second order)", () => {
		expect(checkoutIdempotencyKey("cart-1")).toBe(checkoutIdempotencyKey("cart-1"));
	});

	test("differs per cart", () => {
		expect(checkoutIdempotencyKey("cart-1")).not.toBe(checkoutIdempotencyKey("cart-2"));
	});
});

describe("isAlreadyPlaced", () => {
	test('a clientAction of kind "none" means the replayed order has LEFT pending — already placed', () => {
		expect(
			isAlreadyPlaced({ gateway: "stripe", intentId: "", clientAction: { kind: "none" } }),
		).toBe(true);
	});

	test("a live stripe client secret is NOT already placed", () => {
		expect(
			isAlreadyPlaced({
				gateway: "stripe",
				intentId: "pi_1",
				clientAction: { kind: "stripe_client_secret", clientSecret: "pi_1_secret_x" },
			}),
		).toBe(false);
	});
});

/**
 * The order's own total — what `storefront/checkout/place` hands back so the
 * site can stash it beside the client secret and the pay button can state the
 * amount ("Pay $40.00", TEMPERED.md §7).
 *
 * The rule being pinned is that this is the ORDER's figure, formatted once, at
 * the moment the PaymentIntent was minted. Nothing downstream re-derives it: a
 * total re-quoted from the cart later could differ from what Stripe will take.
 */
describe("buildOrderTotal", () => {
	const order = (totals: Partial<typeof BREAKDOWN>): PublicOrderWire =>
		({
			id: "order-1",
			state: "pending",
			currency: "USD",
			paymentMethod: "stripe",
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			createdAt: "2026-07-27T00:00:00.000Z",
			totals: { ...BREAKDOWN, ...totals, shippingZoneId: null, shippingMethodId: null },
			lines: [],
			fulfillment: null,
			cancellation: null,
			latePayment: "none",
		}) as PublicOrderWire;

	test("is the order's totalCents, through the one money→string boundary", () => {
		expect(buildOrderTotal(order({ totalCents: 4000 }), LOCALE)).toEqual({
			amount: 4000,
			currency: "USD",
			formatted: "$40.00",
		});
	});

	test("takes the currency off the TOTALS block, so amount and code cannot disagree", () => {
		// `order.currency` is a second copy of the same fact. Reading the one that
		// sits beside the number is what makes a mismatch unrepresentable rather
		// than merely unlikely.
		const mismatched = order({ currency: "JPY", totalCents: 4000 });
		expect(buildOrderTotal(mismatched, LOCALE)).toEqual({
			amount: 4000,
			currency: "JPY",
			// Zero-decimal, from ICU's own table — never a divide-by-100.
			formatted: "¥4,000",
		});
	});

	test("a genuinely free order is a figure, not an absence", () => {
		// Deliberately NOT a CheckoutAmountView: the honest-zero rule is about
		// components a store never configured, and an order's total is never one.
		expect(buildOrderTotal(order({ totalCents: 0 }), LOCALE).formatted).toBe("$0.00");
	});
});

/**
 * The confirmation page's totals (#305). Shipping and tax are decided by
 * DIFFERENT evidence: a charged shipping fee follows the METHOD the order was
 * priced with, tax follows the ZONE. Before #305 both followed the zone, which
 * turned a real shipping charge into "Not calculated" beside a total that
 * included it.
 */
describe("buildOrderView — honest zeros on the ORDER's own totals", () => {
	const order = (
		totals: Partial<PublicOrderWire["totals"]>,
		extra: Partial<PublicOrderWire> = {},
	): PublicOrderWire => ({
		id: "order-1",
		state: "pending",
		currency: "USD",
		paymentMethod: "stripe",
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		createdAt: "2026-07-27T00:00:00.000Z",
		totals: { ...BREAKDOWN, shippingZoneId: null, shippingMethodId: null, ...totals },
		lines: [],
		fulfillment: null,
		cancellation: null,
		latePayment: "none",
		...extra,
	});

	test('neither method nor zone ⇒ shipping and tax are "Not calculated"', () => {
		const view = buildOrderView(order({}), LOCALE);
		expect(view.totals.shipping).toEqual({ money: null, label: NOT_CALCULATED_LABEL });
		expect(view.totals.tax).toEqual({ money: null, label: NOT_CALCULATED_LABEL });
		expect(view.totals.totalExcludesUncalculated).toBe(true);
	});

	test('a LEGACY order priced with a method and no zone (placed before ADR-0021) ⇒ shipping is real money (even $0.00), tax "Not calculated"', () => {
		// Since #305 part 2 every new order that carries a method carries the zone
		// it was matched to, so this shape is only ever an order placed under
		// part 1 — which must still read truthfully: it was charged shipping and
		// no tax was calculated for it.
		const charged = buildOrderView(
			order({ shippingMethodId: "m-1", shippingCents: 599, totalCents: 4597 }),
			LOCALE,
		);
		expect(charged.totals.shipping.label).toBe("$5.99");
		expect(charged.totals.tax).toEqual({ money: null, label: NOT_CALCULATED_LABEL });
		expect(charged.totals.totalExcludesUncalculated).toBe(true);

		// A method whose free threshold the order met: a COMPUTED zero, never an absence.
		const free = buildOrderView(order({ shippingMethodId: "m-1", shippingCents: 0 }), LOCALE);
		expect(free.totals.shipping.money).toEqual({ amount: 0, currency: "USD", formatted: "$0.00" });
	});

	test("zone + method ⇒ both computed, and the total excludes nothing", () => {
		const view = buildOrderView(
			order({ shippingZoneId: "z-1", shippingMethodId: "m-1", shippingCents: 599, taxCents: 400 }),
			LOCALE,
		);
		expect(view.totals.shipping.label).toBe("$5.99");
		expect(view.totals.tax.label).toBe("$4.00");
		expect(view.totals.totalExcludesUncalculated).toBe(false);
	});

	test("the late-payment status rides through untouched — the page picks its 'was anything charged?' copy from it", () => {
		for (const latePayment of ["none", "refunded", "refund_pending"] as const) {
			expect(buildOrderView(order({}, { state: "expired", latePayment }), LOCALE).latePayment).toBe(
				latePayment,
			);
		}
	});
});

describe("selectionFieldFor — which selection a quote refusal blames", () => {
	/** Typed as a Record over the WHOLE union, so a reason added to the wire
	 *  without a classification here fails the type check, not a buyer. */
	const EXPECTED: Record<QuoteFailureReason, SelectionField | null> = {
		COUPON_NOT_FOUND: "coupon",
		COUPON_NOT_ACTIVE: "coupon",
		COUPON_MIN_SUBTOTAL: "coupon",
		COUPON_EXHAUSTED: "coupon",
		COUPON_CURRENCY_MISMATCH: "coupon",
		SHIPPING_METHOD_NOT_FOUND: "shippingMethod",
		SHIPPING_RATE_NOT_FOUND: "shippingMethod",
		// ADR-0021: a refusal of the destination drops the destination AND the
		// method (a method is only meaningful inside the zone it came from)…
		INVALID_SHIPPING_ADDRESS: "destination",
		SHIPPING_ZONE_NOT_MATCHED: "destination",
		SHIPPING_REGION_CODE_REQUIRED: "destination",
		// …one that blames the method keeps the destination.
		MISSING_SHIPPING_ADDRESS: "shippingMethod",
		SHIPPING_METHOD_NOT_IN_ZONE: "shippingMethod",
		// Dropped SILENTLY (see isSilentSelectionReason).
		SHIPPING_METHOD_NOT_APPLICABLE: "shippingMethod",
		CART_NOT_FOUND: null,
		CART_EMPTY: null,
		PRODUCT_NOT_PRICED: null,
		CURRENCY_MISMATCH: null,
	};

	test.each(Object.entries(EXPECTED))("%s → %s", (reason, field) => {
		expect(selectionFieldFor(reason as QuoteFailureReason)).toBe(field);
	});

	test("only SHIPPING_METHOD_NOT_APPLICABLE is silent: a stale method on a digital-only cart is dropped with no notice (D10)", () => {
		for (const reason of Object.keys(EXPECTED) as QuoteFailureReason[]) {
			expect(isSilentSelectionReason(reason), reason).toBe(
				reason === "SHIPPING_METHOD_NOT_APPLICABLE",
			);
		}
	});
});

describe("buildShippingOptionsView — the delivery choices of the matched zone", () => {
	const OPTIONS = [
		{ methodId: "m-flat", name: "Standard", type: "flat_rate" as const, amountCents: 599 },
		{ methodId: "m-free", name: "Free over $10", type: "free_shipping" as const, amountCents: 0 },
		{ methodId: "m-none", name: "Courier", type: "flat_rate" as const, amountCents: null },
	];

	test("each priced option carries its money; a computed zero reads Free; the selected one is marked", () => {
		const view = buildShippingOptionsView(OPTIONS, {
			currency: "USD",
			locale: LOCALE,
			selected: "m-free",
		});
		expect(view).toEqual([
			{ id: "m-flat", label: "Standard", price: "$5.99", disabled: false, selected: false },
			{ id: "m-free", label: "Free over $10", price: "Free", disabled: false, selected: true },
			{ id: "m-none", label: "Courier", price: "Unavailable", disabled: true, selected: false },
		]);
	});

	test("an option with no rate is disabled and never labelled Free, even when its name says so", () => {
		const [view] = buildShippingOptionsView(
			[{ methodId: "m", name: "Free shipping", type: "free_shipping", amountCents: null }],
			{ currency: "USD", locale: LOCALE, selected: "m" },
		);
		expect(view).toMatchObject({ disabled: true, selected: false, price: "Unavailable" });
	});
});

describe("uncalculatedReasonFor — why the total leaves something out", () => {
	test.each([
		["no_zones", false, "no_zones"],
		["address_needed", false, "address_needed"],
		["not_required", false, "digital_only"],
		["matched", false, "method_needed"],
		["matched", true, null],
	] as const)("%s (method selected: %s) → %s", (status, methodSelected, reason) => {
		expect(uncalculatedReasonFor(status, methodSelected)).toBe(reason);
	});
});

describe("lockedCheckoutPhase — what a cart that already became an order may offer", () => {
	/** EVERY domain order state, typed as a Record so a state added to the model
	 *  without a decision here fails the type check. */
	const EXPECTED: Record<OrderState, LockedCheckoutPhase> = {
		// Still inside the checkout window: the same-key place replays it to payment.
		pending: "payable",
		// NO LONGER PAYABLE — only these two. `expireOrders` does not reopen the
		// cart, so the only way on is a new cart; a pay button would lead nowhere.
		// NOT "never charged": a declined attempt fails the order while its intent
		// stays confirmable, and a payment can land just after the TTL sweep — so
		// nothing built on `ended` may claim anything about money.
		expired: "ended",
		failed: "ended",
		// CANCELLED IS NOT "ended": the domain allows paid → cancelled and
		// processing → cancelled, so a cancelled order may have been charged. The
		// confirmation page states what actually happened ("This order was
		// cancelled."), which the checkout page cannot.
		cancelled: "placed",
		// Paid or beyond: the confirmation page is the truth.
		paid: "placed",
		processing: "placed",
		shipped: "placed",
		delivered: "placed",
		completed: "placed",
		refunded: "placed",
	};

	test.each(Object.entries(EXPECTED))("%s → %s", (state, phase) => {
		expect(lockedCheckoutPhase(state)).toBe(phase);
	});

	test("a state this build does not know is 'placed' — never a pay button, never \"start again\" over an order that may be paid", () => {
		expect(lockedCheckoutPhase("some_future_state")).toBe("placed");
	});
});
