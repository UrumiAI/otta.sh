import {
	cents,
	currency,
	dispatchOrderEmails,
	dispatchOrderEmailsForOrder,
	idempotencyKey,
	orderId,
	productId,
	reservationId,
	sku,
	transitionOrder,
	type CreateOrderInput,
	type OrderState,
} from "@otta-sh/domain";
import {
	EmailSendTimeoutError,
	EmailTransportUnavailableError,
	type EmailSender,
	isEmailSendTimeoutError,
	isEmailTransportUnavailableError,
	MAX_UNCOUNTED_TIMEOUTS,
	TIMEOUT_BACKOFF_BASE_MS,
	TIMEOUT_BACKOFF_MAX_MS,
	TRANSPORT_UNAVAILABLE_RETRY_MS,
	UNTRIED_RETRY_MS,
} from "@otta-sh/domain";
import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryOrderStore,
} from "@otta-sh/domain/testing";
import { describe, expect, test } from "vitest";

// Step 5.3: EmailSender port + FakeEmailSender + outbox-backed transition, all
// against fakes — the exactly-once assertions (headline cases 4–6).

const USD = currency("USD");

function harness() {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const store = new InMemoryOrderStore({ idGen: new CountingIdGen("oi"), clock });
	const emailSender = new FakeEmailSender();
	return { store, clock, emailSender };
}

function pending(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
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
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: reservationId("res-1"),
			},
		],
		totals: { subtotal: cents(500), total: cents(500), currency: USD },
		...overrides,
	};
}

async function drive(store: InMemoryOrderStore, id: string, to: OrderState) {
	return transitionOrder(
		{ orderStore: store },
		{
			orderId: orderId(id),
			toState: to,
			idempotencyKey: idempotencyKey(`t:${id}:${to}`),
		},
	);
}

describe("a state email after a partial refund states the refund (QA round 2)", () => {
	test("the processing email carries what the ledger shows refunded so far", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "paid");
		await store.recordPayment({
			orderId: orderId("ord-1"),
			gateway: "stripe",
			providerRef: "pi_1",
			amount: cents(500),
			currency: USD,
			status: "succeeded",
		});
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		await store.recordRefund({
			orderId: orderId("ord-1"),
			amount: cents(200),
			currency: USD,
			kind: "gateway",
			gateway: "stripe",
			refundRef: "re_1",
			reason: null,
			refundedBy: "ops",
			idempotencyKey: idempotencyKey("r-1"),
		});
		await drive(store, "ord-1", "processing");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		const processing = emailSender.sends.find((s) => s.template === "order-processing");
		expect(processing?.data).toMatchObject({ refundedSoFarCents: 200 });
	});

	test("with nothing refunded, the field is absent", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "paid");
		await drive(store, "ord-1", "processing");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		const processing = emailSender.sends.find((s) => s.template === "order-processing");
		expect(processing?.data).not.toHaveProperty("refundedSoFarCents");
	});
});

describe("outbox-backed transition emails (5.3)", () => {
	test("paid to processing enqueues exactly one order-processing email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "paid");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock }); // drain confirmation
		await drive(store, "ord-1", "processing");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.countByTemplate("order-processing", "ord-1")).toBe(1);
	});

	test("the same transition applied twice sends exactly one email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "paid");
		await drive(store, "ord-1", "paid"); // redelivery / double admin call
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		await dispatchOrderEmails({ orderStore: store, emailSender, clock }); // second tick, nothing new
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
		expect(store.outboxFor("ord-1")).toHaveLength(1);
	});

	test("an invalid transition enqueues zero emails", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		const res = await drive(store, "ord-1", "delivered"); // illegal from pending
		expect(res.ok).toBe(false);
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.sends).toHaveLength(0);
		expect(store.outboxFor("ord-1")).toHaveLength(0);
	});

	test("pending to expired enqueues exactly one order-expired email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await drive(store, "ord-1", "expired");
		expect(await dispatchOrderEmails({ orderStore: store, emailSender, clock })).toBe(1);
		expect(emailSender.countByTemplate("order-expired", "ord-1")).toBe(1);
	});

	test("markPaid (the Phase-4 flip) also enqueues a confirmation email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		expect(await store.markPaid(orderId("ord-1"))).toBe(true);
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
	});

	test("pending → failed is not a transition any more (ADR-0022): refused, and no email", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		expect(await drive(store, "ord-1", "failed")).toEqual({
			ok: false,
			reason: "INVALID_TRANSITION",
		});
		expect((await store.getById(orderId("ord-1")))?.state).toBe("pending");
		await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(emailSender.sends).toHaveLength(0);
	});
});

// The dispatcher runs inside the plugin's time-boxed cron tick. A stop must land
// BEFORE a claim, never after one: a claimed-then-abandoned row would sit leased
// (and unsent) for the whole lease instead of going out on the next tick.
describe("dispatchOrderEmails under a tick budget", () => {
	test("shouldContinue is asked before each claim; unclaimed rows go out next run", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.createFromCart(
			pending({
				orderId: orderId("ord-2"),
				cartId: "cart-2",
				idempotencyKey: idempotencyKey("key-2"),
				lines: [
					{
						productId: productId("p1"),
						sku: sku("SKU-1"),
						title: "Widget",
						unitPrice: cents(500),
						currency: USD,
						quantity: 1,
						fulfillmentKind: "physical",
						reservationId: reservationId("res-2"),
					},
				],
			}),
		);
		await drive(store, "ord-1", "paid");
		await drive(store, "ord-2", "paid");

		let asked = 0;
		const first = await dispatchOrderEmails(
			{ orderStore: store, emailSender, clock },
			{ shouldContinue: () => asked++ < 1 },
		);
		expect(first).toBe(1);

		// The second row was never claimed, so it is due NOW, not after a lease.
		const second = await dispatchOrderEmails({ orderStore: store, emailSender, clock });
		expect(second).toBe(1);
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
		expect(emailSender.countByTemplate("order-confirmation", "ord-2")).toBe(1);
	});
});

// The sweep's two refinements to the drain. A row is claimed, then its order and
// customer are read, and only then sent — and the cron tick may have run out of
// time in between. And a send cut off by the sweep's own timeout says nothing
// about the row: the provider was never given the time to answer.
describe("dispatchOrderEmails: what does NOT count as an attempt", () => {
	async function paidOrder() {
		const h = harness();
		await h.store.createFromCart(pending());
		await drive(h.store, "ord-1", "paid");
		return h;
	}

	test("canSend is asked just before the send; a refusal hands the row back uncounted and ends the drain", async () => {
		const { store, clock, emailSender } = await paidOrder();
		const sent = await dispatchOrderEmails(
			{ orderStore: store, emailSender, clock },
			{ canSend: () => false },
		);
		expect(sent).toBe(0);
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(0);
		// Backed off only briefly, so it cannot hold the head of the queue: not due
		// now, due after the short untried backoff — its attempt count untouched,
		// and no timeout recorded (the provider was never asked).
		const lease = new Date(clock.now().getTime() + 60_000).toISOString();
		expect(await store.claimNextEmail(clock.now().toISOString(), lease)).toBeNull();
		clock.advance(UNTRIED_RETRY_MS);
		const later = new Date(clock.now().getTime() + 60_000).toISOString();
		expect(await store.claimNextEmail(clock.now().toISOString(), later)).toMatchObject({
			attempts: 1,
			timeouts: 0,
		});
	});

	test("a refused (untried) row does not block a later row from going out", async () => {
		const { store, clock } = harness();
		await store.createFromCart(pending());
		await store.createFromCart(
			pending({
				orderId: orderId("ord-2"),
				cartId: "cart-2",
				idempotencyKey: idempotencyKey("key-2"),
			}),
		);
		await drive(store, "ord-1", "paid");
		await drive(store, "ord-2", "paid");
		const sender = new FakeEmailSender();
		// The first run had no time to send ord-1 (first in line)…
		await dispatchOrderEmails(
			{ orderStore: store, emailSender: sender, clock },
			{ canSend: () => false },
		);
		// …the next run, same moment, sends ord-2 rather than retrying ord-1 first.
		expect(await dispatchOrderEmails({ orderStore: store, emailSender: sender, clock })).toBe(1);
		expect(sender.countByTemplate("order-confirmation", "ord-2")).toBe(1);
	});

	test("no email provider (EmailTransportUnavailableError): the row is released, no attempt used, the drain stops", async () => {
		const { store, clock } = await paidOrder();
		const noProvider: EmailSender = {
			send: () => Promise.reject(new EmailTransportUnavailableError()),
		};
		let unavailable = 0;
		for (let n = 0; n < 15; n++) {
			expect(
				await dispatchOrderEmails(
					{ orderStore: store, emailSender: noProvider, clock },
					{ maxAttempts: 3, onTransportUnavailable: () => unavailable++ },
				),
			).toBe(0);
			clock.advance(TRANSPORT_UNAVAILABLE_RETRY_MS);
		}
		expect(unavailable).toBe(15);
		// However often: never counted, never timed out, never parked.
		expect(store.outboxEntry("ord-1")).toMatchObject({
			status: "pending",
			attempts: 0,
			timeouts: 0,
		});
		// Backed off: not due again until the provider back-off has passed.
		await dispatchOrderEmails({ orderStore: store, emailSender: noProvider, clock });
		const lease = new Date(clock.now().getTime() + 60_000).toISOString();
		expect(await store.claimNextEmail(clock.now().toISOString(), lease)).toBeNull();
		// Once a provider is there, the same row goes out on its first counted attempt.
		clock.advance(TRANSPORT_UNAVAILABLE_RETRY_MS);
		const sender = new FakeEmailSender();
		expect(await dispatchOrderEmails({ orderStore: store, emailSender: sender, clock })).toBe(1);
		expect(sender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
		expect(store.outboxEntry("ord-1")).toMatchObject({ status: "sent", attempts: 1 });
	});

	test("the no-provider error is recognised structurally, across a bridge", () => {
		expect(isEmailTransportUnavailableError(new EmailTransportUnavailableError())).toBe(true);
		expect(isEmailTransportUnavailableError({ name: "EmailTransportUnavailableError" })).toBe(true);
		expect(isEmailTransportUnavailableError(new Error("no provider"))).toBe(false);
		expect(isEmailTransportUnavailableError(null)).toBe(false);
	});

	test("a send the CALLER cut short (less than its full cap) is not the provider's fault: due now, no timeout recorded", async () => {
		const { store, clock } = await paidOrder();
		const cutShort = {
			async send(): Promise<void> {
				throw new EmailSendTimeoutError(800, { cutShort: true });
			},
		};
		for (let n = 0; n < 15; n++) {
			await dispatchOrderEmails(
				{ orderStore: store, emailSender: cutShort, clock },
				{ maxAttempts: 3 },
			);
		}
		// Never backed off, never counted, never parked — however often.
		expect(store.outboxEntry("ord-1")).toMatchObject({
			status: "pending",
			attempts: 0,
			timeouts: 0,
		});
		const lease = new Date(clock.now().getTime() + 60_000).toISOString();
		expect(await store.claimNextEmail(clock.now().toISOString(), lease)).not.toBeNull();
	});

	test("a timed-out row BACKS OFF, so it cannot sit at the head of the queue and starve the rows behind it", async () => {
		const { store, clock } = harness();
		await store.createFromCart(pending());
		await store.createFromCart(
			pending({
				orderId: orderId("ord-2"),
				cartId: "cart-2",
				idempotencyKey: idempotencyKey("key-2"),
			}),
		);
		await drive(store, "ord-1", "paid");
		await drive(store, "ord-2", "paid");
		const sent: string[] = [];
		const sender = timingOutFor("ord-1", sent);

		// ord-1 is first in line; it times out, and the drain stops.
		expect(await dispatchOrderEmails({ orderStore: store, emailSender: sender, clock })).toBe(0);
		// Next run, SAME moment: ord-1 is backed off, so ord-2 goes out.
		expect(await dispatchOrderEmails({ orderStore: store, emailSender: sender, clock })).toBe(1);
		expect(sent).toEqual(["ord-2"]);
		// And ord-1 is due again after its first backoff (one minute).
		clock.advance(TIMEOUT_BACKOFF_BASE_MS);
		const lease = new Date(clock.now().getTime() + 60_000).toISOString();
		const again = await store.claimNextEmail(clock.now().toISOString(), lease);
		expect(again?.orderId).toBe(orderId("ord-1"));
		expect(again?.attempts).toBe(1); // the timeout cost no attempt
		expect(again?.timeouts).toBe(1);
	});

	test("timeouts are uncounted up to the limit; past it each is REPORTED and counted, and the row parks with its reason", async () => {
		const { store, clock } = await paidOrder();
		const sent: string[] = [];
		const sender = timingOutFor("ord-1", sent);
		const reported: number[] = [];
		const run = () =>
			dispatchOrderEmails(
				{ orderStore: store, emailSender: sender, clock },
				{ maxAttempts: 3, onRepeatedTimeouts: (row) => reported.push(row.timeouts) },
			);

		for (let n = 1; n <= MAX_UNCOUNTED_TIMEOUTS; n++) {
			await run();
			clock.advance(TIMEOUT_BACKOFF_MAX_MS);
		}
		expect(reported).toEqual([]);
		expect(store.outboxEntry("ord-1")?.attempts).toBe(0);
		expect(store.outboxEntry("ord-1")?.timeouts).toBe(MAX_UNCOUNTED_TIMEOUTS);

		// The next timeouts are reported (alertable) AND counted, until the row parks.
		for (let n = 0; n < 3; n++) {
			await run();
			clock.advance(TIMEOUT_BACKOFF_MAX_MS);
		}
		expect(reported).toHaveLength(3);
		expect(store.outboxEntry("ord-1")).toMatchObject({
			status: "failed",
			failureReason: "provider kept timing out",
		});
	});

	test("the timeout error is recognised structurally, across a bridge", () => {
		expect(isEmailSendTimeoutError(new EmailSendTimeoutError(10))).toBe(true);
		expect(isEmailSendTimeoutError({ name: "EmailSendTimeoutError" })).toBe(true);
		expect(isEmailSendTimeoutError(new Error("boom"))).toBe(false);
		expect(new EmailSendTimeoutError(10).cutShort).toBe(false);
		expect(new EmailSendTimeoutError(10, { cutShort: true }).cutShort).toBe(true);
	});
});

/** A sender that times out for one order and delivers every other. */
function timingOutFor(orderIdText: string, sent: string[]) {
	return {
		async send(input: { data: Record<string, unknown> }): Promise<void> {
			if (String(input.data.orderId) === orderIdText) throw new EmailSendTimeoutError(1500);
			sent.push(String(input.data.orderId));
		},
	};
}
// The order-scoped dispatcher the payment-settle route calls inline (ADR-0005's
// 2026-10-02 amendment). It shares `dispatchOrderEmails`' send / mark / reschedule
// body; what differs is only WHICH rows it may claim — one order's, never the queue.
describe("dispatchOrderEmailsForOrder — one order, inline", () => {
	test("sends only the named order's due email; the other order waits for the cron", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.createFromCart(
			pending({ orderId: orderId("ord-2"), idempotencyKey: idempotencyKey("key-2") }),
		);
		await store.markPaid(orderId("ord-1"));
		await store.markPaid(orderId("ord-2"));

		const deps = { orderStore: store, emailSender, clock };
		expect(await dispatchOrderEmailsForOrder(deps, orderId("ord-2"))).toBe(1);
		expect(emailSender.sends.map((s) => s.data["orderId"])).toEqual(["ord-2"]);
		// The idempotency key is the outbox row id, exactly as on the cron path — it is
		// what dedupes an inline send and a later cron re-send provider-side.
		expect(emailSender.sends[0]?.idempotencyKey).toMatch(/\S/);
		expect(store.outboxFor("ord-1")).toEqual([{ toState: "paid", status: "pending" }]);
		expect(store.outboxFor("ord-2")).toEqual([{ toState: "paid", status: "sent" }]);
	});

	test("a replay sends nothing — the row is already sent", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.markPaid(orderId("ord-1"));
		const deps = { orderStore: store, emailSender, clock };
		expect(await dispatchOrderEmailsForOrder(deps, orderId("ord-1"))).toBe(1);
		expect(await dispatchOrderEmailsForOrder(deps, orderId("ord-1"))).toBe(0);
		expect(await dispatchOrderEmails(deps)).toBe(0); // and the cron finds nothing either
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
	});

	test("a failed send backs the row off by the caller's lease; the cron delivers it after", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.markPaid(orderId("ord-1"));
		const deps = { orderStore: store, emailSender, clock };

		emailSender.failNextSends(1);
		expect(await dispatchOrderEmailsForOrder(deps, orderId("ord-1"), { leaseMs: 60_000 })).toBe(0);
		expect(store.outboxFor("ord-1")).toEqual([{ toState: "paid", status: "pending" }]);
		// Backed off: not due inside the lease, for either dispatcher.
		expect(await dispatchOrderEmails(deps)).toBe(0);
		// The short lease is the point: the backstop picks it up a minute later, not five.
		clock.advance(60_000);
		expect(await dispatchOrderEmails(deps)).toBe(1);
		expect(emailSender.countByTemplate("order-confirmation", "ord-1")).toBe(1);
	});

	test("onSent reports each row it sent, in order — a failed one is not reported", async () => {
		// The admin console reports "emailed" only for a row that was really sent
		// (QA T1-6), so the caller needs WHICH rows, not just how many.
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.markPaid(orderId("ord-1"));
		await transitionOrder(
			{ orderStore: store },
			{
				orderId: orderId("ord-1"),
				toState: "processing",
				idempotencyKey: idempotencyKey("t:ord-1:processing"),
			},
		);
		const sent: OrderState[] = [];
		const deps = { orderStore: store, emailSender, clock };
		emailSender.failNextSends(1);
		await dispatchOrderEmailsForOrder(deps, orderId("ord-1"), {
			onSent: (row) => sent.push(row.toState),
		});
		// The confirmation failed (backed off for the cron); processing went out.
		expect(sent).toEqual(["processing"]);
	});

	test("an order with nothing due is a zero, not an error", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending()); // still pending — no outbox row
		const deps = { orderStore: store, emailSender, clock };
		expect(await dispatchOrderEmailsForOrder(deps, orderId("ord-1"))).toBe(0);
		expect(await dispatchOrderEmailsForOrder(deps, orderId("ord-unknown"))).toBe(0);
		expect(emailSender.sends).toHaveLength(0);
	});

	test("onlyUnattempted: a row a previous dispatch already tried is left to the cron", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.markPaid(orderId("ord-1"));
		const deps = { orderStore: store, emailSender, clock };

		emailSender.failNextSends(1);
		expect(
			await dispatchOrderEmailsForOrder(deps, orderId("ord-1"), {
				leaseMs: 60_000,
				onlyUnattempted: true,
			}),
		).toBe(0);
		clock.advance(60_000); // the backoff has lapsed — the row is due again
		expect(
			await dispatchOrderEmailsForOrder(deps, orderId("ord-1"), { onlyUnattempted: true }),
		).toBe(0);
		expect(emailSender.sends).toHaveLength(0);
		// Its retry is the cron's — with the budget it would have had.
		expect(await dispatchOrderEmails(deps)).toBe(1);
	});

	test("shouldContinue() false stops the drain before the next claim — nothing new is claimed", async () => {
		const { store, clock, emailSender } = harness();
		await store.createFromCart(pending());
		await store.markPaid(orderId("ord-1"));
		const deps = { orderStore: store, emailSender, clock };
		expect(
			await dispatchOrderEmailsForOrder(deps, orderId("ord-1"), { shouldContinue: () => false }),
		).toBe(0);
		// Never claimed: still a first attempt for whoever comes next.
		expect(
			await store.claimNextEmailForOrder(
				orderId("ord-1"),
				clock.now().toISOString(),
				clock.now().toISOString(),
			),
		).toMatchObject({ attempts: 1 });
	});
});

/** An instant `ms` past the harness clock, as the ISO string the store takes. */
function due(h: { clock: FixedClock }, ms = 0): string {
	return new Date(h.clock.now().getTime() + ms).toISOString();
}

// The order-scoped drain is the SAME body as the global one (only the claim differs),
// so every sweep-cadence and late-payment semantic must hold for it too.
describe("dispatchOrderEmailsForOrder shares the drain's semantics", () => {
	async function paid() {
		const h = harness();
		await h.store.createFromCart(pending());
		await h.store.markPaid(orderId("ord-1"));
		return { ...h, deps: { orderStore: h.store, emailSender: h.emailSender, clock: h.clock } };
	}

	test("canSend false hands the row back untried, behind the short untried backoff", async () => {
		const h = await paid();
		expect(
			await dispatchOrderEmailsForOrder(h.deps, orderId("ord-1"), { canSend: () => false }),
		).toBe(0);
		expect(
			await h.store.claimNextEmailForOrder(orderId("ord-1"), due(h), due(h, 60_000)),
		).toBeNull();
		expect(
			await h.store.claimNextEmailForOrder(
				orderId("ord-1"),
				due(h, UNTRIED_RETRY_MS),
				due(h, UNTRIED_RETRY_MS + 60_000),
				{ onlyUnattempted: true },
			),
		).toMatchObject({ attempts: 1, timeouts: 0 });
	});

	test("a CUT-SHORT timeout is released uncounted and due at once — still a first attempt", async () => {
		const h = await paid();
		const cut: EmailSender = {
			send: () => Promise.reject(new EmailSendTimeoutError(800, { cutShort: true })),
		};
		expect(
			await dispatchOrderEmailsForOrder({ ...h.deps, emailSender: cut }, orderId("ord-1"), {
				onlyUnattempted: true,
			}),
		).toBe(0);
		expect(
			await h.store.claimNextEmailForOrder(orderId("ord-1"), due(h), due(h, 60_000), {
				onlyUnattempted: true,
			}),
		).toMatchObject({ attempts: 1, timeouts: 0 });
	});

	test("a GENUINE timeout backs the row off and records it; the inline path then leaves it to the cron", async () => {
		const h = await paid();
		const slow: EmailSender = { send: () => Promise.reject(new EmailSendTimeoutError(3_000)) };
		await dispatchOrderEmailsForOrder({ ...h.deps, emailSender: slow }, orderId("ord-1"), {
			onlyUnattempted: true,
		});
		h.clock.advance(TIMEOUT_BACKOFF_BASE_MS);
		expect(
			await dispatchOrderEmailsForOrder(h.deps, orderId("ord-1"), { onlyUnattempted: true }),
		).toBe(0);
		expect(await dispatchOrderEmails(h.deps)).toBe(1); // the cron's retry
	});

	test("a NOTICE row renders its own template and figure through the order-scoped drain", async () => {
		const h = harness();
		await h.store.createFromCart(pending());
		await drive(h.store, "ord-1", "expired");
		await dispatchOrderEmails({ orderStore: h.store, emailSender: h.emailSender, clock: h.clock });
		await h.store.enqueueNotice(orderId("ord-1"), {
			kind: "late-payment-refunded",
			amount: cents(450),
			currency: USD,
		});
		expect(
			await dispatchOrderEmailsForOrder(
				{ orderStore: h.store, emailSender: h.emailSender, clock: h.clock },
				orderId("ord-1"),
				{ onlyUnattempted: true },
			),
		).toBe(1);
		const notice = h.emailSender.sends.at(-1)!;
		expect(notice.template).not.toBe("order-expired");
		expect(notice.data).toMatchObject({ noticeAmountCents: 450, noticeCurrency: "USD" });
	});
});
