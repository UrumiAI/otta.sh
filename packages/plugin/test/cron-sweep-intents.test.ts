/**
 * NO ORDER EXPIRES WITH A PAYABLE INTENT (QA3 N1).
 *
 * QA round 3, on an IDLE Workers Free store: order C1's hold lapsed at 13:29:16;
 * the tick at 13:31 expired it with its PaymentIntent still open, and the intent
 * was withdrawn only at 13:32 (C2 at 13:33). Under a backlog intents stayed
 * payable 23–24 minutes past the deadline, and two buyers were charged and then
 * auto-refunded. `cancel-intents` logged "cancel-intents 2" — a due check and the
 * expiry list, nothing withdrawn — in 51 of 67 runs while withdrawals were overdue:
 * at the head it skipped the intents of the orders this tick's expiry bite would
 * flip, leaving them to a run after the flip that had no room on Free — and with a
 * bite of one, that skipped the only intent its list of one held.
 *
 * The invariant this suite pins, at every tick boundary: an order whose hold has
 * lapsed has its intent withdrawn no later than its expiry. The expiry never flips
 * an order whose intent is due and not yet withdrawn.
 */
import { orderId as toOrderId, type OrderId, type PaymentIntentRecord } from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import type { StorageAccess } from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCommerceSweeps, SWEEP_TASK_NAME } from "../src/cron/index.js";
import { BACKGROUND_WORK_KEY } from "../src/cron/background-work-setting.js";
import {
	adapters,
	memoryCursors,
	MINUTE_MS,
	placeLapsedOrder,
	recordingSender,
	seedLapsedHolds,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const FREE = 30;
const NOW = new Date("2026-10-03T13:30:13.000Z");

let storage: StorageAccess;

beforeEach(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
	vi.spyOn(console, "log").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

async function lapsedWithIntent(tag: string, offsetMs = 0): Promise<OrderId> {
	const placed = await placeLapsedOrder(storage, tag, NOW, offsetMs);
	await adapters(storage).orderStore.recordPaymentIntent({
		orderId: toOrderId(placed.id),
		gateway: "stripe",
		intentId: `pi_${tag}`,
	});
	return toOrderId(placed.id);
}

/** Orders that are dead (expired or cancelled) while one of their intents is
 *  still unresolved — payable at the provider. */
async function deadWithPayableIntent(ids: readonly OrderId[]): Promise<string[]> {
	const s = adapters(storage);
	const found: string[] = [];
	for (const id of ids) {
		const order = await s.orderStore.getById(id);
		if (order?.state !== "expired" && order?.state !== "cancelled") continue;
		const intents: PaymentIntentRecord[] = await s.orderStore.listPaymentIntents(id);
		if (intents.some((intent) => intent.cancelOutcome === null)) found.push(id);
	}
	return found;
}

describe("cancel-intents and the expiry, on the Workers Free preset", () => {
	test("QA3 C1: the lapsed order's intent is withdrawn in the first tick, even when an aged leg takes the head and the expiry fills the rest", async () => {
		// The QA store at 13:30: an abandoned cart's hold had waited its turn (aged to
		// the head) and one order with a payable intent had just lapsed.
		const c1 = await lapsedWithIntent("c1");
		await seedLapsedHolds(storage, "cart", 1, NOW);
		const stripe = new FakePaymentGateway({ id: "stripe" });
		const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: FREE });
		const cursors = memoryCursors();
		await cursors.write("state", JSON.stringify({ waits: { "expire-holds": 3 } }));
		for (let tick = 0; tick < 3; tick++) {
			await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				gateways: { stripe },
				now: new Date(NOW.getTime() + tick * MINUTE_MS),
			});
			expect(await deadWithPayableIntent([c1]), `after tick ${String(tick)}`).toEqual([]);
			if (tick === 0) {
				expect(
					stripe.cancelCalls.map((call) => call.intentId),
					"withdrawn in the first tick",
				).toEqual(["pi_c1"]);
			}
		}
		expect((await adapters(storage).orderStore.getById(c1))?.state).toBe("expired");
	}, 120_000);

	test("at every tick boundary no expired order has a payable intent — two lapsed orders and an abandoned cart, minute by minute", async () => {
		const ids = [await lapsedWithIntent("c1"), await lapsedWithIntent("c2", 1000)];
		await seedLapsedHolds(storage, "cart", 1, NOW);
		const stripe = new FakePaymentGateway({ id: "stripe" });
		const ctx = sweepContext(storage, undefined, { [BACKGROUND_WORK_KEY]: FREE });
		const cursors = memoryCursors();
		await cursors.write("state", JSON.stringify({ waits: { "expire-holds": 3 } }));
		for (let tick = 0; tick < 8; tick++) {
			await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
				cursors,
				emailSender: recordingSender([]),
				gateways: { stripe },
				now: new Date(NOW.getTime() + tick * MINUTE_MS),
			});
			expect(await deadWithPayableIntent(ids), `after tick ${String(tick)}`).toEqual([]);
		}
		// And the work got done: both withdrawn, both expired.
		expect(stripe.cancelCalls.map((call) => call.intentId).toSorted()).toEqual(["pi_c1", "pi_c2"]);
		for (const id of ids) {
			expect((await adapters(storage).orderStore.getById(id))?.state).toBe("expired");
		}
	}, 120_000);
});

describe("the expiry's due check under a backlog of abandoned checkouts (issue #364)", () => {
	test("it reads a bounded number of orders, not the whole backlog, and still expires nothing payable", async () => {
		// 150 lapsed orders, every one still holding a payable intent: more than one
		// tick's cancel-intents bite can withdraw, so most are still due when the
		// expiry looks. Its due check used to walk all of them, a page at a time.
		const ids: OrderId[] = [];
		for (let i = 0; i < 150; i++) {
			ids.push(await lapsedWithIntent(`bk${String(i).padStart(3, "0")}`, i));
		}
		const expiryQueries: number[] = [];
		const watched: StorageAccess = {};
		for (const [name, collection] of Object.entries(storage)) {
			watched[name] = new Proxy(collection, {
				get(target, prop, receiver) {
					const value: unknown = Reflect.get(target, prop, receiver);
					if (prop !== "query" || typeof value !== "function") return value;
					return (opts: { where?: Record<string, unknown>; limit?: number }) => {
						if (opts.where?.["state"] === "pending" && "holdExpiresAt" in opts.where) {
							expiryQueries.push(opts.limit ?? 0);
						}
						return (value as (o: unknown) => unknown).call(target, opts);
					};
				},
			});
		}
		const stripe = new FakePaymentGateway({ id: "stripe" });
		await runCommerceSweeps(
			sweepContext(watched, undefined, { [BACKGROUND_WORK_KEY]: FREE }),
			SWEEP_TASK_NAME,
			{
				cursors: memoryCursors(),
				emailSender: recordingSender([]),
				gateways: { stripe },
				now: NOW,
			},
		);
		// One look of at most 100 orders: one query on a host page of 100.
		expect(expiryQueries.length, JSON.stringify(expiryQueries)).toBeLessThanOrEqual(1);
		expect(expiryQueries.every((rows) => rows <= 100)).toBe(true);
		expect(await deadWithPayableIntent(ids)).toEqual([]);
	}, 300_000);
});
