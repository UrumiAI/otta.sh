/**
 * The cart page's money cells (storefront-checkout plan §5).
 *
 * A bare "—" in a price column is indistinguishable from three different
 * things: a free item, an outage, and a line the store simply cannot price
 * here. The reported "every money column shows —" symptom was the third case —
 * legacy cart lines carrying `product_id = NULL`, which `buildCartPricing`
 * short-circuits SILENTLY (`degraded` stays false, so no banner renders) — and
 * it was indistinguishable from the second, which is the whole problem.
 *
 * A visually identical failure comes from a stale worker bundle, where
 * `result.pricing` is `undefined` and the page's `pricing?.degraded` check
 * quietly evaluates to nothing. Treating ABSENT pricing as degraded closes that
 * one.
 *
 * This is the same rule the checkout's "Not calculated" totals follow: say
 * which of the three it is, or say nothing that looks like a number.
 */
import type { CartPricingWire } from "@urumi/plugin";
import { moneyCellText } from "./totals.js";

/** The line is real and orderable-looking, but no live price could be joined
 *  here. (Such a line in fact cannot be ordered — checkout answers
 *  `PRODUCT_NOT_PRICED` — but the cart is not the place to litigate that.) */
export const PRICED_AT_CHECKOUT_LABEL = "priced at checkout";

/**
 * The whole pricing lookup failed.
 *
 * This is a SENTINEL, not a thing to print. It is what `cartMoneyCell` returns
 * for the degraded case, and §7 forbids putting it on a screen: a lone dash is
 * indistinguishable from a free item and from a line this store cannot price.
 * Every caller is expected to pass it through `moneyCellText` with prose of its
 * own — `lineMoneyText` below is the cart's, and it prints
 * `PRICE_UNAVAILABLE_CELL` per row.
 *
 * Per-row prose beside a banner reads as repetition, and an earlier draft of
 * this comment defended the dash on that ground. It is wrong: the money column
 * is where a shopper looks for the figure, and "—" there says a price EXISTS
 * and is this. Do not restore it.
 */
export const UNAVAILABLE_LABEL = "—";

/**
 * The two labels above, in the form a money CELL prints them.
 *
 * `PRICED_AT_CHECKOUT_LABEL` is lower-case because it is also read inside a
 * sentence ("Some items are priced at checkout…"). In the money column it is a
 * cell of its own, sitting beside "At checkout" and "Confirmed at checkout",
 * and TEMPERED.md §10 is sentence case everywhere except the mono eyebrow
 * labels. So the casing is a separate constant rather than a change to the
 * shared one — nothing that reads the label mid-sentence is re-cased behind its
 * back.
 */
export const PRICED_AT_CHECKOUT_CELL = "Priced at checkout";
export const PRICE_UNAVAILABLE_CELL = "Price unavailable";

/** `undefined`/`null` pricing is degraded, not "no prices": absent is the
 *  stale-bundle case the page used to swallow. */
export function isCartPricingDegraded(pricing: CartPricingWire | null | undefined): boolean {
	return pricing === null || pricing === undefined || pricing.degraded;
}

/**
 * Has this cart FINISHED — produced an order, and stopped being a thing the
 * shopper can change?
 *
 * ── why this is NOT the domain's fence, deliberately ────────────────────────
 * `createOrderFromCart` (`packages/domain/src/orders/create-order-from-cart.ts`)
 * and `guardActiveCart` (`packages/domain/src/cart/use-cases.ts`) both ask
 * `state !== "active"` and reject. They are right to, and this is right not to
 * copy them, because they are answering a different question. They are the
 * AUTHORITY deciding whether to permit a mutation, and an authority must fail
 * closed: a state it does not recognise must never be read as permission.
 *
 * This is a RENDERER deciding which of two screens to draw, and the blast
 * radius of failing closed points the other way. `state !== "active"` here
 * would brick a LIVE cart read-only — no quantity field, no remove button, no
 * way to check out — for a shopper whose cart is perfectly fine. And it would
 * do it on a value that NOTHING validates at runtime anywhere on the wire path:
 * `CartWire.state` is typed `string`, and `HttpCommerceClient`'s `#cartResult`
 * blind-casts the response body after checking only that it carries an
 * `ok`/`reason` envelope. Whatever the service ever emits arrives here
 * unchecked.
 *
 * `CartWire.orderId` rides that same unchecked path, and it is the reason the
 * plugin normalizes ONE field and not this one: `state` fails safely under a
 * blind cast (`isCartTerminal(undefined)` is `false`, so the page draws the
 * live cart it draws for every unknown state), whereas `orderId` fails
 * UNSAFELY — `undefined !== null` is true, so `cart/index.astro` would offer
 * `/orders/undefined` as the panel's only action. Hence the coercion in
 * `HttpCommerceClient.getCart`, at the wire boundary, and none downstream.
 *
 * So this answers for the ONE state that is genuinely terminal (`checked_out`
 * is one-way — `CartState` in `packages/domain/src/ports/cart-store.ts`, and
 * nothing flips it back), and anything else renders as the live cart it almost
 * certainly is. `isKnownCartState` below is what stops that tolerance being
 * silent.
 *
 * ── what `checked_out` does NOT mean ────────────────────────────────────────
 * PAID. `createOrderFromCart` flips the cart with `cartStore.checkout()` BEFORE
 * `gateway.createIntent()` ever runs, so a buyer sitting on a pending, failed
 * or expired order has an identically `checked_out` cart. Anything rendered
 * behind this predicate may say the CART is finished; it may never say the
 * buyer is.
 */
export function isCartTerminal(state: string | undefined): boolean {
	return state === "checked_out";
}

/**
 * The states a cart in this store is ever actually in (`CartState`).
 *
 * The companion to `isCartTerminal`'s deliberate tolerance: the page renders an
 * unrecognised state as a live cart, and logs that it did. Without this, a
 * third state would arrive as a permanent, silent mis-render. The other half of
 * that worry — a `serializeCart` that quietly stopped emitting the field — is
 * now pinned at the producer instead (#136): `carts.http.contract.test.ts`
 * asserts the wire carries `state`, so a silent drop fails CI rather than
 * reaching this log.
 */
export function isKnownCartState(state: string | undefined): boolean {
	return state === "active" || state === "checked_out";
}

/**
 * The checked-out cart's copy (docs/theme/TEMPERED.md §10, sentence case).
 *
 * It is here rather than in `cart/index.astro` for the reason every decision in
 * this file is: a test can import a constant and assert what it says. The one
 * that matters is that none of these claims the buyer paid — see
 * `isCartTerminal`'s note, and the test that runs the claim-words regex over
 * `CART_TERMINAL_COPY` below.
 */
export const CART_CHECKED_OUT_TITLE = "This cart has been checked out.";
/**
 * UNCONDITIONAL, so it may only promise what BOTH cases render.
 *
 * It used to end "…If you haven't finished paying, you can return to the
 * checkout below", and that sentence was a lie in case A: the `/checkout` link
 * exists only when the cart cannot name the order, and a named cart gets a link
 * to `/orders/<id>` instead. A buyer whose cart named its order read a promise
 * and found no such control. Case B says it beside the link instead
 * (`CART_RESUME_PURPOSE`), where it is true and where it is actionable.
 */
export const CART_CHECKED_OUT_BODY =
	"Its items are on an order now, so this cart can't be changed.";
/** Said BESIDE the "Start a new cart" control, never after it: it clears an
 *  in-flight payment too, and a buyer must know that before they click. */
export const CART_NEW_CART_CONSEQUENCE = "This clears the cart and any payment still in progress.";
/** The honest version of "we lost your order link", for the cart that carries
 *  no `orderId`: one checked out before `carts.order_id` existed, or a wire
 *  that stopped emitting the field. Uncommon since #132 — the cart names its
 *  order now — but the panel must still say what it does not know rather than
 *  guess, and this is the sentence that lets it. */
export const CART_NO_ORDER_LINK =
	"This page can't name the order. The confirmation page shown at the end of checkout is the link to keep.";
/**
 * The purpose clause on "Return to this checkout" — it exists so a buyer who
 * HAS paid can self-select out of following it.
 *
 * "…to complete it" was the first wording and it is not available: "complete"
 * is the adjective in the natural claim position too ("Payment complete",
 * "Checkout complete"), so the claim-words guard has to catch it, and copy that
 * has a synonym must yield to a guard that does not.
 */
export const CART_RESUME_PURPOSE =
	"If your payment didn't go through, return to this checkout to finish it.";

/**
 * Every sentence the terminal panel can put on a screen, in one list.
 *
 * The list exists so the "never claims the buyer paid" test can be exhaustive
 * BY CONSTRUCTION rather than by someone remembering. Copy reaches the markup
 * as `{CART_X}`, so its words never appear literally in the template — a sixth
 * constant added later would slip past a scan of the markup AND past a
 * hardcoded list in the test. A source-level check pins that every exported
 * `CART_…` string in this file is a member here, so the only way to add copy is
 * to add it to the guard as well.
 */
export const CART_TERMINAL_COPY: readonly string[] = [
	CART_CHECKED_OUT_TITLE,
	CART_CHECKED_OUT_BODY,
	CART_NEW_CART_CONSEQUENCE,
	CART_NO_ORDER_LINK,
	CART_RESUME_PURPOSE,
];

export function cartMoneyCell(
	formatted: string | null | undefined,
	pricingDegraded: boolean,
): string {
	if (formatted !== null && formatted !== undefined) return formatted;
	return pricingDegraded ? UNAVAILABLE_LABEL : PRICED_AT_CHECKOUT_LABEL;
}

/**
 * The ONE path a money string takes to the cart page's screen.
 *
 * Three steps, and they only mean anything together: `cartMoneyCell` decides
 * WHICH of the three "no figure" cases this is, this function's casing map puts
 * the answer in the page's voice, and §7's `moneyCellText` is the last gate —
 * it refuses anything that does not say something, which is what turns
 * `UNAVAILABLE_LABEL`'s bare dash into real prose.
 *
 * It lives here rather than in `cart/index.astro` so a test can execute the
 * whole composition. A test that runs the pieces in a different order asserts a
 * rule the page does not follow: the earlier one dropped the casing map and
 * pinned the LOWER-case label as the cart's output, which is the opposite of
 * what renders.
 */
export function lineMoneyText(
	formatted: string | null | undefined,
	pricingDegraded: boolean,
): string {
	const cell = cartMoneyCell(formatted, pricingDegraded);
	return moneyCellText(
		cell === PRICED_AT_CHECKOUT_LABEL ? PRICED_AT_CHECKOUT_CELL : cell,
		PRICE_UNAVAILABLE_CELL,
	);
}
