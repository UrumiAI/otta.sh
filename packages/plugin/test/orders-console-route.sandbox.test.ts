/**
 * The React console's data path, exercised INSIDE the workerd sandbox (INC-20).
 *
 * WHY A SANDBOX SUITE AND NOT A UNIT TEST. ADR-0006 Decision 1 is the reason and
 * ADR-0014 reaffirms it verbatim: the workerd suites are the contract gate for
 * `@otta-sh/plugin`, and "a change that only works trusted is still broken". This
 * increment adds a branch to the plugin's single admin route, so that branch has
 * to be proven in the isolate the plugin is specified to run in — bundled from a
 * bare copy of `src/`, with no Node, no workspace resolution and no `fetch` but
 * the injected one.
 *
 * THERE IS NO COMMERCE SERVICE BEHIND THIS ROUTE ANY MORE (INC-D3a). Until this
 * increment every case here stood up a stub HTTP server, told it what to answer,
 * and then asserted on the QUERY STRING the plugin sent it — the filter axes, the
 * cursor, the resolved period instants. `makeAdminClients(ctx)` now composes
 * `InProcessAdminOrdersClient` over `ctx.storage`, so the list is a query against
 * a REAL document store in the same isolate and there is no request to inspect.
 * Every one of those cases was therefore re-aimed at the thing the query string
 * was only ever a proxy for: the ROWS that come back. A period that resolves to
 * the wrong window now shows up as the seeded order missing from the page, which
 * is the defect the operator would actually have hit.
 *
 * WHAT IT DOES NOT COVER, deliberately: the React components. Those are gated by
 * Playwright (`sites/staging/e2e/orders-console.spec.ts`), which is additive to
 * this tier and replaces none of it. Nor the write path's own decisions — those
 * are `orders-actions.sandbox.test.ts` (INC-R2), which is where the three DA-3
 * refusals are proven; this file covers the ROUTE: which branch a request lands
 * on, and what a refusal on the branch itself looks like.
 *
 * THREE CASES LOST THEIR SUBJECT OUTRIGHT AND ARE DELETED RATHER THAN WEAKENED
 * (the third is documented at the point it stood, beside the transition cases):
 *  - *"a service that does not report a total does not get one invented"*. The
 *    absent-total case existed because a service older than INC-23 omitted the
 *    field. `#page` computes `total` with `countOrders` on every page it serves,
 *    so absent is now unreachable and a test for it could only assert against a
 *    fixture it invented itself. The rule it protected — never `?? 0` — survives
 *    where it can still be broken: the exact count is asserted below.
 *  - *"a secondary surface failing degrades to null"*. E-1's degradation was
 *    provoked by letting the stub 404 one of the four detail sub-requests. The
 *    four surfaces are now in-process reads against an order that exists, so
 *    there is no per-surface failure left to inject from outside; `.catch(() =>
 *    null)` in `loadDetailSurfaces` is unchanged and still the guard.
 *
 * THE FAIL-CLOSED CASE IS NOT DELETED, because it is still reachable — just not
 * by unplugging a service. See *"a read that throws inside the route fails
 * CLOSED"* below, which provokes it through the input bounds.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ORDERS_ACTION_IDS } from "../src/admin/orders-actions.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const READ = "otta_console_read";

function rowsOf(result: Record<string, unknown>): Array<Record<string, unknown>> {
	return result["orders"] as Array<Record<string, unknown>>;
}
const ACT = "otta_console_act";

/** A namespace no other suite writes under — the document store is
 *  process-scoped, and the cases below scope their own reads with a `search`
 *  axis so one case's orders can never be counted by another's. */
const NS = "oc";

/** The keyset page this route always asks for (`PAGE_LIMIT`). The paging cases
 *  seed one more than this so a second page exists at all. */
const PAGE_LIMIT = 25;

let sandbox: SandboxHandle;
let storage: StorageAccess;
let orderStore: EmdashOrderStore;
let seq = 0;

interface SeedOptions {
	/** Becomes the buyerRef PREFIX, which is the `search` axis a case scopes its
	 *  own rows with. */
	tag: string;
	totalCents?: number;
	state?: "paid" | "processing";
}

/** One order, seeded through the SAME adapters the console's in-process client
 *  composes. Returns its id. */
async function seedOrder(options: SeedOptions): Promise<string> {
	seq += 1;
	const suffix = `${NS}-${String(seq)}`;
	const id = `order-${suffix}`;
	const total = options.totalCents ?? 1999;
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${suffix}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: `${options.tag}-${suffix}@example.test`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${suffix}`),
				sku: toSku(`SKU-${suffix.toUpperCase()}`),
				title: "Linen apron",
				unitPrice: cents(total),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(total), total: cents(total), currency: currency("USD") },
	});
	await orderStore.markPaid(toOrderId(id));
	if (options.state === "processing") {
		await orderStore.transition({
			orderId: toOrderId(id),
			fromState: "paid",
			toState: "processing",
			idempotencyKey: idempotencyKey(`seed-processing-${suffix}`),
			enqueueEmail: false,
		});
	}
	return id;
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	orderStore = new EmdashOrderStore({ storage, inventory, idGen: uuidIdGen, clock: systemClock });
	// ONE boot for the file: the isolate holds no per-case state, so a boot per
	// case would only pay the bundle-and-spawn cost again.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
});

describe("the console's read/write branch on the otta admin route", () => {
	async function invoke(input: unknown): Promise<Record<string, unknown>> {
		const outcome = await sandbox.invokeRoute("admin", input);
		expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
		return (outcome as { result: Record<string, unknown> }).result;
	}

	/** One list read, scoped to the rows a case seeded under its own tag. */
	async function list(
		filter: Record<string, string>,
		extra: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return await invoke({ type: READ, resource: "orders.list", filter, ...extra });
	}

	// -- the list ---------------------------------------------------------------

	test("orders.list returns RAW minor units and the FULL id, not formatted money", async () => {
		// THE WHOLE REASON THIS BRANCH EXISTS (G1). A Block Kit row carries "$19.99"
		// — money already spent — and a React tier fed that string would have nothing
		// left to render through `formatMoney`. It gets 1999, read back off the order
		// this case actually persisted rather than off a fixture a stub was told to
		// return.
		const tag = "rawmoney";
		const id = await seedOrder({ tag, totalCents: 1999 });

		const result = await list({ search: tag });
		expect(result["ok"]).toBe(true);
		const orders = rowsOf(result);
		expect(orders).toHaveLength(1);
		expect(orders[0]?.["totalCents"]).toBe(1999);
		expect(orders[0]?.["currency"]).toBe("USD");
		// ...and the FULL id, which the Block Kit list does not contain anywhere.
		// Without it §1.3's React-tier copy button is unimplementable.
		expect(orders[0]?.["id"]).toBe(id);
		expect(JSON.stringify(result)).not.toContain("$19.99");
	});

	test("the EXACT count of the filtered set is reported, never the page's own length", async () => {
		// THE PARITY GAP INC-23 CLOSED. Without it the React list would caption a
		// page "25 orders on this page" where the count of the filtered set is what
		// the operator needs — and on this tier `total` is a real `countOrders`
		// under the SAME filter as the page, which is what lets the count describe
		// the rows it captions.
		const tag = "exactcount";
		for (let i = 0; i < 3; i++) await seedOrder({ tag });
		const result = await list({ search: tag });
		expect(result["total"]).toBe(3);
		expect(rowsOf(result)).toHaveLength(3);
	});

	test("the filter vocabulary is SENT as data, so the console holds no copy of it", async () => {
		const result = await list({ search: "vocabulary-matches-nothing" });
		const vocabulary = result["vocabulary"] as Record<string, unknown>;

		expect((vocabulary["periods"] as Array<{ label: string }>).map((p) => p.label)).toEqual([
			"Any time",
			"Last 7 days",
			"Last 30 days",
			"Last 90 days",
			"Custom…",
		]);
		expect(vocabulary["statuses"]).toEqual([
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
		]);
		expect(vocabulary["pageLimit"]).toBe(PAGE_LIMIT);
		expect(
			(vocabulary["cancellationReasons"] as Array<{ label: string }>).map((r) => r.label),
		).toContain("Out of stock");
	});

	test("the ONE-CLICK cancel reasons are SHIPPED, exclude `other`, and match the registered per-reason ids exactly", async () => {
		const result = await list({ search: "vocabulary-matches-nothing" });
		const vocabulary = result["vocabulary"] as Record<string, unknown>;
		const oneClick = vocabulary["oneClickCancellationReasons"] as Array<{ value: string }>;

		// THE POINT OF SHIPPING IT. The console renders one button per member and
		// posts `orders:cancel-<value>`; the dispatch table registers one id per
		// member of the SAME constant. A console that re-derived the exclusion
		// itself would hold the second copy of this rule, and the failure mode is
		// no longer benign: `orders:cancel-other` is not registered, so a drift
		// toward it posts an id the gate does not know and the operator gets an
		// unknown-action refusal instead of a cancel.
		//
		// Pinned as SET EQUALITY in both directions, not containment: a member with
		// no id is a broken button, an id with no member is dead surface.
		expect(oneClick.length).toBeGreaterThan(0);
		expect(oneClick.map((r) => r.value)).not.toContain("other");

		const shippedIds = oneClick.map((r) => `orders:cancel-${r.value}`).toSorted();
		const registeredIds = [...ORDERS_ACTION_IDS]
			.filter((id) => id.startsWith("orders:cancel-"))
			.toSorted();
		expect(shippedIds).toEqual(registeredIds);
		expect(registeredIds).not.toContain("orders:cancel-other");

		// A SUBSET of the note form's vocabulary, never a second list: `other` is
		// still offered there, where it records a detail.
		const all = (vocabulary["cancellationReasons"] as Array<{ value: string }>).map((r) => r.value);
		for (const reason of oneClick) expect(all).toContain(reason.value);
		expect(all).toContain("other");
	});

	test("the status axis SELECTS rows, and does not merely travel", async () => {
		// The old proof was `states=paid` appearing in a query string. The claim it
		// was standing in for is that the rows come back filtered, which is what a
		// second order in another state makes checkable.
		const tag = "statusaxis";
		const paid = await seedOrder({ tag });
		const processing = await seedOrder({ tag, state: "processing" });

		const paidOnly = rowsOf(await list({ search: tag, status: "paid" })).map((o) => o["id"]);
		expect(paidOnly).toEqual([paid]);
		const processingOnly = rowsOf(await list({ search: tag, status: "processing" })).map(
			(o) => o["id"],
		);
		expect(processingOnly).toEqual([processing]);
	});

	test("a CUSTOM period's `to` day is INCLUSIVE — an order placed today is in a window ending today", async () => {
		// THE BUG THIS CONVENTION FIXED, now provable against rows instead of
		// against an instant in a query string: padding both ends to midnight
		// silently dropped every order placed on the LAST day the operator asked
		// for. The order below was created moments ago, so a `to` of today that
		// resolved to `T00:00:00.000Z` would exclude it.
		const tag = "customwindow";
		const id = await seedOrder({ tag });
		const today = new Date().toISOString().slice(0, 10);

		const inside = rowsOf(await list({ search: tag, period: "custom", from: today, to: today }));
		expect(inside.map((o) => o["id"])).toEqual([id]);

		// ...and the window really is a window: a day that ended long ago excludes it.
		const outside = rowsOf(
			await list({ search: tag, period: "custom", from: "2020-01-01", to: "2020-01-02" }),
		);
		expect(outside).toEqual([]);
	});

	test("days are ignored unless the period is custom, exactly as on the form", async () => {
		// `last7` carries its own window, so the stray days below must not narrow
		// it — if they did, the order seeded moments ago would fall outside 2020 and
		// vanish.
		const tag = "straydays";
		const id = await seedOrder({ tag });
		const rows = rowsOf(
			await list({ search: tag, period: "last7", from: "2020-01-01", to: "2020-01-02" }),
		);
		expect(rows.map((o) => o["id"])).toEqual([id]);
	});

	test("a relative preset covers TODAY, and a 90-day window is not a 7-day one", async () => {
		// `last7` is TODAY AND THE SIX BEFORE IT, not `now - 168h`: the label and the
		// window it queries have to describe the same thing, and an order placed
		// today is the case that catches a `days` that became `days - 1`.
		const tag = "presets";
		const id = await seedOrder({ tag });
		for (const period of ["last7", "last30", "last90"]) {
			const rows = rowsOf(await list({ search: tag, period }));
			expect(
				rows.map((o) => o["id"]),
				period,
			).toEqual([id]);
		}
	});

	// -- cursors ----------------------------------------------------------------

	describe("cursors", () => {
		const tag = "paging";
		let firstPage: Record<string, unknown>;

		beforeAll(async () => {
			// ONE more than the page limit, so a second page exists at all.
			for (let i = 0; i < PAGE_LIMIT + 1; i++) await seedOrder({ tag });
			firstPage = await list({ search: tag });
		}, 120_000);

		test("page one fills to the page limit and mints a cursor for the rest", async () => {
			expect(rowsOf(firstPage)).toHaveLength(PAGE_LIMIT);
			expect(firstPage["total"]).toBe(PAGE_LIMIT + 1);
			expect(firstPage["nextCursor"]).toEqual(expect.any(String));
			expect(firstPage["cursorRejected"]).toBeUndefined();
		});

		test("the cursor travels WITH the filters it was minted under and is honoured", async () => {
			// Sending only the cursor did not stop a paged request disagreeing with
			// the page before it — it HID the disagreement: the predicate came solely
			// from the token and the filter beside it was never read, so an
			// unfiltered token beside a "Paid" caption answered with the unfiltered
			// set. The two are compared as predicates now, which is only useful if
			// the request states both.
			const second = await list({ search: tag }, { cursor: firstPage["nextCursor"] as string });
			expect(second["ok"]).toBe(true);
			expect(second["cursorRejected"]).toBeUndefined();
			expect(rowsOf(second)).toHaveLength(1);
			// The two pages are disjoint — a cursor that was silently dropped would
			// re-serve page one's rows here.
			const firstIds = new Set(rowsOf(firstPage).map((o) => o["id"]));
			expect(firstIds.has(rowsOf(second)[0]?.["id"])).toBe(false);
		});

		test("PRESENCE, not value: a cursor sent ALONE is honoured against its own filter", async () => {
			// A caller that names no axis claims nothing, so there is no disagreement
			// to find — the token's own filter is the predicate, and the page is the
			// page the token addressed rather than an unfiltered one.
			const second = await invoke({
				type: READ,
				resource: "orders.list",
				cursor: firstPage["nextCursor"] as string,
			});
			expect(second["cursorRejected"]).toBeUndefined();
			expect(rowsOf(second)).toHaveLength(1);
		});

		test("a cursor that DISAGREES with the filters beside it comes back as page one, flagged", async () => {
			// THE PRESCRIBED RECOVERY: a token whose predicate is not the caller's is
			// refused, page one is re-issued once with the caller's OWN parameters,
			// and the fact travels — because there is a list to render and nothing to
			// apologise for, but an address naming that page must be corrected.
			const result = await list(
				{ search: tag, status: "paid" },
				{ cursor: firstPage["nextCursor"] as string },
			);
			expect(result["ok"]).toBe(true);
			expect(result["cursorRejected"]).toBe(true);
			// PAGE ONE under the CALLER's filter, not the token's — which is also why
			// this cannot loop: there is no cursor left to refuse.
			expect(rowsOf(result)).toHaveLength(PAGE_LIMIT);
			const firstIds = rowsOf(firstPage).map((o) => o["id"]);
			expect(rowsOf(result).map((o) => o["id"])).toEqual(firstIds);
		});

		test("an undecodable cursor is recovered the same way", async () => {
			// One condition, one remedy: a tampered token and a token that disagrees
			// with its filters are both "that token is no good, ask again without it".
			const result = await list({ search: tag }, { cursor: "!!!not-base64url!!!" });
			expect(result["ok"]).toBe(true);
			expect(result["cursorRejected"]).toBe(true);
			expect(rowsOf(result)).toHaveLength(PAGE_LIMIT);
		});

		test("a paged relative period sends the SAME instants page one was minted with", async () => {
			// THE OBLIGATION A CLIENT THAT SENDS BOTH TAKES ON: re-resolving "last 7
			// days" at page-two time must not yield a different window, or every
			// `Load more` would be refused. It cannot here, and by construction rather
			// than by luck — `periodWindow` resolves a preset to WHOLE-DAY bounds, so
			// two requests on the same UTC day resolve to the same two instants. (A
			// scan that crosses UTC midnight genuinely does describe a different
			// window; the refusal and the page-one recovery are the right answer to
			// that, not a defect to design around.)
			//
			// THE PROOF MOVED WITH THE TRANSPORT. It used to compare the `from`/`to`
			// query params of two recorded requests. The filter is now compared
			// against the cursor's own as a PREDICATE inside the isolate, so a
			// re-resolution that drifted by so much as a millisecond would make page
			// two disagree with its token — which surfaces as `cursorRejected` and a
			// re-issued page one. Asserting the absence of that flag, and the single
			// remaining row, is the same claim read off the outcome.
			const paged = await list({ search: tag, period: "last7" });
			expect(paged["cursorRejected"]).toBeUndefined();
			expect(rowsOf(paged)).toHaveLength(PAGE_LIMIT);
			const cursor = paged["nextCursor"] as string;
			expect(cursor).toEqual(expect.any(String));

			const second = await list({ search: tag, period: "last7" }, { cursor });
			expect(second["ok"]).toBe(true);
			// The instants re-resolved identically, so the token was HONOURED — a
			// drifting window would have refused it and re-served page one.
			expect(second["cursorRejected"]).toBeUndefined();
			expect(rowsOf(second)).toHaveLength(1);
			const firstIds = new Set(rowsOf(paged).map((o) => o["id"]));
			expect(firstIds.has(rowsOf(second)[0]?.["id"])).toBe(false);
		});

		test("a refusal that is NOT about the cursor stays a failure", async () => {
			// The distinction the console cannot make for itself. A storage fault, a
			// malformed filter, a bug in the console's own code: none is answerable by
			// asking again without the cursor, and none may be reported as a page the
			// operator did not get — the address they are on still names a real page,
			// and rewriting it would throw that away at the moment a reload would have
			// restored it.
			//
			// PROVOKED BY THE FILTER, not by unplugging a service: `toDomainFilter`
			// bounds `search` at 200 characters and THROWS past it, before the cursor
			// is ever looked at. So this request carries a perfectly good cursor and
			// still fails — which is exactly the shape that must not be laundered into
			// a flagged page one.
			const result = await list(
				{ search: "x".repeat(201) },
				{ cursor: firstPage["nextCursor"] as string },
			);
			expect(result["ok"]).toBe(false);
			expect(result["cursorRejected"]).toBeUndefined();
			// The fail-closed banner, not a page: nothing that could be mistaken for
			// rows the operator asked for.
			expect(result["title"]).toBe("Orders are unavailable");
			expect(result["orders"]).toBeUndefined();
		});
	});

	// -- the detail -------------------------------------------------------------

	test("orders.detail answers the order and its four secondary surfaces in one round trip", async () => {
		const tag = "detail";
		const id = await seedOrder({ tag });

		const result = await invoke({ type: READ, resource: "orders.detail", orderId: id });
		expect(result["ok"]).toBe(true);
		const order = result["order"] as Record<string, unknown>;
		expect(order["id"]).toBe(id);
		// RAW minor units here too — the detail is the screen that renders a total.
		expect((order["totals"] as Record<string, unknown>)["totalCents"]).toBe(1999);
		expect(result["customer"]).not.toBeNull();
		expect(result["timeline"]).not.toBeNull();
		expect(result["refunds"]).not.toBeNull();
		expect(result["notes"]).toEqual([]);
		// STEERED, not raw: `paid` legally moves to processing, completed, cancelled
		// or refunded, and a bare `cancelled` is withheld because it would cancel
		// with no reason on file. The React screen renders buttons from this list.
		expect(result["transitions"]).toEqual(["processing", "completed", "refunded"]);
	});

	// DELETED: *"a service-offered state OUTSIDE the plugin's closed ORDER_STATES
	// is never offered (DA-6)"*. That case worked by making the service answer
	// `allowedTransitions: ["teleported", "completed"]` and asserting `teleported`
	// was filtered out. `InProcessAdminOrdersClient.getOrder` takes the list
	// STRAIGHT from `legalNextStates`, so there is no outside party left to offer
	// an out-of-band state and no way to inject one as a black box — every
	// candidate is already a member of `ORDER_STATES` before the filter sees it.
	// It was briefly retained as "every offered transition is a member of
	// ORDER_STATES", which is a tautology on this tier: it cannot fail, so it is
	// deleted rather than left standing as coverage it does not provide. The rule
	// itself is NOT gone — `offeredTransitions`'s `ORDER_STATE_SET.has(t)` guard in
	// `src/admin/orders-read.ts` is unchanged, and it is a pure exported function,
	// so the place it can still be proven is a direct unit test of that function
	// rather than a route case. The two steering filters beside it ARE reachable
	// here and are asserted below and in `orders.detail answers the order…`.

	test("a PROCESSING order is offered no bare `shipped` — it is steered to the Fulfilment form", async () => {
		// A bare `shipped` would ship without tracking and email the buyer an empty
		// shipped notice. The Fulfilment form records tracking and ships atomically,
		// so the transition button for it must not exist beside that form. The
		// domain offers `shipped`, `cancelled` and `refunded` from `processing`; the
		// first two are steered away and the third stays.
		const tag = "steering";
		const id = await seedOrder({ tag, state: "processing" });
		const result = await invoke({ type: READ, resource: "orders.detail", orderId: id });
		expect(result["transitions"]).toEqual(["refunded"]);
	});

	test("an unknown order is a refusal with copy, at HTTP 200 (G5)", async () => {
		const result = await invoke({
			type: READ,
			resource: "orders.detail",
			orderId: `order-${NS}-does-not-exist`,
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Order not found");
		expect(String(result["description"]).length).toBeGreaterThan(0);
	});

	test("a read that throws inside the route fails CLOSED with the screen's own copy, and leaks nothing", async () => {
		// THE CATCH-ALL ARM, still reachable and still worth pinning — just not by
		// unplugging a service any more. An order id carrying whitespace is refused
		// by the in-process client's own input bounds, which THROW (the reads throw
		// where the commands return a typed refusal), and everything that throws in
		// this route lands on the same banner.
		const result = await invoke({ type: READ, resource: "orders.detail", orderId: "bad id" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Orders are unavailable");
		// E-7: it must not assert a cause it does not know. The last clause is what
		// stops a console bug being reported as an outage.
		expect(String(result["description"])).toContain("a fault in the console itself");
		// THIS PATH SWALLOWS EVERYTHING — a storage fault, a malformed row, a bug in
		// the console's own code. So the copy carries no status code and no upstream
		// path: an operator screenshotting a banner must not be publishing the shape
		// of the admin surface, and naming one cause is false whenever another was
		// the real one.
		const text = `${String(result["title"])} ${String(result["description"])}`;
		expect(text).not.toMatch(/HTTP \d|\/admin\/|401/);
		expect(text).not.toContain("Could not reach the commerce service");
		// A banner is read at a glance or not at all (BANNER_BUDGET).
		expect(String(result["description"]).length).toBeLessThanOrEqual(240);
	});

	test("an unrecognised resource is a refusal, not a blank body", async () => {
		const result = await invoke({ type: READ, resource: "orders.nope" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("That request could not be read");
	});

	// -- the write branch -------------------------------------------------------

	test("a write is DISPATCHED to the extracted action, and its notice comes back", async () => {
		// The act branch, end to end. The watermark below (`state`) is re-read
		// against live truth by `orders-actions.ts`, and the refusal it produces for
		// a mismatch is what the console renders. What each action DECIDES is covered
		// by `orders-actions.sandbox.test.ts`; this asserts the wiring.
		const tag = "writewiring";
		const id = await seedOrder({ tag, state: "processing" });

		const result = await invoke({
			type: ACT,
			action_id: "orders:transition-shipped",
			// The operator SAW `paid`; the live order is `processing`.
			value: { orderId: id, toState: "shipped", state: "paid" },
		});

		expect(result["ok"]).toBe(true);
		const notice = result["notice"] as Record<string, unknown>;
		expect(notice["variant"]).toBe("error");
		expect(notice["title"]).toBe("The order changed — nothing was applied");
		expect(String(notice["description"])).toContain("was paid when you started");
	});

	test("a write with no notice reports no notice, rather than inventing one", async () => {
		const tag = "quietwrite";
		const id = await seedOrder({ tag });
		const result = await invoke({
			type: ACT,
			action_id: "orders:transition-processing",
			value: { orderId: id, toState: "processing", state: "paid" },
		});
		expect(result["ok"]).toBe(true);
		expect(result["notice"]).toBeNull();
	});

	test("a RECONCILIATION alert is never mistaken for the outcome of the write", async () => {
		// The alert is a property of the ORDER, not of what just happened —
		// reporting it as the outcome would tell an operator their status change
		// produced a settlement warning. It used to be separated from the notice by
		// keying on a rendered banner's variant; now the write simply returns its own
		// outcome and never sees the record's alerts at all. Kept because the
		// property is what matters, not the mechanism that used to deliver it.
		const tag = "flagged";
		const id = await seedOrder({ tag });
		await orderStore.flagReconciliation(toOrderId(id), "amount mismatch");
		const result = await invoke({
			type: ACT,
			action_id: "orders:transition-processing",
			value: { orderId: id, toState: "processing", state: "paid" },
		});
		expect(result["notice"]).toBeNull();
		// ...and the flag is still standing, unread by the write.
		const detail = await invoke({ type: READ, resource: "orders.detail", orderId: id });
		expect((detail["order"] as Record<string, unknown>)["reconciliationFlag"]).toBe(
			"amount mismatch",
		);
	});

	test("an UNKNOWN action id is a refusal, not a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action. An id
		// this screen does not offer must never come back as an outcome: that would
		// render a refund that never happened as a silent success.
		const result = await invoke({
			type: ACT,
			action_id: "orders:no-such-action",
			value: { orderId: `order-${NS}-does-not-exist` },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
		expect(String(result["description"])).toContain("Nothing was applied");
	});

	test("a REGISTERED id whose write could not complete is also a refusal", async () => {
		// The note hangs off no order, so nothing was appended. "Nothing came back"
		// is not "nothing to say" — and the one shape this must never take is
		// `{ok: true, notice: null}`, which would claim the note was saved.
		const result = await invoke({
			type: ACT,
			action_id: "orders:add-note",
			value: { orderId: `order-${NS}-does-not-exist`, author: "ops", body: "hello" },
		});
		const quietSuccess = result["ok"] === true && result["notice"] === null;
		expect(quietSuccess, "a failed write reported as a quiet success").toBe(false);
		expect((result["notice"] as Record<string, unknown>)["title"]).toBe("Note not added");
	});
});
