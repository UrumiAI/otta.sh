/**
 * The React console's read/write surface on the Orders screen (INC-20).
 *
 * WHY THIS FILE EXISTS AT ALL, stated first because it is the increment's one
 * genuinely load-bearing design decision.
 *
 * ADR-0014 Decision 3 gives `otta-console` exactly one data path: it calls the
 * **existing authenticated `otta` admin route** from the browser, with the
 * operator's own session, holding zero capabilities and zero `allowedHosts`.
 * That route is `POST /_emdash/api/plugins/otta/admin`, and until now it spoke
 * one language — `page_load` / `block_action` / `form_submit` in, Block Kit
 * blocks out. A React screen could in principle consume those blocks. It must
 * not, for four reasons that are all about correctness rather than taste:
 *
 *  1. **Money.** G1 says a money value reaches a screen as integer minor units
 *     and is rendered by `formatMoney`. Block Kit rows carry `"$15.00"` — money
 *     already spent. A React tier fed those strings would have no money to
 *     format, which is why `console-imports-no-workspace-package`'s own comment
 *     says INC-20 "owes the React tier a formatMoney". It is owed raw amounts.
 *  2. **The full id.** §1.3's React-tier rule is a short prefix WITH a copy
 *     button that copies the FULL id. The Block Kit list has no full id in it
 *     anywhere — that is the accepted degradation it was designed around — so
 *     the affordance is unreachable from its blocks by construction.
 *  3. **Filtering without a round trip.** ADR-0014 lists "client-side filter
 *     measured at zero network calls" as what React buys here. Filtering a
 *     rendered table is filtering strings.
 *  4. **Carrier encoding gone.** Same list. Parsing context back out of
 *     `block_id` carriers in a browser would be the carrier encoding, kept.
 *
 * So the console asks the SAME ROUTE for the SAME DATA in a different shape.
 * No new route, no new capability, no `allowedHosts` change, no service change:
 * the interaction `type` is new, the transport, the authorization, the CSRF
 * header and the egress are identical, and every byte still comes from
 * `AdminOrdersClient` over `ctx.http`.
 *
 * WRITES ARE STRUCTURED ACTIONS NOW (INC-R2, ADR-0015). They used to be
 * forwarded through the Block Kit Orders page handler as a synthesized
 * `block_action`, with the outcome SCRAPED back out of the rendered block tree —
 * which made the renderer of the screen this one replaced load-bearing for this
 * one. `orders-actions.ts` is that write path, re-expressed as functions
 * returning an outcome: {@link consoleAct} looks the id up in the same table the
 * gate reads and returns what it produced. Every watermark, every content-derived
 * idempotency key and every word of refusal copy moved across verbatim; nothing
 * about what a write decides changed with the shape it answers in.
 *
 * G5 APPLIES UNCHANGED: every response here is HTTP 200 with an outcome in the
 * body. A refusal is a value.
 */
import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import {
	AdminOrdersClient,
	type CustomerContextWire,
	type OrderDetailWire,
	type OrderNoteWire,
	type OrderSummaryWire,
	type OrderTimelineWire,
	type RefundsSummaryWire,
} from "./admin-orders-client.js";
import {
	CANCELLATION_REASONS,
	ONE_CLICK_CANCEL_REASONS,
	ORDERS_ACTION_IDS,
	RECONCILIATION_OUTCOMES,
	dispatchOrdersAction,
	type OrdersActionResult,
} from "./orders-actions.js";
import {
	PAGE_LIMIT,
	PERIOD_ANY,
	PERIOD_CUSTOM,
	PERIOD_PRESETS,
	loadDetailSurfaces,
	offeredTransitions,
	toClientFilter,
	type OrdersFilterForm,
	type PeriodKey,
} from "./orders-read.js";
import {
	CONSOLE_ACT_INTERACTION,
	CONSOLE_INTERACTIONS,
	CONSOLE_READ_INTERACTION,
	UNKNOWN_ACTION,
	UNREADABLE_REQUEST,
	readConsolePayload,
	type ConsoleFailure,
} from "./console-transport.js";
import { asRecord, readAdminTokens, readString } from "./scaffold/index.js";
import { ORDER_STATES } from "@otta-sh/admin-presentation";
import type { PluginContext, RouteHandler } from "../types.js";

/** INC-21 moved the two interaction types and the refusal shapes into
 *  `./console-transport.js`, where the Pricing & inventory branch reaches them
 *  too. They are RE-EXPORTED here because `admin-route.ts` and this module's
 *  sandbox suite already name this file. Nothing changed. */
export {
	CONSOLE_ACT_INTERACTION,
	CONSOLE_INTERACTIONS,
	CONSOLE_READ_INTERACTION,
	type ConsoleFailure,
};

/** The resources the console can read. One per screen surface, not one per
 *  service endpoint: the detail fans out to five reads in parallel exactly as
 *  the Block Kit detail does, because a React screen making five sequential
 *  round trips through this route would be slower than the screen it replaces. */
export type ConsoleResource = "orders.list" | "orders.detail";

/** Everything the console needs to render the filter controls with the SAME
 *  vocabulary the Block Kit screen offers.
 *
 *  IT IS SENT AS DATA, ON PURPOSE. The alternative — the React package holding
 *  its own copy of "Last 30 days", the ten order states and the four cancellation
 *  reasons — is four more constants that can disagree with the screen they are
 *  migrating from, in a package that cannot import the one place they are
 *  defined. Shipping them down the wire makes the two screens offer the same
 *  options by construction, and costs a few hundred bytes on a list load. */
export interface ConsoleVocabulary {
	/** `ORDER_STATES`, in render order — the Status filter's options. */
	readonly statuses: readonly string[];
	/** The Status filter's all-values sentinel. A real word, never `""`. */
	readonly statusAny: string;
	/** The Period filter's options, in render order, `Any time` first and
	 *  `Custom…` last. `key` is the token the console sends back. */
	readonly periods: ReadonlyArray<{ readonly key: string; readonly label: string }>;
	readonly cancellationReasons: ReadonlyArray<{ readonly value: string; readonly label: string }>;
	/** The subset of {@link cancellationReasons} that gets a ONE-CLICK control, and
	 *  therefore a `orders:cancel-<reason>` id of its own — derived from the same
	 *  constant the dispatch table derives its per-reason ids from, never
	 *  hand-listed and never re-derived on the console side. A console that
	 *  re-applied the `other` exclusion itself would hold the second copy of a rule
	 *  whose two halves now fail HARD when they disagree: `orders:cancel-other` is
	 *  not registered, so offering it posts an unknown id. Anything not in this list
	 *  is cancellable only through the note form, which posts `orders:cancel` with
	 *  the reason in its payload. */
	readonly oneClickCancellationReasons: ReadonlyArray<{
		readonly value: string;
		readonly label: string;
	}>;
	readonly reconciliationOutcomes: ReadonlyArray<{
		readonly value: string;
		readonly label: string;
	}>;
	/** The keyset page size, so the console's "Load more" matches the Block Kit
	 *  screen's rather than guessing. */
	readonly pageLimit: number;
}

/** The Status filter's all-values option value — `ANY` on the Block Kit side. */
const STATUS_ANY = "any";

export const CONSOLE_VOCABULARY: ConsoleVocabulary = {
	statuses: ORDER_STATES,
	statusAny: STATUS_ANY,
	periods: [
		{ key: STATUS_ANY, label: PERIOD_ANY },
		...PERIOD_PRESETS.map((preset) => ({ key: preset.key as string, label: preset.label })),
		{ key: "custom", label: PERIOD_CUSTOM },
	],
	cancellationReasons: CANCELLATION_REASONS.map((r) => ({ value: r.value, label: r.label })),
	oneClickCancellationReasons: ONE_CLICK_CANCEL_REASONS.map((r) => ({
		value: r.value,
		label: r.label,
	})),
	reconciliationOutcomes: RECONCILIATION_OUTCOMES.map((r) => ({ value: r.value, label: r.label })),
	pageLimit: PAGE_LIMIT,
};

export interface ConsoleListPayload {
	readonly ok: true;
	readonly orders: readonly OrderSummaryWire[];
	readonly nextCursor: string | null;
	/**
	 * The service's EXACT count of the filtered set (INC-23), forwarded so the
	 * React list states the same figure the Block Kit list states.
	 *
	 * ABSENT STAYS ABSENT — never defaulted to `0`, which would caption a page
	 * of rows with a count of none. A service older than the field omits it and
	 * both surfaces fall back to the page-scoped count they always had.
	 */
	readonly total?: number;
	/**
	 * THE PAGE THE REQUEST ASKED FOR WAS REFUSED, and these are the first page's
	 * rows instead.
	 *
	 * WHY IT IS ON THE SUCCESS PAYLOAD RATHER THAN A FAILURE. The request WAS
	 * answered: the cursor disagreed with the filters beside it, or would not
	 * decode, and the service's own remedy for that code is "drop the cursor and
	 * re-issue page one" — which `AdminOrdersClient` performs before this route
	 * ever sees a result. So there is a list to render and nothing to apologise
	 * for; what the console still needs is the FACT, because an address that names
	 * that page must be corrected and an operator who followed a link to it is
	 * owed a sentence.
	 *
	 * ABSENT ON EVERY ORDINARY PAGE. A console that ignores it renders the right
	 * rows one page from where it meant to be — the safe direction.
	 */
	readonly cursorRejected?: true;
	readonly vocabulary: ConsoleVocabulary;
}

export interface ConsoleDetailPayload {
	readonly ok: true;
	readonly order: OrderDetailWire;
	/** Already steered — the SAME set the Block Kit screen renders buttons for,
	 *  computed by the same function, so a bare `shipped` or a bare `cancelled`
	 *  is withheld on both surfaces or on neither. */
	readonly transitions: readonly string[];
	readonly customer: CustomerContextWire | null;
	readonly timeline: OrderTimelineWire | null;
	readonly refunds: RefundsSummaryWire | null;
	readonly notes: readonly OrderNoteWire[];
	readonly vocabulary: ConsoleVocabulary;
}

/** The console's fail-closed copy, and now the only Orders copy of it — the
 *  Block Kit screen it was written to match was retired by ADR-0015.
 *
 *  It says three things and no more: the symptom, the two settings to check, and
 *  the possibility that this is a console bug rather than an outage. It names no
 *  cause it does not know, because this path swallows an unreachable service, an
 *  auth failure, a malformed response and a defect in the console's own code
 *  alike — asserting any one of them sends whoever the operator pages to the
 *  wrong team. It also carries no status code and no upstream path: a banner gets
 *  screenshotted. Pinned by `orders-console-route.sandbox.test.ts`. */
const UNAVAILABLE: ConsoleFailure = {
	ok: false,
	title: "Orders are unavailable",
	description:
		"Orders could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
};

const NOT_FOUND: ConsoleFailure = {
	ok: false,
	title: "Order not found",
	description: "No order matches that id. It may have been removed since the list was loaded.",
};

/** The console's request envelope, narrowed to what this module reads. Every
 *  field is untrusted operator-round-tripped input and is re-validated here. */
export interface OrdersConsoleInput {
	type?: unknown;
	resource?: unknown;
	orderId?: unknown;
	cursor?: unknown;
	filter?: unknown;
	action_id?: unknown;
	value?: unknown;
}

/**
 * Read the filter the console sent back into the SAME `OrdersFilterForm` the
 * Block Kit screen builds from a form submit.
 *
 * The two screens therefore hand `toClientFilter` identical input, and the
 * period-to-instants resolution — whole days, both ends inclusive, relative
 * presets resolved against `now` at query time — happens once, in one function,
 * for both. A React screen computing its own `from`/`to` would be the third
 * implementation of a window this console has already unified twice.
 */
function readFilter(raw: unknown): OrdersFilterForm {
	const record = asRecord(raw);
	if (record === undefined) return {};
	const status = readString(record["status"]);
	const period = readString(record["period"]);
	const from = readString(record["from"]);
	const to = readString(record["to"]);
	const search = readString(record["search"]);
	const knownPeriod =
		period !== undefined &&
		(period === "custom" || PERIOD_PRESETS.some((preset) => preset.key === period))
			? (period as PeriodKey)
			: undefined;
	return {
		...(status !== undefined && status.length > 0 && status !== STATUS_ANY ? { status } : {}),
		...(knownPeriod !== undefined ? { period: knownPeriod } : {}),
		// Days belong to the custom period alone — the same rule the Block Kit
		// form applies when it stores a submit.
		...(knownPeriod === "custom" && from !== undefined && from.length > 0 ? { from } : {}),
		...(knownPeriod === "custom" && to !== undefined && to.length > 0 ? { to } : {}),
		...(search !== undefined && search.length > 0 ? { search } : {}),
	};
}

async function createClient(ctx: PluginContext): Promise<AdminOrdersClient> {
	const tokens = await readAdminTokens(ctx);
	return new AdminOrdersClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...tokens,
	});
}

async function consoleList(
	input: OrdersConsoleInput,
	ctx: PluginContext,
): Promise<ConsoleListPayload | ConsoleFailure> {
	const client = await createClient(ctx);
	const cursor = readString(input.cursor);
	const page = await client.listOrders(toClientFilter(readFilter(input.filter)), {
		limit: PAGE_LIMIT,
		...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
	});
	return {
		ok: true,
		orders: page.orders,
		nextCursor: page.nextCursor,
		...(page.total !== undefined ? { total: page.total } : {}),
		// FORWARDED, NEVER RE-DERIVED: only the client can see the service's own
		// refusal code, and only it knows whether the rows below came from the
		// cursor the console asked with or from the page-one retry it made instead.
		...(page.cursorRejected === true ? { cursorRejected: true as const } : {}),
		vocabulary: CONSOLE_VOCABULARY,
	};
}

async function consoleDetail(
	input: OrdersConsoleInput,
	ctx: PluginContext,
): Promise<ConsoleDetailPayload | ConsoleFailure> {
	const orderId = readString(input.orderId);
	if (orderId === undefined || orderId.length === 0) return UNREADABLE_REQUEST;
	const client = await createClient(ctx);
	const detail = await client.getOrder(orderId);
	if (detail === null) return NOT_FOUND;
	// E-1, unchanged for the React tier: the four secondary surfaces are fetched
	// in parallel and each degrades to `null` on its own rather than failing the
	// screen. The console renders a per-panel line for a null, exactly as the
	// Block Kit screen renders a per-group `context` line.
	const surfaces = await loadDetailSurfaces(client, orderId);
	return {
		ok: true,
		order: detail.order,
		transitions: offeredTransitions(detail.order, detail),
		customer: surfaces.customer,
		timeline: surfaces.timeline,
		refunds: surfaces.refunds,
		notes: surfaces.notes,
		vocabulary: CONSOLE_VOCABULARY,
	};
}

/**
 * Run a console write and return its outcome.
 *
 * THE OUTCOME IS A VALUE NOW, not something read back off a render. Everything in
 * the payload — the order id, the state or ledger watermark the operator
 * observed, the amount in minor units — is untrusted operator-round-tripped
 * input, and every one of those fields is re-validated and re-checked against
 * live truth inside `orders-actions.ts` before a single byte is written. This
 * module adds no trust and removes none.
 *
 * THE GATE ON THE ID IS NOT BELT-AND-BRACES. An id this screen does not offer is
 * reachable from a stale tab after a deploy that renamed one, and from a caller
 * bug — never from a control this release rendered. Answering it as an outcome
 * would report a refund that never happened as a quiet success, so an unknown id
 * is a refusal with copy. `ORDERS_ACTION_IDS` is read straight off the same
 * dispatch table `dispatchOrdersAction` runs, so the two cannot disagree about
 * what exists.
 */
async function consoleAct(
	input: OrdersConsoleInput,
	ctx: PluginContext,
): Promise<OrdersActionResult | ConsoleFailure> {
	const actionId = readString(input.action_id);
	if (actionId === undefined) return UNREADABLE_REQUEST;
	if (!ORDERS_ACTION_IDS.has(actionId)) return UNKNOWN_ACTION;
	const client = await createClient(ctx);
	const outcome = await dispatchOrdersAction(actionId, readConsolePayload(input.value), client);
	// Unreachable while the gate above reads the same table — kept because the two
	// are separate statements, and "the id was registered but nothing ran" must
	// never fall through to a quiet success.
	return outcome ?? UNKNOWN_ACTION;
}

/**
 * The console's half of the `otta` admin route.
 */
export function createOrdersConsoleHandler(): RouteHandler<OrdersConsoleInput> {
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		try {
			if (readString(input.type) === CONSOLE_ACT_INTERACTION) {
				return await consoleAct(input, ctx);
			}
			const resource = readString(input.resource);
			if (resource === "orders.list") return await consoleList(input, ctx);
			if (resource === "orders.detail") return await consoleDetail(input, ctx);
			return UNREADABLE_REQUEST;
		} catch {
			// G5's reasoning, one tier up: the console renders a refusal, never a
			// blank pane, and a non-2xx would be indistinguishable from the
			// transport failing. Everything lands here — an unreachable service, a
			// 401 on a missing admin token, a malformed response, a bug in this
			// file — so the copy names the SYMPTOM and says the last possibility out
			// loud rather than asserting a cause it does not know.
			return UNAVAILABLE;
		}
	};
}
