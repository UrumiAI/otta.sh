import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
import type {
	ActionsBlock,
	AdminPageConfig,
	Block,
	ButtonElement,
	FormBlock,
	RouteHandler,
	SelectOption,
	TableBlock,
} from "../types.js";
import {
	AdminOrdersClient,
	type CustomerContextWire,
	type OrderAddressWire,
	type OrderCancellationWire,
	type OrderDetailResult,
	type OrderDetailWire,
	type OrderFulfillmentWire,
	type OrderNoteWire,
	type OrderSummaryWire,
	type OrdersListFilter,
	type OrderTimelineWire,
	type RefundsSummaryWire,
	type RefundWire,
	type TimelineEntryWire,
} from "./admin-orders-client.js";
import {
	asRecord,
	backButton,
	createListDetailHandler,
	customAction,
	failClosedResponse,
	leafLevel,
	listLevel,
	noticeBanner,
	readAdminTokens,
	readString,
	screenActions,
	type ListDetailInput,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/** The admin Orders console page's `admin.pages` manifest entry. View-only:
 *  browse orders + drill into one + fire a legal status transition. Rendered by
 *  the single `admin` dispatch route (see `admin-route.ts`). Built on the shared
 *  list/detail scaffold (`./scaffold`) — the first screen to prove that pattern. */
export const ORDERS_PAGE: AdminPageConfig = { path: "/orders", label: "Orders", icon: "receipt" };

/** This screen's namespaced action ids — the four scaffold nav verbs plus the
 *  two Orders-specific side-effecting verbs. */
const ORDERS_ACTIONS: ScreenActions = screenActions("orders");
const ACTION_TRANSITION = ORDERS_ACTIONS.custom("transition");
const ACTION_ADD_NOTE = ORDERS_ACTIONS.custom("add-note");
const ACTION_RESOLVE = ORDERS_ACTIONS.custom("resolve-reconciliation");
const ACTION_RECORD_FULFILLMENT = ORDERS_ACTIONS.custom("record-fulfillment");
const ACTION_CANCEL = ORDERS_ACTIONS.custom("cancel");
const ACTION_REFUND = ORDERS_ACTIONS.custom("refund");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Orders console (MOD-2). Every `block_action`/`form_submit` this page can emit
 * is namespaced `orders:*` and listed here, so NONE falls through the dispatcher
 * to the `{blocks:[]}` dead-end. `orders:page` is ALSO the table's
 * `page_action_id` (em-dash's "Load more" fires it).
 */
export const ORDERS_ACTION_IDS: ReadonlySet<string> = ORDERS_ACTIONS.actionIds(
	"transition",
	"add-note",
	"resolve-reconciliation",
	"record-fulfillment",
	"cancel",
	"refund",
);

const PAGE_LIMIT = 25;

/** The ten order states offered in the status filter (plus an "all" sentinel). */
const ORDER_STATES = [
	"pending",
	"paid",
	"failed",
	"expired",
	"processing",
	"shipped",
	"delivered",
	"completed",
	"cancelled",
	"refunded",
] as const;

/** Destructive transitions get a danger style + a confirm dialog. */
const DANGER_STATES: ReadonlySet<string> = new Set(["cancelled", "refunded"]);

/** The console's own filter form values (single-status select), kept alongside
 *  the opaque service cursor so paging preserves the form (MOD-9). */
interface OrdersFilterForm {
	status?: string;
	from?: string;
	to?: string;
	search?: string;
}

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type OrdersPageInput = ListDetailInput;

export function createOrdersPageHandler(): RouteHandler<OrdersPageInput> {
	return createListDetailHandler({
		actions: ORDERS_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminOrdersClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// A list row's "Open order" form carries the order id in `values.orderId`;
		// the target is a single-level drill, so the path is just `[orderId]`.
		parseOpen(input) {
			const orderId = readString(input.values?.orderId);
			return orderId === undefined ? undefined : { targetPath: [orderId] };
		},
		levels: [ordersListLevel(), orderDetailLevel()],
		customActions: {
			[ACTION_TRANSITION]: transitionAction(),
			[ACTION_ADD_NOTE]: addNoteAction(),
			[ACTION_RESOLVE]: resolveReconciliationAction(),
			[ACTION_RECORD_FULFILLMENT]: recordFulfillmentAction(),
			[ACTION_CANCEL]: cancelOrderAction(),
			[ACTION_REFUND]: refundOrderAction(),
		},
	});
}

// -- level 0: the orders list -------------------------------------------------

function ordersListLevel() {
	return listLevel<AdminOrdersClient, OrdersFilterForm, OrderSummaryWire>({
		limit: PAGE_LIMIT,
		filterFromValues,
		async fetchPage(client, _path, form, opts) {
			const page = await client.listOrders(toClientFilter(form), {
				limit: opts.limit,
				...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
			});
			return { items: page.orders, nextCursor: page.nextCursor };
		},
		render({ actions, filter, items, nextToken }) {
			return listBlocks(actions, filter, items, nextToken);
		},
		onError: () => failClosed(),
	});
}

function listBlocks(
	actions: ScreenActions,
	form: OrdersFilterForm,
	orders: OrderSummaryWire[],
	nextToken: string | undefined,
): Block[] {
	const table: TableBlock = {
		type: "table",
		columns: [
			{ key: "id", label: "Order #", format: "code" },
			{ key: "createdAt", label: "Created", format: "relative_time" },
			{ key: "state", label: "Status", format: "badge" },
			{ key: "customer", label: "Customer" },
			{ key: "total", label: "Total" },
		],
		rows: orders.map((o) => ({
			id: o.id,
			createdAt: o.createdAt,
			state: o.state,
			customer: o.customerId ?? o.buyerRef,
			total: formatTotal(o.totalCents, o.currency),
		})),
		page_action_id: actions.page,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text: "No orders match these filters.",
	};

	const blocks: Block[] = [
		{ type: "header", text: "Orders" },
		{
			type: "context",
			text: "View-only console. Filter, open an order, and move it through its status flow. Money shown as the order currency; dates in UTC.",
		},
		filterForm(actions, form),
		table,
	];
	if (orders.length > 0) blocks.push(openOrderForm(actions, orders));
	return blocks;
}

function filterForm(actions: ScreenActions, form: OrdersFilterForm): FormBlock {
	const statusOptions: SelectOption[] = [
		{ value: "", label: "All statuses" },
		...ORDER_STATES.map((s) => ({ value: s, label: s })),
	];
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "status",
				label: "Status",
				options: statusOptions,
				initial_value: form.status ?? "",
			},
			{
				type: "date_input",
				action_id: "from",
				label: "From (inclusive)",
				...(form.from !== undefined ? { initial_value: form.from } : {}),
			},
			{
				type: "date_input",
				action_id: "to",
				label: "To (exclusive)",
				...(form.to !== undefined ? { initial_value: form.to } : {}),
			},
			{
				type: "text_input",
				action_id: "search",
				label: "Search (order id or buyer email)",
				...(form.search !== undefined ? { initial_value: form.search } : {}),
			},
		],
		submit: { label: "Apply filters", action_id: actions.applyFilter },
	};
}

function openOrderForm(actions: ScreenActions, orders: OrderSummaryWire[]): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "orderId",
				label: "Open order",
				options: orders.map((o) => ({ value: o.id, label: `${o.id} — ${o.state}` })),
			},
		],
		submit: { label: "Open order", action_id: actions.open },
	};
}

// -- level 1: the order detail ------------------------------------------------

function orderDetailLevel() {
	return leafLevel<AdminOrdersClient, OrderDetailResult>({
		load: (client, _path, id) => client.getOrder(id),
		async render({ client, actions, id, detail, notice }) {
			// Notes, customer context, and the timeline are SECONDARY surfaces: any
			// one read failing must not blank the whole detail view — each degrades
			// independently (empty notes / an "unavailable" customer or timeline
			// section), never fail closed. Fetched in parallel to avoid serial
			// round-trip latency.
			const [notes, customerContext, timeline, refunds] = await Promise.all([
				client.listNotes(id).catch((): OrderNoteWire[] => []),
				client.getCustomerContext(id).catch((): CustomerContextWire | null => null),
				client.getTimeline(id).catch((): OrderTimelineWire | null => null),
				client.getRefunds(id).catch((): RefundsSummaryWire | null => null),
			]);
			return detailBlocks(actions, detail, notes, customerContext, timeline, refunds, notice);
		},
		notFound({ actions, id }) {
			return [
				{ type: "header", text: "Order not found" },
				backButton(actions.back, "← Back to orders"),
				{
					type: "banner",
					variant: "error",
					title: "Order not found",
					description: `No order matches "${id}".`,
				},
			];
		},
		onError: () => failClosed(),
	});
}

function detailBlocks(
	actions: ScreenActions,
	detail: OrderDetailResult,
	notes: OrderNoteWire[],
	customerContext: CustomerContextWire | null,
	timeline: OrderTimelineWire | null,
	refunds: RefundsSummaryWire | null,
	notice: Notice | undefined,
): Block[] {
	const o = detail.order;
	const blocks: Block[] = [
		{ type: "header", text: `Order ${o.id}` },
		backButton(actions.back, "← Back to orders"),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Status", value: o.state },
			{ label: "Customer", value: o.customerId ?? o.buyerRef },
			{ label: "Payment", value: o.paymentMethod ?? "—" },
			{ label: "Created (UTC)", value: o.createdAt },
			{ label: "Reconciliation", value: reconciliationSummary(o) },
		],
	});
	// The reconciliation surface is PROMINENT (right below the header fields): an
	// open flag gets an alert banner + the resolve form; a resolved flag shows the
	// recorded disposition. A never-flagged order shows nothing here.
	for (const block of reconciliationBlocks(o)) blocks.push(block);
	// -- Customer (admin-UX Increment 1) — read-only context, above line items --
	for (const block of customerContextBlocks(actions, customerContext)) blocks.push(block);
	blocks.push({ type: "section", text: "Line items" });
	blocks.push({
		type: "table",
		columns: [
			{ key: "sku", label: "SKU", format: "code" },
			{ key: "title", label: "Title" },
			{ key: "quantity", label: "Qty", format: "number" },
			{ key: "unitPrice", label: "Unit price" },
			{ key: "currency", label: "Currency", format: "badge" },
		],
		rows: o.lines.map((l) => ({
			sku: l.sku,
			title: l.title,
			quantity: l.quantity,
			unitPrice: formatTotal(l.unitPriceCents, l.currency),
			currency: l.currency,
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text: "No line items.",
	});
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Subtotal", value: formatTotal(o.totals.subtotalCents, o.totals.currency) },
			{ label: "Discount", value: formatTotal(o.totals.discountCents, o.totals.currency) },
			{ label: "Shipping", value: formatTotal(o.totals.shippingCents, o.totals.currency) },
			{ label: "Tax", value: formatTotal(o.totals.taxCents, o.totals.currency) },
			{ label: "Total", value: formatTotal(o.totals.totalCents, o.totals.currency) },
		],
	});
	// -- Shipping address (ADR-0009) — the immutable ship-to captured at checkout --
	for (const block of shippingAddressBlocks(o)) blocks.push(block);
	// -- Fulfillment (admin-UX Increment 1) — recorded tracking + the ship form --
	for (const block of fulfillmentBlocks(o)) blocks.push(block);
	// -- Cancellation (admin-UX Increment 1, "cancel with reason") --------------
	for (const block of cancellationBlocks(o, detail)) blocks.push(block);
	// -- Refunds (ADR-0008) — the ledger + remaining-refundable + the refund form -
	for (const block of refundsBlocks(actions, o, refunds)) blocks.push(block);
	// UI steering (PR #63 review, extended here to cancel): on a `processing`
	// order, the bare "Mark shipped" one-click is HIDDEN — it would ship without
	// tracking and send the buyer an empty shipped email, defeating the
	// fulfillment slice's whole point. Shipping happens via the Fulfillment form
	// above (which records tracking and ships atomically). Likewise, whenever
	// `cancelled` is a legal target, the bare "Mark cancelled" one-click is HIDDEN
	// — cancelling without a reason defeats this slice's whole point — steered to
	// the Cancel form above instead. This is UI steering only: the SERVICE still
	// accepts both bare transitions for other callers/back-compat.
	const offeredTransitions = detail.allowedTransitions.filter((t) => {
		if (o.state === "processing" && t === "shipped") return false;
		if (t === "cancelled") return false;
		return true;
	});
	if (offeredTransitions.length > 0) {
		blocks.push({ type: "section", text: "Move status" });
		if (o.state === "processing" && detail.allowedTransitions.includes("shipped")) {
			blocks.push({
				type: "context",
				text: "To mark this order shipped, use the Fulfillment form above — it records the tracking and emails it to the buyer. There is deliberately no bare “Mark shipped” button, so an order is never shipped without tracking.",
			});
		}
		if (detail.allowedTransitions.includes("cancelled")) {
			blocks.push({
				type: "context",
				text: "To cancel this order, use the Cancel form above — it records a reason. There is deliberately no bare “Mark cancelled” button, so an order is never cancelled without a reason on file.",
			});
		}
		blocks.push(transitionActions(o.id, offeredTransitions));
	}
	// -- Notes (append-only) ---------------------------------------------------
	blocks.push({ type: "section", text: "Notes" });
	blocks.push(notesTable(actions, notes));
	blocks.push(addNoteForm(o.id));
	// -- Timeline (admin-UX Increment 1) — read-only chronological history -----
	for (const block of timelineBlocks(actions, timeline)) blocks.push(block);
	return blocks;
}

// -- customer context (admin-UX Increment 1) ----------------------------------

/**
 * The read-only "Customer" panel on the order detail: who the customer is
 * (honestly labeled — see `accountSummary`), their profile address book (labeled
 * prefill/context only — the order's own frozen ship-to is shown above under
 * "Shipping address", ADR-0009), token-free session history, and their other
 * orders under the union customer key. `null` (the context read failed or the order vanished
 * mid-view) renders an explicit "unavailable" body — the section is never
 * silently blank and never blanks the rest of the detail view.
 */
function customerContextBlocks(actions: ScreenActions, ctx: CustomerContextWire | null): Block[] {
	const blocks: Block[] = [{ type: "section", text: "Customer" }];
	if (ctx === null) {
		blocks.push({
			type: "context",
			text: "Customer context unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.",
		});
		return blocks;
	}
	const identity = ctx.identity;
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Email", value: identity.email ?? "— (no account)" },
			{ label: "Buyer reference", value: identity.buyerRef },
			{ label: "Name", value: identity.displayName ?? "—" },
			{ label: "Account", value: accountSummary(identity) },
			{ label: "Email verified (UTC)", value: identity.emailVerifiedAt ?? "not verified" },
			{ label: "Total orders", value: String(ctx.orderCount) },
		],
	});
	if (identity.linkage === "unclaimed") {
		blocks.push({
			type: "context",
			text: "An account exists for this email, but this order is not yet claimed by it — guest orders link automatically at the customer's next sign-in.",
		});
	}
	// Saved addresses — the customer's mutable PROFILE book, prefill/context only
	// (ADR-0009). The order's own frozen ship-to is shown above under "Shipping
	// address"; this book is not it, and a later edit here never rewrites a placed
	// order's destination.
	blocks.push({ type: "section", text: "Saved addresses" });
	blocks.push({
		type: "context",
		text: "Profile address book — prefill/context only. The address this order shipped to is shown above under “Shipping address”; this book is the customer's current saved addresses and can change at any time.",
	});
	blocks.push({
		type: "table",
		columns: [
			{ key: "kind", label: "Kind", format: "badge" },
			{ key: "name", label: "Name" },
			{ key: "address", label: "Address" },
			{ key: "isDefault", label: "Default" },
		],
		rows: ctx.addresses.map((a) => ({
			kind: a.kind,
			name: a.name,
			address: [a.line1, a.line2, a.city, a.region, a.postalCode, a.country]
				.filter((part): part is string => part !== null && part.length > 0)
				.join(", "),
			isDefault: a.isDefault ? "yes" : "",
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text:
			identity.linkage === "guest"
				? "No saved addresses (guests have no address book)."
				: "No saved addresses.",
	});
	// Sign-in sessions — metadata only; no token-like value exists on the wire.
	blocks.push({ type: "section", text: "Sign-in sessions" });
	blocks.push({
		type: "table",
		columns: [
			{ key: "createdAt", label: "Signed in", format: "relative_time" },
			{ key: "expiresAt", label: "Expires (UTC)" },
			{ key: "revokedAt", label: "Revoked (UTC)" },
		],
		rows: ctx.sessions.map((s) => ({
			createdAt: s.createdAt,
			expiresAt: s.expiresAt,
			revokedAt: s.revokedAt ?? "—",
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text:
			identity.linkage === "guest" ? "No sessions (guests never sign in)." : "No sessions.",
	});
	// The person's OTHER most-recent orders (the viewed order is excluded
	// server-side). Display-only — the list screen remains the drill-in surface.
	blocks.push({ type: "section", text: "Other recent orders" });
	blocks.push({
		type: "table",
		columns: [
			{ key: "id", label: "Order #", format: "code" },
			{ key: "createdAt", label: "Created", format: "relative_time" },
			{ key: "state", label: "Status", format: "badge" },
			{ key: "total", label: "Total" },
		],
		rows: ctx.recentOrders.map((o) => ({
			id: o.id,
			createdAt: o.createdAt,
			state: o.state,
			total: formatTotal(o.totalCents, o.currency),
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text: "No other orders from this customer.",
	});
	return blocks;
}

/** The honest account line: claimed / unclaimed / guest — a known account must
 *  never read as "Guest" just because THIS order predates its next sign-in. */
function accountSummary(identity: CustomerContextWire["identity"]): string {
	if (identity.linkage === "claimed") return identity.customerId ?? "—";
	if (identity.linkage === "unclaimed") {
		return `${identity.customerId ?? "—"} (order not yet claimed)`;
	}
	return identity.customerId === null
		? "Guest — no account"
		: `Guest — account record missing (${identity.customerId})`;
}

/** The order's notes, oldest-first (append order). Display-only table — no in-cell
 *  action (Block Kit tables are display-only; the add-note form below is the
 *  write surface). */
function notesTable(actions: ScreenActions, notes: OrderNoteWire[]): TableBlock {
	return {
		type: "table",
		columns: [
			{ key: "createdAt", label: "When (UTC)", format: "relative_time" },
			{ key: "author", label: "Author" },
			{ key: "body", label: "Note" },
		],
		rows: notes.map((n) => ({ createdAt: n.createdAt, author: n.author, body: n.body })),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text: "No notes yet.",
	};
}

/** The add-note form. The current order id rides along as a single-option
 *  `select` (the same carry-the-id-in-values pattern as the list's open-order
 *  form) so a stateless `form_submit` knows which order to append to. */
function addNoteForm(orderId: string): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "orderId",
				label: "Order",
				options: [{ value: orderId, label: orderId }],
				initial_value: orderId,
			},
			{ type: "text_input", action_id: "author", label: "Author", placeholder: "e.g. your name" },
			{ type: "text_input", action_id: "body", label: "Note", placeholder: "Add a note…" },
		],
		submit: { label: "Add note", action_id: ACTION_ADD_NOTE },
	};
}

// -- timeline surface (admin-UX Increment 1) ----------------------------------

/**
 * The read-only "Timeline" section: one chronological table of everything that
 * happened to the order — the durably-audited state changes MERGED with the
 * derived artifacts (creation, notes, fulfillment, cancellation, reconciliation
 * resolution). `null` (the timeline read failed or the order vanished mid-view)
 * renders an explicit "unavailable" body — the section is never silently blank
 * and never blanks the rest of the detail view. A historical order whose
 * transitions predate the audit table (`stateChangesAudited:false`) gets an
 * honest caption that its state-change history is partial.
 */
function timelineBlocks(actions: ScreenActions, timeline: OrderTimelineWire | null): Block[] {
	const blocks: Block[] = [{ type: "section", text: "Timeline" }];
	if (timeline === null) {
		blocks.push({
			type: "context",
			text: "Timeline unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.",
		});
		return blocks;
	}
	blocks.push({
		type: "context",
		text: timeline.stateChangesAudited
			? "Chronological history: state changes are recorded in the audit log; notes and recorded actions (fulfillment, cancellation, reconciliation) are merged in. Times in UTC."
			: "Chronological history. This order's state changes predate the audit log, so earlier transitions aren't shown — its notes and recorded actions still appear. Times in UTC.",
	});
	blocks.push({
		type: "table",
		columns: [
			{ key: "at", label: "When (UTC)", format: "relative_time" },
			{ key: "what", label: "Event", format: "badge" },
			{ key: "who", label: "Who" },
			{ key: "detail", label: "Detail" },
		],
		rows: timeline.entries.map((e) => ({
			at: e.at,
			what: timelineWhat(e),
			who: timelineWho(e),
			detail: timelineDetail(e),
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text: "No timeline activity yet.",
	});
	return blocks;
}

/** The event label for a timeline row — a short, human "what happened". Unknown
 *  kinds degrade to the raw kind string rather than throwing. */
function timelineWhat(e: TimelineEntryWire): string {
	switch (e.kind) {
		case "created":
			return "Order created";
		case "state_change":
			return `Status → ${e.toState ?? "?"}`;
		case "note":
			return "Note added";
		case "fulfillment":
			return "Fulfillment recorded";
		case "cancellation":
			return "Cancelled";
		case "reconciliation_resolved":
			return "Reconciliation resolved";
		default:
			return e.kind;
	}
}

/** Who is responsible for a timeline row (the actor / author), or "—". */
function timelineWho(e: TimelineEntryWire): string {
	const who = e.actor ?? e.author ?? e.recordedBy ?? e.cancelledBy ?? e.resolvedBy ?? null;
	return who !== null && who.length > 0 ? who : "—";
}

/** The human detail for a timeline row — the kind-specific specifics, or "—". */
function timelineDetail(e: TimelineEntryWire): string {
	switch (e.kind) {
		case "state_change":
			return e.fromState !== null && e.fromState !== undefined ? `from ${e.fromState}` : "—";
		case "note":
			return e.body ?? "—";
		case "fulfillment": {
			const parts = [e.carrier, e.trackingNumber].filter(
				(p): p is string => p !== undefined && p.length > 0,
			);
			return parts.length > 0 ? parts.join(" ") : "—";
		}
		case "cancellation": {
			const reason = e.reason ?? "";
			const extra =
				e.detail !== null && e.detail !== undefined && e.detail.length > 0 ? `: ${e.detail}` : "";
			return reason.length > 0 ? `${reason}${extra}` : "—";
		}
		case "reconciliation_resolved": {
			const outcome = e.outcome ?? "";
			const reason = e.reason !== undefined && e.reason.length > 0 ? `: ${e.reason}` : "";
			return outcome.length > 0 ? `${outcome}${reason}` : "—";
		}
		default:
			return "—";
	}
}

function transitionActions(orderId: string, allowed: string[]): ActionsBlock {
	const elements: ButtonElement[] = allowed.map((toState) => {
		const danger = DANGER_STATES.has(toState);
		const button: ButtonElement = {
			type: "button",
			action_id: ACTION_TRANSITION,
			label: `Mark ${toState}`,
			value: { orderId, toState },
		};
		if (danger) {
			button.style = "danger";
			button.confirm = {
				title: `Mark order ${toState}?`,
				text: `This moves the order to "${toState}". This cannot be undone.`,
				confirm: `Yes, mark ${toState}`,
				deny: "Keep as is",
				style: "danger",
			};
		}
		return button;
	});
	return { type: "actions", elements };
}

// -- reconciliation surface (admin-UX Increment 1) ----------------------------

/** The three admin dispositions, offered in the resolve form's select. Mirrors the
 *  domain `ReconciliationOutcome`; the service re-validates the wire value. The
 *  labels spell out that a disposition is a RECORD, not an action — "refunded"
 *  must never read as "this button issues a refund". */
const RECONCILIATION_OUTCOMES: readonly SelectOption[] = [
	{
		value: "refunded",
		label: "refunded (records the disposition — issue the refund in Refunds below)",
	},
	{ value: "fulfilled", label: "fulfilled (order honored as-is; e.g. stock re-sourced)" },
	{ value: "written_off", label: "written_off (loss/false-alarm accepted)" },
];

/** A one-line summary for the header fields block. */
function reconciliationSummary(o: OrderDetailWire): string {
	if (o.reconciliationFlag !== null) return "⚠ Needs reconciliation";
	if (o.reconciliationResolution !== null)
		return `resolved (${o.reconciliationResolution.outcome})`;
	return "none";
}

/** The prominent reconciliation section: an OPEN flag ⇒ an alert banner explaining
 *  what settle detected + a resolve form; a RESOLVED flag ⇒ the recorded
 *  disposition (read-only); a never-flagged order ⇒ nothing. */
function reconciliationBlocks(o: OrderDetailWire): Block[] {
	if (o.reconciliationFlag !== null) {
		return [
			{
				type: "banner",
				variant: "alert",
				title: "Needs reconciliation",
				description: `Settlement flagged this order: ${o.reconciliationFlag}. Money moved but stock/settlement did not line up — record how you resolved it (this does not move the order status or its line items).`,
			},
			{
				type: "context",
				text: "Resolving records your decision only — it does NOT move money or change the order. If the customer is owed a refund, issue it in the Refunds section below: a real refund (Stripe) or a recorded manual refund (x402/off-platform).",
			},
			resolveForm(o.id, o.reconciliationFlag),
		];
	}
	if (o.reconciliationResolution !== null) {
		const r = o.reconciliationResolution;
		return [
			{ type: "section", text: "Reconciliation resolved" },
			{
				type: "fields",
				fields: [
					{ label: "Outcome", value: r.outcome },
					{ label: "Reason", value: r.reason },
					{ label: "Resolved by", value: r.resolvedBy },
					{ label: "Resolved (UTC)", value: r.resolvedAt },
				],
			},
		];
	}
	return [];
}

/** The resolve form. The order id AND the displayed flag detail ride along as
 *  single-option `select`s (the same carry-the-id-in-values pattern as the
 *  add-note / open-order forms) so a stateless `form_submit` knows which order —
 *  and which EXACT anomaly — the admin reviewed. The service compare-and-clears
 *  on that flag: if a new anomaly re-flags the order mid-review, the resolve
 *  conflicts instead of clearing it blind. */
function resolveForm(orderId: string, displayedFlag: string): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "orderId",
				label: "Order",
				options: [{ value: orderId, label: orderId }],
				initial_value: orderId,
			},
			{
				type: "select",
				action_id: "expectedFlag",
				label: "Resolving this anomaly",
				options: [{ value: displayedFlag, label: displayedFlag }],
				initial_value: displayedFlag,
			},
			{
				type: "select",
				action_id: "outcome",
				label: "Outcome (a record of what you did — does not move money)",
				options: [...RECONCILIATION_OUTCOMES],
				initial_value: "refunded",
			},
			{
				type: "text_input",
				action_id: "reason",
				label: "Reason",
				placeholder: "e.g. refunded the buyer via Stripe; stock was gone",
			},
			{
				type: "text_input",
				action_id: "resolvedBy",
				label: "Resolved by",
				placeholder: "your name",
			},
		],
		submit: { label: "Resolve reconciliation", action_id: ACTION_RESOLVE },
	};
}

// -- shipping address surface (ADR-0009) --------------------------------------

/**
 * The "Shipping address" section — the order's own IMMUTABLE ship-to captured at
 * checkout (ADR-0009), authoritative for the warehouse. When present it shows the
 * frozen address fields plus a DISPLAY-ONLY juxtaposition of the ship-to country
 * next to the order's chosen shipping zone (no matching/validation — just the two
 * facts side by side so a human spots a "domestic zone / foreign country" mismatch
 * before packing the box). When absent it renders an honest "no ship-to on file"
 * note (a historical order predating capture, or a digital-only order with no
 * destination) — never the profile book, which is separate prefill/context on the
 * Customer panel below.
 */
function shippingAddressBlocks(o: OrderDetailWire): Block[] {
	const blocks: Block[] = [{ type: "section", text: "Shipping address" }];
	// Tolerate a wire response that omits the field (undefined) exactly like null.
	const address = o.shippingAddress ?? null;
	const zoneId = o.totals.shippingZoneId ?? null;
	if (address === null) {
		blocks.push({
			type: "context",
			text: "No shipping address captured (order predates capture / digital). This order carries no ship-to on file — the profile address book below is context only, never where this order shipped.",
		});
		return blocks;
	}
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Name", value: address.name },
			{ label: "Address", value: formatOrderAddress(address) },
			{ label: "Country", value: address.country },
			// Display-only juxtaposition (ADR-0009): country vs the priced zone.
			{ label: "Chosen shipping zone", value: zoneId ?? "— (none selected)" },
			{ label: "Email", value: address.email ?? "—" },
			{ label: "Phone", value: address.phone ?? "—" },
		],
	});
	blocks.push({
		type: "context",
		text: "This is the address captured at checkout — frozen on the order, never rewritten by later profile edits. The zone above is the buyer's priced choice; it is shown next to the country for a manual sanity check only (nothing cross-validates them).",
	});
	return blocks;
}

/** Join the ship-to street/city/region/postal parts into one line, skipping the
 *  empty optionals (country is rendered on its own field for the zone check). */
function formatOrderAddress(a: OrderAddressWire): string {
	return [a.line1, a.line2, a.city, a.region, a.postalCode]
		.filter((part): part is string => part !== null && part.length > 0)
		.join(", ");
}

// -- fulfillment surface (admin-UX Increment 1) -------------------------------

/**
 * The fulfillment section. A SHIPPED order with recorded tracking shows it
 * (read-only fields); a `processing` order shows the record-fulfillment form
 * (recording ships the order); any other state shows nothing (fulfillment is only
 * meaningful from `processing`). A shipped order WITHOUT fulfillment (shipped via
 * the bare status transition) gets an honest note that no tracking was recorded.
 */
function fulfillmentBlocks(o: OrderDetailWire): Block[] {
	// Tolerate a wire response that omits the field entirely (undefined) exactly
	// like an explicit null — either way, no recorded fulfillment.
	if (o.fulfillment !== null && o.fulfillment !== undefined) {
		return [{ type: "section", text: "Fulfillment" }, fulfillmentFields(o.fulfillment)];
	}
	if (o.state === "processing") {
		return [
			{ type: "section", text: "Fulfillment" },
			{
				type: "context",
				text: "Recording fulfillment ships this order (moves it to “shipped”) and emails the buyer their tracking. Carrier and tracking number are required; the tracking URL and ship date are optional (a blank ship date uses now).",
			},
			recordFulfillmentForm(o.id),
		];
	}
	if (o.state === "shipped") {
		return [
			{ type: "section", text: "Fulfillment" },
			{
				type: "context",
				text: "This order is shipped but no tracking was recorded (it was moved to “shipped” directly). Tracking can only be captured while an order is “processing”.",
			},
		];
	}
	return [];
}

function fulfillmentFields(f: OrderFulfillmentWire): Block {
	return {
		type: "fields",
		fields: [
			{ label: "Carrier", value: f.carrier },
			{ label: "Tracking number", value: f.trackingNumber },
			{ label: "Tracking URL", value: f.trackingUrl ?? "—" },
			{ label: "Shipped (UTC)", value: f.shippedAt },
			{ label: "Recorded by", value: f.recordedBy },
			{ label: "Recorded (UTC)", value: f.recordedAt },
		],
	};
}

/** The record-fulfillment form. The order id rides along as a single-option
 *  `select` (the carry-the-id-in-values pattern the add-note / resolve forms use)
 *  so a stateless `form_submit` knows which order to ship. */
function recordFulfillmentForm(orderId: string): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "orderId",
				label: "Order",
				options: [{ value: orderId, label: orderId }],
				initial_value: orderId,
			},
			{ type: "text_input", action_id: "carrier", label: "Carrier", placeholder: "e.g. UPS" },
			{
				type: "text_input",
				action_id: "trackingNumber",
				label: "Tracking number",
				placeholder: "e.g. 1Z999AA10123456784",
			},
			{
				type: "text_input",
				action_id: "trackingUrl",
				label: "Tracking URL (optional)",
				placeholder: "https://…",
			},
			{ type: "date_input", action_id: "shippedAt", label: "Ship date (optional; UTC)" },
			{
				type: "text_input",
				action_id: "recordedBy",
				label: "Recorded by",
				placeholder: "your name",
			},
		],
		submit: { label: "Record fulfillment & ship", action_id: ACTION_RECORD_FULFILLMENT },
	};
}

// -- cancellation surface (admin-UX Increment 1, "cancel with reason") -------

/** The five structured cancellation reasons, offered in the cancel form's
 *  select. Mirrors the domain `CancellationReason`; the service re-validates
 *  the wire value. */
const CANCELLATION_REASONS: readonly SelectOption[] = [
	{ value: "customer_request", label: "Customer requested it" },
	{ value: "fraud_suspected", label: "Fraud suspected" },
	{ value: "out_of_stock", label: "Out of stock" },
	{ value: "pricing_error", label: "Pricing error" },
	{ value: "other", label: "Other (add detail below)" },
];

/**
 * The cancellation section. An order carrying a recorded cancellation shows it
 * (read-only); an order that is `cancelled` WITHOUT a recorded reason (the bare
 * transition path) gets an honest note that none was captured; an order the
 * state machine still allows to reach `cancelled` shows the danger-styled
 * cancel form; anything else (a different terminal state) shows nothing.
 */
function cancellationBlocks(o: OrderDetailWire, detail: OrderDetailResult): Block[] {
	// Tolerate a wire response that omits the field entirely (undefined) exactly
	// like an explicit null.
	if (o.cancellation !== null && o.cancellation !== undefined) {
		return [{ type: "section", text: "Cancellation" }, cancellationFields(o.cancellation)];
	}
	if (o.state === "cancelled") {
		return [
			{ type: "section", text: "Cancellation" },
			{
				type: "context",
				text: "This order is cancelled but no reason was recorded (it was moved to “cancelled” directly).",
			},
		];
	}
	if (detail.allowedTransitions.includes("cancelled")) {
		return [
			{ type: "section", text: "Cancellation" },
			{
				type: "banner",
				variant: "alert",
				title: "Cancelling is permanent",
				description:
					"Cancelling this order moves it to “cancelled” and emails the buyer — this cannot be undone. Choose the closest reason; add detail below for anything not covered.",
			},
			cancelOrderForm(o.id),
		];
	}
	return [];
}

function cancellationFields(c: OrderCancellationWire): Block {
	return {
		type: "fields",
		fields: [
			{ label: "Reason", value: c.reason },
			{ label: "Detail", value: c.detail ?? "—" },
			{ label: "Cancelled by", value: c.cancelledBy },
			{ label: "Cancelled (UTC)", value: c.cancelledAt },
		],
	};
}

/** The cancel form. The order id rides along as a single-option `select` (the
 *  carry-the-id-in-values pattern the add-note / resolve / fulfillment forms
 *  use) so a stateless `form_submit` knows which order to cancel. */
function cancelOrderForm(orderId: string): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "select",
				action_id: "orderId",
				label: "Order",
				options: [{ value: orderId, label: orderId }],
				initial_value: orderId,
			},
			{
				type: "select",
				action_id: "reason",
				label: "Reason",
				options: [...CANCELLATION_REASONS],
				initial_value: "customer_request",
			},
			{
				type: "text_input",
				action_id: "detail",
				label: "Detail (optional)",
				placeholder: "e.g. chargeback risk flagged",
			},
			{
				type: "text_input",
				action_id: "cancelledBy",
				label: "Cancelled by",
				placeholder: "your name",
			},
		],
		submit: { label: "Cancel order (cannot be undone)", action_id: ACTION_CANCEL },
	};
}

// -- refunds surface (ADR-0008) ----------------------------------------------

/**
 * The refunds section: the append-only ledger, the derived captured/refunded/
 * remaining totals + a "partially vs fully refunded" badge (Shopify's
 * `financial_status` idea — never a stored state), and the refund form when
 * money remains refundable. Capability is HONEST (ADR-0008): a `refundable`
 * gateway (Stripe) offers a REAL refund; an x402 / no-secret gateway offers a
 * RECORD-ONLY manual refund and says so — no button ever silently no-ops. A
 * failed refunds read degrades to an "unavailable" note, never blanks the detail.
 */
function refundsBlocks(
	actions: ScreenActions,
	o: OrderDetailWire,
	summary: RefundsSummaryWire | null,
): Block[] {
	const blocks: Block[] = [{ type: "section", text: "Refunds" }];
	if (summary === null) {
		blocks.push({
			type: "context",
			text: "Refunds are unavailable right now — the refunds service could not be reached. Reload to try again.",
		});
		return blocks;
	}
	const cur = summary.currency.length > 0 ? summary.currency : o.totals.currency;
	// Derived status (a badge, not a stored state): partial vs fully refunded.
	const derived =
		summary.refundedTotalCents === 0
			? "No refunds recorded."
			: summary.remainingCents === 0
				? `Fully refunded (${formatTotal(summary.refundedTotalCents, cur)}).`
				: `Partially refunded: ${formatTotal(summary.refundedTotalCents, cur)} of ${formatTotal(summary.ceilingCents, cur)} refundable.`;
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Captured", value: formatTotal(summary.capturedTotalCents, cur) },
			{ label: "Refunded", value: formatTotal(summary.refundedTotalCents, cur) },
			{ label: "Remaining refundable", value: formatTotal(summary.remainingCents, cur) },
			{ label: "Status", value: derived },
		],
	});
	if (summary.refunds.length > 0) blocks.push(refundsTable(actions, summary.refunds, cur));

	if (summary.remainingCents > 0) {
		blocks.push({ type: "context", text: refundCapabilityText(summary) });
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Refunds cannot be undone",
			description: summary.refundable
				? "Issuing a refund sends money back to the buyer via Stripe and cannot be reversed. Enter an amount up to the remaining refundable total."
				: "This RECORDS that a refund was made out of band — it does NOT move money. Send the return first, then record it here. Enter an amount up to the remaining refundable total.",
		});
		blocks.push(refundOrderForm(o.id, cur, summary.remainingCents, summary.refundable));
	} else if (summary.refundedTotalCents > 0) {
		blocks.push({ type: "context", text: "Fully refunded — nothing left to refund." });
	}
	return blocks;
}

/** The honest per-gateway capability copy (ADR-0008): Stripe moves money; x402 /
 *  no-secret is record-only, and says why. */
function refundCapabilityText(s: RefundsSummaryWire): string {
	if (s.refundable) {
		return `This order was paid via ${s.paymentMethod ?? "the payment provider"} — refunding here issues a REAL refund through Stripe (money moves back to the buyer).`;
	}
	if (s.paymentMethod === "x402") {
		return "This order was paid on-chain (x402), which cannot be reversed and has no signing wallet — refunds here are RECORD-ONLY. Send the return yourself (e.g. USDC to the buyer’s wallet), then record it below so the ledger reflects it.";
	}
	return "Automatic refunds are unavailable for this order (no Stripe key is configured, or the gateway can’t refund) — refunds here are RECORD-ONLY. Issue the refund via your payment provider, then record it below.";
}

function refundsTable(actions: ScreenActions, refunds: RefundWire[], cur: string): TableBlock {
	return {
		type: "table",
		columns: [
			{ key: "amount", label: "Amount" },
			{ key: "kind", label: "Kind", format: "badge" },
			{ key: "ref", label: "Provider ref", format: "code" },
			{ key: "by", label: "By" },
			{ key: "when", label: "When (UTC)" },
		],
		rows: refunds.map((r) => ({
			amount: formatTotal(r.amountCents, r.currency.length > 0 ? r.currency : cur),
			kind: r.kind,
			ref: r.refundRef ?? "—",
			by: r.refundedBy,
			when: r.createdAt,
		})),
		page_action_id: actions.page, // never fires: no next_cursor, no sortable column
		empty_text: "No refunds recorded.",
	};
}

/** The refund form. The order id + currency + a per-submission nonce ride along as
 *  hidden single-option `select`s (the carry-the-id-in-values pattern the other
 *  forms use); the nonce keys the ADDITIVE refund so a double-submit dedupes while
 *  a fresh reload mints a new nonce (two deliberate refunds each apply — the same
 *  discipline as the products restock). The amount is a TEXT input parsed to
 *  integer minor units (NO float money), defaulted to the full remaining. */
function refundOrderForm(
	orderId: string,
	currencyCode: string,
	remainingCents: number,
	refundable: boolean,
): FormBlock {
	return {
		type: "form",
		fields: [
			idCarrier("orderId", orderId),
			idCarrier("currency", currencyCode),
			idCarrier("nonce", crypto.randomUUID()),
			{
				type: "text_input",
				action_id: "amount",
				label: `Refund amount (${currencyCode})`,
				placeholder: "e.g. 19.99",
				initial_value: formatMinorUnitsInput(remainingCents),
			},
			{
				type: "text_input",
				action_id: "reason",
				label: "Reason (optional)",
				placeholder: "e.g. damaged in transit",
			},
			{
				type: "text_input",
				action_id: "refundedBy",
				label: "Refunded by",
				placeholder: "your name",
			},
		],
		submit: {
			label: refundable ? "Issue refund (cannot be undone)" : "Record manual refund",
			action_id: ACTION_REFUND,
		},
	};
}

/** A hidden single-option carrier threading one value through a stateless
 *  `form_submit` (the scaffold's proven pattern, shared by every form here). */
function idCarrier(actionId: string, value: string): FormBlock["fields"][number] {
	return {
		type: "select",
		action_id: actionId,
		label: actionId,
		options: [{ value, label: value }],
		initial_value: value,
	};
}

// -- custom actions: transition + add-note + resolve-reconciliation -----------

function transitionAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const payload = asRecord(input.value);
		const orderId = readString(payload?.orderId);
		const toState = readString(payload?.toState);
		if (orderId === undefined || toState === undefined) return showList();
		const key = `admin-transition:${orderId}:${toState}`;
		const result = await client.transitionOrder(orderId, toState, { idempotencyKey: key });
		let notice: Notice | undefined;
		if (!result.ok) {
			notice = {
				variant: "error",
				title: "Status change failed",
				description:
					"That status change could not be applied — check the order state and the admin token in Settings.",
			};
		} else if (!result.transitioned) {
			// The guarded flip matched 0 rows — already in that state, or a lost race.
			// Not a failure: surface a non-error notice so the merchant gets feedback
			// rather than a silent, unchanged re-render.
			notice = {
				variant: "default",
				title: "No change",
				description: "The order is already in that state.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

function addNoteAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const orderId = readString(values.orderId);
		if (orderId === undefined) return showList();
		const author = (readString(values.author) ?? "").trim();
		const body = (readString(values.body) ?? "").trim();
		// Local guard: a blank note never leaves the plugin (the domain rejects it
		// too, but this gives immediate inline feedback without a round trip).
		if (author.length === 0 || body.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Note not added",
				description: "Enter both an author and a note body.",
			});
		}
		// A content-derived idempotency key: a double-submit of the same note is a
		// no-op, but a genuinely new note (different author/body) still appends.
		const key = `admin-note:${orderId}:${author}:${body}`;
		const result = await client.addNote(orderId, { author, body }, { idempotencyKey: key });
		let notice: Notice | undefined;
		if (!result.ok) {
			notice = {
				variant: "error",
				title: "Note not added",
				description:
					"That note could not be saved — check the order and the admin token in Settings.",
			};
		} else if (!result.appended) {
			notice = {
				variant: "default",
				title: "Already added",
				description: "That exact note is already on this order.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

function resolveReconciliationAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const orderId = readString(values.orderId);
		if (orderId === undefined) return showList();
		// The flag AS DISPLAYED when the form rendered — the compare-and-clear key.
		const expectedFlag = readString(values.expectedFlag) ?? "";
		const outcome = readString(values.outcome) ?? "";
		const reason = (readString(values.reason) ?? "").trim();
		const resolvedBy = (readString(values.resolvedBy) ?? "").trim();
		// Local guard: a blank reason/resolver never leaves the plugin (the domain
		// rejects it too, but this gives immediate inline feedback without a round trip).
		if (reason.length === 0 || resolvedBy.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not resolved",
				description: "Enter both a reason and who is resolving it.",
			});
		}
		// A stable per-order idempotency key: a double-submit is a guarded no-op, and
		// the disposition is only ever written once (the domain's guarded flip).
		const key = `admin-resolve-reconciliation:${orderId}`;
		const result = await client.resolveReconciliation(
			orderId,
			{ expectedFlag, outcome, reason, resolvedBy },
			{ idempotencyKey: key },
		);
		let notice: Notice | undefined;
		if (!result.ok) {
			// A stale review gets its own copy: the flag changed under the admin (a
			// new settle anomaly re-flagged the order) — the re-render below already
			// shows the NEW flag; tell them to re-review it, not to check tokens.
			notice =
				result.reason === "RECONCILIATION_FLAG_CHANGED"
					? {
							variant: "error",
							title: "The reconciliation state changed — reload",
							description:
								"A new anomaly was flagged on this order after you opened it. Nothing was cleared. Review the flag shown below and resolve again.",
						}
					: {
							variant: "error",
							title: "Not resolved",
							description:
								"That reconciliation could not be resolved — check the order and the admin token in Settings.",
						};
		} else if (!result.resolved) {
			// The guarded flip matched 0 rows — already resolved, or a lost race. Not a
			// failure: surface a non-error notice so the merchant gets feedback.
			notice = {
				variant: "default",
				title: "Already resolved",
				description: "This order's reconciliation flag was already cleared.",
			};
		} else {
			// Success confirmation. Uses the `default` variant — the scaffold's Notice
			// union is `default | error`; the cleared-flag re-render is the substantive
			// feedback, this banner just acknowledges the write.
			notice = {
				variant: "default",
				title: "Reconciliation resolved",
				description: "The flag is cleared and your disposition was recorded.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

function recordFulfillmentAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const orderId = readString(values.orderId);
		if (orderId === undefined) return showList();
		const carrier = (readString(values.carrier) ?? "").trim();
		const trackingNumber = (readString(values.trackingNumber) ?? "").trim();
		const recordedBy = (readString(values.recordedBy) ?? "").trim();
		// Local guard: blank required fields never leave the plugin (the domain
		// rejects them too, but this gives immediate inline feedback without a round
		// trip). The tracking URL + ship date are optional.
		if (carrier.length === 0 || trackingNumber.length === 0 || recordedBy.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not shipped",
				description: "Enter the carrier, tracking number, and who is recording it.",
			});
		}
		const trackingUrl = (readString(values.trackingUrl) ?? "").trim();
		// The tracking URL, when given, must be http(s) — the SAME bound the service
		// schema enforces (defense-in-depth: this value is emailed to the buyer, so a
		// javascript:/data: URI is rejected here with immediate inline feedback
		// instead of a generic 400 from the service).
		if (trackingUrl.length > 0 && !/^https?:\/\/\S+$/i.test(trackingUrl)) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not shipped",
				description: "The tracking URL must be a web link starting with http:// or https://.",
			});
		}
		// A `date_input` yields YYYY-MM-DD; the service wants a full ISO datetime
		// (padded to midnight UTC) — reuse the same normalization the filter uses.
		const shippedAt = normalizeBound(readString(values.shippedAt));
		// A stable per-order idempotency key: a double-submit is a guarded no-op, and
		// the order ships exactly once (the domain's guarded processing→shipped flip).
		const key = `admin-record-fulfillment:${orderId}`;
		const result = await client.recordFulfillment(
			orderId,
			{
				carrier,
				trackingNumber,
				...(trackingUrl.length > 0 ? { trackingUrl } : {}),
				...(shippedAt !== undefined ? { shippedAt } : {}),
				recordedBy,
			},
			{ idempotencyKey: key },
		);
		let notice: Notice | undefined;
		if (!result.ok) {
			// A NOT_FULFILLABLE conflict means the order moved out of `processing`
			// (e.g. someone cancelled it, or it already shipped) — the re-render below
			// shows the new state; tell them to reload rather than check tokens.
			notice =
				result.reason === "NOT_FULFILLABLE"
					? {
							variant: "error",
							title: "Order can’t be shipped right now",
							description:
								"This order is no longer “processing” — it may have shipped or been cancelled. Reload and check its status.",
						}
					: {
							variant: "error",
							title: "Not shipped",
							description:
								"That fulfillment could not be recorded — check the order and the admin token in Settings.",
						};
		} else if (!result.recorded) {
			// The guarded flip matched 0 rows — already shipped, or a lost race. Not a
			// failure: surface a non-error notice so the merchant gets feedback.
			notice = {
				variant: "default",
				title: "Already shipped",
				description: "This order was already shipped; its recorded tracking is shown above.",
			};
		} else {
			notice = {
				variant: "default",
				title: "Order shipped",
				description: "Fulfillment recorded — the buyer has been emailed their tracking.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

function cancelOrderAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const orderId = readString(values.orderId);
		if (orderId === undefined) return showList();
		const reason = readString(values.reason) ?? "";
		const detail = (readString(values.detail) ?? "").trim();
		const cancelledBy = (readString(values.cancelledBy) ?? "").trim();
		// Local guard: a blank cancelledBy never leaves the plugin (the domain
		// rejects it too, but this gives immediate inline feedback without a round
		// trip). `detail` is optional; `reason` always carries a value (the select
		// has an initial_value), so an empty one would mean a tampered submit.
		if (reason.length === 0 || cancelledBy.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not cancelled",
				description: "Choose a reason and enter who is cancelling it.",
			});
		}
		// A stable per-order idempotency key: a double-submit is a guarded no-op,
		// and the order cancels only once (the domain's guarded terminal flip).
		const key = `admin-cancel:${orderId}`;
		const result = await client.cancelOrder(
			orderId,
			{ reason, ...(detail.length > 0 ? { detail } : {}), cancelledBy },
			{ idempotencyKey: key },
		);
		let notice: Notice | undefined;
		if (!result.ok) {
			// A NOT_CANCELLABLE conflict means the order can no longer be cancelled
			// (e.g. it shipped, or was already cancelled without a reason) — the
			// re-render below shows the new state; tell them to reload rather than
			// check tokens.
			notice =
				result.reason === "NOT_CANCELLABLE"
					? {
							variant: "error",
							title: "Order can’t be cancelled right now",
							description:
								"This order can no longer be cancelled — it may have shipped, or been cancelled without a reason on file. Reload and check its status.",
						}
					: {
							variant: "error",
							title: "Not cancelled",
							description:
								"That cancellation could not be recorded — check the order and the admin token in Settings.",
						};
		} else if (!result.cancelled) {
			// The guarded flip matched 0 rows — already cancelled with a reason on
			// file, or a lost race. Not a failure: surface a non-error notice so the
			// merchant gets feedback rather than a silent, unchanged re-render.
			notice = {
				variant: "default",
				title: "Already cancelled",
				description: "This order was already cancelled; its recorded reason is shown above.",
			};
		} else {
			notice = {
				variant: "default",
				title: "Order cancelled",
				description: "The cancellation was recorded and the buyer has been emailed.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

function refundOrderAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const orderId = readString(values.orderId);
		if (orderId === undefined) return showList();
		const currency = (readString(values.currency) ?? "").trim();
		const nonce = readString(values.nonce) ?? "";
		const amountStr = (readString(values.amount) ?? "").trim();
		const reason = (readString(values.reason) ?? "").trim();
		const refundedBy = (readString(values.refundedBy) ?? "").trim();
		// Local guards: a blank refundedBy / missing currency never leave the plugin
		// (the domain rejects them too, but this gives immediate inline feedback).
		if (refundedBy.length === 0 || currency.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not refunded",
				description: "Enter the amount and who is issuing/recording it.",
			});
		}
		// Money is parsed to integer MINOR UNITS with exact integer string math (NO
		// float) — a $0 or malformed amount is rejected inline (the domain rejects it
		// too). `allowZero:false`: a refund of nothing is meaningless.
		const amountCents = parseMinorUnitsInput(amountStr, { allowZero: false });
		if (amountCents === null) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not refunded",
				description: "Enter a valid refund amount greater than zero (e.g. 19.99).",
			});
		}
		// Refunds are ADDITIVE — the per-submission nonce keys it so a double-submit
		// dedupes to one refund while a fresh reload mints a new nonce (two deliberate
		// refunds each apply). Mirrors the products restock nonce.
		const key = `admin-refund:${orderId}:${nonce.length > 0 ? nonce : amountStr}`;
		const result = await client.refundOrder(
			orderId,
			{ amountCents, currency, ...(reason.length > 0 ? { reason } : {}), refundedBy },
			{ idempotencyKey: key },
		);
		let notice: Notice;
		if (!result.ok) {
			notice = refundFailureNotice(result.reason);
		} else if (result.duplicate) {
			// The idempotency key already recorded this refund — a benign no-op replay.
			notice = {
				variant: "default",
				title: "Already refunded",
				description:
					"This refund was already recorded (a duplicate submission); the ledger above is unchanged.",
			};
		} else if (result.fullyRefunded) {
			notice = {
				variant: "default",
				title: "Refund complete",
				description:
					"The refund was recorded and the order is now fully refunded — the buyer has been emailed.",
			};
		} else {
			notice = {
				variant: "default",
				title: "Refund recorded",
				description:
					"The refund was recorded. The order stays in its current status; the Refunds section shows the remaining refundable amount.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

/** GENERIC, em-dash-correct notices for a refund failure — keyed off the service's
 *  typed reason, NEVER the raw status/URL. The ambiguous-timeout case is explicit:
 *  do NOT retry, re-check the provider first (ADR-0008 error taxonomy). */
function refundFailureNotice(reason: string | undefined): Notice {
	switch (reason) {
		case "REFUND_EXCEEDS_TOTAL":
		case "REFUND_EXCEEDS_CAPTURED":
			return {
				variant: "error",
				title: "Amount too high",
				description:
					"That is more than the remaining refundable amount for this order. Reload to see the current remaining total.",
			};
		case "PROVIDER_ALREADY_REFUNDED":
			return {
				variant: "error",
				title: "Provider already refunded",
				description:
					"Your payment provider shows this order already refunded (possibly from its dashboard). Nothing was issued — reconcile the provider before trying again.",
			};
		case "GATEWAY_RETRYABLE":
			return {
				variant: "error",
				title: "Temporary problem",
				description:
					"The payment provider could not be reached. Nothing was refunded — try again in a moment.",
			};
		case "GATEWAY_TERMINAL":
			return {
				variant: "error",
				title: "Refund rejected",
				description:
					"The payment provider rejected this refund. Check the order in your provider dashboard.",
			};
		case "GATEWAY_UNVERIFIED":
			return {
				variant: "error",
				title: "Refund status unknown",
				description:
					"The refund request timed out and its outcome is unknown. Do NOT retry — check your provider dashboard first, then reconcile.",
			};
		case "CURRENCY_MISMATCH":
			return {
				variant: "error",
				title: "Not refunded",
				description: "The refund currency does not match the order. Reload and try again.",
			};
		default:
			return {
				variant: "error",
				title: "Not refunded",
				description:
					"That refund could not be processed — check the order and the admin token in Settings.",
			};
	}
}

// -- shared -------------------------------------------------------------------

/** Fail CLOSED with a GENERIC, em-dash-correct banner — never leaks a raw HTTP
 *  status/URL (e.g. an auth 401 from a missing/expired admin token). */
function failClosed() {
	return failClosedResponse({
		header: "Orders",
		title: "Orders are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load orders",
	});
}

/** Translate the console's filter form into the client's list filter (single
 *  status → an OR set of one; bare dates normalized to full UTC datetimes so the
 *  service's `z.string().datetime()` accepts them). */
function toClientFilter(form: OrdersFilterForm): OrdersListFilter {
	const filter: OrdersListFilter = {};
	if (form.status !== undefined && form.status.length > 0) filter.states = [form.status];
	const from = normalizeBound(form.from);
	const to = normalizeBound(form.to);
	if (from !== undefined) filter.from = from;
	if (to !== undefined) filter.to = to;
	if (form.search !== undefined && form.search.length > 0) filter.search = form.search;
	return filter;
}

/** A `date_input` yields `YYYY-MM-DD`; the service wants a full ISO datetime.
 *  Pad a bare date to midnight UTC, pass a full datetime through unchanged. */
function normalizeBound(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
	return value;
}

function filterFromValues(values: Record<string, unknown>): OrdersFilterForm {
	const form: OrdersFilterForm = {};
	const status = readString(values.status);
	const from = readString(values.from);
	const to = readString(values.to);
	const search = readString(values.search);
	if (status !== undefined && status.length > 0) form.status = status;
	if (from !== undefined && from.length > 0) form.from = from;
	if (to !== undefined && to.length > 0) form.to = to;
	if (search !== undefined && search.length > 0) form.search = search;
	return form;
}

/** Format an order-currency amount for display; falls back to `${CUR} ${cents}`
 *  if `Intl` rejects the currency (never throws into the render path). */
function formatTotal(minorUnits: number, currencyCode: string): string {
	try {
		return formatMoney(toCents(minorUnits), toCurrency(currencyCode), "en-US");
	} catch {
		return `${currencyCode} ${minorUnits}`;
	}
}
