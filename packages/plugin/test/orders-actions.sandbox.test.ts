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
 * THERE IS NO SERVICE BEHIND THESE WRITES ANY MORE (INC-D3a). The console's
 * clients come from `makeAdminClients(ctx)`, which composes the commerce
 * adapters straight over `ctx.storage` — so a write here is a write to a REAL
 * document store in the same isolate, and the state a refusal is compared
 * against is the state this file seeded through those same adapters. Every
 * assertion that used to read a recorded HTTP request (a POST body, an
 * `Idempotency-Key` header, an `X-Internal-Token`) is therefore gone: there is
 * no request to record, and no token — the token pair authenticated a caller TO
 * THE SERVICE, and ADR-0014 D3 deleted both with the deployment. What each write
 * DID is now read back off the order itself, which is the stronger statement
 * anyway: the old tests proved a request was addressed correctly, these prove
 * the order moved.
 *
 * ONE PROPERTY LOST ITS SUBJECT ON THIS TIER AND MOVED RATHER THAN BEING DROPPED.
 * F-2a's content-derived idempotency keys are still derived, exactly as before —
 * `admin-refund:<order>:<amount>:<watermark>` and the rest — but a key is now an
 * argument handed to a use-case inside this isolate instead of a header on a
 * wire, so no test AT THIS TIER can observe the STRING. The refund key's
 * derivation is therefore pinned one layer down, directly, in
 * `orders-refund-key.test.ts` — including F-2a's positive case, that two
 * deliberate identical refunds derive DIFFERENT keys because the observed
 * watermark moved. What the key BUYS is still observable here too: a replayed
 * note reads `Already added` (below), which is the dedupe the key performs.
 *
 * REFUNDS RUN ON TWO BOOTS. `makeAdminClients` composes the payment gateways
 * from kv exactly as checkout does (issue #303), so a refund's fate depends on
 * whether Stripe is configured. This file's MAIN boot provisions no Stripe
 * secrets: every well-formed refund there reaches the "no gateway is wired for
 * this order's method" arm and answers `409 REFUND_GATEWAY_UNAVAILABLE`, and the
 * refund cases on it cover everything IN FRONT of that arm — which is where
 * DA-3a and DA-3b live and where the money bugs are. The LAST describe boots a
 * second isolate with both Stripe secrets saved and `api.stripe.com` stubbed
 * (`helpers/stripe-api-stub.ts`), and drives the configured path end to end:
 * one `POST /v1/refunds` over `ctx.http` carrying the refund's idempotency key,
 * the success and fully-refunded notices, a double-submit that asks Stripe for
 * nothing more, and a ceiling refusal that never reaches Stripe.
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
 * below and stays.
 *
 * A green happy path is not evidence for any of this, so every refusal test also
 * asserts the order is UNTOUCHED — read back through the same adapters.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type Order,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { REFUND_TOO_HIGH_TITLE } from "@otta-sh/admin-presentation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ORDERS_ACTION_IDS } from "../src/admin/orders-actions.js";
import {
	startStripeApiStub,
	type StripeApiStub,
	type StripeResponder,
} from "./helpers/stripe-api-stub.js";
import {
	loadPluginInSandbox,
	productionAllowedHosts,
	type SandboxHandle,
} from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const ACT = "otta_console_act";

/** $15.00, the total every seeded order carries — the figures in the refund copy
 *  below are derived from it, so moving it moves them. */
const TOTAL_CENTS = 1500;

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

let sandbox: SandboxHandle;
let storage: StorageAccess;
let orderStore: EmdashOrderStore;
let seq = 0;

/** A namespace no other suite writes under. The document store is process-scoped
 *  and reused across boots, so every id this file mints carries the prefix and
 *  every case mints its own — no case can observe another's order. */
const NS = "oa";

/** The states the order's email outbox holds an entry for — what the buyer has
 *  been, or will be, emailed about. Read off the order document itself. */
async function outboxStates(id: string): Promise<string[]> {
	const doc = (await storage["orders"]?.get(id)) as {
		emailOutbox?: { toState: string }[];
	} | null;
	return (doc?.emailOutbox ?? []).map((entry) => entry.toState);
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	const inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	orderStore = new EmdashOrderStore({ storage, inventory, idGen: uuidIdGen, clock: systemClock });
	// ONE boot for the file. The isolate holds no per-case state — the commerce
	// truth lives in the store beside it — so a boot per case would only pay the
	// bundle-and-spawn cost again.
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
});

/**
 * A fresh order, seeded through the SAME adapters the console's in-process
 * client composes — so what a write re-reads is what this function wrote, and a
 * divergence between the two is a real defect rather than a fixture artefact.
 *
 * `paid` by default, because that is the state every watermark case starts from:
 * `createFromCart` lands an order in `pending` and `markPaid` moves it.
 */
async function seedOrder(
	options: { paid?: boolean; capturedCents?: number } = {},
): Promise<string> {
	seq += 1;
	const suffix = `${NS}-${String(seq)}`;
	const id = `order-${suffix}`;
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`create-${suffix}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: `alice-${suffix}@example.com`,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${suffix}`),
				sku: toSku(`SKU-${suffix.toUpperCase()}`),
				title: "Linen apron",
				unitPrice: cents(TOTAL_CENTS),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(TOTAL_CENTS), total: cents(TOTAL_CENTS), currency: currency("USD") },
	});
	if (options.paid !== false) await orderStore.markPaid(toOrderId(id));
	// A SUCCEEDED capture is what gives the refund ceiling a non-zero value:
	// `min(Σ captured, frozen total)`. Without one every ceiling — and so every
	// "remains refundable" figure the copy quotes — is $0.00, which would let the
	// partial-refund arithmetic in the stale-ledger notice go unchecked.
	if (options.capturedCents !== undefined) {
		await orderStore.recordPayment({
			orderId: toOrderId(id),
			gateway: "stripe",
			providerRef: `pi-${suffix}`,
			amount: cents(options.capturedCents),
			currency: currency("USD"),
			status: "succeeded",
		});
	}
	return id;
}

/** The order as the store holds it right now — what a refusal must have left
 *  alone, and what an applied write must have moved. */
async function readOrder(id: string): Promise<Order> {
	const order = await orderStore.getById(toOrderId(id));
	if (order === null) throw new Error(`seeded order ${id} vanished`);
	return order;
}

/** One console write, exactly as `performAction` sends it, on a given boot. */
async function actOn(
	boot: SandboxHandle,
	actionId: string,
	value: Record<string, string>,
): Promise<ActOutcome> {
	const outcome = await boot.invokeRoute("admin", {
		type: ACT,
		action_id: actionId,
		value,
	});
	expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
	return (outcome as { result: ActOutcome }).result;
}

describe("the Orders write path (workerd sandbox)", () => {
	/** One console write on this file's main boot (no Stripe secrets). */
	async function act(actionId: string, value: Record<string, string>): Promise<ActOutcome> {
		return actOn(sandbox, actionId, value);
	}

	/** Move a seeded order along the state machine using the console's own
	 *  transitions, so a case that needs `shipped` gets there the way an operator
	 *  would rather than by writing the field behind the domain's back. */
	async function advance(id: string, path: readonly string[]): Promise<void> {
		let from = "paid";
		for (const to of path) {
			const result = await act(`orders:transition-${to}`, {
				orderId: id,
				toState: to,
				state: from,
			});
			expect(result.notice, `${from} → ${to}`).toBeNull();
			from = to;
		}
	}

	// -- the dispatch gate ------------------------------------------------------

	test("an UNKNOWN action id is a refusal with copy, never a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action, and from
		// a console bug — never from a control this release rendered. Reporting it as
		// an outcome would render a refund that never happened as done.
		const id = await seedOrder();
		const result = await act("orders:no-such-action", { orderId: id });
		expect(result.ok).toBe(false);
		expect(result.title).toBe("Nothing was changed");
		expect(String(result.description)).toContain("Nothing was applied");
		expect((await readOrder(id)).state).toBe("paid");
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

	test("a transition APPLIES to the persisted order and reports no notice", async () => {
		// What the deleted POST-body assertion was a proxy for. There is no request
		// to inspect now, so the claim is made directly against the store the write
		// went to: the order moved, and it moved to the state the id names.
		const id = await seedOrder();
		const result = await act("orders:transition-processing", {
			orderId: id,
			toState: "processing",
			state: "paid",
		});
		expect(result.notice).toBeNull();
		expect((await readOrder(id)).state).toBe("processing");
	});

	test("the target state comes from the ACTION ID, never from the operator-alterable payload", async () => {
		// DA-6 item 4: `toState` in the payload is a lie an operator can tell. The
		// handler is closed over the state its id was derived from, so the lie has
		// nowhere to land — and the order proves it landed nowhere.
		const id = await seedOrder();
		await act("orders:transition-processing", {
			orderId: id,
			toState: "refunded",
			state: "paid",
		});
		expect((await readOrder(id)).state).toBe("processing");
	});

	test("DA-3a: a transition whose observed state no longer matches applies NOTHING and names both states", async () => {
		const id = await seedOrder();
		await advance(id, ["processing"]);
		const result = await act("orders:transition-shipped", {
			orderId: id,
			toState: "shipped",
			// The operator SAW `paid`; the live order is `processing`.
			state: "paid",
		});
		expect((await readOrder(id)).state).toBe("processing");
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
		const id = await seedOrder();
		for (const state of [undefined, "", "   "]) {
			const result = await act("orders:transition-processing", {
				orderId: id,
				toState: "processing",
				...(state === undefined ? {} : { state }),
			});
			expect(result.notice?.title, JSON.stringify(state)).toBe("That action could not be read");
			expect((await readOrder(id)).state, JSON.stringify(state)).toBe("paid");
		}
	});

	test("an unpaid CARD order cannot be marked paid by hand — refused in the domain, nothing moves (T1-3)", async () => {
		// The console no longer offers the button (orders-console-route.sandbox), but
		// the payload is operator-alterable, so the WRITE must refuse it too: a click
		// here used to email "we've received your payment" and count the revenue with
		// nothing captured.
		const id = await seedOrder({ paid: false });
		const result = await act("orders:transition-paid", {
			orderId: id,
			toState: "paid",
			state: "pending",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Only the payment provider can mark this order paid");
		expect(String(result.notice?.description)).toContain("Nothing was changed");
		const order = await readOrder(id);
		expect(order.state).toBe("pending");
		// Nothing was enqueued for the buyer either.
		expect(await outboxStates(id)).toEqual([]);
	});

	test("a hand-made bare `cancelled` on a PAID order is refused — nothing cancelled, nothing emailed (T1-4)", async () => {
		// The console offers no bare cancel, but the payload is operator-alterable: a
		// raw `orders:transition-cancelled` would close a paid order with the money kept,
		// no restock and a "cancelled" email. The domain refuses it.
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });
		const result = await act("orders:transition-cancelled", {
			orderId: id,
			toState: "cancelled",
			state: "paid",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Use Cancel order to cancel a paid order");
		expect(String(result.notice?.description)).toContain("Nothing was changed");
		const order = await readOrder(id);
		expect(order.state).toBe("paid");
		expect(order.cancellation).toBeNull();
		// The settlement's confirmation is the only email on the order.
		expect(await outboxStates(id)).toEqual(["paid"]);
	});

	test("a no-op transition (ok but transitioned:false) reports a NON-error notice", async () => {
		// The guarded flip matching 0 rows is not a failure — two tabs racing the
		// same button is the ordinary case — so it gets a `default` notice rather
		// than an error one or a silent success. Provoked HONESTLY here: the order
		// is already `processing` and the watermark says so, so the re-read agrees
		// and the flip finds nothing to move.
		const id = await seedOrder();
		await advance(id, ["processing"]);
		const result = await act("orders:transition-processing", {
			orderId: id,
			toState: "processing",
			state: "processing",
		});
		expect(result.notice?.variant).toBe("default");
		expect(result.notice?.title).toBe("No change");
	});

	test("an order that cannot be re-read before a transition applies nothing", async () => {
		// The re-read resolving `null` — an id that names no order, which is what a
		// deleted-then-reloaded tab sends. The stub used to manufacture this with a
		// 500; an unknown id provokes the same branch without inventing an outage.
		const result = await act("orders:transition-processing", {
			orderId: `order-${NS}-does-not-exist`,
			toState: "processing",
			state: "paid",
		});
		expect(result.notice?.title).toBe("Nothing was changed");
	});

	// -- notes ------------------------------------------------------------------

	test("add-note APPENDS the note to the order, and reports no notice", async () => {
		// REGRESSION GUARD. Until INC-R2 the console's note, resolve and fulfilment
		// writes carried their order id in a flat payload while the Block Kit handler
		// they were forwarded to read it from a `block_id` carrier the console never
		// sent — so all three answered "That action could not be read" and wrote
		// nothing at all. The extraction is what closes that, and the note now on the
		// order is the proof.
		const id = await seedOrder();
		const result = await act("orders:add-note", { orderId: id, author: "ops", body: "hello" });
		expect(result.notice).toBeNull();
		const timeline = await sandbox.invokeRoute("admin", {
			type: "otta_console_read",
			resource: "orders.detail",
			orderId: id,
		});
		if ("error" in timeline) throw new Error(timeline.error);
		const notes = (timeline.result as { notes: Array<{ author: string; body: string }> }).notes;
		expect(notes).toEqual([expect.objectContaining({ author: "ops", body: "hello" })]);
	});

	test("add-note replays: the SAME note dedupes, and the not-appended reply says so", async () => {
		// F-2a's content-derived key, observed through what it BUYS rather than
		// through a header that no longer travels anywhere: the second submission of
		// a byte-identical note derives the same key, the domain answers it from the
		// idempotency store, and the console says `Already added` instead of
		// appending a second copy.
		const id = await seedOrder();
		const value = { orderId: id, author: "ops", body: "hello" };
		const first = await act("orders:add-note", value);
		expect(first.notice).toBeNull();
		const replay = await act("orders:add-note", value);
		expect(replay.notice?.variant).toBe("default");
		expect(replay.notice?.title).toBe("Already added");
	});

	test("add-note with a blank author or body refuses inline and writes nothing", async () => {
		const id = await seedOrder();
		for (const values of [
			{ author: "", body: "hello" },
			{ author: "ops", body: "   " },
		]) {
			const result = await act("orders:add-note", { orderId: id, ...values });
			expect(result.notice?.variant).toBe("error");
			expect(result.notice?.title).toBe("Note not added");
		}
	});

	// -- reconciliation ---------------------------------------------------------

	test("resolve CLEARS the flag as displayed and records the disposition", async () => {
		// The domain compare-and-clears on `expectedFlag`, so a new anomaly raised
		// mid-review conflicts instead of being cleared blind. The happy half of that
		// rule: the flag the operator reviewed is the one on the order, so it clears.
		const id = await seedOrder();
		await orderStore.flagReconciliation(toOrderId(id), "amount mismatch");
		const result = await act("orders:resolve-reconciliation", {
			orderId: id,
			expectedFlag: "amount mismatch",
			outcome: "written_off",
			reason: "false alarm",
			resolvedBy: "carol",
		});
		expect(result.notice?.title).toBe("Reconciliation resolved");
		const order = await readOrder(id);
		expect(order.reconciliationFlag).toBeNull();
		expect(order.reconciliationResolution).toMatchObject({
			outcome: "written_off",
			reason: "false alarm",
			resolvedBy: "carol",
		});
	});

	test("a STALE flag gets its own copy — nothing was cleared, review the new one", async () => {
		// The other half, provoked the way it actually happens: a SECOND anomaly is
		// flagged after the form rendered, so the flag on the order is no longer the
		// one the operator reviewed.
		const id = await seedOrder();
		await orderStore.flagReconciliation(toOrderId(id), "a newer anomaly");
		const result = await act("orders:resolve-reconciliation", {
			orderId: id,
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
		// And the newer anomaly is still standing, which is the whole point.
		expect((await readOrder(id)).reconciliationFlag).toBe("a newer anomaly");
	});

	test("resolve with a blank reason or resolver refuses inline and clears nothing", async () => {
		const id = await seedOrder();
		await orderStore.flagReconciliation(toOrderId(id), "amount mismatch");
		for (const values of [
			{ reason: "", resolvedBy: "carol" },
			{ reason: "false alarm", resolvedBy: " " },
		]) {
			const result = await act("orders:resolve-reconciliation", {
				orderId: id,
				expectedFlag: "amount mismatch",
				outcome: "written_off",
				...values,
			});
			expect(result.notice?.title).toBe("Not resolved");
			expect((await readOrder(id)).reconciliationFlag).toBe("amount mismatch");
		}
	});

	// -- fulfilment -------------------------------------------------------------

	test("record-fulfillment SHIPS the order with its tracking, normalising the shipped day to an instant", async () => {
		// Recording fulfilment IS shipping (`processing → shipped`, atomically with
		// the tracking envelope), so the order is advanced to `processing` first —
		// which is also what makes the `NOT_FULFILLABLE` case below honest.
		const id = await seedOrder();
		await advance(id, ["processing"]);
		const result = await act("orders:record-fulfillment", {
			orderId: id,
			carrier: "UPS",
			trackingNumber: "1Z999",
			trackingUrl: "https://ups.example/1Z999",
			shippedAt: "2026-07-08",
			recordedBy: "carol",
		});
		expect(result.notice?.title).toBe("Order shipped");
		const order = await readOrder(id);
		expect(order.state).toBe("shipped");
		expect(order.fulfillment).toMatchObject({
			carrier: "UPS",
			trackingNumber: "1Z999",
			trackingUrl: "https://ups.example/1Z999",
			// A date field yields a DAY; the domain wants a full ISO instant, and a
			// day given as a shipping moment is the start of that day.
			shippedAt: "2026-07-08T00:00:00.000Z",
			recordedBy: "carol",
		});
	});

	test("a non-http(s) tracking URL is refused before it can be emailed to a buyer", async () => {
		// Defense in depth: the commerce input bounds enforce the same rule one layer
		// down, and this value reaches a buyer's inbox, so a `javascript:`/`data:`
		// URI never gets as far as the write.
		const id = await seedOrder();
		await advance(id, ["processing"]);
		for (const trackingUrl of ["javascript:alert(1)", "data:text/html,x", "ftp://x/y"]) {
			const result = await act("orders:record-fulfillment", {
				orderId: id,
				carrier: "UPS",
				trackingNumber: "1Z999",
				trackingUrl,
				recordedBy: "carol",
			});
			expect(result.notice?.title, trackingUrl).toBe("Not shipped");
			expect(String(result.notice?.description)).toContain("http://");
			expect((await readOrder(id)).state, trackingUrl).toBe("processing");
		}
	});

	test("record-fulfillment with any required field blank refuses inline and ships nothing", async () => {
		const id = await seedOrder();
		await advance(id, ["processing"]);
		for (const values of [
			{ carrier: "", trackingNumber: "1Z999", recordedBy: "carol" },
			{ carrier: "UPS", trackingNumber: " ", recordedBy: "carol" },
			{ carrier: "UPS", trackingNumber: "1Z999", recordedBy: "" },
		]) {
			const result = await act("orders:record-fulfillment", { orderId: id, ...values });
			expect(result.notice?.title).toBe("Not shipped");
			expect((await readOrder(id)).state).toBe("processing");
		}
	});

	test("a NOT_FULFILLABLE order gets copy naming the state, not the status code", async () => {
		// A `paid` order has not been picked yet, so there is nothing to ship —
		// the domain's own 409, provoked by the order's real state rather than by a
		// stubbed reply.
		const id = await seedOrder();
		const result = await act("orders:record-fulfillment", {
			orderId: id,
			carrier: "UPS",
			trackingNumber: "1Z999",
			recordedBy: "carol",
		});
		expect(result.notice?.title).toBe("Order can’t be shipped right now");
		expect(String(result.notice?.description)).not.toMatch(/HTTP \d|409|\/admin\//);
		expect((await readOrder(id)).state).toBe("paid");
	});

	// -- cancellation -----------------------------------------------------------

	test("a per-reason cancel re-reads the order, then cancels WITH the reason on file", async () => {
		const id = await seedOrder();
		const result = await act("orders:cancel-out_of_stock", {
			orderId: id,
			reason: "out_of_stock",
			state: "paid",
		});
		expect(result.notice?.title).toBe("Order cancelled");
		const order = await readOrder(id);
		expect(order.state).toBe("cancelled");
		// No reachable state is "cancelled with no reason recorded" — the envelope
		// rides the same guarded flip, and `cancelledBy` defaults to `admin` on the
		// per-reason control, which carries no actor field.
		expect(order.cancellation).toMatchObject({ reason: "out_of_stock", cancelledBy: "admin" });
	});

	test("DA-3a: a cancel whose observed state no longer matches applies NOTHING and names both states", async () => {
		const id = await seedOrder();
		await advance(id, ["processing"]);
		await act("orders:record-fulfillment", {
			orderId: id,
			carrier: "UPS",
			trackingNumber: "1Z999",
			recordedBy: "carol",
		});
		const result = await act("orders:cancel", {
			orderId: id,
			reason: "out_of_stock",
			detail: "warehouse fire",
			cancelledBy: "carol",
			state: "paid",
		});
		expect(result.notice?.title).toBe("The order changed — nothing was cancelled");
		expect(result.notice?.description).toContain("was paid when you started");
		expect(result.notice?.description).toContain("is now shipped");
		const order = await readOrder(id);
		expect(order.state).toBe("shipped");
		expect(order.cancellation).toBeNull();
	});

	test("a cancel reason outside the closed set, or a missing watermark, is an unreadable payload", async () => {
		const id = await seedOrder();
		const cases: Record<string, string>[] = [
			{ orderId: id, reason: "because", state: "paid" },
			{ orderId: id, reason: "out_of_stock" },
		];
		for (const value of cases) {
			const result = await act("orders:cancel", value);
			expect(result.notice?.title, JSON.stringify(value)).toBe("That action could not be read");
			expect((await readOrder(id)).state, JSON.stringify(value)).toBe("paid");
		}
	});

	test("a NOT_CANCELLABLE order gets copy that offers no retry", async () => {
		// A shipped order cannot be cancelled — the state machine says so, and the
		// watermark MATCHES, so this is the domain refusing the write rather than
		// the console refusing the payload.
		const id = await seedOrder();
		await advance(id, ["processing"]);
		await act("orders:record-fulfillment", {
			orderId: id,
			carrier: "UPS",
			trackingNumber: "1Z999",
			recordedBy: "carol",
		});
		const result = await act("orders:cancel-fraud_suspected", {
			orderId: id,
			reason: "fraud_suspected",
			state: "shipped",
		});
		// The write was ATTEMPTED, so this is an outcome to read rather than an input
		// to correct — a prefilled retry would promise something no longer possible.
		expect(result.notice?.title).toBe("Order can’t be cancelled right now");
		expect((await readOrder(id)).state).toBe("shipped");
	});

	// -- refunds: THE GATE ------------------------------------------------------

	test("THE REFUSAL — a refund whose watermark no longer matches applies NOTHING", async () => {
		// The genuinely CONCURRENT case: the ledger moved between the confirm being
		// drawn and this click. This is the ONLY server-side window checked on a
		// refund, so it carries the whole of DA-3a for the money path.
		//
		// A seeded order has an EMPTY refund ledger, so live `refundedTotalCents` is
		// 0 and a payload claiming 500 is exactly the stale watermark this refuses.
		// The remaining-refundable figure the copy quotes is the ceiling minus the
		// ledger: this order captured $6.00 against a $15.00 total, so the ceiling is
		// min(600, 1500) = $6.00 and nothing has come back yet. The ARITHMETIC is the
		// point — a copy that quoted the order total, the captured total or a zero
		// would all pass a test that only looked for the phrase.
		const id = await seedOrder({ capturedCents: 600 });
		const result = await act("orders:refund", {
			orderId: id,
			amountCents: "500",
			refundedSoFarCents: "500",
			currency: "USD",
			reason: "",
			refundedBy: "carol",
		});
		expect(result.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(result.notice?.description).toContain("someone else refunded this order");
		// The copy names BOTH figures and the CAUSE — "the ledger changed" alone
		// states an effect and leaves the operator to guess whether they hit a bug.
		expect(result.notice?.description).toContain("$5.00 was staged");
		expect(result.notice?.description).toContain("$6.00 now remains refundable");
		expect(String(result.notice?.description).length).toBeLessThanOrEqual(240);
	});

	test("an HONEST watermark reaches the write, and with NO Stripe configured it answers that no gateway is wired", async () => {
		// THE ARM BEHIND THE GATE. Everything the console checks has passed — the
		// amount parses as integer minor units, the currency is named, the watermark
		// matches the live ledger — so the refund genuinely reaches
		// `InProcessAdminOrdersClient.refundOrder`. This boot provisions no Stripe
		// secrets, so `makeAdminClients` composes no `stripe` gateway and the refund
		// is refused fail-closed with `409 REFUND_GATEWAY_UNAVAILABLE`, which lands on
		// `refundFailureNotice`'s default arm. The configured path is the describe
		// at the end of this file.
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });
		const result = await act("orders:refund", {
			orderId: id,
			amountCents: "500",
			refundedSoFarCents: "0",
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Not refunded");
		// E-7 holds on this arm too: no status code, no path.
		expect(String(result.notice?.description)).not.toMatch(/HTTP \d|409|\/admin\//);
	});

	test("DA-3b: each of the disjuncts of an unreadable confirm refuses and never reaches the write", async () => {
		// A payload can carry a perfectly good `amountCents` and still be unreadable
		// because the WATERMARK or the CURRENCY is missing. None of them is fixable
		// by re-typing the amount, so all take the payload-level refusal — and,
		// critically, none of them reaches the ledger re-read, which is why the
		// refusal is `That action could not be read` rather than a ledger notice.
		const id = await seedOrder();
		const cases: Record<string, string>[] = [
			// watermark missing, amount fine
			{ amountCents: "1000", currency: "USD" },
			// currency missing, amount fine
			{ amountCents: "1000", refundedSoFarCents: "0" },
			// amount not a positive integer of minor units
			{ amountCents: "0", refundedSoFarCents: "0", currency: "USD" },
			{ amountCents: "-100", refundedSoFarCents: "0", currency: "USD" },
			{ amountCents: "not-a-number", refundedSoFarCents: "0", currency: "USD" },
		];
		for (const value of cases) {
			const result = await act("orders:refund", {
				orderId: id,
				reason: "damaged",
				refundedBy: "carol",
				...value,
			});
			expect(result.notice?.title, JSON.stringify(value)).toBe("That action could not be read");
		}
	});

	test("a ledger that cannot be re-read applies nothing", async () => {
		// `getRefunds` resolving `null` — an id that names no order, which is what a
		// deleted-then-reloaded tab sends. "Nothing came back" is not "nothing to
		// say": the operator is told the ledger could not be re-checked rather than
		// being shown a refund that never happened.
		const result = await act("orders:refund", {
			orderId: `order-${NS}-does-not-exist`,
			amountCents: "500",
			refundedSoFarCents: "0",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(result.notice?.title).toBe("Nothing was refunded");
	});

	// -- money never crosses this boundary as a float ---------------------------

	test("M-3/B-2: a payload's minor units must be a plain integer string — no float is ever laundered into cents", async () => {
		const id = await seedOrder();
		for (const amountCents of ["5.00", "1e3", " 500", "+500", "0x1f", "9007199254740993"]) {
			const result = await act("orders:refund", {
				orderId: id,
				amountCents,
				refundedSoFarCents: "0",
				currency: "USD",
				refundedBy: "carol",
			});
			expect(result.notice?.title, amountCents).toBe("That action could not be read");
		}
	});
});

/** Stripe's side of every PaymentIntent the cases refund against. */
function refundingStripe(
	captured: number,
	/** Statuses for the next `POST /v1/refunds` calls, consumed in order, each
	 *  answered with Stripe's error envelope before anything is refunded. */
	postFailures: number[] = [],
): StripeResponder {
	const refundedByIntent = new Map<string, number>();
	const byKey = new Map<string, { status: number; body: unknown }>();
	let n = 0;
	return (req) => {
		const read = /^\/v1\/payment_intents\/([^/?]+)\?/.exec(req.path);
		if (req.method === "GET" && read !== null) {
			const intent = decodeURIComponent(read[1] ?? "");
			return {
				status: 200,
				body: {
					id: intent,
					latest_charge: {
						amount_refunded: refundedByIntent.get(intent) ?? 0,
						amount_captured: captured,
						currency: "usd",
					},
				},
			};
		}
		if (req.method === "POST" && req.path === "/v1/refunds") {
			const failure = postFailures.shift();
			if (failure !== undefined) {
				return { status: failure, body: { error: { type: "api_error", code: "scripted" } } };
			}
			const key = req.headers["idempotency-key"];
			const previous = typeof key === "string" ? byKey.get(key) : undefined;
			if (previous !== undefined) return previous;
			const intent = req.form.get("payment_intent") ?? "";
			const amount = Number(req.form.get("amount"));
			refundedByIntent.set(intent, (refundedByIntent.get(intent) ?? 0) + amount);
			n += 1;
			const reply = {
				status: 200,
				body: { id: `re_stub_${String(n)}`, amount, currency: "usd", status: "succeeded" },
			};
			if (typeof key === "string") byKey.set(key, reply);
			return reply;
		}
		return { status: 404, body: { error: { type: "invalid_request_error" } } };
	};
}

/**
 * ADMIN REFUNDS WITH STRIPE CONFIGURED (issue #303), inside workerd.
 *
 * A SECOND BOOT, like `storefront-checkout.sandbox.test.ts`'s `place` suite: it
 * saves both Stripe secrets through the Settings form's own actions, grants
 * production's allowlist, and points workerd's global outbound at a local Stripe
 * API stub — so the refund passes the plugin's real `ctx.http` allowlist check
 * for `api.stripe.com` and then lands on the stub instead of the internet. The
 * main boot above stays secret-less, which is what keeps its fail-closed case
 * honest.
 *
 * The stub answers the two requests `StripePaymentGateway.refund` makes the way
 * Stripe does: the pre-flight `GET /v1/payment_intents/:id?expand[]=latest_charge`
 * reports the live refunded/captured view, and `POST /v1/refunds` refunds —
 * honouring Stripe's native idempotency (a repeated `Idempotency-Key` returns the
 * SAME refund and moves no more money). Orders are seeded through the same
 * adapters as above, with a succeeded capture whose `providerRef` is the
 * PaymentIntent the refund targets.
 */
describe("Orders refunds with Stripe configured (workerd sandbox, Stripe stubbed)", () => {
	const STRIPE_SECRET_KEY = "sk_test_refunds_NEVER_LEAK";
	const STRIPE_WEBHOOK_SECRET = "whsec_refunds_NEVER_LEAK";
	let stripeBoot: SandboxHandle;
	let stripe: StripeApiStub;

	function refundPosts(): typeof stripe.requests {
		return stripe.requests.filter((r) => r.method === "POST" && r.path === "/v1/refunds");
	}

	beforeAll(async () => {
		stripe = await startStripeApiStub({ forwardTo: [(await storageBridge()).baseUrl] });
		stripeBoot = await loadPluginInSandbox({
			allowedHosts: productionAllowedHosts(),
			storage: true,
			globalOutbound: stripe.address,
		});
		for (const [action, field, value] of [
			["save-stripe-secret-key", "stripeSecretKey", STRIPE_SECRET_KEY],
			["save-stripe-webhook-secret", "stripeWebhookSecret", STRIPE_WEBHOOK_SECRET],
		] as const) {
			const saved = await stripeBoot.invokeRoute("admin", {
				type: "form_submit",
				action_id: action,
				values: { [field]: value },
			});
			expect(saved).toHaveProperty("result");
		}
	}, 300_000);

	afterAll(async () => {
		await stripeBoot?.close();
		await stripe?.close();
	});

	beforeEach(() => {
		stripe.reset();
		stripe.respondWith(refundingStripe(TOTAL_CENTS));
	});

	afterEach(() => {
		// A refused forward is a 502 INSIDE the isolate, which the refund would
		// report as an ordinary provider failure — so it is asserted here.
		expect(stripe.refused).toEqual([]);
	});

	test("a refund goes to Stripe ONCE over ctx.http, carrying its idempotency key, and is recorded", async () => {
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });
		const result = await actOn(stripeBoot, "orders:refund", {
			orderId: id,
			amountCents: "500",
			refundedSoFarCents: "0",
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(result.notice?.title).toBe("Refund recorded");

		const posts = refundPosts();
		expect(posts).toHaveLength(1);
		// The key the console derived (F-2a) is the key Stripe sees — its NATIVE
		// idempotency is what makes a retry safe provider-side.
		expect(posts[0]?.headers["idempotency-key"]).toBe(`admin-refund:${id}:500:0`);
		expect(posts[0]?.headers.authorization).toBe(`Bearer ${STRIPE_SECRET_KEY}`);
		expect(Object.fromEntries(posts[0]?.form ?? [])).toEqual({
			payment_intent: `pi-${id.slice("order-".length)}`,
			amount: "500",
		});

		const ledger = await orderStore.listRefunds(toOrderId(id));
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			amount: 500,
			kind: "gateway",
			gateway: "stripe",
			refundRef: "re_stub_1",
			status: "recorded",
			refundedBy: "carol",
		});

		// THE DOUBLE-SUBMIT: the same confirm clicked again. Its watermark is now
		// stale, so the console refuses it before the write — and, what matters
		// here, Stripe is asked for nothing more.
		const again = await actOn(stripeBoot, "orders:refund", {
			orderId: id,
			amountCents: "500",
			refundedSoFarCents: "0",
			currency: "USD",
			reason: "damaged",
			refundedBy: "carol",
		});
		expect(again.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(refundPosts()).toHaveLength(1);
		expect(await orderStore.listRefunds(toOrderId(id))).toHaveLength(1);
	});

	test("refunding the rest of the ceiling completes the order", async () => {
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });
		expect(
			(
				await actOn(stripeBoot, "orders:refund", {
					orderId: id,
					amountCents: "500",
					refundedSoFarCents: "0",
					currency: "USD",
					refundedBy: "carol",
				})
			).notice?.title,
		).toBe("Refund recorded");
		const rest = await actOn(stripeBoot, "orders:refund", {
			orderId: id,
			amountCents: "1000",
			refundedSoFarCents: "500",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(rest.notice?.title).toBe("Refund complete");
		expect(refundPosts().map((r) => r.headers["idempotency-key"])).toEqual([
			`admin-refund:${id}:500:0`,
			`admin-refund:${id}:1000:500`,
		]);
		expect((await readOrder(id)).state).toBe("refunded");
	});

	test("a refund past a SHORT capture is refused by the ceiling and never reaches Stripe", async () => {
		// $6.00 captured against a $15.00 total: the ceiling binds at $6.00.
		const id = await seedOrder({ capturedCents: 600 });
		const result = await actOn(stripeBoot, "orders:refund", {
			orderId: id,
			amountCents: "1000",
			refundedSoFarCents: "0",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(result.notice?.title).toBe(REFUND_TOO_HIGH_TITLE);
		expect(stripe.requests).toEqual([]);
		expect(await orderStore.listRefunds(toOrderId(id))).toEqual([]);
	});

	/** The same refund confirm, clicked again with the watermark the console
	 *  now shows: the FINALIZED total, which a failed attempt did not move. */
	const confirm500 = (id: string, soFar = "0") =>
		actOn(stripeBoot, "orders:refund", {
			orderId: id,
			amountCents: "500",
			refundedSoFarCents: soFar,
			currency: "USD",
			refundedBy: "carol",
		});

	test("a 429 from Stripe says try again — and trying again RESUMES the same refund under the same key", async () => {
		stripe.respondWith(refundingStripe(TOTAL_CENTS, [429]));
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });

		expect((await confirm500(id)).notice?.title).toBe("Temporary problem");
		expect((await orderStore.listRefunds(toOrderId(id))).map((r) => r.status)).toEqual([
			"reserved",
		]);

		// The operator does what the notice says. Nothing was finalized, so the
		// watermark they send is unchanged and the retry reaches the SAME key —
		// never "someone else refunded this order".
		expect((await confirm500(id)).notice?.title).toBe("Refund recorded");
		expect(refundPosts().map((r) => r.headers["idempotency-key"])).toEqual([
			`admin-refund:${id}:500:0`,
			`admin-refund:${id}:500:0`,
		]);
		const ledger = await orderStore.listRefunds(toOrderId(id));
		expect(ledger.map((r) => [r.status, r.amount])).toEqual([["recorded", 500]]);
	});

	test("an ambiguous Stripe failure reads as UNKNOWN, and clicking again asks Stripe for nothing", async () => {
		// A 5xx on the create is ambiguous — Stripe may have refunded — exactly like
		// a timeout (the unit suite drives the timeout itself).
		stripe.respondWith(refundingStripe(TOTAL_CENTS, [500]));
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });

		expect((await confirm500(id)).notice?.title).toBe("Refund status unknown");
		expect((await orderStore.listRefunds(toOrderId(id))).map((r) => r.status)).toEqual([
			"unverified",
		]);
		const posted = refundPosts().length;

		expect((await confirm500(id)).notice?.title).toBe("Refund status unknown");
		expect(refundPosts()).toHaveLength(posted);
	});

	test("a Stripe rejection voids the attempt, and a deliberate retry is a NEW refund under a new key", async () => {
		stripe.respondWith(refundingStripe(TOTAL_CENTS, [400]));
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });

		expect((await confirm500(id)).notice?.title).toBe("Refund rejected");
		expect((await orderStore.listRefunds(toOrderId(id))).map((r) => r.status)).toEqual(["voided"]);

		// The voided key is spent (a replay of it answers the same rejection), so
		// the console derives a fresh one for the retry rather than a dead end.
		expect((await confirm500(id)).notice?.title).toBe("Refund recorded");
		const keys = refundPosts().map((r) => r.headers["idempotency-key"]);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(`admin-refund:${id}:500:0`);
		expect(keys[1]).not.toBe(keys[0]);
	});

	test("a rejection of a DIFFERENT refund on the order does not move a retryable refund onto a new key", async () => {
		// $5.00 hits a 429 and stays reserved under `…:500:0`; a $3.00 refund on the
		// same order is then rejected by Stripe (voided). Retrying the $5.00 must
		// RESUME its own reservation, not mint a new one beside it.
		stripe.respondWith(refundingStripe(TOTAL_CENTS, [429, 400]));
		const id = await seedOrder({ capturedCents: TOTAL_CENTS });

		expect((await confirm500(id)).notice?.title).toBe("Temporary problem");
		const three = await actOn(stripeBoot, "orders:refund", {
			orderId: id,
			amountCents: "300",
			refundedSoFarCents: "0",
			currency: "USD",
			refundedBy: "carol",
		});
		expect(three.notice?.title).toBe("Refund rejected");

		expect((await confirm500(id)).notice?.title).toBe("Refund recorded");
		expect(refundPosts().map((r) => r.headers["idempotency-key"])).toEqual([
			`admin-refund:${id}:500:0`,
			`admin-refund:${id}:300:0`,
			`admin-refund:${id}:500:0`,
		]);
		const ledger = await orderStore.listRefunds(toOrderId(id));
		expect(ledger).toHaveLength(2);
		expect(ledger.map((r) => [r.status, r.amount])).toEqual(
			expect.arrayContaining([
				["recorded", 500],
				["voided", 300],
			]),
		);
	});
});
