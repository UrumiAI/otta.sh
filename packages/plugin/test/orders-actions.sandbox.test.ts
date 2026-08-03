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
 * THE THREE REFUSALS ARE THE GATE (ADR-0015 §1, Decision 3), and each has a test
 * that names it:
 *
 *  1. **Stale watermark (DA-3a)** — `refunds: the confirm REFUSES when the ledger
 *     moved`, plus the same check at the review step, on cancels and on
 *     transitions. Its absent-watermark half is `DA-3a is not opt-out`.
 *  2. **Refund ceiling (DA-3c)** — `refund-review BOUND-CHECKS against the live
 *     ceiling`, and `the watermark compare runs BEFORE the bound check` pins the
 *     ORDER the two run in.
 *  3. **Unparseable amount** — `an unparseable amount refuses and the draft carries
 *     the raw text VERBATIM`.
 *
 * A green happy path is not evidence for any of them, so every refusal test also
 * asserts that NO POST was made.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	REFUND_AMOUNT_INVALID,
	REFUND_BY_REQUIRED,
	REFUND_TOO_HIGH_TITLE,
} from "@otta-sh/admin-presentation";
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
	staged?: Record<string, unknown>;
	draft?: Record<string, unknown>;
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
		expect(ORDERS_ACTION_IDS.size).toBe(7 + 10 + 5);
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

	test("DA-3a: a cancel whose observed state no longer matches applies NOTHING, names both states, and hands the typed detail back", async () => {
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
		// Nothing was written and the operator's typing is in hand, so discarding it
		// would make the safe path the expensive one.
		expect(result.draft).toEqual({
			kind: "cancel-draft",
			reasonInput: "Out of stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
		});
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
			expect((result.draft as { kind?: string } | undefined)?.kind).toBe("cancel-draft");
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
		expect(result.notice?.title).toBe("Order can’t be cancelled right now");
		// The write was ATTEMPTED, so this is an outcome to read rather than an input
		// to correct — a prefilled retry would promise something no longer possible.
		expect(result.draft).toBeUndefined();
	});

	test("DA-3: cancel-review stages the free text against a FRESHLY confirmed watermark and writes nothing", async () => {
		const result = await act("orders:cancel-review", {
			orderId: ORDER_ID,
			// The review step takes the reason in OPTION-VALUE space — the human
			// label — and maps it back to the wire value.
			reason: "Out of stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
			state: "paid",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice).toBeNull();
		expect(result.staged).toEqual({
			kind: "cancel-staged",
			reason: "out_of_stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
			state: "paid",
		});
	});

	test("DA-3c: cancel-review re-reads too, so state 2 never stages a confirm the write would already refuse", async () => {
		orderState = "shipped";
		const result = await act("orders:cancel-review", {
			orderId: ORDER_ID,
			reason: "Out of stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
			state: "paid",
		});
		expect(posts()).toHaveLength(0);
		expect(result.staged).toBeUndefined();
		expect(result.notice?.title).toBe("The order changed — nothing was staged");
		expect(result.draft).toEqual({
			kind: "cancel-draft",
			reasonInput: "Out of stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
		});
	});

	test("DA-3a has NO `-review` exemption: a review with no watermark stages NOTHING and does not even re-read", async () => {
		// Re-stamping a fresh watermark here would launder the window it skipped —
		// the operator chose a reason while looking at some state, and a fresh stamp
		// asserts one they never saw, after which the confirm's own check passes
		// trivially. So the refusal comes before any read.
		const result = await act("orders:cancel-review", {
			orderId: ORDER_ID,
			reason: "Out of stock",
			cancelledBy: "carol",
		});
		expect(service.requests).toHaveLength(0);
		expect(result.staged).toBeUndefined();
		expect(result.notice?.title).toBe("That action could not be read");
	});

	test("cancel-review with an unmapped reason or a blank canceller stages nothing", async () => {
		for (const value of [
			{ orderId: ORDER_ID, reason: "out_of_stock", cancelledBy: "carol", state: "paid" },
			{ orderId: ORDER_ID, reason: "Out of stock", cancelledBy: "", state: "paid" },
		]) {
			service.requests.length = 0;
			const result = await act("orders:cancel-review", value);
			expect(posts()).toHaveLength(0);
			expect(result.staged).toBeUndefined();
			expect(result.notice?.title).toBe("Not cancelled");
		}
	});

	// -- refunds: THE GATE ------------------------------------------------------

	test("REFUSAL 3 — an unparseable amount refuses and the draft carries the RAW TEXT verbatim", async () => {
		// The most frequent refusal on this screen is a typo in the amount field, and
		// it is the one where nothing can be re-derived: `parseMinorUnitsInput`
		// returned `null`, so there IS no `amountCents`, and a rejected `19,99`
		// cannot be reconstructed from minor units. Money is integer minor units;
		// a refusal that silently reformats what someone typed is a worse failure
		// than the one it reports.
		for (const amount of ["0", "abc", "19,99", "12.345", "-5.00"]) {
			service.requests.length = 0;
			const result = await act("orders:refund-review", {
				orderId: ORDER_ID,
				currency: "USD",
				refundedSoFar: "500",
				amount,
				reason: "damaged",
				refundedBy: "carol",
			});
			expect(posts(), amount).toHaveLength(0);
			expect(result.staged, amount).toBeUndefined();
			expect(result.notice?.variant).toBe("error");
			expect(result.notice?.title).toBe("Not refunded");
			expect(result.notice?.description).toBe(REFUND_AMOUNT_INVALID);
			expect(result.draft, `draft for ${amount}`).toEqual({
				kind: "refund-draft",
				amountInput: amount,
				reason: "damaged",
				refundedBy: "carol",
			});
		}
		// A blank amount refuses too, and there is nothing to put back for it.
		const blank = await act("orders:refund-review", {
			orderId: ORDER_ID,
			currency: "USD",
			refundedSoFar: "500",
			amount: "  ",
			refundedBy: "carol",
		});
		expect((blank.draft as { amountInput?: string } | undefined)?.amountInput).toBe("");
	});

	test("REFUSAL 2 — refund-review BOUND-CHECKS against the LIVE ceiling and names the real figure", async () => {
		// An extra zero is the likeliest typo on a money field. Without the bound
		// check this staged a red `Refund $99.99` and a dialog reading "Refund $99.99
		// to …?" — BOTH FALSE at the exact moment they were shown, on the one step
		// that exists to let an operator check exactly that.
		const result = await act("orders:refund-review", {
			orderId: ORDER_ID,
			currency: "USD",
			refundedSoFar: "500", // matches live, so DA-3a passes and DA-3c is what fires
			amount: "99.99", // 9999 > the live remaining 1000
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(0);
		expect(result.staged).toBeUndefined();
		expect(result.notice?.title).toBe(REFUND_TOO_HIGH_TITLE);
		expect(result.notice?.title).toBe("Amount too high");
		// The refusal names THE REAL FIGURE, not just "too high".
		expect(result.notice?.description).toBe(
			"$99.99 is more than the $10.00 that remains refundable on this order. Enter $10.00 or less.",
		);
		expect(String(result.notice?.description).length).toBeLessThanOrEqual(240);
		// Prefilled VERBATIM so the operator can delete the extra zero.
		expect((result.draft as { amountInput?: string } | undefined)?.amountInput).toBe("99.99");
	});

	test("REFUSAL 1 — refund-review refuses when the ledger moved, naming both figures AND the cause", async () => {
		refundedSoFar = 900; // someone else refunded $4.00 since the form rendered
		const result = await act("orders:refund-review", {
			orderId: ORDER_ID,
			currency: "USD",
			refundedSoFar: "500",
			amount: "5.00",
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(0);
		expect(result.staged).toBeUndefined();
		expect(result.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		// The CAUSAL CLAUSE is not optional: "the ledger changed" states an effect and
		// leaves the operator to guess whether they hit a bug.
		expect(result.notice?.description).toContain("someone else refunded this order");
		expect(result.notice?.description).toContain("$5.00 was staged");
		expect(result.notice?.description).toContain("$6.00 now remains refundable");
		expect((result.draft as { amountInput?: string } | undefined)?.amountInput).toBe("5.00");
	});

	test("THE ORDER OF THE TWO: the watermark compare runs BEFORE the bound check", async () => {
		// Both would fire — the ledger moved AND $99.99 is over the new remaining
		// $6.00. The movement refusal wins, because its copy already names the new
		// remaining balance and the bound check must only ever quote a ceiling the
		// operator has now been shown.
		refundedSoFar = 900;
		const result = await act("orders:refund-review", {
			orderId: ORDER_ID,
			currency: "USD",
			refundedSoFar: "500",
			amount: "99.99",
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(result.notice?.title).not.toBe(REFUND_TOO_HIGH_TITLE);
	});

	test("DA-3b: a review whose payload lost its watermark refuses as UNREADABLE, never as a bad amount", async () => {
		// `refundedSoFar` and `currency` come off the payload's carrier half; `amount`
		// comes off the operator's keyboard. Folded together, this branch answered
		// `5.00` with "Enter a valid refund amount…" over a field still reading
		// `5.00` — naming a cause that is checkably not the cause.
		const cases: Record<string, string>[] = [
			{ orderId: ORDER_ID, currency: "USD", amount: "5.00", refundedBy: "carol" },
			{ orderId: ORDER_ID, refundedSoFar: "500", amount: "5.00", refundedBy: "carol" },
		];
		for (const value of cases) {
			service.requests.length = 0;
			const result = await act("orders:refund-review", { ...value, reason: "damaged" });
			expect(service.requests).toHaveLength(0);
			expect(result.staged).toBeUndefined();
			expect(result.notice?.title).toBe("That action could not be read");
			expect(String(result.notice?.description)).not.toMatch(/refund amount|19\.99/i);
			expect(result.draft).toEqual({
				kind: "refund-draft",
				amountInput: "5.00",
				reason: "damaged",
				refundedBy: "carol",
			});
		}
	});

	test("a review with no `Refunded by` names the missing field, not the amount", async () => {
		const result = await act("orders:refund-review", {
			orderId: ORDER_ID,
			currency: "USD",
			refundedSoFar: "500",
			amount: "5.00",
			refundedBy: "  ",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice?.description).toBe(REFUND_BY_REQUIRED);
	});

	test("a review that passes every check stages PARSED minor units and the watermark the operator saw", async () => {
		const result = await act("orders:refund-review", {
			orderId: ORDER_ID,
			currency: "USD",
			refundedSoFar: "500",
			amount: "5.00",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(posts()).toHaveLength(0);
		expect(result.notice).toBeNull();
		expect(result.staged).toEqual({
			kind: "refund-staged",
			amountCents: 500,
			refundedSoFarCents: 500,
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
	});

	test("REFUSAL 1, at the confirm — a refund whose watermark no longer matches applies NOTHING", async () => {
		// The genuinely CONCURRENT case: the ledger moved between the confirm being
		// drawn and this click. The review catches movement one step earlier; both
		// are required, and they catch different windows.
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
		// The figure goes back in the field it was typed into.
		expect((result.draft as { amountInput?: string } | undefined)?.amountInput).toBe("5.00");
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

	test("an unreadable CONFIRM payload puts back the amount it DID parse; only a genuinely unparseable one comes back blank", async () => {
		// Four disjuncts, and only one of them lacks an amount. Blanking the field on
		// the other three discards a figure we are holding.
		const withAmount = await act("orders:refund", {
			orderId: ORDER_ID,
			amountCents: "1000",
			currency: "USD", // watermark missing
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(service.requests).toHaveLength(0);
		expect(withAmount.notice?.title).toBe("That action could not be read");
		expect(withAmount.draft).toEqual({
			kind: "refund-draft",
			amountInput: "10.00",
			reason: "damaged",
			refundedBy: "carol",
		});
		for (const amountCents of ["0", "not-a-number", "-100", "10.00"]) {
			service.requests.length = 0;
			const result = await act("orders:refund", {
				orderId: ORDER_ID,
				amountCents,
				refundedSoFarCents: "500",
				currency: "USD",
				refundedBy: "carol",
			});
			expect(service.requests, amountCents).toHaveLength(0);
			expect((result.draft as { amountInput?: string } | undefined)?.amountInput, amountCents).toBe(
				"",
			);
		}
	});

	test("the service's own 409 REFUND_EXCEEDS_TOTAL is still handled — the concurrent case the bound check cannot catch", async () => {
		// The bound check tests what the review STAGES; it cannot see a capture that
		// shrinks between the confirm being drawn and the click.
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
		expect(result.draft).toBeUndefined();
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
		// A form inviting a retry is the worst possible affordance on an unknown
		// outcome, so no draft rides along.
		expect(result.draft).toBeUndefined();
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
