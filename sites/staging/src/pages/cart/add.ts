/**
 * POST /cart/add — the add-to-cart shim (ADR-0003): validates the form,
 * ensures a cart (setting the plugin's cookie descriptor on THIS
 * response), and proxies to the plugin's public
 * `storefront/cart/lines/add`.
 *
 * The `idempotencyKey` arrives FROM THE FORM — minted per rendered PDP by
 * the plugin's add-to-cart slot — and is forwarded verbatim; this endpoint
 * never invents one (a double-submit must replay, not duplicate). A
 * missing key is a 400, mirroring the plugin route's own input guard.
 */
import {
	CART_LINE_MAX_QTY,
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_PRODUCT_ROUTE,
	type CartLineMutationRouteResult,
	type CartLineWire,
	type PdpRouteResult,
} from "@otta-sh/plugin";
import type { APIRoute } from "astro";
import { getEmDashEntry } from "emdash";
import {
	clearCartCookie,
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
import { rejectCrossOrigin } from "../../lib/origin-guard.js";
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

export const POST: APIRoute = async (context) => {
	// CSRF first: emdash disables Astro's checkOrigin; the shim enforces
	// its own origin check (origin-guard.ts, ADR-0006).
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) return forbidden;

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
	if (qty > CART_LINE_MAX_QTY) return seeOther(context, returnTo, QTY_TOO_LARGE);

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
		const { entry, error: entryError } = await getEmDashEntry("products", productId);
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
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE);
		}
		if (entry === null) {
			return seeOther(context, returnTo, PRODUCT_NOT_FOUND);
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
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE);
		}
		if (!productResult.product.purchasable || productResult.product.sku !== sku) {
			return seeOther(context, returnTo, PRODUCT_UNAVAILABLE);
		}
	}

	const addTo = async (cartId: string) =>
		dispatchOttaRoute<CartLineMutationRouteResult<{ line: CartLineWire }>>(
			handler,
			STOREFRONT_CART_LINE_ADD_ROUTE,
			{ cartId, sku, qty, idempotencyKey, ...(productId !== undefined ? { productId } : {}) },
			context.url,
		);

	const cart = await ensureCartId(context, handler);
	if (!cart.ok) {
		// A busy `cart/create` (key-less, so never auto-retried) is the busy 503;
		// any other failure is the ordinary SERVICE_UNAVAILABLE turn.
		if (cart.reason === "busy") return busyResponse(returnTo);
		return seeOther(context, returnTo, SERVICE_UNAVAILABLE);
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
			return seeOther(context, returnTo, SERVICE_UNAVAILABLE);
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
		if (token === "CART_NOT_FOUND") clearCartCookie(context);
		return seeOther(context, returnTo, token);
	}

	return seeOther(context, "/cart");
};
