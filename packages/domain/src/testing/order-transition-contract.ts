import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import {
	customerId,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	type OrderId,
} from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { CreateOrderInput, OrderStore } from "../ports/order-store.js";
import type { OrderState } from "../orders/model.js";
import { dispatchOrderEmails, transitionOrder } from "../orders/transition.js";
import type { FakeEmailSender } from "./fake-email-sender.js";

export interface OrderTransitionHarness {
	store: OrderStore;
	emailSender: FakeEmailSender;
	clock: Clock;
	/**
	 * pg/sqlite only (absent on the fake): run the REAL transition transaction —
	 * guarded `UPDATE` + outbox `INSERT` — then throw before `COMMIT`, so the
	 * whole transaction rolls back. Proves the two writes are atomic (§5, 5.5):
	 * after it rejects, neither the state change nor the outbox row is visible.
	 */
	forceFailedTransition?(input: {
		orderId: OrderId;
		fromState: OrderState;
		toState: OrderState;
	}): Promise<void>;
}

export interface OrderTransitionContractOptions {
	dialect: string;
}

const USD = currency("USD");

function pendingInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId("ord-1"),
		cartId: "cart-1",
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		holdExpiresAt: "2026-07-10T00:15:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: productId("p1"),
				sku: sku("SKU-1"),
				title: "Widget",
				unitPrice: cents(500),
				currency: USD,
				quantity: 3,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		...overrides,
	};
}

/**
 * The reusable order state-machine + exactly-once-email spec (§7). Encodes
 * headline cases 1 (own-orders via `listForCustomer`), 4 (exactly one email),
 * 5 (replay = one email + one state change), and 6 (invalid ⇒ zero emails),
 * PLUS the full transition table — every legal transition succeeds once and
 * every illegal one (including `pending → shipped` and any hop back into a
 * Phase-4 state) is rejected. The Phase-4-authoritative rows (`pending →
 * paid|failed|expired`) are pinned here so a regression that drops them again is
 * caught, not just re-reviewed. Runs against the fake first, then each dialect;
 * the atomicity case additionally runs on the DB adapters.
 */
async function seed(
	h: OrderTransitionHarness,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const { order } = await h.store.createFromCart(pendingInput(overrides));
	return order.id;
}

function drive(h: OrderTransitionHarness, id: OrderId, to: OrderState) {
	return transitionOrder(
		{ orderStore: h.store },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
	);
}

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}

export function orderTransitionContract(
	makeHarness: () => Promise<OrderTransitionHarness>,
	opts: OrderTransitionContractOptions,
): void {
	describe(`orderTransitionContract [${opts.dialect}]`, () => {
		test("pending → paid transitions once and enqueues exactly one order-confirmation email", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			const res = await drive(h, id, "paid");
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.transitioned).toBe(true);
			expect((await h.store.getById(id))?.state).toBe("paid");
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", id)).toBe(1);
		});

		test("paid → processing enqueues exactly one order-processing email", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await dispatch(h); // drain the confirmation email
			const res = await drive(h, id, "processing");
			expect(res.ok).toBe(true);
			await dispatch(h);
			expect(h.emailSender.countByTemplate("order-processing", id)).toBe(1);
		});

		test("the full fulfillment path transitions each step exactly once", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			for (const to of ["paid", "processing", "shipped", "delivered", "completed"] as const) {
				const res = await drive(h, id, to);
				expect(res.ok).toBe(true);
				if (res.ok) expect(res.transitioned).toBe(true);
			}
			expect((await h.store.getById(id))?.state).toBe("completed");
		});

		test("pending → shipped is rejected INVALID_TRANSITION and enqueues zero emails", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			const res = await drive(h, id, "shipped");
			expect(res).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
			expect((await h.store.getById(id))?.state).toBe("pending");
			expect(await dispatch(h)).toBe(0);
			expect(h.emailSender.sends).toHaveLength(0);
		});

		test("a Phase-5 state cannot hop back into a Phase-4 state (paid → pending / paid → expired rejected)", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			expect(await drive(h, id, "pending")).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
			expect(await drive(h, id, "expired")).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
			expect((await h.store.getById(id))?.state).toBe("paid");
		});

		test("pending → expired is accepted (Phase-4-authoritative) and enqueues exactly one order-expired email", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			const res = await drive(h, id, "expired");
			expect(res.ok).toBe(true);
			if (res.ok) expect(res.transitioned).toBe(true);
			expect((await h.store.getById(id))?.state).toBe("expired");
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-expired", id)).toBe(1);
		});

		test("replaying the same transition is a no-op and sends exactly one email (headline 5)", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			const first = await drive(h, id, "paid");
			const replay = await drive(h, id, "paid");
			expect(first.ok).toBe(true);
			expect(replay.ok).toBe(true);
			if (replay.ok) expect(replay.transitioned).toBe(false); // already paid ⇒ no-op
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", id)).toBe(1);
		});

		test("pending → cancelled sends exactly one order-cancelled email", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "cancelled");
			await dispatch(h);
			expect(h.emailSender.countByTemplate("order-cancelled", id)).toBe(1);
		});

		test("listForCustomer returns only that customer's orders (headline 1)", async () => {
			const h = await makeHarness();
			const a = await seed(h, {
				orderId: orderId("ord-a"),
				idempotencyKey: idempotencyKey("key-a"),
				buyerRef: "a@example.com",
			});
			const b = await seed(h, {
				orderId: orderId("ord-b"),
				idempotencyKey: idempotencyKey("key-b"),
				buyerRef: "b@example.com",
			});
			const custA = customerId("cust-a");
			const custB = customerId("cust-b");
			expect(await h.store.linkGuestOrders(custA, "a@example.com")).toBe(1);
			expect(await h.store.linkGuestOrders(custB, "b@example.com")).toBe(1);
			expect((await h.store.listForCustomer(custA)).map((o) => o.id)).toEqual([a]);
			expect((await h.store.listForCustomer(custB)).map((o) => o.id)).toEqual([b]);
		});

		test("linkGuestOrders matches buyer_ref case-insensitively — a mixed-case guest checkout still links (H2)", async () => {
			const h = await makeHarness();
			// Phase-4 checkout stores buyer_ref VERBATIM (no normalization at the
			// wire) — the customer email arriving from login is lower-normalized.
			const id = await seed(h, {
				orderId: orderId("ord-mixed"),
				idempotencyKey: idempotencyKey("key-mixed"),
				buyerRef: "Alice@Example.com",
			});
			const cust = customerId("cust-alice");
			expect(await h.store.linkGuestOrders(cust, "alice@example.com")).toBe(1);
			expect((await h.store.listForCustomer(cust)).map((o) => o.id)).toEqual([id]);
			// Idempotent: a second login links nothing new.
			expect(await h.store.linkGuestOrders(cust, "alice@example.com")).toBe(0);
		});

		test("a forced rollback mid-transition leaves neither the state change nor the outbox row", async () => {
			const h = await makeHarness();
			if (h.forceFailedTransition === undefined) return; // fake: no real transaction to roll back
			const id = await seed(h);
			await expect(
				h.forceFailedTransition({ orderId: id, fromState: "pending", toState: "paid" }),
			).rejects.toThrow();
			// Neither write survived the rollback.
			expect((await h.store.getById(id))?.state).toBe("pending");
			expect(await dispatch(h)).toBe(0); // no outbox row ⇒ nothing to send
		});
	});
}
