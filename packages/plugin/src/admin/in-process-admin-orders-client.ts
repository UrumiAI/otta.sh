/**
 * `InProcessAdminOrdersClient` — the admin Orders console surface with commerce
 * truth held on the plugin's own document store (work order 02, INC-B10b-ii).
 *
 * WHAT THIS CLASS IS. The in-process twin of `AdminOrdersClient`: the same
 * twelve methods, the same argument shapes, the same RETURN VALUES — including
 * every field the HTTP wire carries — with the `@otta-sh/domain` use-cases
 * composed over the `@otta-sh/store-emdash` adapters bound to `ctx.storage`
 * instead of a commerce service. Nothing here reaches for egress; `ctx.http` is
 * never touched.
 *
 * NO FIELD IS NARROWED, and that is a rule rather than a preference. The React
 * admin screens consume these results through `console-api.ts` STRUCTURAL
 * mirrors — they import no wire type — so a field quietly dropped here is
 * invisible to the compiler and breaks at runtime. In particular:
 *  - `OrdersListResult.total` is always present on a page this tier served, and
 *    an ABSENT total is never spelled `0` (that would caption a page of rows
 *    with a count of none);
 *  - `cursorRejected` is only ever `true`, never `false` and never "present but
 *    unset" — it means "you asked for a page you did not get";
 *  - `allowedTransitions` is DERIVED from the domain state machine
 *    (`legalNextStates`), never re-listed here;
 *  - `deletedAt`-style tombstone semantics carry over from products: a non-null
 *    stamp means tombstoned, and nothing collapses it into absence;
 *  - `shippingAddress` is the order's immutable checkout SNAPSHOT (ADR-0009) and
 *    is read off the order row — never re-read from the mutable profile address
 *    book, which appears (separately) on the customer-context panel;
 *  - `RefundsSummaryWire.refundedTotalCents` is the watermark the refund action
 *    reads, and `refundable` is the gateway's HONEST capability — neither is
 *    softened;
 *  - `updatedAt` doubles as the optimistic-concurrency token elsewhere in the
 *    admin surface, so an order's stamps pass through as the store spells them.
 *
 * NO ADMIN AUTH HERE, deliberately (ADR-0014 D3). EmDash's own admin auth and
 * CSRF gate the console route that constructs this; there is no service to
 * authenticate to, so there is nothing to authenticate WITH. The HTTP tier's
 * `X-Internal-Token` / `X-Service-Token` are transport concerns and stay on the
 * transport. What DOES carry over is the route's status mapping: the HTTP
 * client's failure results are `{ ok: false, status }`, so this tier synthesizes
 * the very status the route would have answered with (404 for an unknown order,
 * 409 for a state-machine/ceiling conflict, 400 for a refused input) rather than
 * inventing a code of its own.
 *
 * WHAT WAS PORTED, AND FROM WHERE. Four pieces of the service's route layer
 * (`packages/service/src/routes/admin.ts`) are behaviour rather than framing, so
 * they are mirrored here and named so the two can be compared by eye:
 *  - the orders list's opaque cursor (position + filter + limit, base64url JSON),
 *    its RE-VALIDATION on decode, and the fail-closed disagreement check between
 *    a token's filter/limit and the caller's — plus the client-side recovery that
 *    re-issues page one and flags `cursorRejected`;
 *  - the order serializers (`serializeOrder`, `serializeOrderSummary` from
 *    `routes/orders.ts`, plus the customer-context / timeline / refund / note
 *    serializers in `admin.ts`), field for field;
 *  - the per-command idempotency FALLBACK keys the route mints when a caller
 *    sends no header (`admin:transition:…`, `admin:cancel:…`, and the rest), so a
 *    header-less double-submit dedupes identically on both tiers;
 *  - the REFUND CEILING, which is arithmetic the route composes rather than a
 *    use-case it calls: `Σ captured` (succeeded payments only) and the frozen
 *    order total give `computeRefundCeiling`, `Σ active refunds` (status ≠
 *    `voided`) is subtracted, and the remainder floors at zero. The three summands
 *    are real `@otta-sh/domain` exports; the COMPOSITION lived in the route, and
 *    now lives here too.
 *
 * TWO RECORDED DIVERGENCES, neither of them accidental:
 *  - NO GATEWAYS ARE COMPOSED YET (INC-C1/C3 move the payment adapters). The
 *    refund POST therefore reaches the route's own "no gateway wired for this
 *    order's method" arm and answers `409 REFUND_GATEWAY_UNAVAILABLE`. The whole
 *    path in front of it — input bounds, the REQUIRED idempotency key, the order
 *    lookup — is ported faithfully, so when a gateway map arrives the one line
 *    that changes is where it comes from.
 *  - a refund ROW here carries no `status`. The service's `serializeRefund` emits
 *    one; the plugin's `RefundWire` has never declared it and no console reads
 *    it, so this tier matches the PLUGIN's wire type rather than adding a field
 *    the type says does not exist.
 *
 * SEARCH IS PREFIX-ONLY ON THIS TIER, and that is the ADR-0019 §6 floor rather
 * than a gap: id PREFIX or folded buyerRef PREFIX or EXACT folded line sku. A SQL
 * adapter may serve an unanchored buyer-ref substring as a sanctioned SUPERSET;
 * a document store has no substring operator and serves the floor. Each tier pins
 * its own side in its own tests.
 *
 * INPUT IS REFUSED AT THE BOUNDARY, as in `InProcessCommerceClient` — the request
 * schemas that used to stand in front of every call are mirrored through
 * `commerce-input.ts`. Where the HTTP tier turns a refused input into a TYPED
 * RESULT (every command's `{ ok: false, status: 400 }`), this returns that value
 * too; where it throws (the reads), this rejects.
 *
 * SANDBOX-CLEAN. No `fetch`, no `node:` builtin, no host import.
 */

import {
	appendOrderNote,
	cancelOrder as cancelOrderUseCase,
	computeRefundCeiling,
	getOrderCustomerContext,
	getOrderTimeline,
	idempotencyKey as toIdempotencyKey,
	legalNextStates,
	listOrderNotes,
	ORDER_STATE_MACHINE,
	orderId as toOrderId,
	recordFulfillment as recordFulfillmentUseCase,
	refundOrder as refundOrderUseCase,
	resolveReconciliation as resolveReconciliationUseCase,
	sumCapturedPayments,
	sumRefunds,
	transitionOrder as transitionOrderUseCase,
	cents as toCents,
	currency as toCurrency,
	type CancellationReason,
	type Order,
	type OrderCustomerContext,
	type OrderListCursor,
	type OrderListFilter,
	type OrderNote,
	type OrderState,
	type OrderSummary,
	type OrderTimeline,
	type PaymentGateway,
	type PaymentMethod,
	type ReconciliationOutcome,
	type RefundOrderFailure,
	type RefundRecord,
} from "@otta-sh/domain";
import {
	CommerceInputError,
	isCommerceInputError,
	requireBoundedText,
	requireCurrencyCode,
	requireIdToken,
} from "../commerce/commerce-input.js";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
	type InProcessCommerceStoresOptions,
} from "../commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../types.js";
import type {
	AddNoteResult,
	AdminOrdersSurface,
	CancelOrderResult,
	CustomerContextWire,
	OrderDetailResult,
	OrderDetailWire,
	OrderNoteWire,
	OrdersListFilter,
	OrdersListResult,
	OrderSummaryWire,
	OrderTimelineWire,
	RecordFulfillmentResult,
	RefundOrderResult,
	RefundsSummaryWire,
	RefundWire,
	ResolveReconciliationResult,
	TransitionOrderResult,
} from "./admin-orders-client.js";

/** The page-size bounds the list query schema enforced (`ordersListQuery`:
 *  `min(1).max(100)`, default 25). Mirrored, not imported — the service package
 *  goes away. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** The refund amount ceiling the request schema carried (`refundOrderBody`: a
 *  positive integer no greater than this). A sanity bound on the WIRE value —
 *  the real ceiling is computed from captured payments below. */
const MAX_REFUND_AMOUNT_CENTS = 1_000_000_000_000;

export class InProcessAdminOrdersClient implements AdminOrdersSurface {
	readonly #stores: InProcessCommerceStores;

	/**
	 * The payment gateways keyed by method (ADR-0008), exactly as
	 * `AdminRoutesDeps.gateways` carries them — EMPTY until the payment adapters
	 * move in-process (INC-C1/C3). An empty map is not a stub: it is the honest
	 * "no gateway is wired for this order's method", and the refund POST answers
	 * it with the route's own `409 REFUND_GATEWAY_UNAVAILABLE` rather than
	 * pretending money could move.
	 */
	readonly #gateways: Partial<Record<PaymentMethod, PaymentGateway>> = {};

	/**
	 * Takes the whole context and constructs the adapters once per client, the
	 * same request-scoped lifecycle the console route already had. A context with
	 * no document store fails HERE, at construction, naming what is missing.
	 */
	constructor(ctx: PluginContext, options: InProcessCommerceStoresOptions = {}) {
		this.#stores = createInProcessCommerceStores(ctx, options);
	}

	/**
	 * The admin orders page, its exact total, and the cursor for the next one.
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
	async listOrders(
		filter: OrdersListFilter,
		opts: { cursor?: string; limit?: number } = {},
	): Promise<OrdersListResult> {
		const asked = toDomainFilter(filter);
		const askedLimit = requireLimit(opts.limit);
		const token = opts.cursor !== undefined && opts.cursor.length > 0 ? opts.cursor : null;
		if (token === null) return this.#page(asked, null, askedLimit);

		const honoured = this.#resolveCursor(token, asked, opts.limit, askedLimit);
		if (honoured !== null) return this.#page(honoured.filter, honoured.pos, honoured.limit);

		// THE PRESCRIBED RECOVERY, at the tier the HTTP client performs it at: drop
		// the token, re-issue page one with the same parameters, once, and say so.
		// The request is still made even for a caller that will discard the rows —
		// the flag needs a page behind it, and this tier cannot know which caller it
		// has.
		const retried = await this.#page(asked, null, askedLimit);
		return { ...retried, cursorRejected: true };
	}

	/** GET one order plus the legal outbound transitions from its current state.
	 *  An id that never existed resolves to `null` — the console renders a "not
	 *  found" state, not an error banner. The transitions come STRAIGHT from the
	 *  domain state machine, never re-derived console-side. */
	async getOrder(orderId: string): Promise<OrderDetailResult | null> {
		requireIdToken("orderId", orderId);
		const order = await this.#stores.orderStore.getById(toOrderId(orderId));
		if (order === null) return null;
		return {
			order: toOrderDetailWire(order),
			allowedTransitions: [...legalNextStates(order.state)],
		};
	}

	/** POST an order-status transition. Legality lives in the domain; an unknown
	 *  order is the route's 404 and an illegal move its 409. */
	async transitionOrder(
		orderId: string,
		toState: string,
		opts: { idempotencyKey: string },
	): Promise<TransitionOrderResult> {
		let target: OrderState;
		try {
			requireIdToken("orderId", orderId);
			target = requireOrderState("toState", toState);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, status: 400 };
			throw err;
		}
		const key = fallbackKey(opts.idempotencyKey, `admin:transition:${orderId}:${toState}`);
		const res = await transitionOrderUseCase(
			{ orderStore: this.#stores.orderStore },
			{ orderId: toOrderId(orderId), toState: target, idempotencyKey: toIdempotencyKey(key) },
		);
		if (res.ok) return { ok: true, transitioned: res.transitioned };
		// The transition surface carries no `reason` on the wire — only the status,
		// exactly as `AdminOrdersClient.transitionOrder` returns it.
		return { ok: false, status: res.reason === "ORDER_NOT_FOUND" ? 404 : 409 };
	}

	/** POST resolve an order's reconciliation flag. `expectedFlag` is the detail AS
	 *  DISPLAYED to the admin and the domain compare-and-clears against it, so a
	 *  mid-review re-flag conflicts (`RECONCILIATION_FLAG_CHANGED`, 409) instead of
	 *  being cleared blind. */
	async resolveReconciliation(
		orderId: string,
		disposition: { expectedFlag: string; outcome: string; reason: string; resolvedBy: string },
		opts: { idempotencyKey: string },
	): Promise<ResolveReconciliationResult> {
		let outcome: ReconciliationOutcome;
		try {
			requireIdToken("orderId", orderId);
			requireBoundedText("expectedFlag", disposition.expectedFlag, 1, 4000);
			outcome = requireReconciliationOutcome(disposition.outcome);
			requireBoundedText("reason", disposition.reason, 1, 4000);
			requireBoundedText("resolvedBy", disposition.resolvedBy, 1, 200);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, status: 400 };
			throw err;
		}
		const key = fallbackKey(opts.idempotencyKey, `admin:resolve-reconciliation:${orderId}`);
		const res = await resolveReconciliationUseCase(
			{ orderStore: this.#stores.orderStore },
			{
				orderId: toOrderId(orderId),
				expectedFlag: disposition.expectedFlag,
				outcome,
				reason: disposition.reason,
				resolvedBy: disposition.resolvedBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) return { ok: true, resolved: res.resolved };
		if (res.reason === "ORDER_NOT_FOUND") return { ok: false, status: 404, reason: res.reason };
		// Reconciliation-axis conflicts (like an INVALID_TRANSITION) → 409; the
		// trimmed-empty guards → 400.
		if (res.reason === "NOT_IN_RECONCILIATION" || res.reason === "RECONCILIATION_FLAG_CHANGED") {
			return { ok: false, status: 409, reason: res.reason };
		}
		return { ok: false, status: 400, reason: res.reason };
	}

	/** POST record shipping fulfillment. Recording fulfillment IS shipping the
	 *  order (`processing → shipped`, atomically with the tracking envelope and the
	 *  shipped email), so a non-`processing` order is `NOT_FULFILLABLE` (409). */
	async recordFulfillment(
		orderId: string,
		fulfillment: {
			carrier: string;
			trackingNumber: string;
			trackingUrl?: string | null;
			shippedAt?: string | null;
			recordedBy: string;
		},
		opts: { idempotencyKey: string },
	): Promise<RecordFulfillmentResult> {
		try {
			requireIdToken("orderId", orderId);
			requireBoundedText("carrier", fulfillment.carrier, 1, 200);
			requireBoundedText("trackingNumber", fulfillment.trackingNumber, 1, 200);
			if (fulfillment.trackingUrl !== undefined && fulfillment.trackingUrl !== null) {
				requireTrackingUrl(fulfillment.trackingUrl);
			}
			if (fulfillment.shippedAt !== undefined && fulfillment.shippedAt !== null) {
				requireInstant("shippedAt", fulfillment.shippedAt);
			}
			requireBoundedText("recordedBy", fulfillment.recordedBy, 1, 200);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, status: 400 };
			throw err;
		}
		const key = fallbackKey(opts.idempotencyKey, `admin:fulfillment:${orderId}`);
		const res = await recordFulfillmentUseCase(
			{ orderStore: this.#stores.orderStore },
			{
				orderId: toOrderId(orderId),
				carrier: fulfillment.carrier,
				trackingNumber: fulfillment.trackingNumber,
				trackingUrl: fulfillment.trackingUrl ?? null,
				shippedAt: fulfillment.shippedAt ?? null,
				recordedBy: fulfillment.recordedBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) return { ok: true, recorded: res.recorded };
		if (res.reason === "ORDER_NOT_FOUND") return { ok: false, status: 404, reason: res.reason };
		if (res.reason === "NOT_FULFILLABLE") return { ok: false, status: 409, reason: res.reason };
		return { ok: false, status: 400, reason: res.reason };
	}

	/** POST cancel an order WITH a structured reason. Cancelling records the reason
	 *  envelope AND drives the `{pending,paid,processing} → cancelled` transition
	 *  AND enqueues the cancelled email, atomically — legality lives in the ONE
	 *  state machine, so an order that cannot reach `cancelled` is 409. */
	async cancelOrder(
		orderId: string,
		cancellation: { reason: string; detail?: string | null; cancelledBy: string },
		opts: { idempotencyKey: string },
	): Promise<CancelOrderResult> {
		let reason: CancellationReason;
		try {
			requireIdToken("orderId", orderId);
			reason = requireCancellationReason(cancellation.reason);
			if (cancellation.detail !== undefined && cancellation.detail !== null) {
				requireBoundedText("detail", cancellation.detail, 0, 4000);
			}
			requireBoundedText("cancelledBy", cancellation.cancelledBy, 1, 200);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, status: 400 };
			throw err;
		}
		const key = fallbackKey(opts.idempotencyKey, `admin:cancel:${orderId}`);
		const res = await cancelOrderUseCase(
			{ orderStore: this.#stores.orderStore },
			{
				orderId: toOrderId(orderId),
				reason,
				detail: cancellation.detail ?? null,
				cancelledBy: cancellation.cancelledBy,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) return { ok: true, cancelled: res.cancelled };
		if (res.reason === "ORDER_NOT_FOUND") return { ok: false, status: 404, reason: res.reason };
		if (res.reason === "NOT_CANCELLABLE") return { ok: false, status: 409, reason: res.reason };
		return { ok: false, status: 400, reason: res.reason };
	}

	/** GET an order's customer context (read-only). An unknown order resolves to
	 *  `null`, mirroring `getOrder`. The addresses here are the customer's MUTABLE
	 *  profile book — prefill/context only (ADR-0009), never "where this order
	 *  shipped", which is the order's own snapshot. */
	async getCustomerContext(orderId: string): Promise<CustomerContextWire | null> {
		requireIdToken("orderId", orderId);
		const context = await getOrderCustomerContext(
			{
				orderStore: this.#stores.orderStore,
				customerStore: this.#stores.customerStore,
				addressStore: this.#stores.addressStore,
				sessionStore: this.#stores.sessionStore,
			},
			toOrderId(orderId),
		);
		return context === null ? null : toCustomerContextWire(context);
	}

	/** GET an order's timeline (read-only). An unknown order resolves to `null`.
	 *  `stateChangesAudited: false` flags a historical order whose transitions
	 *  predate the audit table — a partial timeline, said out loud. */
	async getTimeline(orderId: string): Promise<OrderTimelineWire | null> {
		requireIdToken("orderId", orderId);
		const timeline = await getOrderTimeline(
			{ orderStore: this.#stores.orderStore, orderNotesStore: this.#stores.orderNotesStore },
			toOrderId(orderId),
		);
		return timeline === null ? null : toTimelineWire(timeline);
	}

	/**
	 * GET an order's refunds summary (ADR-0008): the append-only ledger plus the
	 * DERIVED ceiling / remaining-refundable and the gateway's honest `refundable`
	 * capability. An unknown order resolves to `null`.
	 *
	 * THE CEILING IS COMPOSED HERE because it was composed in the route: the
	 * domain exports the three summands (`sumCapturedPayments` over SUCCEEDED
	 * payments, `computeRefundCeiling` = `min(Σ captured, frozen total)`,
	 * `sumRefunds` over refunds whose status is not `voided`) and the route did the
	 * subtraction, flooring at zero. No shared helper is invented for it — the
	 * calculation is ported, the way `getTaxClasses` was.
	 */
	async getRefunds(orderId: string): Promise<RefundsSummaryWire | null> {
		requireIdToken("orderId", orderId);
		const oid = toOrderId(orderId);
		const order = await this.#stores.orderStore.getById(oid);
		if (order === null) return null;

		const [payments, refunds] = await Promise.all([
			this.#stores.orderStore.getCapturedPayments(oid),
			this.#stores.orderStore.listRefunds(oid),
		]);
		const capturedTotal = sumCapturedPayments(payments);
		const ceiling = computeRefundCeiling(capturedTotal, order.totals.total);
		const refundedTotal = sumRefunds(refunds);
		const remaining = Math.max(0, ceiling - refundedTotal);
		// The gateway's HONEST capability (ADR-0008): `refundable` true ⇒ money moves
		// via the provider; false ⇒ the admin records a manual/off-platform refund.
		// Never a button that silently no-ops — and with no gateway composed on this
		// tier yet, false is the truth rather than a placeholder.
		const gateway = order.paymentMethod === null ? undefined : this.#gateways[order.paymentMethod];
		return {
			refunds: refunds.map(toRefundWire),
			currency: order.totals.currency,
			capturedTotalCents: capturedTotal,
			refundedTotalCents: refundedTotal,
			ceilingCents: ceiling,
			remainingCents: remaining,
			paymentMethod: order.paymentMethod,
			refundable: gateway?.refundable ?? false,
		};
	}

	/**
	 * POST issue/record a refund (ADR-0008).
	 *
	 * The `Idempotency-Key` is REQUIRED — a refund is ADDITIVE, so two deliberate
	 * refunds must not collapse and there is no safe content-only fallback
	 * (mirrors restock). The order lookup comes next, then the gateway: with no
	 * gateway map composed on this tier yet (INC-C1/C3), every well-formed call
	 * against a real order lands on the route's own
	 * `409 REFUND_GATEWAY_UNAVAILABLE`. The use-case call below is the path that
	 * lights up the moment a gateway is wired — it is written now so the contract
	 * around it is the same one the HTTP tier answers.
	 */
	async refundOrder(
		orderId: string,
		refund: { amountCents: number; currency: string; reason?: string | null; refundedBy: string },
		opts: { idempotencyKey: string },
	): Promise<RefundOrderResult> {
		try {
			requireIdToken("orderId", orderId);
			requireRefundAmount(refund.amountCents);
			requireCurrencyCode("currency", refund.currency);
			if (refund.reason !== undefined && refund.reason !== null) {
				requireBoundedText("reason", refund.reason, 0, 4000);
			}
			requireBoundedText("refundedBy", refund.refundedBy, 1, 200);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, status: 400 };
			throw err;
		}
		if (opts.idempotencyKey.length === 0) {
			return { ok: false, status: 400, reason: "MISSING_IDEMPOTENCY_KEY" };
		}

		const oid = toOrderId(orderId);
		const order = await this.#stores.orderStore.getById(oid);
		if (order === null) return { ok: false, status: 404, reason: "ORDER_NOT_FOUND" };
		const gateway = order.paymentMethod === null ? undefined : this.#gateways[order.paymentMethod];
		if (gateway === undefined) {
			// No gateway wired for the order's method — cannot even record a refund
			// against it (the domain needs a gateway to declare capability).
			return { ok: false, status: 409, reason: "REFUND_GATEWAY_UNAVAILABLE" };
		}

		const res = await refundOrderUseCase(
			{
				orderStore: this.#stores.orderStore,
				paymentEventStore: this.#stores.paymentEventStore,
				clock: this.#stores.clock,
			},
			gateway,
			{
				orderId: oid,
				amount: toCents(refund.amountCents),
				currency: toCurrency(refund.currency),
				reason: refund.reason ?? null,
				refundedBy: refund.refundedBy,
				idempotencyKey: toIdempotencyKey(opts.idempotencyKey),
			},
		);
		if (res.ok) {
			return {
				ok: true,
				recorded: res.recorded,
				duplicate: res.duplicate,
				fullyRefunded: res.fullyRefunded,
			};
		}
		return { ok: false, status: refundFailureStatus(res.reason), reason: res.reason };
	}

	/** GET an order's append-only notes, oldest first (the store's own order). An
	 *  order with no notes — including one that does not exist — is an empty list,
	 *  exactly as the route answers it. */
	async listNotes(orderId: string): Promise<OrderNoteWire[]> {
		requireIdToken("orderId", orderId);
		const notes = await listOrderNotes(
			{ orderNotesStore: this.#stores.orderNotesStore },
			toOrderId(orderId),
		);
		return notes.map(toNoteWire);
	}

	/** POST a new note. A note must hang off a real order (404 otherwise); the
	 *  domain trims and refuses a blank author/body (400). */
	async addNote(
		orderId: string,
		note: { author: string; body: string },
		opts: { idempotencyKey: string },
	): Promise<AddNoteResult> {
		try {
			requireIdToken("orderId", orderId);
			requireBoundedText("author", note.author, 1, 200);
			requireBoundedText("body", note.body, 1, 4000);
		} catch (err) {
			if (isCommerceInputError(err)) return { ok: false, status: 400 };
			throw err;
		}
		const key = fallbackKey(
			opts.idempotencyKey,
			`admin:note:${orderId}:${note.author}:${note.body}`,
		);
		const res = await appendOrderNote(
			{ orderNotesStore: this.#stores.orderNotesStore, orderStore: this.#stores.orderStore },
			{
				orderId: toOrderId(orderId),
				author: note.author,
				body: note.body,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) return { ok: true, appended: res.appended, note: toNoteWire(res.note) };
		// The add-note surface carries no `reason` on the wire — only the status.
		return { ok: false, status: res.reason === "ORDER_NOT_FOUND" ? 404 : 400 };
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
		asked: OrderListFilter,
		askedLimitRaw: number | undefined,
		askedLimit: number,
	): { filter: OrderListFilter; pos: OrderListCursor; limit: number } | null {
		const decoded = decodeOrderCursor(token);
		if (decoded === null) return null;
		const pos = orderCursorPosOf(decoded.pos);
		if (pos === null) return null;
		const tokenFilter = revalidateFilter(decoded.filter);
		if (tokenFilter === null) return null;
		const limit = clampLimit(decoded.limit, askedLimit);
		// PRESENCE, not value: a caller that named no axis claims nothing, so a
		// cursor-alone request is never compared against the filter its token
		// carries.
		if (hasFilterAxes(asked) && canonicalFilter(asked) !== canonicalFilter(tokenFilter)) {
			return null;
		}
		if (askedLimitRaw !== undefined && askedLimitRaw !== limit) return null;
		return { filter: tokenFilter, pos, limit };
	}

	/** The page and its EXACT count, under ONE filter, in parallel — sharing the
	 *  filter is what lets the count describe the page it captions. */
	async #page(
		filter: OrderListFilter,
		pos: OrderListCursor | null,
		limit: number,
	): Promise<OrdersListResult> {
		const [result, total] = await Promise.all([
			this.#stores.orderStore.listOrders(filter, { cursor: pos, limit }),
			this.#stores.orderStore.countOrders(filter),
		]);
		return {
			orders: result.orders.map(toOrderSummaryWire),
			nextCursor:
				result.nextCursor === null ? null : encodeOrderCursor(result.nextCursor, filter, limit),
			total,
		};
	}
}

// ── the wire projections, field for field ─────────────────────────────────

/** `serializeOrderSummary`'s twin. Money stays an integer minor unit + an
 *  ISO-4217 currency string; `reconciliationFlag` is the boolean badge (the list
 *  never leaks the free-text reconciliation detail — the full order does). */
function toOrderSummaryWire(summary: OrderSummary): OrderSummaryWire {
	return {
		id: summary.id,
		state: summary.state,
		currency: summary.currency,
		buyerRef: summary.buyerRef,
		customerId: summary.customerId,
		paymentMethod: summary.paymentMethod,
		createdAt: summary.createdAt,
		totalCents: summary.total,
		reconciliationFlag: summary.reconciliationFlag,
	};
}

/** `serializeOrder`'s twin — the full mutable envelope plus the SNAPSHOT halves
 *  (lines and totals were frozen at purchase time; `shippingAddress` was captured
 *  at checkout, ADR-0009, and is read off the order rather than the live address
 *  book). */
function toOrderDetailWire(order: Order): OrderDetailWire {
	return {
		id: order.id,
		state: order.state,
		currency: order.currency,
		paymentMethod: order.paymentMethod,
		buyerRef: order.buyerRef,
		customerId: order.customerId,
		holdExpiresAt: order.holdExpiresAt,
		createdAt: order.createdAt,
		reconciliationFlag: order.reconciliationFlag,
		reconciliationResolution: order.reconciliationResolution,
		fulfillment: order.fulfillment,
		cancellation: order.cancellation,
		shippingAddress: order.shippingAddress,
		totals: {
			currency: order.totals.currency,
			subtotalCents: order.totals.subtotal,
			discountCents: order.totals.discount,
			shippingCents: order.totals.shipping,
			taxCents: order.totals.tax,
			totalCents: order.totals.total,
			appliedCouponCode: order.totals.appliedCouponCode,
			// ADR-0009 (admin display-only juxtaposition): the chosen zone, read off
			// the totals' method snapshot so the console can render the captured
			// ship-to country NEXT TO the priced zone. No matching/validation.
			shippingZoneId: shippingZoneIdOf(order.totals.shippingMethodSnapshot),
		},
		lines: order.lines.map((l) => ({
			sku: l.sku,
			title: l.title,
			unitPriceCents: l.unitPrice,
			currency: l.currency,
			quantity: l.quantity,
			fulfillmentKind: l.fulfillmentKind,
		})),
	};
}

/** `shippingZoneIdOf`'s twin: read the zone id off the opaque method snapshot
 *  (`{ zoneId, methodId }`), null when absent/malformed. Display-only. */
function shippingZoneIdOf(snapshot: unknown): string | null {
	if (snapshot === null || typeof snapshot !== "object") return null;
	const zoneId = (snapshot as { zoneId?: unknown }).zoneId;
	return typeof zoneId === "string" ? zoneId : null;
}

/** `serializeCustomerContext`'s twin — the domain shape 1:1: identity + linkage,
 *  the profile address book, TOKEN-FREE session summaries (no token, no hash,
 *  ever), and the order aggregates reusing the list summary shape. */
function toCustomerContextWire(context: OrderCustomerContext): CustomerContextWire {
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
		recentOrders: context.recentOrders.map(toOrderSummaryWire),
	};
}

/** `serializeTimeline`'s twin — a chronological list of discriminated entries
 *  spread AS THEY ARE (each `kind` populates its own fields; an unknown/future
 *  kind degrades to a bare `at` row rather than throwing), plus
 *  `stateChangesAudited`. No presentation strings and no money on this surface. */
function toTimelineWire(timeline: OrderTimeline): OrderTimelineWire {
	return {
		orderId: timeline.orderId,
		stateChangesAudited: timeline.stateChangesAudited,
		entries: timeline.entries.map((e) => ({ ...e })),
	};
}

/** `serializeRefund`'s twin, minus `status`: the plugin's `RefundWire` has never
 *  declared that field and no console reads it, so this tier matches the PLUGIN's
 *  wire type rather than adding a key the type says does not exist. Money is an
 *  integer minor `amountCents` + an ISO-4217 currency — never a float. */
function toRefundWire(refund: RefundRecord): RefundWire {
	return {
		id: refund.id,
		orderId: refund.orderId,
		amountCents: refund.amount,
		currency: refund.currency,
		kind: refund.kind,
		gateway: refund.gateway,
		// The WIRE field is `refundRef` (the provider's own refund id), not
		// `providerRef` — whatever a React prop elsewhere happens to be called.
		refundRef: refund.refundRef,
		reason: refund.reason,
		refundedBy: refund.refundedBy,
		createdAt: refund.createdAt,
	};
}

/** `serializeNote`'s twin. A plain annotation — no money, no branded ids beyond
 *  the string id. */
function toNoteWire(note: OrderNote): OrderNoteWire {
	return {
		id: note.id,
		orderId: note.orderId,
		author: note.author,
		body: note.body,
		createdAt: note.createdAt,
	};
}

/** `refundFailureStatus`'s twin (ADR-0008). Malformed input → 400; ceiling /
 *  capability / provider-divergence conflicts → 409; a definite provider
 *  rejection → 502; a transient transport failure → 503; the ambiguous timeout →
 *  409 (the caller must RE-CHECK before retrying, never auto-retry). */
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
		// so it is never conflated with a clean pre-issuance rejection.
		case "REFUND_ISSUED_UNRECORDED":
			return 409;
		case "GATEWAY_TERMINAL":
			return 502;
		case "GATEWAY_RETRYABLE":
			return 503;
	}
}

// ── the input bounds the request schemas used to hold ─────────────────────

/** The caller's `Idempotency-Key`, or the route's own stable fallback, so a
 *  header-less double-submit dedupes on the guarded flip rather than inserting
 *  twice. Ported verbatim per command — the fallback strings are behaviour. */
function fallbackKey(key: string, fallback: string): string {
	return key.length > 0 ? key : fallback;
}

/**
 * The caller's filter as a domain `OrderListFilter`.
 *
 * AN EMPTY VALUE IS AN ABSENT AXIS, not an empty one — the HTTP client omits a
 * zero-length `search`/`from`/`to` and an empty `states` array from its query
 * string entirely, so honouring one here would filter on a value the other
 * transport never sends.
 */
function toDomainFilter(filter: OrdersListFilter): OrderListFilter {
	const out: OrderListFilter = {};
	if (filter.states !== undefined && filter.states.length > 0) {
		out.states = filter.states.map((s) => requireOrderState("states", s));
	}
	if (filter.from !== undefined && filter.from.length > 0) {
		out.from = requireInstant("from", filter.from);
	}
	if (filter.to !== undefined && filter.to.length > 0) out.to = requireInstant("to", filter.to);
	if (filter.search !== undefined && filter.search.length > 0) {
		out.search = requireBoundedText("search", filter.search, 1, 200);
	}
	return out;
}

/** Exactly the shared `orderStateEnum`, read off the ONE state machine so a new
 *  state cannot be accepted here without appearing there. */
function requireOrderState(field: string, value: string): OrderState {
	if (!Object.hasOwn(ORDER_STATE_MACHINE, value)) {
		throw new CommerceInputError(field, "must be a known order state");
	}
	return value as OrderState;
}

const RECONCILIATION_OUTCOMES = [
	"refunded",
	"fulfilled",
	"written_off",
] as const satisfies readonly ReconciliationOutcome[];

function requireReconciliationOutcome(value: string): ReconciliationOutcome {
	if (!RECONCILIATION_OUTCOMES.includes(value as ReconciliationOutcome)) {
		throw new CommerceInputError("outcome", "must be a known reconciliation outcome");
	}
	return value as ReconciliationOutcome;
}

const CANCELLATION_REASONS = [
	"customer_request",
	"fraud_suspected",
	"out_of_stock",
	"pricing_error",
	"other",
] as const satisfies readonly CancellationReason[];

function requireCancellationReason(value: string): CancellationReason {
	if (!CANCELLATION_REASONS.includes(value as CancellationReason)) {
		throw new CommerceInputError("reason", "must be a known cancellation reason");
	}
	return value as CancellationReason;
}

/** `recordFulfillmentBody`'s tracking-URL bound: at most 2000 characters and an
 *  http(s) URL with no whitespace. */
function requireTrackingUrl(value: string): string {
	requireBoundedText("trackingUrl", value, 0, 2000);
	if (value.length > 0 && !/^https?:\/\/\S+$/i.test(value)) {
		throw new CommerceInputError("trackingUrl", "must be an http(s) URL");
	}
	return value;
}

/** `refundOrderBody`'s amount bound: a positive integer minor amount within the
 *  schema's sanity ceiling. Never a float, never a bare zero. */
function requireRefundAmount(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_REFUND_AMOUNT_CENTS) {
		throw new CommerceInputError("amountCents", "must be a positive integer minor amount");
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

/**
 * Exactly what `z.string().datetime()` accepts — the validator the service's own
 * query and cursor schemas put in front of every instant field: an RFC-3339
 * instant in UTC, optional fractional seconds, a literal `Z` and no numeric
 * offset.
 *
 * MIRRORED RATHER THAN APPROXIMATED, because these values are compared
 * LEXICOGRAPHICALLY by the store's window and keyset predicates. `Date.parse`
 * alone accepts `"Jan 5, 2026"` and `"2026-01-01"` — real instants, neither of
 * them `toISOString()`-shaped — and one of those reaching the store would page
 * or window from somewhere the operator never asked for. A divergence in the
 * fail-OPEN direction is the one kind this boundary must not have.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function requireInstant(field: string, value: string): string {
	if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
		throw new CommerceInputError(field, "must be an ISO-8601 UTC instant");
	}
	return value;
}

// ── the opaque cursor, ported from the route ──────────────────────────────

interface DecodedCursor {
	pos: unknown;
	filter: unknown;
	limit: unknown;
}

/** Encode the keyset position + the ACTIVE filter + the clamped limit, so paging
 *  preserves both. */
function encodeOrderCursor(pos: OrderListCursor, filter: OrderListFilter, limit: number): string {
	const payload = { pos: { createdAt: pos.createdAt, id: pos.id }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode a token; `null` on ANY malformed/tampered/garbage input, so a bad token
 *  is a refusal rather than a throw. */
function decodeOrderCursor(token: string): DecodedCursor | null {
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

/** `cursorPosOf`'s twin: `{ createdAt: <ISO instant>, id: <opaque, bounded> }`,
 *  or null when malformed. The regex pins the spelling the keyset comparison
 *  depends on; `Date.parse` rejects the shapes that match it and name no real day
 *  (`2026-02-31`). */
function orderCursorPosOf(pos: unknown): OrderListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; id?: unknown };
	if (typeof p.createdAt !== "string" || !ISO_INSTANT.test(p.createdAt)) return null;
	if (Number.isNaN(Date.parse(p.createdAt))) return null;
	if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 200) return null;
	return { createdAt: p.createdAt, id: toOrderId(p.id) };
}

/**
 * RE-VALIDATE the decoded filter before trusting it — the token is
 * operator-round-tripped input like any other. `null` ⇒ refuse.
 *
 * AN UNKNOWN AXIS IS A REFUSAL HERE, AND A STRIP ON THE WIRE — the same
 * divergence `InProcessAdminProductsClient` records, for the same reason. The
 * service's `orderListFilterSchema` is non-strict, so a token carrying an axis it
 * does not know silently loses it and the page comes back under a predicate that
 * is not the one the token claimed. Refusing costs a `cursorRejected` page one —
 * visible, flagged, recoverable. So this side stays narrower ON PURPOSE; the only
 * way to reach it at all is a hand-made or edited token.
 */
function revalidateFilter(filter: unknown): OrderListFilter | null {
	if (filter === null || typeof filter !== "object") return null;
	const f = filter as Record<string, unknown>;
	const out: OrderListFilter = {};
	for (const key of Object.keys(f)) {
		if (!ORDER_FILTER_AXES.includes(key as (typeof ORDER_FILTER_AXES)[number])) return null;
	}
	if (f["states"] !== undefined) {
		const states = f["states"];
		if (!Array.isArray(states)) return null;
		const parsed: OrderState[] = [];
		for (const s of states as unknown[]) {
			if (typeof s !== "string" || !Object.hasOwn(ORDER_STATE_MACHINE, s)) return null;
			parsed.push(s as OrderState);
		}
		if (parsed.length > 0) out.states = parsed;
	}
	for (const bound of ["from", "to"] as const) {
		const value = f[bound];
		if (value === undefined) continue;
		if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
			return null;
		}
		out[bound] = value;
	}
	if (f["search"] !== undefined) {
		const search = f["search"];
		if (typeof search !== "string" || search.length === 0 || search.length > 200) return null;
		out.search = search;
	}
	return out;
}

/** Every FILTER axis — written out so that adding one without teaching the
 *  presence check about it is a compile error, not a silently unguarded axis a
 *  cursor request could then contradict for free. */
const ORDER_FILTER_AXES = [
	"states",
	"from",
	"to",
	"search",
] as const satisfies readonly (keyof OrderListFilter)[];

/** Did the caller SPELL OUT any filter axis? Presence, not value. */
function hasFilterAxes(filter: OrderListFilter): boolean {
	return ORDER_FILTER_AXES.some((axis) => filter[axis] !== undefined);
}

/**
 * A filter rendered so two filters compare as PREDICATES rather than as JSON
 * text: key order is irrelevant, an absent axis and an `undefined` one are the
 * same thing, an OR-able array is a SET (sorted, deduped — `states=paid,cancelled`
 * and `states=cancelled,paid,paid` select the same rows), and a window bound is an
 * INSTANT rather than a spelling (`…T00:00:00Z` and `…T00:00:00.000Z` are the same
 * moment). Case is deliberately not folded: the store's own case-insensitivity is
 * the store's business, and a token round-trips whatever the caller said.
 *
 * There is no order-side `isNoOpAxis`: the one axis with a no-op value
 * (`deleted: false`) is a PRODUCTS axis. Orders have no tombstone filter.
 */
function canonicalFilter(filter: OrderListFilter): string {
	const entries = (Object.entries(filter) as [string, unknown][])
		.filter(([, value]) => value !== undefined)
		.map(([key, value]): [string, unknown] => [key, canonicalFilterValue(key, value)])
		.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(entries);
}

function canonicalFilterValue(key: string, value: unknown): unknown {
	if (Array.isArray(value)) return [...new Set(value as unknown[])].toSorted();
	if ((key === "from" || key === "to") && typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? value : new Date(ms).toISOString();
	}
	return value;
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
	const bin = atob(b64); // throws on invalid base64 ⇒ caught by decodeOrderCursor
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
