/**
 * The cron's `cancel-intents` leg withdraws an expired order's payment intent —
 * late-payment PREVENTION, wired end to end over the real in-process stores. The
 * expiry itself (`expire-orders`) never talks to the provider: a gateway that
 * cannot be reached costs the cancel (retried on a later tick), never the expiry.
 */
import {
	cents,
	type PaymentGateway,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import { runCommerceSweeps, SWEEP_LEGS } from "../src/cron/sweeps.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const usd = toCurrency("USD");
let h: InProcessCommerceHarness;

beforeEach(async () => {
	if (h === undefined) h = await makeInProcessCommerce();
	else await h.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await h?.close();
});

async function lapsedOrderWithIntent(id: string, intentId: string): Promise<void> {
	await h.stores.orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2000-01-01T00:00:00.000Z",
		buyerRef: "buyer@example.com",
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${id}`),
				sku: toSku(`SKU-${id}`),
				title: "Digital Widget",
				unitPrice: cents(1500),
				currency: usd,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: usd },
	});
	await h.stores.orderStore.recordPaymentIntent({
		orderId: toOrderId(id),
		gateway: "stripe",
		intentId,
	});
}

/** A Paid-sized query budget, so the expiry and the cancel both run in one tick. */
const PAID_QUERIES = 1_000;

async function sweep(stripe: FakePaymentGateway) {
	const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
		now: new Date("2001-01-01T00:00:00.000Z"),
		queryBudget: PAID_QUERIES,
		gateways: { stripe },
	});
	return {
		expiry: summary.legs.find((leg) => leg.leg === "expire-orders"),
		cancels: summary.legs.find((leg) => leg.leg === "cancel-intents"),
	};
}

describe("cron cancel-intents", () => {
	test("in ONE tick the order expires and its recorded intent is cancelled through the deployment's gateway", async () => {
		await lapsedOrderWithIntent("cx-1", "pi_cx_1");
		const stripe = new FakePaymentGateway({ id: "stripe" });

		const { expiry, cancels } = await sweep(stripe);

		expect(expiry).toMatchObject({ ok: true, count: 1 });
		expect(cancels).toMatchObject({ ok: true, count: 1 });
		expect(stripe.cancelCalls.map((c) => c.intentId)).toEqual(["pi_cx_1"]);
		expect((await h.stores.orderStore.getById(toOrderId("cx-1")))?.state).toBe("expired");
	});

	test("an order the expiry has NOT reached yet still has its intent withdrawn at its deadline (QA2 M1a)", async () => {
		// Two lapsed orders, an expiry that can take only one this tick: the other
		// stays `pending` — and its intent is withdrawn anyway, so it cannot be paid
		// in the gap before the expiry catches up.
		await lapsedOrderWithIntent("cx-lag-a", "pi_cx_lag_a");
		await lapsedOrderWithIntent("cx-lag-b", "pi_cx_lag_b");
		const stripe = new FakePaymentGateway({ id: "stripe" });

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date("2001-01-01T00:00:00.000Z"),
			queryBudget: PAID_QUERIES,
			expiryBatchLimit: 1,
			gateways: { stripe },
		});

		expect(summary.legs.find((leg) => leg.leg === "expire-orders")).toMatchObject({ count: 1 });
		const states = await Promise.all(
			["cx-lag-a", "cx-lag-b"].map(
				async (id) => (await h.stores.orderStore.getById(toOrderId(id)))?.state,
			),
		);
		expect(states.toSorted()).toEqual(["expired", "pending"]);
		expect(stripe.cancelCalls.map((c) => c.intentId).toSorted()).toEqual([
			"pi_cx_lag_a",
			"pi_cx_lag_b",
		]);
		for (const id of ["cx-lag-a", "cx-lag-b"]) {
			const [intent] = await h.stores.orderStore.listPaymentIntents(toOrderId(id));
			expect(intent?.cancelOutcome, id).toBe("cancelled");
		}
	});

	test("a gateway that throws costs the cancel, never the expiry", async () => {
		await lapsedOrderWithIntent("cx-2", "pi_cx_2");
		const stripe = new FakePaymentGateway({ id: "stripe" });
		stripe.setCancelResult(new Error("api.stripe.com unreachable"));

		const { expiry, cancels } = await sweep(stripe);

		expect(expiry).toMatchObject({ ok: true, count: 1 });
		expect(cancels).toMatchObject({ ok: true });
		expect((await h.stores.orderStore.getById(toOrderId("cx-2")))?.state).toBe("expired");
		// Rescheduled, not abandoned: the next tick asks again.
		const [intent] = await h.stores.orderStore.listPaymentIntents(toOrderId("cx-2"));
		expect(intent?.cancelOutcome).toBeNull();
		expect(intent?.cancelAttempts).toBe(1);
	});

	test("the leg's gate stops it mid-batch once the tick's time is gone — the rest wait for the next tick", async () => {
		await lapsedOrderWithIntent("cx-3a", "pi_cx_3a");
		await lapsedOrderWithIntent("cx-3b", "pi_cx_3b");
		const stripe = new FakePaymentGateway({ id: "stripe" });
		// The tick clock stands still until the first Stripe cancel, which "takes"
		// longer than the whole tick: the gate must refuse the second unit.
		let t = 0;
		const slow: PaymentGateway = {
			id: "stripe",
			refundable: true,
			createIntent: (i) => stripe.createIntent(i),
			verifyConfirmation: (raw) => stripe.verifyConfirmation(raw),
			refund: (i) => stripe.refund(i),
			async cancelIntent(input) {
				t += 60_000;
				return stripe.cancelIntent(input);
			},
		};

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date("2001-01-01T00:00:00.000Z"),
			queryBudget: PAID_QUERIES,
			tickClock: () => t,
			gateways: { stripe: slow },
		});

		// Both orders expired — the expiry never waits on a provider — but only one
		// cancel fit.
		expect(summary.legs.find((leg) => leg.leg === "expire-orders")).toMatchObject({ count: 2 });
		expect(summary.legs.find((leg) => leg.leg === "cancel-intents")).toMatchObject({
			ok: true,
			count: 1,
			incomplete: true,
		});
		expect(stripe.cancelCalls).toHaveLength(1);
	});

	test("a cancel is never STARTED with less than a whole cancel's time left — and a tick that runs out costs it no attempt", async () => {
		await lapsedOrderWithIntent("cx-4", "pi_cx_4");
		const stripe = new FakePaymentGateway({ id: "stripe" });

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date("2001-01-01T00:00:00.000Z"),
			queryBudget: PAID_QUERIES,
			// Little more than the reserve: no room for a 1.5 s cancel.
			budgetMs: 1_200,
			gateways: { stripe },
		});

		expect(
			summary.legs.find((leg) => leg.leg === "cancel-intents")?.count ?? 0,
		).toBeLessThanOrEqual(1);
		expect(stripe.cancelCalls).toHaveLength(0);
		const [intent] = await h.stores.orderStore.listPaymentIntents(toOrderId("cx-4"));
		expect(intent?.cancelAttempts).toBe(0);
		expect(intent?.cancelOutcome).toBeNull();
	});

	test("an IDLE minute is quiet: no deferral line for this leg", async () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
		vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date("2001-01-01T00:00:00.000Z"),
			queryBudget: 30,
			gateways: () => ({}),
		});

		const leg = summary.legs.find((entry) => entry.leg === "cancel-intents");
		expect(leg).toMatchObject({ ok: true, count: 0 });
		expect(leg?.deferred).toBeUndefined();
		expect(lines.filter((l) => l.includes("cancel-intents"))).toEqual([]);
	});

	test("a tick with nothing due resolves no gateways at all", async () => {
		let resolved = 0;
		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date("2001-01-01T00:00:00.000Z"),
			queryBudget: PAID_QUERIES,
			gateways: () => {
				resolved++;
				return {};
			},
		});
		expect(summary.legs.find((leg) => leg.leg === "cancel-intents")).toMatchObject({
			ok: true,
			count: 0,
		});
		expect(resolved).toBe(0);
	});

	test("it runs right after the critical legs (the outbox and the expiry pair), ahead of the completers", () => {
		const legs = [...SWEEP_LEGS];
		expect(legs.slice(0, 4)).toEqual([
			"order-emails",
			"expire-holds",
			"expire-orders",
			"cancel-intents",
		]);
		expect(legs.indexOf("cancel-intents")).toBeLessThan(legs.indexOf("hold-intents"));
	});
});
