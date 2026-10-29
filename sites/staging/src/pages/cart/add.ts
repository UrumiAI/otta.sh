/**
 * POST /cart/add — the add-to-cart shim (ADR-0003): validates the form,
 * ensures a cart (setting the plugin's cookie descriptor on THIS
 * response), and proxies to the plugin's public
 * `storefront/cart/lines/add`.
 *
 * The `idempotencyKey` arrives FROM THE FORM — minted per SUBMISSION by the
 * PDP's script (ADR-0039), or with no script the one the plugin's add-to-cart
 * slot rendered into the page — and is forwarded verbatim; this endpoint never
 * invents one (a double-submit must replay, not duplicate). A missing key is a
 * 400, mirroring the plugin route's own input guard.
 *
 * With no cart yet, the key also keys the CREATE (issue #39), so a double-submitted
 * first add lands in one cart instead of minting an orphan per request — but only
 * when the key is this visitor's alone. A create key answers its cart to whoever
 * sends it, and the key the page RENDERED (the no-script fallback) may have been
 * served to every visitor from a shared cache, so the form posts it again as
 * `renderedKey` and the create is keyed only when the two differ: the page's script
 * minted this one for this submission. Equal, or no `renderedKey` at all, the
 * create is unkeyed, as before.
 *
 * The plugin applies the same rule itself (a rendered key carries the `pdp:` mark
 * and never keys a create), so this check is the second of two. It is not
 * redundant: a page rendered — and cached — before the mark existed carries an
 * UNMARKED rendered key, which only the missing `renderedKey` field gives away.
 */
import {
	CART_LINE_MAX_QTY,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	type CartLineMutationRouteResult,
	type CartLineWire,
	type PdpRouteResult,
} from "@urumi.ai/otta-plugin";
import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";
import {
	clearCartCookieIfBad,
	ensureCartId,
	failureToken,
	PRODUCT_NOT_FOUND,
	PRODUCT_UNAVAILABLE,
	QTY_TOO_LARGE,
	routeDispatcher,
	seeOther,
	SERVICE_UNAVAILABLE,
} from "../../lib/cart-actions.js";
import { forgetCheckedOutCart } from "../../lib/cart-rotation.js";
import { toCmsProductContent, type ProductEntryData } from "../../lib/products.js";
import {
	busyResponse,
	dispatchOttaRoute,
	formPositiveInt,
	formString,
	isBusyResult,
	notAFormResponse,
	readFormBody,
	safeReturnPath,
} from "../../lib/otta-api.js";
import { PRODUCT_ERROR_ID } from "../../lib/error-notice.js";

export const POST: APIRoute = async (context) => {
	// CSRF: src/middleware.ts has already refused a cross-site POST (ADR-0006).
	const form = await readFormBody(context.request);
	if (form === null) return notAFormResponse();
	const sku = formString(form.get("sku"));
	// The CMS content id (join key to product_commerce) minted into the PDP
	// add-to-cart slot — forwarded so the cart line is priceable/quotable/
	// orderable (issue #80). `formString` normalizes a blank/absent value to
	// `undefined`, so it is OMITTED here rather than forwarded as "" (the plugin
	// route strictly rejects a present-but-blank productId with INVALID_INPUT;
	// this shim never produces that shape). NOTE the divergence: a blank hidden
	// input would degrade to a bare add (null productId) that a legit storefront
	// never emits — it is not a security hole (an unpriced line is caught at
	// checkout with PRODUCT_NOT_PRICED, never mispriced) but WOULD silently
	// re-break #80's orderability, so the PDP slot must always render a non-blank
	// productId (it does — `content.id` is always present).
	const productId = formString(form.get("productId"));
	const idempotencyKey = formString(form.get("idempotencyKey"));
	const renderedKey = formString(form.get("renderedKey"));
	const returnTo = safeReturnPath(form.get("returnTo"), "/products");

	// Absent/blank qty defaults to 1; a PRESENT-but-invalid qty ("abc",
	// "-3", "2.5") is a 400, matching /cart/update — never silently 1.
	const rawQty = form.get("qty");
	const qty = formString(rawQty) === undefined ? 1 : formPositiveInt(rawQty);

	if (sku === undefined || idempotencyKey === undefined || qty === undefined) {
		return new Response(
			"Bad request: sku and idempotencyKey are required; qty must be a positive integer",
			{ status: 400 },
		);
	}

	// Over the cap: the plugin refuses it as QTY_TOO_LARGE anyway, so answer that
	// here, before `ensureCartId` can mint a cart for an add that cannot succeed
	// (QA U-6). The copy names the limit.
	if (qty > CART_LINE_MAX_QTY) return seeOther(context, returnTo, QTY_TOO_LARGE, PRODUCT_ERROR_ID);

	const handler = routeDispatcher(context);

	// Bogus SKU / garbage productId pre-check (item 3, fail fast — BEFORE
	// `ensureCartId` mints a cart for a request that will be rejected).
	//
	// The service's own guard is now the stronger one and no longer needs
	// covering for: an add that names a productId must RESOLVE its sku to a
	// live, priced sellable unit of that product, so a garbage/nonexistent
	// productId is refused SKU_MISMATCH at the add rather than let through to
	// checkout's PRODUCT_NOT_PRICED (`routes/carts.ts`, `resolveSellableUnit`).
	//
	// This check stays anyway, for the two things the service's cannot do from
	// where it stands. It runs BEFORE a cart is minted, so a request that was
	// never going to succeed does not leave an empty cart and a cookie behind;
	// and it checks the CMS, which the service has no access to — a productId
	// can be perfectly valid commerce-side while naming content this site
	// cannot render, and the theme already owns that lookup via
	// `getEmDashEntry` (the same slug-or-id lookup `[slug].astro` uses).
	if (productId !== undefined) {
		// The read reports a query failure in `error`, but a missing binding — or
		// emdash's byline/term hydration after the main query — throws outright.
		// That arm is the same outage, so it gets the same turn, not a 500.
		let read: Awaited<ReturnType<typeof getEmDashEntry>>;
		try {
			read = await getEmDashEntry("products", productId);
		} catch (cause) {
			console.error("[site-staging] add-to-cart content lookup threw:", cause);
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE, PRODUCT_ERROR_ID);
		}
		const { entry, error: entryError } = read;
		// Reproduced live against a real dev instance (real astro:content live
		// loader — our unit tests mock this dependency and originally missed
		// this): a genuinely nonexistent-but-well-formed id does NOT come back
		// as a clean `{entry: null}` with no error, despite `EntryResult.error`'s
		// own JSDoc ("not set for not found, only for actual errors") — astro's
		// `getLiveEntry` (content/runtime.js) wraps the loader's "no row"
		// `undefined` return into `{error: new LiveEntryNotFoundError(collection,
		// lookup)}`, and `getEmDashEntry`'s `resolveNormal` passes that straight
		// through unfiltered. Observed shape (dev console, a nonexistent
		// well-formed id): `entry === null`; `error instanceof Error === true`;
		// `error.name === "LiveEntryNotFoundError"` (also
		// `error.constructor.name`); message `Entry _emdash → {...} was not
		// found.` A GENUINE transient/DB failure surfaces as a plain `Error`
		// instead (`resolveNormal`'s catch / `loadEntry`'s catch both do
		// `new Error(...)`, default `.name === "Error"`) — so `.name` is the
		// reliable not-found-vs-transient discriminant, checked BEFORE the
		// generic `entryError` branch below (which still catches every other
		// error shape, including a bare `{entry: null}` with no error at all —
		// the documented-but-presently-inaccurate-for-this-case contract —
		// which also falls through to the `entry === null` → PRODUCT_NOT_FOUND
		// check that follows).
		const isNotFoundError =
			entryError instanceof Error && entryError.name === "LiveEntryNotFoundError";
		if (entryError !== undefined && !isNotFoundError) {
			// A transient/DB issue is never mislabeled as "doesn't exist".
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE, PRODUCT_ERROR_ID);
		}
		if (entry === null) {
			return seeOther(context, returnTo, PRODUCT_NOT_FOUND, PRODUCT_ERROR_ID);
		}

		// Entry exists — dispatch the SAME PDP route call `[slug].astro` makes
		// to get a live, authoritative ProductViewModel (purchasable + sku),
		// and reject BEFORE ever calling the add-line route if the submitted
		// sku was forged onto a mismatched/inactive product.
		const content = toCmsProductContent(entry.data as unknown as ProductEntryData);
		const productResult = await dispatchOttaRoute<PdpRouteResult>(
			handler,
			STOREFRONT_PRODUCT_ROUTE,
			{ content },
			context.url,
		);
		// The pre-check READ was busy (already retried once): the shopper's add is
		// fine, the store is momentarily busy — say so, not SERVICE_UNAVAILABLE.
		if (isBusyResult(productResult)) return busyResponse(returnTo);
		if (productResult === null || !productResult.ok) {
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE, PRODUCT_ERROR_ID);
		}
		if (!productResult.product.purchasable || productResult.product.sku !== sku) {
			return seeOther(context, returnTo, PRODUCT_UNAVAILABLE, PRODUCT_ERROR_ID);
		}
	}

	const addTo = async (cartId: string) =>
		dispatchOttaRoute<CartLineMutationRouteResult<{ line: CartLineWire }>>(
			handler,
			STOREFRONT_CART_LINE_ADD_ROUTE,
			{ cartId, sku, qty, idempotencyKey, ...(productId !== undefined ? { productId } : {}) },
			context.url,
		);

	const cart = await ensureCartId(
		context,
		handler,
		renderedKey !== undefined && renderedKey !== idempotencyKey ? { idempotencyKey } : {},
	);
	if (!cart.ok) {
		// A busy `cart/create` (still busy after a keyed create's one retry) is the
		// busy 503; any other failure is the ordinary SERVICE_UNAVAILABLE turn.
		if (cart.reason === "busy") return busyResponse(returnTo);
		return seeOther(context, returnTo, SERVICE_UNAVAILABLE, PRODUCT_ERROR_ID);
	}

	let result = await addTo(cart.cartId);

	// The cookie still names a cart that became an order. When that order can no
	// longer be paid (paid, expired, failed…) the cart is SPENT: forget it, start a
	// new one and add there. A PENDING order's cart is kept — its payment may still
	// happen, and /checkout resumes it from this cookie — so that add still answers
	// CART_CHECKED_OUT, and the product page's notice links to the cart, which
	// offers the way out (cart-rotation.ts).
	//
	// The new cart is the spent cart's REPLACEMENT: the plugin keys it on the spent
	// cart (`rotate:<cartId>`, derived server-side), so a duplicate request racing this
	// one lands in the same new cart. The retry reuses the form's own key: an add
	// refused CART_CHECKED_OUT records no mutation (pinned by cartStoreContract), so
	// this is the key's first application and a racing duplicate replays into the
	// same line instead of adding twice. If the replacement itself is refused (the
	// cart changed under us), the shopper gets the ordinary unavailable turn; the
	// spent cookie is already gone, so their next add starts a fresh cart.
	if (
		result !== null &&
		!isBusyResult(result) &&
		!result.ok &&
		failureToken(result) === "CART_CHECKED_OUT" &&
		(await forgetCheckedOutCart(
			{ cookies: context.cookies, handler, url: context.url },
			cart.cartId,
		))
	) {
		const fresh = await ensureCartId(context, handler, { replacesCartId: cart.cartId });
		if (!fresh.ok) {
			if (fresh.reason === "busy") return busyResponse(returnTo);
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE, PRODUCT_ERROR_ID);
		}
		result = await addTo(fresh.cartId);
	}

	// Still busy after dispatch's one retry (same idempotency key): 503, not a
	// generic "went wrong" — a reload re-posts the same key, which is replay-safe.
	if (isBusyResult(result)) return busyResponse(returnTo);
	if (result === null || !result.ok) {
		const token = failureToken(result);
		// A stale cookie pointing at a vanished cart: drop it so the next
		// add mints a fresh cart instead of failing forever.
		clearCartCookieIfBad(context, token);
		// One unit refused is a sold-out item: "try a smaller quantity" would send
		// the shopper looking for a quantity below 1 (QA2 F). More than one keeps
		// the quantity sentence, which is true either way.
		return seeOther(
			context,
			returnTo,
			token === "OUT_OF_STOCK" && qty === 1 ? "SOLD_OUT" : token,
			PRODUCT_ERROR_ID,
		);
	}

	return seeOther(context, "/cart");
};
