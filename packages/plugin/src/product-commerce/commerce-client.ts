/**
 * The `CommerceClient` transport port (ADR-0002 §3 / plan §5): storefront
 * routes and the widget's save route depend on this INTERFACE, never on
 * `fetch` directly. `HttpCommerceClient` (http-commerce-client.ts) is the
 * only adapter this phase builds — `InProcessCommerceClient` is deferred
 * (ADR-0002 §6: no premature abstraction beyond a second real adapter).
 *
 * Wire types mirror `@otta-sh/service`'s `PUT/GET/DELETE /products/:id/commerce`
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
	/** Initial stock — a create-if-absent seed, never a restock path (plan §8
	 *  Risk 4). OPERATIONALLY: it lands ONLY on the save that first carries the
	 *  product's sku. Since PR 1a a sku-bearing save always seeds a row
	 *  (`initialOnHand ?? 0`), so a later save's figure hits `ON CONFLICT (sku)
	 *  DO NOTHING` and is silently discarded — by design, so the seed can never
	 *  clobber a live or already-decremented count. Stock after that first save
	 *  is the restock endpoint's job. */
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

// ── Variants wire types ──────────────────────────────────────────────────
// Mirror `@otta-sh/service`'s `serializeVariant`/`serializeVariantSummary` 1:1.
// Money is an integer minor-unit amount + an ISO-4217 string, and ABSENT IS
// ABSENT: an unpriced size is `null`, never `0` and never a zero-amount object.

/** One sellable unit of a product, as the service serializes it. */
export interface ProductVariantWire {
	productId: string;
	/** The CMS repeater row's stable, IMMUTABLE key — the variant's identity
	 *  within its product. Never editable: neither write input carries a field
	 *  that could change it, so a re-key does not compile. */
	variantKey: string;
	/** Null until an admin sets one ("declare then price"). */
	sku: string | null;
	/** Null means ABSENT — a different fact from zero, and never rendered as
	 *  `0`, `0.00` or "Free". A resurrect clears a price whose currency the
	 *  product can no longer honour, which is how a live size ends up here. */
	price: CommerceMoney | null;
	/** The display name — a CACHE of the CMS repeater row's name sub-field, with
	 *  a single writer (`upsertProductVariant`). Eventually consistent. */
	title: string | null;
	/** The ORPHAN tombstone: non-null once the CMS stopped declaring this key.
	 *  The row keeps its sku, price and stock — deactivation, never deletion.
	 *
	 *  ALWAYS NULL ON `listProductVariants`, which serves live rows only; a write
	 *  reply is the one place a non-null value reaches this client today, when a
	 *  declare RESURRECTS a key and answers with the row it revived (null again by
	 *  then). Rendering an orphan distinctly — it may hold stock and sit on live
	 *  orders — needs the internal-token console read, not this one. */
	orphanedAt: string | null;
	createdAt: string;
	/** The compare-and-set watermark an edit must pass back. */
	updatedAt: string;
}

/** A LIST row: the variant plus the coarse stock signal the same statement
 *  joined. The service deliberately does NOT publish the exact count on this
 *  read (it is storefront-reachable) — `inStock` is a stock signal, so a size
 *  whose stock is unknown reads `false`.
 *
 *  It is NOT purchasability on its own: it knows about the size's units and
 *  nothing about the row above it, so it reads `true` for a stocked size of an
 *  unpublished or soft-deleted product. Offer a size only when its PARENT's
 *  `active` says the product is — the same join the product level already
 *  makes (`purchasable ⟺ commerce !== null && commerce.active`). */
export interface ProductVariantSummaryWire extends ProductVariantWire {
	inStock: boolean;
}

/** The CMS-sync DECLARE's body — presence + the name cache, NOTHING
 *  commercial. `sku` and `price` are absent BY DESIGN (ADR-0016): a sync that
 *  could write them would be a second writer racing the admin. */
export interface UpsertProductVariantInput {
	/** `undefined` PRESERVES the stored cache; an explicit `null` CLEARS it. */
	title?: string | null;
	/** The CMS content's `updatedAt` — one ordering watermark for BOTH presence
	 *  transitions. A resurrect applies only on a STRICTLY NEWER value. */
	contentUpdatedAt?: string;
}

/** The ADMIN edit's body — the commerce-owned fields only. `title` is absent BY
 *  DESIGN: the console renders a variant's name as read-only text. */
export interface UpdateProductVariantFieldsInput {
	/** A DIFFERENT value than the row holds is a RENAME, which carries the sku's
	 *  on-hand count with it or refuses — never a silent stranding. */
	sku?: string;
	price?: CommerceMoney;
}

/**
 * The guarded edit's outcome. Every refusal is a VALUE, not a thrown error, so
 * a console renders all of them without branching on an HTTP status.
 *
 * EVERY OPERAND IS NULLABLE, and none of them has a default. The token is what a
 * caller branches on; the operands only sharpen the sentence it renders, and a
 * missing one means THE SERVICE DID NOT SAY — a different fact from any value
 * this client could invent. Both plausible defaults are actively harmful. A
 * `liveHolds` of `0` states that no holds exist, beside a refusal caused BY
 * holds — the one number the console's own rule forbids rendering there, and a
 * flat contradiction of the message it sits in. A `currentUpdatedAt` of `""`
 * re-submits as a watermark that cannot match, turning one recoverable stale
 * edit into a guaranteed second one. A null renders as "unavailable" and the
 * operator reloads; a fabricated value renders as a fact and the operator acts
 * on it.
 */
export type VariantUpdateResult =
	| { ok: true; variant: ProductVariantWire }
	/** Unknown key, or an ORPHANED row — an edit is neither a create nor a
	 *  resurrection; the way back is the CMS re-declaring the key. */
	| { ok: false; reason: "VARIANT_NOT_FOUND" }
	/** Someone else saved first. `currentUpdatedAt` is the watermark to reload
	 *  from and re-submit against — null when the service did not send one, which
	 *  means RELOAD THE ROW, never "re-submit an empty watermark". */
	| { ok: false; reason: "STALE_EDIT"; currentUpdatedAt: string | null }
	/** The price disagrees with the currency the variant, or its product, is
	 *  anchored to. `currency` is THE VARIANT'S OWN, and null when it has none
	 *  yet — the archetypal case, a first pricing refused against the PRODUCT's
	 *  currency. Null is "nothing yet", never "no conflict". */
	| { ok: false; reason: "CURRENCY_MISMATCH"; currency: string | null }
	/** Price must be > 0 — an absent price is expressed by omitting the field. */
	| { ok: false; reason: "INVALID_FIELD"; field: string | null }
	/** Another LIVE sellable unit — a product OR a variant — already holds it. */
	| { ok: false; reason: "SKU_TAKEN"; sku: string | null }
	/** A rename onto a sku that already has its own inventory row. Stock is never
	 *  merged between skus, so the operator decides. */
	| { ok: false; reason: "SKU_STOCK_CONFLICT"; fromSku: string | null; toSku: string | null }
	/** A rename away from a sku that still has live holds. Short-lived by
	 *  construction — a "try again shortly", not a dead end. `liveHolds` is null
	 *  when the count did not arrive; it is NEVER 0, because a zero beside this
	 *  refusal contradicts the refusal. */
	| { ok: false; reason: "SKU_HELD_STOCK"; sku: string | null; liveHolds: number | null };
// ── end variants wire types ──────────────────────────────────────────────

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

	// ── Variants: one method per WRITER, never one per row ────────────────
	// Mirrors the service's `/products/:id/variants*` routes 1:1, and mirrors
	// the two-writer split those routes enforce (ADR-0016): the sync declares
	// presence + the display name, the admin sets sku + price, and neither
	// input type carries the other's fields — so crossing the line does not
	// compile here either, not merely 400 at the wire.
	/** LIVE variants only — the service filters orphans out of this
	 *  unauthenticated read (a discontinued size's name and last price are not
	 *  public data). A console that needs tombstones reads them behind the
	 *  internal token. */
	listProductVariants(productId: string): Promise<ProductVariantSummaryWire[]>;
	/** The CMS-sync DECLARE. Brings a variant into existence, refreshes its
	 *  name cache, and RESURRECTS an orphan — it never refuses presence, so
	 *  there is no typed-failure envelope to normalize. */
	upsertProductVariant(
		productId: string,
		variantKey: string,
		input: UpsertProductVariantInput,
		idempotencyKey: string,
	): Promise<ProductVariantWire>;
	/** The guarded ADMIN edit. `expectedUpdatedAt` is the compare-and-set
	 *  watermark read off the row; every refusal is a typed result, never a
	 *  thrown transport error. */
	updateProductVariantFields(
		productId: string,
		variantKey: string,
		input: UpdateProductVariantFieldsInput,
		expectedUpdatedAt: string,
		idempotencyKey: string,
	): Promise<VariantUpdateResult>;
	/** The ORPHAN transition — deactivation, never deletion; an unknown key is
	 *  a no-op, so this resolves for a key that was never declared. */
	deactivateProductVariant(
		productId: string,
		variantKey: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;
	// ── end variants ──────────────────────────────────────────────────────

	// ── Phase 3 group E: cart (plan §6, wire mirrors @otta-sh/service's ─────
	// `/carts` routes 1:1, hand-rolled like the wire types above — the
	// plugin declares no runtime dependency on @otta-sh/domain/service). ────
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
	// @otta-sh/service's /auth + /me routes 1:1; the bearer session token is
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
	// Wire mirrors @otta-sh/service's routes/orders.ts 1:1. Every typed failure
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
// Mirror @otta-sh/service's `quoteBody`/`checkoutBody` (schemas.ts) and its
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

/** `@otta-sh/service`'s quote rejections: the cart pre-checks it runs before
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

/** `CreateOrderFailure` verbatim (`@otta-sh/domain`'s orders/errors.ts). */
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
// Mirror @otta-sh/service's serializeOrder / serializeCustomer / serializeAddress
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
// Mirror `@otta-sh/service`'s `routes/carts.ts` serialization 1:1: NO price
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
 * Phase 2's `AvailabilityToken` pattern): `@otta-sh/service`'s `CartFailure`
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
	//
	// Since the add endpoint's SKU guard the token covers the whole of "this sku
	// does not name a live sellable unit of that product": an unknown or
	// soft-deleted product, a sku belonging to a different product, and a sku
	// whose variant the CMS has since orphaned. The caller's response is the same
	// in every case — do not re-derive which one it was, the service deliberately
	// does not say.
	| "SKU_MISMATCH"
	// The second route-level reject from the same guard: the sku DOES name a live
	// sellable unit of the product, and nothing has priced it — a variant whose
	// price a resurrect cleared is exactly this state. The same token the quote
	// and checkout paths already use, raised earlier so a shopper is told at the
	// Add button rather than at the last step.
	| "PRODUCT_NOT_PRICED";

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
