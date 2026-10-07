import {
	cents,
	classifyLatePayment,
	createOrderFromCart,
	currency,
	dispatchOrderEmails,
	EmailSendTimeoutError,
	expireOrders,
	idempotencyKey,
	leftPendingUnpaid,
	type Order,
	type OrderEvent,
	type OrderStore,
	orderId as brandOrderId,
	renderEmail as renderWith,
	settleOrder,
	type EmailTemplate,
} from "@otta-sh/domain";
import { FakeEmailSender } from "@otta-sh/domain/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

// Money formatting is injected; this stub shows the minor units it was handed.
const renderEmail = (template: EmailTemplate, data: Record<string, unknown>) =>
	renderWith(template, data, { formatMoney: (minor, code) => `[${code} ${String(minor)}]` });

// The fake-only half of the late-payment cure: what the shared contract cannot
// observe through the ports (anomaly rows, the dispatcher's template and data)
// plus the pure classification and the copy.

describe("late payments", () => {
	let h: OrderHarness;
	beforeEach(() => {
		h = makeOrderHarness();
	});

	async function pendingPhysical(key = "k1"): Promise<Order> {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 5,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(h.createDeps, {
			cartId,
			idempotencyKey: idempotencyKey(key),
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
		});
		if (!res.ok) throw new Error(`seed order failed: ${res.reason}`);
		return res.order;
	}

	function evt(order: Order, opts: { dedupeKey?: string; amount?: number } = {}) {
		return h.stripeGw.webhook({
			outcome: "succeeded",
			orderId: order.id,
			providerRef: `pi_${order.id}`,
			amount: opts.amount ?? order.totals.total,
			currency: "USD",
			dedupeKey: opts.dedupeKey ?? "evt-late",
		});
	}

	async function expire(): Promise<void> {
		h.clock.advance(16 * 60 * 1000);
		expect(await expireOrders(h.expireDeps)).toBe(1);
	}

	test("a late payment records ONE SETTLE_ON_NON_PENDING anomaly however often it is redelivered", async () => {
		const order = await pendingPhysical();
		await expire();
		for (let i = 0; i < 3; i++) await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		const anomalies = h.paymentEventStore.anomalies().filter((a) => a.orderId === order.id);
		expect(anomalies.map((a) => a.kind)).toEqual(["SETTLE_ON_NON_PENDING"]);
		expect(h.stripeGw.refundCalls).toHaveLength(1);
	});

	test("a success that LOSES the paid flip to a mid-flight expiry is refunded too — after the loud PAID_FLIP_LOST anomaly", async () => {
		const order = await pendingPhysical();
		h.clock.advance(16 * 60 * 1000);
		// The settle loads `pending`, then the sweep wins between load and flip.
		// Every other method is BOUND to the real store: its `#private` fields need
		// their own receiver, so a bare prototype chain would throw on first use.
		const racing = new Proxy(h.orderStore, {
			get(target, prop) {
				if (prop === "markPaid") {
					return async (id: Order["id"]) => {
						await expireOrders(h.expireDeps);
						return target.markPaid(id);
					};
				}
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === "function" ? (value as () => unknown).bind(target) : value;
			},
		}) as OrderStore;

		const res = await settleOrder({ ...h.settleDeps, orderStore: racing }, h.stripeGw, evt(order));

		expect(res.ok).toBe(true);
		const anomalies = h.paymentEventStore.anomalies().filter((a) => a.orderId === order.id);
		expect(anomalies.map((a) => a.kind)).toEqual(["PAID_FLIP_LOST"]);
		expect(h.stripeGw.refundCalls).toHaveLength(1);
		const after = await h.orderStore.getById(order.id);
		expect(after?.state).toBe("expired");
		expect(after?.reconciliationFlag).toBeNull();
		expect(after?.reconciliationResolution?.outcome).toBe("refunded");
	});

	test("the dispatcher sends the notice with its own template, to the buyer, once — stating the REFUNDED amount, not the order total", async () => {
		const order = await pendingPhysical();
		await expire();
		// A short capture: the buyer paid less than the total (an amount the settle
		// path admits on a dead order). The email must name what came back.
		await settleOrder(h.settleDeps, h.stripeGw, evt(order, { amount: 900 }));
		await settleOrder(h.settleDeps, h.stripeGw, evt(order, { amount: 900 }));
		const emailSender = new FakeEmailSender();

		await dispatchOrderEmails({ orderStore: h.orderStore, emailSender, clock: h.clock });

		expect(emailSender.countByTemplate("order-late-payment-refunded", order.id)).toBe(1);
		expect(emailSender.countByTemplate("order-expired", order.id)).toBe(1);
		const notice = emailSender.sends.find((s) => s.template === "order-late-payment-refunded");
		expect(notice?.to).toBe("buyer@example.com");
		expect(notice?.data["noticeAmountCents"]).toBe(900);
		const rendered = renderEmail("order-late-payment-refunded", notice?.data ?? {});
		expect(rendered.text).toContain("Refunded: [USD 900]");
		// The order's own total is only ever the summary's "Order total", never the
		// refunded figure.
		expect(rendered.text).not.toContain("Refunded: [USD 1500]");
	});

	test("the notice rides the sweep's bounded dispatcher like any row: handed back untried, or timed out, it is sent later — once, never parked", async () => {
		const order = await pendingPhysical();
		await expire();
		await settleOrder(h.settleDeps, h.stripeGw, evt(order));
		const sender = new FakeEmailSender();
		const late = () => sender.countByTemplate("order-late-payment-refunded", order.id);
		const drain = (options: Parameters<typeof dispatchOrderEmails>[1]) =>
			dispatchOrderEmails(
				{ orderStore: h.orderStore, emailSender: sender, clock: h.clock },
				options,
			);

		// Out of time just before the send: handed back untried (attempt not counted).
		await drain({ canSend: () => false });
		expect(late()).toBe(0);
		// A send the caller's timeout cut off: handed back uncounted, backed off.
		const timingOut = {
			send: async () => {
				throw new EmailSendTimeoutError(5_000);
			},
		};
		h.clock.advance(60 * 60 * 1000);
		await dispatchOrderEmails({ orderStore: h.orderStore, emailSender: timingOut, clock: h.clock });
		// Later, with a working provider, everything due goes out — the notice ONCE.
		for (let i = 0; i < 3; i++) {
			h.clock.advance(60 * 60 * 1000);
			await drain({});
		}
		expect(late()).toBe(1);
		expect(h.orderStore.noticesFor(order.id)).toEqual([
			{ notice: "late-payment-refunded", status: "sent" },
		]);
	});

	test("a cancelled order seeded with NO audit trail keeps the manual flag (no evidence it was unpaid)", async () => {
		h.orderStore.seedSummaryOrder({
			id: "ord-legacy",
			state: "cancelled",
			currency: "USD",
			buyerRef: "legacy@example.com",
			paymentMethod: "stripe",
			createdAt: "2026-01-01T00:00:00.000Z",
			totalCents: 1500,
		});
		const res = await settleOrder(
			h.settleDeps,
			h.stripeGw,
			h.stripeGw.webhook({
				outcome: "succeeded",
				orderId: "ord-legacy",
				providerRef: "pi_legacy",
				amount: 1500,
				currency: "USD",
				dedupeKey: "evt-legacy",
			}),
		);
		expect(res.ok).toBe(true);
		expect(h.stripeGw.refundCalls).toHaveLength(0);
		const kinds = h.paymentEventStore.anomalies().map((a) => a.kind);
		expect(kinds).toEqual(["SETTLE_ON_NON_PENDING"]);
		expect((await h.orderStore.getById(brandOrderId("ord-legacy")))?.reconciliationFlag).toBe(
			"settle on cancelled",
		);
	});
});

const USD = currency("USD");
const paid = (amount: number) => ({
	gateway: "stripe" as const,
	providerRef: "pi_1",
	amount: cents(amount),
	currency: USD,
	status: "succeeded",
});
const refund = (amount: number, status: "recorded" | "reserved" = "recorded") => ({
	amount: cents(amount),
	status,
});
const event = (fromState: OrderEvent["fromState"], toState: OrderEvent["toState"]): OrderEvent => ({
	id: `ev-${String(fromState)}-${String(toState)}`,
	orderId: brandOrderId("o"),
	at: "2026-07-10T00:00:00.000Z",
	kind: "state_change",
	fromState,
	toState,
	actor: null,
});

describe("leftPendingUnpaid — positive evidence only", () => {
	test("expired and failed are only ever entered from pending", () => {
		expect(leftPendingUnpaid("expired", [])).toBe(true);
		expect(leftPendingUnpaid("failed", [])).toBe(true);
	});

	test("cancelled needs the pending → cancelled flip in its audit", () => {
		expect(leftPendingUnpaid("cancelled", [event("pending", "cancelled")])).toBe(true);
		expect(
			leftPendingUnpaid("cancelled", [event("pending", "paid"), event("paid", "cancelled")]),
		).toBe(false);
		// Predates the audit log: no evidence either way, so no.
		expect(leftPendingUnpaid("cancelled", [])).toBe(false);
	});

	test("live and paid-family states are never late", () => {
		for (const state of ["pending", "paid", "processing", "refunded"] as const) {
			expect(leftPendingUnpaid(state, []), state).toBe(false);
		}
	});
});

describe("classifyLatePayment", () => {
	test("nothing captured on a dead order ⇒ none", () => {
		expect(classifyLatePayment({ state: "expired", events: [], payments: [], refunds: [] })).toBe(
			"none",
		);
	});

	test("captured and fully refunded ⇒ refunded", () => {
		const cases = [
			["expired", []],
			["failed", []],
			["cancelled", [event("pending", "cancelled")]],
		] as const;
		for (const [state, events] of cases) {
			expect(
				classifyLatePayment({ state, events, payments: [paid(900)], refunds: [refund(900)] }),
				state,
			).toBe("refunded");
		}
	});

	test("captured but not (yet) refunded ⇒ refund_pending — never 'nothing was charged'", () => {
		expect(
			classifyLatePayment({
				state: "expired",
				events: [],
				payments: [paid(900)],
				refunds: [refund(900, "reserved")],
			}),
		).toBe("refund_pending");
	});

	test("an order that was paid, is still live, or lacks evidence has no LATE payment", () => {
		expect(
			classifyLatePayment({
				state: "cancelled",
				events: [event("pending", "paid"), event("paid", "cancelled")],
				payments: [paid(900)],
				refunds: [],
			}),
		).toBe("none");
		expect(
			classifyLatePayment({ state: "paid", events: [], payments: [paid(900)], refunds: [] }),
		).toBe("none");
	});
});

describe("the late-payment-refunded email", () => {
	test("says the payment arrived late and was refunded — never that nothing was charged", () => {
		const email = renderEmail("order-late-payment-refunded", {
			orderId: "ord-1",
			state: "expired",
			currency: "USD",
			totalCents: 1500,
			noticeAmountCents: 1500,
			noticeCurrency: "USD",
		});
		expect(email.subject).toMatch(/refunded/i);
		expect(email.text).toMatch(/after (your|the) order expired/i);
		expect(email.text).toMatch(/5.10 (business )?days/);
		expect(email.text).toContain("Refunded: [USD 1500]");
		expect(email.text).not.toMatch(/nothing was charged/i);
	});

	test("names a cancelled or a (historical) failed order for what it is", () => {
		const base = { orderId: "o", currency: "USD", totalCents: 1500, noticeAmountCents: 1500 };
		expect(
			renderEmail("order-late-payment-refunded", { ...base, state: "cancelled" }).text,
		).toContain("after your order was cancelled");
		expect(renderEmail("order-late-payment-refunded", { ...base, state: "failed" }).text).toContain(
			"an order that had already failed",
		);
	});
});
