/**
 * The Orders WRITE path, exercised INSIDE the workerd sandbox (INC-R2).
 *
 * WHY A SANDBOX SUITE AND NOT A UNIT TEST. ADR-0006 Decision 1, reaffirmed by
 * ADR-0014 and again by ADR-0015: the workerd suites are the contract gate for
 * `@otta-sh/plugin`, and "a change that only works trusted is still broken". This
 * suite therefore drives the writes the way the React console does — one POST to
 * the plugin's single `admin` route, `type: "otta_console_act"`, an action id and
 * a flat payload — inside the isolate the plugin is specified to run in.
 *
 * WHAT IT REPLACES. `orders-page.sandbox.test.ts` was 4,035 lines, and the bulk of
 * it asserted the retired Block Kit screen's RENDERING: block order, accordion
 * keys and labels, which group `default_open` resolves to, table columns, picker
 * options, confirm dialogs, `context` wording, the `meter`, the `select` option
 * vocabularies, badge suppression, the fail-closed banner's shape. None of that
 * outlives the renderer. Everything asserting BEHAVIOUR moved here.
 *
 * THE STALE-WATERMARK REFUSAL IS THE GATE (ADR-0015 Decision 3, as amended), and
 * it is proven on every write that carries a watermark: `THE REFUSAL — a refund
 * whose watermark no longer matches applies NOTHING` for the refund ledger,
 * `DA-3a: a cancel whose observed state no longer matches`, and `DA-3a: a
 * transition whose observed state no longer matches`. Its absent-watermark half —
 * refuse, do not re-read, do not tolerate — is `DA-3a is not opt-out` and the
 * unreadable-payload cases beside it.
 *
 * WHAT IS NO LONGER TESTED HERE, AND WHY THAT IS NOT A GAP. THREE checks went with
 * the deleted `-review` pair: the two further refusals ADR-0015 DECISION 3 names —
 * the DA-3c live-ceiling bound check and the unparseable-amount refusal — and the
 * `REFUND_BY_REQUIRED` attribution guard, which Decision 3 never named because it
 * was never one of its three. All three lived ONLY on `orders:refund-review`,
 * which no surface ever called; the ids and all three checks are deleted, so there
 * is no behaviour left for a test to pin. Refund attribution is now enforced on
 * the client alone — see ADR-0015's amendment, which records where that
 * enforcement has a hole. The reachable confirm's own money validation — integer
 * minor units, a positive amount, no float laundered into cents — is `M-3/B-2`
 * below and stays, as does the service's over-refund refusal
 * (`REFUND_EXCEEDS_TOTAL`).
 *
 * A green happy path is not evidence for any of this, so every refusal test also
 * asserts that NO POST was made.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { REFUND_TOO_HIGH_TITLE } from "@otta-sh/admin-presentation";
import { ORDERS_ACTION_IDS } from "../src/admin/orders-actions.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

const ACT = "otta_console_act";
const ORDER_ID = "ord-1";
const ADMIN_TOKEN = "admin-token-xyz";

interface Notice {
	variant: string;
	title: string;
	description: string;
}
interface ActOutcome {
	ok?: boolean;
	title?: string;
	description?: string;
	notice?: Notice | null;
}

/** The order as the stub serves it. `state` is what a watermark is compared
 *  against, so every DA-3a test moves exactly this. */
function order(state = "paid"): Record<string, unknown> {
	return {
		id: ORDER_ID,
		state,
		currency: "USD",
		paymentMethod: "card",
		buyerRef: "alice@example.com",
		customerId: null,
		createdAt: "2026-07-08T10:30:00.000Z",
		reconciliationFlag: null,
		reconciliationResolution: null,
		fulfillment: null,
		cancellation: null,
		shippingAddress: null,
		totals: {
			currency: "USD",
			subtotalCents: 1500,
			discountCents: 0,
			shippingCents: 0,
			taxCents: 0,
			totalCents: 1500,
			appliedCouponCode: null,
		},
		lines: [],
	};
}

/** $5.00 already refunded of a $15.00 capture, so $10.00 remains. The watermark
 *  an honest payload carries is therefore `500`, and the live ceiling is `1000`. */
function refundsSummary(refundedTotalCents = 500): Record<string, unknown> {
	return {
		refunds: [],
		currency: "USD",
		capturedTotalCents: 1500,
		refundedTotalCents,
		ceilingCents: 1500,
		remainingCents: 1500 - refundedTotalCents,
		paymentMethod: "card",
		refundable: true,
	};
}

/** One request header, case-insensitively. */
function header(
	request: { headers: Record<string, string | string[] | undefined> } | undefined,
	name: string,
): string | undefined {
	const value = request?.headers[name.toLowerCase()];
	return typeof value === "string" ? value : undefined;
}

describe("the Orders write path (workerd sandbox)", () => {
	let service: StubCommerceServer;
	let sandbox: SandboxHandle;

	/** GET routing is a function of the path, so a surface this write is not
	 *  supposed to read 404s — which is itself part of every assertion. */
	let orderState = "paid";
	let refundedSoFar = 500;

	beforeEach(async () => {
		orderState = "paid";
		refundedSoFar = 500;
		service = await startStubCommerceServer();
		service.respondWith("GET", (request) => {
			const path = request.url.split("?")[0] ?? "";
			if (path === `/admin/orders/${ORDER_ID}`) {
				return { status: 200, body: { order: order(orderState), allowedTransitions: [] } };
			}
			if (path === `/admin/orders/${ORDER_ID}/refunds`) {
				return { status: 200, body: refundsSummary(refundedSoFar) };
			}
			return { status: 404, body: { error: "no route" } };
		});
		service.respondWith("POST", () => ({
			status: 200,
			body: {
				ok: true,
				transitioned: true,
				resolved: true,
				recorded: true,
				cancelled: true,
				appended: true,
				duplicate: false,
				fullyRefunded: false,
				note: { author: "ops", body: "hello", createdAt: "2026-07-08T10:30:00.000Z" },
			},
		}));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [service.host],
			commerceServiceBaseUrl: service.baseUrl,
		});
		// The admin token rides every write; seeding it here is what lets each test
		// assert the header rather than assume it.
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: ADMIN_TOKEN },
		});
		service.requests.length = 0;
	});

	afterEach(async () => {
		await sandbox.close();
		await service.close();
	});

	/** One console write, exactly as `performAction` sends it. */
	async function act(actionId: string, value: Record<string, string>): Promise<ActOutcome> {
		const outcome = await sandbox.invokeRoute("admin", {
			type: ACT,
			action_id: actionId,
			value,
		});
		expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
		return (outcome as { result: ActOutcome }).result;
	}

	const posts = (): typeof service.requests => service.requests.filter((r) => r.method === "POST");
	const postTo = (suffix: string): (typeof service.requests)[number] | undefined =>
		posts().find((r) => r.url === `/admin/orders/${ORDER_ID}${suffix}`);

	// -- the dispatch gate ------------------------------------------------------

	test("an UNKNOWN action id is a refusal with copy, never a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action, and from
		// a console bug — never from a control this release rendered. Reporting it as
		// an outcome would render a refund that never happened as done.
		const result = await act("orders:no-such-action", { orderId: ORDER_ID });
		expect(result.ok).toBe(false);
		expect(result.title).toBe("Nothing was changed");
		expect(String(result.description)).toContain("Nothing was applied");
		expect(posts()).toHaveLength(0);
	});

	test("EVERY id in ORDERS_ACTION_IDS dispatches — the gate and the table cannot disagree", async () => {
		// The combination that used to blank a console: a control rendered for an id
		// the dispatcher does not know. The set is read straight off the dispatch
		// table, and this drives every member to prove it.
		// 5 named + one per order state + one per ONE-CLICK cancellation reason.
		// `other` has no one-click control, so it derives no id (and the deleted
		// `-review` pair derives none either).
		expect(ORDERS_ACTION_IDS.size).toBe(5 + 10 + 4);
		expect(ORDERS_ACTION_IDS.has("orders:cancel-other")).toBe(false);
		expect(ORDERS_ACTION_IDS.has("orders:cancel-review")).toBe(false);
		expect(ORDERS_ACTION_IDS.has("orders:refund-review")).toBe(false);
		for (const actionId of ORDERS_ACTION_IDS) {
			const result = await act(actionId, {});
			// No order id, so each one refuses as unreadable — but it REFUSES, which
			// only a registered id can do. An unregistered one answers `ok: false`.
			expect(result.ok, actionId).toBe(true);
		}
	});

	// -- transitions ------------------------------------------------------------

	test("a transition POSTs with a content-derived Idempotency-Key and both tokens", async () => {
		const result = await act("orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "processing",
			state: "paid",
		});
		const post = postTo("/transition");
		expect(post).toBeDefined();
		expect(post?.body).toEqual({ toState: "processing" });
		// F-2a: content-derived, never a nonce.
		expect(header(post, "Idempotency-Key")).toBe(`admin-transition:${ORDER_ID}:processing`);
		expect(header(post, "X-Internal-Token")).toBe(ADMIN_TOKEN);
		expect(result.notice).toBeNull();
	});

	test("the target state comes from the ACTION ID, never from the operator-alterable payload", async () => {
		// DA-6 item 4: `toState` in the payload is a lie an operator can tell.
		await act("orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "refunded",
			state: "paid",
		});
		expect(postTo("/transition")?.body).toEqual({ toState: "processing" });
	});

	test("DA-3a: a transition whose observed state no longer matches applies NOTHING and names both states", async () => {
		orderState = "processing";
		const result = await act("orders:transition-shipped", {
			orderId: ORDER_ID,
			toState: "shipped",
			state: "paid",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("The order changed — nothing was applied");
		expect(result.notice?.description).toContain("was paid when you started");
		expect(result.notice?.description).toContain("is now processing");
	});

	test("DA-3a is not opt-out: a transition payload with the watermark STRIPPED refuses instead of writing unchecked", async () => {
		// An absent watermark has two sources — a payload edited in devtools, or a
		// tab rendered before the watermark existed — and refusing is right for both.
		// The refusal happens BEFORE the re-read, because no re-read can supply a
		// watermark the operator never sent.
		for (const state of [undefined, "", "   "]) {
			service.requests.length = 0;
			const result = await act("orders:transition-processing", {
				orderId: ORDER_ID,
				toState: "processing",
				...(state === undefined ? {} : { state }),
			});
			expect(service.requests, JSON.stringify(state)).toHaveLength(0);
			expect(result.notice?.title).toBe("That action could not be read");
		}
	});

	test("a no-op transition (ok but transitioned:false) reports a NON-error notice", async () => {
		service.respondWith("POST", () => ({ status: 200, body: { ok: true, transitioned: false } }));
		const result = await act("orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "processing",
			state: "paid",
		});
		expect(result.notice?.variant).toBe("default");
		expect(result.notice?.title).toBe("No change");
	});

	test("an order that cannot be re-read before a transition applies nothing", async () => {
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await act("orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "processing",
			state: "paid",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice?.title).toBe("Nothing was changed");
	});

	// -- notes ------------------------------------------------------------------

	test("add-note POSTs with a content-derived Idempotency-Key and the admin token", async () => {
		// REGRESSION GUARD. Until this increment the console's note, resolve and
		// fulfilment writes carried their order id in a flat payload while the Block
		// Kit handler they were forwarded to read it from a `block_id` carrier the
		// console never sent — so all three answered "That action could not be read"
		// and made no request at all. The extraction is what closes that.
		const result = await act("orders:add-note", {
			orderId: ORDER_ID,
			author: "ops",
			body: "hello",
		});
		const post = postTo("/notes");
		expect(post).toBeDefined();
		expect(post?.body).toEqual({ author: "ops", body: "hello" });
		expect(header(post, "Idempotency-Key")).toBe(`admin-note:${ORDER_ID}:ops:hello`);
		expect(header(post, "X-Internal-Token")).toBe(ADMIN_TOKEN);
		expect(result.notice).toBeNull();
	});

	test("add-note replays: the SAME note derives the SAME key, and a not-appended reply says so", async () => {
		await act("orders:add-note", { orderId: ORDER_ID, author: "ops", body: "hello" });
		const first = header(postTo("/notes"), "Idempotency-Key");
		service.requests.length = 0;
		service.respondWith("POST", () => ({
			status: 200,
			body: {
				ok: true,
				appended: false,
				note: { author: "ops", body: "hello", createdAt: "2026-07-08T10:30:00.000Z" },
			},
		}));
		const replay = await act("orders:add-note", {
			orderId: ORDER_ID,
			author: "ops",
			body: "hello",
		});
		expect(header(postTo("/notes"), "Idempotency-Key")).toBe(first);
		expect(replay.notice?.variant).toBe("default");
		expect(replay.notice?.title).toBe("Already added");
	});

	test("add-note with a blank author or body refuses inline and makes NO POST", async () => {
		for (const values of [
			{ author: "", body: "hello" },
			{ author: "ops", body: "   " },
		]) {
			service.requests.length = 0;
			const result = await act("orders:add-note", { orderId: ORDER_ID, ...values });
			expect(posts()).toHaveLength(0);
			expect(result.notice?.variant).toBe("error");
			expect(result.notice?.title).toBe("Note not added");
		}
	});

	// -- reconciliation ---------------------------------------------------------

	test("resolve POSTs the disposition WITH the flag as displayed", async () => {
		// The service compare-and-clears on `expectedFlag`, so a new anomaly raised
		// mid-review conflicts instead of being cleared blind.
		const result = await act("orders:resolve-reconciliation", {
			orderId: ORDER_ID,
			expectedFlag: "amount mismatch",
			outcome: "written_off",
			reason: "false alarm",
			resolvedBy: "carol",
		});
		const post = postTo("/resolve-reconciliation");
		expect(post?.body).toEqual({
			expectedFlag: "amount mismatch",
			outcome: "written_off",
			reason: "false alarm",
			resolvedBy: "carol",
		});
		expect(header(post, "Idempotency-Key")).toBe(`admin-resolve-reconciliation:${ORDER_ID}`);
		expect(result.notice?.title).toBe("Reconciliation resolved");
	});

	test("a STALE flag gets its own copy — nothing was cleared, review the new one", async () => {
		service.respondWith("POST", () => ({
			status: 409,
			body: { ok: false, reason: "RECONCILIATION_FLAG_CHANGED" },
		}));
		const result = await act("orders:resolve-reconciliation", {
			orderId: ORDER_ID,
			expectedFlag: "amount mismatch",
			outcome: "written_off",
			reason: "false alarm",
			resolvedBy: "carol",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("The reconciliation state changed — reload");
		expect(String(result.notice?.description)).toContain("Nothing was cleared");
		// E-7: never a raw status or URL.
		expect(String(result.notice?.description)).not.toMatch(/HTTP \d|409|\/admin\//);
	});

	test("resolve with a blank reason or resolver refuses inline and makes NO POST", async () => {
		for (const values of [
			{ reason: "", resolvedBy: "carol" },
			{ reason: "false alarm", resolvedBy: " " },
		]) {
			service.requests.length = 0;
			const result = await act("orders:resolve-reconciliation", {
				orderId: ORDER_ID,
				expectedFlag: "amount mismatch",
				outcome: "written_off",
				...values,
			});
			expect(posts()).toHaveLength(0);
			expect(result.notice?.title).toBe("Not resolved");
		}
	});

	// -- fulfilment -------------------------------------------------------------

	test("record-fulfillment POSTs the tracking, normalising the shipped day to an instant", async () => {
		const result = await act("orders:record-fulfillment", {
			orderId: ORDER_ID,
			carrier: "UPS",
			trackingNumber: "1Z999",
			trackingUrl: "https://ups.example/1Z999",
			shippedAt: "2026-07-08",
			recordedBy: "carol",
		});
		const post = postTo("/fulfillment");
		expect(post?.body).toEqual({
			carrier: "UPS",
			trackingNumber: "1Z999",
			trackingUrl: "https://ups.example/1Z999",
			// A date field yields a DAY; the service wants a full ISO instant, and a
			// day given as a shipping moment is the start of that day.
			shippedAt: "2026-07-08T00:00:00.000Z",
			recordedBy: "carol",
		});
		expect(header(post, "Idempotency-Key")).toBe(`admin-record-fulfillment:${ORDER_ID}`);
		expect(result.notice?.title).toBe("Order shipped");
	});

	test("a non-http(s) tracking URL is refused before it can be emailed to a buyer", async () => {
		// Defense in depth: the service schema enforces the same bound, and this
		// value reaches a buyer's inbox, so a `javascript:`/`data:` URI never leaves
		// the plugin.
		for (const trackingUrl of ["javascript:alert(1)", "data:text/html,x", "ftp://x/y"]) {
			service.requests.length = 0;
			const result = await act("orders:record-fulfillment", {
				orderId: ORDER_ID,
				carrier: "UPS",
				trackingNumber: "1Z999",
				trackingUrl,
				recordedBy: "carol",
			});
			expect(posts(), trackingUrl).toHaveLength(0);
			expect(result.notice?.title).toBe("Not shipped");
			expect(String(result.notice?.description)).toContain("http://");
		}
	});

	test("record-fulfillment with any required field blank refuses inline and makes NO POST", async () => {
		for (const values of [
			{ carrier: "", trackingNumber: "1Z999", recordedBy: "carol" },
			{ carrier: "UPS", trackingNumber: " ", recordedBy: "carol" },
			{ carrier: "UPS", trackingNumber: "1Z999", recordedBy: "" },
		]) {
			service.requests.length = 0;
			const result = await act("orders:record-fulfillment", { orderId: ORDER_ID, ...values });
			expect(posts()).toHaveLength(0);
			expect(result.notice?.title).toBe("Not shipped");
		}
	});

	test("a NOT_FULFILLABLE order gets copy naming the state, not the status code", async () => {
		service.respondWith("POST", () => ({
			status: 409,
			body: { ok: false, reason: "NOT_FULFILLABLE" },
		}));
		const result = await act("orders:record-fulfillment", {
			orderId: ORDER_ID,
			carrier: "UPS",
			trackingNumber: "1Z999",
			recordedBy: "carol",
		});
		expect(result.notice?.title).toBe("Order can’t be shipped right now");
		expect(String(result.notice?.description)).not.toMatch(/HTTP \d|409|\/admin\//);
	});

	// -- cancellation -----------------------------------------------------------

	test("a per-reason cancel re-reads the order, then POSTs with the content-derived key", async () => {
		const result = await act("orders:cancel-out_of_stock", {
			orderId: ORDER_ID,
			reason: "out_of_stock",
			state: "paid",
		});
		const post = postTo("/cancel");
		expect(post?.body).toEqual({ reason: "out_of_stock", cancelledBy: "admin" });
		expect(header(post, "Idempotency-Key")).toBe(`admin-cancel:${ORDER_ID}`);
		expect(result.notice?.title).toBe("Order cancelled");
	});

	test("DA-3a: a cancel whose observed state no longer matches applies NOTHING and names both states", async () => {
		orderState = "shipped";
		const result = await act("orders:cancel", {
			orderId: ORDER_ID,
			reason: "out_of_stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
			state: "paid",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice?.title).toBe("The order changed — nothing was cancelled");
		expect(result.notice?.description).toContain("was paid when you started");
		expect(result.notice?.description).toContain("is now shipped");
	});

	test("a cancel reason outside the closed set, or a missing watermark, is an unreadable payload", async () => {
		const cases: Record<string, string>[] = [
			{ orderId: ORDER_ID, reason: "because", state: "paid" },
			{ orderId: ORDER_ID, reason: "out_of_stock" },
		];
		for (const value of cases) {
			service.requests.length = 0;
			const result = await act("orders:cancel", value);
			expect(service.requests).toHaveLength(0);
			expect(result.notice?.title).toBe("That action could not be read");
		}
	});

	test("a NOT_CANCELLABLE order gets copy that offers no retry", async () => {
		service.respondWith("POST", () => ({
			status: 409,
			body: { ok: false, reason: "NOT_CANCELLABLE" },
		}));
		const result = await act("orders:cancel-fraud_suspected", {
			orderId: ORDER_ID,
			reason: "fraud_suspected",
			state: "paid",
		});
		// The write was ATTEMPTED, so this is an outcome to read rather than an input
		// to correct — a prefilled retry would promise something no longer possible.
		expect(result.notice?.title).toBe("Order can’t be cancelled right now");
	});

	// -- refunds: THE GATE ------------------------------------------------------

	test("THE REFUSAL — a refund whose watermark no longer matches applies NOTHING", async () => {
		// The genuinely CONCURRENT case: the ledger moved between the confirm being
		// drawn and this click. This is now the ONLY server-side window checked on a
		// refund, so it carries the whole of DA-3a for the money path.
		refundedSoFar = 900;
		const result = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			reason: "",
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(result.notice?.description).toContain("someone else refunded this order");
		// The copy names BOTH figures and the CAUSE — "the ledger changed" alone
		// states an effect and leaves the operator to guess whether they hit a bug.
		expect(result.notice?.description).toContain("$5.00 was staged");
		expect(result.notice?.description).toContain("$6.00 now remains refundable");
		expect(String(result.notice?.description).length).toBeLessThanOrEqual(240);
	});

	test("F-2a: the refund key is `admin-refund:<order>:<amount>:<watermark>` — content plus the OBSERVED watermark, never a nonce", async () => {
		const result = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
		const post = postTo("/refund");
		expect(post?.body).toEqual({
			amountCents: 500,
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(header(post, "Idempotency-Key")).toBe(`admin-refund:${ORDER_ID}:500:500`);
		expect(header(post, "X-Internal-Token")).toBe(ADMIN_TOKEN);
		expect(result.notice?.title).toBe("Refund recorded");
	});

	test("F-2a: the SAME click twice derives the SAME key, and the replay reads `Already refunded`", async () => {
		const value = {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		};
		await act("orders:refund", value);
		const first = header(postTo("/refund"), "Idempotency-Key");
		service.requests.length = 0;
		service.respondWith("POST", () => ({
			status: 200,
			body: { ok: true, recorded: true, duplicate: true, fullyRefunded: false },
		}));
		const replay = await act("orders:refund", value);
		expect(header(postTo("/refund"), "Idempotency-Key")).toBe(first);
		expect(replay.notice?.variant).toBe("default");
		expect(replay.notice?.title).toBe("Already refunded");
	});

	test("F-2a, THE POSITIVE CASE: two DELIBERATE identical refunds derive DIFFERENT keys, so both apply", async () => {
		// This is what the watermark buys, and why a render-time nonce cannot
		// replace it: the domain resolves a refund by key ALONE with no amount
		// comparison, so a reused key for a different intent reports money that
		// never moved as already refunded.
		await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		});
		const first = header(postTo("/refund"), "Idempotency-Key");
		// The first refund moved the ledger, so the operator's next view carries a
		// new watermark — and the same amount against it is a different key.
		refundedSoFar = 1000;
		service.requests.length = 0;
		await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "1000",
			currency: "USD",
			refundedBy: "carol",
		});
		const second = header(postTo("/refund"), "Idempotency-Key");
		expect(first).toBe(`admin-refund:${ORDER_ID}:500:500`);
		expect(second).toBe(`admin-refund:${ORDER_ID}:500:1000`);
		expect(second).not.toBe(first);
	});

	test("DA-3b: each of the FOUR disjuncts of an unreadable confirm refuses and makes NO request", async () => {
		// A payload can carry a perfectly good `amountCents` and still be unreadable
		// because the WATERMARK or the CURRENCY is missing. None of the four is
		// fixable by re-typing the amount, so all four take the payload-level
		// refusal — and, critically, none of them reaches the service.
		const cases: Record<string, string>[] = [
			// watermark missing, amount fine
			{ amountCents: "1000", currency: "USD" },
			// currency missing, amount fine
			{ amountCents: "1000", refundedSoFarCents: "500" },
			// amount not a positive integer of minor units
			{ amountCents: "0", refundedSoFarCents: "500", currency: "USD" },
			{ amountCents: "-100", refundedSoFarCents: "500", currency: "USD" },
			{ amountCents: "not-a-number", refundedSoFarCents: "500", currency: "USD" },
		];
		for (const value of cases) {
			service.requests.length = 0;
			const result = await act("orders:refund", {
				orderId: ORDER_ID,
				reason: "damaged",
				refundedBy: "carol",
				...value,
			});
			expect(service.requests, JSON.stringify(value)).toHaveLength(0);
			expect(result.notice?.title, JSON.stringify(value)).toBe("That action could not be read");
		}
	});

	test("the service's own 409 REFUND_EXCEEDS_TOTAL is the over-refund guard — nothing else bounds the amount", async () => {
		// There is no client-side ceiling check on this path: the one that existed
		// lived on the deleted `-review` step and no surface ever called it. So an
		// over-ceiling amount that clears the watermark compare reaches the service,
		// and the SERVICE refuses it. This test is that guarantee.
		service.respondWith("POST", () => ({
			status: 409,
			body: { ok: false, reason: "REFUND_EXCEEDS_TOTAL" },
		}));
		const result = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "9999",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(1);
		// The SAME title the client-side ceiling check raises — an operator reading
		// two titles for one refusal has to work out whether they hit two limits.
		expect(result.notice?.title).toBe(REFUND_TOO_HIGH_TITLE);
		expect(String(result.notice?.description)).not.toMatch(/HTTP \d|409|\/admin\//);
	});

	test("an ambiguous gateway timeout tells the operator NOT to retry, and offers no retry affordance", async () => {
		service.respondWith("POST", () => ({
			status: 504,
			body: { ok: false, reason: "GATEWAY_UNVERIFIED" },
		}));
		const result = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(result.notice?.title).toBe("Refund status unknown");
		expect(String(result.notice?.description)).toContain("Do NOT retry");
	});

	test("a fully-refunding refund says so, and an unreachable ledger applies nothing", async () => {
		service.respondWith("POST", () => ({
			status: 200,
			body: { ok: true, recorded: true, duplicate: false, fullyRefunded: true },
		}));
		const full = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "1000",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(full.notice?.title).toBe("Refund complete");

		service.respondWith("GET", () => ({ status: 500, body: {} }));
		service.requests.length = 0;
		const unreadable = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(0);
		expect(unreadable.notice?.title).toBe("Nothing was refunded");
	});

	// -- money never crosses this boundary as a float ---------------------------

	test("M-3/B-2: a payload's minor units must be a plain integer string — no float is ever laundered into cents", async () => {
		for (const amountCents of ["5.00", "1e3", " 500", "+500", "0x1f", "9007199254740993"]) {
			service.requests.length = 0;
			const result = await act("orders:refund", {
				orderId: ORDER_ID,
				amountCents,
				refundedSoFarCents: "500",
				currency: "USD",
				refundedBy: "carol",
			});
			expect(service.requests, amountCents).toHaveLength(0);
			expect(result.notice?.title, amountCents).toBe("That action could not be read");
		}
	});
});
