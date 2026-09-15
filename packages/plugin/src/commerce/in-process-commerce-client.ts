/**
 * `InProcessCommerceClient` — the `CommerceClient` port with commerce truth held
 * on the plugin's own document store: the `@otta-sh/domain` use-cases composed
 * over the `@otta-sh/store-emdash` adapters bound to `ctx.storage`, with no
 * commerce service and no egress at all (ADR-0018).
 *
 * WHAT THIS CLASS IS, AND WHAT IT IS NOT. It is a TRANSPORT adapter that happens
 * to have no wire: every method checks its inputs against the bounds the request
 * schemas used to enforce (`commerce-input.ts` — read its doc, the watermark
 * format is load-bearing), brands them, calls one use-case, and serializes the
 * result into the same value the other transport returns.
 *
 * It holds no commerce rule of its own. A rule here would be a rule the contract
 * suites cannot see, and the port's whole value is that the two implementations
 * are interchangeable. Where the surface this replaces did something beyond
 * calling a use-case — the add's sku guard, the quote's per-line price
 * resolution — that work is mirrored here and says so: it is part of the
 * behaviour a caller depends on, not part of any HTTP framing.
 *
 * TWO RULES ARE LOAD-BEARING AND NEITHER IS NEGOTIABLE.
 *
 * 1. IDENTITY COMES FROM THE SESSION, NEVER FROM AN ARGUMENT. Every method with
 *    "my" semantics — the customer's own orders, their own addresses, the session
 *    arm of the entitlement check — resolves the customer by handing the bearer
 *    session token to the session store and using what IT returns. No method
 *    accepts a customer id, so a caller cannot name someone else's: the isolation
 *    is structural rather than a filter. A foreign or unknown order is NOT_FOUND
 *    rather than a refusal, so the answer leaks no existence either.
 *
 * 2. INPUT IS REFUSED AT THE BOUNDARY, BEFORE ANY STORE CALL. Removing the wire
 *    removed the request schemas that stood in front of every call; they are
 *    restored in `commerce-input.ts` and applied here first, so a bad input can
 *    never reach a store. It rejects with a structural `INVALID_INPUT` code
 *    carrying the field and the reason.
 *
 * 3. NO STATUS CODES, IN EITHER DIRECTION. There is no HTTP here to translate, so
 *    nothing is translated: where the port declares a typed result the refusal IS
 *    that value, and where it declares none, the domain's or the adapter's own
 *    error surfaces as an AWAITED REJECTION carrying its structural `code`
 *    untouched. In particular a compare-and-set budget exhausted under contention,
 *    and a superseded settings mutation, reach the caller as themselves — the
 *    first is retryable and a caller has to be able to see that.
 *
 * SANDBOX-CLEAN. No `fetch`, no `node:` builtin, no host import: the document
 * store arrives injected on `ctx`, and the adapters reach the host only through
 * the structural storage seam.
 */

import {
	activateProductCommerce,
	addLine,
	cents,
	computeQuote,
	createCart,
	createOrderFromCart,
	currency as toCurrency,
	deactivateProductCommerce,
	deactivateProductVariant,
	email as toEmail,
	getCart,
	getProductCommerce,
	idempotencyKey as toIdempotencyKey,
	InvalidProductFieldError,
	listProductCommerceByIds,
	listProductVariants,
	money,
	orderId as toOrderId,
	productId as toProductId,
	removeLine,
	requestLogin,
	SkuConflictError,
	SkuHeldStockError,
	SkuStockConflictError,
	sku as toSku,
	softDeleteProductCommerce,
	updateLine,
	updateProductVariantFields,
	upsertProductCommerce,
	upsertProductVariant,
	verifyLogin,
	type Address,
	type Cart,
	type CartDeps,
	type CartLine,
	type CreateOrderDeps,
	type FulfillmentKind,
	type Money,
	type Order,
	type PaymentIntentHandle,
	type ProductCommerce as DomainProductCommerce,
	type ProductCommerceView,
	type ProductId,
	type ProductVariant,
	type ProductVariantSummary,
	type TotalsLineInput,
} from "@otta-sh/domain";
import type {
	AddressWire,
	AuthedResult,
	CartLineWire,
	CartResult,
	CartWire,
	CheckoutRequestWire,
	CheckoutResult,
	CommerceClient,
	CommerceMoney,
	LoginVerifyResult,
	OrderLineWire,
	OrderSummaryWire,
	PaymentIntentWire,
	ProductCommerce,
	ProductCommerceBatchItem,
	ProductVariantSummaryWire,
	ProductVariantWire,
	PublicOrderResult,
	PublicOrderWire,
	QuoteRequestWire,
	QuoteResult,
	UpdateProductVariantFieldsInput,
	UpsertProductCommerceInput,
	UpsertProductVariantInput,
	VariantUpdateResult,
} from "../product-commerce/commerce-client.js";
import type { PluginContext } from "../types.js";
import {
	looksLikeEmail,
	requireBatchIds,
	requireBoundedProductId,
	requireBoundedText,
	requireCurrencyCode,
	requireIdToken,
	requireIdempotencyKey,
	requireMoney,
	requireNonNegativeInteger,
	requireNullableInteger,
	requireProductId,
	requireQty,
	requireShippingAddress,
	requireSku,
	requireTitle,
	requireVariantKey,
	requireWatermark,
} from "./commerce-input.js";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
	type InProcessCommerceStoresOptions,
} from "./in-process-commerce-stores.js";

/** The currency a cart gets when the caller names none — the same default this
 *  surface has always applied. */
const DEFAULT_CURRENCY = "USD";

export class InProcessCommerceClient implements CommerceClient {
	readonly #stores: InProcessCommerceStores;
	readonly #cartDeps: CartDeps;
	readonly #createOrderDeps: CreateOrderDeps;

	/**
	 * Takes the whole context, not just the store, and constructs the adapters once
	 * per client — which matches the request-scoped lifecycle the storefront routes
	 * already have: a client is cheap, and nothing may outlive the invocation the
	 * host handed the context to.
	 *
	 * `options` exists for a suite that needs deterministic time or ids. A deploy
	 * passes none.
	 */
	constructor(ctx: PluginContext, options: InProcessCommerceStoresOptions = {}) {
		this.#stores = createInProcessCommerceStores(ctx, options);
		this.#cartDeps = {
			cartStore: this.#stores.cartStore,
			inventoryStore: this.#stores.inventory,
			clock: this.#stores.clock,
		};
		this.#createOrderDeps = {
			orderStore: this.#stores.orderStore,
			cartStore: this.#stores.cartStore,
			inventoryStore: this.#stores.inventory,
			productCommerce: this.#stores.productCommerce,
			shippingRules: this.#stores.shippingRules,
			taxRules: this.#stores.taxRules,
			couponStore: this.#stores.couponStore,
			clock: this.#stores.clock,
			idGen: this.#stores.idGen,
			// EMPTY, AND THAT IS THE CURRENT STATE OF THE PAYMENT TOPOLOGY rather than
			// an oversight: the gateways move in-process with the payment adapters, and
			// until they do `createOrder` cannot mint an intent. The domain refuses a
			// checkout whose method has no gateway, so the refusal is loud rather than
			// a silently unpayable order.
			gateways: {},
		};
	}

	// ── product commerce ────────────────────────────────────────────────────

	async upsertProductCommerce(
		productId: string,
		input: UpsertProductCommerceInput,
		idempotencyKey: string,
	): Promise<ProductCommerce> {
		requireProductId(productId);
		requireIdempotencyKey(idempotencyKey);
		if (input.sku !== undefined) requireSku(input.sku);
		if (input.price !== undefined) requireMoney("price", input.price);
		if (input.title !== undefined) requireTitle(input.title);
		if (input.weightGrams !== undefined) requireNullableInteger("weightGrams", input.weightGrams);
		if (input.lengthMm !== undefined) requireNullableInteger("lengthMm", input.lengthMm);
		if (input.widthMm !== undefined) requireNullableInteger("widthMm", input.widthMm);
		if (input.heightMm !== undefined) requireNullableInteger("heightMm", input.heightMm);
		if (input.initialOnHand !== undefined) {
			requireNonNegativeInteger("initialOnHand", input.initialOnHand);
		}
		if (input.contentUpdatedAt !== undefined) {
			requireWatermark("contentUpdatedAt", input.contentUpdatedAt);
		}
		const row = await upsertProductCommerce(
			{ productCommerce: this.#stores.productCommerce, inventory: this.#stores.inventory },
			{
				productId: toProductId(productId),
				...(input.sku !== undefined ? { sku: toSku(input.sku) } : {}),
				...(input.price !== undefined ? { price: toMoney(input.price) } : {}),
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.taxClass !== undefined ? { taxClass: input.taxClass } : {}),
				...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
				...(input.lengthMm !== undefined ? { lengthMm: input.lengthMm } : {}),
				...(input.widthMm !== undefined ? { widthMm: input.widthMm } : {}),
				...(input.heightMm !== undefined ? { heightMm: input.heightMm } : {}),
				...(input.productKind !== undefined ? { productKind: input.productKind } : {}),
				...(input.contentUpdatedAt !== undefined
					? { contentUpdatedAt: input.contentUpdatedAt }
					: {}),
			},
			toIdempotencyKey(idempotencyKey),
			input.initialOnHand,
		);
		return serializeCommerce(row);
	}

	async getProductCommerce(productId: string): Promise<ProductCommerce | null> {
		requireProductId(productId);
		const row = await getProductCommerce(this.#stores.productCommerce, toProductId(productId));
		return row === null ? null : serializeCommerce(row);
	}

	async softDeleteProductCommerce(productId: string, idempotencyKey: string): Promise<void> {
		requireProductId(productId);
		requireIdempotencyKey(idempotencyKey);
		await softDeleteProductCommerce(
			this.#stores.productCommerce,
			toProductId(productId),
			toIdempotencyKey(idempotencyKey),
		);
	}

	async activateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void> {
		requireProductId(productId);
		requireIdempotencyKey(idempotencyKey);
		requireWatermark("contentUpdatedAt", contentUpdatedAt);
		await activateProductCommerce(
			this.#stores.productCommerce,
			toProductId(productId),
			toIdempotencyKey(idempotencyKey),
			contentUpdatedAt,
		);
	}

	async deactivateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void> {
		requireProductId(productId);
		requireIdempotencyKey(idempotencyKey);
		requireWatermark("contentUpdatedAt", contentUpdatedAt);
		await deactivateProductCommerce(
			this.#stores.productCommerce,
			toProductId(productId),
			toIdempotencyKey(idempotencyKey),
			contentUpdatedAt,
		);
	}

	/** A pure read. An id with no commerce row — or an incomplete one — is OMITTED
	 *  rather than reported, exactly as the port's own contract says. */
	async getCommerceBatch(productIds: string[]): Promise<ProductCommerceBatchItem[]> {
		requireBatchIds(productIds);
		const views = await listProductCommerceByIds(
			this.#stores.productCommerce,
			productIds.map((id) => toProductId(id)),
		);
		return views.map(serializeView);
	}

	// ── variants ────────────────────────────────────────────────────────────

	/**
	 * The PUBLIC projection: live rows only. The operator's projection — every row,
	 * orphans flagged — is a different caller's read, and a discontinued size's
	 * name and last price are not storefront data, so the filter is here rather
	 * than optional.
	 */
	async listProductVariants(productId: string): Promise<ProductVariantSummaryWire[]> {
		requireProductId(productId);
		const rows = await listProductVariants(this.#stores.productCommerce, toProductId(productId));
		return rows.filter((row) => row.orphanedAt === null).map(serializeVariantSummary);
	}

	async upsertProductVariant(
		productId: string,
		variantKey: string,
		input: UpsertProductVariantInput,
		idempotencyKey: string,
	): Promise<ProductVariantWire> {
		requireProductId(productId);
		requireVariantKey(variantKey);
		requireIdempotencyKey(idempotencyKey);
		if (input.title !== undefined) requireTitle(input.title);
		if (input.contentUpdatedAt !== undefined) {
			requireWatermark("contentUpdatedAt", input.contentUpdatedAt);
		}
		const row = await upsertProductVariant(
			this.#stores.productCommerce,
			{
				productId: toProductId(productId),
				variantKey,
				...(input.title !== undefined ? { title: input.title } : {}),
				...(input.contentUpdatedAt !== undefined
					? { contentUpdatedAt: input.contentUpdatedAt }
					: {}),
			},
			toIdempotencyKey(idempotencyKey),
		);
		return serializeVariant(row);
	}

	/**
	 * The guarded admin edit. EVERY documented refusal is a VALUE here, matching
	 * the port: the three compare-and-set outcomes the use-case returns, and the
	 * four refusals the domain raises as errors. Those four are caught BY TYPE and
	 * nothing else is — so a contention abort or a storage fault is never mistaken
	 * for a merchant's input error.
	 */
	async updateProductVariantFields(
		productId: string,
		variantKey: string,
		input: UpdateProductVariantFieldsInput,
		expectedUpdatedAt: string,
		idempotencyKey: string,
	): Promise<VariantUpdateResult> {
		requireProductId(productId);
		requireVariantKey(variantKey);
		requireIdempotencyKey(idempotencyKey);
		requireWatermark("expectedUpdatedAt", expectedUpdatedAt);
		if (input.sku !== undefined) requireSku(input.sku);
		// STRICTLY POSITIVE here, unlike the product upsert: a zero-amount variant
		// price was refused at the wire before the use-case ever saw it, and it has
		// to be refused here for the same reason — an absent price is expressed by
		// omitting the field, so a zero is a mistake rather than a clearing.
		if (input.price !== undefined) requireMoney("price", input.price, { positive: true });
		try {
			const result = await updateProductVariantFields(
				{ productCommerce: this.#stores.productCommerce, inventory: this.#stores.inventory },
				{
					productId: toProductId(productId),
					variantKey,
					...(input.sku !== undefined ? { sku: toSku(input.sku) } : {}),
					...(input.price !== undefined ? { price: toMoney(input.price) } : {}),
					// No `title`: the name is CMS-owned, and the input type carries none.
				},
				toIdempotencyKey(idempotencyKey),
				expectedUpdatedAt,
			);
			if (result.ok) return { ok: true, variant: serializeVariant(result.variant) };
			if (result.reason === "not_found") return { ok: false, reason: "VARIANT_NOT_FOUND" };
			if (result.reason === "stale") {
				return {
					ok: false,
					reason: "STALE_EDIT",
					currentUpdatedAt: result.current.updatedAt.toISOString(),
				};
			}
			// currency_mismatch. The currency reported is THE VARIANT'S OWN and only
			// that, so it is null in the archetypal case — a first pricing refused
			// because it disagreed with the PRODUCT's currency. Null means "nothing
			// yet", never the other row's value smuggled in under this name.
			return {
				ok: false,
				reason: "CURRENCY_MISMATCH",
				currency: result.current.price?.currency ?? null,
			};
		} catch (err) {
			if (err instanceof InvalidProductFieldError) {
				return { ok: false, reason: "INVALID_FIELD", field: err.field };
			}
			if (err instanceof SkuConflictError) return { ok: false, reason: "SKU_TAKEN", sku: err.sku };
			if (err instanceof SkuStockConflictError) {
				return { ok: false, reason: "SKU_STOCK_CONFLICT", fromSku: err.fromSku, toSku: err.toSku };
			}
			if (err instanceof SkuHeldStockError) {
				return { ok: false, reason: "SKU_HELD_STOCK", sku: err.sku, liveHolds: err.liveHolds };
			}
			throw err;
		}
	}

	async deactivateProductVariant(
		productId: string,
		variantKey: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void> {
		requireProductId(productId);
		requireVariantKey(variantKey);
		requireIdempotencyKey(idempotencyKey);
		requireWatermark("contentUpdatedAt", contentUpdatedAt);
		await deactivateProductVariant(
			this.#stores.productCommerce,
			toProductId(productId),
			variantKey,
			toIdempotencyKey(idempotencyKey),
			contentUpdatedAt,
		);
	}

	// ── cart ────────────────────────────────────────────────────────────────

	async createCart(currency?: string): Promise<{ cartId: string }> {
		if (currency !== undefined) requireCurrencyCode("currency", currency);
		const cartId = await createCart(this.#cartDeps, toCurrency(currency ?? DEFAULT_CURRENCY));
		return { cartId };
	}

	/** Runs the lazy hold expiry the use-case owns, then reads. An unknown cart is
	 *  the typed token, never a rejection. */
	async getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>> {
		requireIdToken("cartId", cartId);
		const cart = await getCart(this.#cartDeps, cartId);
		if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
		return { ok: true, cart: serializeCart(cart) };
	}

	/**
	 * The add, with the SKU GUARD in front of it — the one piece of this surface
	 * that is not a bare use-case call, and a security check rather than framing,
	 * so it lives wherever the add lives.
	 *
	 * `sku` and `productId` are two INDEPENDENT caller inputs. Order pricing takes
	 * the price, the title and the digital entitlement from the productId's row but
	 * stamps the line's sku from the cart line, so a caller who could pair product
	 * A's id with product B's sku would be charged A's price while reserving B's
	 * stock. Every add must therefore RESOLVE its sku to a live, priced sellable
	 * unit OF THE NAMED PRODUCT, and anything that does not resolve is refused
	 * rather than reinterpreted.
	 *
	 * A BARE ADD (no productId) is left exactly as it is, deliberately: resolving a
	 * bare sku means asking which unit across the whole catalog holds it, and the
	 * port has no such lookup — every read on it is keyed by product. A bare line
	 * is also unorderable by construction (both checkout paths refuse a null
	 * productId before they price anything), so it can confer neither price nor
	 * entitlement, and the spoof this guard exists to stop is not expressible
	 * through it.
	 */
	async addCartLine(
		cartId: string,
		sku: string,
		productId: string | null,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		requireIdToken("cartId", cartId);
		requireSku(sku);
		// The ADD's product id is bounded the way the add's own schema bounded it —
		// non-empty and at most 200 characters, with NO charset rule. Tightening it to
		// the opaque-id charset here would refuse ids the other transport accepts, and
		// a divergence that refuses MORE is still a divergence.
		if (productId !== null) requireBoundedProductId(productId);
		requireQty(qty);
		requireIdempotencyKey(idempotencyKey);
		let kind: FulfillmentKind = "physical";
		if (productId !== null) {
			const resolved = await this.#resolveSellableUnit(toProductId(productId), sku);
			if (resolved.status === "unknown") return { ok: false, reason: "SKU_MISMATCH" };
			if (resolved.status === "unpriced") {
				// Live, correctly named, and nobody has priced it. Refused HERE and by
				// name so a shopper is told at the Add button rather than at the last
				// step, and so no stock is held for a line that could never be bought.
				return { ok: false, reason: "PRODUCT_NOT_PRICED" };
			}
			kind = resolved.productKind;
		}
		const result = await addLine(
			this.#cartDeps,
			cartId,
			toSku(sku),
			productId,
			qty,
			toIdempotencyKey(idempotencyKey),
			kind,
		);
		if (!result.ok) return { ok: false, reason: result.reason };
		return { ok: true, line: serializeLine(result.line) };
	}

	/** The TARGET quantity, never a delta — the use-case applies the difference. */
	async adjustCartLine(
		cartId: string,
		lineId: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		requireIdToken("cartId", cartId);
		requireIdToken("lineId", lineId);
		requireQty(qty);
		requireIdempotencyKey(idempotencyKey);
		const result = await updateLine(
			this.#cartDeps,
			cartId,
			lineId,
			qty,
			toIdempotencyKey(idempotencyKey),
		);
		if (!result.ok) return { ok: false, reason: result.reason };
		return { ok: true, line: serializeLine(result.line) };
	}

	async removeCartLine(
		cartId: string,
		lineId: string,
		idempotencyKey: string,
	): Promise<CartResult<Record<string, never>>> {
		requireIdToken("cartId", cartId);
		requireIdToken("lineId", lineId);
		requireIdempotencyKey(idempotencyKey);
		const result = await removeLine(
			this.#cartDeps,
			cartId,
			lineId,
			toIdempotencyKey(idempotencyKey),
		);
		if (!result.ok) return { ok: false, reason: result.reason };
		// The success arm carries NOTHING beyond the token, and the port says so with
		// `Record<string, never>` — a shape no object literal can satisfy structurally
		// (its own `ok` key contradicts the index signature), which is why the assertion
		// is here rather than a payload invented to satisfy it.
		return { ok: true } as CartResult<Record<string, never>>;
	}

	// ── customer account ────────────────────────────────────────────────────

	/**
	 * Issues the login challenge. The answer is IDENTICAL whether or not an account
	 * exists and whether or not the issue was throttled — an account oracle is
	 * exactly what this surface must not be — so a malformed address is the same
	 * generic success rather than a distinguishable refusal.
	 *
	 * The emailed link is not dispatched from here yet: mail delivery moves
	 * in-process with the rest of the outbound topology, and until it does this
	 * records the challenge and nothing more. A storage failure still rejects —
	 * that is infrastructure, not an answer about an account.
	 */
	async requestLoginLink(email: string): Promise<{ ok: true }> {
		// CHECKED BUT NEVER REPORTED: a bound that fails here ends the call in the
		// same generic success a valid address gets. This surface must answer
		// identically whatever it is handed, so a refusal — of a bound OR of an
		// address — would be a usable signal about which addresses exist.
		if (!looksLikeEmail(email)) return { ok: true };
		let address;
		try {
			address = toEmail(email);
		} catch {
			return { ok: true };
		}
		await requestLogin({ credentialVerifier: this.#stores.credentialVerifier }, { email: address });
		return { ok: true };
	}

	async verifyLogin(challengeId: string, token: string): Promise<LoginVerifyResult> {
		requireIdToken("challengeId", challengeId);
		requireBoundedText("token", token, 1, 400);
		const result = await verifyLogin(
			{
				credentialVerifier: this.#stores.credentialVerifier,
				customerStore: this.#stores.customerStore,
				sessionStore: this.#stores.sessionStore,
				orderStore: this.#stores.orderStore,
				clock: this.#stores.clock,
			},
			{ challengeId, token },
		);
		if (!result.ok) return { ok: false, reason: result.reason };
		return { ok: true, sessionToken: result.sessionToken, expiresAt: result.expiresAt };
	}

	/** Idempotent: revoking an unknown or already-revoked session is a no-op. */
	async logout(sessionToken: string): Promise<void> {
		await this.#stores.sessionStore.revoke(sessionToken);
	}

	async listMyOrders(sessionToken: string): Promise<AuthedResult<{ orders: OrderSummaryWire[] }>> {
		const customerId = await this.#stores.sessionStore.validate(sessionToken);
		if (customerId === null) return { ok: false, reason: "UNAUTHENTICATED" };
		const orders = await this.#stores.orderStore.listForCustomer(customerId);
		return { ok: true, orders: orders.map(serializeOrderSummary) };
	}

	/** A foreign or unknown order is NOT_FOUND, never a refusal: the answer must
	 *  not tell a caller that somebody else's order exists. */
	async getMyOrder(
		sessionToken: string,
		orderId: string,
	): Promise<
		{ ok: true; order: OrderSummaryWire } | { ok: false; reason: "UNAUTHENTICATED" | "NOT_FOUND" }
	> {
		const customerId = await this.#stores.sessionStore.validate(sessionToken);
		if (customerId === null) return { ok: false, reason: "UNAUTHENTICATED" };
		requireIdToken("orderId", orderId);
		const order = await this.#stores.orderStore.getById(toOrderId(orderId));
		if (order === null || order.customerId !== customerId) {
			return { ok: false, reason: "NOT_FOUND" };
		}
		return { ok: true, order: serializeOrderSummary(order) };
	}

	async listMyAddresses(sessionToken: string): Promise<AuthedResult<{ addresses: AddressWire[] }>> {
		const customerId = await this.#stores.sessionStore.validate(sessionToken);
		if (customerId === null) return { ok: false, reason: "UNAUTHENTICATED" };
		const addresses = await this.#stores.addressStore.list(customerId);
		return { ok: true, addresses: addresses.map(serializeAddress) };
	}

	// ── delivery authorization ──────────────────────────────────────────────

	/**
	 * Two scopes, by PRESENCE and in this order:
	 *  1. `scope.orderId` — the download link's unguessable order id, an open
	 *     bearer capability. A session token, if one came along, is ignored: with
	 *     no email in the question there is nothing to probe.
	 *  2. else a valid session — the buyer's own entitlements only, because the
	 *     email the check runs against is read off the session's customer HERE and
	 *     can never be supplied by the caller.
	 * Anything else is unauthenticated. The raw-email scope is operator-only and is
	 * not reachable through this port at all: it carries no field for one.
	 */
	async checkEntitlement(
		scope: { orderId?: string },
		sku: string,
		opts: { sessionToken?: string } = {},
	): Promise<AuthedResult<{ active: boolean }>> {
		requireSku(sku, 200);
		const skuValue = toSku(sku);
		if (scope.orderId !== undefined) {
			// The check's own schema bounded this one as plain text, not as a path
			// parameter — mirror that rather than the stricter path rule.
			requireBoundedText("orderId", scope.orderId, 1, 200);
			const active = await this.#stores.entitlementStore.check({
				orderId: toOrderId(scope.orderId),
				sku: skuValue,
			});
			return { ok: true, active };
		}
		if (opts.sessionToken !== undefined) {
			const customerId = await this.#stores.sessionStore.validate(opts.sessionToken);
			if (customerId !== null) {
				const customer = await this.#stores.customerStore.get(customerId);
				if (customer !== null) {
					const active = await this.#stores.entitlementStore.check({
						buyerRef: customer.email,
						sku: skuValue,
					});
					return { ok: true, active };
				}
			}
		}
		return { ok: false, reason: "UNAUTHENTICATED" };
	}

	// ── checkout ────────────────────────────────────────────────────────────

	/**
	 * The totals preview. It redeems nothing, so it is safe to repeat as the buyer
	 * edits their selection.
	 *
	 * The per-line price resolution is mirrored from the surface this replaces,
	 * including its precedence: a line with no product reference cannot be priced
	 * and answers PRODUCT_NOT_PRICED before any currency comparison happens. Every
	 * line's projection is fetched in ONE store round trip — a per-line read would
	 * be an N+1 on the hottest path in checkout.
	 */
	async quoteCheckout(input: QuoteRequestWire): Promise<QuoteResult> {
		requireIdToken("cartId", input.cartId);
		if (input.shippingZoneId !== undefined) requireIdToken("shippingZoneId", input.shippingZoneId);
		if (input.shippingMethodId !== undefined) {
			requireIdToken("shippingMethodId", input.shippingMethodId);
		}
		if (input.couponCode !== undefined) requireBoundedText("couponCode", input.couponCode, 1, 200);
		const cart = await this.#stores.cartStore.get(input.cartId);
		if (cart === null) return { ok: false, reason: "CART_NOT_FOUND" };
		if (cart.lines.length === 0) return { ok: false, reason: "CART_EMPTY" };

		const byId = await this.#stores.productCommerce.getManyByProductId(
			cart.lines
				.map((line) => line.productId)
				.filter((id): id is string => id !== null)
				.map((id) => toProductId(id)),
		);
		const lines: TotalsLineInput[] = [];
		for (const line of cart.lines) {
			if (line.productId === null) return { ok: false, reason: "PRODUCT_NOT_PRICED" };
			const row = byId.get(toProductId(line.productId)) ?? null;
			if (row === null || row.price === null) return { ok: false, reason: "PRODUCT_NOT_PRICED" };
			if (row.price.currency !== cart.currency) return { ok: false, reason: "CURRENCY_MISMATCH" };
			lines.push({
				unitPriceCents: row.price.amount,
				qty: line.qty,
				taxClassId: row.taxClass ?? "standard",
			});
		}

		const quote = await computeQuote(
			{
				shippingRules: this.#stores.shippingRules,
				taxRules: this.#stores.taxRules,
				couponStore: this.#stores.couponStore,
				clock: this.#stores.clock,
			},
			{
				currency: cart.currency,
				lines,
				...(input.shippingZoneId !== undefined ? { zoneId: input.shippingZoneId } : {}),
				...(input.shippingMethodId !== undefined ? { methodId: input.shippingMethodId } : {}),
				...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
			},
		);
		if (!quote.ok) return { ok: false, reason: quote.reason };
		const breakdown = quote.breakdown;
		return {
			ok: true,
			breakdown: {
				currency: breakdown.currency,
				subtotalCents: breakdown.subtotalCents,
				discountCents: breakdown.discountCents,
				shippingCents: breakdown.shippingCents,
				taxCents: breakdown.taxCents,
				totalCents: breakdown.totalCents,
				appliedCouponCode: breakdown.appliedCouponCode ?? null,
			},
		};
	}

	/**
	 * Mints the order, holds stock for the checkout window and creates the payment
	 * intent. The `idempotencyKey` is the CALLER's and is used verbatim: it must be
	 * stable per cart, or a reload mints a second order.
	 *
	 * NO CUSTOMER ID IS THREADED, matching the surface this replaces: the claim
	 * travelling with a checkout is the `buyerRef`, and a guest's orders are linked
	 * to an account when the buyer next proves that inbox is theirs.
	 *
	 * The reply carries the PUBLIC order projection, which is the narrower of the
	 * two available and deliberately so: the only fields a checkout page uses off
	 * this reply are the order's id and state, and projecting the whitelist means
	 * the ship-to snapshot and the buyer reference cannot reach a page by accident.
	 */
	async createOrder(input: CheckoutRequestWire, idempotencyKey: string): Promise<CheckoutResult> {
		requireIdToken("cartId", input.cartId);
		requireIdempotencyKey(idempotencyKey);
		requireBoundedText("buyerRef", input.buyerRef, 1, 320);
		if (input.shippingZoneId !== undefined) requireIdToken("shippingZoneId", input.shippingZoneId);
		if (input.shippingMethodId !== undefined) {
			requireIdToken("shippingMethodId", input.shippingMethodId);
		}
		if (input.couponCode !== undefined) requireBoundedText("couponCode", input.couponCode, 1, 200);
		if (input.shippingAddress !== undefined) requireShippingAddress(input.shippingAddress);
		const result = await createOrderFromCart(this.#createOrderDeps, {
			cartId: input.cartId,
			idempotencyKey: toIdempotencyKey(idempotencyKey),
			buyerRef: input.buyerRef,
			paymentMethod: input.paymentMethod,
			...(input.shippingZoneId !== undefined ? { shippingZoneId: input.shippingZoneId } : {}),
			...(input.shippingMethodId !== undefined ? { shippingMethodId: input.shippingMethodId } : {}),
			...(input.couponCode !== undefined ? { couponCode: input.couponCode } : {}),
			...(input.shippingAddress !== undefined ? { shippingAddress: input.shippingAddress } : {}),
		});
		if (!result.ok) return { ok: false, reason: result.reason };
		return {
			ok: true,
			order: serializePublicOrder(result.order),
			intent: serializeIntent(result.intent),
		};
	}

	/** The capability read: the order id alone is the credential, so the reply is
	 *  the public whitelist and never the operator's view. */
	async getPublicOrder(orderId: string): Promise<PublicOrderResult> {
		requireIdToken("orderId", orderId);
		const order = await this.#stores.orderStore.getById(toOrderId(orderId));
		if (order === null) return { ok: false, reason: "ORDER_NOT_FOUND" };
		return { ok: true, order: serializePublicOrder(order) };
	}

	/**
	 * Resolve a submitted sku to ONE live sellable unit of ONE named product.
	 *
	 * "Live sellable unit" is the port's own definition and spans both tables: a
	 * product row that is not soft-deleted, and a variant row that is not orphaned
	 * — deliberately the same predicate the live-sku uniqueness rule uses, and
	 * deliberately NOT the publish gate, which decides whether a storefront LISTS a
	 * product and must never be conflated with whether a sku names a real thing.
	 * PRICED is part of sellable: a unit nobody has priced cannot be sold, and one
	 * priced at a row that is not its own is worse than unsold.
	 *
	 * A live, priced VARIANT is resolved and then REFUSED, and that is the whole of
	 * the variant branch today: order pricing reads the snapshot price AND title
	 * from the product row and has no way to reach a variant, so letting a size into
	 * a cart would sell the parent's price under the parent's name, immutably. The
	 * refusal is the same token a spoof gets, so nothing is published about which
	 * sizes exist. The branch opens when order pricing resolves the sellable unit
	 * rather than the product row — one return statement, in this one place.
	 *
	 * Cost: one keyed read on the hot path (the product's own sku matches), a second
	 * only when it does not. Per REQUEST, never per line; an add carries one line.
	 */
	async #resolveSellableUnit(
		productId: ProductId,
		submittedSku: string,
	): Promise<
		{ status: "ok"; productKind: FulfillmentKind } | { status: "unknown" } | { status: "unpriced" }
	> {
		const product = await this.#stores.productCommerce.getByProductId(productId);
		if (product === null || product.deletedAt !== null) return { status: "unknown" };
		if (product.sku !== null && String(product.sku) === submittedSku) {
			return product.price === null
				? { status: "unpriced" }
				: { status: "ok", productKind: product.productKind };
		}
		// Either this product sells through variants, or the sku belongs to somebody
		// else entirely. Both arms answer `unknown` today, so the lookup below is
		// SCAFFOLDING — held here, unobserved, because it keeps the flip to a single
		// return in the one place that already knows which rows are live and which
		// sku was asked for.
		const variants = await this.#stores.productCommerce.listVariants(productId);
		const variant = variants.find(
			(row) => row.orphanedAt === null && row.sku !== null && String(row.sku) === submittedSku,
		);
		if (variant === undefined) return { status: "unknown" };
		return { status: "unknown" };
	}
}

// ── serialization ─────────────────────────────────────────────────────────
// Every value this client returns is built here, and money is an integer minor
// amount plus an ISO-4217 string in every one of them. ABSENT IS ABSENT: an
// unpriced row is `null`, never `0` and never a zero-amount object — rendering a
// missing price as zero would turn "nobody has priced this" into "this is free".

function toMoney(value: CommerceMoney): Money {
	return money(cents(value.amount), toCurrency(value.currency));
}

function toMoneyWire(value: Money | null): CommerceMoney | null {
	return value === null ? null : { amount: value.amount, currency: value.currency };
}

function serializeCommerce(row: DomainProductCommerce): ProductCommerce {
	return {
		productId: row.productId,
		sku: row.sku,
		price: toMoneyWire(row.price),
		taxClass: row.taxClass,
		weightGrams: row.weightGrams,
		lengthMm: row.lengthMm,
		widthMm: row.widthMm,
		heightMm: row.heightMm,
		productKind: row.productKind,
		active: row.active,
		deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
		contentUpdatedAt: row.contentUpdatedAt,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** The catalog batch item. `inStock` is the store's own single join — this client
 *  never makes a second inventory round trip for it. */
function serializeView(view: ProductCommerceView): ProductCommerceBatchItem {
	return {
		productId: view.productId,
		sku: view.sku,
		price: { amount: view.price.amount, currency: view.price.currency },
		inStock: view.inStock,
		active: view.active,
	};
}

/** One variant, for the list and for both write replies. `inStock` is absent from
 *  a WRITE reply on purpose: a write states what it wrote, and the store joins no
 *  stock for it — a hardcoded `false` beside a size that has units would be worse
 *  than the omission. */
function serializeVariant(row: ProductVariant | ProductVariantSummary): ProductVariantWire {
	return {
		productId: row.productId,
		variantKey: row.variantKey,
		sku: row.sku,
		price: toMoneyWire(row.price),
		title: row.title,
		orphanedAt: row.orphanedAt === null ? null : row.orphanedAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * The LIST row: the variant plus the coarse stock signal the same statement
 * joined. The exact count is NOT projected — this read is storefront-reachable,
 * and a per-sku count is operational data a buyer must not be handed. Folding the
 * port's "unknown" into `false` is right for a purchasability signal and would be
 * wrong for anything that renders the number: a size whose stock nobody knows is
 * not one to offer.
 */
function serializeVariantSummary(row: ProductVariantSummary): ProductVariantSummaryWire {
	return {
		...serializeVariant(row),
		inStock: row.onHand !== null && row.onHand > 0,
	};
}

function serializeCart(cart: Cart): CartWire {
	return {
		cartId: cart.cartId,
		state: cart.state,
		// The order this cart handed off to; null while it is active. Not a payment
		// signal — it is stamped before the intent — and a null does not prove that
		// no order exists for the cart.
		orderId: cart.orderId,
		currency: cart.currency,
		lines: cart.lines.map(serializeLine),
	};
}

/** A cart line carries NO price: a line snapshots none, and the live price is read
 *  from the commerce row at display and at checkout. */
function serializeLine(line: CartLine): CartLineWire {
	return {
		lineId: line.lineId,
		sku: line.sku,
		productId: line.productId,
		qty: line.qty,
		reservationId: line.reservationId,
		expiresAt: line.expiresAt,
	};
}

function serializeOrderLines(order: Order): OrderLineWire[] {
	return order.lines.map((line) => ({
		sku: line.sku,
		title: line.title,
		unitPriceCents: line.unitPrice,
		currency: line.currency,
		quantity: line.quantity,
		fulfillmentKind: line.fulfillmentKind,
	}));
}

/** The customer's own order, as their account pages read it. */
function serializeOrderSummary(order: Order): OrderSummaryWire {
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		holdExpiresAt: order.holdExpiresAt,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
		},
		lines: serializeOrderLines(order),
	};
}

/**
 * The public projection — a WHITELIST, not a delete-list, so a field added to the
 * order model later is PRIVATE by default. It omits the buyer reference, the
 * customer id, the ship-to snapshot and the reconciliation fields ENTIRELY rather
 * than as nulls, so a caller cannot tell "redacted" from "absent" and probe for
 * the real shape; fulfillment and cancellation stay but are TRIMMED to what a
 * guest may legitimately read — carrier and tracking, the cancellation reason —
 * never the staff identity, the audit witness or the free-text detail.
 */
function serializePublicOrder(order: Order): PublicOrderWire {
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		holdExpiresAt: order.holdExpiresAt,
		createdAt: order.createdAt,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
			appliedCouponCode: order.totals.appliedCouponCode,
			shippingZoneId: shippingZoneIdOf(order.totals.shippingMethodSnapshot),
		},
		lines: serializeOrderLines(order),
		fulfillment:
			order.fulfillment === null
				? null
				: {
						carrier: order.fulfillment.carrier,
						trackingNumber: order.fulfillment.trackingNumber,
						trackingUrl: order.fulfillment.trackingUrl,
						shippedAt: order.fulfillment.shippedAt,
					},
		cancellation:
			order.cancellation === null
				? null
				: { reason: order.cancellation.reason, cancelledAt: order.cancellation.cancelledAt },
	};
}

/** The chosen shipping zone, read off the totals' method snapshot (an opaque value
 *  on the model). Display-only: never used for matching. */
function shippingZoneIdOf(snapshot: unknown): string | null {
	if (snapshot === null || typeof snapshot !== "object") return null;
	const zoneId = (snapshot as { zoneId?: unknown }).zoneId;
	return typeof zoneId === "string" ? zoneId : null;
}

function serializeAddress(address: Address): AddressWire {
	return {
		id: address.id,
		kind: address.kind,
		name: address.name,
		line1: address.line1,
		line2: address.line2,
		city: address.city,
		region: address.region,
		postalCode: address.postalCode,
		country: address.country,
		isDefault: address.isDefault,
	};
}

/** The payment handle, passed through unmodified — this client never inspects a
 *  client secret beyond handing it on. */
function serializeIntent(intent: PaymentIntentHandle): PaymentIntentWire {
	return { gateway: intent.gateway, intentId: intent.intentId, clientAction: intent.clientAction };
}
