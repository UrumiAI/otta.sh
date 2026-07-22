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
	type OrderDetailResult,
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
			// Notes are a SECONDARY surface: a notes-read failure must not blank the
			// whole detail view — degrade to an empty notes section, never fail closed.
			let notes: OrderNoteWire[] = [];
			try {
				notes = await client.listNotes(id);
			} catch {
				notes = [];
			}
			return detailBlocks(actions, detail, notes, notice);
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
			{ label: "Reconciliation", value: o.reconciliationFlag ?? "none" },
		],
	});
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

// -- custom actions: transition + add-note ------------------------------------

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
