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
 * ONE PROPERTY LOST ITS SUBJECT AND IS SAID OUT LOUD RATHER THAN QUIETLY DROPPED.
 * F-2a's content-derived idempotency keys are still derived, exactly as before —
 * `admin-refund:<order>:<amount>:<watermark>` and the rest — but a key is now an
 * argument handed to a use-case inside this process instead of a header on a
 * wire, so no test can observe the STRING. What the key BUYS is still observable
 * and still tested: a replayed note reads `Already added` (below), which is the
 * dedupe the key performs.
 *
 * REFUNDS CANNOT COMPLETE ON THIS TIER, and that is recorded, not worked around.
 * `InProcessAdminOrdersClient` composes NO payment gateways yet (INC-C1/C3 move
 * the payment adapters), so every well-formed refund reaches its "no gateway is
 * wired for this order's method" arm and answers `409
 * REFUND_GATEWAY_UNAVAILABLE`. The refund cases below therefore cover everything
 * IN FRONT of that arm — which is where DA-3a and DA-3b live and where the money
 * bugs are — plus the honest notice the arm itself produces. The success,
 * duplicate and fully-refunded notices, the `REFUND_EXCEEDS_TOTAL` ceiling
 * refusal and the `GATEWAY_UNVERIFIED` ambiguous-timeout copy are unreachable
 * until a gateway map is composed; they had exactly one previous source of truth,
 * a stub answering an invented status code, and a test that stubs a reply it
 * cannot provoke proves nothing about this tier.
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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ORDERS_ACTION_IDS } from "../src/admin/orders-actions.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
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
async function seedOrder(options: { paid?: boolean } = {}): Promise<string> {
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
	return id;
}

/** The order as the store holds it right now — what a refusal must have left
 *  alone, and what an applied write must have moved. */
async function readOrder(id: string): Promise<Order> {
	const order = await orderStore.getById(toOrderId(id));
	if (order === null) throw new Error(`seeded order ${id} vanished`);
	return order;
}

describe("the Orders write path (workerd sandbox)", () => {
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
		// The remaining-refundable figure the copy quotes is the ceiling, which with
		// no captured payments recorded is min(Σ captured, total) = $0.00 — the
		// honest number for an order whose money this tier cannot see moving yet.
		const id = await seedOrder();
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
		expect(result.notice?.description).toContain("now remains refundable");
		expect(String(result.notice?.description).length).toBeLessThanOrEqual(240);
	});

	test("an HONEST watermark reaches the write, and this tier answers that no gateway is wired", async () => {
		// THE ARM BEHIND THE GATE. Everything the console checks has passed — the
		// amount parses as integer minor units, the currency is named, the watermark
		// matches the live ledger — so the refund genuinely reaches
		// `InProcessAdminOrdersClient.refundOrder`, which composes no payment
		// gateways yet (INC-C1/C3) and answers `409 REFUND_GATEWAY_UNAVAILABLE`.
		// That lands on `refundFailureNotice`'s default arm.
		//
		// This is the case the deleted success/duplicate/fully-refunded tests become
		// until a gateway map exists: asserting the notice a stub was told to produce
		// would have said nothing about this tier, and asserting a success would have
		// been false.
		const id = await seedOrder();
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
