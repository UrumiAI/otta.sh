/**
 * AN EXTERNAL ACTION IS RECORDED, WHEREVER THE TICK RUNS OUT (QA3 N2).
 *
 * QA round 3: 5 of 14 orders got their "Checkout expired" email twice, one three
 * times. Each first send was in a tick that logged `order-emails stopped at the
 * tick's query ceiling (29) part-way through a unit`. The provider had the email;
 * the ceiling then refused `markEmailSent`, the row stayed leased, and when the lease
 * lapsed it went out again.
 *
 * The rule pinned here, for every leg that calls a provider and then writes what it
 * did — the outbox (an email), `cancel-intents` (a Stripe cancel), `late-refunds` (a
 * Stripe refund): wherever the tick's query ceiling lands inside the unit, the
 * provider is asked ONCE. Each case puts the ceiling at every call of the unit in
 * turn (a tick budget of 3, 4, 5 … calls), then drains with a roomy tick, and counts
 * the provider calls.
 */
import { orderId as toOrderId, settleOrder, type SendEmailInput } from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import {
	EmdashEntitlementStore,
	EmdashPaymentEventStore,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runCommerceSweeps, SWEEP_TASK_NAME } from "../src/cron/index.js";
import {
	adapters,
	HOUR_MS,
	memoryCursors,
	MINUTE_MS,
	placeLapsedOrder,
	placeOrder,
	placePaidOrderOwingCommit,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";
import type { PluginContext } from "../src/types.js";

const NOW = new Date(Math.floor((Date.now() + 2 * HOUR_MS) / MINUTE_MS) * MINUTE_MS);
/** Tick budgets that put the ceiling at every call of one unit, and past it. */
const CEILINGS = Array.from({ length: 28 }, (_, i) => i + 3);

afterEach(() => {
	vi.useRealTimers();
});

beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** One tick at `budget` calls, then roomy ticks until nothing is left. */
async function tightThenDrain(
	storage: StorageAccess,
	budget: number,
	extra: Parameters<typeof runCommerceSweeps>[2],
	start: Date = NOW,
	followClock = false,
): Promise<void> {
	const ctx = sweepContext(storage);
	const cursors = memoryCursors();
	for (let tick = 0; tick < 6; tick++) {
		if (followClock) vi.setSystemTime(new Date(start.getTime() + tick * 20 * MINUTE_MS));
		await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors,
			...extra,
			queryBudget: tick === 0 ? budget : 1000,
			// Past any lease and any short retry the tight tick may have left.
			now: new Date(start.getTime() + tick * 20 * MINUTE_MS),
		});
	}
}

describe("the ceiling inside a provider unit never repeats the provider call", () => {
	test.each(CEILINGS)(
		"an order email, ceiling at %i calls: sent once",
		async (budget) => {
			const { storage } = await makeSqliteStorage(commerceStorageLayout());
			// The outbox's claim and lease read the store's own clock: it follows the
			// ticks here (`tightThenDrain` moves the system time), as it does in production.
			vi.useFakeTimers({ toFake: ["Date"] });
			const start = new Date();
			await placePaidOrderOwingCommit(storage, "mail", start);
			const sent: SendEmailInput[] = [];
			// The real sender, as the budget sees it: building it reads the API key and the
			// from-address (two kv calls, once), and each send is one subrequest.
			const realSender = async (_timeout: () => number, counted: PluginContext) => {
				await counted.kv.get("email-api-key");
				await counted.kv.get("email-from");
				return {
					async send(input: SendEmailInput) {
						await counted.kv.get("the-request");
						sent.push(input);
					},
				};
			};
			await tightThenDrain(storage, budget, { emailSenderFactory: realSender }, start, true);
			vi.useRealTimers();
			// The store's only email: the paid order's confirmation.
			expect(sent.map((input) => input.template)).toHaveLength(1);
		},
		60_000,
	);

	test.each(CEILINGS)(
		"an intent withdrawal, ceiling at %i calls: Stripe asked once",
		async (budget) => {
			const { storage } = await makeSqliteStorage(commerceStorageLayout());
			const placed = await placeLapsedOrder(storage, "cancel", NOW);
			await adapters(storage).orderStore.recordPaymentIntent({
				orderId: toOrderId(placed.id),
				gateway: "stripe",
				intentId: "pi_cancel",
			});
			const stripe = new FakePaymentGateway({ id: "stripe" });
			await tightThenDrain(storage, budget, {
				emailSender: recordingSender([]),
				gateways: { stripe },
			});
			expect(stripe.cancelCalls.map((call) => call.intentId)).toEqual(["pi_cancel"]);
			const [intent] = await adapters(storage).orderStore.listPaymentIntents(toOrderId(placed.id));
			expect(intent?.cancelOutcome).toBe("cancelled");
		},
		60_000,
	);

	test.each(CEILINGS)(
		"a late-payment refund resume, ceiling at %i calls: Stripe refunds once",
		async (budget) => {
			const { storage } = await makeSqliteStorage(commerceStorageLayout());
			const late = await placeOrder(
				storage,
				"late",
				new Date(Date.now() - 30 * MINUTE_MS),
				new Date(Date.now() - HOUR_MS),
			);
			const s = adapters(storage);
			expect(await s.orderStore.expire(toOrderId(late.id), new Date().toISOString())).toBe(true);
			const stripe = new FakePaymentGateway({ id: "stripe" });
			stripe.setRefundResult({ ok: false, reason: "RETRYABLE" });
			const settled = await settleOrder(
				{
					orderStore: s.orderStore,
					entitlementStore: new EmdashEntitlementStore({
						storage,
						idGen: uuidIdGen,
						clock: s.clock,
					}),
					paymentEventStore: new EmdashPaymentEventStore({ storage }),
					inventoryStore: s.inventory,
					clock: s.clock,
				},
				stripe,
				stripe.webhook({
					outcome: "succeeded",
					orderId: late.id,
					providerRef: `pi_${late.id}`,
					amount: 1000,
					currency: "USD",
					dedupeKey: `evt_${late.id}`,
				}),
			);
			expect(settled).toEqual({ ok: false, reason: "LATE_PAYMENT_REFUND_RETRYABLE" });
			stripe.clearRefundResult();
			const before = stripe.refundCalls.length;
			await tightThenDrain(storage, budget, {
				emailSender: recordingSender([]),
				gateways: { stripe },
			});
			// One resume after the settle's failed attempt.
			expect(stripe.refundCalls.length - before).toBe(1);
			const refunds = await s.orderStore.listRefunds(toOrderId(late.id));
			expect(refunds.map((refund) => refund.status)).toEqual(["recorded"]);
		},
		60_000,
	);
});
