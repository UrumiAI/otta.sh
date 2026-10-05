/**
 * The console's writes record WHO made them — the signed-in operator the host
 * names on the admin route (`routeCtx.user`) — and say WHY a Mark refunded was
 * refused (QA round 2, admin).
 *
 *  - History showed "—" for Mark processing / delivered / refunded: a status move
 *    carried no actor. It now carries the operator.
 *  - "Refund $X (full remaining)" and a cancel's refund were recorded BY "admin";
 *    "Refund a different amount" made the operator type a name. Both now default to
 *    the operator; a typed name still wins where the form has one.
 *  - M4: Mark refunded on an order still holding captured money is refused in the
 *    domain (`REFUND_THROUGH_MONEY`); the notice sends the operator to Money →
 *    Refunds and says what to do about a refund made in the provider's dashboard.
 *
 * The surface is stubbed to observe what each write asks for; the domain and the
 * in-process client are pinned over a real store elsewhere.
 */
import { describe, expect, test } from "vitest";
import type {
	AdminOrdersSurface,
	OrderDetailResult,
	TransitionOrderResult,
} from "../src/admin/admin-orders-surface.js";
import { dispatchOrdersAction, type OrdersActionResult } from "../src/admin/orders-actions.js";
import { operatorName } from "../src/admin/orders-console-route.js";

const ORDER_ID = "order-operator";
const OPERATOR = "ops@example.test";

interface Calls {
	transition: unknown[];
	refund: unknown[];
	cancel: unknown[];
}

function never(): never {
	throw new Error("not called here");
}

function surface(
	state: string,
	transition: TransitionOrderResult = { ok: true, transitioned: true },
): { client: AdminOrdersSurface; calls: Calls } {
	const calls: Calls = { transition: [], refund: [], cancel: [] };
	const detail: OrderDetailResult = {
		order: { id: ORDER_ID, state } as OrderDetailResult["order"],
		allowedTransitions: [],
	};
	const client: AdminOrdersSurface = {
		getOrder: () => Promise.resolve(detail),
		transitionOrder: (...args: unknown[]) => {
			calls.transition.push(args);
			return Promise.resolve(transition);
		},
		recordFulfillment: never,
		cancelOrder: (...args: unknown[]) => {
			calls.cancel.push(args);
			return Promise.resolve({ ok: true, cancelled: true, restockedUnits: 0 });
		},
		getRefunds: () =>
			Promise.resolve({
				refunds: [],
				currency: "USD",
				capturedTotalCents: 1000,
				refundedTotalCents: 0,
				finalizedTotalCents: 0,
				ceilingCents: 1000,
				remainingCents: 1000,
				paymentMethod: "stripe",
				refundable: true,
			}),
		refundOrder: (...args: unknown[]) => {
			calls.refund.push(args);
			return Promise.resolve({ ok: true, recorded: true, duplicate: false, fullyRefunded: false });
		},
		listOrders: never,
		resolveReconciliation: never,
		getCustomerContext: never,
		getTimeline: never,
		listNotes: never,
		addNote: never,
	} as unknown as AdminOrdersSurface;
	return { client, calls };
}

async function act(
	client: AdminOrdersSurface,
	actionId: string,
	payload: Record<string, string>,
	operator?: string,
): Promise<OrdersActionResult> {
	const result = await dispatchOrdersAction(actionId, payload, client, operator);
	expect(result, `${actionId} is not registered`).toBeDefined();
	return result as OrdersActionResult;
}

describe("operatorName — who the host says is signed in", () => {
	test("the display name, else the email; nothing when the host named nobody", () => {
		expect(operatorName({ name: "Ada Lovelace", email: "ada@example.test" })).toBe("Ada Lovelace");
		expect(operatorName({ name: "  ", email: "ada@example.test" })).toBe("ada@example.test");
		expect(operatorName({ name: null, email: "ada@example.test" })).toBe("ada@example.test");
		expect(operatorName(undefined)).toBeUndefined();
		expect(operatorName({ name: null, email: "" })).toBeUndefined();
	});
});

describe("status moves carry the operator", () => {
	test("Mark processing records who made it", async () => {
		const { client, calls } = surface("paid");
		await act(
			client,
			"orders:transition-processing",
			{ orderId: ORDER_ID, toState: "processing", state: "paid" },
			OPERATOR,
		);
		expect(calls.transition[0]).toEqual([
			ORDER_ID,
			"processing",
			expect.objectContaining({ actor: OPERATOR }),
		]);
	});

	test("with no operator named, the move carries no actor rather than a made-up one", async () => {
		const { client, calls } = surface("paid");
		await act(client, "orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "processing",
			state: "paid",
		});
		expect(calls.transition[0]).toEqual([
			ORDER_ID,
			"processing",
			{ idempotencyKey: expect.any(String) },
		]);
	});
});

describe("refunds and cancels are recorded by the operator", () => {
	const REFUND = {
		orderId: ORDER_ID,
		amountCents: "1000",
		refundedSoFarCents: "0",
		currency: "USD",
	};

	test("full remaining: no name typed — recorded by the operator, never 'admin'", async () => {
		const { client, calls } = surface("paid");
		await act(client, "orders:refund", REFUND, OPERATOR);
		expect(calls.refund[0]).toEqual([
			ORDER_ID,
			expect.objectContaining({ refundedBy: OPERATOR }),
			expect.anything(),
		]);
	});

	test("a typed name still wins", async () => {
		const { client, calls } = surface("paid");
		await act(client, "orders:refund", { ...REFUND, refundedBy: "carol" }, OPERATOR);
		expect(calls.refund[0]).toEqual([
			ORDER_ID,
			expect.objectContaining({ refundedBy: "carol" }),
			expect.anything(),
		]);
	});

	test("a cancel's refund is recorded by the operator", async () => {
		const { client, calls } = surface("paid");
		await act(
			client,
			"orders:cancel-customer_request",
			{ orderId: ORDER_ID, reason: "customer_request", state: "paid", restock: "true" },
			OPERATOR,
		);
		expect(calls.cancel[0]).toEqual([
			ORDER_ID,
			expect.objectContaining({ cancelledBy: OPERATOR }),
			expect.anything(),
		]);
	});
});

describe("Mark refunded while money is still held (QA2 M4)", () => {
	test("the refusal sends the operator to Money → Refunds, and nothing changed", async () => {
		const { client } = surface("shipped", {
			ok: false,
			status: 409,
			reason: "REFUND_THROUGH_MONEY",
		});
		const result = await act(
			client,
			"orders:transition-refunded",
			{ orderId: ORDER_ID, toState: "refunded", state: "shipped" },
			OPERATOR,
		);
		expect(result.notice).toMatchObject({
			variant: "error",
			title: "Refund it in Money → Refunds",
		});
		expect(result.notice?.description).toMatch(/^Nothing was changed\./);
		expect(result.notice?.description).toContain(
			"start the refund in Money → Refunds anyway: Otta checks with the provider first, issues nothing, and then lets you mark the order refunded.",
		);
	});

	test("while a refund is unresolved, the refusal says to check Money → Refunds first (review round 1)", async () => {
		const { client } = surface("shipped", { ok: false, status: 409, reason: "REFUND_IN_FLIGHT" });
		const result = await act(
			client,
			"orders:transition-refunded",
			{ orderId: ORDER_ID, toState: "refunded", state: "shipped" },
			OPERATOR,
		);
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.description).toContain(
			"A refund on this order is still unresolved — check Money → Refunds first",
		);
	});
});

describe("a refund replayed after it was recorded (QA round 2)", () => {
	function withLedger(refunds: unknown[], finalized: number) {
		const { client, calls } = surface("paid");
		client.getRefunds = () =>
			Promise.resolve({
				refunds,
				currency: "USD",
				capturedTotalCents: 1000,
				refundedTotalCents: finalized,
				finalizedTotalCents: finalized,
				ceilingCents: 1000,
				remainingCents: 1000 - finalized,
				paymentMethod: "stripe",
				refundable: true,
			}) as never;
		return { client, calls };
	}

	test("the operator's own retry of a recorded refund says it is already recorded, not that someone else refunded", async () => {
		const { client, calls } = withLedger(
			[
				{
					status: "recorded",
					amountCents: 100,
					idempotencyKey: `admin-refund:${ORDER_ID}:100:0`,
				},
			],
			100,
		);
		const result = await act(
			client,
			"orders:refund",
			{ orderId: ORDER_ID, amountCents: "100", refundedSoFarCents: "0", currency: "USD" },
			OPERATOR,
		);
		expect(calls.refund).toHaveLength(0);
		expect(result.notice).toMatchObject({ variant: "default", title: "Already refunded" });
		expect(result.notice?.description).not.toMatch(/someone else/);
	});

	test("a ledger moved by another refund says so without blaming anyone", async () => {
		const { client } = withLedger(
			[{ status: "recorded", amountCents: 300, idempotencyKey: "admin-refund:other:300:0" }],
			300,
		);
		const result = await act(
			client,
			"orders:refund",
			{ orderId: ORDER_ID, amountCents: "100", refundedSoFarCents: "0", currency: "USD" },
			OPERATOR,
		);
		expect(result.notice?.title).toBe("The refund ledger changed — nothing was refunded");
		expect(result.notice?.description).toMatch(/another tab or by someone else/);
		expect(result.notice?.description).toContain("$7.00 now remains refundable");
	});
});

describe("resolving an unverified refund (review round 2)", () => {
	function withResolve(result: unknown) {
		const { client } = surface("shipped");
		const calls: unknown[] = [];
		(client as unknown as Record<string, unknown>)["resolveUnverifiedRefund"] = (
			...args: unknown[]
		) => {
			calls.push(args);
			return Promise.resolve(result);
		};
		return { client, calls };
	}

	test("Confirmed at the provider: records the operator and the provider id, and says what happened", async () => {
		const { client, calls } = withResolve({
			ok: true,
			changed: true,
			fullyRefunded: true,
			email: "sent",
		});
		const result = await act(
			client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "k1", refundRef: " re_dash " },
			OPERATOR,
		);
		expect(calls[0]).toEqual([
			ORDER_ID,
			{ refundKey: "k1", outcome: "confirmed", refundRef: "re_dash", resolvedBy: OPERATOR },
		]);
		expect(result.notice?.title).toBe("Refund confirmed");
		expect(result.notice?.description).toMatch(/fully refunded/);
		expect(result.notice?.description).toContain("The buyer has been emailed.");
	});

	test("It didn't happen: voids it and says the amount can be refunded again", async () => {
		const { client, calls } = withResolve({ ok: true, changed: true, fullyRefunded: false });
		const result = await act(
			client,
			"orders:resolve-refund-voided",
			{ orderId: ORDER_ID, refundKey: "k1" },
			OPERATOR,
		);
		expect(calls[0]).toEqual([
			ORDER_ID,
			{ refundKey: "k1", outcome: "voided", resolvedBy: OPERATOR },
		]);
		expect(result.notice?.title).toBe("Marked as not refunded");
		expect(result.notice?.description).toMatch(/can be refunded again/);
	});

	// #364: the notice says what became of what the refund was FOR.
	test("a confirmed cancellation refund says the order is cancelled, what went back to stock, and the email", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				email: "sent",
				followUp: {
					purpose: "cancellation",
					outcome: "cancelled",
					cancelledNow: true,
					restock: true,
					restockedUnits: 2,
					restockSkipped: [],
				},
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.title).toBe("Refund confirmed and order cancelled");
		expect(result.notice?.description).toContain("the cancellation it was for is finished");
		expect(result.notice?.description).toContain("2 items returned to stock.");
		expect(result.notice?.description).toContain("The buyer has been emailed.");
	});

	test("a confirmed cancellation refund on an order that moved on is an error naming its state", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				email: "sent",
				followUp: {
					purpose: "cancellation",
					outcome: "not_cancelled",
					state: "shipped",
					flagged: true,
					refundEmailQueued: true,
				},
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.variant).toBe("error");
		expect(result.notice?.title).toBe("Refund confirmed — order not cancelled");
		expect(result.notice?.description).toContain("the order is shipped");
		expect(result.notice?.description).toContain("The order is flagged.");
		expect(result.notice?.description).toContain("Contact the buyer");
		// Already shipped: "before it ships" would be false.
		expect(result.notice?.description).not.toContain("before it ships");
		expect(result.notice?.description).toContain("Buyer emailed about the refund.");
	});

	test("a cancellation refund that didn't happen tells the operator to cancel again", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				followUp: { purpose: "cancellation", outcome: "cancel_again" },
			}).client,
			"orders:resolve-refund-voided",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.title).toBe("Marked as not refunded");
		expect(result.notice?.description).toContain("click Cancel order again");
	});

	test("a confirm whose cancel did not finish says to click Cancel order again, without refunding twice", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				followUp: { purpose: "cancellation", outcome: "cancel_again" },
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.title).toBe("Refund confirmed — finish the cancellation");
		expect(result.notice?.description).toContain("it will not refund twice");
	});

	test("late payments: confirmed resolves its flag and emails; didn't happen says to refund it", async () => {
		const done = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				email: "sent",
				followUp: { purpose: "late-payment", outcome: "finished" },
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "late-payment-refund:pi_1" },
			OPERATOR,
		);
		expect(done.notice?.description).toContain("The late payment is recorded as refunded");
		expect(done.notice?.description).toContain("The buyer has been emailed.");
		const manual = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				followUp: { purpose: "late-payment", outcome: "refund_manually", flagged: true },
			}).client,
			"orders:resolve-refund-voided",
			{ orderId: ORDER_ID, refundKey: "late-payment-refund:pi_1" },
			OPERATOR,
		);
		expect(manual.notice?.description).toContain("still held");
		expect(manual.notice?.description).toContain("refund it from Money → Refunds");
	});

	// Review round 1.
	test("a confirm REPLAY whose cancel still did not finish says to cancel again, not 'already resolved'", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: false,
				fullyRefunded: false,
				followUp: { purpose: "cancellation", outcome: "cancel_again" },
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.title).toBe("Refund confirmed — finish the cancellation");
	});

	test("an order not cancelled that could not be flagged says so, and a refund email already sent is not claimed again", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: false,
				fullyRefunded: false,
				followUp: {
					purpose: "cancellation",
					outcome: "not_cancelled",
					state: "processing",
					flagged: false,
					refundEmailQueued: false,
				},
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.description).not.toContain("The order is flagged");
		expect(result.notice?.description).toContain("could not be flagged");
		expect(result.notice?.description).toContain("before it ships");
		expect(result.notice?.description).not.toMatch(/emailed/i);
	});

	test("an order cancelled another way says the buyer gets a separate refund email", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				email: "sent",
				followUp: {
					purpose: "cancellation",
					outcome: "already_cancelled",
					refundEmailQueued: true,
				},
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.title).toBe("Refund confirmed — order was already cancelled");
		expect(result.notice?.description).not.toContain("is finished");
		expect(result.notice?.description).toContain("The buyer has been emailed.");
	});

	test("a confirmed cancellation that declined Return to stock says nothing was returned", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				email: "sent",
				followUp: {
					purpose: "cancellation",
					outcome: "cancelled",
					cancelledNow: true,
					restock: false,
					restockedUnits: 0,
					restockSkipped: [],
				},
			}).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "admin-cancel:o:refund" },
			OPERATOR,
		);
		expect(result.notice?.description).toContain("Nothing was returned to stock.");
	});

	test("a late payment marked not refunded over another open flag does not claim it flagged the order", async () => {
		const result = await act(
			withResolve({
				ok: true,
				changed: true,
				fullyRefunded: false,
				followUp: { purpose: "late-payment", outcome: "refund_manually", flagged: false },
			}).client,
			"orders:resolve-refund-voided",
			{ orderId: ORDER_ID, refundKey: "late-payment-refund:pi_1" },
			OPERATOR,
		);
		expect(result.notice?.description).not.toContain("The order is flagged");
		expect(result.notice?.description).toContain("another open flag");
	});

	test("a replay says it was already resolved; a row no longer waiting says so", async () => {
		const replay = await act(
			withResolve({ ok: true, changed: false, fullyRefunded: false }).client,
			"orders:resolve-refund-voided",
			{ orderId: ORDER_ID, refundKey: "k1" },
			OPERATOR,
		);
		expect(replay.notice?.title).toBe("Already resolved");
		const stale = await act(
			withResolve({ ok: false, status: 409, reason: "NOT_UNVERIFIED" }).client,
			"orders:resolve-refund-confirmed",
			{ orderId: ORDER_ID, refundKey: "k1" },
			OPERATOR,
		);
		expect(stale.notice?.variant).toBe("error");
		expect(stale.notice?.description).toMatch(/^Nothing was changed/);
	});
});

describe("the provider-refunded notices name the kept flag (review round 2)", () => {
	test("a refund refused as already refunded says an open flag is kept", async () => {
		const { client } = surface("paid");
		client.refundOrder = () =>
			Promise.resolve({ ok: false, status: 409, reason: "PROVIDER_ALREADY_REFUNDED" }) as never;
		const result = await act(
			client,
			"orders:refund",
			{ orderId: ORDER_ID, amountCents: "500", refundedSoFarCents: "0", currency: "USD" },
			OPERATOR,
		);
		expect(result.notice?.description).toContain(
			"the order's reconciliation flag says which — unless it already had an open flag, which is kept; resolve that one and try the refund again.",
		);
	});
});
