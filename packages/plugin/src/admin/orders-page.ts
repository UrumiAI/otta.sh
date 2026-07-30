import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
import type {
	AdminPageConfig,
	Block,
	BlockResponse,
	ButtonElement,
	FieldsBlock,
	FormBlock,
	RouteHandler,
	SelectOption,
	TableBlock,
	TabPanel,
} from "../types.js";
import {
	AdminOrdersClient,
	type CustomerContextWire,
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
	carriedForm,
	createListDetailHandler,
	customAction,
	emptyState,
	encodePath,
	failClosedResponse,
	filterPanel,
	filterSummary,
	leafLevel,
	listLevel,
	noticeBanner,
	PATH_FIELD,
	readAdminTokens,
	readString,
	screenActions,
	type CustomActionApi,
	type ListDetailInput,
	type NavPath,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Orders console — the REFERENCE screen for `docs/admin/ADMIN-CONSOLE.md`
 * (§11.1 list, §11.2 detail). The other six screens pattern-match on this file, so
 * every structural choice here cites the rule it implements.
 *
 * THE SHAPE, in one paragraph. The list is `header` + one `context` + an optional
 * notice `banner` + a COLLAPSED filter panel (+ its active-filter `section`) +
 * the table — nothing else above the data (P-1). The detail is five blocks
 * outside the tabs (header, back, up to two banners, the identity strip) and then
 * FOUR task-named panels — `Order` · `Fulfilment` · `Money` · `History` (D-2) —
 * whose named groups are all `accordion`s, because `section` is not a heading and
 * there is no mid-level type weight in the renderer (R-5, P-2).
 *
 * FOUR THINGS THAT WILL BITE A SCREEN AUTHOR COPYING THIS FILE:
 *  1. NO VISIBLE PLUMBING. Every id/watermark a stateless submit needs rides
 *     invisibly in the form's `block_id` via {@link carriedForm} (F-2, B-3a), and
 *     every BUTTON carries its context in `value` because a button echoes no
 *     `block_id` (B-1). There is not one single-option `select` left (F-3).
 *  2. NO NONCE, ANYWHERE. Every write derives its idempotency key from its own
 *     content plus the WATERMARK THE OPERATOR SAW — for a refund,
 *     `admin-refund:${orderId}:${amountCents}:${refundedSoFarCents}` (F-2a). That
 *     is what lets two deliberate identical refunds both apply while a
 *     double-click dedupes, and a render-time nonce cannot do it safely:
 *     `domain/src/orders/refund-order.ts` resolves a refund by key ALONE with no
 *     amount comparison, so a reused key with a different amount renders a
 *     success-shaped "Already refunded" for money that never moved (issue #152).
 *  3. A DESTRUCTIVE ACT IS NEVER A FORM SUBMIT (DA-1) — `FormBlock` has no
 *     `confirm`; only `button` does (R-10). Closed-set acts get one danger button
 *     per value with no staging (DA-2b: the cancellation reasons, the
 *     full-remaining refund); a typed amount or free text stages then confirms
 *     (DA-3), and EVERY confirm re-reads the record and refuses on a watermark
 *     mismatch (DA-3a).
 *  4. A THROW IN HERE IS CONTAINED and renders this screen's `onError()` banner —
 *     the SAME banner as "the service is unreachable". So a `filterPanel` field
 *     over budget or a rejected carrier namespace looks like an outage. Suspect
 *     this file first; the cause is in the worker log.
 *
 * Built on the shared list/detail scaffold (`./scaffold`).
 */
export const ORDERS_PAGE: AdminPageConfig = { path: "/orders", label: "Orders", icon: "receipt" };

/** This screen's namespaced action ids. */
const ORDERS_ACTIONS: ScreenActions = screenActions("orders");
const ACTION_ADD_NOTE = ORDERS_ACTIONS.custom("add-note");
const ACTION_RESOLVE = ORDERS_ACTIONS.custom("resolve-reconciliation");
const ACTION_RECORD_FULFILLMENT = ORDERS_ACTIONS.custom("record-fulfillment");
/** DA-3 state 1 → state 2 (stage a cancellation with free-text detail). */
const ACTION_CANCEL_REVIEW = ORDERS_ACTIONS.custom("cancel-review");
/** The DA-3 state-2 confirm for a cancellation. DA-2b's per-reason buttons have
 *  their own ids (see {@link CANCEL_REASON_ACTIONS}) — one `actions` block cannot
 *  hold several buttons sharing an `action_id` (R-13: they collide as React keys). */
const ACTION_CANCEL = ORDERS_ACTIONS.custom("cancel");
/** DA-3 state 1 → state 2 (stage a partial refund). */
const ACTION_REFUND_REVIEW = ORDERS_ACTIONS.custom("refund-review");
/** Both the DA-2b full-remaining refund button and the DA-3 state-2 confirm —
 *  they are siblings in DIFFERENT `actions` blocks, so one id is fine. */
const ACTION_REFUND = ORDERS_ACTIONS.custom("refund");

const PAGE_LIMIT = 25;

/** A `select`/`combobox` sentinel meaning "no constraint". NEVER `""`: the pinned
 *  renderer treats an empty value as "no value" and draws a BLANK trigger
 *  (R-17a), and the trigger renders the raw VALUE rather than the option label —
 *  so a sentinel has to read acceptably as a word (F-6a, F-6c). */
const ANY = "any";
/** The same, for a picker with nothing selected yet (L-7). */
const NONE = "none";

/** §1's prose budgets, as constants so the copy below can be measured against
 *  them rather than eyeballed. Enforced mechanically for the two strings whose
 *  length depends on SERVICE DATA (an accordion label carrying a tracking number,
 *  a banner quoting a settlement anomaly) — everything else is authored literal
 *  text that is in budget by inspection. */
const LABEL_BUDGET = 60;
const BANNER_BUDGET = 240;

/**
 * The ten order states, and the ONE source the per-state transition ids and the
 * dispatcher's registration are both derived from (DA-6).
 *
 * WHY THIS MATTERS: `ORDERS_ACTION_IDS` is fixed at module load, `admin-route.ts`
 * dispatches on set membership, and an unmatched id falls through to
 * `{blocks: []}` — a BLANK console. Offered transitions come from the SERVICE
 * (`detail.allowedTransitions`), so a service offering a state this plugin has
 * never heard of would render a button that blanks the page. Hence: the ids come
 * from this list, `customActions` comes from this list, and
 * {@link offeredTransitions} DROPS anything outside it.
 */
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

const ORDER_STATE_SET: ReadonlySet<string> = new Set(ORDER_STATES);

/** `transition-<state>` — one DISTINCT verb per state (R-13), derived. */
const transitionVerb = (state: string): string => `transition-${state}`;
/** `cancel-<reason>` — one DISTINCT verb per cancellation reason (R-13, DA-2b). */
const cancelReasonVerb = (reason: string): string => `cancel-${reason}`;

/** The transitions whose bare one-click is IRREVERSIBLE, so DA-5's danger style
 *  plus a confirm dialog. `cancelled` is not here because it is never offered as
 *  a bare transition at all — it is steered to the Cancel group, which records a
 *  reason (DA-7). */
const DANGER_STATES: ReadonlySet<string> = new Set(["refunded"]);

/** The five structured cancellation reasons. Mirrors the domain
 *  `CancellationReason`; the service re-validates the wire value. DA-2b renders
 *  ONE danger button per entry, so this list is also the source of those ids. */
const CANCELLATION_REASONS: readonly SelectOption[] = [
	{ value: "customer_request", label: "Customer requested it" },
	{ value: "fraud_suspected", label: "Fraud suspected" },
	{ value: "out_of_stock", label: "Out of stock" },
	{ value: "pricing_error", label: "Pricing error" },
	{ value: "other", label: "Other (add detail below)" },
];

const CANCEL_REASON_LABELS: ReadonlyMap<string, string> = new Map(
	CANCELLATION_REASONS.map((r) => [r.value, r.label]),
);

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the Orders
 * console (MOD-2). Derived from {@link ORDER_STATES} and
 * {@link CANCELLATION_REASONS} rather than hand-listed, so a button can never
 * render for an id the dispatcher does not know (DA-6) — that combination is what
 * blanks the console.
 */
export const ORDERS_ACTION_IDS: ReadonlySet<string> = ORDERS_ACTIONS.actionIds(
	"add-note",
	"resolve-reconciliation",
	"record-fulfillment",
	"cancel",
	"cancel-review",
	"refund",
	"refund-review",
	...ORDER_STATES.map(transitionVerb),
	...CANCELLATION_REASONS.map((r) => cancelReasonVerb(r.value)),
);

/** The console's own filter form values, kept alongside the opaque service cursor
 *  so paging preserves the form (MOD-9). */
interface OrdersFilterForm {
	status?: string;
	from?: string;
	to?: string;
	search?: string;
}

/**
 * A DA-3 staged payload: what the operator typed in state 1, plus THE WATERMARK
 * THEY SAW, echoed back through the state-2 confirm button's `value` so the
 * handler can re-read and refuse on a mismatch (DA-3a).
 *
 * Every member is a string on the wire and money crosses as its integer
 * minor-unit string (B-2) — the same discipline as a carrier payload, so there is
 * one parsing rule on this screen rather than two.
 */
type Staged =
	| {
			kind: "refund";
			orderId: string;
			amountCents: number;
			/** The watermark: `refundedTotalCents` AS RENDERED. */
			refundedSoFarCents: number;
			currency: string;
			reason: string;
			refundedBy: string;
	  }
	| {
			kind: "cancel";
			orderId: string;
			reason: string;
			detail: string;
			cancelledBy: string;
			/** The watermark: the order `state` AS RENDERED. */
			state: string;
	  };

/** The em-dash BlockInteraction envelope this page consumes. */
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
		// The "Open order" picker carries the order id in `values.orderId`; the
		// target is a single-level drill, so the path is just `[orderId]`. The L-7
		// "nothing selected" sentinel re-renders the list unchanged.
		parseOpen(input) {
			const orderId = readString(input.values?.orderId);
			if (orderId === undefined || orderId.length === 0 || orderId === NONE) return undefined;
			return { targetPath: [orderId] };
		},
		levels: [ordersListLevel(), orderDetailLevel()],
		customActions: {
			[ACTION_ADD_NOTE]: addNoteAction(),
			[ACTION_RESOLVE]: resolveReconciliationAction(),
			[ACTION_RECORD_FULFILLMENT]: recordFulfillmentAction(),
			[ACTION_CANCEL_REVIEW]: cancelReviewAction(),
			[ACTION_CANCEL]: cancelOrderAction(),
			[ACTION_REFUND_REVIEW]: refundReviewAction(),
			[ACTION_REFUND]: refundOrderAction(),
			// One handler per state, keyed by the SAME derived id the button uses, so
			// a rendered transition button always has a registered target (DA-6).
			...Object.fromEntries(
				ORDER_STATES.map((state) => [
					ORDERS_ACTIONS.custom(transitionVerb(state)),
					transitionAction(state),
				]),
			),
			// Likewise one per cancellation reason (DA-2b).
			...Object.fromEntries(
				CANCELLATION_REASONS.map((r) => [
					ORDERS_ACTIONS.custom(cancelReasonVerb(r.value)),
					cancelOrderAction(),
				]),
			),
		},
	});
}

// -- level 0: the orders list (§11.1) -----------------------------------------

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
		render({ actions, path, filter, items, nextToken, notice }) {
			return listBlocks(actions, path, filter, items, nextToken, notice);
		},
		onError: () => failClosed(),
	});
}

/**
 * §11.1's block order, exactly: `header` · `context` · notice `banner` · the
 * COLLAPSED filter panel · the active-filter `section` · THE DATA. Nothing else
 * may precede the table (P-1/L-1) — no create form (orders are not created in the
 * admin), no expanded filter, no `divider`.
 */
function listBlocks(
	actions: ScreenActions,
	path: NavPath,
	form: OrdersFilterForm,
	orders: OrderSummaryWire[],
	nextToken: string | undefined,
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Orders", block_id: "orders:hdr" },
		{
			type: "context",
			// 101 chars ≤ 140 (§1). "View-only" is gone: this console cancels,
			// refunds, fulfils and annotates orders.
			text: "Filter, open an order, and move it through its status flow. Money in the order's currency; dates UTC.",
		},
	];
	// A list level may receive a notice from a custom action that could not name
	// an order (DA-3b), so the banner has to reach here or the operator is bounced
	// to the list with no explanation.
	if (notice !== undefined) blocks.push(noticeBanner(notice));

	// ONE PART PER AUTHORED FILTER FIELD (L-3): a from/to range is two fields and
	// therefore two parts, or the `(N active)` count disagrees with the panel.
	const activeFilters = [
		form.status !== undefined && `status: ${form.status}`,
		form.from !== undefined && `from: ${form.from}`,
		form.to !== undefined && `to: ${form.to}`,
		form.search !== undefined && `search: ${form.search}`,
	];
	blocks.push(
		filterPanel({
			form: filterForm(actions, path, form),
			// STABLE across an apply AND across `Clear filters` (B-7) — encoding the
			// filter here would remount the panel and `default_open:false` would then
			// slam it shut on the operator who filters constantly.
			blockId: "orders:filters",
			activeFilters,
		}),
	);
	const summary = filterSummary(activeFilters);
	if (summary !== undefined) {
		blocks.push({
			type: "section",
			text: summary,
			// The path rides in `value`, NOT `block_id`: a button echoes no
			// `block_id`, and at depth > 0 an omitted path re-filters the ROOT list
			// while appearing to work (L-6, B-1). A bare `apply-filter` carries no
			// `values`, so the scaffold rebuilds the DEFAULT filter — which is the
			// clear.
			accessory: {
				type: "button",
				action_id: actions.applyFilter,
				label: "Clear filters",
				value: { [PATH_FIELD]: encodePath(path) },
			},
			block_id: "orders:filter-summary",
		});
	}

	const filtered = summary !== undefined;
	if (orders.length === 0 && !filtered) {
		// E-2: the primary collection at its TRUE zero state earns the one `empty`
		// block on this screen, and the table is OMITTED rather than rendered with
		// `empty_text`. No `actions` — orders are not created in the admin.
		blocks.push(
			emptyState({
				title: "No orders yet",
				description: "Orders appear here as buyers check out.",
				size: "base",
				blockId: "orders:empty",
			}),
		);
		return blocks;
	}

	blocks.push({
		type: "table",
		block_id: "orders:list",
		columns: [
			{ key: "id", label: "Order #", format: "code" }, // identity first (T-2)
			{ key: "createdAt", label: "Placed", format: "relative_time" },
			{ key: "state", label: "Status", format: "badge" }, // the ONE badge column (T-5)
			{ key: "customer", label: "Customer" },
			{ key: "total", label: "Total" }, // money LAST, pre-formatted (T-2, M-1)
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
		// Filtered-to-zero only — the unfiltered zero state took the `empty` branch
		// above, because an operator's next act here is CHANGING the filter (E-2).
		empty_text: "No orders match these filters.",
	});
	if (orders.length > 0) blocks.push(openOrderForm(actions, path, orders));
	return blocks;
}

/**
 * The four-field filter (L-2 ⇒ an accordion), built by {@link carriedForm} LAST so
 * the digest it carries matches the form — `filterPanel` recomputes it and throws
 * on an absent or stale one, because a form whose React key cannot change when its
 * prefilled values do strands a cleared filter on screen (B-3a).
 *
 * Carrying `__path` invisibly is also what stands the engine's visible "Scope"
 * dropdown injection down (see `withFilterPathCarry`).
 */
function filterForm(actions: ScreenActions, path: NavPath, form: OrdersFilterForm): FormBlock {
	return carriedForm({
		namespace: "orders:filter",
		context: { [PATH_FIELD]: encodePath(path) },
		form: {
			type: "form",
			fields: [
				{
					type: "select",
					action_id: "status",
					label: "Status",
					// The trigger renders the raw VALUE (R-17a), so the all-values option
					// is the word `any`, never `""` — which would render blank (F-6a).
					options: [
						{ value: ANY, label: "All statuses" },
						...ORDER_STATES.map((s) => ({ value: s, label: s })),
					],
					initial_value: form.status ?? ANY,
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
					label: "Search order ID or buyer email",
					...(form.search !== undefined ? { initial_value: form.search } : {}),
				},
			],
			// A verb phrase naming the RESULT (L-5, F-7).
			submit: { label: "Apply filters", action_id: actions.applyFilter },
		},
	});
}

/**
 * The drill-in picker (L-7), until table row clicks land (§14 item 2). A
 * `combobox` because a page holds up to 25 rows (> 8) and this field NEVER
 * prefills — a prefilling `combobox` shows one value and submits another
 * (R-12a, F-6, X-30).
 *
 * The option VALUE is the record id and the LABEL never contains it (X-22, M-7):
 * `alice@example.com · $15.00 · paid`. The trigger will read the raw uuid, which
 * §16 item 3 records as a real, tracked wart of the pinned renderer — it is
 * deleted outright by table row actions, not improved by a better label.
 */
function openOrderForm(
	actions: ScreenActions,
	path: NavPath,
	orders: OrderSummaryWire[],
): FormBlock {
	return carriedForm({
		namespace: "orders:open",
		context: { [PATH_FIELD]: encodePath(path) },
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "orderId",
					label: "Open order",
					options: [
						{ value: NONE, label: "Choose an order…" },
						...orders.map((o) => ({
							value: o.id,
							label: `${o.customerId ?? o.buyerRef} · ${formatTotal(o.totalCents, o.currency)} · ${o.state}`,
						})),
					],
					initial_value: NONE,
				},
			],
			submit: { label: "Open order", action_id: actions.open },
		},
	});
}

// -- level 1: the order detail (§11.2) ---------------------------------------

function orderDetailLevel() {
	return leafLevel<AdminOrdersClient, OrderDetailResult>({
		load: (client, _path, id) => client.getOrder(id),
		async render({ client, actions, path, id, detail, notice }) {
			const surfaces = await loadDetailSurfaces(client, id);
			return detailBlocks({ actions, path, detail, ...surfaces, notice, staged: undefined });
		},
		notFound({ actions, path, id }) {
			return [
				{ type: "header", text: "Order not found" },
				backButton(actions.back, "← Back to orders", path),
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

/**
 * Notes, customer context, timeline and refunds are SECONDARY surfaces: any one
 * failing must degrade to a `context` line in its own group and never blank the
 * detail or fail the screen closed (E-1). Fetched in parallel.
 */
async function loadDetailSurfaces(
	client: AdminOrdersClient,
	id: string,
): Promise<{
	notes: OrderNoteWire[];
	customer: CustomerContextWire | null;
	timeline: OrderTimelineWire | null;
	refunds: RefundsSummaryWire | null;
}> {
	const [notes, customer, timeline, refunds] = await Promise.all([
		client.listNotes(id).catch((): OrderNoteWire[] => []),
		client.getCustomerContext(id).catch((): CustomerContextWire | null => null),
		client.getTimeline(id).catch((): OrderTimelineWire | null => null),
		client.getRefunds(id).catch((): RefundsSummaryWire | null => null),
	]);
	return { notes, customer, timeline, refunds };
}

interface DetailArgs {
	actions: ScreenActions;
	path: NavPath;
	detail: OrderDetailResult;
	notes: OrderNoteWire[];
	customer: CustomerContextWire | null;
	timeline: OrderTimelineWire | null;
	refunds: RefundsSummaryWire | null;
	notice: Notice | undefined;
	/** Set only on a DA-3 state-2 render: the group holding it is the ONE group
	 *  forced open, and D-5's ordinary precedence is not evaluated (D-5 Rule 1). */
	staged: Staged | undefined;
}

/**
 * §4's detail skeleton: blocks 1–5 outside the tabs, then the four constant
 * panels. Only these five may precede the tabs (D-1) — in particular the
 * reconciliation alert stays OUTSIDE, because a state demanding action must never
 * sit where a tab can hide it.
 */
function detailBlocks(args: DetailArgs): Block[] {
	const { actions, path, detail, notice, staged } = args;
	const o = detail.order;
	const open = openGroup(o, staged);
	const blocks: Block[] = [
		// M-10: orders have no human handle, so the uuid stands — but it appears
		// exactly once, here.
		{ type: "header", text: `Order ${o.id}` },
		{ ...backButton(actions.back, "← Back to orders", path), block_id: "orders:nav" },
	];
	// At most 2 banners at this level (X-31): the notice and the reconciliation
	// alert. Every other banner on this screen lives inside an accordion, which
	// §2 does not count.
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	if (o.reconciliationFlag !== null) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Needs reconciliation",
			description: fit(
				`Settlement flagged this order: ${o.reconciliationFlag}. Resolve it under Fulfilment — recording a resolution moves no money and does not change the order.`,
				BANNER_BUDGET,
			),
		});
	}
	// The identity strip: "what am I looking at, and is it healthy" without a
	// click. 6 entries in 3 row-major PAIRS (R-3, §4) — `Total` is here, so the
	// Money panel does not repeat `Payment` (P-3).
	blocks.push(
		fields("orders:identity", [
			["Status", o.state],
			["Total", formatTotal(o.totals.totalCents, o.totals.currency)],
			["Placed (UTC)", utc(o.createdAt)],
			["Payment", o.paymentMethod ?? "—"],
			["Customer", o.customerId ?? o.buyerRef],
			["Reconciliation", reconciliationSummary(o)],
		]),
	);
	const panels: TabPanel[] = [
		{ label: "Order", blocks: orderPanel(actions, o, args.customer, open) },
		{ label: "Fulfilment", blocks: fulfilmentPanel(actions, detail, open, staged) },
		{ label: "Money", blocks: moneyPanel(actions, o, args.refunds, open, staged) },
		{ label: "History", blocks: historyPanel(actions, o, args.notes, args.timeline, open) },
	];
	blocks.push({
		type: "tab",
		// STABLE (B-4): a volatile key would throw the operator back to panel 0
		// after every action's re-render.
		block_id: `orders:${o.id}:tabs`,
		default_tab: 0, // ALWAYS (D-4) — urgency is the banner's job, not the tab's
		panels,
	});
	return blocks;
}

/**
 * D-5, evaluated ONCE per rendered response: at most one group anywhere on the
 * screen is `default_open` (X-18), and WHICH one is computed rather than chosen.
 *
 * Rule 1 — a DA-3 state 2 overrides everything: that one group carries a changed
 * `block_id` AND `default_open: true` (B-6 — the changed key remounts the group,
 * and the remount re-reads the flag, which is `false` for anything destructive;
 * change only the id and the accordion SNAPS SHUT on the operator the moment they
 * click "Review refund", hiding the confirm button they asked for).
 *
 * Rule 2 — first match wins: `reconcile` if flagged and unresolved, else
 * `fulfilment` on a `paid`/`processing` order, else nothing. Orders has NO named
 * primary edit group, so D-5 rank 3 does not apply here.
 */
type OpenGroup = "reconcile" | "fulfilment" | "refunds" | "cancel" | undefined;

function openGroup(o: OrderDetailWire, staged: Staged | undefined): OpenGroup {
	if (staged?.kind === "refund") return "refunds";
	if (staged?.kind === "cancel") return "cancel";
	if (o.reconciliationFlag !== null) return "reconcile";
	if (o.state === "paid" || o.state === "processing") return "fulfilment";
	return undefined;
}

// -- panel "Order" ------------------------------------------------------------

function orderPanel(
	actions: ScreenActions,
	o: OrderDetailWire,
	customer: CustomerContextWire | null,
	open: OpenGroup,
): Block[] {
	const cur = o.totals.currency;
	const ladder: Array<[string, number]> = [
		["Subtotal", o.totals.subtotalCents],
		["Discount", o.totals.discountCents],
		["Shipping", o.totals.shippingCents],
		["Tax", o.totals.taxCents],
		["Total", o.totals.totalCents],
	];
	const ladderRows = ladder.map(([line, amount]) => ({
		line,
		amount: formatTotal(amount, cur),
	}));
	const blocks: Block[] = [
		// The ONE `header` permitted inside a panel (P-2): this group must always be
		// visible, so it cannot be an accordion, and `section` is not a heading.
		{ type: "header", text: "Line items" },
		{
			type: "table",
			block_id: "orders:lines",
			columns: [
				{ key: "sku", label: "SKU", format: "code" },
				{ key: "title", label: "Title" },
				{ key: "quantity", label: "Qty", format: "number" },
				{ key: "unitPrice", label: "Unit price" },
				{ key: "lineTotal", label: "Line total" },
				// No `Currency` column: the formatted string carries it (M-2), and a
				// column of identical currency badges is pure decoration (T-5).
			],
			rows: o.lines.map((l) => ({
				sku: l.sku,
				title: l.title,
				quantity: l.quantity,
				unitPrice: formatTotal(l.unitPriceCents, l.currency),
				// Integer math on minor units — never a float on the money path.
				lineTotal: formatTotal(l.unitPriceCents * l.quantity, l.currency),
			})),
			page_action_id: actions.page, // never fires: no next_cursor (T-8), no sortable column
			empty_text: "No line items.",
		},
		{
			type: "context",
			// M-5, stated ONCE on the screen.
			text: "Titles and prices are what the buyer paid — later product edits never change them.",
		},
		{
			// M-4: a money ladder is a TWO-COLUMN TABLE, never `fields`. `fields` is
			// row-major `grid-cols-2` (R-3), so a five-line ladder can never read
			// downward inside it whatever order the entries are authored in.
			type: "table",
			block_id: "orders:totals",
			columns: [
				{ key: "line", label: "Line" },
				{ key: "amount", label: "Amount" }, // money last (T-2)
			],
			rows: ladderRows,
			page_action_id: actions.page, // never fires: no next_cursor, no sortable column
			// No empty_text — the ladder always has five rows.
		},
	];
	// M-1: a wrong number is worse than a missing one, so an unformattable amount
	// renders `—` and the block says so rather than leaking raw minor units.
	if (ladderRows.some((r) => r.amount === UNFORMATTABLE)) {
		blocks.push({
			type: "context",
			text: `One or more amounts could not be formatted and are shown as ${UNFORMATTABLE}.`,
		});
	}
	blocks.push(customerGroup(actions, o, customer, open));
	return blocks;
}

/**
 * The Customer group. D-6: the label carries the answer that makes opening it
 * unnecessary, so the group can be skipped from the trigger row alone.
 *
 * D-7: for a guest with nothing to show, three headings and three empty tables
 * collapse into ONE sentence — and the three sub-groups are omitted entirely
 * rather than rendered empty (P-3).
 */
function customerGroup(
	actions: ScreenActions,
	o: OrderDetailWire,
	ctx: CustomerContextWire | null,
	_open: OpenGroup,
): Block {
	const blockId = `orders:${o.id}:customer`;
	if (ctx === null) {
		return {
			type: "accordion",
			block_id: blockId,
			label: "Customer",
			default_open: false,
			blocks: [
				{
					type: "context",
					// E-3: a FAILED read names what failed, what is unaffected, and the one
					// next step — and never reads like a successful empty.
					text: "Customer context unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.",
				},
			],
		};
	}
	const identity = ctx.identity;
	const handle = identity.email ?? identity.buyerRef;
	const suffix = identity.linkage === "claimed" ? "" : ` (${identity.linkage})`;
	const body: Block[] = [
		fields(`orders:${o.id}:customer-fields`, [
			["Email", identity.email ?? "— (no account)"],
			["Account", accountSummary(identity)],
			["Name", identity.displayName ?? "—"],
			["Orders placed", String(ctx.orderCount)],
			["Buyer reference", identity.buyerRef],
			[
				"Email verified (UTC)",
				identity.emailVerifiedAt === null ? "not verified" : utc(identity.emailVerifiedAt),
			],
		]),
	];
	if (identity.linkage === "unclaimed") {
		body.push({
			type: "context",
			text: "An account exists for this email, but this order is not yet claimed by it — guest orders link automatically at the customer's next sign-in.",
		});
	}
	const hasSecondaryData =
		ctx.addresses.length > 0 || ctx.sessions.length > 0 || ctx.recentOrders.length > 0;
	if (!hasSecondaryData) {
		body.push({
			type: "context",
			// D-7: one sentence replaces three headings and three empty tables.
			text:
				identity.linkage === "guest"
					? "Guest checkout — no account, no saved addresses, no sign-in history."
					: "No saved addresses, sign-in sessions or other orders on file for this customer.",
		});
	}
	if (ctx.addresses.length > 0) {
		body.push({
			type: "accordion",
			block_id: `orders:${o.id}:addresses`,
			label: `Saved addresses (${ctx.addresses.length})`,
			default_open: false,
			blocks: [
				{
					type: "context",
					// ADR-0009, trimmed to ≤200: the profile book is NOT where this order
					// shipped, and a later edit here never rewrites a placed order.
					text: "The customer's current profile book — context only. Where this order shipped is under Fulfilment, frozen on the order.",
				},
				{
					type: "table",
					block_id: `orders:${o.id}:addresses:table`,
					columns: [
						// `Kind` is NOT badged: shipping/billing is a property, not lifecycle
						// state, and every badge renders identically (R-6, T-5).
						{ key: "kind", label: "Kind" },
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
						isDefault: a.isDefault ? "yes" : "—", // T-5: a boolean is yes/—, never a badge
					})),
					page_action_id: actions.page, // never fires: no next_cursor, no sortable column
					empty_text: "No saved addresses.",
				},
			],
		});
	}
	if (ctx.sessions.length > 0) {
		body.push({
			type: "accordion",
			block_id: `orders:${o.id}:sessions`,
			label: `Sign-in sessions (${ctx.sessions.length})`,
			default_open: false,
			blocks: [
				{
					type: "table",
					block_id: `orders:${o.id}:sessions:table`,
					columns: [
						{ key: "createdAt", label: "Signed in", format: "relative_time" },
						{ key: "expiresAt", label: "Expires (UTC)" },
						{ key: "revokedAt", label: "Revoked (UTC)" },
					],
					rows: ctx.sessions.map((s) => ({
						createdAt: s.createdAt,
						expiresAt: utc(s.expiresAt), // M-6: milliseconds are noise (X-13)
						revokedAt: s.revokedAt === null ? "—" : utc(s.revokedAt),
					})),
					page_action_id: actions.page, // never fires: no next_cursor, no sortable column
					empty_text: "No sessions.",
				},
			],
		});
	}
	if (ctx.recentOrders.length > 0) {
		body.push({
			type: "accordion",
			block_id: `orders:${o.id}:other-orders`,
			label: `Other orders (${ctx.recentOrders.length})`,
			default_open: false,
			blocks: [
				{
					type: "table",
					block_id: `orders:${o.id}:other-orders:table`,
					columns: [
						{ key: "id", label: "Order #", format: "code" },
						{ key: "createdAt", label: "Placed", format: "relative_time" },
						{ key: "state", label: "Status", format: "badge" },
						{ key: "total", label: "Total" },
					],
					rows: ctx.recentOrders.map((r) => ({
						id: r.id,
						createdAt: r.createdAt,
						state: r.state,
						total: formatTotal(r.totalCents, r.currency),
					})),
					page_action_id: actions.page, // never fires: no next_cursor, no sortable column
					empty_text: "No other orders from this customer.",
				},
			],
		});
	}
	return {
		type: "accordion",
		block_id: blockId,
		label: fitLabel(`Customer — ${handle}${suffix}`),
		default_open: false,
		blocks: body,
	};
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

// -- panel "Fulfilment" -------------------------------------------------------

/**
 * Cancelling and fulfilling are the two answers to ONE question — does this order
 * ship? — so an operator deciding between them never changes panels (§11.2). It
 * does not belong in Money: cancelling moves no money, and a cancelled paid order
 * still needs a separate refund in a separate panel.
 */
function fulfilmentPanel(
	actions: ScreenActions,
	detail: OrderDetailResult,
	open: OpenGroup,
	staged: Staged | undefined,
): Block[] {
	const o = detail.order;
	const blocks: Block[] = [];
	const reconcile = reconcileGroup(o, open);
	if (reconcile !== undefined) blocks.push(reconcile);
	blocks.push(...shippingAddressBlocks(o));
	const fulfilment = fulfilmentGroup(o, open);
	if (fulfilment !== undefined) blocks.push(fulfilment);
	blocks.push(...transitionBlocks(o, detail));
	blocks.push(...cancelBlocks(o, detail, open, staged));
	if (blocks.length === 0) {
		// D-3: a panel with nothing to do renders ONE honest line — never a dropped
		// panel, which would strand `activeTab` past the end and render blank (R-14).
		blocks.push({
			type: "context",
			text: `Nothing to do here — this order is ${o.state} and carries no fulfilment or cancellation record.`,
		});
	}
	return blocks;
}

/** The reconcile group: an OPEN flag gets the resolve form (D-5 rank 1 opens it);
 *  a RESOLVED flag shows the recorded disposition read-only; a never-flagged order
 *  gets no group at all. The alert BANNER lives outside the tabs (D-1). */
function reconcileGroup(o: OrderDetailWire, open: OpenGroup): Block | undefined {
	const blockId = `orders:${o.id}:reconcile`;
	if (o.reconciliationFlag !== null) {
		return {
			type: "accordion",
			block_id: blockId,
			label: "Resolve reconciliation",
			default_open: open === "reconcile",
			blocks: [
				{
					type: "context",
					// DA-4: this records a decision and moves no money — say so, and never
					// style it as danger.
					text: "Recording a resolution logs your decision only — it moves no money and does not change the order. Refund in Money if the buyer is owed one.",
				},
				resolveForm(o.id, o.reconciliationFlag),
			],
		};
	}
	const r = o.reconciliationResolution;
	if (r !== null) {
		return {
			type: "accordion",
			block_id: blockId,
			label: fitLabel(`Reconciliation — resolved (${r.outcome})`),
			default_open: false,
			blocks: [
				fields(`orders:${o.id}:reconcile-fields`, [
					["Outcome", r.outcome],
					["Resolved by", r.resolvedBy],
					["Reason", r.reason],
					["Resolved (UTC)", utc(r.resolvedAt)],
				]),
			],
		};
	}
	return undefined;
}

/** The three admin dispositions. The labels spell out that a disposition is a
 *  RECORD, not an action — "refunded" must never read as "this issues a refund". */
const RECONCILIATION_OUTCOMES: readonly SelectOption[] = [
	{
		value: "refunded",
		label: "refunded (records the disposition — issue the refund in Refunds below)",
	},
	{ value: "fulfilled", label: "fulfilled (order honored as-is; e.g. stock re-sourced)" },
	{ value: "written_off", label: "written_off (loss/false-alarm accepted)" },
];

/**
 * The resolve form — THREE visible fields (F-5). The order id and the flag AS
 * DISPLAYED ride invisibly in the carrier (F-2): they used to be two
 * single-option `select`s labelled `orderId` and `expectedFlag`. The service
 * compare-and-clears on that flag, so a new anomaly mid-review conflicts instead
 * of clearing blind.
 */
function resolveForm(orderId: string, displayedFlag: string): FormBlock {
	return carriedForm({
		namespace: "orders:reconcile",
		context: { orderId, expectedFlag: displayedFlag },
		form: {
			type: "form",
			fields: [
				{
					type: "select",
					action_id: "outcome",
					label: "Outcome", // ≤40 (F-4); the caveat is the context line above
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
			submit: { label: "Record resolution", action_id: ACTION_RESOLVE },
		},
	});
}

/**
 * The order's own IMMUTABLE ship-to captured at checkout (ADR-0009),
 * authoritative for the warehouse. Absent (a historical or digital-only order) ⇒
 * ONE `context` line, never an empty group (D-7, E-1).
 *
 * The address is SPLIT across `fields` entries rather than joined into one long
 * value, because the renderer truncates a `fields` value on pixel width (§1).
 */
function shippingAddressBlocks(o: OrderDetailWire): Block[] {
	const address = o.shippingAddress ?? null;
	const zoneId = o.totals.shippingZoneId ?? null;
	if (address === null) {
		return [
			{
				type: "context",
				text: "No shipping address captured — this order predates capture, or is digital-only. The profile book under Order is context only, never where this order shipped.",
			},
		];
	}
	return [
		{
			type: "accordion",
			block_id: `orders:${o.id}:ship`,
			label: fitLabel(`Shipping address — ${address.country}`),
			default_open: false,
			blocks: [
				fields(`orders:${o.id}:ship-fields`, [
					["Name", address.name],
					["Country", address.country],
					["Address line 1", address.line1],
					["Address line 2", address.line2 ?? "—"],
					["City", address.city],
					["Region", address.region ?? "—"],
					["Postal code", address.postalCode],
					// Display-only juxtaposition (ADR-0009): the priced zone next to the
					// country, so a human spots a mismatch before packing the box.
					["Chosen shipping zone", zoneId ?? "— (none selected)"],
					["Email", address.email ?? "—"],
					["Phone", address.phone ?? "—"],
				]),
				{
					type: "context",
					text: "Captured at checkout and frozen on this order. The zone is the buyer's priced choice; nothing cross-validates them.",
				},
			],
		},
	];
}

/**
 * The fulfilment group. Recorded tracking ⇒ read-only `fields`; a `processing`
 * order ⇒ the record form (recording SHIPS the order); a `shipped` order with no
 * tracking ⇒ an honest line; a `paid` order ⇒ the one line that says what has to
 * happen first, which is also what D-5 rank 2 opens. Any other state has no
 * fulfilment concept, so no group (D-7).
 */
function fulfilmentGroup(o: OrderDetailWire, open: OpenGroup): Block | undefined {
	const blockId = `orders:${o.id}:fulfilment`;
	const isOpen = open === "fulfilment";
	// Tolerate a wire response that omits the field (undefined) exactly like null.
	const f = o.fulfillment ?? null;
	if (f !== null) {
		return {
			type: "accordion",
			block_id: blockId,
			label: fitLabel(`Fulfilment — ${f.carrier} ${f.trackingNumber}`),
			default_open: isOpen,
			blocks: [fulfilmentFields(o.id, f)],
		};
	}
	if (o.state === "processing") {
		return {
			type: "accordion",
			block_id: blockId,
			label: "Fulfilment",
			default_open: isOpen,
			blocks: [
				{
					type: "context",
					// F-8, ≤200: only what the labels cannot say.
					text: "Recording ships this order and emails the buyer their tracking. Carrier and tracking number are required; a blank ship date means now.",
				},
				recordFulfillmentForm(o.id, o.state),
			],
		};
	}
	if (o.state === "shipped") {
		return {
			type: "accordion",
			block_id: blockId,
			label: "Fulfilment — no tracking recorded",
			default_open: isOpen,
			blocks: [
				{
					type: "context",
					text: "This order shipped without recorded tracking (it was moved to “shipped” directly). Tracking can only be captured while an order is “processing”.",
				},
			],
		};
	}
	if (o.state === "paid") {
		return {
			type: "accordion",
			block_id: blockId,
			label: "Fulfilment",
			default_open: isOpen,
			blocks: [
				{
					type: "context",
					// DA-7: no control, one line naming the reason and the alternative.
					text: "Tracking is recorded once this order is processing — use “Mark processing” below first.",
				},
			],
		};
	}
	return undefined;
}

function fulfilmentFields(orderId: string, f: OrderFulfillmentWire): FieldsBlock {
	return fields(`orders:${orderId}:fulfilment-fields`, [
		["Carrier", f.carrier],
		["Tracking number", f.trackingNumber],
		["Shipped (UTC)", utc(f.shippedAt)],
		["Recorded by", f.recordedBy],
		["Tracking URL", f.trackingUrl ?? "—"],
		["Recorded (UTC)", utc(f.recordedAt)],
	]);
}

/** FIVE visible fields (§11.2) — the order id and the state watermark ride in the
 *  carrier (F-2, B-3). DA-4: a non-destructive write stays one-shot. */
function recordFulfillmentForm(orderId: string, state: string): FormBlock {
	return carriedForm({
		namespace: "orders:fulfil",
		context: { orderId, state },
		form: {
			type: "form",
			fields: [
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
				{ type: "date_input", action_id: "shippedAt", label: "Ship date (optional, UTC)" },
				{
					type: "text_input",
					action_id: "recordedBy",
					label: "Recorded by",
					placeholder: "your name",
				},
			],
			submit: { label: "Record fulfilment & ship", action_id: ACTION_RECORD_FULFILLMENT },
		},
	});
}

/**
 * The transitions the service offers, minus the two this UI steers away from and
 * minus anything outside {@link ORDER_STATES}.
 *
 * That last filter is load-bearing (DA-6): the ids are fixed at module load and
 * `admin-route.ts` falls through an unknown one to `{blocks: []}`, so rendering a
 * button for a state this plugin never registered would BLANK THE CONSOLE.
 */
function offeredTransitions(o: OrderDetailWire, detail: OrderDetailResult): string[] {
	return detail.allowedTransitions.filter((t) => {
		if (!ORDER_STATE_SET.has(t)) return false;
		// A bare `shipped` would ship without tracking and email the buyer an empty
		// shipped notice — steered to the Fulfilment form, which records tracking
		// and ships atomically.
		if (o.state === "processing" && t === "shipped") return false;
		// A bare `cancelled` would cancel with no reason on file — steered to the
		// Cancel group, which records one. (The SERVICE still accepts both bare
		// transitions for other callers; this is UI steering only.)
		if (t === "cancelled") return false;
		return true;
	});
}

/** ONE `actions` block with DISTINCT per-state ids (DA-6, R-13) — the old
 *  one-block-per-button split existed only because every button shared the
 *  literal id `orders:transition` and they collided as React keys. Withheld
 *  moves get one `context` line each and NO control (DA-7). */
function transitionBlocks(o: OrderDetailWire, detail: OrderDetailResult): Block[] {
	const offered = offeredTransitions(o, detail);
	const blocks: Block[] = [];
	if (o.state === "processing" && detail.allowedTransitions.includes("shipped")) {
		blocks.push({
			type: "context",
			text: "There is deliberately no bare “Mark shipped” — use Fulfilment above, which records the tracking and emails it to the buyer.",
		});
	}
	if (detail.allowedTransitions.includes("cancelled")) {
		blocks.push({
			type: "context",
			text: "There is deliberately no bare “Mark cancelled” — use Cancel order below, which records a reason on file.",
		});
	}
	if (offered.length === 0) return blocks;
	blocks.push({
		type: "actions",
		block_id: "orders:transitions",
		elements: offered.map((toState) => transitionButton(o.id, toState)),
	});
	return blocks;
}

function transitionButton(orderId: string, toState: string): ButtonElement {
	const button: ButtonElement = {
		// DERIVED from ORDER_STATES, so a rendered button always has a registered
		// handler. The handler takes the target state from THIS ID, never from the
		// value below — `value.toState` is echoed for devtools legibility and is
		// operator-alterable, so it is deliberately not trusted.
		action_id: ORDERS_ACTIONS.custom(transitionVerb(toState)),
		type: "button",
		label: `Mark ${toState}`,
		value: { orderId, toState },
	};
	if (DANGER_STATES.has(toState)) {
		button.style = "danger";
		button.confirm = {
			title: "Mark this order refunded?",
			text: "Marks the order refunded for bookkeeping. It does not move money — record the money in Money → Refunds.",
			confirm: "Yes, mark refunded",
			deny: "Keep as is",
			style: "danger",
		};
	}
	return button;
}

/**
 * The Cancel group. Four states, and the destructive one is DA-2b + DA-3:
 *
 *  - already cancelled WITH a reason ⇒ the recorded cancellation, read-only;
 *  - cancelled WITHOUT one (the bare transition) ⇒ an honest line;
 *  - cancellable ⇒ one DANGER BUTTON PER REASON (DA-2b: a closed set needs no
 *    staging, no staleness window and no staged payload to decode) plus a nested
 *    DA-3 group for the case where the operator wants to add free text;
 *  - anything else ⇒ no control and one `context` line (DA-7).
 *
 * On a DA-3 state-2 render this group carries `:review` AND `default_open: true`
 * (B-6) and its body becomes the staged form plus ONE confirm button — see
 * {@link cancelReviewBody} for why the nested accordion is not used there.
 */
function cancelBlocks(
	o: OrderDetailWire,
	detail: OrderDetailResult,
	open: OpenGroup,
	staged: Staged | undefined,
): Block[] {
	const blockId = `orders:${o.id}:cancel`;
	// Tolerate a wire response that omits the field (undefined) exactly like null.
	const recorded = o.cancellation ?? null;
	if (recorded !== null) {
		return [
			{
				type: "accordion",
				block_id: blockId,
				label: fitLabel(`Cancelled — ${recorded.reason}`),
				default_open: false,
				blocks: [cancellationFields(o.id, recorded)],
			},
		];
	}
	if (o.state === "cancelled") {
		return [
			{
				type: "accordion",
				block_id: blockId,
				label: "Cancellation — no reason recorded",
				default_open: false,
				blocks: [
					{
						type: "context",
						text: "This order is cancelled but no reason was recorded (it was moved to “cancelled” directly).",
					},
				],
			},
		];
	}
	if (!detail.allowedTransitions.includes("cancelled")) {
		return [
			{
				type: "context",
				// DA-7: the precondition knowably forbids it, so no control at all.
				text: `This order can no longer be cancelled — it is ${o.state}. Refund it under Money if the buyer is owed money.`,
			},
		];
	}
	if (staged?.kind === "cancel") {
		return [
			{
				type: "accordion",
				// BOTH halves of the force-open (B-6): a changed key remounts the group,
				// and the remount re-reads `default_open` — which is `false` for a
				// destructive group unless THIS render sets it true.
				block_id: `${blockId}:review`,
				label: "Cancel order",
				default_open: open === "cancel",
				blocks: cancelReviewBody(o, staged),
			},
		];
	}
	return [
		{
			type: "accordion",
			block_id: blockId,
			label: "Cancel order",
			default_open: false, // ALWAYS, for anything destructive (D-5)
			blocks: [
				{
					type: "banner",
					variant: "alert",
					title: "Cancelling is permanent",
					description:
						"Cancelling moves this order to “cancelled”, emails the buyer and releases the held stock. It cannot be undone.",
				},
				{ type: "context", text: "Pick the reason — cancelling is immediate." },
				{
					type: "actions",
					block_id: `orders:${o.id}:cancel-reasons`,
					elements: CANCELLATION_REASONS.map((r) => cancelReasonButton(o, r)),
				},
				{
					type: "accordion",
					block_id: `orders:${o.id}:cancel-note`,
					label: "Cancel with a note",
					default_open: false,
					blocks: [
						{
							type: "banner",
							variant: "alert",
							// DA-3 state 1 requires this banner; §2 does not count banners
							// inside an accordion, so it is free.
							title: "Cancelling is permanent and cannot be undone",
							description:
								"Review what you typed on the next step — the confirm there is the point of no return.",
						},
						cancelNoteForm(o.id, o.state),
					],
				},
			],
		},
	];
}

/** DA-2b: one danger button per legal value, the value in `button.value`, and the
 *  reason NAMED IN THE CONFIRM TEXT. No round trip, no staged payload. */
function cancelReasonButton(o: OrderDetailWire, reason: SelectOption): ButtonElement {
	return {
		type: "button",
		action_id: ORDERS_ACTIONS.custom(cancelReasonVerb(reason.value)),
		label: `Cancel — ${reason.label}`,
		// A button's ONLY context channel (B-1). `state` is the watermark the
		// handler re-reads against (DA-3a).
		value: { orderId: o.id, reason: reason.value, state: o.state },
		style: "danger",
		confirm: {
			title: "Cancel this order?",
			text: `Cancel this order as “${reason.label}”? This is permanent — the order cannot be un-cancelled, and the held stock is released.`,
			confirm: "Yes, cancel the order",
			deny: "Keep the order",
			style: "danger",
		},
	};
}

/**
 * DA-3 state 2 for a cancellation: THE SAME FORM remounted with the staged values
 * as `initial_value`, plus one danger confirm button.
 *
 * "Change details" is deliberately NOT an action (DA-3): the operator edits the
 * visible form and re-submits `-review`, which deletes the hand-maintained
 * `fields` echo of the payload — a second rendering of the same data, and a place
 * for the dialog and the payload to disagree.
 *
 * The nested "Cancel with a note" accordion is NOT reused here: nesting the
 * forced-open group one level deeper would leave it invisible behind a COLLAPSED
 * parent, and D-5 Rule 1 forbids opening the parent as well. See the PR's
 * disclosure — the spec's §11.2 listing is ambiguous on which accordion carries
 * the `:review` suffix, and this is the only reading in which the confirm button
 * is actually on screen.
 */
function cancelReviewBody(o: OrderDetailWire, staged: Staged & { kind: "cancel" }): Block[] {
	const reasonLabel = CANCEL_REASON_LABELS.get(staged.reason) ?? staged.reason;
	return [
		{
			type: "banner",
			variant: "alert",
			title: "Cancelling is permanent and cannot be undone",
			description:
				"Confirm below to cancel this order, email the buyer and release the held stock. Edit the form and review again to change anything.",
		},
		cancelNoteForm(o.id, o.state, staged),
		{
			type: "actions",
			block_id: `orders:${o.id}:cancel-confirm`,
			elements: [
				{
					type: "button",
					action_id: ACTION_CANCEL,
					label: "Cancel the order",
					// The staged payload, INCLUDING the watermark the operator saw (DA-3).
					value: {
						orderId: o.id,
						reason: staged.reason,
						detail: staged.detail,
						cancelledBy: staged.cancelledBy,
						state: staged.state,
					},
					style: "danger",
					confirm: {
						title: "Cancel this order?",
						text: `Cancel this order as “${reasonLabel}”? This is permanent — the order cannot be un-cancelled, and the held stock is released.`,
						confirm: "Yes, cancel the order",
						deny: "Keep the order",
						style: "danger",
					},
				},
			],
		},
	];
}

/** THREE visible fields — the order id and the state watermark ride in the
 *  carrier. On a state-2 render the staged values are the `initial_value`s, and
 *  `carriedForm`'s prefill digest is what makes the remount actually pick them up
 *  (B-3a). */
function cancelNoteForm(
	orderId: string,
	state: string,
	staged?: Staged & { kind: "cancel" },
): FormBlock {
	return carriedForm({
		namespace: "orders:cancel-note",
		context: { orderId, state },
		form: {
			type: "form",
			fields: [
				{
					type: "select",
					action_id: "reason",
					label: "Reason",
					options: [...CANCELLATION_REASONS],
					initial_value: staged?.reason ?? "customer_request",
				},
				{
					type: "text_input",
					action_id: "detail",
					label: "Detail (optional)",
					placeholder: "e.g. chargeback risk flagged",
					...(staged !== undefined && staged.detail.length > 0
						? { initial_value: staged.detail }
						: {}),
				},
				{
					type: "text_input",
					action_id: "cancelledBy",
					label: "Cancelled by",
					placeholder: "your name",
					...(staged !== undefined ? { initial_value: staged.cancelledBy } : {}),
				},
			],
			submit: { label: "Review cancellation", action_id: ACTION_CANCEL_REVIEW },
		},
	});
}

function cancellationFields(orderId: string, c: OrderCancellationWire): FieldsBlock {
	return fields(`orders:${orderId}:cancel-fields`, [
		["Reason", c.reason],
		["Detail", c.detail ?? "—"],
		["Cancelled by", c.cancelledBy],
		["Cancelled (UTC)", utc(c.cancelledAt)],
	]);
}

// -- panel "Money" ------------------------------------------------------------

function moneyPanel(
	actions: ScreenActions,
	o: OrderDetailWire,
	summary: RefundsSummaryWire | null,
	open: OpenGroup,
	staged: Staged | undefined,
): Block[] {
	if (summary === null) {
		return [
			{
				type: "context",
				// E-1: a secondary read failed ⇒ a `context` line in place of the body,
				// never a banner and never a failed screen.
				text: "Refunds are unavailable right now — the refunds service could not be reached. The order itself is unaffected; reload to try again.",
			},
		];
	}
	const cur = summary.currency.length > 0 ? summary.currency : o.totals.currency;
	return [
		// `Payment` is already in the identity strip; do not repeat it (P-3).
		fields("orders:money", [
			["Captured", formatTotal(summary.capturedTotalCents, cur)],
			["Refunded", formatTotal(summary.refundedTotalCents, cur)],
			["Remaining", formatTotal(summary.remainingCents, cur)],
			// The COUNT carries its unit, not because it is prettier but because a
			// bare integer beside a label matching /refund/ is exactly what X-9's
			// raw-minor-units heuristic rejects — see the PR's disclosure.
			["Refunds recorded", refundCount(summary.refunds.length)],
		]),
		refundsGroup(actions, o, summary, cur, open, staged),
	];
}

function refundsGroup(
	actions: ScreenActions,
	o: OrderDetailWire,
	summary: RefundsSummaryWire,
	cur: string,
	open: OpenGroup,
	staged: Staged | undefined,
): Block {
	const blockId = `orders:${o.id}:refunds`;
	const reviewing = staged?.kind === "refund";
	const body: Block[] = [];
	// A REAL bounded ratio (§2). `custom_value` is MANDATORY because value/max are
	// minor units and `meter` has no currency (M-8, R-20). Omitted at a zero
	// ceiling, where the ratio would be undefined rather than merely empty.
	if (summary.ceilingCents > 0) {
		body.push({
			type: "meter",
			label: "Refunded",
			value: summary.refundedTotalCents,
			max: summary.ceilingCents,
			custom_value: `${formatTotal(summary.refundedTotalCents, cur)} of ${formatTotal(summary.ceilingCents, cur)}`,
		});
	}
	if (summary.refunds.length > 0) body.push(refundsTable(actions, o.id, summary.refunds, cur));
	body.push({ type: "context", text: refundCapabilityText(summary) });

	if (reviewing && staged.kind === "refund") {
		body.push(...refundReviewBody(o, summary, cur, staged));
	} else if (summary.remainingCents > 0) {
		// DA-2b: the majority path is the full remaining balance, so it is ONE
		// danger button with the amount and the watermark in `value` — no round
		// trip, no staleness window.
		body.push({
			type: "actions",
			block_id: `orders:${o.id}:refund-full`,
			elements: [refundFullButton(o, summary, cur)],
		});
		body.push({
			type: "accordion",
			block_id: `orders:${o.id}:refund-partial`,
			label: "Refund a different amount",
			default_open: false, // ALWAYS, for anything destructive (D-5)
			blocks: [
				{
					type: "banner",
					variant: "alert",
					title: "A recorded refund cannot be reversed here",
					description:
						"Review the amount on the next step. Refunds are additive: recording one twice records two refunds.",
				},
				refundPartialForm(o.id, cur, summary),
			],
		});
	} else if (summary.refundedTotalCents > 0) {
		// DA-7: no control at all, one line naming the reason.
		body.push({ type: "context", text: "Fully refunded — nothing left to refund." });
	} else {
		body.push({
			type: "context",
			text: "Nothing has been captured on this order, so there is nothing to refund.",
		});
	}
	return {
		type: "accordion",
		// B-6: on a DA-3 state 2 the id CHANGES and the flag is set — both halves.
		block_id: reviewing ? `${blockId}:review` : blockId,
		// D-6: the label carries the answer, so the group can be skipped unopened.
		label: fitLabel(
			`Refunds — ${formatTotal(summary.refundedTotalCents, cur)} of ${formatTotal(summary.ceilingCents, cur)} refunded`,
		),
		default_open: reviewing && open === "refunds",
		blocks: body,
	};
}

/** DA-2b's full-remaining refund. `value` carries the amount AND
 *  `refundedSoFarCents` — the watermark the operator saw, which is both the
 *  DA-3a re-read key and the third component of the idempotency key (F-2a). */
function refundFullButton(
	o: OrderDetailWire,
	summary: RefundsSummaryWire,
	cur: string,
): ButtonElement {
	const amount = formatTotal(summary.remainingCents, cur);
	return {
		type: "button",
		action_id: ACTION_REFUND,
		label: `Refund ${amount} (full remaining)`,
		value: {
			orderId: o.id,
			amountCents: String(summary.remainingCents),
			refundedSoFarCents: String(summary.refundedTotalCents),
			currency: cur,
			reason: "",
			refundedBy: "",
		},
		style: "danger",
		confirm: {
			title: fit(`Refund ${amount}?`, LABEL_BUDGET),
			text: refundConfirmText(amount, o.customerId ?? o.buyerRef, summary.refundable),
			confirm: `Yes, refund ${amount}`,
			deny: "Keep as is",
			style: "danger",
		},
	};
}

/**
 * DA-3 state 2 for a refund: the staged form remounted plus ONE danger confirm.
 * The DA-2b full-remaining button and the nested partial-amount accordion are
 * both omitted here — a second refund control beside a staged one is exactly the
 * ambiguity the confirm dialog exists to remove.
 */
function refundReviewBody(
	o: OrderDetailWire,
	summary: RefundsSummaryWire,
	cur: string,
	staged: Staged & { kind: "refund" },
): Block[] {
	const amount = formatTotal(staged.amountCents, cur);
	return [
		{
			type: "banner",
			variant: "alert",
			title: "A recorded refund cannot be reversed here",
			description: `Confirm below to refund ${amount}. Edit the form and review again to change the amount.`,
		},
		refundPartialForm(o.id, cur, summary, staged),
		{
			type: "actions",
			block_id: `orders:${o.id}:refund-confirm`,
			elements: [
				{
					type: "button",
					action_id: ACTION_REFUND,
					label: `Refund ${amount}`,
					value: {
						orderId: o.id,
						amountCents: String(staged.amountCents),
						// The watermark AS THE OPERATOR SAW IT — not as it is now.
						refundedSoFarCents: String(staged.refundedSoFarCents),
						currency: staged.currency,
						reason: staged.reason,
						refundedBy: staged.refundedBy,
					},
					style: "danger",
					confirm: {
						title: fit(`Refund ${amount}?`, LABEL_BUDGET),
						text: refundConfirmText(amount, o.customerId ?? o.buyerRef, summary.refundable),
						confirm: `Yes, refund ${amount}`,
						deny: "Keep as is",
						style: "danger",
					},
				},
			],
		},
	];
}

/**
 * `confirm.text` — exactly two sentences, ≤200 (§1): one naming the concrete
 * amount and recipient, one naming the consequence.
 *
 * The recipient is dropped when a long buyer handle would push the string over
 * budget. Truncating a confirm dialog mid-sentence would be worse than a slightly
 * less specific one, and the budget is a hard rule (X-11).
 */
function refundConfirmText(amount: string, recipient: string, refundable: boolean): string {
	const consequence = refundable
		? "This sends the money back through Stripe and cannot be reversed."
		: "This records a refund made out of band — it does not move money.";
	const named = `Refund ${amount} to ${recipient}? ${consequence}`;
	return named.length <= 200 ? named : `Refund ${amount} to this order's buyer? ${consequence}`;
}

/** The honest per-gateway capability copy (ADR-0008), each ≤200 (§1): Stripe
 *  moves money; x402 / no-secret is record-only, and says why. */
function refundCapabilityText(s: RefundsSummaryWire): string {
	if (s.refundable) {
		return `Paid via ${s.paymentMethod ?? "the payment provider"} — refunding here issues a REAL refund through Stripe and money moves back to the buyer.`;
	}
	if (s.paymentMethod === "x402") {
		return "Paid on-chain (x402), which cannot be reversed and has no signing wallet — refunds here are RECORD-ONLY. Send the return yourself, then record it here.";
	}
	return "Automatic refunds are unavailable for this order — refunds here are RECORD-ONLY. Issue it through your payment provider, then record it here.";
}

function refundsTable(
	actions: ScreenActions,
	orderId: string,
	refunds: RefundWire[],
	cur: string,
): TableBlock {
	return {
		type: "table",
		block_id: `orders:${orderId}:refunds:table`,
		columns: [
			{ key: "amount", label: "Amount" },
			{ key: "kind", label: "Kind", format: "badge" }, // lifecycle state (T-5)
			{ key: "ref", label: "Provider ref", format: "code" },
			{ key: "by", label: "By" },
			{ key: "when", label: "When", format: "relative_time" },
		],
		rows: refunds.map((r) => ({
			amount: formatTotal(r.amountCents, r.currency.length > 0 ? r.currency : cur),
			kind: r.kind,
			ref: r.refundRef ?? "—",
			by: r.refundedBy,
			when: r.createdAt,
		})),
		page_action_id: actions.page, // never fires: no next_cursor (T-8), no sortable column
		empty_text: "No refunds recorded.",
	};
}

/**
 * THREE visible fields (§11.2). The order id, the currency and — critically — the
 * observed `refundedSoFar` watermark ride in the carrier. The two carrier
 * `select`s labelled `orderId`/`currency` are deleted, and SO IS THE `nonce`
 * `select`: it is not relocated (F-2a). The amount is a TEXT input parsed to
 * integer minor units (M-3, F-6) — `number_input` would put a float on the money
 * path.
 */
function refundPartialForm(
	orderId: string,
	cur: string,
	summary: RefundsSummaryWire,
	staged?: Staged & { kind: "refund" },
): FormBlock {
	return carriedForm({
		namespace: "orders:refund-partial",
		context: {
			orderId,
			currency: cur,
			refundedSoFar: String(summary.refundedTotalCents),
		},
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "amount",
					label: `Refund amount (${cur})`,
					placeholder: "e.g. 19.99",
					initial_value: formatMinorUnitsInput(staged?.amountCents ?? summary.remainingCents),
				},
				{
					type: "text_input",
					action_id: "reason",
					label: "Reason (optional)",
					placeholder: "e.g. damaged in transit",
					...(staged !== undefined && staged.reason.length > 0
						? { initial_value: staged.reason }
						: {}),
				},
				{
					type: "text_input",
					action_id: "refundedBy",
					label: "Refunded by",
					placeholder: "your name",
					...(staged !== undefined ? { initial_value: staged.refundedBy } : {}),
				},
			],
			submit: { label: "Review refund", action_id: ACTION_REFUND_REVIEW },
		},
	});
}

// -- panel "History" ---------------------------------------------------------

/** T-8's cap: a leaf detail's table MUST NOT set `next_cursor` (a load-more click
 *  at leaf depth blanks the page), so the read is capped and the cap is stated. */
const TIMELINE_CAP = 50;
const NOTES_CAP = 20;

function historyPanel(
	actions: ScreenActions,
	o: OrderDetailWire,
	notes: OrderNoteWire[],
	timeline: OrderTimelineWire | null,
	_open: OpenGroup,
): Block[] {
	const blocks: Block[] = [];
	if (timeline === null) {
		blocks.push({
			type: "context",
			// E-3: names what failed, what is unaffected, and the one next step.
			text: "Timeline unavailable — it could not be loaded right now. The order itself is unaffected; reload, and check the admin token in Settings if this persists.",
		});
	} else {
		const shown = timeline.entries.slice(-TIMELINE_CAP);
		blocks.push({
			type: "table",
			block_id: "orders:timeline",
			columns: [
				{ key: "at", label: "When", format: "relative_time" }, // M-6
				{ key: "what", label: "Event", format: "badge" }, // event kind (T-5)
				{ key: "who", label: "Who" },
				{ key: "detail", label: "Detail" },
			],
			rows: shown.map((e) => ({
				at: e.at,
				what: timelineWhat(e),
				who: timelineWho(e),
				detail: timelineDetail(e),
			})),
			page_action_id: actions.page, // never fires: no next_cursor (T-8), no sortable column
			empty_text: "No timeline activity yet.",
		});
		blocks.push({
			type: "context",
			text: timeline.stateChangesAudited
				? "State changes come from the audit log; notes and recorded actions are merged in. Times UTC."
				: "This order's state changes predate the audit log, so earlier transitions aren't shown — its notes and recorded actions still appear. Times UTC.",
		});
		if (timeline.entries.length > shown.length) {
			blocks.push({
				type: "context",
				text: `Showing the ${TIMELINE_CAP} most recent events; older activity is not listed.`,
			});
		}
	}
	blocks.push(notesGroup(actions, o, notes));
	return blocks;
}

function notesGroup(actions: ScreenActions, o: OrderDetailWire, notes: OrderNoteWire[]): Block {
	const shown = notes.slice(-NOTES_CAP);
	const body: Block[] = [];
	if (shown.length > 0) {
		body.push({
			type: "table",
			block_id: `orders:${o.id}:notes:table`,
			columns: [
				{ key: "createdAt", label: "When", format: "relative_time" },
				{ key: "author", label: "Author" },
				{ key: "body", label: "Note" },
			],
			rows: shown.map((n) => ({ createdAt: n.createdAt, author: n.author, body: n.body })),
			page_action_id: actions.page, // never fires: no next_cursor (T-8), no sortable column
			empty_text: "No notes yet.",
		});
		if (notes.length > shown.length) {
			body.push({
				type: "context",
				text: `Showing the ${NOTES_CAP} most recent notes; older notes are not listed.`,
			});
		}
	}
	body.push(addNoteForm(o.id));
	return {
		type: "accordion",
		block_id: `orders:${o.id}:notes`,
		label: `Notes (${notes.length})`, // D-6
		default_open: false,
		blocks: body,
	};
}

/** TWO visible fields, in F-1's order: what is being changed first, attribution
 *  last. The order id rides in the carrier — it used to be a single-option
 *  `select` labelled `Order`. DA-4: one-shot, no confirm. */
function addNoteForm(orderId: string): FormBlock {
	return carriedForm({
		namespace: "orders:note",
		context: { orderId },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "body",
					label: "Note",
					placeholder: "Add a note…",
					multiline: true, // F-6: free text over one line
				},
				{
					type: "text_input",
					action_id: "author",
					label: "Author",
					placeholder: "e.g. your name",
				},
			],
			submit: { label: "Add note", action_id: ACTION_ADD_NOTE },
		},
	});
}

// -- timeline row formatting --------------------------------------------------

/** The event label for a timeline row. Unknown kinds degrade to the raw kind
 *  string rather than throwing. */
function timelineWhat(e: TimelineEntryWire): string {
	switch (e.kind) {
		case "created":
			return "Order created";
		case "state_change":
			return `Status → ${e.toState ?? "?"}`;
		case "note":
			return "Note added";
		case "fulfillment":
			return "Fulfilment recorded";
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

// -- custom actions -----------------------------------------------------------

/**
 * DA-3b: a payload that fails to decode renders an `error` notice, never a silent
 * redirect. The old `if (orderId === undefined) return showList()` bounced the
 * operator to the list with no explanation at all.
 */
const UNREADABLE: Notice = {
	variant: "error",
	title: "That action could not be read",
	description: "Nothing was changed. Reload the order and try again.",
};

/**
 * One handler per state, closed over the target from {@link ORDER_STATES} — so
 * the state a transition writes comes from the ACTION ID (which only exists
 * because it was derived from that list) and never from the operator-alterable
 * `value.toState` (DA-6).
 */
function transitionAction(toState: string) {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const orderId = readString(asRecord(input.value)?.orderId);
		if (orderId === undefined) return showList(undefined, UNREADABLE);
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
			// Not a failure: surface a non-error notice rather than a silent re-render.
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
	return customAction<AdminOrdersClient>(async ({ carried, input, client, showLeaf, showList }) => {
		// Read the carried context, never `carried.__path` — reserved keys are
		// stripped for screens, and the path is on `carriedPath`.
		const orderId = readString(carried?.orderId);
		if (orderId === undefined) return showList(undefined, UNREADABLE);
		const values = input.values ?? {};
		const author = (readString(values.author) ?? "").trim();
		const body = (readString(values.body) ?? "").trim();
		// Local guard: a blank note never leaves the plugin (the domain rejects it
		// too, but this gives inline feedback without a round trip).
		if (author.length === 0 || body.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Note not added",
				description: "Enter both an author and a note body.",
			});
		}
		// Content-derived key (F-2a): a double-submit of the same note is a no-op,
		// a genuinely new note still appends.
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
	return customAction<AdminOrdersClient>(async ({ carried, input, client, showLeaf, showList }) => {
		const orderId = readString(carried?.orderId);
		if (orderId === undefined) return showList(undefined, UNREADABLE);
		// The flag AS DISPLAYED when the form rendered — the compare-and-clear key,
		// now carried invisibly instead of shown as a dropdown labelled
		// `expectedFlag`.
		const expectedFlag = readString(carried?.expectedFlag) ?? "";
		const values = input.values ?? {};
		const outcome = readString(values.outcome) ?? "";
		const reason = (readString(values.reason) ?? "").trim();
		const resolvedBy = (readString(values.resolvedBy) ?? "").trim();
		if (reason.length === 0 || resolvedBy.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not resolved",
				description: "Enter both a reason and who is resolving it.",
			});
		}
		const key = `admin-resolve-reconciliation:${orderId}`;
		const result = await client.resolveReconciliation(
			orderId,
			{ expectedFlag, outcome, reason, resolvedBy },
			{ idempotencyKey: key },
		);
		let notice: Notice | undefined;
		if (!result.ok) {
			// A stale review gets its own copy: the flag changed under the admin, the
			// re-render below already shows the NEW flag.
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
			notice = {
				variant: "default",
				title: "Already resolved",
				description: "This order's reconciliation flag was already cleared.",
			};
		} else {
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
	return customAction<AdminOrdersClient>(async ({ carried, input, client, showLeaf, showList }) => {
		const orderId = readString(carried?.orderId);
		if (orderId === undefined) return showList(undefined, UNREADABLE);
		const values = input.values ?? {};
		const carrier = (readString(values.carrier) ?? "").trim();
		const trackingNumber = (readString(values.trackingNumber) ?? "").trim();
		const recordedBy = (readString(values.recordedBy) ?? "").trim();
		if (carrier.length === 0 || trackingNumber.length === 0 || recordedBy.length === 0) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not shipped",
				description: "Enter the carrier, tracking number, and who is recording it.",
			});
		}
		const trackingUrl = (readString(values.trackingUrl) ?? "").trim();
		// The tracking URL, when given, must be http(s) — the SAME bound the service
		// schema enforces. Defense in depth: this value is emailed to the buyer, so a
		// `javascript:`/`data:` URI is rejected here with inline feedback.
		if (trackingUrl.length > 0 && !/^https?:\/\/\S+$/i.test(trackingUrl)) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Not shipped",
				description: "The tracking URL must be a web link starting with http:// or https://.",
			});
		}
		// A `date_input` yields YYYY-MM-DD; the service wants a full ISO datetime.
		const shippedAt = normalizeBound(readString(values.shippedAt));
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
								"That fulfilment could not be recorded — check the order and the admin token in Settings.",
						};
		} else if (!result.recorded) {
			notice = {
				variant: "default",
				title: "Already shipped",
				description: "This order was already shipped; its recorded tracking is shown above.",
			};
		} else {
			notice = {
				variant: "default",
				title: "Order shipped",
				description: "Fulfilment recorded — the buyer has been emailed their tracking.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

/** DA-3 state 1 → 2 for a cancellation: validate, then re-render with the group
 *  forced open and the typed values staged. NOTHING is written here. */
function cancelReviewAction() {
	return customAction<AdminOrdersClient>(async (api) => {
		const orderId = readString(api.carried?.orderId);
		if (orderId === undefined) return api.showList(undefined, UNREADABLE);
		const state = readString(api.carried?.state) ?? "";
		const values = api.input.values ?? {};
		const reason = readString(values.reason) ?? "";
		const detail = (readString(values.detail) ?? "").trim();
		const cancelledBy = (readString(values.cancelledBy) ?? "").trim();
		if (!CANCEL_REASON_LABELS.has(reason) || cancelledBy.length === 0) {
			return api.showLeaf([orderId], {
				variant: "error",
				title: "Not cancelled",
				description: "Choose a reason and enter who is cancelling it. Nothing was changed.",
			});
		}
		return stagedResponse(api, orderId, {
			kind: "cancel",
			orderId,
			reason,
			detail,
			cancelledBy,
			state,
		});
	});
}

/**
 * Shared by DA-2b's five per-reason buttons AND DA-3's state-2 confirm — one
 * handler, because both carry the same `{orderId, reason, state}` in
 * `button.value` (the DA-3 one adds `detail`).
 *
 * DA-3a, MANDATORY: re-read the order and refuse on a watermark mismatch. The
 * staged `state` is what the operator saw; if the order moved under them, apply
 * NOTHING and name both figures.
 */
function cancelOrderAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const payload = asRecord(input.value);
		const orderId = readString(payload?.orderId);
		if (orderId === undefined) return showList(undefined, UNREADABLE);
		const reason = readString(payload?.reason) ?? "";
		const detail = (readString(payload?.detail) ?? "").trim();
		const cancelledBy = (readString(payload?.cancelledBy) ?? "").trim();
		const observedState = readString(payload?.state) ?? "";
		// Every decoded value is UNTRUSTED operator-round-tripped input (B-1), so the
		// closed set is re-checked here and not merely at render.
		if (!CANCEL_REASON_LABELS.has(reason)) {
			return showLeaf([orderId], UNREADABLE);
		}
		// DA-3a: re-read before writing.
		const live = await client.getOrder(orderId).catch(() => null);
		if (live === null) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Nothing was cancelled",
				description:
					"This order could not be re-checked before cancelling, so nothing was applied. Reload and try again.",
			});
		}
		if (observedState.length > 0 && live.order.state !== observedState) {
			return showLeaf([orderId], {
				variant: "error",
				title: "The order changed — nothing was cancelled",
				description: `It was ${observedState} when you started and is now ${live.order.state}. Check the order below before cancelling.`,
			});
		}
		const key = `admin-cancel:${orderId}`;
		const result = await client.cancelOrder(
			orderId,
			{
				reason,
				...(detail.length > 0 ? { detail } : {}),
				cancelledBy: cancelledBy.length > 0 ? cancelledBy : "admin",
			},
			{ idempotencyKey: key },
		);
		let notice: Notice | undefined;
		if (!result.ok) {
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

/** DA-3 state 1 → 2 for a refund: parse the amount, then re-render with the
 *  Refunds group forced open and the amount staged. NOTHING is written here. */
function refundReviewAction() {
	return customAction<AdminOrdersClient>(async (api) => {
		const orderId = readString(api.carried?.orderId);
		if (orderId === undefined) return api.showList(undefined, UNREADABLE);
		const currency = (readString(api.carried?.currency) ?? "").trim();
		const refundedSoFarCents = parseCents(api.carried?.refundedSoFar);
		const values = api.input.values ?? {};
		const amountStr = (readString(values.amount) ?? "").trim();
		const reason = (readString(values.reason) ?? "").trim();
		const refundedBy = (readString(values.refundedBy) ?? "").trim();
		// Money parsed to integer MINOR UNITS with exact integer string math (no
		// float). `allowZero:false` — a refund of nothing is meaningless.
		const amountCents = parseMinorUnitsInput(amountStr, { allowZero: false });
		if (amountCents === null || refundedSoFarCents === null || currency.length === 0) {
			return api.showLeaf([orderId], {
				variant: "error",
				title: "Not refunded",
				description:
					"Enter a valid refund amount greater than zero (e.g. 19.99). Nothing was changed.",
			});
		}
		if (refundedBy.length === 0) {
			return api.showLeaf([orderId], {
				variant: "error",
				title: "Not refunded",
				description: "Enter who is issuing or recording this refund. Nothing was changed.",
			});
		}
		return stagedResponse(api, orderId, {
			kind: "refund",
			orderId,
			amountCents,
			refundedSoFarCents,
			currency,
			reason,
			refundedBy,
		});
	});
}

/**
 * The money-moving confirm — DA-2b's full-remaining button and DA-3's state-2
 * confirm both land here.
 *
 * TWO RULES APPLY TOGETHER, and neither is sufficient alone:
 *  - DA-3a: RE-READ the refund ledger and refuse on a watermark mismatch, so a
 *    stale staged amount is never applied. Operator A stages $99.00; operator B
 *    refunds $99.00; A's dialog still says "Refund $99.00" — a false statement.
 *  - F-2a: derive the key from `${orderId}:${amountCents}:${refundedSoFarCents}`.
 *    The watermark makes two DELIBERATE identical refunds differ (so both apply)
 *    while a double-click of the same button dedupes.
 *
 * They compose: DA-3a rejects the stale submit before the key is ever derived,
 * which matters because `refundOrder` resolves a duplicate by KEY ALONE with no
 * amount comparison (issue #152).
 */
function refundOrderAction() {
	return customAction<AdminOrdersClient>(async ({ input, client, showLeaf, showList }) => {
		const payload = asRecord(input.value);
		const orderId = readString(payload?.orderId);
		if (orderId === undefined) return showList(undefined, UNREADABLE);
		const amountCents = parseCents(payload?.amountCents);
		const observedSoFar = parseCents(payload?.refundedSoFarCents);
		const currency = (readString(payload?.currency) ?? "").trim();
		const reason = (readString(payload?.reason) ?? "").trim();
		const refundedBy = (readString(payload?.refundedBy) ?? "").trim();
		if (
			amountCents === null ||
			amountCents <= 0 ||
			observedSoFar === null ||
			currency.length === 0
		) {
			return showLeaf([orderId], UNREADABLE);
		}
		// DA-3a: re-read, then compare against the watermark the operator SAW.
		const live = await client.getRefunds(orderId).catch(() => null);
		if (live === null) {
			return showLeaf([orderId], {
				variant: "error",
				title: "Nothing was refunded",
				description:
					"The refund ledger could not be re-checked, so nothing was applied. Reload and try again.",
			});
		}
		const liveCur = live.currency.length > 0 ? live.currency : currency;
		if (live.refundedTotalCents !== observedSoFar) {
			return showLeaf([orderId], {
				variant: "error",
				title: "The refund ledger changed — nothing was refunded",
				description: `${formatTotal(amountCents, liveCur)} was staged, but ${formatTotal(live.remainingCents, liveCur)} now remains refundable. Check the refund ledger below.`,
			});
		}
		// The observed watermark is the third key component (F-2a) — NOT a nonce.
		const key = `admin-refund:${orderId}:${amountCents}:${observedSoFar}`;
		const result = await client.refundOrder(
			orderId,
			{
				amountCents,
				currency,
				...(reason.length > 0 ? { reason } : {}),
				refundedBy: refundedBy.length > 0 ? refundedBy : "admin",
			},
			{ idempotencyKey: key },
		);
		let notice: Notice;
		if (!result.ok) {
			notice = refundFailureNotice(result.reason);
		} else if (result.duplicate) {
			// A benign replay: the SAME amount against the SAME watermark, i.e. a
			// double-click. A different amount would have produced a different key.
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
					"The refund was recorded. The order stays in its current status; Money → Refunds shows what remains.",
			};
		}
		return showLeaf([orderId], notice);
	});
}

/**
 * Re-render the leaf with a DA-3 staged payload in place. The scaffold's
 * `showLeaf` cannot carry render state, so the leaf's reads are repeated here —
 * the alternative would be threading a staging channel through the shared engine
 * for one screen.
 *
 * A failure falls back to a plain state-1 render with an honest notice: nothing
 * was written on a `-review`, so this must NOT reach the engine's containment,
 * whose copy says a mutation may already have applied.
 */
async function stagedResponse(
	api: CustomActionApi<AdminOrdersClient>,
	orderId: string,
	staged: Staged,
): Promise<BlockResponse> {
	try {
		const detail = await api.client.getOrder(orderId);
		if (detail === null) return api.showLeaf([orderId]);
		const surfaces = await loadDetailSurfaces(api.client, orderId);
		return {
			blocks: detailBlocks({
				actions: ORDERS_ACTIONS,
				path: [orderId],
				detail,
				...surfaces,
				notice: undefined,
				staged,
			}),
		};
	} catch (err) {
		// Contained failures are indistinguishable from an unreachable service in
		// the UI, so the cause has to reach the log or a screen bug reads as an
		// outage.
		console.error("[urumi] orders: staged re-render failed:", err);
		return api.showLeaf([orderId], {
			variant: "error",
			title: "Could not show that for review",
			description: "Nothing was changed. Reload the order and try again.",
		});
	}
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

/** What an unformattable amount renders as (M-1): a wrong number is worse than a
 *  missing one, and raw minor units in a money field is the bug this kills. */
const UNFORMATTABLE = "—";

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

/** A `fields` block from label/value PAIRS, so an odd entry count is visible at
 *  the call site — `fields` is a row-major `grid-cols-2` (R-3), so entries read
 *  left→right then down and must be authored in pairs (§2). */
function fields(blockId: string, entries: ReadonlyArray<readonly [string, string]>): FieldsBlock {
	return {
		type: "fields",
		block_id: blockId,
		fields: entries.map(([label, value]) => ({ label, value })),
	};
}

/** Trim a string to `max`, ellipsis included — for the two places a rendered
 *  string's length depends on SERVICE DATA (an accordion label carrying a
 *  tracking number, a banner quoting a settlement anomaly) and could otherwise
 *  blow a §1 budget through no fault of the copy. */
function fit(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** An `accordion.label` inside §1's 60-char budget (X-11). */
function fitLabel(text: string): string {
	return fit(text, LABEL_BUDGET);
}

/** An absolute UTC timestamp TRIMMED TO SECONDS (M-6): milliseconds are noise,
 *  and X-13 rejects them outright. No timezone conversion, ever — a
 *  non-conforming value passes through unchanged rather than being mangled. */
function utc(iso: string): string {
	return iso.replace(/\.\d+(?=Z$)/, "");
}

/** Read integer minor units out of an untrusted carried/button payload. Rejects
 *  anything that is not a plain non-negative integer string — money never
 *  crosses this boundary as a float (B-2). */
function parseCents(value: unknown): number | null {
	const raw = readString(value);
	if (raw === undefined || !/^\d+$/.test(raw)) return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
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

/**
 * The submitted filter, with every field at its default omitted — which is
 * exactly what L-3's `(N active)` count and L-6's summary are derived from, so
 * "active" means one thing on this screen.
 *
 * The status sentinel is the word `any`, not `""` (F-6a): an empty option value
 * renders a BLANK trigger in the pinned renderer, and the trigger shows the raw
 * value rather than the label (R-17a).
 */
function filterFromValues(values: Record<string, unknown>): OrdersFilterForm {
	const form: OrdersFilterForm = {};
	const status = readString(values.status);
	const from = readString(values.from);
	const to = readString(values.to);
	const search = readString(values.search);
	if (status !== undefined && status.length > 0 && status !== ANY) form.status = status;
	if (from !== undefined && from.length > 0) form.from = from;
	if (to !== undefined && to.length > 0) form.to = to;
	if (search !== undefined && search.length > 0) form.search = search;
	return form;
}

/** A refund count as a phrase rather than a bare integer (see the call site). */
function refundCount(n: number): string {
	if (n === 0) return "None";
	return n === 1 ? "1 refund" : `${n} refunds`;
}

/** A one-line reconciliation summary for the identity strip. */
function reconciliationSummary(o: OrderDetailWire): string {
	if (o.reconciliationFlag !== null) return "⚠ Needs reconciliation";
	if (o.reconciliationResolution !== null) {
		return `Resolved (${o.reconciliationResolution.outcome})`;
	}
	return "None";
}

/**
 * Format an order-currency amount for display (M-1: money is ALWAYS formatted).
 *
 * Two deliberate behaviours:
 *  - A negative amount formats as its absolute value with an explicit minus
 *    prefix, because `cents()` is branded NON-NEGATIVE and throws below zero.
 *  - An amount `Intl` cannot format renders {@link UNFORMATTABLE}, never
 *    `${CUR} ${minorUnits}`. The old fallback printed RAW MINOR UNITS in the one
 *    place it was least visible — a wrong number dressed as a formatted total.
 *    The totals ladder says so in a `context` line when it happens.
 */
function formatTotal(minorUnits: number, currencyCode: string): string {
	try {
		const currency = toCurrency(currencyCode);
		return minorUnits < 0
			? `−${formatMoney(toCents(Math.abs(minorUnits)), currency, "en-US")}`
			: formatMoney(toCents(minorUnits), currency, "en-US");
	} catch {
		return UNFORMATTABLE;
	}
}
