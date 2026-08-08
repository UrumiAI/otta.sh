import {
	addLine,
	type Cart,
	type CartDeps,
	type CartFailure,
	type CartLine,
	type CartStore,
	type Clock,
	createCart,
	currency,
	expireHolds,
	type FulfillmentKind,
	getCart,
	type InventoryStore,
	idempotencyKey,
	productId as toProductId,
	type ProductCommerceStore,
	type ProductId,
	removeLine,
	sku,
	updateLine,
} from "@otta-sh/domain";
import { type Context, Hono } from "hono";
import { tokenMatches } from "../auth.js";
import {
	addLineBody,
	createCartBody,
	linePathParams,
	patchLineBody,
	pathParams,
} from "../schemas.js";

export interface CartRoutesDeps {
	store: InventoryStore;
	cartStore: CartStore;
	/** Resolves a line's fulfillment kind server-side (Phase 4 §6) — a digital
	 *  product reserves nothing — and, since the add endpoint's SKU guard, the
	 *  catalog the guard resolves a submitted sku against. Optional ONLY so
	 *  `expireHoldsRoutes` can share the type: `cartRoutes` narrows it back to
	 *  REQUIRED in its own signature, so the guard cannot be silently disabled by
	 *  a call site that forgets to wire the store. */
	productCommerce?: ProductCommerceStore;
	clock: Clock;
	/** Hold TTL in ms; defaults to the domain's DEFAULT_HOLD_TTL_MS. */
	ttlMs?: number;
	/**
	 * Shared secret for the internal endpoints (`X-Internal-Token` header). When
	 * unset, `/internal/*` is DISABLED (503) rather than open — the minimal
	 * auth'd-internal stance §6 requires; a fuller authn story is deferred.
	 */
	internalToken?: string;
}

const DEFAULT_CURRENCY = "USD";

/**
 * Cart routes — each a straight serialization of a cart use-case: validate →
 * use-case → serialize. No status-code-as-logic for stock: `OUT_OF_STOCK` is a
 * 200 typed body (mirroring `reserve`). Not-found is 404; a checked-out fence is
 * 409. The `Idempotency-Key` header threads into the domain command.
 */
export function cartRoutes(deps: CartRoutesDeps & { productCommerce: ProductCommerceStore }): Hono {
	const app = new Hono();
	const cartDeps: CartDeps = {
		cartStore: deps.cartStore,
		inventoryStore: deps.store,
		clock: deps.clock,
		ttlMs: deps.ttlMs,
	};

	app.post("/", async (c) => {
		const parsed = createCartBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const cartId = await createCart(cartDeps, currency(parsed.data.currency ?? DEFAULT_CURRENCY));
		return c.json({ cartId }, 201);
	});

	app.get("/:cartId", async (c) => {
		const params = pathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const cart = await getCart(cartDeps, params.data.cartId);
		if (cart === null) return c.json({ ok: false, reason: "CART_NOT_FOUND" }, 404);
		return c.json({ ok: true, cart: serializeCart(cart) }, 200);
	});

	app.post("/:cartId/lines", async (c) => {
		const key = requireKey(c);
		if (key === null) return c.json({ error: "missing Idempotency-Key header" }, 400);
		const params = pathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = addLineBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		// SECURITY — the add endpoint's SKU guard. `sku` and `productId` arrive as
		// two INDEPENDENT client inputs (both editable on the storefront /cart/add
		// POST). Checkout takes price/title/currency AND grants the digital
		// entitlement from the productId's row, but stamps the order line's `sku`
		// from the cart line (the client value). If the two may disagree, a caller
		// pairs product A's productId (cheap / its entitlement) with product B's
		// sku (pricey / a different good) and is charged A's price while reserving
		// B's stock.
		//
		// Issue #80 closed the half of that where a product_commerce row existed
		// and its sku differed. Two halves stayed open, and both become REACHABLE
		// the moment a product hands out more than one sku, which is what variants
		// are: a productId with NO row was waved through as "harmless", and a
		// product whose skus live on its VARIANTS could never match at all. So the
		// rule is now stated positively rather than as a list of rejections —
		// every add must RESOLVE its sku to a live sellable unit OF THE NAMED
		// PRODUCT (see `resolveSellableUnit`), and anything that does not resolve
		// is rejected rather than reinterpreted.
		//
		// A BARE ADD (no productId) IS LEFT EXACTLY AS IT WAS, and that is a
		// decision, not an oversight. Resolving a bare sku means asking "which
		// live sellable unit, across the whole catalog, holds this sku" — and
		// `ProductCommerceStore` has no such lookup: every read on it is keyed by
		// productId. A bare line is also unorderable by construction (both
		// checkout paths reject a null productId with PRODUCT_NOT_PRICED before
		// they price anything), so it can confer neither price nor entitlement and
		// the spoof this guard exists to stop is not expressible through it. What
		// a bare add CAN still do is reserve stock — which every legitimate add
		// does too, so it is a rate-limiting concern and not this one. Closing it
		// honestly needs a by-sku resolver on the port; the guard cannot invent
		// one, and guessing with the admin list's case-insensitive search would
		// resolve "sku-a" onto "SKU-A" and see no variants at all.
		//
		// NOT AN N+1, and not on the reserve path: the resolution is at most two
		// keyed reads per REQUEST (never per line — an add carries exactly one),
		// the product read alone answers the storefront's hot path, and nothing
		// here reserves, seeds or otherwise touches inventory. It runs BEFORE
		// `addLine`, so a rejected add writes nothing and a replay of it is
		// rejected identically rather than half-applied.
		let productId: string | null = null;
		let kind: FulfillmentKind = "physical";
		if (parsed.data.productId !== undefined) {
			productId = parsed.data.productId;
			const resolved = await resolveSellableUnit(
				deps.productCommerce,
				toProductId(parsed.data.productId),
				parsed.data.sku,
			);
			if (resolved.status === "unknown") {
				return c.json({ ok: false, reason: "SKU_MISMATCH" }, 409);
			}
			if (resolved.status === "unpriced") {
				// Live, correctly named, and nobody has priced it — a variant whose
				// price a resurrect cleared is exactly this state. Refused HERE and by
				// name, because the alternative is a line that looks purchasable and
				// then gets charged whatever the row above it happens to hold.
				return c.json({ ok: false, reason: "PRODUCT_NOT_PRICED" }, 409);
			}
			kind = resolved.productKind;
		}
		const res = await addLine(
			cartDeps,
			params.data.cartId,
			sku(parsed.data.sku),
			productId,
			parsed.data.qty,
			idempotencyKey(key),
			kind,
		);
		if (res.ok) return c.json({ ok: true, line: serializeLine(res.line) }, 200);
		return failure(c, res.reason);
	});

	app.patch("/:cartId/lines/:lineId", async (c) => {
		const key = requireKey(c);
		if (key === null) return c.json({ error: "missing Idempotency-Key header" }, 400);
		const params = linePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = patchLineBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const res = await updateLine(
			cartDeps,
			params.data.cartId,
			params.data.lineId,
			parsed.data.qty,
			idempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true, line: serializeLine(res.line) }, 200);
		return failure(c, res.reason);
	});

	app.delete("/:cartId/lines/:lineId", async (c) => {
		const key = requireKey(c);
		if (key === null) return c.json({ error: "missing Idempotency-Key header" }, 400);
		const params = linePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await removeLine(
			cartDeps,
			params.data.cartId,
			params.data.lineId,
			idempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true }, 200);
		return failure(c, res.reason);
	});

	return app;
}

/**
 * Internal (non-public) sweep endpoint: reclaim globally-expired holds (§6).
 * Guarded by a shared-secret `X-Internal-Token` header: 503 when no token is
 * configured (endpoint disabled, never silently open), 401 on a mismatch.
 */
export function expireHoldsRoutes(deps: CartRoutesDeps): Hono {
	const app = new Hono();
	const cartDeps: CartDeps = {
		cartStore: deps.cartStore,
		inventoryStore: deps.store,
		clock: deps.clock,
		ttlMs: deps.ttlMs,
	};
	app.post("/expire-holds", async (c) => {
		const token = deps.internalToken;
		if (token === undefined || token.length === 0) {
			return c.json({ ok: false, error: "internal endpoints disabled" }, 503);
		}
		if (!tokenMatches(c.req.header("X-Internal-Token"), token)) {
			return c.json({ ok: false, error: "unauthorized" }, 401);
		}
		const reclaimed = await expireHolds(cartDeps);
		return c.json({ ok: true, reclaimed }, 200);
	});
	return app;
}

function serializeCart(cart: Cart): {
	cartId: string;
	state: string;
	/** The order this cart handed off to (issue #132), or null while it is
	 *  `active`. Not a payment signal, and a null does NOT prove no order exists
	 *  for the cart — see `CartStore.checkout`. */
	orderId: string | null;
	currency: string;
	lines: ReturnType<typeof serializeLine>[];
} {
	return {
		cartId: cart.cartId,
		state: cart.state,
		orderId: cart.orderId,
		currency: cart.currency,
		lines: cart.lines.map(serializeLine),
	};
}

/** Wire shape of a cart line — no price (Phase 3), no internal reservation state. */
function serializeLine(line: CartLine): {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
} {
	return {
		lineId: line.lineId,
		sku: line.sku,
		productId: line.productId,
		qty: line.qty,
		reservationId: line.reservationId,
		expiresAt: line.expiresAt,
	};
}

/**
 * Resolve a submitted sku to ONE live sellable unit of ONE named product — the
 * whole of the add endpoint's SKU guard.
 *
 * "Live sellable unit" is the port's own phrase and the port's own definition,
 * spanning both tables: a `product_commerce` row that is not soft-deleted, and a
 * `product_variants` row that is not orphaned. That is deliberately the SAME
 * predicate the live-sku uniqueness indexes use (`WHERE deleted_at IS NULL` /
 * `WHERE orphaned_at IS NULL`), which is what makes "one sku names one unit"
 * true here rather than merely likely — and it is NOT the publish gate: `active`
 * decides whether a storefront lists a product, not whether the sku on a request
 * names a real thing, and the two must not be conflated in a security check.
 *
 * A DEAD unit therefore fails to resolve, by construction and without a special
 * case: a soft-deleted product, and an orphaned variant that still holds its sku,
 * its price and its stock, both simply are not live and neither is reachable.
 *
 * PRICED IS PART OF SELLABLE. A unit nobody has priced cannot be sold, and a
 * unit priced at a row that is not its own is worse than unsold — so the guard
 * refuses the unpriced case here rather than letting it travel to a checkout
 * that would resolve the price from somewhere else.
 *
 * COST: one keyed read when the product's own sku matches — the storefront's
 * hot path, and byte-for-byte the read this route already did — and a second
 * only when it does not, which is the variant case. Both are per REQUEST, and an
 * add carries exactly one line; there is no per-line loop here and there must
 * never be one.
 */
async function resolveSellableUnit(
	store: ProductCommerceStore,
	productId: ProductId,
	submittedSku: string,
): Promise<
	{ status: "ok"; productKind: FulfillmentKind } | { status: "unknown" } | { status: "unpriced" }
> {
	const product = await store.getByProductId(productId);
	if (product === null || product.deletedAt !== null) return { status: "unknown" };
	if (product.sku !== null && String(product.sku) === submittedSku) {
		return product.price === null
			? { status: "unpriced" }
			: { status: "ok", productKind: product.productKind };
	}
	// The product's own sku is not the one submitted — so either this product
	// sells through variants, or the sku belongs to somebody else entirely.
	const variant = (await store.listVariants(productId)).find(
		(row) => row.orphanedAt === null && row.sku !== null && String(row.sku) === submittedSku,
	);
	if (variant === undefined) return { status: "unknown" };
	if (variant.price === null) return { status: "unpriced" };
	// Fulfillment kind is a PRODUCT-level fact (there is no per-variant kind on
	// the port), so a size inherits its product's: digital sizes of a digital
	// product reserve nothing, exactly as the product itself would.
	return { status: "ok", productKind: product.productKind };
}

function failure(c: Context, reason: CartFailure): Response {
	const body = { ok: false as const, reason };
	switch (reason) {
		case "OUT_OF_STOCK":
			return c.json(body, 200); // typed body, not status-code-as-logic
		case "CART_NOT_FOUND":
		case "LINE_NOT_FOUND":
			return c.json(body, 404);
		case "CART_CHECKED_OUT":
		case "LINE_CHECKED_OUT":
		case "HOLD_EXPIRED":
			// HOLD_EXPIRED: a late add replay whose hold the sweep already reaped —
			// the line was not resurrected; the client adds again with a fresh key.
			return c.json(body, 409);
	}
}

function requireKey(c: { req: { header(name: string): string | undefined } }): string | null {
	const key = c.req.header("Idempotency-Key");
	return key === undefined || key.length === 0 ? null : key;
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
