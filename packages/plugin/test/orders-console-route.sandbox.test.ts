/**
 * The React console's data path, exercised INSIDE the workerd sandbox (INC-20).
 *
 * WHY A SANDBOX SUITE AND NOT A UNIT TEST. ADR-0006 Decision 1 is the reason and
 * ADR-0014 reaffirms it verbatim: the 18 workerd suites are the contract gate
 * for `@otta-sh/plugin`, and "a change that only works trusted is still broken".
 * This increment adds a branch to the plugin's single admin route, so that
 * branch has to be proven in the isolate the plugin is specified to run in —
 * bundled from a bare copy of `src/`, with no Node, no workspace resolution and
 * no `fetch` but the injected one.
 *
 * IT ALSO PROVES THE EXTRACTION. The shared presentation package is a runtime
 * workspace import in `src/`, which `src/` had none of before INC-20. If the
 * harness failed to materialise it, or if tsdown left it external, this file
 * would not boot at all — so every assertion below is downstream of the
 * extraction actually working inside workerd.
 *
 * WHAT IT DOES NOT COVER, deliberately: the React components. Those are gated by
 * Playwright (`sites/staging/e2e/orders-console.spec.ts`), which is additive to
 * this tier and replaces none of it. Nor the write path's own decisions — those
 * are `orders-actions.sandbox.test.ts` (INC-R2), which is where the three DA-3
 * refusals are proven; this file covers the ROUTE: which branch a request lands
 * on, and what a refusal on the branch itself looks like.
 *
 * FIVE CROSS-SURFACE PINS LEFT WITH INC-R2. They asserted that the BLOCK KIT
 * Orders screen rendered the same shared copy constants the React screen imports,
 * and that a plain `page_load` still produced its blocks. ADR-0015 retired that
 * screen, so there is no second surface left for either claim to be about.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ORDERS_ACTION_IDS } from "../src/admin/orders-actions.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

const READ = "otta_console_read";
const ACT = "otta_console_act";

const ORDER_ID = "7e4ce728-0000-4000-8000-000000000001";
const OTHER_ID = "7e4ce728-1111-4000-8000-000000000002";

function orderSummary(
	id: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		state: "paid",
		currency: "USD",
		buyerRef: "alice@example.com",
		customerId: null,
		paymentMethod: "card",
		createdAt: "2026-07-08T10:30:00.000Z",
		totalCents: 1999,
		reconciliationFlag: null,
		...overrides,
	};
}

function orderDetail(id: string): Record<string, unknown> {
	return {
		id,
		state: "paid",
		currency: "USD",
		paymentMethod: "card",
		buyerRef: "alice@example.com",
		customerId: null,
		holdExpiresAt: null,
		createdAt: "2026-07-08T10:30:00.000Z",
		reconciliationFlag: null,
		reconciliationResolution: null,
		fulfillment: null,
		cancellation: null,
		shippingAddress: null,
		totals: {
			currency: "USD",
			subtotalCents: 1999,
			discountCents: 0,
			shippingCents: 0,
			taxCents: 0,
			totalCents: 1999,
			appliedCouponCode: null,
		},
		lines: [
			{
				sku: "APR-LIN-NAT",
				title: "Linen apron",
				unitPriceCents: 1999,
				currency: "USD",
				quantity: 1,
				fulfillmentKind: "physical",
			},
		],
	};
}

/** The `YYYY-MM-DD` (UTC) `n` days before `day`, so a relative period's expected
 *  bounds are not a function of the day the suite runs on. */
function dayBefore(day: string, n: number): string {
	return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** The stub keys ONE responder per HTTP method, so routing is a function of the
 *  url — the shape the retired Block Kit suite used. Each test declares
 *  the routes it cares about and everything else 404s, which is itself part of
 *  the assertion: a surface this branch is not supposed to call shows up as a
 *  null rather than passing silently. */
type Routes = Record<string, () => { status: number; body: unknown }>;

function responder(routes: Routes) {
	return (request: { url: string }) => {
		const path = request.url.split("?")[0] ?? "";
		const route = routes[path];
		return route ? route() : { status: 404, body: { error: "no route" } };
	};
}

describe("the console's read/write branch on the otta admin route", () => {
	let service: StubCommerceServer;
	let sandbox: SandboxHandle;

	beforeEach(async () => {
		service = await startStubCommerceServer();
		sandbox = await loadPluginInSandbox({
			allowedHosts: [service.host],
			commerceServiceBaseUrl: service.baseUrl,
		});
	});

	afterEach(async () => {
		await sandbox.close();
		await service.close();
	});

	async function invoke(input: unknown): Promise<Record<string, unknown>> {
		const outcome = await sandbox.invokeRoute("admin", input);
		expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
		return (outcome as { result: Record<string, unknown> }).result;
	}

	test("orders.list returns RAW minor units, not formatted money", async () => {
		// THE WHOLE REASON THIS BRANCH EXISTS (G1). A Block Kit row carries
		// "$19.99" — money already spent — and a React tier fed that string would
		// have nothing left to render through `formatMoney`. It gets 1999.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({
					status: 200,
					body: { orders: [orderSummary(ORDER_ID)], nextCursor: null },
				}),
			}),
		);

		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result["ok"]).toBe(true);
		const orders = result["orders"] as Array<Record<string, unknown>>;
		expect(orders).toHaveLength(1);
		expect(orders[0]?.["totalCents"]).toBe(1999);
		expect(orders[0]?.["currency"]).toBe("USD");
		// ...and the FULL id, which the Block Kit list does not contain anywhere.
		// Without it §1.3's React-tier copy button is unimplementable.
		expect(orders[0]?.["id"]).toBe(ORDER_ID);
		expect(JSON.stringify(result)).not.toContain("$19.99");
	});

	test("the service's exact `total` is FORWARDED to the React list (INC-23 parity)", async () => {
		// THE PARITY GAP THIS MERGE CLOSES. INC-23 gave the Block Kit list an exact
		// count; without this the React list beside it would have kept saying
		// "25 orders on this page" while the Block Kit screen one sidebar entry
		// away said "137 orders" — on the most-read line of the most-read screen.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({
					status: 200,
					body: { orders: [orderSummary(ORDER_ID)], nextCursor: "cur-2", total: 137 },
				}),
			}),
		);
		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result["total"]).toBe(137);
	});

	test("a service that does not report a total does not get one invented", async () => {
		// ABSENT STAYS ABSENT — never `?? 0`, which would caption a page of rows
		// with a count of none.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({
					status: 200,
					body: { orders: [orderSummary(ORDER_ID)], nextCursor: null },
				}),
			}),
		);
		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result).not.toHaveProperty("total");
	});

	test("the filter vocabulary is the Block Kit screen's own", async () => {
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({ status: 200, body: { orders: [], nextCursor: null } }),
			}),
		);
		const result = await invoke({ type: READ, resource: "orders.list" });
		const vocabulary = result["vocabulary"] as Record<string, unknown>;

		// Sent as DATA so the React screen cannot offer a different set of
		// options than the screen it is migrating from — it has no copy of them.
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
		expect(vocabulary["pageLimit"]).toBe(25);
		expect(
			(vocabulary["cancellationReasons"] as Array<{ label: string }>).map((r) => r.label),
		).toContain("Out of stock");
	});

	test("the ONE-CLICK cancel reasons are SHIPPED, exclude `other`, and match the registered per-reason ids exactly", async () => {
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({ status: 200, body: { orders: [], nextCursor: null } }),
			}),
		);
		const result = await invoke({ type: READ, resource: "orders.list" });
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

	test("a filter is translated through the SAME mapping the Block Kit form uses", async () => {
		service.respondWith("GET", () => ({ status: 200, body: { orders: [], nextCursor: null } }));

		await invoke({
			type: READ,
			resource: "orders.list",
			filter: { status: "paid", period: "custom", from: "2026-07-01", to: "2026-07-31" },
		});

		const seen = service.requests.find((r) => r.url.startsWith("/admin/orders"))?.url ?? "";
		expect(seen).toContain("states=paid");
		// Whole days, BOTH ENDS INCLUSIVE — the console's one date-bounds
		// convention, resolved by `periodWindow`/`endOfDay` rather than by a
		// second implementation in the browser.
		expect(decodeURIComponent(seen)).toContain("2026-07-01T00:00:00.000Z");
		expect(decodeURIComponent(seen)).toContain("2026-07-31T23:59:59.999Z");
	});

	test("a cursor travels WITH the filters it was minted under, never alone", async () => {
		// Sending only the cursor did not stop a paged request disagreeing with the
		// page before it — it HID the disagreement: the route took the predicate
		// solely from the token and never read the query's filter params, so an
		// unfiltered token beside `?states=paid` answered 200 with the unfiltered
		// set and a console captioned those rows "Paid". The route now compares the
		// two as predicates and fails closed on a difference, which is only useful
		// if the request states both.
		service.respondWith("GET", () => ({ status: 200, body: { orders: [], nextCursor: null } }));
		await invoke({
			type: READ,
			resource: "orders.list",
			cursor: "svc-cursor-1",
			filter: { status: "paid", search: "Ada" },
		});
		const seen = service.requests.find((r) => r.url.startsWith("/admin/orders"))?.url ?? "";
		expect(seen).toContain("cursor=svc-cursor-1");
		expect(seen).toContain("states=paid");
		// THE TERM IS NOT FOLDED between the address and the wire. The comparison is
		// case-SENSITIVE by design (the store's case-insensitivity is the store's
		// business), so normalising here and not on page one would manufacture a
		// mismatch out of nothing.
		expect(decodeURIComponent(seen)).toContain("search=Ada");
		expect(seen).toContain("limit=25");
	});

	test("a paged relative period sends the SAME instants page one was minted with", async () => {
		// THE OBLIGATION THE GATE PUTS ON A CLIENT THAT SENDS BOTH: re-resolving
		// "last 7 days" at page-two time must not yield a different window, or every
		// `Load more` would 400. It cannot here, and by construction rather than by
		// luck — `periodWindow` resolves a preset to WHOLE-DAY bounds, so two
		// requests on the same UTC day resolve to the same two instants. (A scan
		// that crosses UTC midnight genuinely does describe a different window; the
		// refusal and the page-one recovery are the right answer to that, not a
		// defect to design around.)
		service.respondWith("GET", () => ({ status: 200, body: { orders: [], nextCursor: null } }));
		await invoke({ type: READ, resource: "orders.list", filter: { period: "last7" } });
		await invoke({
			type: READ,
			resource: "orders.list",
			cursor: "svc-cursor-1",
			filter: { period: "last7" },
		});
		const asked = service.requests
			.filter((r) => r.url.startsWith("/admin/orders"))
			.map((r) => new URLSearchParams(r.url.split("?")[1] ?? ""));
		expect(asked).toHaveLength(2);
		expect(asked[1]?.get("cursor")).toBe("svc-cursor-1");
		expect(asked[1]?.get("from")).toBe(asked[0]?.get("from"));
		expect(asked[1]?.get("to")).toBe(asked[0]?.get("to"));
	});

	test("a refused cursor comes back as page one, flagged, not as an error", async () => {
		// THE SERVICE'S OWN REMEDY, performed at the client: `cursor filter
		// mismatch` means "drop the token and re-issue page one with these
		// parameters". Two service requests, one console answer, and the fact
		// travels so the screen can correct an address that still names that page.
		let call = 0;
		service.respondWith("GET", () => {
			call += 1;
			return call === 1
				? { status: 400, body: { error: "cursor filter mismatch" } }
				: { status: 200, body: { orders: [], nextCursor: "next-1" } };
		});
		const result = await invoke({
			type: READ,
			resource: "orders.list",
			cursor: "stale-cursor",
			filter: { status: "paid" },
		});
		expect(result["ok"]).toBe(true);
		expect(result["cursorRejected"]).toBe(true);
		const asked = service.requests
			.filter((r) => r.url.startsWith("/admin/orders"))
			.map((r) => r.url);
		expect(asked).toHaveLength(2);
		expect(asked[0]).toContain("cursor=stale-cursor");
		// THE RETRY DROPS THE TOKEN AND KEEPS THE PARAMETERS, which is why it cannot
		// loop: there is no cursor left to refuse.
		expect(asked[1]).not.toContain("cursor=");
		expect(asked[1]).toContain("states=paid");
	});

	test("an undecodable cursor is recovered the same way", async () => {
		// One condition, one remedy: `invalid cursor` and `cursor filter mismatch`
		// are both "that token is no good, ask again without it".
		let call = 0;
		service.respondWith("GET", () => {
			call += 1;
			return call === 1
				? { status: 400, body: { error: "invalid cursor" } }
				: { status: 200, body: { orders: [], nextCursor: null } };
		});
		const result = await invoke({ type: READ, resource: "orders.list", cursor: "!!!garbage" });
		expect(result["ok"]).toBe(true);
		expect(result["cursorRejected"]).toBe(true);
	});

	test("a cursor refusal for a request that carried NO cursor cannot re-issue", async () => {
		// The service contradicting itself. There is nothing to retry — the same
		// cursor-less request would ask the same question — so it fails like any
		// other refusal rather than looping or reporting a page nobody asked for.
		service.respondWith("GET", () => ({
			status: 400,
			body: { error: "cursor filter mismatch" },
		}));
		const result = await invoke({
			type: READ,
			resource: "orders.list",
			filter: { status: "paid" },
		});
		expect(result["ok"]).toBe(false);
		expect(service.requests.filter((r) => r.url.startsWith("/admin/orders"))).toHaveLength(1);
	});

	test("a refusal that is NOT about the cursor stays a failure", async () => {
		// The distinction the console cannot make for itself. An outage, an expired
		// admin token, an unparseable filter: none is answerable by asking again
		// without the cursor, and none may be reported as a page the operator did
		// not get — the address they are on still names a real page, and rewriting
		// it would throw that away at the moment a reload would have restored it.
		service.respondWith("GET", () => ({ status: 503, body: { error: "service unavailable" } }));
		const result = await invoke({
			type: READ,
			resource: "orders.list",
			cursor: "svc-cursor-1",
			filter: { status: "paid" },
		});
		expect(result["ok"]).toBe(false);
		expect(result["cursorRejected"]).toBeUndefined();
		expect(service.requests.filter((r) => r.url.startsWith("/admin/orders"))).toHaveLength(1);
	});

	test("a 400 with no readable body is NOT read as a cursor refusal", async () => {
		// The safe reading of an unexplained failure is the one that keeps the
		// operator's page in the address rather than the one that discards it.
		service.respondWith("GET", () => ({ status: 400, body: "" }));
		const result = await invoke({
			type: READ,
			resource: "orders.list",
			cursor: "svc-cursor-1",
		});
		expect(result["ok"]).toBe(false);
		expect(service.requests.filter((r) => r.url.startsWith("/admin/orders"))).toHaveLength(1);
	});

	test("days are ignored unless the period is custom, exactly as on the form", async () => {
		service.respondWith("GET", () => ({ status: 200, body: { orders: [], nextCursor: null } }));
		await invoke({
			type: READ,
			resource: "orders.list",
			filter: { period: "last7", from: "2020-01-01", to: "2020-01-02" },
		});
		const seen = service.requests.find((r) => r.url.startsWith("/admin/orders"))?.url ?? "";
		expect(decodeURIComponent(seen)).not.toContain("2020-01-01");
	});

	test("a relative preset resolves to WHOLE days, today included — the exact instants the service is asked for", async () => {
		// THE WINDOW A PRESET REPLACES those ignored days WITH. The test above proves
		// stray custom days are dropped; without this one, `days - 1` could become
		// `days` — an off-by-one day on every relative period — and nothing in the
		// tree would notice. `last7` is TODAY AND THE SIX BEFORE IT, not `now - 168h`:
		// the label and the window it queries have to describe the same thing.
		service.respondWith("GET", () => ({ status: 200, body: { orders: [], nextCursor: null } }));
		const today = new Date().toISOString().slice(0, 10);

		for (const [period, days] of [
			["last7", 7],
			["last30", 30],
			["last90", 90],
		] as const) {
			service.requests.length = 0;
			await invoke({ type: READ, resource: "orders.list", filter: { period } });
			const seen = service.requests.find((r) => r.url.startsWith("/admin/orders"))?.url ?? "";
			const query = new URLSearchParams(seen.split("?")[1] ?? "");
			// Both ends inclusive: the start of the first day through the LAST
			// millisecond of today. Midnight for both ends silently dropped every
			// order placed on the last day the operator asked for.
			expect(query.get("from")).toBe(`${dayBefore(today, days - 1)}T00:00:00.000Z`);
			expect(query.get("to")).toBe(`${today}T23:59:59.999Z`);
		}
	});

	test("orders.detail fans out to the secondary surfaces in one round trip", async () => {
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: { order: orderDetail(ORDER_ID), allowedTransitions: ["processing", "cancelled"] },
				}),
				[`/admin/orders/${ORDER_ID}/customer-context`]: () => ({
					status: 200,
					body: {
						context: {
							identity: { buyerRef: "alice@example.com", linkage: "guest" },
							orderCount: 2,
						},
					},
				}),
				[`/admin/orders/${ORDER_ID}/timeline`]: () => ({
					status: 200,
					body: { timeline: { entries: [] } },
				}),
				[`/admin/orders/${ORDER_ID}/refunds`]: () => ({
					status: 200,
					body: {
						refunds: [],
						currency: "USD",
						capturedTotalCents: 1999,
						refundedTotalCents: 0,
						ceilingCents: 1999,
						remainingCents: 1999,
						paymentMethod: "card",
						refundable: true,
					},
				}),
				[`/admin/orders/${ORDER_ID}/notes`]: () => ({ status: 200, body: { notes: [] } }),
			}),
		);

		const result = await invoke({ type: READ, resource: "orders.detail", orderId: ORDER_ID });
		expect(result["ok"]).toBe(true);
		expect((result["order"] as Record<string, unknown>)["id"]).toBe(ORDER_ID);
		expect(result["customer"]).not.toBeNull();
		expect(result["refunds"]).not.toBeNull();
		// STEERED, not raw: `cancelled` is withheld on both surfaces because a
		// bare cancel records no reason. The React screen renders buttons from
		// this list, so the steering cannot diverge between the two screens.
		expect(result["transitions"]).toEqual(["processing"]);
	});

	test("a service-offered state OUTSIDE the plugin's closed ORDER_STATES is never offered (DA-6)", async () => {
		// The ids are fixed at module load and an id this plugin never registered is
		// refused rather than dispatched, so a button for it could only ever refuse.
		// The React screen renders its transition buttons straight off this list.
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: {
						order: orderDetail(ORDER_ID),
						allowedTransitions: ["teleported", "completed"],
					},
				}),
			}),
		);

		const result = await invoke({ type: READ, resource: "orders.detail", orderId: ORDER_ID });
		expect(result["ok"]).toBe(true);
		expect(result["transitions"]).toEqual(["completed"]);
		// ...and it does not reach the client by any other route either.
		expect(JSON.stringify(result)).not.toContain("teleported");
	});

	test("a PROCESSING order is offered no bare `shipped` — it is steered to the Fulfilment form", async () => {
		// A bare `shipped` would ship without tracking and email the buyer an empty
		// shipped notice. The Fulfilment form records tracking and ships atomically,
		// so the transition button for it must not exist beside that form.
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: {
						order: { ...orderDetail(ORDER_ID), state: "processing" },
						allowedTransitions: ["shipped", "delivered"],
					},
				}),
			}),
		);

		const result = await invoke({ type: READ, resource: "orders.detail", orderId: ORDER_ID });
		expect(result["transitions"]).toEqual(["delivered"]);
	});

	test("a secondary surface failing degrades to null, never to a failed screen (E-1)", async () => {
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: { order: orderDetail(ORDER_ID), allowedTransitions: [] },
				}),
			}),
		);

		const result = await invoke({ type: READ, resource: "orders.detail", orderId: ORDER_ID });
		expect(result["ok"]).toBe(true);
		expect(result["refunds"]).toBeNull();
		expect(result["timeline"]).toBeNull();
		expect(result["customer"]).toBeNull();
		expect(result["notes"]).toEqual([]);
	});

	test("an unknown order is a refusal with copy, at HTTP 200 (G5)", async () => {
		service.respondWith("GET", () => ({ status: 404, body: {} }));
		const result = await invoke({ type: READ, resource: "orders.detail", orderId: OTHER_ID });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Order not found");
		expect(String(result["description"]).length).toBeGreaterThan(0);
	});

	test("an unreachable service fails CLOSED with the screen's own copy, and leaks nothing", async () => {
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Orders are unavailable");
		// E-7: it must not assert a cause it does not know. The last clause is
		// what stops a console bug being reported as an outage.
		expect(String(result["description"])).toContain("a fault in the console itself");
		// THIS PATH SWALLOWS EVERYTHING — an unreachable service, a 401 on the admin
		// token, a malformed response, and a bug in the console's own code. So the
		// copy must carry no status code, no upstream path and no auth detail: an
		// operator screenshotting a banner must not be publishing the shape of the
		// admin API, and naming one cause is false whenever another was the real one.
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

	test("a write is DISPATCHED to the extracted action, and its notice comes back", async () => {
		// The act branch, end to end. The watermark below (`state`) is re-read
		// against live truth by `orders-actions.ts`, and the refusal it produces for
		// a mismatch is what the console renders. What each action DECIDES is
		// covered by `orders-actions.sandbox.test.ts`; this asserts the wiring.
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: {
						order: { ...orderDetail(ORDER_ID), state: "processing" },
						allowedTransitions: [],
					},
				}),
			}),
		);

		const result = await invoke({
			type: ACT,
			action_id: "orders:transition-shipped",
			// The operator SAW `paid`; the live order is `processing`.
			value: { orderId: ORDER_ID, toState: "shipped", state: "paid" },
		});

		expect(result["ok"]).toBe(true);
		const notice = result["notice"] as Record<string, unknown>;
		expect(notice["variant"]).toBe("error");
		expect(notice["title"]).toBe("The order changed — nothing was applied");
		expect(String(notice["description"])).toContain("was paid when you started");
	});

	test("a write with no notice reports no notice, rather than inventing one", async () => {
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: { order: orderDetail(ORDER_ID), allowedTransitions: ["processing"] },
				}),
				[`/admin/orders/${ORDER_ID}/notes`]: () => ({ status: 200, body: { notes: [] } }),
			}),
		);
		service.respondWith("POST", () => ({ status: 200, body: { ok: true, transitioned: true } }));

		const result = await invoke({
			type: ACT,
			action_id: "orders:transition-processing",
			value: { orderId: ORDER_ID, toState: "processing", state: "paid" },
		});
		expect(result["ok"]).toBe(true);
		expect(result["notice"]).toBeNull();
	});

	test("a RECONCILIATION alert is never mistaken for the outcome of the write", async () => {
		// The alert is a property of the ORDER, not of what just happened —
		// reporting it as the outcome would tell an operator their status change
		// produced a settlement warning. It used to be separated from the notice by
		// keying on a rendered banner's variant; now the write simply returns its
		// own outcome and never sees the record's alerts at all. Kept because the
		// property is what matters, not the mechanism that used to deliver it.
		const flagged = { ...orderDetail(ORDER_ID), reconciliationFlag: "amount mismatch" };
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: { order: flagged, allowedTransitions: ["processing"] },
				}),
				[`/admin/orders/${ORDER_ID}/notes`]: () => ({ status: 200, body: { notes: [] } }),
			}),
		);
		service.respondWith("POST", () => ({ status: 200, body: { ok: true, transitioned: true } }));

		const result = await invoke({
			type: ACT,
			action_id: "orders:transition-processing",
			value: { orderId: ORDER_ID, toState: "processing", state: "paid" },
		});
		expect(result["notice"]).toBeNull();
	});

	test("an UNKNOWN action id is a refusal, not a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action. An id
		// this screen does not offer must never come back as an outcome: that would
		// render a refund that never happened as a silent success.
		const result = await invoke({
			type: ACT,
			action_id: "orders:no-such-action",
			value: { orderId: ORDER_ID },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
		expect(String(result["description"])).toContain("Nothing was applied");
	});

	test("a REGISTERED id whose write could not complete is also a refusal", async () => {
		// The service is unreachable, so nothing was appended. "Nothing came back"
		// is not "nothing to say".
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await invoke({
			type: ACT,
			action_id: "orders:add-note",
			value: { orderId: ORDER_ID, author: "ops", body: "hello" },
		});
		// Either a real refusal notice from the handler, or this branch's own —
		// never `{ok: true, notice: null}`, which would claim the note was saved.
		const quietSuccess = result["ok"] === true && result["notice"] === null;
		expect(quietSuccess, "a failed write reported as a quiet success").toBe(false);
	});
});
