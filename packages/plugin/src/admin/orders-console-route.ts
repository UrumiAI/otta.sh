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
import { asRecord, readAdminTokens, readString } from "./scaffold/index.js";
import { ORDER_STATES } from "@otta-sh/admin-presentation";
import type { Block, PluginContext, RouteHandler, SandboxedRouteContext } from "../types.js";

/**
 * The interaction types this module answers to.
 *
 * Deliberately NOT `page_load` / `block_action`: those belong to EmDash's
 * `SandboxedPluginPage` transport and the Block Kit screens keep them
 * exclusively. A distinct pair means the dispatcher can never confuse a console
 * request with an admin-shell one, and — the reason that matters — it means
 * nothing this module does can change what the Block Kit Orders screen renders.
 * ADR-0014 requires both screens to work until the replacement is proven; two
 * disjoint interaction types is that requirement expressed in the dispatch table.
 */
export const CONSOLE_READ_INTERACTION = "otta_console_read";
export const CONSOLE_ACT_INTERACTION = "otta_console_act";

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

/** A refusal the console renders instead of a blank pane (G5's reasoning, one
 *  tier up): the request completed, the answer is "no", and it says why. */
export interface ConsoleFailure {
	readonly ok: false;
	readonly title: string;
	readonly description: string;
}

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

/** The banner the Block Kit handler produced for this write, forwarded verbatim.
 *  `null` when the action succeeded quietly (the Block Kit screen re-renders
 *  with no banner in that case, and so does the console). */
export interface ConsoleActPayload {
	readonly ok: true;
	readonly notice: {
		readonly variant: string;
		readonly title: string;
		readonly description: string;
	} | null;
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

const UNREADABLE_REQUEST: ConsoleFailure = {
	ok: false,
	title: "That request could not be read",
	description:
		"The console asked for something this screen does not serve. Reload the page; if it happens again, this is a fault in the console itself.",
};

/** An action id the Block Kit screen does not register. Reachable from a stale
 *  tab after a deploy that renamed one, and from a console bug — never from a
 *  button this release rendered. */
const UNKNOWN_ACTION: ConsoleFailure = {
	ok: false,
	title: "Nothing was changed",
	description:
		"This console asked for an action this screen does not offer. Nothing was applied. Reload the page; if it happens again, this is a fault in the console itself.",
};

/** A registered action that produced no screen at all — so it produced no
 *  outcome either, and must not be reported as a quiet success. */
const NOTHING_APPLIED: ConsoleFailure = {
	ok: false,
	title: "Nothing was changed",
	description:
		"That action did not complete and nothing was applied. Reload the order and try again; if it happens again, this is a fault in the console itself.",
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

/**
 * Pull the outcome banner out of the block tree the Block Kit handler returned.
 *
 * WHY INDEX-FREE AND VARIANT-KEYED. `detailBlocks` emits at most two banners at
 * the top level: the notice, then the reconciliation alert. The alert is
 * `variant: "alert"` and is a property of the ORDER, not of what just happened —
 * forwarding it as the outcome of a refund would tell the operator their refund
 * produced a settlement warning. A `Notice` is only ever `default` or `error`
 * (`scaffold/banner.ts`), so keying on the variant separates the two without
 * depending on either one's position. Banners nested inside accordions are not
 * top-level blocks and are not seen here, which is why a scan is safe.
 */
export function firstNotice(blocks: readonly Block[]): ConsoleActPayload["notice"] {
	for (const block of blocks) {
		if (block.type !== "banner") continue;
		const banner = block as { variant?: unknown; title?: unknown; description?: unknown };
		const variant = readString(banner.variant);
		if (variant !== "default" && variant !== "error") continue;
		return {
			variant,
			title: readString(banner.title) ?? "",
			description: readString(banner.description) ?? "",
		};
	}
	return null;
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
 * The `value` is passed through UNTOUCHED. Everything in it — the order id, the
 * state or ledger watermark the operator observed, the amount in minor units —
 * is what the Block Kit button would have carried, and every one of those fields
 * is re-validated and re-checked against live truth on the other side before a
 * single byte is written. This module adds no trust and removes none.
 */
async function consoleAct(
	input: OrdersConsoleInput,
	ctx: PluginContext,
	orders: RouteHandler<OrdersPageInput>,
	request: SandboxedRouteContext<OrdersConsoleInput>["request"],
): Promise<ConsoleActPayload | ConsoleFailure> {
	const actionId = readString(input.action_id);
	if (actionId === undefined) return UNREADABLE_REQUEST;
	// GATE ON THE REGISTERED SET, and it is not belt-and-braces. The Block Kit
	// dispatcher answers an id it does not recognise with `{blocks: []}` — the
	// house-style fall-through — which on THIS branch is indistinguishable from
	// "the write succeeded and had nothing to say". So a typo'd or stale action
	// id would have rendered as a silent success on a refund button. The set is
	// the same `ORDERS_ACTION_IDS` the dispatcher routes on, so the two cannot
	// disagree about what exists.
	if (!ORDERS_ACTION_IDS.has(actionId)) return UNKNOWN_ACTION;
	const result = await orders(
		{ input: { type: "block_action", action_id: actionId, value: input.value }, request },
		ctx,
	);
	const envelope = asRecord(result);
	const blocks = Array.isArray(envelope?.["blocks"]) ? (envelope["blocks"] as Block[]) : [];
	// A registered id that STILL came back with no blocks did not render a
	// screen, so it did not do what it was asked either. `{ok: true, notice:
	// null}` here would report a refund that never happened as a quiet success.
	if (blocks.length === 0) return NOTHING_APPLIED;
	return { ok: true, notice: firstNotice(blocks) };
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

/** The interaction types the dispatcher routes here. Exported so
 *  `admin-route.ts` and its suite name the same two strings. */
export const CONSOLE_INTERACTIONS: ReadonlySet<string> = new Set([
	CONSOLE_READ_INTERACTION,
	CONSOLE_ACT_INTERACTION,
]);
