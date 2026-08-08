import {
	type AddressStore,
	appendOrderNote,
	cancelOrder,
	type Clock,
	computeRefundCeiling,
	type CustomerStore,
	getOrderCustomerContext,
	getOrderTimeline,
	idempotencyKey as toIdempotencyKey,
	InvalidLowStockThresholdError,
	type InventoryStore,
	InvalidProductFieldError,
	legalNextStates,
	listOrderNotes,
	type OrderCustomerContext,
	type OrderTimeline,
	type OrderListCursor,
	type OrderListFilter,
	orderId as toOrderId,
	type OrderNote,
	type OrderNotesStore,
	type OrderState,
	type OrderStore,
	type PaymentEventStore,
	type PaymentGateway,
	type PaymentMethod,
	type ProductCommerce,
	type ProductCommerceStore,
	productId as toProductId,
	type ProductListCursor,
	type ProductListFilter,
	type ProductSummary,
	recordFulfillment,
	type RefundOrderFailure,
	type RefundRecord,
	refundOrder,
	removeStock,
	resolveReconciliation,
	restock,
	type SessionStore,
	SkuConflictError,
	sumCapturedPayments,
	sumRefunds,
	transitionOrder,
	updateProductCommerceFields,
	sku as toSku,
	money as toMoney,
	cents as toCents,
	currency as toCurrency,
} from "@otta-sh/domain";
import { Hono } from "hono";
import { z } from "zod";
import {
	appendNoteBody,
	cancelOrderBody,
	editProductCommerceBody,
	orderListFilterSchema,
	orderPathParams,
	ordersListQuery,
	orderStateEnum,
	productListFilterSchema,
	productPathParams,
	productsListQuery,
	recordFulfillmentBody,
	refundOrderBody,
	resolveReconciliationBody,
	stockMovementBody,
	transitionBody,
} from "../schemas.js";
import { serializeOrder, serializeOrderSummary } from "./orders.js";
import { requireInternalToken } from "./internal-auth.js";

export interface AdminRoutesDeps {
	orderStore: OrderStore;
	/** Append-only order notes (admin-UX Increment 0). */
	orderNotesStore: OrderNotesStore;
	// Customer context on the order detail (admin-UX Increment 1) — read-only.
	customerStore: CustomerStore;
	addressStore: AddressStore;
	sessionStore: SessionStore;
	// Admin Products console (admin-UX Increment 2) — view-only enumerate + detail.
	productCommerce: ProductCommerceStore;
	/** The detail leaf's single-sku stock read (`getOnHand`) — never used by the
	 *  list, which must not N+1 into inventory per row (port doc). Also the
	 *  commerce EDIT's create-if-absent inventory seed (PR 1a): an edit that
	 *  leaves the product with a sku must leave it with an inventory row, or the
	 *  restock endpoint below 409s NO_INVENTORY_ROW forever. */
	inventoryStore: InventoryStore;
	/** Payment gateways keyed by method (ADR-0008) — the refund endpoint selects
	 *  the order's gateway to issue (Stripe) or record-only (x402/no-secret). The
	 *  gateway's `refundable` flag drives the admin capability display. */
	gateways: Partial<Record<PaymentMethod, PaymentGateway>>;
	/** The loud-anomaly seam for the impossible-by-construction "gateway refund
	 *  issued but its reserved ledger row could not be finalized" residual
	 *  (ADR-0008, REFUND_UNRECORDED — the PAID_FLIP_LOST precedent). Wired so that
	 *  residual records an anomaly carrying the provider refundRef; the refund flow
	 *  also flags the order for reconciliation. */
	paymentEventStore?: PaymentEventStore;
	/** Timestamp source for the anomaly record (paired with `paymentEventStore`). */
	clock?: Clock;
	/** Reuses the existing service privileged auth (X-Internal-Token). Phase 5
	 *  introduces no separate admin identity (Risk 7): the internal token is the
	 *  service's privileged mechanism; a real admin panel calls this with it. */
	internalToken?: string;
}

/**
 * Admin order-status transition (Phase 5 §7). The only customer-facing surface
 * that can move an order is NONE — this endpoint requires the privileged
 * (internal-token) auth. Legality is enforced in the domain (`transitionOrder`);
 * a transition that also has a template enqueues exactly one email atomically
 * with the flip (§5), drained by the dispatcher.
 */
export function adminRoutes(deps: AdminRoutesDeps): Hono {
	const app = new Hono();

	// Every handler below carries its own `requireInternalToken` call. Those stay
	// as defense-in-depth, but they are no longer the fail-safe: the parent-level
	// `app.use("/admin/*")` in `createApp` (ADR-0010) closes this whole prefix, so
	// a route added here without an inline call is denied rather than silently
	// public.

	// -- Admin Orders console: view-only list + detail (internal-token guarded) --

	app.get("/orders", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const parsed = ordersListQuery.safeParse(c.req.query());
		if (!parsed.success)
			return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
		const q = parsed.data;

		let filter: OrderListFilter;
		let limit: number;
		let cursorPos: OrderListCursor | null;

		if (q.cursor !== undefined) {
			// Paged request: the opaque cursor carries the keyset POSITION plus the
			// active filter (so filters survive paging) plus the page limit. Decoding
			// MUST fail CLOSED to a 400 — a malformed/tampered/garbage token never
			// 500s (MOD-1). The decoded filter is RE-VALIDATED through zod and the
			// decoded limit RE-CLAMPED server-side (never trusted past max=100).
			const decoded = decodeCursor(q.cursor);
			if (decoded === null) return c.json({ error: "invalid cursor" }, 400);
			const filterParsed = orderListFilterSchema.safeParse(decoded.filter);
			const posParsed = cursorPosOf(decoded.pos);
			if (!filterParsed.success || posParsed === null) {
				return c.json({ error: "invalid cursor" }, 400);
			}
			filter = toFilter(filterParsed.data);
			cursorPos = posParsed;
			limit = clampLimit(decoded.limit, q.limit);
		} else {
			// First page: build the filter from the query string (CSV states →
			// per-token validated enum array), validate the assembled filter, and take
			// the already-clamped query limit.
			const built = buildFilterFromQuery(q.states, q.from, q.to, q.search);
			if (built === null) return c.json({ error: "invalid states filter" }, 400);
			filter = built;
			cursorPos = null;
			limit = q.limit;
		}

		// The page and its EXACT count, under one filter, in parallel (INC-23).
		// `total` is the count of the whole filtered set — not of this page — so a
		// console can caption "17 orders" on page 2 of 3 instead of the
		// page-scoped hedge keyset paging otherwise forces (there is no running
		// offset to derive one from, and a renderer must never invent one).
		const [result, total] = await Promise.all([
			deps.orderStore.listOrders(filter, { cursor: cursorPos, limit }),
			deps.orderStore.countOrders(filter),
		]);
		const nextCursor =
			result.nextCursor === null ? null : encodeCursor(result.nextCursor, filter, limit);
		return c.json(
			{ ok: true, orders: result.orders.map(serializeOrderSummary), nextCursor, total },
			200,
		);
	});

	app.get("/orders/:orderId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const order = await deps.orderStore.getById(toOrderId(params.data.orderId));
		if (order === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		// The transition buttons the console renders come straight from the domain
		// state machine — the single source of truth (never a UI-side re-listing).
		return c.json(
			{
				ok: true,
				order: serializeOrder(order),
				allowedTransitions: [...legalNextStates(order.state)],
			},
			200,
		);
	});

	// -- Admin Products console: view-only list + detail (admin-UX Increment 2) --
	// Mirrors the Orders console's shape 1:1 (internal-token guarded reads, the
	// same opaque-cursor-carries-filter-and-limit encoding, MOD-1 fail-closed
	// decode). The list carries per-row stock via the store's SINGLE LEFT JOIN —
	// one statement per page, never an N+1 into stock per row (port doc) — where
	// `onHand: null` means "no inventory row" (unknown), NOT zero. The detail
	// leaf still reads the ONE opened product's stock via `InventoryStore.
	// getOnHand`.

	app.get("/products", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const parsed = productsListQuery.safeParse(c.req.query());
		if (!parsed.success)
			return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
		const q = parsed.data;

		let filter: ProductListFilter;
		let limit: number;
		let cursorPos: ProductListCursor | null;

		if (q.cursor !== undefined) {
			// Paged request: the opaque cursor carries the keyset POSITION plus the
			// active filter (so filters survive paging) plus the page limit. Decoding
			// MUST fail CLOSED to a 400 — a malformed/tampered/garbage token never
			// 500s (MOD-1, mirrors the Orders list). The decoded filter is
			// RE-VALIDATED through zod and the decoded limit RE-CLAMPED server-side
			// (never trusted past max=100).
			const decoded = decodeProductCursor(q.cursor);
			if (decoded === null) return c.json({ error: "invalid cursor" }, 400);
			const filterParsed = productListFilterSchema.safeParse(decoded.filter);
			const posParsed = productCursorPosOf(decoded.pos);
			if (!filterParsed.success || posParsed === null) {
				return c.json({ error: "invalid cursor" }, 400);
			}
			filter = toProductFilter(filterParsed.data);
			cursorPos = posParsed;
			limit = clampLimit(decoded.limit, q.limit);
		} else {
			filter = toProductFilter({
				active: q.active === undefined ? undefined : q.active === "true",
				deleted: q.deleted === undefined ? undefined : q.deleted === "true",
				productKind: q.productKind,
				search: q.search,
				lowStockThreshold: q.lowStockThreshold,
			});
			cursorPos = null;
			limit = q.limit;
		}

		try {
			// The page and its EXACT count, under one filter, in parallel (INC-23) —
			// the same shape as the Orders list above; see its note. Sharing the
			// filter is what lets the count describe the low-stock-filtered page
			// once `filter.lowStockThreshold` is set (port doc).
			const [result, total] = await Promise.all([
				deps.productCommerce.listProducts(filter, { cursor: cursorPos, limit }),
				deps.productCommerce.countProducts(filter),
			]);
			const nextCursor =
				result.nextCursor === null ? null : encodeProductCursor(result.nextCursor, filter, limit);
			return c.json(
				{ ok: true, products: result.products.map(serializeProductSummary), nextCursor, total },
				200,
			);
		} catch (err) {
			// Defense-in-depth (port doc): both zod layers above already constrain
			// `lowStockThreshold` to a non-negative integer, so this is normally
			// unreachable — but an unmapped throw here would 500 a bad query
			// instead of 400ing it, exactly the asymmetry the port doc calls out.
			if (err instanceof InvalidLowStockThresholdError) {
				return c.json({ error: "invalid query", issues: [{ message: err.message }] }, 400);
			}
			throw err;
		}
	});

	app.get("/products/:productId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = productPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const product = await deps.productCommerce.getByProductId(toProductId(params.data.productId));
		if (product === null) {
			// UNKNOWN id — genuinely never existed. Distinct from a soft-deleted
			// row (see below): the two used to read identically as 404, which hid
			// the tombstone from the admin (product lifecycle surfacing, port doc).
			return c.json({ ok: false, reason: "PRODUCT_NOT_FOUND" }, 404);
		}
		// A single-sku read — never a per-row list join (port doc) — through
		// `findOnHand`, which keeps "no inventory row" (`null`, unknown) apart from
		// `0` ("out of stock") exactly as the LIST does. Both halves used to
		// collapse to `0` here (`?? 0` inside `getOnHand`, plus a `sku === null ? 0`
		// on this line), so one product could read `—` in the list and `0` on its
		// own detail page, one click apart — and a detail view is the screen with
		// the most context, so it is the last place that should be the one guessing.
		// A skuless "create then price" row has nothing to look up at all: `null`,
		// never a zero nobody counted.
		//
		// A soft-deleted row still resolves here (200, `deletedAt` non-null) — the
		// detail is the HONEST read-only tombstone view, not a 404 masquerading as
		// "never existed" (product lifecycle surfacing). Its `onHand` is read for
		// informational value only; the write routes below (PATCH/restock/
		// remove-stock) remain blocked for a deleted row via their OWN not_found
		// guards (`updateCommerceFields`'s guard order / `resolveProductSku`) —
		// this GET is visibility only, never a path back to editability.
		const onHand = product.sku === null ? null : await deps.inventoryStore.findOnHand(product.sku);
		return c.json({ ok: true, product: serializeProductDetail(product, onHand) }, 200);
	});

	// -- Admin Products console: guarded commerce EDIT (admin-UX Increment 2) -----
	// The standalone product edit page's write (slice 2). A NON-GET, so the
	// app-level X-Service-Token write gate covers it when the service secret is
	// set; the route additionally requires the internal token (same double-gate as
	// the order-transition write). Edits only the commerce-owned fields — never the
	// CMS publish gate (`active`) or the sync watermark. Optimistic-concurrency:
	// `expectedUpdatedAt` compare-and-set → a concurrent edit is a structured 409
	// STALE_EDIT the panel reloads on, never a silent last-writer-wins clobber.
	app.patch("/products/:productId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = productPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = editProductCommerceBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const body = parsed.data;

		// A retry/double-submit dedupes when the client sends a stable
		// Idempotency-Key; absent one, a deterministic fallback keyed by the target
		// + the expected watermark keeps replays of THIS edit idempotent (a genuine
		// second edit carries a fresher watermark ⇒ a distinct fallback key).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:product-edit:${params.data.productId}:${body.expectedUpdatedAt}`;

		try {
			const res = await updateProductCommerceFields(
				{ productCommerce: deps.productCommerce, inventory: deps.inventoryStore },
				{
					productId: toProductId(params.data.productId),
					...(body.sku !== undefined ? { sku: toSku(body.sku) } : {}),
					...(body.price !== undefined
						? { price: toMoney(toCents(body.price.amount), toCurrency(body.price.currency)) }
						: {}),
					// No `title`: it is CMS-owned and the schema `.strict()`-rejects one
					// (ADR-0013). The sync writes it via PUT /products/:id/commerce.
					...(body.taxClass !== undefined ? { taxClass: body.taxClass } : {}),
					...(body.compareAtPrice !== undefined
						? {
								compareAtPrice:
									body.compareAtPrice === null
										? null
										: toMoney(
												toCents(body.compareAtPrice.amount),
												toCurrency(body.compareAtPrice.currency),
											),
							}
						: {}),
					...(body.unitCost !== undefined
						? {
								unitCost:
									body.unitCost === null
										? null
										: toMoney(toCents(body.unitCost.amount), toCurrency(body.unitCost.currency)),
							}
						: {}),
					...(body.inventoryPolicy !== undefined ? { inventoryPolicy: body.inventoryPolicy } : {}),
					...(body.weightGrams !== undefined ? { weightGrams: body.weightGrams } : {}),
					...(body.lengthMm !== undefined ? { lengthMm: body.lengthMm } : {}),
					...(body.widthMm !== undefined ? { widthMm: body.widthMm } : {}),
					...(body.heightMm !== undefined ? { heightMm: body.heightMm } : {}),
					...(body.productKind !== undefined ? { productKind: body.productKind } : {}),
				},
				toIdempotencyKey(key),
				body.expectedUpdatedAt,
			);
			if (res.ok) {
				return c.json({ ok: true, updatedAt: res.product.updatedAt.toISOString() }, 200);
			}
			if (res.reason === "not_found") {
				return c.json({ ok: false, reason: "PRODUCT_NOT_FOUND" }, 404);
			}
			if (res.reason === "stale") {
				// The panel reloads the fresh detail; hand back the current watermark so
				// a re-save can compare-and-set against it.
				return c.json(
					{
						ok: false,
						reason: "STALE_EDIT",
						currentUpdatedAt: res.current.updatedAt.toISOString(),
					},
					409,
				);
			}
			// currency_mismatch
			return c.json(
				{
					ok: false,
					reason: "CURRENCY_MISMATCH",
					currency: res.current.price?.currency ?? null,
				},
				409,
			);
		} catch (err) {
			if (err instanceof InvalidProductFieldError) {
				return c.json({ ok: false, reason: "INVALID_FIELD", field: err.field }, 400);
			}
			if (err instanceof SkuConflictError) {
				return c.json({ ok: false, reason: "SKU_TAKEN", sku: err.sku }, 409);
			}
			throw err;
		}
	});

	// -- Admin Products console: merchant restock / stock removal (Increment 2) --
	// The invariant-critical stock-movement writes. NON-GETs (app-level
	// X-Service-Token write gate covers them when the secret is set) that ALSO
	// require the internal token — the same double-gate as the product edit. Each
	// resolves the productId to its AUTHORITATIVE sku (never trusting a
	// client-supplied one) and mirrors the port 1:1: restock is a commutative
	// oversell-safe increment; remove-stock is a guarded decrement that can never
	// drive on-hand below 0. Because a restock is ADDITIVE (not idempotent by
	// nature like a state flip), the `Idempotency-Key` header is REQUIRED — there
	// is no safe content-only fallback (two deliberate "+5" restocks must NOT
	// collapse), so the plugin sends a stable per-submission key.

	app.post("/products/:productId/restock", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = productPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = stockMovementBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ ok: false, reason: "MISSING_IDEMPOTENCY_KEY" }, 400);
		}

		const skuResolved = await resolveProductSku(deps, params.data.productId);
		if (skuResolved.status === "not_found") {
			return c.json({ ok: false, reason: "PRODUCT_NOT_FOUND" }, 404);
		}
		if (skuResolved.status === "no_sku") return c.json({ ok: false, reason: "NO_SKU" }, 409);

		const res = await restock(
			deps.inventoryStore,
			toSku(skuResolved.sku),
			parsed.data.qty,
			toIdempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true, onHand: res.onHand }, 200);
		// UNKNOWN_SKU: the product exists but has no inventory row yet (priced but
		// never seeded). A stock movement cannot create one — 409, like a
		// conflict-with-current-state.
		return c.json({ ok: false, reason: "NO_INVENTORY_ROW" }, 409);
	});

	app.post("/products/:productId/remove-stock", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = productPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = stockMovementBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ ok: false, reason: "MISSING_IDEMPOTENCY_KEY" }, 400);
		}

		const skuResolved = await resolveProductSku(deps, params.data.productId);
		if (skuResolved.status === "not_found") {
			return c.json({ ok: false, reason: "PRODUCT_NOT_FOUND" }, 404);
		}
		if (skuResolved.status === "no_sku") return c.json({ ok: false, reason: "NO_SKU" }, 409);

		const res = await removeStock(
			deps.inventoryStore,
			toSku(skuResolved.sku),
			parsed.data.qty,
			toIdempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true, onHand: res.onHand }, 200);
		if (res.reason === "INSUFFICIENT_STOCK") {
			// Cannot remove more than is on hand — 409 with the current count so the
			// panel can show it. Guarded in the domain (never drives on_hand < 0).
			return c.json({ ok: false, reason: "INSUFFICIENT_STOCK", onHand: res.onHand }, 409);
		}
		return c.json({ ok: false, reason: "NO_INVENTORY_ROW" }, 409); // UNKNOWN_SKU
	});

	// -- Admin Orders console: customer context (admin-UX Increment 1) -----------
	// Read-only, internal-token guarded like the other admin GETs; mirrors the
	// `getOrderCustomerContext` use-case 1:1. The response aggregates PII (email,
	// address book, session metadata) — it is NEVER logged; failures reach the
	// app-level onError which logs only the thrown error, not this body.
	app.get("/orders/:orderId/customer-context", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const context = await getOrderCustomerContext(
			{
				orderStore: deps.orderStore,
				customerStore: deps.customerStore,
				addressStore: deps.addressStore,
				sessionStore: deps.sessionStore,
			},
			toOrderId(params.data.orderId),
		);
		if (context === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		return c.json({ ok: true, context: serializeCustomerContext(context) }, 200);
	});

	// -- Admin Orders console: order timeline / audit (admin-UX Increment 1) -----
	// Read-only, internal-token guarded like the other admin GETs; mirrors the
	// `getOrderTimeline` use-case 1:1. Merges the durably-audited state-change
	// events with the order's derived artifacts (creation, notes, fulfillment,
	// cancellation, reconciliation resolution) into ONE chronological view. It
	// surfaces no money and no PII beyond what the order detail + notes already
	// show; `stateChangesAudited` flags a historical order whose transitions
	// predate the audit table (a partial timeline).
	app.get("/orders/:orderId/timeline", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const timeline = await getOrderTimeline(
			{ orderStore: deps.orderStore, orderNotesStore: deps.orderNotesStore },
			toOrderId(params.data.orderId),
		);
		if (timeline === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		return c.json({ ok: true, timeline: serializeTimeline(timeline) }, 200);
	});

	app.post("/orders/:orderId/transition", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = transitionBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:transition:${params.data.orderId}:${parsed.data.toState}`;
		const res = await transitionOrder(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				toState: parsed.data.toState,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json(
				{ ok: true, transitioned: res.transitioned, order: serializeOrder(res.order) },
				200,
			);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		return c.json({ ok: false, reason: res.reason }, 409); // INVALID_TRANSITION
	});

	// -- Admin Orders console: resolve a reconciliation flag (admin-UX Increment 1)
	// A NON-GET, so the app-level X-Service-Token write gate covers it when the
	// service secret is set; the route additionally requires the internal token.
	// Mirrors the port 1:1 — clears the flag + records the disposition, never
	// touching state/line items (the snapshot invariant lives in the domain).
	app.post("/orders/:orderId/resolve-reconciliation", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = resolveReconciliationBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// Idempotency (CLAUDE.md): the client `Idempotency-Key` header, or a stable
		// fallback derived from the order id (a header-less double-submit dedupes on
		// the guarded flip, not a fresh key each time).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:resolve-reconciliation:${params.data.orderId}`;
		const res = await resolveReconciliation(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				expectedFlag: parsed.data.expectedFlag,
				outcome: parsed.data.outcome,
				reason: parsed.data.reason,
				resolvedBy: parsed.data.resolvedBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json({ ok: true, resolved: res.resolved, order: serializeOrder(res.order) }, 200);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		// Reconciliation-axis conflicts (like an INVALID_TRANSITION) → 409:
		// NOT_IN_RECONCILIATION (never flagged) and RECONCILIATION_FLAG_CHANGED
		// (the live flag differs from the one the admin reviewed — reload and
		// re-review). The trimmed-empty guards → 400.
		if (res.reason === "NOT_IN_RECONCILIATION" || res.reason === "RECONCILIATION_FLAG_CHANGED")
			return c.json({ ok: false, reason: res.reason }, 409);
		return c.json({ ok: false, reason: res.reason }, 400); // EMPTY_REASON / EMPTY_RESOLVER
	});

	// -- Admin Orders console: record shipping fulfillment (admin-UX Increment 1) -
	// A NON-GET, so the app-level X-Service-Token write gate covers it when the
	// service secret is set; the route additionally requires the internal token.
	// Mirrors the port 1:1 — recording fulfillment ships the order
	// (`processing → shipped`) and enqueues the shipped email (now carrying
	// tracking), atomically. Legality (must be `processing`) lives in the domain.
	app.post("/orders/:orderId/fulfillment", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = recordFulfillmentBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// Idempotency (CLAUDE.md): the client `Idempotency-Key` header, or a stable
		// fallback derived from the order id (a header-less double-submit dedupes on
		// the guarded flip, not a fresh key each time).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:fulfillment:${params.data.orderId}`;
		const res = await recordFulfillment(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				carrier: parsed.data.carrier,
				trackingNumber: parsed.data.trackingNumber,
				trackingUrl: parsed.data.trackingUrl ?? null,
				shippedAt: parsed.data.shippedAt ?? null,
				recordedBy: parsed.data.recordedBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json({ ok: true, recorded: res.recorded, order: serializeOrder(res.order) }, 200);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		// NOT_FULFILLABLE (the order is not in `processing`) → 409, like an
		// INVALID_TRANSITION; the trimmed-empty guards → 400.
		if (res.reason === "NOT_FULFILLABLE") return c.json({ ok: false, reason: res.reason }, 409);
		return c.json({ ok: false, reason: res.reason }, 400); // EMPTY_CARRIER / _TRACKING_NUMBER / _RECORDER
	});

	// -- Admin Orders console: cancel an order WITH a structured reason ----------
	// (admin-UX Increment 1, "cancel with reason"). A NON-GET, so the app-level
	// X-Service-Token write gate covers it when the service secret is set; the
	// route additionally requires the internal token. Mirrors the port 1:1 —
	// cancelling records the reason envelope AND drives the
	// {pending,paid,processing} → cancelled transition AND enqueues the cancelled
	// email, atomically. Legality (which states may cancel) lives in the domain,
	// derived from the ONE state machine. The bare `POST .../transition {toState:
	// "cancelled"}` above remains available for other callers/back-compat — a
	// cancellation via that path carries no reason.
	app.post("/orders/:orderId/cancel", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = cancelOrderBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// Idempotency (CLAUDE.md): the client `Idempotency-Key` header, or a stable
		// fallback derived from the order id (a header-less double-submit dedupes on
		// the guarded flip, not a fresh key each time).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0 ? header : `admin:cancel:${params.data.orderId}`;
		const res = await cancelOrder(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				reason: parsed.data.reason,
				detail: parsed.data.detail ?? null,
				cancelledBy: parsed.data.cancelledBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json({ ok: true, cancelled: res.cancelled, order: serializeOrder(res.order) }, 200);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		// NOT_CANCELLABLE (the order's state cannot legally reach `cancelled`, or it
		// was already cancelled without a reason on file) → 409, like an
		// INVALID_TRANSITION/NOT_FULFILLABLE; the trimmed-empty guard → 400.
		if (res.reason === "NOT_CANCELLABLE") return c.json({ ok: false, reason: res.reason }, 409);
		return c.json({ ok: false, reason: res.reason }, 400); // EMPTY_CANCELLED_BY
	});

	// -- Admin Orders console: refunds (ADR-0008) --------------------------------
	// GET is internal-token guarded (a read): the ledger + the derived
	// ceiling/remaining + the gateway's honest `refundable` capability, so the
	// panel can show the right action (Stripe refund vs record-a-manual-refund)
	// and the remaining-refundable amount. POST issues/records a refund — a
	// NON-GET, so the app-level X-Service-Token write gate covers it too; it
	// mirrors the `refundOrder` use-case 1:1 (ceiling + capability + gateway error
	// taxonomy all live in the domain/adapter).

	app.get("/orders/:orderId/refunds", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const oid = toOrderId(params.data.orderId);
		const order = await deps.orderStore.getById(oid);
		if (order === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);

		const [payments, refunds] = await Promise.all([
			deps.orderStore.getCapturedPayments(oid),
			deps.orderStore.listRefunds(oid),
		]);
		const capturedTotal = sumCapturedPayments(payments);
		const ceiling = computeRefundCeiling(capturedTotal, order.totals.total);
		const refundedTotal = sumRefunds(refunds);
		const remaining = Math.max(0, ceiling - refundedTotal);
		// The gateway's HONEST capability (ADR-0008): `refundable` true ⇒ money moves
		// via the provider; false (x402, or Stripe with no secretKey) ⇒ the admin
		// records a manual/off-platform refund. Never a button that silently no-ops.
		const gateway = order.paymentMethod === null ? undefined : deps.gateways[order.paymentMethod];
		return c.json(
			{
				ok: true,
				refunds: refunds.map(serializeRefund),
				currency: order.totals.currency,
				capturedTotalCents: capturedTotal,
				refundedTotalCents: refundedTotal,
				ceilingCents: ceiling,
				remainingCents: remaining,
				paymentMethod: order.paymentMethod,
				refundable: gateway?.refundable ?? false,
			},
			200,
		);
	});

	app.post("/orders/:orderId/refund", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = refundOrderBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// A refund is ADDITIVE (not idempotent by nature like a state flip), so the
		// `Idempotency-Key` header is REQUIRED — two deliberate refunds must not
		// collapse, and there is no safe content-only fallback (mirrors restock).
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ ok: false, reason: "MISSING_IDEMPOTENCY_KEY" }, 400);
		}

		const oid = toOrderId(params.data.orderId);
		const order = await deps.orderStore.getById(oid);
		if (order === null) return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		const gateway = order.paymentMethod === null ? undefined : deps.gateways[order.paymentMethod];
		if (gateway === undefined) {
			// No gateway wired for the order's method — cannot even record a refund
			// against it (the domain needs a gateway to declare capability).
			return c.json({ ok: false, reason: "REFUND_GATEWAY_UNAVAILABLE" }, 409);
		}

		const res = await refundOrder(
			{
				orderStore: deps.orderStore,
				...(deps.paymentEventStore !== undefined
					? { paymentEventStore: deps.paymentEventStore }
					: {}),
				...(deps.clock !== undefined ? { clock: deps.clock } : {}),
			},
			gateway,
			{
				orderId: oid,
				amount: toCents(parsed.data.amountCents),
				currency: toCurrency(parsed.data.currency),
				reason: parsed.data.reason ?? null,
				refundedBy: parsed.data.refundedBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json(
				{
					ok: true,
					recorded: res.recorded,
					duplicate: res.duplicate,
					fullyRefunded: res.fullyRefunded,
					refund: serializeRefund(res.refund),
					order: serializeOrder(res.order),
				},
				200,
			);
		}
		return c.json({ ok: false, reason: res.reason }, refundFailureStatus(res.reason));
	});

	// -- Admin Orders console: append-only order notes (admin-UX Increment 0) ----
	// GET is internal-token guarded (a read); POST is additionally covered by the
	// app-level X-Service-Token write gate (any non-GET) when the service secret is
	// set — no per-route gate is needed here.

	app.get("/orders/:orderId/notes", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const notes = await listOrderNotes(
			{ orderNotesStore: deps.orderNotesStore },
			toOrderId(params.data.orderId),
		);
		return c.json({ ok: true, notes: notes.map(serializeNote) }, 200);
	});

	app.post("/orders/:orderId/notes", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = appendNoteBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		// Idempotency (CLAUDE.md): the client `Idempotency-Key` header, or a fallback
		// derived from the order id (so a header-less double-submit still dedupes on
		// a stable key rather than always inserting).
		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:note:${params.data.orderId}:${parsed.data.author}:${parsed.data.body}`;
		const res = await appendOrderNote(
			{ orderNotesStore: deps.orderNotesStore, orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				author: parsed.data.author,
				body: parsed.data.body,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json({ ok: true, appended: res.appended, note: serializeNote(res.note) }, 201);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		return c.json({ ok: false, reason: res.reason }, 400); // EMPTY_AUTHOR / EMPTY_BODY
	});

	return app;
}

/** Wire shape of the order customer context (admin-UX Increment 1). Mirrors the
 *  domain shape 1:1: identity + linkage, the profile address book (NOT a
 *  per-order shipping snapshot — none exists in this domain), TOKEN-FREE
 *  session summaries, and the union-keyed order aggregates (`recentOrders`
 *  reuses the admin-list summary wire shape). */
function serializeCustomerContext(context: OrderCustomerContext): Record<string, unknown> {
	return {
		identity: {
			customerId: context.identity.customerId,
			buyerRef: context.identity.buyerRef,
			email: context.identity.email,
			displayName: context.identity.displayName,
			emailVerifiedAt: context.identity.emailVerifiedAt,
			linkage: context.identity.linkage,
		},
		addresses: context.addresses.map((a) => ({
			id: a.id,
			kind: a.kind,
			name: a.name,
			line1: a.line1,
			line2: a.line2,
			city: a.city,
			region: a.region,
			postalCode: a.postalCode,
			country: a.country,
			isDefault: a.isDefault,
			createdAt: a.createdAt,
		})),
		sessions: context.sessions.map((s) => ({
			id: s.id,
			createdAt: s.createdAt,
			expiresAt: s.expiresAt,
			revokedAt: s.revokedAt,
		})),
		orderCount: context.orderCount,
		recentOrders: context.recentOrders.map(serializeOrderSummary),
	};
}

/** Wire shape of the order timeline (admin-UX Increment 1, timeline slice).
 *  Mirrors the domain shape 1:1: a chronological list of discriminated entries
 *  (each `at` + `kind` + the kind's fields) plus `stateChangesAudited` (false ⇒
 *  the order's transitions predate the audit table, so the state-change history
 *  is partial). Each entry is a plain structured record — the plugin renders it;
 *  no presentation strings on the wire. */
function serializeTimeline(timeline: OrderTimeline): Record<string, unknown> {
	return {
		orderId: timeline.orderId,
		stateChangesAudited: timeline.stateChangesAudited,
		entries: timeline.entries.map((e) => ({ ...e })),
	};
}

/** Wire shape of a refund row (ADR-0008). Money is an integer minor-unit
 *  `amountCents` + an ISO-4217 currency string — never a float. `kind` is
 *  'gateway' (money moved via the provider, `refundRef` set) or 'manual'
 *  (out-of-band record, `refundRef` null). */
function serializeRefund(refund: RefundRecord): Record<string, unknown> {
	return {
		id: refund.id,
		orderId: refund.orderId,
		amountCents: refund.amount,
		currency: refund.currency,
		kind: refund.kind,
		gateway: refund.gateway,
		refundRef: refund.refundRef,
		reason: refund.reason,
		refundedBy: refund.refundedBy,
		status: refund.status,
		createdAt: refund.createdAt,
	};
}

/** Map a refund failure to an HTTP status (ADR-0008). Malformed input → 400;
 *  ceiling / capability / provider-divergence conflicts → 409; a definite
 *  provider rejection → 502; a transient transport failure → 503; the ambiguous
 *  timeout → 409 (the caller must RE-CHECK before retrying, never auto-retry). */
function refundFailureStatus(reason: RefundOrderFailure): 400 | 404 | 409 | 502 | 503 {
	switch (reason) {
		case "ORDER_NOT_FOUND":
			return 404;
		case "EMPTY_REFUNDED_BY":
		case "INVALID_AMOUNT":
			return 400;
		case "CURRENCY_MISMATCH":
		case "NO_CAPTURED_PAYMENT":
		case "REFUND_EXCEEDS_CAPTURED":
		case "REFUND_EXCEEDS_TOTAL":
		case "PROVIDER_ALREADY_REFUNDED":
		case "REFUND_NOT_SUPPORTED":
		case "GATEWAY_UNVERIFIED":
		// The loud residual (ADR-0008, reserve-before-issue): a gateway refund
		// issued but its reserved ledger row could not be finalized. A DISTINCT 409
		// (its own `reason` on the wire) so it is never conflated with a clean
		// pre-issuance rejection — the money moved, an anomaly + reconciliation flag
		// were recorded, and the operator must reconcile (never auto-retry).
		case "REFUND_ISSUED_UNRECORDED":
			return 409;
		case "GATEWAY_TERMINAL":
			return 502;
		case "GATEWAY_RETRYABLE":
			return 503;
	}
}

/** Wire shape of an order note (admin-UX Increment 0). Plain annotation — no
 *  money, no branded ids leaked beyond the string id. */
function serializeNote(note: OrderNote): Record<string, unknown> {
	return {
		id: note.id,
		orderId: note.orderId,
		author: note.author,
		body: note.body,
		createdAt: note.createdAt,
	};
}

/** Wire shape of an admin Products-list row (view-only projection; admin-UX
 *  Increment 2). Money stays an integer minor unit + an ISO-4217 currency
 *  string, null exactly like the stored row (a "create then price" product
 *  may have neither sku nor price yet). Carries `onHand` from the store's
 *  single LEFT JOIN — a COUNT, never money (no cents, no currency), and never
 *  an N+1 per row (port doc). */
function serializeProductSummary(summary: ProductSummary): Record<string, unknown> {
	return {
		productId: summary.productId,
		sku: summary.sku,
		title: summary.title,
		priceCents: summary.price?.amount ?? null,
		currency: summary.price?.currency ?? null,
		productKind: summary.productKind,
		active: summary.active,
		// Passed through UNCOERCED: `null` ("no inventory row" — unknown) must
		// reach the client AS null, distinct from `0` ("out of stock"). A `?? 0`
		// here would invent an out-of-stock claim for every unsynced product.
		onHand: summary.onHand,
		deletedAt: summary.deletedAt,
		createdAt: summary.createdAt,
	};
}

/** Wire shape of the admin Product detail (view-only; admin-UX Increment 2) —
 *  the FULL `ProductCommerce` row plus the single-sku `onHand` read (never a
 *  list-level join). Money as integer minor units + ISO-4217, exactly like
 *  `serializeOrder`'s money fields.
 *
 *  `onHand` is `number | null` with the LIST's semantics (INC-23): `null` is
 *  "no inventory row / no sku" — unknown — and `0` is a known sku that is out
 *  of stock. The two must never be folded into each other in either direction. */
function serializeProductDetail(
	product: ProductCommerce,
	onHand: number | null,
): Record<string, unknown> {
	return {
		productId: product.productId,
		sku: product.sku,
		title: product.title,
		priceCents: product.price?.amount ?? null,
		currency: product.price?.currency ?? null,
		taxClass: product.taxClass,
		// Increment 2 slice 5. This is the INTERNAL-TOKEN admin detail, so unit
		// cost (admin-only margin data) is intentionally serialized HERE — and
		// ONLY here (never on the public `GET /products/:id/commerce`, never on the
		// catalog view). Compare-at + inventory policy round-trip alongside it.
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

/** Resolve an admin productId to its AUTHORITATIVE sku for a stock movement —
 *  never trusting a client-supplied sku. A missing/soft-deleted product ⇒
 *  `not_found` (404, mirrors the product detail's not-found rule); a skuless
 *  "create then price" product ⇒ `no_sku` (409, nothing to move stock against
 *  yet). */
async function resolveProductSku(
	deps: AdminRoutesDeps,
	productId: string,
): Promise<{ status: "ok"; sku: string } | { status: "not_found" } | { status: "no_sku" }> {
	const product = await deps.productCommerce.getByProductId(toProductId(productId));
	if (product === null || product.deletedAt !== null) return { status: "not_found" };
	if (product.sku === null) return { status: "no_sku" };
	return { status: "ok", sku: product.sku };
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** Clamp a page limit into [1, 100] (MOD-1: a decoded cursor's limit is
 *  RE-CLAMPED, never honored past the max). Falls back to the query limit, then
 *  the default, for a missing/garbage value. */
function clampLimit(decoded: unknown, queryLimit: number): number {
	const raw =
		typeof decoded === "number" && Number.isFinite(decoded)
			? decoded
			: Number.isFinite(queryLimit)
				? queryLimit
				: DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

/** Build a domain filter from raw query params. CSV `states` are split and each
 *  token validated against the shared enum — an unknown token ⇒ null (→ 400). */
function buildFilterFromQuery(
	states: string | undefined,
	from: string | undefined,
	to: string | undefined,
	search: string | undefined,
): OrderListFilter | null {
	const filter: OrderListFilter = {};
	if (states !== undefined) {
		const tokens = states
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const parsed: OrderState[] = [];
		for (const t of tokens) {
			const r = orderStateEnum.safeParse(t);
			if (!r.success) return null;
			parsed.push(r.data);
		}
		if (parsed.length > 0) filter.states = parsed;
	}
	if (from !== undefined) filter.from = from;
	if (to !== undefined) filter.to = to;
	if (search !== undefined) filter.search = search;
	return filter;
}

/** Narrow a validated-filter zod result back into the domain `OrderListFilter`
 *  (drops `undefined` keys so the shape is exact). */
function toFilter(parsed: {
	states?: OrderState[];
	from?: string;
	to?: string;
	search?: string;
}): OrderListFilter {
	const filter: OrderListFilter = {};
	if (parsed.states !== undefined && parsed.states.length > 0) filter.states = parsed.states;
	if (parsed.from !== undefined) filter.from = parsed.from;
	if (parsed.to !== undefined) filter.to = parsed.to;
	if (parsed.search !== undefined) filter.search = parsed.search;
	return filter;
}

/** The decoded cursor's `createdAt` must be a valid ISO-8601 datetime — the SAME
 *  check the query `from`/`to` bounds use — so a tampered/garbage position is a
 *  malformed cursor (→ 400), never a raw string that reaches the store's keyset
 *  comparison. */
const cursorCreatedAt = z.string().datetime();

/** Validate a decoded cursor position shape — `{ createdAt: <ISO datetime>, id:
 *  <opaque, bounded string> }` — or null if malformed (→ 400). */
function cursorPosOf(pos: unknown): OrderListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; id?: unknown };
	if (typeof p.createdAt !== "string" || !cursorCreatedAt.safeParse(p.createdAt).success) {
		return null;
	}
	if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 200) return null;
	return { createdAt: p.createdAt, id: toOrderId(p.id) };
}

interface DecodedCursor {
	pos: unknown;
	filter: unknown;
	limit: unknown;
}

/** Encode the keyset position + active filter + limit into an opaque base64url
 *  token, so paging preserves the filter and clamped limit. */
function encodeCursor(pos: OrderListCursor, filter: OrderListFilter, limit: number): string {
	const payload = { pos: { createdAt: pos.createdAt, id: pos.id }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode an opaque cursor token; returns null on ANY malformed/garbage input so
 *  the route answers 400 rather than 500 (MOD-1). */
function decodeCursor(token: string): DecodedCursor | null {
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

/** Narrow a validated product-filter zod result back into the domain
 *  `ProductListFilter` (drops `undefined` keys so the shape is exact) —
 *  mirrors `toFilter`. */
function toProductFilter(parsed: {
	active?: boolean;
	deleted?: boolean;
	productKind?: "physical" | "digital";
	search?: string;
	lowStockThreshold?: number;
}): ProductListFilter {
	const filter: ProductListFilter = {};
	if (parsed.active !== undefined) filter.active = parsed.active;
	if (parsed.deleted !== undefined) filter.deleted = parsed.deleted;
	if (parsed.productKind !== undefined) filter.productKind = parsed.productKind;
	if (parsed.search !== undefined) filter.search = parsed.search;
	if (parsed.lowStockThreshold !== undefined) filter.lowStockThreshold = parsed.lowStockThreshold;
	return filter;
}

/** Validate a decoded product-cursor position shape — `{ createdAt: <ISO
 *  datetime>, productId: <opaque, bounded string> }` — or null if malformed
 *  (→ 400). Mirrors `cursorPosOf`. */
function productCursorPosOf(pos: unknown): ProductListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; productId?: unknown };
	if (typeof p.createdAt !== "string" || !cursorCreatedAt.safeParse(p.createdAt).success) {
		return null;
	}
	if (typeof p.productId !== "string" || p.productId.length === 0 || p.productId.length > 200) {
		return null;
	}
	return { createdAt: p.createdAt, productId: toProductId(p.productId) };
}

/** Encode the product-list keyset position + active filter + limit into an
 *  opaque base64url token — mirrors `encodeCursor`. */
function encodeProductCursor(
	pos: ProductListCursor,
	filter: ProductListFilter,
	limit: number,
): string {
	const payload = { pos: { createdAt: pos.createdAt, productId: pos.productId }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode an opaque product-list cursor token; returns null on ANY malformed/
 *  garbage input so the route answers 400 rather than 500 (MOD-1). Mirrors
 *  `decodeCursor`. */
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

// Portable base64url (Node + workerd both provide btoa/atob + TextEncoder).
function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64); // throws on invalid base64 ⇒ caught by decodeCursor ⇒ 400
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
