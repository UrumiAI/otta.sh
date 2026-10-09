/**
 * The admin console's writes send the buyer's email AT ONCE, and report whether it
 * really went (QA T1-6; ADR-0005's second 2026-10-02 amendment).
 *
 * Before, every admin transition, cancel, fulfilment and refund only ENQUEUED its
 * email, and the cron sent it up to 15 minutes later — out of order when several
 * were due — while the console said "the buyer has been emailed". Now each write
 * that enqueues an email ends with `sendOrderEmailsNow` for that order, and its
 * result carries `email`:
 *
 *  - `sent`         — the email this write enqueued went out;
 *  - `queued`       — it did not (the provider failed, or the wait ran out); the
 *                     cron retries it automatically;
 *  - `unconfigured` — this bundle has no email provider, so nothing will be sent;
 *  - `no-recipient` — the order has no email address (its `buyerRef` is
 *                     a hand-seeded or legacy buyerRef without `@`), so nothing was or will be sent;
 *  - absent         — the write enqueued no email (a replay, or Mark refunded).
 *
 * Driven over a REAL document store through `InProcessAdminOrdersClient`, with the
 * inline send's sender injected (the seam the settle routes' suites use).
 */
import {
	cents,
	dispatchOrderEmails,
	PROVIDER_REFUNDED_FLAG_PREFIX,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	latePaymentRefundKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type OrderId,
} from "@otta-sh/domain";
import { FakeEmailSender, FakePaymentGateway } from "@otta-sh/domain/testing";
import { EmdashOrderStore } from "@otta-sh/store-emdash";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { InProcessAdminOrdersClient } from "../src/admin/in-process-admin-orders-client.js";
import type { SendOrderEmailsNowOptions } from "../src/email/send-order-emails-now.js";
import { SETTLE_REQUEST_BUDGET_MS } from "../src/settle-deadline.js";
import type { PluginContext, StorageAccess } from "../src/types.js";
import { busyStorage } from "./helpers/busy-storage.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const USD = toCurrency("USD");
const FAR = "2099-01-01T00:00:00.000Z";
/** A buyer whose reference is a hand-seeded or legacy buyerRef without `@`, not an email address. */
const WALLET_BUYER = {
	buyerRef: "wallet:0x1111111111111111111111111111111111111111",
	paymentMethod: "stripe",
} as const;

let harness: InProcessCommerceHarness;
const gateways = { stripe: new FakePaymentGateway({ id: "stripe" }) };

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce({ gateways });
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

/** A PAID card order with its $15.00 captured — `markPaid` enqueues its
 *  confirmation, exactly as a settlement does. */
async function seedPaid(
	id: string,
	buyer: { buyerRef: string; paymentMethod: "stripe" } = {
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
	},
): Promise<OrderId> {
	const oid = toOrderId(id);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: USD,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: FAR,
		buyerRef: buyer.buyerRef,
		paymentMethod: buyer.paymentMethod,
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Widget",
				unitPrice: cents(1500),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
	});
	await harness.stores.orderStore.markPaid(oid);
	await harness.stores.orderStore.recordPayment({
		orderId: oid,
		gateway: buyer.paymentMethod,
		providerRef: `pi_${id}`,
		amount: cents(1500),
		currency: USD,
		status: "succeeded",
	});
	return oid;
}

function adminClient(
	orderEmails: Omit<SendOrderEmailsNowOptions, "deadline">,
): InProcessAdminOrdersClient {
	return new InProcessAdminOrdersClient(harness.ctx, { gateways, orderEmails });
}

// Review round 2: an unverified refund is resolved by a person.
async function unverified(id: OrderId, key: string, amount: number) {
	await harness.stores.orderStore.reserveRefund({
		orderId: id,
		amount: cents(amount),
		currency: USD,
		kind: "gateway",
		gateway: "stripe",
		refundRef: null,
		reason: null,
		refundedBy: "admin",
		idempotencyKey: toIdempotencyKey(key),
	});
	await harness.stores.orderStore.markRefundUnverified(toIdempotencyKey(key));
}

describe("an admin write sends its email at once, in order", () => {
	test("status moves go out immediately and in the order they were made", async () => {
		const id = await seedPaid("ord-moves");
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });

		expect(await orders.transitionOrder(id, "processing", { idempotencyKey: "k-proc" })).toEqual({
			ok: true,
			transitioned: true,
			email: "sent",
		});
		for (const [to, key] of [
			["shipped", "k-ship"],
			["delivered", "k-dlv"],
		] as const) {
			expect(await orders.transitionOrder(id, to, { idempotencyKey: key })).toEqual({
				ok: true,
				transitioned: true,
				email: "sent",
			});
		}
		// The confirmation the settlement left unsent goes first, then each move —
		// never the cron's 15-minute batch, out of order.
		expect(sender.sends.map((s) => s.template)).toEqual([
			"order-confirmation",
			"order-processing",
			"order-shipped",
			"order-delivered",
		]);
	});

	test("a replayed move enqueued nothing, so it reports no email", async () => {
		const id = await seedPaid("ord-replay");
		const orders = adminClient({ emailSender: new FakeEmailSender() });
		await orders.transitionOrder(id, "processing", { idempotencyKey: "k-1" });
		expect(await orders.transitionOrder(id, "processing", { idempotencyKey: "k-1" })).toEqual({
			ok: true,
			transitioned: false,
		});
	});

	test("Mark refunded emails nobody and says so by reporting no email", async () => {
		const id = await seedPaid("ord-markref");
		// Refunded outside Otta, as the provider reported (QA2 M4): the only way a
		// Stripe order with captured money may be marked refunded.
		await harness.stores.orderStore.flagReconciliation(
			id,
			`${PROVIDER_REFUNDED_FLAG_PREFIX} — test`,
		);
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		expect(await orders.transitionOrder(id, "refunded", { idempotencyKey: "k-r" })).toEqual({
			ok: true,
			transitioned: true,
		});
		expect(sender.countByTemplate("order-refunded", id)).toBe(0);
	});

	test("Mark refunded is neither offered nor accepted while captured money is unrefunded (QA2 M4)", async () => {
		const id = await seedPaid("ord-markref-held");
		const orders = adminClient({ emailSender: new FakeEmailSender() });
		expect((await orders.getOrder(id))?.allowedTransitions).not.toContain("refunded");
		expect(await orders.transitionOrder(id, "refunded", { idempotencyKey: "k-held" })).toEqual({
			ok: false,
			status: 409,
			reason: "REFUND_THROUGH_MONEY",
		});
		expect((await harness.stores.orderStore.getById(id))?.state).toBe("paid");
	});

	test("a status move records the operator who made it (History's Who)", async () => {
		const id = await seedPaid("ord-actor");
		const orders = adminClient({ emailSender: new FakeEmailSender() });
		await orders.transitionOrder(id, "processing", {
			idempotencyKey: "k-actor",
			actor: "ops@example.test",
		});
		const events = await harness.stores.orderStore.listEventsForOrder(id);
		expect(events.at(-1)).toMatchObject({ toState: "processing", actor: "ops@example.test" });
	});

	test("an unverified refund confirmed at the provider is recorded, closes the order and sends the refunded email now", async () => {
		const id = await seedPaid("ord-unv-confirm");
		await unverified(id, "k-unv-1", 1500);
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		expect(
			await orders.resolveUnverifiedRefund(id, {
				refundKey: "k-unv-1",
				outcome: "confirmed",
				refundRef: "re_dash",
				resolvedBy: "ops@example.test",
			}),
		).toEqual({ ok: true, changed: true, fullyRefunded: true, email: "sent" });
		expect(sender.countByTemplate("order-refunded", id)).toBe(1);
		expect((await harness.stores.orderStore.getById(id))?.state).toBe("refunded");
	});

	test("an unverified refund that didn't happen is voided, emails nobody, and a reserved one cannot be resolved", async () => {
		const id = await seedPaid("ord-unv-void");
		await unverified(id, "k-unv-2", 500);
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		expect(
			await orders.resolveUnverifiedRefund(id, {
				refundKey: "k-unv-2",
				outcome: "voided",
				resolvedBy: "ops",
			}),
		).toEqual({ ok: true, changed: true, fullyRefunded: false });
		expect(sender.sends.filter((s) => s.template !== "order-confirmation")).toHaveLength(0);
		await harness.stores.orderStore.reserveRefund({
			orderId: id,
			amount: cents(100),
			currency: USD,
			kind: "gateway",
			gateway: "stripe",
			refundRef: null,
			reason: null,
			refundedBy: "admin",
			idempotencyKey: toIdempotencyKey("k-unv-3"),
		});
		expect(
			await orders.resolveUnverifiedRefund(id, {
				refundKey: "k-unv-3",
				outcome: "voided",
				resolvedBy: "ops",
			}),
		).toEqual({ ok: false, status: 409, reason: "NOT_UNVERIFIED" });
	});

	// #364: confirming a refund finishes what it was FOR, and sends THAT email now.
	test("confirming a cancellation's timed-out refund finishes the cancel and sends the cancelled email now — not a refund email", async () => {
		const id = await seedPaid("ord-unv-cxl");
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		gateways.stripe.setRefundResult({ ok: false, reason: "UNVERIFIED" });
		try {
			expect(
				await orders.cancelOrder(
					id,
					{ reason: "customer_request", cancelledBy: "ops" },
					{ idempotencyKey: `admin-cancel:${id}` },
				),
			).toMatchObject({ ok: false, reason: "REFUND_FAILED" });
		} finally {
			gateways.stripe.clearRefundResult();
		}
		const calls = gateways.stripe.refundCalls.length;

		expect(
			await orders.resolveUnverifiedRefund(id, {
				refundKey: `admin-cancel:${id}:refund`,
				outcome: "confirmed",
				resolvedBy: "ops@example.test",
			}),
		).toEqual({
			ok: true,
			changed: true,
			fullyRefunded: false,
			email: "sent",
			followUp: {
				purpose: "cancellation",
				outcome: "cancelled",
				cancelledNow: true,
				restock: true,
				restockedUnits: 0,
				restockSkipped: [],
				restockPending: false,
			},
		});
		expect((await harness.stores.orderStore.getById(id))?.state).toBe("cancelled");
		expect(sender.countByTemplate("order-cancelled", id)).toBe(1);
		expect(sender.countByTemplate("order-refund-issued", id)).toBe(0);
		expect(gateways.stripe.refundCalls.length, "no second provider call").toBe(calls);
	});

	test("confirming a late payment's timed-out refund sends its late-payment notice now", async () => {
		const oid = toOrderId("ord-unv-late");
		await harness.stores.orderStore.createFromCart({
			orderId: oid,
			cartId: null,
			currency: USD,
			idempotencyKey: toIdempotencyKey("seed-ord-unv-late"),
			holdExpiresAt: FAR,
			buyerRef: "buyer@example.com",
			paymentMethod: "stripe",
			lines: [],
			totals: { subtotal: cents(1500), total: cents(1500), currency: USD },
		});
		await harness.stores.orderStore.transition({
			orderId: oid,
			fromState: "pending",
			toState: "expired",
			idempotencyKey: toIdempotencyKey("expire-ord-unv-late"),
			enqueueEmail: false,
		});
		await harness.stores.orderStore.recordPayment({
			orderId: oid,
			gateway: "stripe",
			providerRef: "pi_late",
			amount: cents(1500),
			currency: USD,
			status: "succeeded",
		});
		const key = latePaymentRefundKey("pi_late");
		await harness.stores.orderStore.reserveRefund({
			orderId: oid,
			amount: cents(1500),
			currency: USD,
			kind: "gateway",
			gateway: "stripe",
			refundRef: null,
			reason: "payment arrived after the order was expired",
			refundedBy: "otta:auto-refund",
			idempotencyKey: key,
			purpose: "late-payment",
		});
		await harness.stores.orderStore.markRefundUnverified(key);
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });

		expect(
			await orders.resolveUnverifiedRefund(oid, {
				refundKey: key,
				outcome: "confirmed",
				resolvedBy: "ops",
			}),
		).toEqual({
			ok: true,
			changed: true,
			fullyRefunded: false,
			email: "sent",
			followUp: { purpose: "late-payment", outcome: "finished" },
		});
		expect(sender.countByTemplate("order-late-payment-refunded", oid)).toBe(1);
		expect(sender.countByTemplate("order-refund-issued", oid)).toBe(0);
	});

	test("fulfilment sends the shipped email with its tracking", async () => {
		const id = await seedPaid("ord-ship");
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		await orders.transitionOrder(id, "processing", { idempotencyKey: "k-p" });
		const res = await orders.recordFulfillment(
			id,
			{ carrier: "UPS", trackingNumber: "1Z999", recordedBy: "carol" },
			{ idempotencyKey: "k-ship" },
		);
		expect(res).toEqual({ ok: true, recorded: true, email: "sent" });
		const shipped = sender.sends.find((s) => s.template === "order-shipped");
		expect(shipped?.data["fulfillment"]).toMatchObject({ trackingNumber: "1Z999" });
	});

	test("a cancel sends the cancelled email, which states the refund", async () => {
		const id = await seedPaid("ord-cancel");
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		const res = await orders.cancelOrder(
			id,
			{ reason: "customer_request", cancelledBy: "carol" },
			{ idempotencyKey: "k-c" },
		);
		expect(res).toMatchObject({ ok: true, cancelled: true, email: "sent" });
		const cancelled = sender.sends.find((s) => s.template === "order-cancelled");
		expect(cancelled?.data["cancellation"]).toMatchObject({
			refund: { amountCents: 1500, currency: "USD" },
		});
	});

	test("a PARTIAL refund sends a refund email stating the amount refunded, not the total", async () => {
		const id = await seedPaid("ord-partial");
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		const res = await orders.refundOrder(
			id,
			{ amountCents: 400, currency: "USD", refundedBy: "carol" },
			{ idempotencyKey: "k-rf" },
		);
		expect(res).toEqual({
			ok: true,
			recorded: true,
			duplicate: false,
			fullyRefunded: false,
			email: "sent",
		});
		const mail = sender.sends.find((s) => s.template === "order-refund-issued");
		expect(mail?.data["noticeAmountCents"]).toBe(400);
	});

	test("the refund that completes it sends the refunded email with the total refunded", async () => {
		const id = await seedPaid("ord-full");
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		const res = await orders.refundOrder(
			id,
			{ amountCents: 1500, currency: "USD", refundedBy: "carol" },
			{ idempotencyKey: "k-full" },
		);
		expect(res).toMatchObject({ ok: true, fullyRefunded: true, email: "sent" });
		const mail = sender.sends.find((s) => s.template === "order-refunded");
		expect(mail?.data["noticeAmountCents"]).toBe(1500);
	});
});

describe("the console is told the truth when the email did not go", () => {
	test("a failing provider leaves the email queued for the cron — and the write still succeeds", async () => {
		const id = await seedPaid("ord-failing");
		const sender = new FakeEmailSender();
		sender.failNextSends(10);
		const orders = adminClient({ emailSender: sender });
		expect(await orders.transitionOrder(id, "processing", { idempotencyKey: "k" })).toEqual({
			ok: true,
			transitioned: true,
			email: "queued",
		});
		expect((await orders.getOrder(id))?.order.state).toBe("processing");
	});

	test("the inline wait is budgeted from the START of the admin write, not from after it", async () => {
		// The write itself (a Stripe refund, a cancel) can take most of the budget; the
		// email must not then wait a full budget on top. Each write fixes its ONE
		// deadline as it starts (settle-deadline.ts); a write that has already spent it
		// skips the inline attempt, and says the email is queued.
		const id = await seedPaid("ord-budget");
		const sender = new FakeEmailSender();
		let calls = 0;
		const orders = new InProcessAdminOrdersClient(harness.ctx, {
			gateways,
			orderEmails: { emailSender: sender },
			// The write's start reads 0; every later reading is past the request budget.
			now: () => (calls++ === 0 ? 0 : SETTLE_REQUEST_BUDGET_MS),
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await orders.transitionOrder(id, "processing", { idempotencyKey: "k" })).toEqual({
			ok: true,
			transitioned: true,
			email: "queued",
		});
		expect(sender.sends).toHaveLength(0);
	});

	test("an order with no email address (a wallet-id buyer) reports no-recipient — never queued — and sends nothing", async () => {
		const id = await seedPaid("ord-wallet", WALLET_BUYER);
		const sender = new FakeEmailSender();
		const orders = adminClient({ emailSender: sender });
		expect(await orders.transitionOrder(id, "processing", { idempotencyKey: "k" })).toEqual({
			ok: true,
			transitioned: true,
			email: "no-recipient",
		});
		expect(sender.sends).toEqual([]);
		// Answered before any claim: the rows are the cron's, whose drain completes them
		// as skipped — and still sends nothing.
		const cron = new FakeEmailSender();
		expect(
			await dispatchOrderEmails({
				orderStore: harness.stores.orderStore,
				emailSender: cron,
				clock: { now: () => new Date(FAR) },
			}),
		).toBe(0);
		expect(cron.sends).toEqual([]);
		expect(await harness.stores.orderStore.claimNextEmailForOrder(id, FAR, FAR)).toBeNull();
	});

	test("no-recipient is answered before the time budget and the provider check — never queued or unconfigured", async () => {
		const spent = await seedPaid("ord-wallet-late", WALLET_BUYER);
		let calls = 0;
		const late = new InProcessAdminOrdersClient(harness.ctx, {
			gateways,
			orderEmails: { emailSender: new FakeEmailSender() },
			// The write's start reads 0; every later reading is past the request budget.
			now: () => (calls++ === 0 ? 0 : SETTLE_REQUEST_BUDGET_MS),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await late.transitionOrder(spent, "processing", { idempotencyKey: "k" })).toEqual({
			ok: true,
			transitioned: true,
			email: "no-recipient",
		});
		// No "the cron sweep will take it" line for an email that will never go. (The
		// spy may carry an earlier case's calls, so only this order's are checked.)
		expect(warn.mock.calls.flat().join(" ")).not.toContain(spent);

		const bare = await seedPaid("ord-wallet-unconfigured", WALLET_BUYER);
		const unconfigured = adminClient({});
		expect(await unconfigured.transitionOrder(bare, "processing", { idempotencyKey: "k" })).toEqual(
			{ ok: true, transitioned: true, email: "no-recipient" },
		);
	});

	/**
	 * A context whose `orders.get` turns BUSY for every read made once the write's
	 * email step has begun (`#sendEmailsNow` is on the stack) — the store failing
	 * between the committed write and the email that ends it. Reads made by the write
	 * itself, and every other call, are untouched; the failure is `busyStorage`'s.
	 */
	function ordersReadFailsAfterWrite(): PluginContext {
		const storage = harness.ctx.storage as StorageAccess;
		const busyOrders = busyStorage(storage)["orders"] as unknown as {
			get: (...args: unknown[]) => Promise<unknown>;
		};
		const proxied = new Proxy(storage, {
			get(target, collection, receiver) {
				const real = Reflect.get(target, collection, receiver) as unknown;
				if (collection !== "orders" || typeof real !== "object" || real === null) return real;
				return new Proxy(real, {
					get(inner, method, innerReceiver) {
						const value = Reflect.get(inner, method, innerReceiver) as unknown;
						if (typeof value !== "function") return value;
						const fn = (value as (...args: unknown[]) => unknown).bind(inner);
						if (method !== "get") return fn;
						return (...args: unknown[]) =>
							new Error().stack?.includes("sendEmailsNow") === true
								? busyOrders.get(...args)
								: fn(...args);
					},
				});
			},
		});
		return { ...harness.ctx, storage: proxied } as PluginContext;
	}

	test("a store that turns busy after the write never fails it: the write answers ok with an email status", async () => {
		// The one write with no order in hand (`resolveUnverifiedRefund`) reads it for
		// the recipient check after committing; that read failing falls through to the
		// ordinary path, whose drain read fails too — so the email is queued for the cron
		// (and the write, which committed, still answers ok). Without the guard this case
		// rejects with the store's busy error.
		const card = await seedPaid("ord-busy-after");
		await unverified(card, "k-unv-busy", 1500);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = new InProcessAdminOrdersClient(ordersReadFailsAfterWrite(), {
			gateways,
			orderEmails: { emailSender: new FakeEmailSender() },
		});
		expect(
			await orders.resolveUnverifiedRefund(card, {
				refundKey: "k-unv-busy",
				outcome: "confirmed",
				refundRef: "re_busy",
				resolvedBy: "ops@example.test",
			}),
		).toEqual({ ok: true, changed: true, fullyRefunded: true, email: "queued" });
		errors.mockRestore();

		// A write that holds its order makes no read for the check at all.
		const wallet = await seedPaid("ord-busy-wallet", WALLET_BUYER);
		const moves = new InProcessAdminOrdersClient(ordersReadFailsAfterWrite(), {
			gateways,
			orderEmails: { emailSender: new FakeEmailSender() },
		});
		expect(await moves.transitionOrder(wallet, "processing", { idempotencyKey: "k" })).toEqual({
			ok: true,
			transitioned: true,
			email: "no-recipient",
		});
	});

	test("a store with no email provider reports unconfigured, and claims nothing", async () => {
		const id = await seedPaid("ord-unconfigured");
		const orders = adminClient({});
		expect(await orders.transitionOrder(id, "processing", { idempotencyKey: "k" })).toEqual({
			ok: true,
			transitioned: true,
			email: "unconfigured",
		});
	});

	test("an inline send can never fail the admin write", async () => {
		const id = await seedPaid("ord-throwing");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const orders = new InProcessAdminOrdersClient(harness.ctx, {
			gateways,
			orderEmails: { emailSender: new FakeEmailSender() },
		});
		// A store rejection inside the inline claim — after the write itself landed.
		vi.spyOn(EmdashOrderStore.prototype, "claimNextEmailForOrder").mockRejectedValueOnce(
			new Error("storage blew up"),
		);
		const res = await orders.transitionOrder(id, "processing", { idempotencyKey: "k" });
		expect(res).toEqual({ ok: true, transitioned: true, email: "queued" });
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
