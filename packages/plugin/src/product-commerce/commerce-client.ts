/**
 * The `CommerceClient` transport port (ADR-0002 §3 / plan §5): storefront
 * routes and the widget's save route depend on this INTERFACE, never on
 * `fetch` directly. `HttpCommerceClient` (http-commerce-client.ts) is the
 * only adapter this phase builds — `InProcessCommerceClient` is deferred
 * (ADR-0002 §6: no premature abstraction beyond a second real adapter).
 *
 * Wire types mirror `@urumi/service`'s `PUT/GET/DELETE /products/:id/commerce`
 * 1:1 (money as an integer + ISO-4217 string, never a float).
 */

export interface CommerceMoney {
	amount: number;
	currency: string;
}

export type CommerceProductKind = "physical" | "digital";

/** Every commercial field is optional — "create then price" (plan §1 case
 *  3): a bare content sync carries only the product_id. */
export interface UpsertProductCommerceInput {
	sku?: string;
	price?: CommerceMoney;
	/** The product title an ORDER LINE SNAPSHOTS at purchase time (service
	 *  schema: non-empty, ≤500 chars). Not a merchant-editable commerce field:
	 *  it is derived from the CMS CONTENT field `data.title` — em-dash's
	 *  `ContentItem` has NO top-level `title`; see `sync/hooks.ts`'s
	 *  `TITLE_FIELD` for the evidence — so the storefront heading and the order
	 *  line can never drift. A row whose title is NULL is UNPURCHASABLE
	 *  (`createOrderFromCart` rejects it with `PRODUCT_NOT_PRICED`). OMITTED —
	 *  never sent as `""` — when the content has no usable title, which the store
	 *  reads as "preserve whatever is already stored". */
	title?: string;
	taxClass?: string | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: CommerceProductKind;
	/** Initial stock — a create-if-absent seed attempted on any save that
	 *  carries it (self-healing after a partial failure, review B1); never a
	 *  restock path (plan §8 Risk 4). */
	initialOnHand?: number;
	/** Sync-ordering watermark (review S1): the CMS content's `updatedAt`,
	 *  sent by `content:afterSave` syncs so the service rejects a
	 *  delayed/out-of-order OLDER save as a stale no-op. Panel saves omit it
	 *  (explicit merchant intent = last-writer-wins, documented). */
	contentUpdatedAt?: string;
}

export interface ProductCommerce {
	productId: string;
	sku: string | null;
	price: CommerceMoney | null;
	taxClass: string | null;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: CommerceProductKind;
	active: boolean;
	deletedAt: string | null;
	contentUpdatedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

// ── Phase 2: catalog batch read (plan §6) ────────────────────────────────
// Wire item for `POST /catalog/commerce/batch` — mirrors the service's
// ProductCommerceView DTO 1:1. Only ids that exist come back; missing ids
// are OMITTED, never per-id errors. `inStock` is the service's own
// single intra-DB join (§6 invariant — the plugin never makes a second
// inventory round trip). Branding (Cents/Currency) happens one layer up,
// at `catalog/commerce-view.ts`'s parse boundary.
export interface ProductCommerceBatchItem {
	productId: string;
	sku: string;
	price: CommerceMoney;
	inStock: boolean;
	/** The publish gate: the join derives purchasability from it
	 *  (`purchasable ⟺ present && active`). */
	active: boolean;
}
// ── end Phase 2 catalog batch read ───────────────────────────────────────

export interface CommerceClient {
	upsertProductCommerce(
		productId: string,
		input: UpsertProductCommerceInput,
		idempotencyKey: string,
	): Promise<ProductCommerce>;
	getProductCommerce(productId: string): Promise<ProductCommerce | null>;
	softDeleteProductCommerce(productId: string, idempotencyKey: string): Promise<void>;
	/** The afterPublish→activate follow-up (plan §6 step 7): mirrors
	 *  `POST /products/:id/commerce/activate` 1:1. Deliberately separate from
	 *  `upsertProductCommerce` — see the service route's doc for why `active`
	 *  is not an upsert field. `contentUpdatedAt` is the CMS content's
	 *  `updatedAt` at publish time — the ordering watermark the store gates on
	 *  so a stale, out-of-order publish is a no-op (convergence). */
	activateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;
	/** The afterUnpublish→deactivate follow-up (plan §6 step 7): the mirror of
	 *  `activateProductCommerce`, mirrors `POST /products/:id/commerce/deactivate`
	 *  1:1 — closes the publish gate so an unpublished product stops being
	 *  purchasable. `contentUpdatedAt` is the same ordering watermark. */
	deactivateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;

	// ── Phase 2: catalog batch read (plan §6) ─────────────────────────────
	// (A later Phase-3 task adds its cart methods below this block — keep
	// the delimiters so the diff surfaces stay additive.)
	getCommerceBatch(productIds: string[]): Promise<ProductCommerceBatchItem[]>;
	// ── end Phase 2 catalog batch read ────────────────────────────────────

	// ── Phase 3 group E: cart (plan §6, wire mirrors @urumi/service's ─────
	// `/carts` routes 1:1, hand-rolled like the wire types above — the
	// plugin declares no runtime dependency on @urumi/domain/service). ────
	createCart(currency?: string): Promise<{ cartId: string }>;
	getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>>;
	addCartLine(
		cartId: string,
		sku: string,
		/** The CMS content id (the join key to `product_commerce`) so the line can
		 *  be priced/quoted/ordered — issue #80. `null` for a bare (legacy) add that
		 *  has no product reference; the wire OMITS the field when null. */
		productId: string | null,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>>;
	adjustCartLine(
		cartId: string,
		lineId: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>>;
	removeCartLine(
		cartId: string,
		lineId: string,
		idempotencyKey: string,
	): Promise<CartResult<Record<string, never>>>;
	// ── end Phase 3 group E: cart ─────────────────────────────────────────

	// ── Phase 5: storefront customer account (plan §7, wire mirrors ───────
	// @urumi/service's /auth + /me routes 1:1; the bearer session token is
	// passed through from the plugin's first-party cookie layer, never held
	// by the sandboxed plugin itself). ────────────────────────────────────
	requestLoginLink(email: string): Promise<{ ok: true }>;
	verifyLogin(challengeId: string, token: string): Promise<LoginVerifyResult>;
	logout(sessionToken: string): Promise<void>;
	listMyOrders(sessionToken: string): Promise<AuthedResult<{ orders: OrderSummaryWire[] }>>;
	getMyOrder(
		sessionToken: string,
		orderId: string,
	): Promise<
		{ ok: true; order: OrderSummaryWire } | { ok: false; reason: "UNAUTHENTICATED" | "NOT_FOUND" }
	>;
	listMyAddresses(sessionToken: string): Promise<AuthedResult<{ addresses: AddressWire[] }>>;
	// ── end Phase 5 customer account ──────────────────────────────────────

	// ── Phase 4: checkout (quote → order → public order read) ─────────────
	// Wire mirrors @urumi/service's routes/orders.ts 1:1. Every typed failure
	// rides the same `{ ok: false, reason }` envelope regardless of status
	// (adapter rule #2 — 400/404/409/502 all carry one), so callers branch on
	// the token and never on an HTTP code.
	quoteCheckout(input: QuoteRequestWire): Promise<QuoteResult>;
	/** The `idempotencyKey` is the CALLER's — forwarded verbatim as
	 *  `Idempotency-Key`, never invented here (see `checkoutIdempotencyKey`:
	 *  it must be stable per cart, or a reload mints a second order). */
	createOrder(input: CheckoutRequestWire, idempotencyKey: string): Promise<CheckoutResult>;
	/** The unauthenticated capability read (ADR-0010 §2). Sends NO
	 *  `X-Internal-Token`: that header unlocks the full admin projection
	 *  (`serializeOrder`, incl. `buyerRef`/`shippingAddress`) on a page a guest
	 *  reads. The guest gets `serializePublicOrder`'s whitelist. */
	getPublicOrder(orderId: string): Promise<PublicOrderResult>;
	// ── end Phase 4 checkout ──────────────────────────────────────────────
}

// ── Phase 4: checkout wire types ───────────────────────────────────────────
// Mirror @urumi/service's `quoteBody`/`checkoutBody` (schemas.ts) and its
// quote/checkout/public-order serializations 1:1. Money is integer minor units
// + an ISO-4217 string, never a float.

export interface QuoteRequestWire {
	cartId: string;
	shippingZoneId?: string;
	shippingMethodId?: string;
	couponCode?: string;
}

export interface QuoteBreakdownWire {
	currency: string;
	subtotalCents: number;
	discountCents: number;
	shippingCents: number;
	taxCents: number;
	totalCents: number;
	appliedCouponCode: string | null;
}

/** `@urumi/service`'s quote rejections: the cart pre-checks it runs before
 *  `computeQuote` (`orders.ts`) plus `QuoteFailure`'s own union. */
export type QuoteFailureReason =
	| "CART_NOT_FOUND"
	| "CART_EMPTY"
	| "PRODUCT_NOT_PRICED"
	| "CURRENCY_MISMATCH"
	| "COUPON_NOT_FOUND"
	| "SHIPPING_METHOD_NOT_FOUND"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_CURRENCY_MISMATCH";

export type QuoteResult =
	| { ok: true; breakdown: QuoteBreakdownWire }
	| { ok: false; reason: QuoteFailureReason };

/** ADR-0009's optional ship-to snapshot — bounds mirror `shippingAddressBody`. */
export interface ShippingAddressWire {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	region?: string;
	postalCode: string;
	country: string;
	email?: string;
	phone?: string;
}

export interface CheckoutRequestWire {
	cartId: string;
	paymentMethod: "stripe" | "x402";
	/** Email/session claim token (ADR-0004). Stored VERBATIM by the service —
	 *  the site trims but never lowercases it. */
	buyerRef: string;
	shippingZoneId?: string;
	shippingMethodId?: string;
	couponCode?: string;
	shippingAddress?: ShippingAddressWire;
}

/** The domain's `ClientAction` verbatim — passed through unmodified; the
 *  plugin never inspects a client secret beyond handing it to the theme. */
export type ClientActionWire =
	| { kind: "stripe_client_secret"; clientSecret: string }
	| { kind: "x402_challenge"; accepts: string[]; price: number; payTo: string }
	| { kind: "none" };

export interface PaymentIntentWire {
	gateway: string;
	intentId: string;
	clientAction: ClientActionWire;
}

/** `serializePublicOrder`'s whitelist (`orders.ts`) — deliberately WITHOUT
 *  `buyerRef`/`customerId`/`shippingAddress`/reconciliation fields, which the
 *  service omits entirely (never as null) so a client cannot probe the shape. */
export interface PublicOrderWire {
	id: string;
	state: string;
	currency: string;
	paymentMethod: string | null;
	holdExpiresAt: string;
	createdAt: string;
	totals: QuoteBreakdownWire & { shippingZoneId: string | null };
	lines: OrderLineWire[];
	fulfillment: {
		carrier: string;
		trackingNumber: string;
		trackingUrl: string | null;
		shippedAt: string;
	} | null;
	cancellation: { reason: string; cancelledAt: string } | null;
}

/** `CreateOrderFailure` verbatim (`@urumi/domain`'s orders/errors.ts). */
export type CheckoutFailureReason =
	| "CART_NOT_FOUND"
	| "CART_EMPTY"
	| "CART_CHECKED_OUT"
	| "RESERVATION_LOST"
	| "PRODUCT_NOT_PRICED"
	| "CURRENCY_MISMATCH"
	| "INVALID_SHIPPING_ADDRESS"
	| "PAYMENT_INTENT_FAILED"
	| "SHIPPING_METHOD_NOT_FOUND"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_FOUND"
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_MAX_PER_CUSTOMER"
	| "COUPON_CURRENCY_MISMATCH";

/**
 * NOTE the asymmetry, deliberate and load-bearing: `POST /checkout/orders`
 * answers with the FULL `serializeOrder` projection (it is a machine-to-machine
 * write behind the service token), which is a SUPERSET of `PublicOrderWire` —
 * it also carries `buyerRef`, `customerId` and the ship-to snapshot. Typing it
 * as the public shape is what keeps those fields un-referenceable here: the
 * checkout route projects only `id`/`state` out of this reply and NEVER
 * forwards the body, so nothing private can reach a storefront page by
 * accident. The guest-facing read (`getPublicOrder`) genuinely receives only
 * the whitelist.
 */
export type CheckoutResult =
	| { ok: true; order: PublicOrderWire; intent: PaymentIntentWire }
	| { ok: false; reason: CheckoutFailureReason };

export type PublicOrderResult =
	| { ok: true; order: PublicOrderWire }
	| { ok: false; reason: "ORDER_NOT_FOUND" };
// ── end Phase 4 checkout wire types ────────────────────────────────────────

// ── Phase 5: customer account wire types (plan §7) ─────────────────────────
// Mirror @urumi/service's serializeOrder / serializeCustomer / serializeAddress
// 1:1. Money is integer minor units + ISO-4217 string, never a float.
export interface OrderTotalsWire {
	currency: string;
	subtotalCents: number;
	discountCents: number;
	shippingCents: number;
	taxCents: number;
	totalCents: number;
}

export interface OrderLineWire {
	sku: string;
	title: string;
	unitPriceCents: number;
	currency: string;
	quantity: number;
	fulfillmentKind: string;
}

export interface OrderSummaryWire {
	id: string;
	state: string;
	currency: string;
	paymentMethod: string | null;
	holdExpiresAt: string;
	totals: OrderTotalsWire;
	lines: OrderLineWire[];
}

export interface AddressWire {
	id: string;
	kind: string;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	isDefault: boolean;
}

export type LoginVerifyResult =
	| { ok: true; sessionToken: string; expiresAt: string }
	| { ok: false; reason: "EXPIRED" | "INVALID" | "CONSUMED" };

/** A `/me/*` result: the success payload, or an unauthenticated (401) signal the
 *  account route turns into a redirect to the login page. */
export type AuthedResult<T> = ({ ok: true } & T) | { ok: false; reason: "UNAUTHENTICATED" };
// ── end Phase 5 customer account wire types ────────────────────────────────

// ── Phase 3 group E: cart wire types (plan §6) ─────────────────────────────
// Mirror `@urumi/service`'s `routes/carts.ts` serialization 1:1: NO price
// field on a line (a cart line snapshots no price — domain `CartStore`'s own
// documented invariant; the live price is read from `product_commerce`
// elsewhere, at display/checkout, never stored on the line).
export interface CartLineWire {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
}

export interface CartWire {
	cartId: string;
	state: string;
	/**
	 * The order this cart handed off to (issue #132); null while it is `active`.
	 *
	 * REQUIRED, never optional: an optional field would let TypeScript's own
	 * narrowing bless a bare `!== null` on a value that can still arrive
	 * `undefined` over a skewed wire. `HttpCommerceClient.getCart` NORMALIZES a
	 * missing, empty or non-string value to `null` before any consumer sees it,
	 * which is what makes this declaration honest at runtime too.
	 *
	 * Not a payment signal (it is stamped before the payment intent), and a null
	 * does NOT prove that no order exists for the cart.
	 */
	orderId: string | null;
	currency: string;
	lines: CartLineWire[];
}

/**
 * Typed cart-mutation failures — SEMANTIC TOKENS, never English (matches
 * Phase 2's `AvailabilityToken` pattern): `@urumi/service`'s `CartFailure`
 * union verbatim (adapter-architecture rule #2, "no status-code-as-logic" —
 * `OUT_OF_STOCK` rides a 200, `CART_NOT_FOUND`/`LINE_NOT_FOUND` a 404,
 * `CART_CHECKED_OUT`/`LINE_CHECKED_OUT`/`HOLD_EXPIRED` a 409 — the CLIENT
 * normalizes all of these back to a uniform `{ ok: false; reason }` value,
 * see `HttpCommerceClient`'s `#cartResult`, so callers branch on the token,
 * never the HTTP status).
 */
export type CartFailureReason =
	| "OUT_OF_STOCK"
	| "CART_NOT_FOUND"
	| "LINE_NOT_FOUND"
	| "CART_CHECKED_OUT"
	| "LINE_CHECKED_OUT"
	| "HOLD_EXPIRED"
	// A route-level (not domain-`CartFailure`) reject: the add's `sku` and
	// `productId` disagree with the trusted catalog (issue #80 review). The
	// service returns it as a 409 typed envelope; `#cartResult` normalizes it
	// like any other typed cart failure.
	| "SKU_MISMATCH";

export type CartResult<T> = ({ ok: true } & T) | { ok: false; reason: CartFailureReason };
// ── end Phase 3 group E: cart wire types ───────────────────────────────────

/** Structured failure — status + parsed body, so callers can distinguish
 *  e.g. a 400 `MISSING_PRODUCT_ID` reject from a 503/network failure
 *  (afterSave must treat the latter as fire-and-forget, plan §4). */
export class CommerceClientError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(`commerce service request failed with status ${status}`);
		this.name = "CommerceClientError";
		this.status = status;
		this.body = body;
	}
}
