/**
 * The console's notices say what became of the buyer's email — TRULY (QA T1-6).
 *
 * The writes used to answer "the buyer has been emailed" while the email sat in the
 * outbox for up to 15 minutes. Each admin write now sends it inline and reports
 * `email: "sent" | "queued" | "unconfigured" | "no-recipient"` (absent when it enqueued
 * none), and these cases pin that the copy follows that value and nothing else:
 * "emailed" only when it was sent, "queued and will be retried automatically" when it
 * was not yet (no time promise: the cron's retry can be backed off), "no email" when
 * the store has no provider, and "no email address" when the order has none to send
 * to (a hand-seeded or legacy buyerRef without `@`) — never "queued" for an email that will
 * never go. The inline send itself is pinned over a
 * real store in `admin-order-emails-inline.test.ts`.
 */
import { describe, expect, test } from "vitest";
import type {
	AdminOrdersSurface,
	InlineEmailStatus,
	OrderDetailResult,
} from "../src/admin/admin-orders-surface.js";
import { dispatchOrdersAction, type OrdersActionResult } from "../src/admin/orders-actions.js";

const ORDER_ID = "order-email-copy";

const SENT = "The buyer has been emailed.";
const QUEUED = "The buyer’s email is queued and will be retried automatically.";
const UNCONFIGURED = "No email was sent — this store has no email provider set up.";
const NO_RECIPIENT = "No email was sent — this order has no email address.";

function refuse(method: string) {
	return (): never => {
		throw new Error(`${method} must not be called here`);
	};
}

/** A surface whose order sits in `state` and whose writes report `email`. */
function surface(state: string, email: InlineEmailStatus | undefined): AdminOrdersSurface {
	const detail: OrderDetailResult = {
		order: { id: ORDER_ID, state } as OrderDetailResult["order"],
		allowedTransitions: [],
	};
	const withEmail = email === undefined ? {} : { email };
	return {
		getOrder: () => Promise.resolve(detail),
		transitionOrder: () => Promise.resolve({ ok: true, transitioned: true, ...withEmail }),
		recordFulfillment: () => Promise.resolve({ ok: true, recorded: true, ...withEmail }),
		cancelOrder: () =>
			Promise.resolve({
				ok: true,
				cancelled: true,
				refund: { amountCents: 2400, currency: "USD" },
				restockedUnits: 1,
				...withEmail,
			}),
		getRefunds: () =>
			Promise.resolve({
				refunds: [],
				currency: "USD",
				capturedTotalCents: 2400,
				refundedTotalCents: 0,
				finalizedTotalCents: 0,
				ceilingCents: 2400,
				remainingCents: 2400,
				paymentMethod: "stripe",
				settlement: "gateway",
				refundable: true,
				providerCaptured: true,
			}),
		refundOrder: () =>
			Promise.resolve({
				ok: true,
				recorded: true,
				duplicate: false,
				fullyRefunded: false,
				...withEmail,
			}),
		listOrders: refuse("listOrders"),
		resolveReconciliation: refuse("resolveReconciliation"),
		getCustomerContext: refuse("getCustomerContext"),
		getTimeline: refuse("getTimeline"),
		listNotes: refuse("listNotes"),
		addNote: refuse("addNote"),
		resolveUnverifiedRefund: refuse("resolveUnverifiedRefund"),
		revokeDownloadAccess: refuse("revokeDownloadAccess"),
	};
}

async function act(
	client: AdminOrdersSurface,
	actionId: string,
	payload: Record<string, string>,
): Promise<OrdersActionResult> {
	const result = await dispatchOrdersAction(actionId, payload, client);
	expect(result, `${actionId} is not registered`).toBeDefined();
	return result as OrdersActionResult;
}

const WRITES: ReadonlyArray<{
	name: string;
	state: string;
	actionId: string;
	payload: Record<string, string>;
}> = [
	{
		name: "a status move",
		state: "paid",
		actionId: "orders:transition-processing",
		payload: { orderId: ORDER_ID, toState: "processing", state: "paid" },
	},
	{
		name: "a fulfilment",
		state: "processing",
		actionId: "orders:record-fulfillment",
		payload: { orderId: ORDER_ID, carrier: "UPS", trackingNumber: "1Z", recordedBy: "carol" },
	},
	{
		name: "a cancel",
		state: "paid",
		actionId: "orders:cancel-customer_request",
		payload: { orderId: ORDER_ID, reason: "customer_request", state: "paid", restock: "true" },
	},
	{
		name: "a partial refund",
		state: "paid",
		actionId: "orders:refund",
		payload: {
			orderId: ORDER_ID,
			amountCents: "500",
			refundedSoFarCents: "0",
			currency: "USD",
			refundedBy: "carol",
		},
	},
];

describe("each admin write's notice states what became of the buyer's email", () => {
	for (const write of WRITES) {
		test(`${write.name}: "emailed" only when the email was sent`, async () => {
			const sent = await act(surface(write.state, "sent"), write.actionId, write.payload);
			// (The fulfilment's reads "…emailed their tracking.")
			expect(sent.notice?.description).toContain("The buyer has been emailed");

			const queued = await act(surface(write.state, "queued"), write.actionId, write.payload);
			expect(queued.notice?.description).toContain(QUEUED);
			expect(queued.notice?.description).not.toContain("has been emailed");

			const none = await act(surface(write.state, "unconfigured"), write.actionId, write.payload);
			expect(none.notice?.description).toContain(UNCONFIGURED);
			expect(none.notice?.description).not.toContain("has been emailed");

			const nobody = await act(surface(write.state, "no-recipient"), write.actionId, write.payload);
			expect(nobody.notice?.description).toContain(NO_RECIPIENT);
			expect(nobody.notice?.description).not.toContain("has been emailed");
			expect(nobody.notice?.description).not.toContain("queued");
		});
	}

	test("a status move that emails nobody (Mark refunded) says so and claims no email", async () => {
		const result = await act(surface("paid", undefined), "orders:transition-refunded", {
			orderId: ORDER_ID,
			toState: "refunded",
			state: "paid",
		});
		// The mark-paid guard's own notice (ADR-0026 Decision 3), unchanged by C.
		expect(result.notice).toEqual({
			variant: "default",
			title: "Marked refunded",
			description: "No money moved and the buyer was not emailed.",
		});
	});

	test("a status move names the state it moved the order to", async () => {
		const result = await act(surface("paid", "sent"), "orders:transition-processing", {
			orderId: ORDER_ID,
			toState: "processing",
			state: "paid",
		});
		expect(result.notice).toEqual({
			variant: "default",
			title: "Order marked processing",
			description: SENT,
		});
	});

	// ADR-0044: the cash-on-delivery moves read as what they mean.
	describe("cash on delivery", () => {
		/** `surface`, its order a COD (offline) one, its fulfilment reporting `state`. */
		function codSurface(
			state: string,
			email: InlineEmailStatus | undefined,
			shippedTo?: string,
		): AdminOrdersSurface {
			const base = surface(state, email);
			return {
				...base,
				getOrder: () =>
					Promise.resolve({
						order: { id: ORDER_ID, state, settlement: "offline" } as OrderDetailResult["order"],
						allowedTransitions: [],
					}),
				recordFulfillment: () =>
					Promise.resolve({
						ok: true,
						recorded: true,
						...(email === undefined ? {} : { email }),
						...(shippedTo === undefined ? {} : { state: shippedTo }),
					}),
			};
		}

		test("a move to shipped_awaiting_payment: 'Order marked shipped — cash due on delivery'", async () => {
			const result = await act(
				codSurface("awaiting_payment", "sent"),
				"orders:transition-shipped_awaiting_payment",
				{ orderId: ORDER_ID, toState: "shipped_awaiting_payment", state: "awaiting_payment" },
			);
			expect(result.notice).toEqual({
				variant: "default",
				title: "Order marked shipped — cash due on delivery",
				description: SENT,
			});
		});

		test("Record shipment of an unpaid COD order says the cash is due", async () => {
			const result = await act(
				codSurface("awaiting_payment", "sent", "shipped_awaiting_payment"),
				"orders:record-fulfillment",
				{ orderId: ORDER_ID, carrier: "UPS", trackingNumber: "1Z", recordedBy: "carol" },
			);
			expect(result.notice?.title).toBe("Order marked shipped — cash due on delivery");
		});

		test.each([
			["awaiting_payment", "paid"],
			["shipped_awaiting_payment", "delivered"],
		])(
			"Mark paid from %s (→ %s) says 'Payment recorded', with the email status",
			async (from, to) => {
				const result = await act(codSurface(from, "sent"), `orders:transition-${to}`, {
					orderId: ORDER_ID,
					toState: to,
					state: from,
				});
				expect(result.notice).toEqual({
					variant: "default",
					title: "Payment recorded",
					description: `The cash payment is recorded on the order. ${SENT}`,
				});
				// Even with no email to report, the payment is stated.
				const quiet = await act(codSurface(from, undefined), `orders:transition-${to}`, {
					orderId: ORDER_ID,
					toState: to,
					state: from,
				});
				expect(quiet.notice?.title).toBe("Payment recorded");
			},
		);

		test("a card order's move to delivered keeps its plain copy", async () => {
			const result = await act(surface("shipped", "sent"), "orders:transition-delivered", {
				orderId: ORDER_ID,
				toState: "delivered",
				state: "shipped",
			});
			expect(result.notice?.title).toBe("Order marked delivered");
		});
	});

	test("a cancel's notice keeps its email status even with a long not-restocked list", async () => {
		// The email sentence comes BEFORE the skipped-SKU list, and the list is capped,
		// so fitting the banner can never cut off what became of the buyer's email.
		const skipped = Array.from({ length: 30 }, (_, i) => ({
			sku: `VERY-LONG-SKU-NUMBER-${String(i).padStart(3, "0")}`,
			quantity: 1,
			reason: "UNKNOWN_SKU",
		}));
		const client = {
			...surface("paid", "queued"),
			cancelOrder: () =>
				Promise.resolve({
					ok: true as const,
					cancelled: true,
					refund: { amountCents: 2400, currency: "USD" },
					restockedUnits: 0,
					restockSkipped: skipped,
					email: "queued" as const,
				}),
		};
		const result = await act(client, "orders:cancel-customer_request", {
			orderId: ORDER_ID,
			reason: "customer_request",
			state: "paid",
			restock: "true",
		});
		const description = String(result.notice?.description);
		expect(description).toContain(QUEUED);
		expect(description.indexOf(QUEUED)).toBeLessThan(description.indexOf("VERY-LONG-SKU"));
		expect(description).toMatch(/and \d+ more/);
	});
});
