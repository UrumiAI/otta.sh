import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
import type {
	AdminPageConfig,
	Block,
	ButtonElement,
	ConfirmDialog,
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
	SHORT_ID_CONFIRM_LEN,
	shortIdFixed,
	shortIdsFor,
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
 * FIVE THINGS THAT WILL BITE A SCREEN AUTHOR COPYING THIS FILE:
 *  1. NO VISIBLE PLUMBING. Every id/watermark a stateless submit needs rides
 *     invisibly in the form's `block_id` via {@link carriedForm} (F-2, B-3a), and
 *     every BUTTON carries its context in `value` because a button echoes no
 *     `block_id` (B-1). There is not one single-option `select` left (F-3), and the
 *     one `select` that remains carries HUMAN LABELS as its option values, because
 *     the pinned renderer's trigger shows the raw value (R-17a, F-6c).
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
 *  4. EVERY REFUSAL RE-RENDERS STATE 1, FLATTENED, THROUGH THE SCAFFOLD'S
 *     RENDER-STATE CHANNEL. There is no second read-and-render path in this file:
 *     a `-review`, a DA-3a refusal and a DA-3c refusal all go back through
 *     `showLeaf(path, notice?, renderState?)` and the LEVEL's own `render`, so the
 *     figures an operator sees after a refusal always come from a fresh read
 *     ({@link OrdersRenderState}, DA-3a-i/-ii/-iii). The one non-obvious constraint:
 *     a refusal's group needs a `block_id` distinct from BOTH the idle key and the
 *     `:review` key, and the collect form must be flattened INTO that group — leave
 *     it in its nested `default_open: false` child and the operator's rejected
 *     input is on the page and invisible.
 *  5. A THROW IN HERE IS CONTAINED and renders this screen's `onError()` banner —
 *     the SAME banner as "the service is unreachable", which is exactly why that
 *     banner's copy must not claim the service is unreachable (E-7). So a
 *     `filterPanel` field over budget or a rejected carrier namespace looks like an
 *     outage. Suspect this file first; the cause is in the worker log.
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

/**
 * The transitions whose bare one-click is IRREVERSIBLE: DA-5's danger style plus a
 * confirm dialog, WITH THE COPY KEYED OFF THE TARGET STATE.
 *
 * Keyed rather than written inline behind a set membership test: with a bare
 * `DANGER_STATES` set, a second member would silently inherit `refunded`'s dialog
 * and a `Mark voided` button would raise a confirm claiming to mark the order
 * refunded. Correct today, wrong the moment the set grows — so the copy lives with
 * the state it describes and there is no way to add one without the other.
 *
 * `cancelled` is absent because it is never offered as a bare transition at all —
 * it is steered to the Cancel group, which records a reason (DA-7).
 */
const DANGER_TRANSITIONS: ReadonlyMap<string, ConfirmDialog> = new Map([
	[
		"refunded",
		{
			title: "Mark this order refunded?",
			text: "Marks the order refunded for bookkeeping. It does not move money — record the money in Money → Refunds.",
			confirm: "Yes, mark refunded",
			deny: "Keep as is",
			style: "danger",
		} satisfies ConfirmDialog,
	],
]);

/**
 * The five structured cancellation reasons — the WIRE values the domain accepts
 * (mirroring `CancellationReason`; the service re-validates), each with the human
 * label an operator reads. This list is the source of the per-reason action ids.
 *
 * `other`'s label is the bare word: it used to read `Other (add detail below)`,
 * which promised a field the DA-2b button could not provide (§11.2). Inside the
 * DA-3 note form — the only path that records detail — the Detail field is
 * directly below, so the parenthetical said nothing the form did not.
 */
const CANCELLATION_REASONS: readonly SelectOption[] = [
	{ value: "customer_request", label: "Customer requested it" },
	{ value: "fraud_suspected", label: "Fraud suspected" },
	{ value: "out_of_stock", label: "Out of stock" },
	{ value: "pricing_error", label: "Pricing error" },
	{ value: "other", label: "Other" },
];

/**
 * DA-2b's buttons: every reason EXCEPT `other`. A bare `Other` button records no
 * detail and fires immediately, so it pointed an operator wanting to explain
 * themselves at a group that may be collapsed; `other` lives in the note form's
 * `select`, which is the only path that records detail (§11.2).
 *
 * Dropping it also takes the fan-out from five buttons to FOUR, which is inside
 * DA-2c's cap — so the buttons keep `style:"danger"` rather than going quiet, and
 * the check DA-2c asks for ("is the enum really that wide?") answers itself here.
 */
const CANCEL_BUTTON_REASONS: readonly SelectOption[] = CANCELLATION_REASONS.filter(
	(r) => r.value !== "other",
);

const CANCEL_REASON_LABELS: ReadonlyMap<string, string> = new Map(
	CANCELLATION_REASONS.map((r) => [r.value, r.label]),
);

/**
 * The inverse map, and the reason it exists: the pinned renderer's `select`
 * trigger renders the raw option VALUE, not its label (R-17a, F-6c). With
 * `customer_request` as the option value, the one `select` left on this screen
 * displayed a raw internal identifier — the single thing still undercutting this
 * file's claim to have removed visible plumbing, and it did so directly beneath
 * four DA-2b buttons already showing the human labels.
 *
 * So the note form's option **value IS the human label**, and a submit is mapped
 * back through here to the wire value. The labels are unique by construction (they
 * are authored above), and every mapped value is re-checked against
 * {@link CANCEL_REASON_LABELS} before it reaches the service.
 */
const CANCEL_REASON_BY_LABEL: ReadonlyMap<string, string> = new Map(
	CANCELLATION_REASONS.map((r) => [r.label, r.value]),
);

/** The note form's default reason, in the OPTION-VALUE space above (a label). */
const DEFAULT_CANCEL_REASON_OPTION =
	CANCEL_REASON_LABELS.get("customer_request") ?? "Customer requested it";

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
 * THIS SCREEN'S RENDER STATE (DA-3a-iii) — one discriminated union, named at
 * {@link createOrdersPageHandler}'s `createListDetailHandler<OrdersRenderState>`,
 * which is the one place the levels and the custom actions are checked against each
 * other. It answers the question a `notice` cannot: a banner says WHAT HAPPENED,
 * this says WHAT TO RENDER NOW — which group to open, which values to put back in
 * a form.
 *
 * FOUR MEMBERS, TWO PER DESTRUCTIVE FLOW, and the pairing is the point:
 *
 *  - `*-staged` is DA-3 **state 2**: the operator's input has passed every check,
 *    so it is carried in PARSED form together with THE WATERMARK THEY SAW, which
 *    the state-2 confirm button echoes into `value` so the write can re-read and
 *    refuse on a mismatch (DA-3a).
 *  - `*-draft` is a **refusal** (DA-3a's stale watermark, DA-3c's failed bound
 *    check, a validation failure, or an unreadable payload): state 1 re-rendered
 *    into the same group, forced open, flattened, with the submitted values
 *    prefilled and NO confirm control (DA-3a-i).
 *
 * TWO PROPERTIES OF THE DRAFT MEMBERS THAT ARE FORCED, NOT STYLISTIC:
 *
 *  1. **A DRAFT CARRIES RAW OPERATOR TEXT** (`amountInput`, `reasonInput`), never
 *     minor units (DA-3a-iii property 5). `refundReviewAction` refuses precisely
 *     when `parseMinorUnitsInput` returns `null` — the single most frequent refusal
 *     on this screen, a typo in the amount field — so on that path there IS no
 *     `amountCents` to re-derive a prefill from, and a rejected `19,99` cannot be
 *     reconstructed from cents. The form prefills the string VERBATIM.
 *  2. **A DRAFT CARRIES NO WATERMARK.** The re-rendered form rebuilds it from the
 *     freshly-read summary ({@link refundPartialForm}), so the operator's next
 *     review stages against current truth BY CONSTRUCTION rather than by anyone
 *     remembering to re-stamp it — and B-3 independently requires a prefilling
 *     form's change token to reflect the current record.
 *
 * It is within-request only (property 2): nothing is stored or echoed to the
 * client, and whatever must survive the NEXT click still rides in `button.value`
 * or the form's `block_id` carrier exactly as before.
 */
type OrdersRenderState =
	| {
			kind: "refund-staged";
			/** Integer minor units (M-3) — parsed, bound-checked and ≤ the live ceiling. */
			amountCents: number;
			/** The watermark: `refundedTotalCents` AS THE OPERATOR SAW IT. */
			refundedSoFarCents: number;
			currency: string;
			reason: string;
			refundedBy: string;
	  }
	| {
			kind: "refund-draft";
			/** VERBATIM operator text, unparsed — see the note above. */
			amountInput: string;
			reason: string;
			refundedBy: string;
	  }
	| {
			kind: "cancel-staged";
			/** The WIRE reason (`out_of_stock`), mapped back from the option label. */
			reason: string;
			detail: string;
			cancelledBy: string;
			/** The watermark: the order `state` AS THE OPERATOR SAW IT. */
			state: string;
	  }
	| {
			kind: "cancel-draft";
			/** The submitted option value, which on this screen IS the human label
			 *  (see {@link CANCEL_REASON_BY_LABEL}) — prefilled back verbatim when it
			 *  is a known option, and dropped to the default when it is not, because
			 *  X-23 forbids an `initial_value` absent from `options`. */
			reasonInput: string;
			detail: string;
			cancelledBy: string;
	  };

/** The em-dash BlockInteraction envelope this page consumes. */
export type OrdersPageInput = ListDetailInput;

export function createOrdersPageHandler(): RouteHandler<OrdersPageInput> {
	// The render-state type is NAMED here rather than inferred (DA-3a-iii property
	// 1): this call is the one place the levels and the custom actions meet, so
	// naming it is what puts a mismatch between them where both ends are visible.
	return createListDetailHandler<OrdersRenderState>({
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

	// D4 / §1.3, and the reason this table was restructured: the screen used to
	// LEAD with 36 characters of entropy. A uuid is not the thing an operator
	// searched for — it is a key they carry to the next surface — so the lead
	// goes to `Placed` and `Customer`, the two columns a human actually scans,
	// and the id renders as a git-style shortest-unique PREFIX (PM §C.3,
	// DESIGNER §1 item 1).
	//
	// WHY THE PREFIX IS NOT THE FINAL COLUMN, though the audit called it
	// "trailing": T-2's money edge is load-bearing and the audit's own §1 item
	// says why. Block Kit tables have no per-column alignment of ANY kind (R-7),
	// so the last column is the only place a money column reads as a column of
	// money rather than as ragged text. Money keeps the edge; the id takes the
	// slot in front of it. Both halves of T-2's rule that can be satisfied here
	// are — the id is out of the lead, the money is last — and the half that
	// cannot ("identity first") is the one D4 exists to overturn.
	//
	// `shortIdsFor` runs over `orders`: THE SAME ARRAY `openOrderForm` below is
	// built from. It is deterministic over the SET of ids, so the token in a row
	// and the token in that row's picker option are the same string by
	// construction rather than by coincidence — and the suite pins the identity
	// instead of trusting it.
	//
	// NO COPY BUTTON and no full id anywhere in the row: a Block Kit table cell
	// is a scalar with no per-cell affordance, which is §1.3's accepted
	// degradation. The full id is one drill away, on the detail screen's
	// identity strip, which is §1.3's "the full id remains obtainable".
	const shortIds = shortIdsFor(orders.map((o) => o.id));
	blocks.push({
		type: "table",
		block_id: "orders:list",
		columns: [
			{ key: "createdAt", label: "Placed", format: "relative_time" },
			{ key: "customer", label: "Customer" },
			{ key: "state", label: "Status", format: "badge" }, // the ONE badge column (T-5)
			// The `#` lives in the HEADER, so the cell is the bare token and the
			// column is as narrow as the token is. `format: "code"` keeps it from
			// reading as prose (T-4).
			{ key: "shortId", label: "Order #", format: "code" },
			{ key: "total", label: "Total" }, // money LAST, pre-formatted (T-2, M-1)
		],
		rows: orders.map((o) => ({
			// The fallback is unreachable — `shortIdsFor` is TOTAL over the ids it
			// was given — and is here so a future caller narrowing the set renders
			// a short id rather than `undefined` in the operator's face.
			shortId: shortIds.get(o.id) ?? shortIdFixed(o.id),
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
 * The option VALUE is the record id, and the LABEL LEADS WITH A SHORT FORM OF
 * IT (D4 / the UUID display rule): `#7e4c · alice@example.com · $15.00 · paid`.
 * The three attributes after it are the human context; the token in front is
 * the only thing that makes two options TELL APART, because a repeat customer's
 * two orders at the same total in the same state are otherwise identical
 * character for character — and the operator picks one of them to refund.
 *
 * The prefix is computed by {@link shortIdsFor} over `orders` — THE SAME ARRAY
 * THE TABLE RENDERS, which is what makes "unique among the candidate set" and
 * "unique among the rows on screen" the same claim. Passing a re-fetched or
 * filtered copy would compute uniqueness against the wrong population; the
 * suite pins the identity rather than trusting it.
 *
 * NO COPY BUTTON, deliberately: Block Kit `select`/`combobox` options are
 * `{value, label}` and nothing else, so the accepted degradation is the prefix
 * alone. The FULL id stays one drill away — the detail screen's identity strip
 * renders it verbatim, exactly once.
 */
function openOrderForm(
	actions: ScreenActions,
	path: NavPath,
	orders: OrderSummaryWire[],
): FormBlock {
	const shortIds = shortIdsFor(orders.map((o) => o.id));
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
							// `shortIdsFor` is TOTAL over the ids it was given, so the fallback
							// is unreachable — it is here so a future caller narrowing the set
							// gets a short id rather than `undefined` in the operator's face.
							label: `#${shortIds.get(o.id) ?? shortIdFixed(o.id)} · ${o.customerId ?? o.buyerRef} · ${formatTotal(o.totalCents, o.currency)} · ${o.state}`,
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
	// The leaf declares the WHOLE union and narrows on `kind` (DA-3a-iii property
	// 1). It has to: `render` is an arrow-typed property, so `strictFunctionTypes`
	// checks the render-state parameter CONTRAVARIANTLY, and a level declaring a
	// narrower member than its screen can send is a compile error here rather than
	// an `undefined` read on the money path after a refusal.
	return leafLevel<AdminOrdersClient, OrderDetailResult, OrdersRenderState>({
		load: (client, _path, id) => client.getOrder(id),
		async render({ client, actions, path, id, detail, notice, renderState }) {
			const surfaces = await loadDetailSurfaces(client, id);
			return detailBlocks({ actions, path, detail, ...surfaces, notice, renderState });
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
	/** Set on a DA-3 state-2 render AND on every refusal (DA-3a-i): the group it
	 *  names is the ONE group forced open, and D-5's ordinary precedence is not
	 *  evaluated at all (D-5 Rule 1). `undefined` on every other render. */
	renderState: OrdersRenderState | undefined;
}

/**
 * §4's detail skeleton: blocks 1–5 outside the tabs, then the four constant
 * panels. Only these five may precede the tabs (D-1) — in particular the
 * reconciliation alert stays OUTSIDE, because a state demanding action must never
 * sit where a tab can hide it.
 */
function detailBlocks(args: DetailArgs): Block[] {
	const { actions, path, detail, notice, renderState } = args;
	const o = detail.order;
	const open = openGroup(o, renderState);
	const blocks: Block[] = [
		// D4 / DESIGNER §1 item 10: the largest type on this page used to be a
		// uuid. M-10's "orders have no human handle" is true of the RECORD and
		// false of the SCREEN — an operator arriving here knows the order by who
		// placed it and when, so the H1 says that and the id is demoted to the
		// identity strip below.
		//
		// The demotion is not a deletion, and §1.3 is the reason: every other
		// surface (row, picker, refund confirm) shows a PREFIX, so exactly one
		// surface has to render the whole thing or the full id stops being
		// obtainable anywhere in the console. That surface is the strip, and it
		// is still "exactly once" — just one block lower.
		{ type: "header", text: `Order · ${o.customerId ?? o.buyerRef} · ${headerDate(o.createdAt)}` },
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
	//
	// `Order ID` took `Customer`'s slot rather than being appended: the H1 above
	// now carries the customer, and repeating it here would state one fact twice
	// while pushing the strip to 7 entries — an odd count that breaks the
	// row-major pairing R-3 is built on. So the H1 and the strip SWAPPED which
	// of the two identifiers each owns; neither was lost, and the strip is still
	// three clean pairs. This entry is §1.3's "the full id remains obtainable",
	// and it renders in full ON PURPOSE — it is the one surface in the console
	// that does.
	blocks.push(
		fields("orders:identity", [
			["Status", o.state],
			["Total", formatTotal(o.totals.totalCents, o.totals.currency)],
			["Placed (UTC)", utc(o.createdAt)],
			["Payment", o.paymentMethod ?? "—"],
			["Order ID", o.id],
			["Reconciliation", reconciliationSummary(o)],
		]),
	);
	const panels: TabPanel[] = [
		{ label: "Order", blocks: orderPanel(actions, o, args.customer, open) },
		{ label: "Fulfilment", blocks: fulfilmentPanel(actions, detail, open, renderState) },
		{ label: "Money", blocks: moneyPanel(actions, o, args.refunds, open, renderState) },
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
 * RULE 1 — the staged-confirm-OR-REFUSAL override, keyed on
 * **`renderState !== undefined`**. A DA-3 state 2, a DA-3a stale-watermark
 * refusal, a DA-3c bound-check refusal and a validation refusal are all Rule-1
 * responses: that one group carries a changed `block_id` AND `default_open: true`
 * (B-6 — the changed key remounts the group and the remount re-reads the flag,
 * which is `false` for anything destructive; change only the id and the accordion
 * SNAPS SHUT on the operator the moment they click "Review refund"), and every
 * other group on the screen is `false`. Rule 2 is not evaluated.
 *
 * **THE REFUSAL CASE IS THE ONE THAT GETS MISSED**, and it is why this function
 * takes render state rather than a narrower "staged" argument. A refusal that falls
 * through to Rule 2 opens whatever the record state suggests — on this screen
 * `fulfilment`, which is a DIFFERENT TAB PANEL — while the group whose banner reads
 * "re-enter an amount below" stays shut with the operator's rejected input hidden
 * inside it. The predicate is "this response carries render state", which is
 * readable here, and not "this response came from `-review`", which is not.
 *
 * RULE 2 — first match wins: `reconcile` if flagged and unresolved, else
 * `fulfilment` on a `paid`/`processing` order, else nothing. Orders has NO named
 * primary edit group, so D-5 rank 3 does not apply here.
 */
type OpenGroup = "reconcile" | "fulfilment" | "refunds" | "cancel" | undefined;

function openGroup(o: OrderDetailWire, renderState: OrdersRenderState | undefined): OpenGroup {
	// Rule 1. Exhaustive over the union rather than a truthiness test, so a fifth
	// member cannot be added without deciding which group owns it.
	if (renderState !== undefined) {
		switch (renderState.kind) {
			case "refund-staged":
			case "refund-draft":
				return "refunds";
			case "cancel-staged":
			case "cancel-draft":
				return "cancel";
		}
	}
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
	const body: Block[] = [customerFields(o.id, ctx)];
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

/**
 * The Customer group's identity `fields` — SIX entries on an account, TWO on a
 * guest (§11.2). D-1a: the 4-or-6 cap belongs to the identity strip outside the
 * tabs, not to a panel's own `fields`, so six here is not a budget being spent.
 *
 * **NEVER RENDER A ROW WHOSE ONLY CONTENT IS A DENIAL.** On a guest the six-entry
 * shape said "no account" five different ways — `Account email —`, `Name —`,
 * `Account Guest — no account`, `Email verified not verified` — directly over the
 * D-7 `context` line that already says it once, and its `Email — (no account)` row
 * DENIED an address that the group label, the identity strip and `Buyer reference`
 * were all displaying at the same time.
 *
 * TWO LABELS ALSO CHANGE, because the old pair could not be told apart: `Email` is
 * the ACCOUNT's email and is now `Account email`; the order's own contact address —
 * previously the internal-sounding `Buyer reference` — is `Contact email`. And
 * `(UTC)` is dropped from `Email verified` when the value is `not verified`, since
 * there is no timestamp for a suffix to describe (M-6 governs timestamps, not
 * denials).
 */
function customerFields(orderId: string, ctx: CustomerContextWire): FieldsBlock {
	const identity = ctx.identity;
	const blockId = `orders:${orderId}:customer-fields`;
	if (identity.linkage === "guest") {
		return fields(blockId, [
			["Contact email", identity.buyerRef],
			["Orders placed", String(ctx.orderCount)],
		]);
	}
	return fields(blockId, [
		["Account email", identity.email ?? "—"],
		["Account", accountSummary(identity)],
		["Name", identity.displayName ?? "—"],
		["Orders placed", String(ctx.orderCount)],
		["Contact email", identity.buyerRef],
		identity.emailVerifiedAt === null
			? ["Email verified", "not verified"]
			: ["Email verified (UTC)", utc(identity.emailVerifiedAt)],
	]);
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
	renderState: OrdersRenderState | undefined,
): Block[] {
	const o = detail.order;
	const blocks: Block[] = [];
	const reconcile = reconcileGroup(o, open);
	if (reconcile !== undefined) blocks.push(reconcile);
	blocks.push(...shippingAddressBlocks(o));
	const fulfilment = fulfilmentGroup(o, open);
	if (fulfilment !== undefined) blocks.push(fulfilment);
	// `renderState !== undefined` is exactly "this render is mid-decision" — a DA-3
	// state 2 or a DA-3a refusal — which is what quiets the transition row (DA-2c; see
	// {@link transitionButton}).
	blocks.push(...transitionBlocks(o, detail, renderState !== undefined));
	blocks.push(...cancelBlocks(o, detail, open, renderState));
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

/**
 * ONE `actions` block with DISTINCT per-state ids (DA-6, R-13) — the old
 * one-block-per-button split existed only because every button shared the literal
 * id `orders:transition` and they collided as React keys. Withheld moves get one
 * `context` line each and NO control (DA-7).
 *
 * DA-7a governs the wording of those two lines: a withheld-action line names the
 * ALTERNATIVE and never narrates the design decision. Both used to open *"There is
 * deliberately no bare …"*, which tells an operator what designers withheld — a
 * fact they cannot act on — and is 30 characters longer than the version that
 * starts from their goal.
 */
function transitionBlocks(o: OrderDetailWire, detail: OrderDetailResult, quiet: boolean): Block[] {
	const offered = offeredTransitions(o, detail);
	const blocks: Block[] = [];
	if (o.state === "processing" && detail.allowedTransitions.includes("shipped")) {
		blocks.push({
			type: "context",
			// 93 chars: goal first, control last, one verb the operator can act on.
			text: "To ship this order, record the tracking under Fulfilment above — that emails it to the buyer.",
		});
	}
	if (detail.allowedTransitions.includes("cancelled")) {
		blocks.push({
			type: "context",
			// 75 chars.
			text: "To cancel this order, use Cancel order below — it records a reason on file.",
		});
	}
	if (offered.length === 0) return blocks;
	blocks.push({
		type: "actions",
		block_id: "orders:transitions",
		elements: offered.map((toState) => transitionButton(o.id, toState, o.state, quiet)),
	});
	return blocks;
}

/**
 * One transition button. `observedState` is THE WATERMARK — the state the operator
 * was looking at when this button rendered — and carrying it is not optional
 * (DA-2a, DA-6 item 5).
 *
 * WHY, CONCRETELY. `Mark refunded` renders `style:"danger"` + `confirm`, so it IS a
 * destructive confirm under DA-1/DA-5, and §8 exempts nothing from DA-3a's re-read.
 * A rendered button AGES: open a `paid` order, see `Mark refunded`, and while you
 * read the dialog a colleague moves the order `paid → processing → shipped`. The
 * domain state machine is no defence, because `shipped → refunded` is ALSO legal
 * (`domain/src/orders/state-machine.ts`: `shipped: ["delivered", "refunded"]`, which
 * `service/src/routes/admin.ts` hands to this console unnarrowed) — so the guarded
 * flip matches from the live state as readily as from the observed one, and a
 * shipped order whose tracking was already emailed lands in `refunded`, a TERMINAL
 * state, on a decision made while looking at `paid`. Until this watermark existed,
 * status moves were the one destructive write here with no staleness check at all.
 *
 * `quiet` DROPS `style:"danger"` AND KEEPS THE `confirm` — DA-2c's licensed move
 * ("the buttons go quiet and the dialog stays loud"), applied on the emphasis axis
 * rather than the fan-out one. It is set on any render carrying render state, i.e. a
 * DA-3 state 2 or a DA-3a refusal, and it fixes a real emphasis inversion: a cancel
 * refusal correctly suppresses the four DA-2b reason buttons and the one confirm, so
 * the loudest control left on the Fulfilment panel becomes a red `Mark refunded`,
 * sitting directly above the form the banner is telling the operator to re-submit.
 * `refunded` is TERMINAL — of every adjacent control it is the one a mis-click cannot
 * undo — and it is not what this render is about. The same holds in state 2, where the
 * one loud control should be the confirm the operator just asked for.
 *
 * NOTHING ELSE CHANGES. The `confirm` dialog and its own `style:"danger"` are
 * untouched on every render, because DA-2c is explicit that the guard is the dialog
 * and not the colour, and DA-1 is satisfied either way. So the click still costs a
 * deliberate "Yes, mark refunded"; it just stops shouting over the banner.
 */
function transitionButton(
	orderId: string,
	toState: string,
	observedState: string,
	quiet: boolean,
): ButtonElement {
	const button: ButtonElement = {
		// DERIVED from ORDER_STATES, so a rendered button always has a registered
		// handler. The handler takes the target state from THIS ID, never from the
		// value below — `value.toState` is echoed for devtools legibility and is
		// operator-alterable, so it is deliberately not trusted (DA-6 item 4).
		action_id: ORDERS_ACTIONS.custom(transitionVerb(toState)),
		type: "button",
		label: `Mark ${toState}`,
		value: { orderId, toState, state: observedState },
	};
	// The dialog comes from the map keyed by TARGET STATE, so it can never describe
	// a different transition than the one it guards.
	const confirm = DANGER_TRANSITIONS.get(toState);
	if (confirm !== undefined) {
		// The dialog ALWAYS; the colour only when this render is not already about
		// something else (DA-2c — see the header).
		if (!quiet) button.style = "danger";
		button.confirm = confirm;
	}
	return button;
}

/**
 * D-6a's label for the Cancel group: a destructive group is a bare trigger row of
 * exactly the same weight as every other trigger (R-5) and a label CANNOT be red,
 * so a label naming only the verb makes the most dangerous control on the panel the
 * quietest thing on it. 45 chars, inside §1's 60-char budget (X-35).
 *
 * Worth knowing before writing a test: this quotes the control it names, so a DA-7
 * line elsewhere reading "use Cancel order below" also matches `Cancel order` —
 * resolve this group by `block_id`, never by label (§15 V-1).
 */
const CANCEL_GROUP_LABEL = "Cancel order — permanent, releases held stock";

/**
 * The Cancel group. Six render modes; the destructive ones are DA-2b + DA-3:
 *
 *  - already cancelled WITH a reason ⇒ the recorded cancellation, read-only;
 *  - cancelled WITHOUT one (the bare transition) ⇒ an honest line;
 *  - no longer cancellable ⇒ no control and one `context` line (DA-7);
 *  - **state 2** (`cancel-staged`) ⇒ `:review` + `default_open` + the staged form
 *    and ONE confirm button, nothing else;
 *  - **a refusal** (`cancel-draft`) ⇒ a THIRD key + `default_open` + the collect
 *    form FLATTENED in, prefilled, and NO confirm (DA-3a-i);
 *  - otherwise ⇒ one DANGER BUTTON PER REASON (DA-2b: a closed set needs no
 *    staging, no staleness window and no staged payload to decode) plus a nested
 *    DA-3 group for the case where the operator wants to add free text.
 *
 * ALL THREE KEYS ARE DISTINCT — `…:cancel`, `…:cancel:review`, `…:cancel:refused` —
 * and the reason is THE REFUSAL'S TWO ARRIVAL PATHS. A refusal is reachable from
 * idle (submit the collect form with a blank `Cancelled by`) AND from state 2 (click
 * the confirm after someone else moved the order), so B-6's remount half needs this
 * `block_id` to differ from whichever of those two was on screen. Reuse either
 * existing id and one arrival path leaves it UNCHANGED: no remount, so the mounted
 * accordion never re-reads the `default_open: true` this response emits (B-5;
 * `accordion.tsx` reads it once, at mount). Whether the operator then SEES the
 * prefilled form is decided by their click history — they happened to leave it open,
 * or R-24 unmounted the tree on some earlier non-2xx and returned it to
 * `default_open: false`. A response whose own force-open clause does nothing, resting
 * on client state it did not set, is the exact ground DA-3's outermost-group rule now
 * stands on (§8, and D-5's "constrains the emitted response" paragraph), and it is
 * not expressible as a V-4 tier-1 assertion. A third key differs from BOTH, so
 * DA-3a-i's "forced open" is true OF THE RESPONSE on every arrival.
 *
 * WHAT THIS COMMENT USED TO SAY, AND WHY IT WAS BACKWARDS: that a refusal reusing
 * `:review` "would keep the values the confirm just failed with". Measured on a
 * state-2 → refusal arrival, the prefill digest is BYTE-IDENTICAL on both sides and
 * the form remounts anyway, because its own carrier re-read moved (B-3a) — the
 * group's id never governed the values. And retention is not a hazard to begin with:
 * DA-3a-i's "values prefilled" clause is asking for precisely that. Do not restore
 * that reasoning; the three keys stand on the arrival-path argument above.
 */
function cancelBlocks(
	o: OrderDetailWire,
	detail: OrderDetailResult,
	open: OpenGroup,
	renderState: OrdersRenderState | undefined,
): Block[] {
	const blockId = `orders:${o.id}:cancel`;
	// Tolerate a wire response that omits the field (undefined) exactly like null.
	const recorded = o.cancellation ?? null;
	if (recorded !== null) {
		return [
			{
				type: "accordion",
				block_id: blockId,
				// A RECORD, not a trigger — D-6a's consequence clause would be describing
				// an act that already happened, so the D-6 answer is the label.
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
	if (renderState?.kind === "cancel-staged") {
		return [
			{
				type: "accordion",
				// BOTH halves of the force-open (B-6): a changed key remounts the group,
				// and the remount re-reads `default_open` — which is `false` for a
				// destructive group unless THIS render sets it true.
				block_id: `${blockId}:review`,
				label: CANCEL_GROUP_LABEL,
				default_open: open === "cancel",
				blocks: cancelReviewBody(o, renderState),
			},
		];
	}
	if (renderState?.kind === "cancel-draft") {
		return [
			{
				type: "accordion",
				block_id: `${blockId}:refused`,
				label: CANCEL_GROUP_LABEL,
				default_open: open === "cancel",
				blocks: cancelDraftBody(o, renderState),
			},
		];
	}
	return [
		{
			type: "accordion",
			block_id: blockId,
			label: CANCEL_GROUP_LABEL,
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
					// FOUR buttons, not five: `other` has no button (see
					// CANCEL_BUTTON_REASONS), which also keeps the fan-out inside DA-2c's
					// cap so each stays `style:"danger"`.
					elements: CANCEL_BUTTON_REASONS.map((r) => cancelReasonButton(o, r)),
				},
				{
					type: "accordion",
					block_id: `orders:${o.id}:cancel-note`,
					label: "Cancel with a note",
					default_open: false,
					blocks: [CANCEL_NOTE_BANNER, cancelNoteForm(o.id, o.state)],
				},
			],
		},
	];
}

/**
 * The nested DA-3 collect group's banner — required by DA-3 state 1, and free
 * against §2's two-banner cap because §2 does not count banners inside an
 * accordion.
 *
 * IT SAYS ONLY WHAT IS NEW. The parent group's banner sits ~190px above and
 * already says "Cancelling is permanent"; a second near-identical warning teaches
 * an operator to skim both, which costs more safety than it buys. And "the point of
 * no return" is gone: it was the one purple phrase on an otherwise plain-spoken
 * screen (E-4).
 */
const CANCEL_NOTE_BANNER: Block = {
	type: "banner",
	variant: "alert",
	title: "Review what you typed on the next step",
	description:
		"The confirm on the next step is what records the cancellation — nothing is recorded until then.",
};

/** DA-2b: one danger button per legal value, the value in `button.value`, and the
 *  reason NAMED IN THE CONFIRM TEXT. No round trip, no staged payload.
 *
 *  The LABEL IS THE BARE REASON — `Out of stock`, not `Cancel — Out of stock`: the
 *  group label and the confirm already say "cancel" twice, so the prefix repeated a
 *  word three times per button and pushed the reason (the only thing that differs
 *  between four adjacent red buttons) to the right (§11.2). */
function cancelReasonButton(o: OrderDetailWire, reason: SelectOption): ButtonElement {
	return {
		type: "button",
		action_id: ORDERS_ACTIONS.custom(cancelReasonVerb(reason.value)),
		label: reason.label,
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
 * THE NESTED "Cancel with a note" ACCORDION IS NOT RENDERED HERE — the collect
 * group is FLATTENED AWAY (DA-3's outermost-group rule). Nesting the forced-open
 * group one level deeper leaves the confirm invisible behind a COLLAPSED parent,
 * and D-5 Rule 1 forbids opening the parent as well; the spec was unbuildable as
 * revision 3 wrote it, and revision 4 resolved it in this direction.
 */
function cancelReviewBody(
	o: OrderDetailWire,
	staged: OrdersRenderState & { kind: "cancel-staged" },
): Block[] {
	const reasonLabel = CANCEL_REASON_LABELS.get(staged.reason) ?? staged.reason;
	return [
		{
			type: "banner",
			variant: "alert",
			title: "Cancelling is permanent and cannot be undone",
			description:
				"Confirm below to cancel this order, email the buyer and release the held stock. Edit the form and review again to change anything.",
		},
		cancelNoteForm(o.id, o.state, {
			// The prefill is in OPTION-VALUE space, which on this screen is the human
			// label — so the staged WIRE reason is mapped forward here, exactly as the
			// handler mapped the submission backward.
			reasonOption: reasonLabel,
			detail: staged.detail,
			cancelledBy: staged.cancelledBy,
		}),
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

/**
 * A REFUSAL on the cancel flow: DA-3a-i's state-1 re-render, into this group,
 * forced open, FLATTENED, with the submitted values prefilled and NO CONFIRM.
 *
 * FOUR THINGS THIS BODY DOES NOT CONTAIN, each for a stated reason:
 *
 *  - **No confirm control.** DA-3a-i, scoping note: "state-2-shaped" settles
 *    `default_open` and the `block_id` and licenses nothing about the body. The
 *    payload a confirm would carry is the payload just refused.
 *  - **No nested collect group.** That is the flatten clause. Force the outer group
 *    open and leave the form in a `default_open: false` child and the operator's
 *    rejected input is on the page and invisible — which passes an id check while
 *    failing the "values prefilled" clause outright (X-39 asserts the nested
 *    group's absence).
 *  - **No DA-2b reason buttons.** Deliberate, and the same judgment state 2 makes:
 *    the operator is mid-decision on ONE cancellation and four one-click red
 *    buttons beside a banner reading "choose a reason and enter who is cancelling"
 *    are a trap — every one of them cancels immediately, with no detail, which is
 *    the exact thing this operator was trying to record. The refusal copy names one
 *    route (the form below); DA-7a's discipline is one route per line.
 *  - **No second "Cancelling is permanent" banner.** The refusal's own `error`
 *    notice is already at the top of the screen; a third warning here is the
 *    skim-training §11.2 removed the duplicate for.
 */
function cancelDraftBody(
	o: OrderDetailWire,
	draft: OrdersRenderState & { kind: "cancel-draft" },
): Block[] {
	return [
		CANCEL_NOTE_BANNER,
		cancelNoteForm(o.id, o.state, {
			// X-23: an `initial_value` must be one of the options, so an unrecognized
			// submission falls back to the default rather than prefilling a value the
			// `select` cannot display.
			reasonOption: CANCEL_REASON_BY_LABEL.has(draft.reasonInput)
				? draft.reasonInput
				: DEFAULT_CANCEL_REASON_OPTION,
			detail: draft.detail,
			cancelledBy: draft.cancelledBy,
		}),
	];
}

/**
 * THREE visible fields — the order id and the state watermark ride in the carrier.
 * On a state-2 or refusal render the submitted values are the `initial_value`s, and
 * `carriedForm`'s prefill digest is what makes the remount actually pick them up
 * (B-3a).
 *
 * `prefill.reasonOption` is in OPTION-VALUE space, which on this screen is the
 * HUMAN LABEL — see {@link CANCEL_REASON_BY_LABEL} for why the `select` carries
 * labels as values, and note that the caller is responsible for the X-23 guarantee
 * that the value is one of the options.
 */
function cancelNoteForm(
	orderId: string,
	state: string,
	prefill?: { reasonOption: string; detail: string; cancelledBy: string },
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
					// The option VALUE is the human label: the pinned renderer's trigger
					// renders the raw value (R-17a), so wire values here would put
					// `customer_request` on the screen (F-6c).
					options: CANCELLATION_REASONS.map((r) => ({ value: r.label, label: r.label })),
					initial_value: prefill?.reasonOption ?? DEFAULT_CANCEL_REASON_OPTION,
				},
				{
					type: "text_input",
					action_id: "detail",
					label: "Detail (optional)",
					placeholder: "e.g. chargeback risk flagged",
					...(prefill !== undefined && prefill.detail.length > 0
						? { initial_value: prefill.detail }
						: {}),
				},
				{
					type: "text_input",
					action_id: "cancelledBy",
					label: "Cancelled by",
					placeholder: "your name",
					...(prefill !== undefined ? { initial_value: prefill.cancelledBy } : {}),
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
	renderState: OrdersRenderState | undefined,
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
	const blocks: Block[] = [
		// `Payment` is already in the identity strip; do not repeat it (P-3).
		fields("orders:money", [
			["Captured", formatTotal(summary.capturedTotalCents, cur)],
			["Refunded", formatTotal(summary.refundedTotalCents, cur)],
			// M-11a: a bare `Remaining` beside `Captured` and `Refunded` could mean
			// remaining to capture, to refund or to ship. Naming the axis costs eleven
			// characters and matches the `meter` and the DA-3a refusal's own wording.
			["Remaining refundable", formatTotal(summary.remainingCents, cur)],
			// A BARE INTEGER (X-9's heuristic excludes labels matching /recorded/, so
			// the invented "1 refund" unit is no longer needed to get past it).
			["Refunds recorded", String(summary.refunds.length)],
		]),
	];
	// M-11: `Total $95.00` on the identity strip beside `Captured $0.00` here is a
	// contradiction the operator otherwise has to leave the console to resolve.
	// Required whenever the narrower figure differs from the total, not only at zero,
	// and it states the arithmetic and the semantics WITHOUT diagnosing a cause (E-7
	// — "authorised but not settled" is a claim about a provider this screen cannot
	// verify).
	if (summary.capturedTotalCents !== o.totals.totalCents) {
		blocks.push({
			type: "context",
			text: `Captured is the money that actually arrived; ${formatTotal(summary.capturedTotalCents, cur)} of the ${formatTotal(o.totals.totalCents, o.totals.currency)} total has been captured so far.`,
		});
	}
	blocks.push(refundsGroup(actions, o, summary, cur, open, renderState));
	return blocks;
}

/**
 * The Refunds group — three render modes, and which one is chosen by the render
 * state, never by taste.
 *
 * | Mode | `block_id` | Body |
 * |---|---|---|
 * | idle | `…:refunds` | meter · ledger · capability line · DA-2b button · the nested DA-3 collect group |
 * | **state 2** (`refund-staged`) | `…:refunds:review` | alert banner · the staged form · ONE danger confirm — **and nothing else** |
 * | **a refusal** (`refund-draft`) | `…:refunds:refused` | meter · ledger · capability line · alert banner · the prefilled form — **no confirm** |
 *
 * THREE KEYS, ALL DISTINCT, and the reason is THE REFUSAL'S TWO ARRIVAL PATHS — see
 * {@link cancelBlocks} for the same argument at length. A refusal is reachable from
 * idle (a typo in the amount field) AND from state 2 (the confirm, after the ledger
 * moved), so B-6's remount half needs this `block_id` to differ from whichever of
 * those two was on screen. Reuse either existing id and one arrival leaves it
 * unchanged, nothing remounts, and the `default_open: true` in this response is never
 * read (B-5) — leaving the force-open to the operator's click history rather than to
 * the response, which no tier-1 assertion can check.
 *
 * NOT because the values would go stale: measured, the prefill digest is identical
 * across a state-2 → refusal arrival and the form remounts on its own carrier (B-3a).
 * Keeping the operator's amount is what DA-3a-i asks for, not a defect.
 *
 * WHY STATE 2 SUPPRESSES THE METER AND THE LEDGER (§8's outermost-group rule and
 * §11.2, both explicit): the operator is mid-decision on one amount, and the group
 * is showing them a FRESH ledger beside a confirm carrying the watermark they
 * originally saw. Two readings of the ledger, one of which is not the one the button
 * will be judged against, is worse than one.
 *
 * WHY A REFUSAL KEEPS THEM: a refusal is a state-1 body (DA-3a-i), and its whole
 * message is "the ledger is not what you thought" — the copy says so and names the
 * live figure, so the ledger it points at has to be on screen.
 */
function refundsGroup(
	actions: ScreenActions,
	o: OrderDetailWire,
	summary: RefundsSummaryWire,
	cur: string,
	open: OpenGroup,
	renderState: OrdersRenderState | undefined,
): Block {
	const blockId = `orders:${o.id}:refunds`;
	const staged = renderState?.kind === "refund-staged" ? renderState : undefined;
	const draft = renderState?.kind === "refund-draft" ? renderState : undefined;
	const body: Block[] = [];
	if (staged === undefined) {
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
	}

	if (staged !== undefined) {
		body.push(...refundReviewBody(o, summary, cur, staged));
	} else if (draft !== undefined) {
		body.push(...refundDraftBody(o, cur, summary, draft));
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
			// D-6a: a destructive group's label carries its CONSEQUENCE, because a
			// label cannot be red (R-5) and a bare noun makes the dangerous control the
			// quietest thing on the panel. 46 chars (X-35).
			label: "Refund a different amount — cannot be reversed",
			default_open: false, // ALWAYS, for anything destructive (D-5)
			blocks: [REFUND_PARTIAL_BANNER, refundPartialForm(o.id, cur, summary)],
		});
	} else if (summary.refundedTotalCents > 0) {
		// DA-7: no control at all, one line naming the reason.
		body.push({ type: "context", text: "Fully refunded — nothing left to refund." });
	}
	// At a ZERO CEILING there is deliberately no line here: D-6b replaces the
	// degenerate `$0.00 of $0.00` ratio in the LABEL with the fact itself, and the
	// explanatory `context` line then restates what the label just said. The M-11
	// line above is what tells the operator whether the money arrived.
	return {
		type: "accordion",
		// B-6: on a state 2 OR a refusal the id CHANGES and the flag is set — both
		// halves, and three distinct keys.
		block_id:
			staged !== undefined
				? `${blockId}:review`
				: draft !== undefined
					? `${blockId}:refused`
					: blockId,
		// D-6: the label carries the answer, so the group can be skipped unopened —
		// and D-6b replaces the ratio outright when its denominator is zero, because
		// `$0.00 of $0.00 refunded` tells an operator nothing and reads like a bug.
		label: fitLabel(
			summary.ceilingCents > 0
				? `Refunds — ${formatTotal(summary.refundedTotalCents, cur)} of ${formatTotal(summary.ceilingCents, cur)} refunded`
				: "Refunds — nothing captured, nothing to refund",
		),
		default_open: open === "refunds",
		blocks: body,
	};
}

/** DA-3 state 1's required alert banner (§2 does not count banners inside an
 *  accordion). Shared by the collect group and by the flattened refusal body, so
 *  the two cannot drift. */
const REFUND_PARTIAL_BANNER: Block = {
	type: "banner",
	variant: "alert",
	title: "A recorded refund cannot be reversed here",
	description:
		"Review the amount on the next step. Refunds are additive: recording one twice records two refunds.",
};

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
			text: refundConfirmText(o.id, amount, o.customerId ?? o.buyerRef, summary.refundable),
			confirm: `Yes, refund ${amount}`,
			deny: "Keep as is",
			style: "danger",
		},
	};
}

/**
 * DA-3 state 2 for a refund: the staged form remounted plus ONE danger confirm.
 * The DA-2b full-remaining button, the nested partial-amount accordion, the meter
 * and the ledger are ALL omitted (§8's outermost-group rule, §11.2) — a second
 * refund control beside a staged one is exactly the ambiguity the confirm dialog
 * exists to remove, and the suppression of the meter/ledger happens in
 * {@link refundsGroup}, which owns the body.
 */
function refundReviewBody(
	o: OrderDetailWire,
	summary: RefundsSummaryWire,
	cur: string,
	staged: OrdersRenderState & { kind: "refund-staged" },
): Block[] {
	const amount = formatTotal(staged.amountCents, cur);
	return [
		{
			type: "banner",
			variant: "alert",
			title: "A recorded refund cannot be reversed here",
			description: `Confirm below to refund ${amount}. Edit the form and review again to change the amount.`,
		},
		refundPartialForm(o.id, cur, summary, {
			amountInput: formatMinorUnitsInput(staged.amountCents),
			reason: staged.reason,
			refundedBy: staged.refundedBy,
		}),
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
						text: refundConfirmText(o.id, amount, o.customerId ?? o.buyerRef, summary.refundable),
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
 * A REFUSAL on the refund flow: DA-3a-i's state-1 re-render, into this group,
 * forced open, FLATTENED, with the submitted values prefilled and NO CONFIRM.
 *
 * THE AMOUNT IS PREFILLED VERBATIM from `amountInput`, never re-derived from
 * minor units. The most frequent refusal on this screen is a typo in the amount
 * field, and on that path `parseMinorUnitsInput` returned `null` — so there is no
 * `amountCents` to format, and a rejected `19,99` cannot be reconstructed from
 * cents (DA-3a-iii property 5).
 *
 * THREE THINGS THIS BODY DOES NOT CONTAIN:
 *
 *  - **No confirm control.** DA-3a-i's scoping note: "state-2-shaped" settles
 *    `default_open` and the `block_id` and licenses nothing about the body. The
 *    payload a confirm would carry is the payload just refused — re-offering it
 *    re-stages a stale amount (DA-3a) or the very figure the bound check rejected
 *    (DA-3c), a red `Refund $900.00` on a $50 order.
 *  - **No nested collect group.** That is the flatten clause, and X-39 asserts the
 *    nested group's absence: force the outer group open and leave the form in a
 *    `default_open: false` child and the operator's rejected `19,99` is on the page
 *    and invisible, which fails "values prefilled" while passing an id check.
 *  - **No DA-2b full-remaining button.** Deliberate, and it is the same judgment
 *    state 2 makes. On a DA-3c refusal the rejected figure was TOO HIGH and the only
 *    other control on offer would be the largest possible refund — the one button a
 *    mis-keyed extra zero must not be one click away from. The refusal copy names
 *    one route ("re-enter an amount below"), which is the form directly beneath it.
 */
function refundDraftBody(
	o: OrderDetailWire,
	cur: string,
	summary: RefundsSummaryWire,
	draft: OrdersRenderState & { kind: "refund-draft" },
): Block[] {
	return [REFUND_PARTIAL_BANNER, refundPartialForm(o.id, cur, summary, draft)];
}

/**
 * `confirm.text` — exactly two sentences, ≤200 (§1): one naming the concrete
 * ORDER, amount and recipient, one naming the consequence.
 *
 * THE ORDER COMES FIRST, and it is the reason this function takes an id at all
 * (D4). Amount and recipient are the two attributes a repeat customer's orders
 * SHARE, so a dialog naming only those is a dialog that cannot tell the operator
 * which of two candidates the money is about to leave. `shortIdFixed` is used
 * rather than {@link shortIdsFor} because a confirm renders against one record
 * with no candidate set in hand; at 8 characters it is a visible superset of the
 * 4-character prefix the operator just read in the picker.
 *
 * The recipient is dropped when a long buyer handle would push the string over
 * budget — the id and the amount are never the thing that goes. Truncating a
 * confirm dialog mid-sentence would be worse than a slightly less specific one,
 * and the budget is a hard rule (X-11).
 */
function refundConfirmText(
	orderId: string,
	amount: string,
	recipient: string,
	refundable: boolean,
): string {
	const consequence = refundable
		? "This sends the money back through Stripe and cannot be reversed."
		: "This records a refund made out of band — it does not move money.";
	const order = `Order #${shortIdFixed(orderId, SHORT_ID_CONFIRM_LEN)}`;
	const named = `${order} — refund ${amount} to ${recipient}? ${consequence}`;
	return named.length <= 200
		? named
		: `${order} — refund ${amount} to this order's buyer? ${consequence}`;
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
			// NO `Kind` COLUMN, and it is deleted rather than demoted to plain text.
			// `kind` is `gateway.refundable ? "gateway" : "manual"` resolved ONCE from
			// the ORDER's own payment method (`domain/src/orders/refund-order.ts`,
			// `service/src/routes/admin.ts`), so it cannot vary down a single order's
			// ledger — and this per-order ledger is the only table in the console that
			// renders it. A column of identical `manual` pills is forbidden outright by
			// T-5's near-constant clause (X-4), and a column of one repeated word is a
			// column of nothing. Where the kind matters it is already in the group's
			// capability `context` line, which says whether refunds here move money.
			{ key: "ref", label: "Provider ref", format: "code" },
			{ key: "by", label: "By" },
			{ key: "when", label: "When", format: "relative_time" },
		],
		rows: refunds.map((r) => ({
			amount: formatTotal(r.amountCents, r.currency.length > 0 ? r.currency : cur),
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
 *
 * `prefill.amountInput` IS A RAW STRING and is used verbatim, whether it came from a
 * refusal (what the operator typed, possibly unparseable) or from state 2 (formatted
 * back from the parsed cents by the caller). The form never re-derives it here, so
 * there is exactly one place that decides what an operator sees in that field.
 *
 * THE CARRIED WATERMARK IS ALWAYS THE FRESHLY-READ ONE (`summary.refundedTotalCents`),
 * on every render mode including a refusal. That is deliberate and it is why the
 * draft render state carries no watermark: the operator's next `-review` stages
 * against current truth by construction rather than by anyone remembering to
 * re-stamp it, and B-3 independently requires a prefilling form's change token to
 * reflect the CURRENT record.
 */
function refundPartialForm(
	orderId: string,
	cur: string,
	summary: RefundsSummaryWire,
	prefill?: { amountInput: string; reason: string; refundedBy: string },
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
					initial_value: prefill?.amountInput ?? formatMinorUnitsInput(summary.remainingCents),
				},
				{
					type: "text_input",
					action_id: "reason",
					label: "Reason (optional)",
					placeholder: "e.g. damaged in transit",
					...(prefill !== undefined && prefill.reason.length > 0
						? { initial_value: prefill.reason }
						: {}),
				},
				{
					type: "text_input",
					action_id: "refundedBy",
					label: "Refunded by",
					placeholder: "your name",
					...(prefill !== undefined ? { initial_value: prefill.refundedBy } : {}),
				},
			],
			submit: { label: "Review refund", action_id: ACTION_REFUND_REVIEW },
		},
	});
}

// -- panel "History" ---------------------------------------------------------

/** T-8's cap: a leaf detail's table MUST NOT set `next_cursor` (a load-more click
 *  at leaf depth blanks the page), so the read is capped and — per T-8a — the cap is
 *  stated ONLY when rows were actually withheld. */
const TIMELINE_CAP = 50;

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

/**
 * The Notes group is FORM ONLY (§11.2) — the label carries the count, the group
 * carries the form, and there is no read table.
 *
 * WHY THE TABLE IS GONE. The History timeline directly above already renders every
 * note: a `note` entry's `Detail` column IS the note body, verbatim
 * ({@link timelineDetail}), and the timeline's cap (50) is LOOSER than the notes cap
 * (20) was — so the table added a duplicate rendering of the same text, a second
 * cap `context` line, and nothing else. Deleting it also deletes the notes cap, which
 * is why `NOTES_CAP` no longer exists.
 */
function notesGroup(_actions: ScreenActions, o: OrderDetailWire, notes: OrderNoteWire[]): Block {
	return {
		type: "accordion",
		block_id: `orders:${o.id}:notes`,
		label: `Notes (${notes.length})`, // D-6
		default_open: false,
		blocks: [addNoteForm(o.id)],
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
 * A MISSING WATERMARK IS AN UNREADABLE PAYLOAD, NOT A REASON TO SKIP DA-3a.
 *
 * Every rendered destructive control on this screen carries the watermark the
 * operator saw, so an absent one has exactly two sources, and refusing is right for
 * both: a payload edited in devtools (`button.value` is operator-alterable — B-1),
 * or a browser tab rendered before the watermark existed, which is precisely the
 * stale view DA-3a is for. A `value.state.length > 0` guard around the comparison
 * would let either write with no staleness check at all, which is the X-38 hole
 * dressed as tolerance.
 *
 * `""` is folded into `undefined` deliberately: a whitespace-only or empty state is
 * not a state, and no comparison against it can be meaningful.
 *
 * THE RULE IS ABSOLUTE ON THIS SCREEN, and that is checkable. Every site holding a
 * watermark answers an absent one with {@link UNREADABLE} and NO re-read: the ten
 * transitions and {@link cancelReviewAction}/{@link cancelOrderAction} through this
 * helper, and the two refund handlers through `parseCents` — the refund watermark is
 * a MINOR-UNITS LEDGER TOTAL rather than a state name, so it cannot route through
 * here, but `observedSoFar === null` is the same check and gets the same answer.
 *
 * They differ only in whether a DA-3a-i draft rides along, which is decided by whether
 * the refused payload came from a form — all of them but the transitions, which have
 * no form to prefill (see {@link transitionAction}).
 *
 * A `-review` is NOT an exception on the grounds that it writes nothing; see
 * {@link cancelReviewAction}'s header for why re-stamping a fresh watermark onto the
 * confirm it draws makes the tolerance worse than the refusal, not better.
 */
function readWatermark(value: unknown): string | undefined {
	const raw = readString(value)?.trim();
	return raw === undefined || raw.length === 0 ? undefined : raw;
}

/**
 * One handler per state, closed over the target from {@link ORDER_STATES} — so
 * the state a transition writes comes from the ACTION ID (which only exists
 * because it was derived from that list) and never from the operator-alterable
 * `value.toState` (DA-6 item 4).
 *
 * DA-2a / DA-3a, MANDATORY AND WITH NO EXEMPTION FOR STATUS MOVES: take the
 * watermark out of `value`, RE-READ the order, and refuse on a mismatch. See
 * {@link transitionButton} for the concrete race this closes — `shipped → refunded`
 * is legal, so the domain's guarded flip is no defence against a decision made
 * while looking at `paid`, and transitions are the write most likely to race
 * because the state being moved FROM is the thing another operator is most likely
 * to have changed.
 *
 * NO RENDER STATE IS PASSED ON THE REFUSAL, and that is not an omission. DA-3a-i's
 * four clauses are all about a GROUP with a collect form in it; a transition is a
 * bare `actions` block with no group, no form and no operator-typed input to
 * preserve, so there is nothing to force open and nothing to prefill. The re-render
 * shows the live state in the identity strip, which is the fact the operator needs.
 */
function transitionAction(toState: string) {
	return customAction<AdminOrdersClient, OrdersRenderState>(
		async ({ input, client, showLeaf, showList }) => {
			const payload = asRecord(input.value);
			const orderId = readString(payload?.orderId);
			if (orderId === undefined) return showList(undefined, UNREADABLE);
			const observedState = readWatermark(payload?.state);
			if (observedState === undefined) return showLeaf([orderId], UNREADABLE);
			const live = await client.getOrder(orderId).catch(() => null);
			if (live === null) {
				return showLeaf([orderId], {
					variant: "error",
					title: "Nothing was changed",
					description:
						"This order could not be re-checked before the status change, so nothing was applied. Reload and try again.",
				});
			}
			if (live.order.state !== observedState) {
				return showLeaf([orderId], {
					variant: "error",
					title: "The order changed — nothing was applied",
					description: `It was ${observedState} when you started and is now ${live.order.state}. Check the order below before changing its status.`,
				});
			}
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
		},
	);
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

/**
 * DA-3 state 1 → 2 for a cancellation: validate, RE-READ, then re-render with the
 * group forced open and the typed values staged. NOTHING is written here.
 *
 * IT RE-READS BECAUSE `-review` RENDERS THE TWO STATEMENTS THE SHAPE EXISTS TO MAKE
 * TRUE (DA-3c: "not only the confirm handler"). The confirm it draws says *"Cancel
 * this order as 'out of stock'? This is permanent…"* over a payload carrying the
 * watermark. If the order moved between the form rendering and this submit, that
 * confirm is dead on arrival — `cancelOrderAction`'s own DA-3a check will refuse it
 * — and the operator would be shown a coherent current panel beside a button that
 * cannot succeed, with nothing saying why. So the movement is caught HERE, at the
 * step whose only purpose is letting them check.
 *
 * AN ABSENT WATERMARK IS REFUSED HERE TOO, with no `-review` exemption —
 * {@link readWatermark}'s doc states that rule absolutely and this handler is not
 * outside it. Tolerating it (`observedState !== undefined && …`) looked safe, because
 * the confirm this handler draws re-stamps `state` from its own fresh read and
 * `cancelOrderAction` then checks against that. It is not safe, for two reasons:
 *
 *  1. **The re-stamp launders the window it skipped.** The operator chose a reason
 *     while looking at some state; a fresh stamp asserts a state they never saw, and
 *     the confirm's check then passes trivially. The window from that page rendering
 *     to this submit goes unchecked while the payload claims otherwise — the X-38
 *     hole one step removed. {@link refundReviewAction} names the identical move as
 *     wrong for the refund path ("re-stamping it fresh … would assert a decision the
 *     operator never made"); the same asymmetry cannot be a defect there and a
 *     tolerance here.
 *  2. **A `-review` has less standing to skip it, not more.** Its whole purpose is
 *     catching movement before a confirm is drawn. With no watermark it has nothing
 *     to compare, so the one step that exists to let an operator check silently
 *     checks nothing.
 *
 * So every DA-3a site on this screen refuses an absent watermark identically, and a
 * reviewer checks one boolean per site instead of judging each one. The cost is a
 * reload on a payload that was hand-edited or came from a pre-watermark tab.
 *
 * EVERY REFUSAL CARRIES A DRAFT (DA-3a-i): forced open, flattened, prefilled. This
 * handler was the fifth refusal site on the screen and the one no plan had listed.
 */
function cancelReviewAction() {
	return customAction<AdminOrdersClient, OrdersRenderState>(async (api) => {
		const orderId = readString(api.carried?.orderId);
		if (orderId === undefined) return api.showList(undefined, UNREADABLE);
		const observedState = readWatermark(api.carried?.state);
		const values = api.input.values ?? {};
		// The `select` carries the HUMAN LABEL as its value (see
		// CANCEL_REASON_BY_LABEL), so map back to the wire reason. Untrusted input:
		// an unmapped value is refused, never forwarded.
		const reasonInput = readString(values.reason) ?? "";
		const reason = CANCEL_REASON_BY_LABEL.get(reasonInput);
		const detail = (readString(values.detail) ?? "").trim();
		const cancelledBy = (readString(values.cancelledBy) ?? "").trim();
		const draft = (): OrdersRenderState => ({
			kind: "cancel-draft",
			reasonInput,
			detail,
			cancelledBy,
		});
		// DA-3a with NO `-review` EXEMPTION (see this function's header). Refused before
		// the read, because no re-read can supply a watermark the operator never sent and
		// the outcome cannot depend on what it would return.
		if (observedState === undefined) {
			return api.showLeaf([orderId], UNREADABLE, draft());
		}
		if (reason === undefined || cancelledBy.length === 0) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "Not cancelled",
					description: "Choose a reason and enter who is cancelling it. Nothing was changed.",
				},
				draft(),
			);
		}
		const live = await api.client.getOrder(orderId).catch(() => null);
		if (live === null) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "Could not check the order",
					description:
						"This order could not be re-read, so nothing was staged and nothing was changed. Reload and try again.",
				},
				draft(),
			);
		}
		if (live.order.state !== observedState) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "The order changed — nothing was staged",
					description: `It was ${observedState} when you started and is now ${live.order.state} — someone else moved it since you opened this form. Check the order below, then review again.`,
				},
				draft(),
			);
		}
		return api.showLeaf([orderId], undefined, {
			kind: "cancel-staged",
			reason,
			detail,
			cancelledBy,
			// The watermark FRESHLY CONFIRMED equal to the observed one, so the confirm
			// this render draws is one the write can actually accept.
			state: live.order.state,
		});
	});
}

/**
 * Shared by DA-2b's four per-reason buttons AND DA-3's state-2 confirm — one
 * handler, because both carry the same `{orderId, reason, state}` in
 * `button.value` (the DA-3 one adds `detail`).
 *
 * DA-3a, MANDATORY: re-read the order and refuse on a watermark mismatch. The
 * staged `state` is what the operator saw; if the order moved under them, apply
 * NOTHING and name both states.
 *
 * EVERY REFUSAL HERE CARRIES A DRAFT (DA-3a-i), including the two that read like
 * plumbing failures. Nothing was written on any of them and the operator's typed
 * detail is in hand, so discarding it to tell them to try again makes the safe path
 * the expensive one — and the next thing they reach for is a one-click reason
 * button, which records no detail at all.
 */
function cancelOrderAction() {
	return customAction<AdminOrdersClient, OrdersRenderState>(
		async ({ input, client, showLeaf, showList }) => {
			const payload = asRecord(input.value);
			const orderId = readString(payload?.orderId);
			if (orderId === undefined) return showList(undefined, UNREADABLE);
			const reason = readString(payload?.reason) ?? "";
			const detail = (readString(payload?.detail) ?? "").trim();
			const cancelledBy = (readString(payload?.cancelledBy) ?? "").trim();
			const observedState = readWatermark(payload?.state);
			// The draft prefill is in OPTION-VALUE space (the human label), and an
			// unrecognized reason simply has no label to put back — the form falls to its
			// default and the operator's detail and name survive, which is the part they
			// typed.
			const draft = (): OrdersRenderState => ({
				kind: "cancel-draft",
				reasonInput: CANCEL_REASON_LABELS.get(reason) ?? "",
				detail,
				cancelledBy,
			});
			// Every decoded value is UNTRUSTED operator-round-tripped input (B-1), so the
			// closed set and the watermark's PRESENCE are both re-checked here, not
			// merely at render.
			if (!CANCEL_REASON_LABELS.has(reason) || observedState === undefined) {
				return showLeaf([orderId], UNREADABLE, draft());
			}
			// DA-3a: re-read before writing.
			const live = await client.getOrder(orderId).catch(() => null);
			if (live === null) {
				return showLeaf(
					[orderId],
					{
						variant: "error",
						title: "Nothing was cancelled",
						description:
							"This order could not be re-checked before cancelling, so nothing was applied. Reload and try again.",
					},
					draft(),
				);
			}
			if (live.order.state !== observedState) {
				return showLeaf(
					[orderId],
					{
						variant: "error",
						title: "The order changed — nothing was cancelled",
						description: `It was ${observedState} when you started and is now ${live.order.state} — someone else moved it since you started. Check the order below, then cancel again if you still want to.`,
					},
					draft(),
				);
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
			// NO DRAFT ON THESE: the write was attempted. `NOT_CANCELLABLE` means the
			// order cannot be cancelled AT ALL now, so a forced-open form prefilled for a
			// retry would promise something that is no longer possible; the other branches
			// are outcomes to read, not inputs to correct.
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
		},
	);
}

/**
 * DA-3 state 1 → 2 for a refund. NOTHING is written here — and yet this handler
 * runs FIVE checks around one read, because `-review` renders the two statements the
 * whole shape exists to make true: the button label and the `confirm.text`.
 *
 * | Check | Rule | Refusal names |
 * |---|---|---|
 * | the carrier decodes: watermark AND currency both present | DA-3b | the payload, NOT the amount |
 * | parses to a positive integer of minor units | M-3 | what was typed |
 * | required attribution present | DA-3c | the missing field |
 * | the ledger has not moved since the form rendered | DA-3a | both figures AND the cause |
 * | `amountCents <= remainingRefundableCents` **live** | DA-3c | the real ceiling |
 *
 * THE FIRST ROW IS ITS OWN BRANCH, and folding it into the second is a real defect —
 * it was one until this revision. `refundedSoFar` and `currency` come off the
 * CARRIER; `amount` comes off the operator's keyboard. Fold them together and a
 * missing watermark answers `5.00` with *"Enter a valid refund amount greater than
 * zero (e.g. 19.99)"* over a field reading `5.00` — the console naming a cause that
 * is demonstrably not the cause and sending the operator to re-type the one thing
 * that was already right. A missing watermark is an unreadable payload
 * ({@link readWatermark}), so it gets {@link UNREADABLE}, exactly as
 * {@link refundOrderAction} gives it. It is checked FIRST because a broken carrier
 * is not fixable by re-typing: no amount the operator enters can make that payload
 * decode, so no refusal that points at the amount field is honest.
 *
 * WHY IT RE-READS THE LEDGER, given the carrier already holds a watermark. Two
 * defects, one read:
 *
 *  1. **DA-3c wants the LIVE ceiling.** The carrier holds `refundedSoFar`, not the
 *     remaining balance, and even a carried remaining would be the figure the
 *     operator SAW rather than the one the write will be judged against.
 *  2. **State 2 must not render at all once the ledger has moved.** Everything else
 *     state 2 draws — its label, its `meter`, the Money `fields`, the form's carrier
 *     — is rebuilt from the FRESH read, while the confirm alone carries the
 *     state-1 watermark (correctly: re-stamping it fresh while leaving `amountCents`
 *     alone would assert a decision the operator never made). So a moved ledger
 *     produces a coherent current panel beside a button that CANNOT succeed, with
 *     nothing saying why. Refusing here is what removes that state from existence.
 *
 * THE ORDER MATTERS. The watermark comparison runs BEFORE the bound check, so the
 * bound check is always against a ceiling the operator has now been shown — and the
 * movement refusal, whose copy already names the new remaining balance, wins when
 * both would fire.
 *
 * EVERY REFUSAL CARRIES A DRAFT WITH THE RAW AMOUNT STRING (DA-3a-i, DA-3a-iii
 * property 5) — including the unreadable-payload one, where nothing was written and
 * the operator's typing is still in hand. The parse check refuses precisely when the
 * amount did NOT parse, so there is no `amountCents` on that path and `19,99` cannot
 * be re-derived from cents: `amountInput` is the only thing that can put it back on
 * screen.
 */
function refundReviewAction() {
	return customAction<AdminOrdersClient, OrdersRenderState>(async (api) => {
		const orderId = readString(api.carried?.orderId);
		if (orderId === undefined) return api.showList(undefined, UNREADABLE);
		const currency = (readString(api.carried?.currency) ?? "").trim();
		const observedSoFar = parseCents(api.carried?.refundedSoFar);
		const values = api.input.values ?? {};
		const amountStr = (readString(values.amount) ?? "").trim();
		const reason = (readString(values.reason) ?? "").trim();
		const refundedBy = (readString(values.refundedBy) ?? "").trim();
		// The operator's input, VERBATIM, ready for any refusal below.
		const draft = (): OrdersRenderState => ({
			kind: "refund-draft",
			amountInput: amountStr,
			reason,
			refundedBy,
		});
		// DA-3b, BEFORE anything about the amount: these two come off the CARRIER, not
		// the operator's keyboard, so their absence is an unreadable payload
		// (`readWatermark`) and no refusal naming the amount field could be true. Blaming
		// the amount here told the operator to fix a field that already held `5.00`.
		if (observedSoFar === null || currency.length === 0) {
			return api.showLeaf([orderId], UNREADABLE, draft());
		}
		// Money parsed to integer MINOR UNITS with exact integer string math (no
		// float). `allowZero:false` — a refund of nothing is meaningless.
		const amountCents = parseMinorUnitsInput(amountStr, { allowZero: false });
		if (amountCents === null) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "Not refunded",
					description:
						"Enter a valid refund amount greater than zero (e.g. 19.99). Nothing was changed.",
				},
				draft(),
			);
		}
		if (refundedBy.length === 0) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "Not refunded",
					description: "Enter who is issuing or recording this refund. Nothing was changed.",
				},
				draft(),
			);
		}
		const live = await api.client.getRefunds(orderId).catch(() => null);
		if (live === null) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "Could not check the refund ledger",
					description:
						"The refund ledger could not be re-read, so nothing was staged and nothing was changed. Reload and try again.",
				},
				draft(),
			);
		}
		const liveCur = live.currency.length > 0 ? live.currency : currency;
		// DA-3a at the REVIEW step: the ledger moved between the form rendering and
		// this submit, so state 2 would draw a confirm the write will refuse.
		if (live.refundedTotalCents !== observedSoFar) {
			return api.showLeaf([orderId], staleLedgerNotice(amountCents, live, liveCur), draft());
		}
		// DA-3c: the bound check, against a ceiling just confirmed current. Without
		// it, `900.00` on a $50 order stages a red `Refund $900.00` and a dialog reading
		// "Refund $900.00 to …?" — both false at the exact moment they are shown, on the
		// one step that exists to let an operator check exactly that.
		if (amountCents > live.remainingCents) {
			return api.showLeaf(
				[orderId],
				{
					variant: "error",
					title: "Amount too high",
					description: `${formatTotal(amountCents, liveCur)} is more than the ${formatTotal(live.remainingCents, liveCur)} that remains refundable on this order. Enter ${formatTotal(live.remainingCents, liveCur)} or less.`,
				},
				draft(),
			);
		}
		return api.showLeaf([orderId], undefined, {
			kind: "refund-staged",
			amountCents,
			refundedSoFarCents: observedSoFar,
			currency,
			reason,
			refundedBy,
		});
	});
}

/**
 * The DA-3a stale-watermark refusal, shared by the `-review` and the confirm
 * handlers so the two cannot drift.
 *
 * THE CAUSAL CLAUSE IS NOT OPTIONAL. §8's normative example includes *"someone else
 * refunded this order"*, and an earlier version of this copy dropped it. "The ledger
 * changed" states an EFFECT and leaves the operator to guess whether they hit a bug;
 * the causal clause is the fact, it is what stops them retrying identically, and at
 * 76 characters it is nowhere near the 240 budget — so this was never length-driven.
 * 162 chars at the worked figures.
 */
function staleLedgerNotice(
	stagedAmountCents: number,
	live: RefundsSummaryWire,
	cur: string,
): Notice {
	return {
		variant: "error",
		title: "The refund ledger changed — nothing was refunded",
		description: fit(
			`${formatTotal(stagedAmountCents, cur)} was staged and was not recorded — someone else refunded this order since you started. ${formatTotal(live.remainingCents, cur)} now remains refundable; re-enter an amount below to try again.`,
			BANNER_BUDGET,
		),
	};
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
	return customAction<AdminOrdersClient, OrdersRenderState>(
		async ({ input, client, showLeaf, showList }) => {
			const payload = asRecord(input.value);
			const orderId = readString(payload?.orderId);
			if (orderId === undefined) return showList(undefined, UNREADABLE);
			const amountCents = parseCents(payload?.amountCents);
			const observedSoFar = parseCents(payload?.refundedSoFarCents);
			const currency = (readString(payload?.currency) ?? "").trim();
			const reason = (readString(payload?.reason) ?? "").trim();
			const refundedBy = (readString(payload?.refundedBy) ?? "").trim();
			// The refusal prefill, in RAW STRING space — the only channel that can put the
			// operator's figure back, since a `refund-draft` prefills `amountInput` and
			// nothing else. Where the amount parsed, formatting it back is what the field
			// showed them.
			const draft = (amountInput: string): OrdersRenderState => ({
				kind: "refund-draft",
				amountInput,
				reason,
				refundedBy,
			});
			// DA-3b. FOUR DISJUNCTS, AND ONLY ONE OF THEM LACKS AN AMOUNT. A payload can
			// carry a perfectly good `amountCents: "1000"` and still be unreadable because
			// the WATERMARK or the CURRENCY is missing — and on that arrival the operator
			// typed `10.00`, it parsed, nothing was written, and blanking the field
			// discards a figure we are holding while `reason` survives beside it. So the
			// prefill is conditional on the amount, not on the branch: `$10.00` goes back,
			// and only a genuinely unparseable or non-positive amount yields `""`.
			if (
				amountCents === null ||
				amountCents <= 0 ||
				observedSoFar === null ||
				currency.length === 0
			) {
				return showLeaf(
					[orderId],
					UNREADABLE,
					draft(amountCents !== null && amountCents > 0 ? formatMinorUnitsInput(amountCents) : ""),
				);
			}
			// DA-3a: re-read, then compare against the watermark the operator SAW.
			const live = await client.getRefunds(orderId).catch(() => null);
			if (live === null) {
				return showLeaf(
					[orderId],
					{
						variant: "error",
						title: "Nothing was refunded",
						description:
							"The refund ledger could not be re-checked, so nothing was applied. Reload and try again.",
					},
					draft(formatMinorUnitsInput(amountCents)),
				);
			}
			const liveCur = live.currency.length > 0 ? live.currency : currency;
			if (live.refundedTotalCents !== observedSoFar) {
				// The genuinely CONCURRENT case: the ledger moved between the state-2
				// render (or the DA-2b button's render) and this click. `refundReviewAction`
				// catches movement one step earlier; both are required, and they catch
				// different windows.
				return showLeaf(
					[orderId],
					staleLedgerNotice(amountCents, live, liveCur),
					draft(formatMinorUnitsInput(amountCents)),
				);
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
			// NO DRAFT ON THESE: the write was attempted, so every branch below is an
			// outcome to read rather than an input to correct — and on `GATEWAY_UNVERIFIED`
			// the outcome is unknown, where a form inviting a retry is the worst possible
			// affordance.
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
		},
	);
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

/**
 * Fail CLOSED with a GENERIC, em-dash-correct banner — never leaks a raw HTTP
 * status/URL (e.g. an auth 401 from a missing/expired admin token).
 *
 * E-7: IT MUST NOT ASSERT A CAUSE IT DOES NOT KNOW. This path swallows
 * *everything* — an unreachable service, a 401, a malformed response, and A BUG IN
 * THIS FILE (a `carriedForm` digest throw, a `filterPanel` field over budget, a
 * rejected carrier namespace all land here). The old copy opened *"Could not reach
 * the commerce service"*, which is simply false whenever a console defect is the
 * cause, and the cost is not cosmetic: it tells the operator the network is down and
 * sends whoever they page to the wrong team.
 *
 * So the copy names the SYMPTOM, lists the two things the operator can check, and
 * then says the remaining possibility out loud. That last clause is the load-bearing
 * one — it is the only thing that stops a console bug being reported as an outage —
 * and it costs 62 characters. 164 chars total, ≤240 (X-42).
 */
function failClosed() {
	return failClosedResponse({
		header: "Orders",
		title: "Orders are unavailable",
		description:
			"Orders could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
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

/**
 * The detail H1's date — `8 Jul 2026`. DATE ONLY, and deliberately the smallest
 * thing that works: INC-13 introduces the shared absolute-timestamp formatter
 * for the console's other timestamps, and this is the one surface that needed a
 * human-readable date before that lands. It is the natural place for INC-13 to
 * absorb.
 *
 * UTC-pinned (M-6 — no timezone conversion anywhere in this console) and run
 * through `Intl`, which is the house rule: localization and RTL-safety come
 * from Intl, never from hand-assembled month names. The locale is `en-GB` for
 * its DAY-MONTH-YEAR shape rather than for its country — `8 Jul 2026` cannot be
 * misread the way a numeric `7/8/2026` can, which is why the spec writes the
 * format that way.
 *
 * A malformed date falls back to the ISO date part rather than throwing:
 * `Intl.format` raises on an invalid Date, and a header is not worth failing a
 * render over (the handler answers 200 on every path).
 */
const HEADER_DATE = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	year: "numeric",
	timeZone: "UTC",
});

function headerDate(iso: string): string {
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? iso.slice(0, 10) : HEADER_DATE.format(at);
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
