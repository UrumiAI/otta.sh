/**
 * The console's ONE data path, and the wire shapes it speaks (INC-20).
 *
 * ADR-0014 Decision 3: `otta-console` holds zero capabilities and zero
 * `allowedHosts`, owns no routes, and reaches commerce ONLY by calling the
 * existing authenticated `otta` admin route from the browser with the operator's
 * own session. Everything in this module goes through that one route, through
 * `apiFetch` (which adds the `X-EmDash-Request` CSRF header state-changing
 * endpoints require), same-origin. There is no second fetch anywhere in this
 * package, and there must never be one.
 *
 * WIRE TYPES ARE MIRRORED, NOT IMPORTED, and for the same reason
 * `packages/plugin/src/types.ts` hand-mirrors EmDash's plugin surface: the
 * console may not import `@otta-sh/plugin`
 * (`console-imports-no-workspace-package`), so the shapes below are this
 * package's own statement of what it expects to receive. They are structural
 * subsets — every field here is read by a component; fields the plugin sends and
 * the console does not use are deliberately absent rather than mirrored for
 * completeness, so this file stays a description of THIS screen's needs.
 *
 * FAILURES ARE VALUES (G5, one tier up). Nothing here throws at a component. A
 * 401 (a session that expired in another tab) and a 403 (a role that lost
 * `plugins:manage`) are the two most likely things this page will ever see in
 * production, and both must reach the screen as a sentence, not as a blank pane.
 * INC-19 stated the status and recorded the remediation copy as deferred to this
 * increment; {@link readFailure} is where it lands, built on EmDash's own
 * `getErrorMessage` so the server's message is what the operator reads.
 */
import { PRODUCTS_UNAVAILABLE_TITLE } from "@otta-sh/admin-presentation";
import { apiFetch, getErrorMessage } from "emdash/plugin-utils";

/** The Block Kit plugin's single admin dispatch route — `otta`, not
 *  `otta-console`. See `admin.tsx`'s note: `ctx.kv` is namespaced per plugin id,
 *  so a route on the console's own id would open onto an EMPTY settings
 *  namespace and need the service token duplicated plus its own
 *  `network:request` capability. Cross-plugin fetch is the clean path. */
export const OTTA_ADMIN_ROUTE = "/_emdash/api/plugins/otta/admin";

/** The two interaction types the plugin's console branch answers to. Disjoint
 *  from EmDash's own (`page_load` / `block_action` / `form_submit`), which is
 *  what keeps the Block Kit Orders screen's behaviour untouched. */
const READ = "otta_console_read";
const ACT = "otta_console_act";

// ── wire shapes ──────────────────────────────────────────────────────────────

export interface OrderSummary {
	readonly id: string;
	readonly state: string;
	readonly currency: string;
	readonly buyerRef: string;
	readonly customerId: string | null;
	readonly paymentMethod: string | null;
	readonly createdAt: string;
	readonly totalCents: number;
	readonly reconciliationFlag: boolean | string | null;
}

export interface OrderLine {
	readonly sku: string;
	readonly title: string;
	readonly unitPriceCents: number;
	readonly currency: string;
	readonly quantity: number;
	readonly fulfillmentKind: string;
}

export interface OrderTotals {
	readonly currency: string;
	readonly subtotalCents: number;
	readonly discountCents: number;
	readonly shippingCents: number;
	readonly taxCents: number;
	readonly totalCents: number;
	readonly appliedCouponCode: string | null;
	readonly shippingZoneId?: string | null;
}

export interface ShippingAddress {
	readonly name?: string | null;
	readonly line1?: string | null;
	readonly line2?: string | null;
	readonly city?: string | null;
	readonly region?: string | null;
	readonly postalCode?: string | null;
	readonly country?: string | null;
	readonly email?: string | null;
	readonly phone?: string | null;
}

export interface OrderFulfillment {
	readonly carrier?: string | null;
	readonly trackingNumber?: string | null;
	readonly trackingUrl?: string | null;
	readonly shippedAt?: string | null;
	readonly recordedBy?: string | null;
	readonly recordedAt?: string | null;
}

export interface OrderCancellation {
	readonly reason?: string | null;
	readonly detail?: string | null;
	readonly cancelledBy?: string | null;
	readonly cancelledAt?: string | null;
}

export interface OrderDetail {
	readonly id: string;
	readonly state: string;
	readonly currency: string;
	readonly paymentMethod: string | null;
	readonly buyerRef: string;
	readonly customerId: string | null;
	readonly createdAt: string;
	readonly reconciliationFlag: string | null;
	readonly reconciliationResolution: {
		readonly outcome?: string | null;
		readonly reason?: string | null;
		readonly resolvedBy?: string | null;
		readonly resolvedAt?: string | null;
	} | null;
	readonly fulfillment: OrderFulfillment | null;
	readonly cancellation: OrderCancellation | null;
	readonly shippingAddress: ShippingAddress | null;
	readonly totals: OrderTotals;
	readonly lines: readonly OrderLine[];
}

export interface RefundRow {
	readonly amountCents: number;
	readonly currency?: string | null;
	readonly providerRef?: string | null;
	readonly refundedBy?: string | null;
	readonly createdAt?: string | null;
}

export interface RefundsSummary {
	readonly refunds: readonly RefundRow[];
	readonly currency: string;
	readonly capturedTotalCents: number;
	readonly refundedTotalCents: number;
	readonly ceilingCents: number;
	readonly remainingCents: number;
	readonly paymentMethod: string | null;
	readonly refundable: boolean;
}

export interface TimelineEntry {
	readonly kind: string;
	readonly at: string;
	readonly toState?: string | null;
	readonly actor?: string | null;
	readonly author?: string | null;
	readonly recordedBy?: string | null;
	readonly cancelledBy?: string | null;
	readonly resolvedBy?: string | null;
	readonly body?: string | null;
	readonly carrier?: string | null;
	readonly trackingNumber?: string | null;
	readonly reason?: string | null;
	readonly detail?: string | null;
	readonly outcome?: string | null;
}

export interface OrderTimeline {
	readonly entries: readonly TimelineEntry[];
}

export interface OrderNote {
	readonly author: string;
	readonly body: string;
	readonly createdAt: string;
}

export interface CustomerContext {
	readonly identity: {
		readonly email?: string | null;
		readonly buyerRef: string;
		readonly linkage: string;
		readonly name?: string | null;
		readonly emailVerifiedAt?: string | null;
	};
	readonly orderCount: number;
	readonly addresses?: readonly ShippingAddress[];
	readonly recentOrders?: readonly {
		readonly id: string;
		readonly state: string;
		readonly createdAt: string;
		readonly totalCents: number;
		readonly currency: string;
	}[];
}

export interface LabelledOption {
	readonly value: string;
	readonly label: string;
}

export interface Vocabulary {
	readonly statuses: readonly string[];
	readonly statusAny: string;
	readonly periods: readonly { readonly key: string; readonly label: string }[];
	readonly cancellationReasons: readonly LabelledOption[];
	/** The reasons that have a `orders:cancel-<reason>` action id, shipped by the
	 *  plugin from the SAME constant its dispatch table derives those ids from.
	 *  A one-click control may only offer a member of this list; the rest are
	 *  reachable through the note form, which posts `orders:cancel`. Never filter
	 *  {@link cancellationReasons} here to reconstruct it — that is the second copy
	 *  of the rule this field exists to delete. */
	readonly oneClickCancellationReasons: readonly LabelledOption[];
	readonly reconciliationOutcomes: readonly LabelledOption[];
	readonly pageLimit: number;
}

export interface OrdersFilter {
	readonly status?: string;
	readonly period?: string;
	readonly from?: string;
	readonly to?: string;
	readonly search?: string;
}

export interface ListPayload {
	readonly ok: true;
	readonly orders: readonly OrderSummary[];
	readonly nextCursor: string | null;
	/** The service's exact count of the filtered set (INC-23). Optional because
	 *  a service older than the field omits it, and `formatAmount`'s rule
	 *  applies to counts too: absent is not zero. */
	readonly total?: number;
	/**
	 * THE PAGE THIS SCREEN ASKED FOR WAS REFUSED, and these are the first page's
	 * rows instead.
	 *
	 * The service fails closed when a cursor disagrees with the filters sent
	 * beside it, or when the token will not decode, and its prescribed remedy is
	 * mechanical: drop the cursor and re-issue page one with the same parameters.
	 * The plugin performs that before answering, so this arrives as a SUCCESS with
	 * a flag rather than as a failure — the request was answered, just not from
	 * the page that was named.
	 *
	 * IT IS THE ONLY THING THAT MAY TRIGGER THE ADDRESS-BAR RESET. A failure
	 * cannot: every failure reaches this tier in one shape, so a refused token
	 * would be indistinguishable from an expired session or a dropped connection,
	 * and correcting the address on those would throw away the operator's page at
	 * the moment a reload would have restored it.
	 */
	readonly cursorRejected?: boolean;
	readonly vocabulary: Vocabulary;
}

export interface DetailPayload {
	readonly ok: true;
	readonly order: OrderDetail;
	readonly transitions: readonly string[];
	readonly customer: CustomerContext | null;
	readonly timeline: OrderTimeline | null;
	readonly refunds: RefundsSummary | null;
	readonly notes: readonly OrderNote[];
	readonly vocabulary: Vocabulary;
}

export interface ActPayload {
	readonly ok: true;
	readonly notice: {
		readonly variant: string;
		readonly title: string;
		readonly description: string;
	} | null;
	/**
	 * WHICH INPUT the outcome is about, when it is about exactly one — the
	 * plugin's `ProductsActionResult.field`, mirrored here so the contract
	 * between the two tiers is declared rather than living in a cast at the one
	 * call site that reads it.
	 *
	 * OPTIONAL, and absent is the common case: an outcome about the record as a
	 * whole omits it and reports at the top of the screen. The value is still
	 * re-checked where it is read — this is a mirror of a payload that crossed
	 * HTTP, not a guarantee about it.
	 */
	readonly field?: "sku";
}

// ── wire shapes: Pricing & inventory (INC-21) ────────────────────────────────

/** One list row. A structural subset of the plugin's `ProductSummaryWire`, and
 *  `onHand` is the RAW COUNT rather than a rendered cell — G1's reasoning
 *  applied to a number that is not money: a Block Kit row carries `"3 · Low"`,
 *  a decision already made, and a React tier fed that string could neither
 *  re-band it nor tell `0` from "no inventory record". `onHandCell` is called
 *  HERE, from the shared package, so both surfaces band the same count the same
 *  way. */
export interface ProductSummary {
	readonly productId: string;
	readonly sku: string | null;
	readonly title: string | null;
	readonly priceCents: number | null;
	readonly currency: string | null;
	readonly productKind: string;
	readonly active: boolean;
	/** `null` ⇒ the sku carries no inventory record. NEVER conflated with 0. */
	readonly onHand: number | null;
	readonly deletedAt: string | null;
	readonly createdAt: string;
}

export interface ProductRecord {
	readonly productId: string;
	readonly sku: string | null;
	readonly title: string | null;
	readonly priceCents: number | null;
	readonly currency: string | null;
	readonly taxClass: string | null;
	readonly compareAtCents: number | null;
	readonly compareAtCurrency: string | null;
	readonly unitCostCents: number | null;
	readonly unitCostCurrency: string | null;
	readonly inventoryPolicy: string;
	readonly weightGrams: number | null;
	readonly lengthMm: number | null;
	readonly widthMm: number | null;
	readonly heightMm: number | null;
	readonly productKind: string;
	readonly active: boolean;
	readonly deletedAt: string | null;
	readonly onHand: number | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TaxClass {
	readonly id: string;
	readonly name: string;
}

export interface ProductsVocabulary {
	/** The combined Status select's options — `active`/`archived` as ONE
	 *  mutually-exclusive choice, because a soft-deleted row is always
	 *  inactive. */
	readonly statuses: readonly LabelledOption[];
	readonly kinds: readonly LabelledOption[];
	/** The all-values sentinel both selects use. Never `""`. */
	readonly any: string;
	readonly pageLimit: number;
}

/** Page context a row cannot carry: what counts as `Low`, and whether the read
 *  degraded. It survives a page narrowed to ZERO rows, which is exactly when
 *  the degradation banner has to speak. */
export interface StockContext {
	readonly threshold: number | null;
	readonly unreadable: boolean;
	readonly filterUnavailable: boolean;
}

export interface ProductsFilter {
	readonly status?: string;
	readonly productKind?: string;
	readonly lowStock?: boolean;
	readonly search?: string;
}

export interface ProductsListPayload {
	readonly ok: true;
	readonly products: readonly ProductSummary[];
	readonly nextCursor: string | null;
	/** Absent when the service reports none AND when "Low stock only" was
	 *  asked for but the threshold could not be resolved, so the request never
	 *  carried the predicate (`stock.filterUnavailable`) — see the plugin's
	 *  `resolveStockContext`. Both land on the page-scoped count. */
	readonly total?: number;
	/**
	 * THE PAGE THIS SCREEN ASKED FOR WAS REFUSED, and these are the first page's
	 * rows instead.
	 *
	 * The service fails closed when a cursor disagrees with the filters sent
	 * beside it, or when the token will not decode, and its prescribed remedy is
	 * mechanical: drop the cursor and re-issue page one with the same parameters.
	 * The plugin performs that before answering, so this arrives as a SUCCESS with
	 * a flag rather than as a failure — the request was answered, just not from
	 * the page that was named.
	 *
	 * IT IS THE ONLY THING THAT MAY TRIGGER THE ADDRESS-BAR RESET. A failure
	 * cannot: every failure reaches this tier in one shape, so a refused token
	 * would be indistinguishable from an expired session or a dropped connection,
	 * and correcting the address on those would throw away the operator's page at
	 * the moment a reload would have restored it.
	 */
	readonly cursorRejected?: boolean;
	readonly stock: StockContext;
	readonly vocabulary: ProductsVocabulary;
}

export interface ProductDetailPayload {
	readonly ok: true;
	readonly product: ProductRecord;
	readonly taxClasses: readonly TaxClass[];
	readonly threshold: number | null;
	readonly vocabulary: ProductsVocabulary;
}

/** What every component in this package renders on a refusal. `ok: false` is the
 *  discriminant, and it is the SAME shape whether the refusal came from the
 *  transport, from EmDash's authorization layer or from the plugin — a screen
 *  that had to tell those apart would be a screen with three empty states. */
export interface Failure {
	readonly ok: false;
	readonly title: string;
	readonly description: string;
}

export type Result<T> = T | Failure;

export function isFailure<T extends { ok: true }>(result: Result<T>): result is Failure {
	return result.ok === false;
}

// ── transport ────────────────────────────────────────────────────────────────

/**
 * Turn a non-2xx response into the sentence an operator should read.
 *
 * THIS IS INC-19'S RECORDED DEFERRAL, LANDING. The shell stated the status
 * (`HTTP 403`) and said, in as many words, that remediation copy belonged with a
 * real screen. A status alone tells an operator that something refused; it does
 * not tell them whether to sign in again, ask for a permission, or page someone.
 *
 * `getErrorMessage` is EmDash's own helper: it parses the
 * `{ success: false, error: { code, message } }` envelope every plugin API route
 * uses and falls back cleanly when the body is not JSON. So the SERVER'S message
 * is what reaches the screen whenever there is one, and the per-status sentence
 * below is the remediation — what to DO — appended to it rather than replacing
 * it. Never both silent and never a guess.
 */
async function readFailure(response: Response, subject: string): Promise<Failure> {
	const remediation =
		response.status === 401
			? "Your session is no longer valid — it may have expired or been signed out in another tab. Reload this page to sign in again."
			: response.status === 403
				? "Your account is signed in but is not allowed to manage plugins. Ask an administrator to grant the plugins:manage permission, then reload."
				: response.status >= 500
					? "The admin service answered with an error. Reload to try again; if it persists this is a fault in the console or the commerce service, not your data."
					: "The console sent a request this admin would not accept. Reload the page; if it happens again, this is a fault in the console itself.";
	const served = await getErrorMessage(response, "");
	return {
		ok: false,
		// THE SUBJECT IS THE CALLER'S, and it is not decoration: a console with two
		// migrated screens can refuse on either, and "Orders are unavailable" on
		// the Pricing & inventory screen sends an operator to look at the wrong
		// thing. It names the SCREEN rather than the request, because the screen
		// is what the operator is looking at.
		title: `${subject} (HTTP ${String(response.status)})`,
		description: served.length > 0 ? `${served} ${remediation}` : remediation,
	};
}

/** The two migrated screens' failure subjects. The products one is the SHARED
 *  constant both the Block Kit screen's `failClosed()` and the plugin's console
 *  branch already use — three spellings of one sentence was two too many. */
const ORDERS_UNAVAILABLE = "Orders are unavailable";
const PRODUCTS_UNAVAILABLE = PRODUCTS_UNAVAILABLE_TITLE;

/** A request that never produced a response at all. Distinguished from a
 *  refusal on purpose: "nothing came back" and "something came back and it was
 *  a no" are different problems with different fixes, and INC-19's probe panel
 *  made the same distinction for the same reason. */
function transportFailure(error: unknown): Failure {
	return {
		ok: false,
		title: "The admin could not be reached",
		description: `The request never completed${
			error instanceof Error ? ` — ${error.message}` : ""
		}. Check that you are online, then reload.`,
	};
}

async function post<T extends { ok: true }>(body: unknown, subject: string): Promise<Result<T>> {
	let response: Response;
	try {
		response = await apiFetch(OTTA_ADMIN_ROUTE, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		return transportFailure(error);
	}
	if (!response.ok) return readFailure(response, subject);
	let envelope: unknown;
	try {
		envelope = await response.json();
	} catch (error) {
		return transportFailure(error);
	}
	const data = (envelope as { data?: unknown } | null)?.data;
	// The plugin answers 200 with `{ok:false,…}` for its OWN refusals (G5), so a
	// payload that already says no is passed through untouched — its copy is
	// better than anything this layer could invent.
	if (typeof data === "object" && data !== null && "ok" in data) return data as Result<T>;
	return {
		ok: false,
		title: "The admin sent something this screen could not read",
		description:
			"The response did not have the shape this screen expects. Reload the page; if it happens again, this is a fault in the console itself.",
	};
}

export function fetchOrders(filter: OrdersFilter, cursor?: string): Promise<Result<ListPayload>> {
	return post<ListPayload>(
		{
			type: READ,
			resource: "orders.list",
			filter,
			...(cursor !== undefined ? { cursor } : {}),
		},
		ORDERS_UNAVAILABLE,
	);
}

export function fetchOrderDetail(orderId: string): Promise<Result<DetailPayload>> {
	return post<DetailPayload>(
		{ type: READ, resource: "orders.detail", orderId },
		ORDERS_UNAVAILABLE,
	);
}

export function fetchProducts(
	filter: ProductsFilter,
	cursor?: string,
): Promise<Result<ProductsListPayload>> {
	return post<ProductsListPayload>(
		{
			type: READ,
			resource: "products.list",
			filter,
			...(cursor !== undefined ? { cursor } : {}),
		},
		PRODUCTS_UNAVAILABLE,
	);
}

export function fetchProductDetail(productId: string): Promise<Result<ProductDetailPayload>> {
	return post<ProductDetailPayload>(
		{ type: READ, resource: "products.detail", productId },
		PRODUCTS_UNAVAILABLE,
	);
}

/**
 * Perform a write.
 *
 * `actionId` and `value` are the EXACT pair the Block Kit button of the same
 * name carries, and the plugin forwards them to the Block Kit action handler
 * unchanged. Every watermark, every idempotency key and every refusal message
 * comes from that handler — the React tier issues the click and renders the
 * answer, it does not decide anything about money.
 */
export function performAction(
	actionId: string,
	value: Record<string, string>,
	subject: string = ORDERS_UNAVAILABLE,
): Promise<Result<ActPayload>> {
	return post<ActPayload>({ type: ACT, action_id: actionId, value }, subject);
}

/** The subject a Pricing & inventory write's transport refusal names. Exported
 *  so the screen states it once rather than at every call site. */
export const PRODUCTS_ACT_SUBJECT = PRODUCTS_UNAVAILABLE;
