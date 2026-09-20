/**
 * `InProcessAdminProductsClient` — the admin Products console surface with
 * commerce truth held on the plugin's own document store (work order 02,
 * INC-B10b-i).
 *
 * WHAT THIS CLASS IS. The sole implementation of `AdminProductsSurface`: the same
 * six methods, the same argument shapes, the same RETURN VALUES — including every
 * field the `*Wire` types carry — with the `@otta-sh/domain` use-cases composed
 * over the `@otta-sh/store-emdash` adapters bound to `ctx.storage` instead of a
 * commerce service. Nothing here reaches for egress; `ctx.http` is never
 * touched.
 *
 * NO FIELD IS NARROWED, and that is a rule rather than a preference. The React
 * admin screens consume these results through `console-api.ts` STRUCTURAL
 * mirrors — they import no wire type — so a field quietly dropped here is
 * invisible to the compiler and breaks at runtime. In particular: `onHand` stays
 * `number | null` and is never coerced to `0` (`null` is "no inventory row",
 * which is not "out of stock"), `deletedAt` is always present, and every
 * `reason` member of the three discriminated results keeps the operands its
 * operator copy is composed from.
 *
 * NO ADMIN AUTH HERE, deliberately (ADR-0014 D3). EmDash's own admin auth and
 * CSRF gate the console route that constructs this; there is no service to
 * authenticate to, so there is nothing to authenticate WITH. The HTTP tier's
 * `X-Internal-Token` / `X-Service-Token` are transport concerns and stay on the
 * transport.
 *
 * WHAT WAS PORTED, AND FROM WHERE. Three pieces of the service's route layer are
 * behaviour rather than framing, so they are mirrored here and named so the two
 * can be compared by eye:
 *  - the products list's opaque cursor (position + filter + limit, base64url
 *    JSON), its RE-VALIDATION on decode, and the fail-closed disagreement check
 *    between a token's filter/limit and the caller's — plus the client-side
 *    recovery that re-issues page one and flags `cursorRejected`;
 *  - the two serializers, field for field;
 *  - `getTaxClasses`, whose real logic lives in the service's `rules-admin`
 *    route (`GET /admin/tax/classes`) even though it is a products-client
 *    method: it is `TaxRulesStore.listClasses()`, unfiltered, in store order.
 *
 * INPUT IS REFUSED AT THE BOUNDARY, as in `InProcessCommerceClient` — the
 * request schemas that used to stand in front of every call are mirrored through
 * `commerce-input.ts`. Where the HTTP tier turns a refused input into a TYPED
 * RESULT (the edit's 400 ⇒ `{ ok: false, reason: "invalid" }`, a stock
 * movement's ⇒ the same), this returns that value too; where it throws (the two
 * reads), this rejects.
 *
 * SANDBOX-CLEAN. No `fetch`, no `node:` builtin, no host import.
 */

import {
	cents as toCents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	InvalidProductFieldError,
	MAX_LOW_STOCK_THRESHOLD,
	money as toMoney,
	productId as toProductId,
	removeStock as removeStockUseCase,
	restock as restockUseCase,
	sku as toSku,
	SkuConflictError,
	SkuHeldStockError,
	SkuStockConflictError,
	updateProductCommerceFields,
	type ProductCommerce as DomainProductCommerce,
	type ProductListCursor,
	type ProductListFilter,
	type ProductSummary,
	type UpdateProductCommerceFieldsInput,
} from "@otta-sh/domain";
import {
	CommerceInputError,
	isCommerceInputError,
	requireBoundedText,
	requireIdToken,
	requireMoney,
	requireNullableInteger,
	requireWatermark,
} from "../commerce/commerce-input.js";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
	type InProcessCommerceStoresOptions,
} from "../commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../types.js";
import type {
	AdminProductsSurface,
	ProductDetailWire,
	ProductEditResult,
	ProductEditWire,
	ProductsListFilter,
	ProductsListResult,
	ProductSummaryWire,
	RestockResult,
	StockRemovalResult,
	TaxClassWire,
} from "./admin-products-surface.js";

/** The page-size bounds the list query schema enforced (`productsListQuery`:
 *  `min(1).max(100)`, default 25). Mirrored, not imported — the service package
 *  goes away. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** The stock-movement quantity ceiling (`stockMovementBody`: a positive integer
 *  no greater than this). Far above the shopper-facing cart cap on purpose: this
 *  is the merchant's own surface. */
const MAX_STOCK_MOVEMENT_QTY = 1_000_000_000;

export class InProcessAdminProductsClient implements AdminProductsSurface {
	readonly #stores: InProcessCommerceStores;

	/**
	 * Takes the whole context and constructs the adapters once per client, the
	 * same request-scoped lifecycle the console route already had. A context with
	 * no document store fails HERE, at construction, naming what is missing.
	 */
	constructor(ctx: PluginContext, options: InProcessCommerceStoresOptions = {}) {
		this.#stores = createInProcessCommerceStores(ctx, options);
	}

	/**
	 * The admin products page, its exact total, and the cursor for the next one.
	 *
	 * THE FILTER TRAVELS BESIDE THE CURSOR, and the two are compared as
	 * PREDICATES. A token whose filter or limit disagrees with the caller's is
	 * REFUSED, exactly as the route refuses it — and the refusal is then handled
	 * the way the HTTP client handles it: page one is re-issued with the caller's
	 * own parameters, once, and comes back flagged `cursorRejected` so a console
	 * can say out loud that it did not get the page it asked for.
	 *
	 * A malformed filter value REJECTS rather than resolving, because the other
	 * transport's schema answers 400 and its client throws on a non-cursor 400.
	 */
	async listProducts(
		filter: ProductsListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<ProductsListResult> {
		const asked = toDomainFilter(filter);
		const askedLimit = requireLimit(opts.limit);
		const token = opts.cursor !== undefined && opts.cursor.length > 0 ? opts.cursor : null;
		if (token === null) return this.#page(asked, null, askedLimit);

		const refused = this.#resolveCursor(token, asked, opts.limit, askedLimit);
		if (refused !== null) return this.#page(refused.filter, refused.pos, refused.limit);

		// THE PRESCRIBED RECOVERY, at the tier the HTTP client performs it at: drop
		// the token, re-issue page one with the same parameters, once, and say so.
		// The request is still made even for a caller that will discard the rows —
		// the flag needs a page behind it, and this tier cannot know which caller it
		// has.
		const retried = await this.#page(asked, null, askedLimit);
		return { ...retried, cursorRejected: true };
	}

	/** GET one product's full detail (incl. its single-sku stock read). An id that
	 *  never existed resolves to `null`; a SOFT-DELETED row resolves to the row,
	 *  with `deletedAt` set — the honest read-only tombstone view, never a 404
	 *  masquerading as "never existed". */
	async getProduct(productId: string): Promise<ProductDetailWire | null> {
		requireIdToken("productId", productId);
		const product = await this.#stores.productCommerce.getByProductId(toProductId(productId));
		if (product === null) return null;
		// `findOnHand`, never `getOnHand`: the latter collapses "no inventory row"
		// into `0`, and the detail leaf is the screen with the most context — the
		// last place that should be the one guessing.
		const onHand =
			product.sku === null ? null : await this.#stores.inventory.findOnHand(product.sku);
		return toProductDetailWire(product, onHand);
	}

	/**
	 * Edit the commerce-owned fields of one product, compare-and-set on the
	 * watermark the admin loaded.
	 *
	 * Every refusal is a typed member rather than a throw, because that is what
	 * the other transport's status mapping produces. A refused INPUT is
	 * `{ reason: "invalid", field: null }` — the shape the wire's schema 400
	 * produces, which carries no field — while the domain's own
	 * `InvalidProductFieldError` names the field it rejected, as its 400 does.
	 */
	async updateProduct(
		productId: string,
		body: ProductEditWire,
		key: string,
	): Promise<ProductEditResult> {
		let input: UpdateProductCommerceFieldsInput;
		let expectedUpdatedAt: string;
		try {
			requireIdToken("productId", productId);
			expectedUpdatedAt = requireWatermark("expectedUpdatedAt", body.expectedUpdatedAt);
			input = toUpdateInput(productId, body);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, reason: "invalid", field: null };
			throw err;
		}

		// The route's own fallback, mirrored: a stable key dedupes a double-submit,
		// and absent one a deterministic key over the target + the expected watermark
		// keeps replays of THIS edit idempotent (a genuine second edit carries a
		// fresher watermark ⇒ a distinct fallback key).
		const idempotencyKey =
			key.length > 0 ? key : `admin:product-edit:${productId}:${expectedUpdatedAt}`;

		try {
			const res = await updateProductCommerceFields(
				{ productCommerce: this.#stores.productCommerce, inventory: this.#stores.inventory },
				input,
				toIdempotencyKey(idempotencyKey),
				expectedUpdatedAt,
			);
			if (res.ok) return { ok: true, updatedAt: res.product.updatedAt.toISOString() };
			if (res.reason === "not_found") return { ok: false, reason: "not_found" };
			if (res.reason === "stale") {
				return {
					ok: false,
					reason: "stale",
					currentUpdatedAt: res.current.updatedAt.toISOString(),
				};
			}
			return {
				ok: false,
				reason: "currency_mismatch",
				currency: res.current.price?.currency ?? null,
			};
		} catch (err) {
			if (err instanceof InvalidProductFieldError) {
				return { ok: false, reason: "invalid", field: err.field };
			}
			if (err instanceof SkuConflictError) return { ok: false, reason: "sku_taken", sku: err.sku };
			if (err instanceof SkuStockConflictError) {
				return {
					ok: false,
					reason: "sku_stock_conflict",
					fromSku: err.fromSku,
					toSku: err.toSku,
				};
			}
			if (err instanceof SkuHeldStockError) {
				// A count that is not a whole number is NOT a count — the same
				// normalisation the HTTP client applies to the wire's value, so a
				// console renders "some, number unknown" rather than a `0` that would
				// read as "no holds" beside a refusal caused by holds.
				const holds: unknown = err.liveHolds;
				return {
					ok: false,
					reason: "sku_held_stock",
					sku: err.sku,
					liveHolds:
						typeof holds === "number" && Number.isInteger(holds) && holds > 0 ? holds : null,
				};
			}
			throw err;
		}
	}

	/** ADD `qty` units to the product's stock. `key` is REQUIRED and must be stable
	 *  per submission: a restock is additive, so two deliberate "+5"s must not
	 *  collapse and there is no safe content-only fallback. */
	async restock(productId: string, qty: number, key: string): Promise<RestockResult> {
		const resolved = await this.#resolveStockMovement(productId, qty, key);
		if (resolved.status !== "ok") return { ok: false, reason: resolved.status };
		const res = await restockUseCase(
			this.#stores.inventory,
			toSku(resolved.sku),
			qty,
			toIdempotencyKey(key),
		);
		if (res.ok) return { ok: true, onHand: res.onHand };
		// UNKNOWN_SKU: the product exists but has no inventory row yet (priced but
		// never seeded). A stock movement cannot create one.
		return { ok: false, reason: "no_inventory_row" };
	}

	/** REMOVE `qty` damaged/shrinkage units. The domain applies a GUARDED
	 *  decrement, so an over-removal is a clean `insufficient_stock` carrying the
	 *  current count — never a negative stock and never a throw. */
	async removeStock(productId: string, qty: number, key: string): Promise<StockRemovalResult> {
		const resolved = await this.#resolveStockMovement(productId, qty, key);
		if (resolved.status !== "ok") return { ok: false, reason: resolved.status };
		const res = await removeStockUseCase(
			this.#stores.inventory,
			toSku(resolved.sku),
			qty,
			toIdempotencyKey(key),
		);
		if (res.ok) return { ok: true, onHand: res.onHand };
		if (res.reason === "INSUFFICIENT_STOCK") {
			return { ok: false, reason: "insufficient_stock", onHand: res.onHand };
		}
		return { ok: false, reason: "no_inventory_row" };
	}

	/**
	 * The tax-class registry — the source for the edit form's tax-class select.
	 *
	 * PORTED FROM `rules-admin.ts`'s `GET /admin/tax/classes`, which is where this
	 * products-client method's logic has always lived: the whole registry, in the
	 * store's own order, with no filter and no projection. A caller treats it as
	 * best-effort and falls back to a static default set, so this must fail rather
	 * than invent options.
	 */
	async getTaxClasses(): Promise<TaxClassWire[]> {
		return this.#stores.taxRules.listClasses();
	}

	// -- internals -------------------------------------------------------------

	/**
	 * Decode a cursor token and decide whether it may be honoured.
	 *
	 * Returns the page to read, or `null` for a REFUSAL — which is every one of
	 * the route's own fail-closed cases: an undecodable or tampered token, a
	 * position that is not a position, a decoded filter that does not re-validate,
	 * a filter the caller SPELLED OUT that disagrees with the token's, and a limit
	 * the caller spelled out that disagrees with the token's clamped one.
	 */
	#resolveCursor(
		token: string,
		asked: ProductListFilter,
		askedLimitRaw: number | undefined,
		askedLimit: number,
	): { filter: ProductListFilter; pos: ProductListCursor; limit: number } | null {
		const decoded = decodeProductCursor(token);
		if (decoded === null) return null;
		const pos = productCursorPosOf(decoded.pos);
		if (pos === null) return null;
		const tokenFilter = revalidateFilter(decoded.filter);
		if (tokenFilter === null) return null;
		const limit = clampLimit(decoded.limit, askedLimit);
		// PRESENCE, not value: a caller that named no axis claims nothing, so a
		// cursor-alone request is never compared against the filter its token
		// carries. `lowStockThreshold: 0` is a real threshold and participates.
		if (hasFilterAxes(asked) && canonicalFilter(asked) !== canonicalFilter(tokenFilter))
			return null;
		if (askedLimitRaw !== undefined && askedLimitRaw !== limit) return null;
		return { filter: tokenFilter, pos, limit };
	}

	/** The page and its EXACT count, under ONE filter, in parallel — sharing the
	 *  filter is what lets the count describe the page it captions. */
	async #page(
		filter: ProductListFilter,
		pos: ProductListCursor | null,
		limit: number,
	): Promise<ProductsListResult> {
		const [result, total] = await Promise.all([
			this.#stores.productCommerce.listProducts(filter, { cursor: pos, limit }),
			this.#stores.productCommerce.countProducts(filter),
		]);
		return {
			products: result.products.map(toProductSummaryWire),
			nextCursor:
				result.nextCursor === null ? null : encodeProductCursor(result.nextCursor, filter, limit),
			total,
		};
	}

	/**
	 * The shared front half of both stock movements, in the route's own order:
	 * path parameter, then body, then the required idempotency key, then the
	 * product's AUTHORITATIVE sku — never a client-supplied one.
	 *
	 * A missing or soft-deleted product is `not_found`; a skuless "create then
	 * price" product is `no_sku`; every bound failure is `invalid`, which is what
	 * the other transport's 400s map to.
	 */
	async #resolveStockMovement(
		productId: string,
		qty: number,
		key: string,
	): Promise<{ status: "ok"; sku: string } | { status: "not_found" | "no_sku" | "invalid" }> {
		try {
			requireIdToken("productId", productId);
			requireStockMovementQty(qty);
			if (key.length === 0) throw new CommerceInputError("idempotencyKey", "must not be empty");
		} catch (err) {
			if (isCommerceInputError(err)) return { status: "invalid" };
			throw err;
		}
		const product = await this.#stores.productCommerce.getByProductId(toProductId(productId));
		if (product === null || product.deletedAt !== null) return { status: "not_found" };
		if (product.sku === null) return { status: "no_sku" };
		return { status: "ok", sku: product.sku };
	}
}

// ── the wire projections, field for field ─────────────────────────────────

/** `serializeProductSummary`'s twin. `onHand` is passed through UNCOERCED: `null`
 *  ("no inventory row" — unknown) must reach the caller AS null, distinct from
 *  `0` ("out of stock"). */
function toProductSummaryWire(summary: ProductSummary): ProductSummaryWire {
	return {
		productId: summary.productId,
		sku: summary.sku,
		title: summary.title,
		priceCents: summary.price?.amount ?? null,
		currency: summary.price?.currency ?? null,
		productKind: summary.productKind,
		active: summary.active,
		onHand: summary.onHand,
		deletedAt: summary.deletedAt,
		createdAt: summary.createdAt,
	};
}

/** `serializeProductDetail`'s twin — the FULL row plus the single-sku stock read.
 *  `unitCost` is admin-only margin data and is carried HERE and only here. */
function toProductDetailWire(
	product: DomainProductCommerce,
	onHand: number | null,
): ProductDetailWire {
	return {
		productId: product.productId,
		sku: product.sku,
		title: product.title,
		priceCents: product.price?.amount ?? null,
		currency: product.price?.currency ?? null,
		taxClass: product.taxClass,
		compareAtCents: product.compareAtPrice?.amount ?? null,
		compareAtCurrency: product.compareAtPrice?.currency ?? null,
		unitCostCents: product.unitCost?.amount ?? null,
		unitCostCurrency: product.unitCost?.currency ?? null,
		inventoryPolicy: product.inventoryPolicy,
		weightGrams: product.weightGrams,
		lengthMm: product.lengthMm,
		widthMm: product.widthMm,
		heightMm: product.heightMm,
		productKind: product.productKind,
		active: product.active,
		deletedAt: product.deletedAt === null ? null : product.deletedAt.toISOString(),
		onHand,
		createdAt: product.createdAt.toISOString(),
		updatedAt: product.updatedAt.toISOString(),
	};
}

// ── the input bounds the request schemas used to hold ─────────────────────

/**
 * The caller's filter as a domain `ProductListFilter`.
 *
 * AN EMPTY STRING IS AN ABSENT AXIS, not an empty one — the HTTP client omits a
 * zero-length `search`/`productKind` from its query string entirely, so honouring
 * one here would filter on a value the other transport never sends.
 */
function toDomainFilter(filter: ProductsListFilter): ProductListFilter {
	const out: ProductListFilter = {};
	if (filter.active !== undefined) out.active = filter.active;
	if (filter.deleted !== undefined) out.deleted = filter.deleted;
	if (filter.productKind !== undefined && filter.productKind.length > 0) {
		out.productKind = requireProductKind(filter.productKind);
	}
	if (filter.search !== undefined && filter.search.length > 0) {
		out.search = requireBoundedText("search", filter.search, 1, 200);
	}
	if (filter.lowStockThreshold !== undefined) {
		out.lowStockThreshold = requireLowStockThreshold(filter.lowStockThreshold);
	}
	return out;
}

function requireProductKind(value: string): "physical" | "digital" {
	if (value !== "physical" && value !== "digital") {
		throw new CommerceInputError("productKind", 'must be "physical" or "digital"');
	}
	return value;
}

/** The threshold's domain: a non-negative integer no greater than the port's own
 *  ceiling, so nothing outside it reaches the store (which would otherwise throw
 *  `InvalidLowStockThresholdError`). `0` is a real threshold, never "absent". */
function requireLowStockThreshold(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LOW_STOCK_THRESHOLD) {
		throw new CommerceInputError("lowStockThreshold", "must be a non-negative integer in range");
	}
	return value;
}

/** The page size the caller asked for, bounded as the query schema bounded it.
 *  Absent ⇒ the schema's own default. */
function requireLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new CommerceInputError("limit", `must be an integer between 1 and ${String(MAX_LIMIT)}`);
	}
	return limit;
}

function requireStockMovementQty(qty: number): number {
	if (!Number.isSafeInteger(qty) || qty <= 0 || qty > MAX_STOCK_MOVEMENT_QTY) {
		throw new CommerceInputError("qty", "must be a positive integer within the movement cap");
	}
	return qty;
}

/**
 * Every key `editProductCommerceBody` declares, written out so an unknown one is
 * a refusal rather than a silent drop.
 *
 * `.strict()` IS BEHAVIOUR, not framing. The other transport's body schema is
 * strict and answers an unrecognised key with a 400 that this surface turns into
 * `{ ok: false, reason: "invalid" }`; dropping it here instead would report a
 * save that did not happen as a success. `title` is the instance that matters —
 * it is CMS-owned (ADR-0013) and the port has no field for it, so a caller that
 * sends one must be told, not quietly obeyed in part. Only an UNTYPED caller can
 * get here; `ProductEditWire` stops a typed one at the compiler.
 */
const PRODUCT_EDIT_KEYS = [
	"expectedUpdatedAt",
	"sku",
	"price",
	"taxClass",
	"compareAtPrice",
	"unitCost",
	"weightGrams",
	"lengthMm",
	"widthMm",
	"heightMm",
	"productKind",
	"inventoryPolicy",
] as const satisfies readonly (keyof ProductEditWire)[];

/** `editProductCommerceBody`'s bounds, then the branding the use-case takes.
 *  Money is an integer minor amount carrying an explicit ISO-4217 currency —
 *  never a bare number and never a float. */
function toUpdateInput(productId: string, body: ProductEditWire): UpdateProductCommerceFieldsInput {
	const input: UpdateProductCommerceFieldsInput = { productId: toProductId(productId) };
	for (const key of Object.keys(body)) {
		if (!PRODUCT_EDIT_KEYS.includes(key as (typeof PRODUCT_EDIT_KEYS)[number])) {
			throw new CommerceInputError(key, "is not a field this edit accepts");
		}
	}
	if (body.sku !== undefined) {
		// `min(1)` and no ceiling, as the edit body's schema has it — the sku's real
		// bounds belong to the store's column, not to this boundary.
		if (body.sku.length === 0) throw new CommerceInputError("sku", "must not be empty");
		input.sku = toSku(body.sku);
	}
	if (body.price !== undefined) {
		const price = requireMoney("price", body.price, { positive: true });
		input.price = toMoney(toCents(price.amount), toCurrency(price.currency));
	}
	// No `title`: it is CMS-owned and the other transport's `.strict()` body
	// rejects one outright (ADR-0013). The port has no field for it either.
	if (body.taxClass !== undefined) input.taxClass = body.taxClass;
	if (body.compareAtPrice !== undefined) {
		input.compareAtPrice = toNullableMoney("compareAtPrice", body.compareAtPrice);
	}
	if (body.unitCost !== undefined) {
		input.unitCost = toNullableMoney("unitCost", body.unitCost);
	}
	if (body.weightGrams !== undefined) {
		input.weightGrams = requireNonNegativeOrNull("weightGrams", body.weightGrams);
	}
	if (body.lengthMm !== undefined) {
		input.lengthMm = requireNonNegativeOrNull("lengthMm", body.lengthMm);
	}
	if (body.widthMm !== undefined) {
		input.widthMm = requireNonNegativeOrNull("widthMm", body.widthMm);
	}
	if (body.heightMm !== undefined) {
		input.heightMm = requireNonNegativeOrNull("heightMm", body.heightMm);
	}
	if (body.productKind !== undefined) input.productKind = requireProductKind(body.productKind);
	if (body.inventoryPolicy !== undefined) {
		if (body.inventoryPolicy !== "deny") {
			// The one-value enum is the boundary that keeps an `allow_backorder` from
			// ever reaching the no-oversell reserve path.
			throw new CommerceInputError("inventoryPolicy", 'must be "deny"');
		}
		input.inventoryPolicy = "deny";
	}
	return input;
}

/** Compare-at and cost are NON-NEGATIVE money (unlike `price`: a cleared-to-zero
 *  compare-at is meaningful) and an explicit null CLEARS. */
function toNullableMoney(
	field: string,
	value: { amount: number; currency: string } | null,
): ReturnType<typeof toMoney> | null {
	if (value === null) return null;
	const checked = requireMoney(field, value);
	return toMoney(toCents(checked.amount), toCurrency(checked.currency));
}

function requireNonNegativeOrNull(field: string, value: number | null): number | null {
	const checked = requireNullableInteger(field, value);
	if (checked !== null && checked < 0) {
		throw new CommerceInputError(field, "must be a non-negative integer");
	}
	return checked;
}

// ── the opaque cursor, ported from the route ──────────────────────────────

interface DecodedCursor {
	pos: unknown;
	filter: unknown;
	limit: unknown;
}

/** Encode the keyset position + the ACTIVE filter + the clamped limit, so paging
 *  preserves both. */
function encodeProductCursor(
	pos: ProductListCursor,
	filter: ProductListFilter,
	limit: number,
): string {
	const payload = { pos: { createdAt: pos.createdAt, productId: pos.productId }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode a token; `null` on ANY malformed/tampered/garbage input, so a bad token
 *  is a refusal rather than a throw. */
function decodeProductCursor(token: string): DecodedCursor | null {
	try {
		const json = new TextDecoder().decode(fromBase64Url(token));
		const parsed = JSON.parse(json) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const p = parsed as DecodedCursor;
		return { pos: p.pos, filter: p.filter, limit: p.limit };
	} catch {
		return null;
	}
}

/**
 * Exactly what `z.string().datetime()` accepts — the validator the service's own
 * cursor schema put in front of this field: an RFC-3339 instant in UTC, optional
 * fractional seconds, a literal `Z` and no numeric offset.
 *
 * MIRRORED RATHER THAN APPROXIMATED, because the value is compared
 * LEXICOGRAPHICALLY by the store's keyset predicate. `Date.parse` alone accepts
 * `"Jan 5, 2026"` and `"2026-01-01"` — real instants, neither of them
 * `toISOString()`-shaped — and a tampered token carrying one would be refused on
 * the wire but sorted as raw text here, paging from somewhere the operator never
 * asked for. A divergence in the fail-OPEN direction is the one kind this
 * boundary must not have.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** `Date.toISOString()`-comparable: the position's `createdAt` must be a real
 *  instant IN THAT SPELLING, never a raw string that reaches the store's keyset
 *  comparison. The regex pins the spelling; `Date.parse` rejects the shapes that
 *  match it and name no real day (`2026-02-31`). */
function productCursorPosOf(pos: unknown): ProductListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; productId?: unknown };
	if (typeof p.createdAt !== "string" || !ISO_INSTANT.test(p.createdAt)) return null;
	if (Number.isNaN(Date.parse(p.createdAt))) return null;
	if (typeof p.productId !== "string" || p.productId.length === 0 || p.productId.length > 200) {
		return null;
	}
	return { createdAt: p.createdAt, productId: toProductId(p.productId) };
}

/**
 * RE-VALIDATE the decoded filter before trusting it — the token is
 * operator-round-tripped input like any other. `null` ⇒ refuse.
 *
 * AN UNKNOWN AXIS IS A REFUSAL HERE, AND A STRIP ON THE WIRE — a divergence,
 * recorded rather than smoothed over, because the two directions are not equally
 * safe. The service's `productListFilterSchema` is non-strict, so a token
 * carrying an axis it does not know silently loses it and the page comes back
 * under a predicate that is not the one the token claimed. Refusing costs a
 * `cursorRejected` page one — visible, flagged, recoverable, and the same answer
 * any other undecodable token gets. Matching the wire would mean deliberately
 * widening this side to answer a tampered token with a mis-captioned page, which
 * is the failure the disagreement check below exists to prevent. So this side
 * stays narrower ON PURPOSE. The only way to reach it at all is a hand-made or
 * edited token; every token this client mints carries exactly these axes.
 */
function revalidateFilter(filter: unknown): ProductListFilter | null {
	if (filter === null || typeof filter !== "object") return null;
	const f = filter as Record<string, unknown>;
	const out: ProductListFilter = {};
	for (const key of Object.keys(f)) {
		if (!PRODUCT_FILTER_AXES.includes(key as (typeof PRODUCT_FILTER_AXES)[number])) return null;
	}
	if (f["active"] !== undefined) {
		if (typeof f["active"] !== "boolean") return null;
		out.active = f["active"];
	}
	if (f["deleted"] !== undefined) {
		if (typeof f["deleted"] !== "boolean") return null;
		out.deleted = f["deleted"];
	}
	if (f["productKind"] !== undefined) {
		if (f["productKind"] !== "physical" && f["productKind"] !== "digital") return null;
		out.productKind = f["productKind"];
	}
	if (f["search"] !== undefined) {
		const search = f["search"];
		if (typeof search !== "string" || search.length === 0 || search.length > 200) return null;
		out.search = search;
	}
	if (f["lowStockThreshold"] !== undefined) {
		const threshold = f["lowStockThreshold"];
		if (
			typeof threshold !== "number" ||
			!Number.isSafeInteger(threshold) ||
			threshold < 0 ||
			threshold > MAX_LOW_STOCK_THRESHOLD
		) {
			return null;
		}
		out.lowStockThreshold = threshold;
	}
	return out;
}

/** Every FILTER axis — written out so that adding one without teaching the
 *  presence check about it is a compile error, not a silently unguarded axis a
 *  cursor request could then contradict for free. */
const PRODUCT_FILTER_AXES = [
	"active",
	"deleted",
	"productKind",
	"search",
	"lowStockThreshold",
] as const satisfies readonly (keyof ProductListFilter)[];

/** Did the caller SPELL OUT any filter axis? Presence, not value. */
function hasFilterAxes(filter: ProductListFilter): boolean {
	return PRODUCT_FILTER_AXES.some((axis) => filter[axis] !== undefined);
}

/**
 * A filter rendered so two filters compare as PREDICATES rather than as JSON
 * text: key order is irrelevant, an absent axis and an `undefined` one are the
 * same thing, and an axis whose value is indistinguishable from omitting it is
 * dropped.
 *
 * `deleted: false` IS such an axis — the store's tombstone predicate is
 * `deleted_at IS NULL` for every value except `true` — while `active: false` is
 * NOT, because the store emits a real `active = false` for it. The asymmetry is
 * the store's, not a tidying opportunity. Case is deliberately not folded.
 */
function canonicalFilter(filter: ProductListFilter): string {
	const entries = (Object.entries(filter) as [string, unknown][])
		.filter(([key, value]) => value !== undefined && !(key === "deleted" && value === false))
		.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(entries);
}

/** Clamp a decoded limit into [1, 100] — a token's limit is RE-CLAMPED, never
 *  honoured past the max. Falls back to the caller's own bounded limit. */
function clampLimit(decoded: unknown, askedLimit: number): number {
	const raw = typeof decoded === "number" && Number.isFinite(decoded) ? decoded : askedLimit;
	return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

// Portable base64url (Node + workerd both provide btoa/atob + TextEncoder).
function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64); // throws on invalid base64 ⇒ caught by decodeProductCursor
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
