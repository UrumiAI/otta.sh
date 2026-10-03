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
import {
	dispatchOrderEmails,
	dispatchOrderEmailsForOrder,
	transitionOrder,
	transitionOrderAsAdmin,
} from "../orders/transition.js";
import { PROVIDER_REFUNDED_FLAG_PREFIX } from "../orders/provider-refunded-flag.js";
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
 * paid|expired`) are pinned here so a regression that drops them again is
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

function adminDrive(h: OrderTransitionHarness, id: OrderId, to: OrderState) {
	return transitionOrderAsAdmin(
		{ orderStore: h.store },
		{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`a:${id}:${to}`) },
	);
}

function dispatch(h: OrderTransitionHarness) {
	return dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
}

/** Far past any lease a case sets — "long after". */
const LATER = "2099-01-01T00:00:00.000Z";

/** A claim instant at the harness clock (where `transition` stamped the row due) and
 *  a five-minute lease past it — the dispatcher's own defaults, not literals that
 *  could fall before a harness's clock. */
function claimWindow(h: OrderTransitionHarness): { now: string; lease: string } {
	const now = h.clock.now();
	return {
		now: now.toISOString(),
		lease: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
	};
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

		// -- the order-scoped claim (the settle path's inline dispatch) ----------
		//
		// `claimNextEmailForOrder` is `claimNextEmail` narrowed to ONE order: the same
		// due predicate, the same lease, the same single-winner compare-and-set. It
		// exists so a request (the payment-settle route) can send the order it just
		// settled without ever touching the global drain, which is the cron's.

		test("claimNextEmailForOrder claims that order's due row and never another order's", async () => {
			const h = await makeHarness();
			const a = await seed(h, {
				orderId: orderId("ord-a"),
				idempotencyKey: idempotencyKey("key-a"),
			});
			const b = await seed(h, {
				orderId: orderId("ord-b"),
				idempotencyKey: idempotencyKey("key-b"),
			});
			await drive(h, a, "paid");
			await drive(h, b, "paid");
			const { now, lease } = claimWindow(h);

			const claimed = await h.store.claimNextEmailForOrder(b, now, lease);
			expect(claimed).toMatchObject({ orderId: b, toState: "paid", attempts: 1 });
			// b has nothing else due; a's row is still there, untouched, for the cron.
			expect(await h.store.claimNextEmailForOrder(b, now, lease)).toBeNull();
			const global = await h.store.claimNextEmail(now, lease);
			expect(global).toMatchObject({ orderId: a, toState: "paid", attempts: 1 });
			expect(await h.store.claimNextEmail(now, lease)).toBeNull();
		});

		test("claimNextEmailForOrder is null for an order with nothing due: none enqueued, unknown, sent", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			const { now, lease } = claimWindow(h);
			// Still pending: no transition, no outbox row.
			expect(await h.store.claimNextEmailForOrder(id, now, lease)).toBeNull();
			expect(await h.store.claimNextEmailForOrder(orderId("ord-missing"), now, lease)).toBeNull();
			await drive(h, id, "paid");
			const row = await h.store.claimNextEmailForOrder(id, now, lease);
			expect(row).not.toBeNull();
			await h.store.markEmailSent(row!.id, now);
			// Sent is terminal — even long after any lease would have lapsed.
			expect(await h.store.claimNextEmailForOrder(id, LATER, LATER)).toBeNull();
		});

		test("claimNextEmailForOrder respects a live lease and reclaims once it lapses", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const { now, lease } = claimWindow(h);
			const first = await h.store.claimNextEmailForOrder(id, now, lease);
			expect(first).not.toBeNull();
			// Leased (a crashed or still-running dispatcher holds it): neither the scoped
			// claim nor the global one may take it.
			expect(await h.store.claimNextEmailForOrder(id, now, lease)).toBeNull();
			expect(await h.store.claimNextEmail(now, lease)).toBeNull();
			// Lapsed: claimable again, attempts counting the reclaim.
			const reclaimed = await h.store.claimNextEmailForOrder(id, lease, LATER);
			expect(reclaimed?.id).toBe(first?.id);
			expect(reclaimed?.attempts).toBe(2);
		});

		test("claimNextEmailForOrder is null for a row parked failed (retries exhausted)", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const { now, lease } = claimWindow(h);
			const row = await h.store.claimNextEmailForOrder(id, now, lease);
			expect(row).not.toBeNull();
			await h.store.rescheduleEmail(row!.id, null); // parked `failed`
			expect(await h.store.claimNextEmailForOrder(id, LATER, LATER)).toBeNull();
			expect(await h.store.claimNextEmail(LATER, LATER)).toBeNull();
		});

		test("onlyUnattempted claims a never-attempted row, and never one a dispatcher already tried", async () => {
			// The inline (request) path claims ONLY first attempts, so redeliveries during a
			// provider outage cannot spend the retry budget. An attempted row stays
			// claimable by the cron's global claim — and by the unrestricted scoped claim.
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const { now, lease } = claimWindow(h);

			const first = await h.store.claimNextEmailForOrder(id, now, lease, { onlyUnattempted: true });
			expect(first).toMatchObject({ orderId: id, attempts: 1 });
			// A failed send returns it to pending, due NOW — so only `attempts` stands in the way.
			await h.store.rescheduleEmail(first!.id, now);

			expect(
				await h.store.claimNextEmailForOrder(id, now, lease, { onlyUnattempted: true }),
			).toBeNull();
			const retried = await h.store.claimNextEmail(now, lease);
			expect(retried).toMatchObject({ id: first!.id, attempts: 2 });
		});

		test("onlyUnattempted never undercuts the cron's backoff: not before a future due time, never after a timeout", async () => {
			// An UNCOUNTED timeout hands the row back with `attempts` at 0 — but it is the
			// cron's to retry, on the cron's backoff. The inline claim must skip it even
			// once that backoff has lapsed, and must never take a backed-off row early.
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const { now, lease } = claimWindow(h);
			const at = (ms: number) => new Date(h.clock.now().getTime() + ms).toISOString();

			const first = await h.store.claimNextEmail(now, lease);
			expect(first).not.toBeNull();
			await h.store.releaseEmailClaim(first!.id, { retryAt: at(60_000), timedOut: true });

			// Backed off: due in a minute — not claimable inline, or at all, before then.
			expect(
				await h.store.claimNextEmailForOrder(id, at(59_000), at(120_000), {
					onlyUnattempted: true,
				}),
			).toBeNull();
			// Due again — but it has timed out once, so it is the cron's, not the request's.
			expect(
				await h.store.claimNextEmailForOrder(id, at(60_000), at(120_000), {
					onlyUnattempted: true,
				}),
			).toBeNull();
			expect(await h.store.claimNextEmail(at(60_000), at(120_000))).toMatchObject({
				id: first!.id,
				attempts: 1,
				timeouts: 1,
			});
		});

		test("onlyUnattempted: a row handed back untried keeps its future due time, then is a first attempt again", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const { now, lease } = claimWindow(h);
			const at = (ms: number) => new Date(h.clock.now().getTime() + ms).toISOString();

			const first = await h.store.claimNextEmailForOrder(id, now, lease, { onlyUnattempted: true });
			await h.store.releaseEmailClaim(first!.id, { retryAt: at(30_000) }); // untried
			expect(
				await h.store.claimNextEmailForOrder(id, at(29_000), at(90_000), {
					onlyUnattempted: true,
				}),
			).toBeNull();
			expect(
				await h.store.claimNextEmailForOrder(id, at(30_000), at(90_000), {
					onlyUnattempted: true,
				}),
			).toMatchObject({ id: first!.id, attempts: 1, timeouts: 0 });
		});

		test("claimNextEmailForOrder returns a NOTICE row with its payload, like the global claim", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "expired");
			const { now, lease } = claimWindow(h);
			// Drain the expiry email first so the notice is the only due row.
			const expiry = await h.store.claimNextEmailForOrder(id, now, lease);
			await h.store.markEmailSent(expiry!.id, now);
			expect(
				await h.store.enqueueNotice(id, {
					kind: "late-payment-refunded",
					amount: cents(1500),
					currency: USD,
				}),
			).toBe(true);
			const later = new Date(h.clock.now().getTime() + 1_000).toISOString();
			expect(
				await h.store.claimNextEmailForOrder(id, later, LATER, { onlyUnattempted: true }),
			).toMatchObject({
				orderId: id,
				attempts: 1,
				timeouts: 0,
				notice: { kind: "late-payment-refunded", amount: 1500, currency: "USD" },
			});
		});

		test("concurrent claimNextEmailForOrder calls on the same row yield exactly one winner", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const { now, lease } = claimWindow(h);
			// The settle route and a cron tick (or two settle deliveries) racing for the
			// same row: the compare-and-set lets one through, the other re-reads a leased
			// entry and reports nothing to do.
			const results = await Promise.all([
				h.store.claimNextEmailForOrder(id, now, lease),
				h.store.claimNextEmailForOrder(id, now, lease),
				h.store.claimNextEmail(now, lease),
			]);
			expect(results.filter((r) => r !== null)).toHaveLength(1);
		});

		test("dispatchOrderEmailsForOrder sends that order's email once and leaves other orders to the cron", async () => {
			const h = await makeHarness();
			const a = await seed(h, {
				orderId: orderId("ord-a"),
				idempotencyKey: idempotencyKey("key-a"),
			});
			const b = await seed(h, {
				orderId: orderId("ord-b"),
				idempotencyKey: idempotencyKey("key-b"),
			});
			await drive(h, a, "paid");
			await drive(h, b, "paid");
			const deps = { orderStore: h.store, emailSender: h.emailSender, clock: h.clock };

			expect(await dispatchOrderEmailsForOrder(deps, b)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", b)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", a)).toBe(0);
			// Replay: already sent, nothing due.
			expect(await dispatchOrderEmailsForOrder(deps, b)).toBe(0);
			// The cron drain then delivers a's — and does not re-send b's.
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", a)).toBe(1);
			expect(h.emailSender.countByTemplate("order-confirmation", b)).toBe(1);
		});

		// -- the admin's status moves (transitionOrderAsAdmin) -------------------

		for (const method of ["stripe", "x402", null] as const) {
			test(`the admin cannot mark a ${String(method)} order paid — no offline method exists to settle by hand`, async () => {
				// Fails CLOSED: only a payment method DECLARED offline may be marked paid by
				// hand, and none is today. A gateway order is settled by its gateway; an
				// order with no method on file has nothing that could have been paid.
				const h = await makeHarness();
				const id = await seed(h, { paymentMethod: method });
				const res = await adminDrive(h, id, "paid");
				expect(res).toEqual({ ok: false, reason: "MANUAL_PAYMENT_NOT_ALLOWED" });
				expect((await h.store.getById(id))?.state).toBe("pending");
				// Nothing was enqueued: no "we've received your payment" for money nobody saw.
				expect(await dispatch(h)).toBe(0);
			});
		}

		for (const from of ["pending", "paid", "processing"] as const) {
			test(`a bare admin → cancelled on a ${from} order is refused — Cancel order records why`, async () => {
				// A bare transition records no reason, releases no adopted hold (only expiry
				// records a release intent) and, on a paid order, keeps the money with a
				// "cancelled" email (QA T1-4). Cancel order is the one path; refused in the
				// domain, whatever a hand-made request sends.
				const h = await makeHarness();
				const id = await seed(h);
				if (from !== "pending") await drive(h, id, "paid");
				if (from === "processing") await drive(h, id, "processing");
				await dispatch(h);
				h.emailSender.reset();
				expect(await adminDrive(h, id, "cancelled")).toEqual({ ok: false, reason: "USE_CANCEL" });
				expect((await h.store.getById(id))?.state).toBe(from);
				expect(await dispatch(h)).toBe(0);
			});
		}

		test("an admin Mark refunded moves the state but emails the buyer nothing", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await dispatch(h);
			h.emailSender.reset();
			const res = await adminDrive(h, id, "refunded");
			expect(res).toMatchObject({ ok: true, transitioned: true });
			expect((await h.store.getById(id))?.state).toBe("refunded");
			// Bookkeeping only: no money moved, so no "your order has been refunded".
			expect(await dispatch(h)).toBe(0);
			expect(h.emailSender.countByTemplate("order-refunded", id)).toBe(0);
			// The move is still audited like any other.
			const events = await h.store.listEventsForOrder(id);
			expect(events.at(-1)).toMatchObject({ fromState: "paid", toState: "refunded" });
		});

		// QA2 M4 (ADR-0026, amended 2026-10-03): Mark refunded closed a Stripe order
		// that still held captured money the ledger never returned, and the buyer's
		// page then said "refunded". Refused in the domain unless nothing is left
		// to refund through the provider, the provider itself reported the payment
		// refunded, or the method returns money outside Otta.
		async function capture(h: OrderTransitionHarness, id: OrderId, gateway: "stripe" | "x402") {
			await h.store.recordPayment({
				orderId: id,
				gateway,
				providerRef: `pay_${id}`,
				amount: cents(1500),
				currency: USD,
				status: "succeeded",
			});
		}

		test("an admin Mark refunded on a Stripe order with captured, unrefunded money is refused", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await capture(h, id, "stripe");
			// A partial refund through the ledger still leaves money to return.
			await h.store.recordRefund({
				orderId: id,
				amount: cents(400),
				currency: USD,
				kind: "gateway",
				gateway: "stripe",
				refundRef: "re_part",
				reason: null,
				refundedBy: "admin@example.test",
				idempotencyKey: idempotencyKey(`part:${id}`),
			});
			expect(await adminDrive(h, id, "refunded")).toEqual({
				ok: false,
				reason: "REFUND_THROUGH_MONEY",
			});
			expect((await h.store.getById(id))?.state).toBe("paid");
		});

		// Review round 1: a reserved or unverified refund is a promise, not money back —
		// an unverified full refund that later voids would otherwise have let Mark
		// refunded close an order whose money the shop still holds.
		for (const status of ["reserved", "unverified"] as const) {
			test(`Mark refunded is refused REFUND_IN_FLIGHT while a refund is ${status}`, async () => {
				const h = await makeHarness();
				const id = await seed(h);
				await drive(h, id, "paid");
				await capture(h, id, "stripe");
				const key = idempotencyKey(`inflight:${id}`);
				await h.store.reserveRefund({
					orderId: id,
					amount: cents(1500),
					currency: USD,
					kind: "gateway",
					gateway: "stripe",
					refundRef: null,
					reason: null,
					refundedBy: "ops",
					idempotencyKey: key,
				});
				if (status === "unverified") await h.store.markRefundUnverified(key);
				expect(await adminDrive(h, id, "refunded")).toEqual({
					ok: false,
					reason: "REFUND_IN_FLIGHT",
				});
				expect((await h.store.getById(id))?.state).toBe("paid");
			});
		}

		test("an unverified refund resolved as 'it didn't happen' leaves Mark refunded guarded by the money still held", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await capture(h, id, "stripe");
			const key = idempotencyKey(`void-unv:${id}`);
			await h.store.reserveRefund({
				orderId: id,
				amount: cents(1500),
				currency: USD,
				kind: "gateway",
				gateway: "stripe",
				refundRef: null,
				reason: null,
				refundedBy: "ops",
				idempotencyKey: key,
			});
			await h.store.markRefundUnverified(key);
			expect(await h.store.voidUnverifiedRefund({ idempotencyKey: key, resolvedBy: "ops" })).toBe(
				true,
			);
			expect(await adminDrive(h, id, "refunded")).toEqual({
				ok: false,
				reason: "REFUND_THROUGH_MONEY",
			});
		});

		test("Mark refunded is allowed once the provider itself reported the payment refunded (the refund ledger's flag)", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await capture(h, id, "stripe");
			await h.store.flagReconciliation(id, `${PROVIDER_REFUNDED_FLAG_PREFIX} — test`);
			expect(await adminDrive(h, id, "refunded")).toMatchObject({ ok: true, transitioned: true });
		});

		test("Mark refunded is allowed for a method that returns money outside Otta (x402)", async () => {
			const h = await makeHarness();
			const id = await seed(h, { paymentMethod: "x402" });
			await drive(h, id, "paid");
			await capture(h, id, "x402");
			expect(await adminDrive(h, id, "refunded")).toMatchObject({ ok: true, transitioned: true });
		});

		test("an admin move records WHO made it on the audit event", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			const res = await transitionOrderAsAdmin(
				{ orderStore: h.store },
				{
					orderId: id,
					toState: "processing",
					idempotencyKey: idempotencyKey(`who:${id}`),
					actor: "ops@example.test",
				},
			);
			expect(res).toMatchObject({ ok: true, transitioned: true });
			const events = await h.store.listEventsForOrder(id);
			expect(events.at(-1)).toMatchObject({
				fromState: "paid",
				toState: "processing",
				actor: "ops@example.test",
			});
		});

		test("every other admin move emails the buyer exactly as a transition does", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await dispatch(h);
			const res = await adminDrive(h, id, "processing");
			expect(res).toMatchObject({ ok: true, transitioned: true });
			expect(await dispatch(h)).toBe(1);
			expect(h.emailSender.countByTemplate("order-processing", id)).toBe(1);
		});

		test("an admin move replayed is a no-op, and an illegal one is refused", async () => {
			const h = await makeHarness();
			const id = await seed(h);
			await drive(h, id, "paid");
			await dispatch(h);
			await adminDrive(h, id, "processing");
			expect(await adminDrive(h, id, "processing")).toMatchObject({
				ok: true,
				transitioned: false,
			});
			expect(await adminDrive(h, id, "pending")).toEqual({
				ok: false,
				reason: "INVALID_TRANSITION",
			});
			expect(await dispatch(h)).toBe(1);
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
