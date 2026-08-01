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
 * this tier and replaces none of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CLEAR_FILTERS_LABEL,
	NOTHING_ON_PAGE,
	ORDERS_EMPTY,
	ORDERS_LIST_INTRO,
	ORDERS_NO_MATCH,
	SCAN_FURTHER,
	reconciliationAlertSentence,
} from "@otta-sh/admin-presentation";
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

/** The stub keys ONE responder per HTTP method, so routing is a function of the
 *  url — the same shape `orders-page.sandbox.test.ts` uses. Each test declares
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

	test("an unreachable service fails CLOSED with the screen's own copy", async () => {
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Orders are unavailable");
		// E-7: it must not assert a cause it does not know. The last clause is
		// what stops a console bug being reported as an outage.
		expect(String(result["description"])).toContain("a fault in the console itself");
	});

	test("an unrecognised resource is a refusal, not a blank body", async () => {
		const result = await invoke({ type: READ, resource: "orders.nope" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("That request could not be read");
	});

	test("a write is FORWARDED to the Block Kit handler, and its notice comes back", async () => {
		// The whole point of the act branch: no second implementation of a
		// money-moving path. The watermark below (`state`) is re-checked by
		// `orders-page.ts`'s own transition action, and the refusal it produces
		// for a mismatch is what the console renders.
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
		// `detailBlocks` emits at most two top-level banners: the notice, then the
		// reconciliation alert. The alert is a property of the ORDER, not of what
		// just happened — forwarding it would tell an operator their status change
		// produced a settlement warning. The extractor keys on the variant, which
		// a `Notice` never sets to "alert".
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
		// The Block Kit dispatcher answers an unrecognised id with `{blocks: []}` —
		// its house-style fall-through — which on this branch is indistinguishable
		// from "the write succeeded and had nothing to say". Reachable from a stale
		// tab after a deploy that renamed an action, and it would have rendered a
		// refund that never happened as a silent success.
		const result = await invoke({
			type: ACT,
			action_id: "orders:no-such-action",
			value: { orderId: ORDER_ID },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
		expect(String(result["description"])).toContain("Nothing was applied");
	});

	test("a REGISTERED id that renders nothing is also a refusal", async () => {
		// The service is unreachable for every read, so the Block Kit action bails
		// to a shape with no blocks. "Nothing came back" is not "nothing to say".
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

	test("BOTH SCREENS SAY THE SAME WORDS — the Block Kit render reads the shared copy", async () => {
		// THE CROSS-SURFACE PIN (INC-20 review). The React Orders screen imports
		// these constants; this asserts the BLOCK KIT screen renders them. Change
		// either side's wording without changing the constant and this fails —
		// which is the property the shared module exists to give, and the one a
		// pair of hand-copied strings could never have.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({ status: 200, body: { orders: [], nextCursor: null } }),
			}),
		);
		const result = await invoke({ type: "page_load", page: "/orders" });
		const blocks = result["blocks"] as Array<Record<string, unknown>>;
		const text = JSON.stringify(blocks);

		expect(text).toContain(ORDERS_LIST_INTRO);
		// Zero rows, unfiltered, first page, no cursor → outcome 2, the screen's
		// own `empty` copy and no `Clear filters`.
		expect(text).toContain(ORDERS_EMPTY.title);
		expect(text).toContain(ORDERS_EMPTY.description);
		expect(text).not.toContain(CLEAR_FILTERS_LABEL);
	});

	test("...and the same words for a filter that matches nothing", async () => {
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({ status: 200, body: { orders: [], nextCursor: null } }),
			}),
		);
		const result = await invoke({
			type: "form_submit",
			action_id: "orders:apply-filter",
			values: { status: "paid" },
		});
		const text = JSON.stringify(result["blocks"]);
		expect(text).toContain(ORDERS_NO_MATCH.title);
		expect(text).toContain(ORDERS_NO_MATCH.description);
		expect(text).toContain(CLEAR_FILTERS_LABEL);
	});

	test("...and the same scan note when a page remains behind a zero-row one", async () => {
		// Outcome 3 on the Block Kit side: no `empty` block at all, a `context`
		// line instead, so `Load more` survives. The React screen renders the same
		// sentence for the same reason.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({ status: 200, body: { orders: [], nextCursor: "cur-2" } }),
			}),
		);
		const result = await invoke({ type: "page_load", page: "/orders" });
		const blocks = result["blocks"] as Array<Record<string, unknown>>;
		const text = JSON.stringify(blocks);
		expect(text).toContain(`${NOTHING_ON_PAGE} ${SCAN_FURTHER}`);
		expect(blocks.some((block) => block["type"] === "empty")).toBe(false);
	});

	test("...and the same reconciliation sentence on the detail", async () => {
		const flagged = { ...orderDetail(ORDER_ID), reconciliationFlag: "amount mismatch" };
		service.respondWith(
			"GET",
			responder({
				[`/admin/orders/${ORDER_ID}`]: () => ({
					status: 200,
					body: { order: flagged, allowedTransitions: [] },
				}),
				[`/admin/orders/${ORDER_ID}/notes`]: () => ({ status: 200, body: { notes: [] } }),
			}),
		);
		const result = await invoke({
			type: "form_submit",
			action_id: "orders:open",
			values: { orderId: ORDER_ID },
		});
		expect(JSON.stringify(result["blocks"])).toContain(
			reconciliationAlertSentence("amount mismatch"),
		);
	});

	test("the BLOCK KIT screen is untouched by any of this", async () => {
		// ADR-0014 Decision 1: both screens render until the replacement is
		// proven. The console's interaction types are disjoint from EmDash's, so a
		// plain `page_load` must still produce the Block Kit Orders blocks —
		// header first, table present, and no console payload anywhere in it.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({
					status: 200,
					body: { orders: [orderSummary(ORDER_ID)], nextCursor: null },
				}),
			}),
		);
		const result = await invoke({ type: "page_load", page: "/orders" });
		const blocks = result["blocks"] as Array<Record<string, unknown>>;
		expect(blocks[0]).toMatchObject({ type: "header", text: "Orders" });
		expect(blocks.some((block) => block["type"] === "table")).toBe(true);
		expect(result["vocabulary"]).toBeUndefined();
		expect(result["ok"]).toBeUndefined();
	});
});
