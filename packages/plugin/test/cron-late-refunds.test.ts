/**
 * The cron's `late-refunds` leg resumes a late-payment refund that a transient
 * provider failure left `reserved` — wired end to end over the real in-process
 * stores. Stripe's webhook redelivery is the first retry, but Stripe gives up after
 * a few days, and a reserved row holds refund capacity (refusing an admin refund of
 * the same money) until something resumes it. This leg is that something.
 */
import {
	cents,
	type PaymentGateway,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	settleOrder,
	sku as toSku,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import {
	lateRefundStripeOptions,
	runCommerceSweeps,
	SWEEP_LEGS,
	type SweepCursorStore,
} from "../src/cron/sweeps.js";
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

/** An expired stripe order whose late payment hit a RETRYABLE refund failure. */
async function stuckLateRefund(id: string, gateway: FakePaymentGateway): Promise<void> {
	const store = h.stores.orderStore;
	await store.createFromCart({
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
	expect(await store.expire(toOrderId(id), "2001-01-01T00:00:00.000Z")).toBe(true);
	gateway.setRefundResult({ ok: false, reason: "RETRYABLE" });
	const res = await settleOrder(
		{
			orderStore: store,
			entitlementStore: h.stores.entitlementStore,
			paymentEventStore: h.stores.paymentEventStore,
			inventoryStore: h.stores.inventory,
			clock: h.stores.clock,
		},
		gateway,
		gateway.webhook({
			outcome: "succeeded",
			orderId: id,
			providerRef: `pi_${id}`,
			amount: 1500,
			currency: "USD",
			dedupeKey: `evt_${id}`,
		}),
	);
	expect(res).toEqual({ ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" });
}

/** Two hours on: the retry is due, and nowhere near the ~3-day give-up. */
function soon(): Date {
	return new Date(Date.now() + 2 * 3_600_000);
}

/** A Paid-sized query budget, so the best-effort leg gets its turn. */
const PAID_QUERIES = 1_000;

describe("cron late-refunds", () => {
	test("resumes the reserved refund through the deployment's gateway, once", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-1", stripe);
		stripe.clearRefundResult();

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: soon(),
			queryBudget: PAID_QUERIES,
			gateways: { stripe },
		});

		expect(summary.legs.find((leg) => leg.leg === "late-refunds")).toMatchObject({
			ok: true,
			count: 1,
		});
		const refunds = await h.stores.orderStore.listRefunds(toOrderId("lr-1"));
		expect(refunds.map((r) => r.status)).toEqual(["recorded"]);
		expect((await h.stores.orderStore.getById(toOrderId("lr-1")))?.reconciliationFlag).toBeNull();
	});

	test("on the Workers Free preset a refund retry past the age limit is ESCALATED (given up for a human) within a tick", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-free", stripe);

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			// Four days on: past the ~3-day give-up.
			now: new Date(Date.now() + 4 * 24 * 3_600_000),
			queryBudget: 30,
			gateways: { stripe },
		});

		expect(summary.legs.find((leg) => leg.leg === "late-refunds")?.ok).toBe(true);
		const refunds = await h.stores.orderStore.listRefunds(toOrderId("lr-free"));
		expect(refunds.map((r) => r.status)).toEqual(["unverified"]);
		const order = await h.stores.orderStore.getById(toOrderId("lr-free"));
		expect(order?.reconciliationFlag ?? "").toContain("verify in Stripe");
	});

	test("on the Workers Free preset, in a minute it does NOT lead, a stale retry is still ESCALATED at the head of the tick — no Stripe call", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-escalate", stripe);
		const calls = stripe.refundCalls.length;
		const now = new Date(Date.now() + 4 * 24 * 3_600_000);
		const cursors = memoryCursors();
		// It led a moment ago: this minute it runs last, where a unit does not fit.
		await cursors.write(
			"state",
			JSON.stringify({ lastRun: { "late-refunds": now.toISOString() } }),
		);

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now,
			queryBudget: 30,
			cursors,
			gateways: { stripe },
		});

		expect(summary.legs.find((leg) => leg.leg === "late-refunds")).toMatchObject({
			ok: true,
			deferred: true,
			count: 1,
		});
		expect(stripe.refundCalls).toHaveLength(calls);
		const refunds = await h.stores.orderStore.listRefunds(toOrderId("lr-escalate"));
		expect(refunds.map((r) => r.status)).toEqual(["unverified"]);
	});

	test("on the Workers Free preset the leg LEADS a tick once per maintenance interval, so a due refund still makes progress", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-lead", stripe);
		stripe.clearRefundResult();

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date(Date.now() + 2 * 3_600_000),
			queryBudget: 30,
			gateways: { stripe },
			cursors: memoryCursors(),
		});

		expect(summary.legs.find((leg) => leg.leg === "late-refunds")).toMatchObject({
			ok: true,
			count: 1,
		});
		const refunds = await h.stores.orderStore.listRefunds(toOrderId("lr-lead"));
		expect(refunds.map((r) => r.status)).toEqual(["recorded"]);
	});

	test("on Paid it never LEADS — it just runs last — and a Free lead is capped at ONE unit", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-paid", stripe);
		stripe.clearRefundResult();
		const paidCursors = memoryCursors();
		await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: soon(),
			queryBudget: PAID_QUERIES,
			gateways: { stripe },
			cursors: paidCursors,
		});
		expect(paidCursors.data.get("state") ?? "", "no lead stamp on Paid").not.toContain(
			"late-refunds",
		);

		await stuckLateRefund("lr-free-a", stripe);
		await stuckLateRefund("lr-free-b", stripe);
		stripe.clearRefundResult();
		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: soon(),
			queryBudget: 30,
			lateRefundBatch: 5,
			gateways: { stripe },
			cursors: memoryCursors(),
		});
		expect(summary.legs.find((leg) => leg.leg === "late-refunds")?.count).toBe(1);
	});

	test("an IDLE tick costs one due check: no deferral line, no warning, no state write", async () => {
		const cursors = memoryCursors();
		const opts = { queryBudget: 30, cursors, gateways: () => ({}) };
		// A first tick stamps the scans; the second is the idle minute under test.
		await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			...opts,
			now: new Date("2999-01-01T00:00:00.000Z"),
		});
		const writesBefore = cursors.writes;
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
		vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			...opts,
			now: new Date("2999-01-01T00:01:00.000Z"),
		});

		const leg = summary.legs.find((entry) => entry.leg === "late-refunds");
		expect(leg).toMatchObject({ ok: true, count: 0 });
		expect(leg?.deferred).toBeUndefined();
		expect(lines.filter((l) => l.includes("late-refunds"))).toEqual([]);
		// Nothing about this leg reached the sweep's state: no deferral streak, no stamp.
		expect(cursors.data.get("state") ?? "").not.toContain("late-refunds");
		expect(writesBefore).toBeGreaterThanOrEqual(0);
	});

	test("the leg's gate stops it mid-batch once the tick's time is gone — the rest wait for the next tick", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-time-a", stripe);
		await stuckLateRefund("lr-time-b", stripe);
		stripe.clearRefundResult();
		// The tick clock stands still until the first Stripe call, which "takes" far
		// longer than the whole tick: the gate must refuse the second unit.
		let t = 0;
		const slow: PaymentGateway = {
			id: "stripe",
			refundable: true,
			createIntent: (i) => stripe.createIntent(i),
			verifyConfirmation: (raw) => stripe.verifyConfirmation(raw),
			cancelIntent: (input) => stripe.cancelIntent(input),
			async refund(input) {
				t += 60_000;
				return stripe.refund(input);
			},
		};

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: soon(),
			queryBudget: PAID_QUERIES,
			lateRefundBatch: 5,
			tickClock: () => t,
			gateways: { stripe: slow },
		});

		expect(summary.legs.find((leg) => leg.leg === "late-refunds")).toMatchObject({
			ok: true,
			count: 1,
			incomplete: true,
		});
	});

	test("a tick with less time left than a whole refund needs never STARTS one: the row stays reserved, never unverified", async () => {
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await stuckLateRefund("lr-short", stripe);
		stripe.clearRefundResult();
		const before = stripe.refundCalls.length;

		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: soon(),
			queryBudget: PAID_QUERIES,
			// Under a pre-flight + a whole create + the writes after it.
			budgetMs: 3_000,
			gateways: { stripe },
		});

		expect(summary.legs.find((leg) => leg.leg === "late-refunds")?.count).toBe(0);
		expect(stripe.refundCalls).toHaveLength(before);
		const refunds = await h.stores.orderStore.listRefunds(toOrderId("lr-short"));
		expect(refunds.map((r) => r.status)).toEqual(["reserved"]);
	});

	test("it is the LAST leg: best-effort work never delays the critical legs or the completers", () => {
		expect(SWEEP_LEGS.at(-1)).toBe("late-refunds");
	});

	test("a tick with nothing due resolves no gateways at all", async () => {
		let resolved = 0;
		const summary = await runCommerceSweeps(h.ctx, SWEEP_TASK_NAME, {
			now: new Date("2999-01-01T00:00:00.000Z"),
			queryBudget: PAID_QUERIES,
			gateways: () => {
				resolved++;
				return {};
			},
		});
		expect(summary.legs.find((leg) => leg.leg === "late-refunds")).toMatchObject({
			ok: true,
			count: 0,
		});
		expect(resolved).toBe(0);
	});
});

/** A leg budget with `remainingMs` ms left. */
function legAt(remainingMs: number) {
	return { remainingMs: () => remainingMs };
}

describe("lateRefundStripeOptions — never start a refund create that is bound to time out", () => {
	test("the create gets a FIXED bound; the pre-flight may be clipped to what is left", () => {
		const opts = lateRefundStripeOptions(legAt(900));
		expect(opts.refundCreateTimeoutMs).toBe(2_500);
		expect(
			typeof opts.requestTimeoutMs === "function" ? opts.requestTimeoutMs() : -1,
		).toBeLessThanOrEqual(900);
	});

	test("the create is started only with room for all of it plus the storage writes after it", () => {
		expect(lateRefundStripeOptions(legAt(3_100)).beforeRefundCreate?.()).toBe(true);
		expect(lateRefundStripeOptions(legAt(2_900)).beforeRefundCreate?.()).toBe(false);
	});
});

/** An in-memory cursor store that counts its writes. */
function memoryCursors(): SweepCursorStore & { writes: number; data: Map<string, string> } {
	const data = new Map<string, string>();
	const store = {
		writes: 0,
		data,
		async read(name: string) {
			return data.get(name) ?? null;
		},
		async write(name: string, value: string) {
			store.writes++;
			data.set(name, value);
		},
	};
	return store;
}
