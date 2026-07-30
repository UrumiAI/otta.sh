/**
 * The checkout view model — pure (no `ctx`, no IO), so the theme shim stays a
 * view-model→markup mapping (ADR-0003 §3) and every rule below is unit-testable
 * without a sandbox.
 *
 * ── Honest zeros, the rule this module exists to enforce ──────────────────
 * `computeQuote` substitutes a synthetic ZERO-shipping method when no
 * `methodId` is passed, and skips the tax lookup entirely when no `zoneId` is
 * passed (`@otta-sh/domain`'s pricing/quote.ts). So a store with nothing
 * configured — which is every store today — gets `shippingCents: 0` and
 * `taxCents: 0` on the wire, indistinguishable at the number from a genuine
 * free-shipping, zero-tax order.
 *
 * Rendering that as "Free shipping" or "Tax: $0.00" would be a promise the
 * store never made, and an unexplained "—" is indistinguishable from an outage.
 * So a component that was NOT computed carries `money: null` and an honest
 * LABEL; a component that genuinely WAS computed carries its money even at
 * zero. The caller — which knows whether it passed a zone/method — says which.
 *
 * Money crosses this boundary through `formatMoney` (the plugin's one
 * sanctioned money→string boundary) with branded `cents()`/`currency()` inputs,
 * so a float or a bad currency code throws at the parse rather than rendering.
 */
import { formatMoney } from "../presentation/format-money.js";
import { cents, currency } from "../presentation/money.js";
import type { Currency } from "../presentation/money.js";
import type {
	CartLineWire,
	PaymentIntentWire,
	PublicOrderWire,
	QuoteBreakdownWire,
} from "../product-commerce/commerce-client.js";
import type { CartMoneyWire, CartPricingWire } from "./cart-pricing.js";

/** Shown for a component the store has not configured — never "Free", never a
 *  money string. The theme expands it with the reason ("no delivery options are
 *  configured for this store"); the token itself lives here so the honest-zero
 *  rule is asserted in one place. */
export const NOT_CALCULATED_LABEL = "Not calculated";

/** Shown for a component that is genuinely absent rather than uncomputed — no
 *  coupon applied, so there is no discount to state. */
export const NOT_APPLICABLE_LABEL = "—";

export interface CheckoutLineView {
	lineId: string;
	sku: string;
	qty: number;
	/** null when the line is not priceable (no productId, unsynced commerce,
	 *  inactive, currency mismatch, or a degraded lookup) — never a fabricated
	 *  number. Such a cart cannot in fact be checked out: `createOrderFromCart`
	 *  answers `PRODUCT_NOT_PRICED`. */
	unitPrice: CartMoneyWire | null;
	lineTotal: CartMoneyWire | null;
}

/** One totals row: the money when it was computed, plus the string the theme
 *  renders either way. `label` is ALWAYS safe to print. */
export interface CheckoutAmountView {
	money: CartMoneyWire | null;
	label: string;
}

export interface CheckoutTotalsView {
	subtotal: CheckoutAmountView;
	discount: CheckoutAmountView;
	shipping: CheckoutAmountView;
	tax: CheckoutAmountView;
	total: CheckoutAmountView;
	appliedCouponCode: string | null;
	/** true while shipping or tax was not computed — the theme's signal to
	 *  caveat the total ("this total does not include shipping or tax"). */
	totalExcludesUncalculated: boolean;
}

export interface CheckoutTotalsOptions {
	locale: string;
	/** Did the caller pass a shipping method to the quote? */
	shippingSelected: boolean;
	/** Did the caller pass a tax zone to the quote? */
	taxZoneSelected: boolean;
}

function money(amount: number, currencyCode: Currency, locale: string): CartMoneyWire {
	return {
		amount,
		currency: currencyCode,
		formatted: formatMoney(cents(amount), currencyCode, locale),
	};
}

function computed(amount: number, currencyCode: Currency, locale: string): CheckoutAmountView {
	const value = money(amount, currencyCode, locale);
	return { money: value, label: value.formatted };
}

function uncomputed(label: string): CheckoutAmountView {
	return { money: null, label };
}

/** Quote breakdown → the totals block the checkout page renders. */
export function buildCheckoutTotals(
	breakdown: QuoteBreakdownWire,
	options: CheckoutTotalsOptions,
): CheckoutTotalsView {
	const code = currency(breakdown.currency);
	const { locale } = options;
	const hasDiscount = breakdown.discountCents > 0 || breakdown.appliedCouponCode !== null;

	return {
		subtotal: computed(breakdown.subtotalCents, code, locale),
		discount: hasDiscount
			? computed(breakdown.discountCents, code, locale)
			: uncomputed(NOT_APPLICABLE_LABEL),
		shipping: options.shippingSelected
			? computed(breakdown.shippingCents, code, locale)
			: uncomputed(NOT_CALCULATED_LABEL),
		tax: options.taxZoneSelected
			? computed(breakdown.taxCents, code, locale)
			: uncomputed(NOT_CALCULATED_LABEL),
		total: computed(breakdown.totalCents, code, locale),
		appliedCouponCode: breakdown.appliedCouponCode,
		totalExcludesUncalculated: !options.shippingSelected || !options.taxZoneSelected,
	};
}

/** Cart lines + the `buildCartPricing` join → the review table's rows. A line
 *  with no pricing row (degraded lookup, unpriceable line) keeps its identity
 *  and quantity and shows no money — the page must still be able to say WHAT
 *  is in the order. */
export function buildCheckoutLines(
	lines: CartLineWire[],
	pricing: CartPricingWire,
): CheckoutLineView[] {
	return lines.map((line) => {
		const priced = pricing.lines.find((p) => p.lineId === line.lineId) ?? null;
		return {
			lineId: line.lineId,
			sku: line.sku,
			qty: line.qty,
			unitPrice: priced?.unitPrice ?? null,
			lineTotal: priced?.lineTotal ?? null,
		};
	});
}

/**
 * The order's OWN total, as of the moment it was created — the figure the
 * PaymentIntent was minted for.
 *
 * Deliberately a plain `CartMoneyWire` and not a `CheckoutAmountView`: the
 * honest-zero rule above is about COMPONENTS the store never configured, and an
 * order's total is never one of those. An order exists, so its total was
 * computed, so there is no "Not calculated" case to represent.
 *
 * Formatted HERE rather than at the caller because this package owns the one
 * sanctioned money→string boundary (`formatMoney`, branded inputs). The site
 * has no formatter and no locale of its own; it prints what it is handed.
 */
export function buildOrderTotal(order: PublicOrderWire, locale: string): CartMoneyWire {
	return money(order.totals.totalCents, currency(order.totals.currency), locale);
}

export interface OrderLineView {
	sku: string;
	title: string;
	qty: number;
	fulfillmentKind: string;
	unitPrice: CartMoneyWire;
	lineTotal: CartMoneyWire;
}

/** The confirmation page's view of an order — built from
 *  `serializePublicOrder`'s whitelist ONLY (no `buyerRef`, no ship-to: the
 *  service omits them entirely for an unauthenticated read). */
export interface PublicOrderView {
	id: string;
	/** The order's OWN state — the only thing the page may claim. Stripe's
	 *  `redirect_status` never decides this; `settleOrder`, driven by the
	 *  `payment_intent.succeeded` webhook, is the sole `pending → paid`
	 *  authority (ADR-0012 decision 5). */
	state: string;
	currency: string;
	paymentMethod: string | null;
	holdExpiresAt: string;
	createdAt: string;
	totals: CheckoutTotalsView;
	lines: OrderLineView[];
	fulfillment: {
		carrier: string;
		trackingNumber: string;
		trackingUrl: string | null;
		shippedAt: string;
	} | null;
	cancellation: { reason: string; cancelledAt: string } | null;
}

/**
 * Public order wire → confirmation view model.
 *
 * The same honest-zero rule as the checkout page applies to the ORDER's own
 * totals, and for the same reason: an order placed with no shipping zone
 * carries `shippingCents: 0` / `taxCents: 0` from the identical synthetic-zero
 * pipeline. `totals.shippingZoneId` is the only evidence on the wire that a
 * zone was ever chosen, so it drives both flags — no zone ⇒ neither component
 * was calculated, and the page says so rather than promising free delivery on
 * an order that has not been priced for delivery.
 */
export function buildOrderView(order: PublicOrderWire, locale: string): PublicOrderView {
	const zoneSelected = order.totals.shippingZoneId !== null;
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		holdExpiresAt: order.holdExpiresAt,
		createdAt: order.createdAt,
		totals: buildCheckoutTotals(order.totals, {
			locale,
			shippingSelected: zoneSelected,
			taxZoneSelected: zoneSelected,
		}),
		lines: order.lines.map((l) => {
			const lineCode = currency(l.currency);
			return {
				sku: l.sku,
				title: l.title,
				qty: l.quantity,
				fulfillmentKind: l.fulfillmentKind,
				unitPrice: money(l.unitPriceCents, lineCode, locale),
				lineTotal: money(l.unitPriceCents * l.quantity, lineCode, locale),
			};
		}),
		fulfillment: order.fulfillment,
		cancellation: order.cancellation,
	};
}

/**
 * The checkout idempotency key — DETERMINISTIC in the cart id, exactly the
 * service's own documented fallback (`orders.ts`), but sent explicitly so the
 * behaviour never depends on an implicit server default.
 *
 * It must be stable across re-renders of `/checkout`, unlike the cart forms'
 * fresh-per-render keys: a fresh key on reload would mint a SECOND order, which
 * the `CART_CHECKED_OUT` fence then rejects — leaving the buyer with no way
 * forward. With this key a double-click, a reload or a back-then-forward
 * replays into the same order and (through Stripe's native idempotency) the
 * same PaymentIntent and client secret.
 */
export function checkoutIdempotencyKey(cartId: string): string {
	return `checkout:${cartId}`;
}

/**
 * A replay whose order has already LEFT `pending` (paid / failed / expired /
 * cancelled): `createOrderFromCart` short-circuits without minting an intent
 * and answers `intentId: ""` with `clientAction: { kind: "none" }`.
 *
 * That is not an error and must never be rendered as one — treating it as a
 * failure would strand a buyer whose order is already PAID. The site 303s
 * straight to `/orders/<id>` instead.
 */
export function isAlreadyPlaced(intent: PaymentIntentWire): boolean {
	return intent.clientAction.kind === "none";
}

/** The Stripe client secret to hand the browser, or null when this intent
 *  carries no card action (a replay, or a non-Stripe method). */
export function stripeClientSecret(intent: PaymentIntentWire): string | null {
	return intent.clientAction.kind === "stripe_client_secret"
		? intent.clientAction.clientSecret
		: null;
}
