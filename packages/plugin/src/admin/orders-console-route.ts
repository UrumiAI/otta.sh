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
 * WRITES ARE NOT REIMPLEMENTED, AND THAT IS THE POINT. Refunds, cancellations
 * and status transitions are money-moving paths with watermarks, content-derived
 * idempotency keys and a large, hard-won vocabulary of refusal copy — all of it
 * in `orders-page.ts` and all of it covered by `orders-page.sandbox.test.ts`. A
 * second implementation for React would be a second set of concurrency bugs. So
 * {@link consoleAct} forwards the operator's click to the Block Kit handler as
 * the exact `block_action` the Block Kit button would have sent, and returns the
 * notice that handler produced. The React screen renders a different banner; the
 * decision behind it is the same code, byte for byte.
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
	PAGE_LIMIT,
	PERIOD_ANY,
	PERIOD_CUSTOM,
	PERIOD_PRESETS,
	RECONCILIATION_OUTCOMES,
	ORDERS_ACTION_IDS,
	createOrdersPageHandler,
	loadDetailSurfaces,
	offeredTransitions,
	toClientFilter,
	type OrdersFilterForm,
	type OrdersPageInput,
	type PeriodKey,
} from "./orders-page.js";
import {
	CONSOLE_ACT_INTERACTION,
	CONSOLE_INTERACTIONS,
	CONSOLE_READ_INTERACTION,
	UNREADABLE_REQUEST,
	firstNotice,
	forwardConsoleAct,
	type ConsoleActPayload,
	type ConsoleFailure,
} from "./console-transport.js";
import { asRecord, readAdminTokens, readString } from "./scaffold/index.js";
import { ORDER_STATES } from "@otta-sh/admin-presentation";
import type { PluginContext, RouteHandler, SandboxedRouteContext } from "../types.js";

/** INC-21 moved the two interaction types, the refusal shapes and the
 *  act-forwarding into `./console-transport.js`, where the Pricing & inventory
 *  branch reaches them too. They are RE-EXPORTED here because `admin-route.ts`
 *  and this module's sandbox suite already name this file. Nothing changed. */
export {
	CONSOLE_ACT_INTERACTION,
	CONSOLE_INTERACTIONS,
	CONSOLE_READ_INTERACTION,
	firstNotice,
	type ConsoleActPayload,
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

/** The console's fail-closed copy. It says the same three things
 *  `orders-page.ts`'s `failClosed()` says — symptom, the two things to check,
 *  and the possibility that this is a console bug rather than an outage — for
 *  the same reason: naming a cause it does not know sends whoever the operator
 *  pages to the wrong team. */
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
 * Forward a console click to the Block Kit action handler and return its notice.
 *
 * Every Orders write is a BUTTON, so the payload is passed through UNTOUCHED as
 * the `block_action` that button would have fired. Everything in it — the order
 * id, the state or ledger watermark the operator observed, the amount in minor
 * units — is what the Block Kit button would have carried, and every one of
 * those fields is re-validated and re-checked against live truth on the other
 * side before a single byte is written. This module adds no trust and removes
 * none. (Pricing & inventory's writes are mostly FORM submits, which is why the
 * shared forwarder also knows how to mint a carrier — see
 * `products-console-route.ts`.)
 *
 * `ORDERS_ACTION_IDS` is the same set the dispatcher routes on, so the two
 * cannot disagree about what exists.
 */
async function consoleAct(
	input: OrdersConsoleInput,
	ctx: PluginContext,
	orders: RouteHandler<OrdersPageInput>,
	request: SandboxedRouteContext<OrdersConsoleInput>["request"],
): Promise<ConsoleActPayload | ConsoleFailure> {
	const actionId = readString(input.action_id);
	if (actionId === undefined) return UNREADABLE_REQUEST;
	return forwardConsoleAct({
		actionId,
		interaction: { type: "block_action", action_id: actionId, value: input.value },
		registered: ORDERS_ACTION_IDS,
		handler: orders,
		ctx,
		request,
		record: "order",
	});
}

/**
 * The console's half of the `otta` admin route.
 *
 * It constructs the Block Kit Orders handler ONCE and holds it, the way
 * `admin-route.ts` holds the seven page handlers — the write path is that
 * handler, so there is exactly one of it.
 */
export function createOrdersConsoleHandler(): RouteHandler<OrdersConsoleInput> {
	const orders = createOrdersPageHandler();

	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		try {
			if (readString(input.type) === CONSOLE_ACT_INTERACTION) {
				return await consoleAct(input, ctx, orders, routeCtx.request);
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
