import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
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
	type OrderDetailResult,
	type OrderDetailWire,
	type OrderFulfillmentWire,
	type OrderNoteWire,
	type OrderSummaryWire,
	type OrdersListFilter,
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
			// Notes + customer context are SECONDARY surfaces: either read failing
			// must not blank the whole detail view — each degrades independently
			// (empty notes / an "unavailable" customer section), never fail closed.
			// Fetched in parallel to avoid serial round-trip latency.
			const [notes, customerContext] = await Promise.all([
				client.listNotes(id).catch((): OrderNoteWire[] => []),
				client.getCustomerContext(id).catch((): CustomerContextWire | null => null),
			]);
			return detailBlocks(actions, detail, notes, customerContext, notice);
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
	// -- Fulfillment (admin-UX Increment 1) — recorded tracking + the ship form --
	for (const block of fulfillmentBlocks(o)) blocks.push(block);
	if (detail.allowedTransitions.length > 0) {
		blocks.push({ type: "section", text: "Move status" });
		blocks.push(transitionActions(o.id, detail.allowedTransitions));
	}
	// -- Notes (append-only) ---------------------------------------------------
	blocks.push({ type: "section", text: "Notes" });
	blocks.push(notesTable(actions, notes));
	blocks.push(addNoteForm(o.id));
	return blocks;
}

// -- customer context (admin-UX Increment 1) ----------------------------------

/**
 * The read-only "Customer" panel on the order detail: who the customer is
 * (honestly labeled — see `accountSummary`), their profile address book (with a
 * PROMINENT "not the ship-to" disclaimer: this domain snapshots no per-order
 * address), token-free session history, and their other orders under the
 * union customer key. `null` (the context read failed or the order vanished
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
	// Saved addresses — prominent disclaimer FIRST: this is the profile address
	// book, never a per-order ship-to (support must not read it as one).
	blocks.push({ type: "section", text: "Saved addresses" });
	blocks.push({
		type: "context",
		text: "Profile address book — NOT the address this order shipped to. Orders do not capture a shipping address.",
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
	{ value: "refunded", label: "refunded (recorded only — issue the refund separately)" },
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
				text: "Resolving records your decision only — it does NOT move money or change the order. If the customer is owed a refund, issue it via your payment provider (or the refunded status flow) separately.",
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
