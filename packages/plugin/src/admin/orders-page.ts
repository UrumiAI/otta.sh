import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	ActionsBlock,
	AdminPageConfig,
	Block,
	BlockResponse,
	ButtonElement,
	FormBlock,
	RouteHandler,
	SelectOption,
	TableBlock,
} from "../types.js";
import {
	AdminOrdersClient,
	type OrderDetailResult,
	type OrderSummaryWire,
	type OrdersListFilter,
} from "./admin-orders-client.js";
import { INTERNAL_TOKEN_KEY } from "./settings-form.js";

/** The admin Orders console page's `admin.pages` manifest entry. View-only:
 *  browse orders + drill into one + fire a legal status transition. Rendered by
 *  the single `admin` dispatch route (see `admin-route.ts`). */
export const ORDERS_PAGE: AdminPageConfig = { path: "/orders", label: "Orders", icon: "receipt" };

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the Orders
 * console (MOD-2). Every `block_action`/`form_submit` this page can emit is
 * namespaced `orders:*` and listed here, so NONE falls through the dispatcher to
 * the `{blocks:[]}` dead-end. `orders:page` is ALSO the table's `page_action_id`
 * (em-dash's "Load more" fires it) — its handler tolerates a value with no cursor
 * (treated as the first page).
 */
export const ORDERS_ACTION_IDS: ReadonlySet<string> = new Set([
	"orders:apply-filter",
	"orders:page",
	"orders:open",
	"orders:back",
	"orders:transition",
]);

const ACTION_APPLY_FILTER = "orders:apply-filter";
const ACTION_PAGE = "orders:page";
const ACTION_OPEN = "orders:open";
const ACTION_BACK = "orders:back";
const ACTION_TRANSITION = "orders:transition";

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

export interface OrdersPageInput {
	/** em-dash BlockInteraction discriminant. */
	type?: unknown;
	action_id?: unknown;
	/** `form_submit` payload. */
	values?: Record<string, unknown>;
	/** `block_action` payload (e.g. the table "Load more" `{ cursor, sort }`, or a
	 *  transition button's `{ orderId, toState }`). */
	value?: unknown;
}

export function createOrdersPageHandler(): RouteHandler<OrdersPageInput> {
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const action = typeof input.action_id === "string" ? input.action_id : undefined;
		const adminToken = (await ctx.kv.get<string>(INTERNAL_TOKEN_KEY)) ?? undefined;
		const client = new AdminOrdersClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(adminToken !== undefined ? { adminToken } : {}),
		});

		// -- detail: open one order ------------------------------------------------
		if (action === ACTION_OPEN) {
			const orderId = readString(input.values?.orderId);
			if (orderId === undefined) return renderList(client, {});
			return renderDetail(client, orderId);
		}

		// -- detail: fire a legal transition, then re-render the detail ------------
		if (action === ACTION_TRANSITION) {
			const payload = asRecord(input.value);
			const orderId = readString(payload?.orderId);
			const toState = readString(payload?.toState);
			if (orderId === undefined || toState === undefined) return renderList(client, {});
			const key = `admin-transition:${orderId}:${toState}`;
			const result = await client.transitionOrder(orderId, toState, { idempotencyKey: key });
			let notice: DetailNotice | undefined;
			if (!result.ok) {
				notice = {
					variant: "error",
					title: "Status change failed",
					description:
						"That status change could not be applied — check the order state and the admin token in Settings.",
				};
			} else if (!result.transitioned) {
				// The guarded flip matched 0 rows — already in that state, or a lost
				// race. Not a failure: surface a non-error notice so the merchant gets
				// feedback rather than a silent, unchanged re-render.
				notice = {
					variant: "default",
					title: "No change",
					description: "The order is already in that state.",
				};
			}
			return renderDetail(client, orderId, notice);
		}

		// -- back to the list ------------------------------------------------------
		if (action === ACTION_BACK) {
			return renderList(client, {});
		}

		// -- Load more: keyset next page (defensive: no cursor ⇒ first page) --------
		if (action === ACTION_PAGE) {
			const payload = asRecord(input.value);
			const token = readString(payload?.cursor);
			const decoded = token === undefined ? null : decodePluginCursor(token);
			if (decoded === null) return renderList(client, {}); // tolerate a missing/garbage cursor
			return renderList(client, decoded.f, decoded.c);
		}

		// -- apply the filter form (first page of the filtered set) ----------------
		if (action === ACTION_APPLY_FILTER) {
			return renderList(client, filterFromValues(input.values ?? {}));
		}

		// -- page load (or any other interaction routed here) ⇒ the list -----------
		return renderList(client, {});
	};
}

// -- list view ----------------------------------------------------------------

async function renderList(
	client: AdminOrdersClient,
	form: OrdersFilterForm,
	cursor?: string,
): Promise<BlockResponse> {
	try {
		const filter = toClientFilter(form);
		const page = await client.listOrders(filter, {
			limit: PAGE_LIMIT,
			...(cursor !== undefined ? { cursor } : {}),
		});
		// The table's next_cursor carries BOTH the service cursor and the console's
		// own form values, so "Load more" preserves the filter both functionally
		// (the service token embeds it) and visually (the form re-populates).
		const nextToken =
			page.nextCursor === null ? undefined : encodePluginCursor({ c: page.nextCursor, f: form });
		return { blocks: listBlocks(form, page.orders, nextToken) };
	} catch {
		return failClosed();
	}
}

function listBlocks(
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
		page_action_id: ACTION_PAGE,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text: "No orders match these filters.",
	};

	const blocks: Block[] = [
		{ type: "header", text: "Orders" },
		{
			type: "context",
			text: "View-only console. Filter, open an order, and move it through its status flow. Money shown as the order currency; dates in UTC.",
		},
		filterForm(form),
		table,
	];
	if (orders.length > 0) blocks.push(openOrderForm(orders));
	return blocks;
}

function filterForm(form: OrdersFilterForm): FormBlock {
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
		submit: { label: "Apply filters", action_id: ACTION_APPLY_FILTER },
	};
}

function openOrderForm(orders: OrderSummaryWire[]): FormBlock {
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
		submit: { label: "Open order", action_id: ACTION_OPEN },
	};
}

// -- detail view --------------------------------------------------------------

/** A banner surfaced above the detail view after a transition attempt — an
 *  `error` on failure, or a non-error `default` on a no-op (already-in-state /
 *  lost race). `variant` uses em-dash's authoritative banner union. */
interface DetailNotice {
	variant: "default" | "error";
	title: string;
	description: string;
}

async function renderDetail(
	client: AdminOrdersClient,
	orderId: string,
	notice?: DetailNotice,
): Promise<BlockResponse> {
	let detail: OrderDetailResult | null;
	try {
		detail = await client.getOrder(orderId);
	} catch {
		return failClosed();
	}
	if (detail === null) {
		return {
			blocks: [
				{ type: "header", text: "Order not found" },
				backButton(),
				{
					type: "banner",
					variant: "error",
					title: "Order not found",
					description: `No order matches "${orderId}".`,
				},
			],
		};
	}
	return { blocks: detailBlocks(detail, notice) };
}

function detailBlocks(detail: OrderDetailResult, notice: DetailNotice | undefined): Block[] {
	const o = detail.order;
	const blocks: Block[] = [{ type: "header", text: `Order ${o.id}` }, backButton()];
	if (notice !== undefined) {
		blocks.push({
			type: "banner",
			variant: notice.variant,
			title: notice.title,
			description: notice.description,
		});
	}
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
		page_action_id: ACTION_PAGE, // never fires: no next_cursor, no sortable column
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
	return blocks;
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

function backButton(): ActionsBlock {
	return {
		type: "actions",
		elements: [{ type: "button", action_id: ACTION_BACK, label: "← Back to orders" }],
	};
}

// -- shared -------------------------------------------------------------------

/** Fail CLOSED with a GENERIC, em-dash-correct banner — never leaks a raw HTTP
 *  status/URL (e.g. an auth 401 from a missing/expired admin token). Emits the
 *  authoritative `{variant, title, description}` shape (MOD-3) so it renders in
 *  production, not the legacy `text` shape em-dash drops. */
function failClosed(): BlockResponse {
	return {
		blocks: [
			{ type: "header", text: "Orders" },
			{
				type: "banner",
				variant: "error",
				title: "Orders are unavailable",
				description:
					"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
			},
		],
		toast: { message: "Could not load orders", type: "error" },
	};
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

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

// -- console cursor (wraps the service cursor + the form so paging preserves both) --

interface PluginCursor {
	/** The opaque SERVICE cursor token. */
	c: string;
	/** The console filter form (re-populated on the paged re-render). */
	f: OrdersFilterForm;
}

function encodePluginCursor(cursor: PluginCursor): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodePluginCursor(token: string): PluginCursor | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(token))) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const p = parsed as { c?: unknown; f?: unknown };
		if (typeof p.c !== "string") return null;
		const f = p.f !== null && typeof p.f === "object" ? (p.f as OrdersFilterForm) : {};
		return { c: p.c, f };
	} catch {
		return null;
	}
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const bin = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
