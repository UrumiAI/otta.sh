/**
 * The cron's `order-emails` leg and the host's email provider (ADR-0031).
 *
 * Ported from the deleted `cron-email-provider.test.ts`, whose two guards still
 * matter once the providers left core:
 *  - TRUSTED MODE, NO PROVIDER: `ctx.email` is absent. The leg reports
 *    `skipped`, claims nothing and spends no attempt (the arm production staging
 *    runs until a provider is selected);
 *  - A BUSY TICK: the leg's entry read (the "no provider" record) refused by the
 *    tick's query ceiling is a DEFERRAL that ages, never `skipped` — `skipped`
 *    would clear the leg's wait every busy tick and starve order emails (the
 *    review of #383).
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import type { StorageAccess } from "@otta-sh/store-emdash";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { SWEEP_TASK_NAME } from "../src/cron/index.js";
import { runCommerceSweeps } from "../src/cron/sweeps.js";
import type { EmailMessage, PluginContext } from "../src/types.js";
import {
	adapters,
	type CallCounter,
	memoryCursors,
	placeLapsedOrder,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

let storage: StorageAccess;

beforeAll(async () => {
	({ storage } = await makeSqliteStorage(commerceStorageLayout()));
}, 120_000);

async function paidOrder(id: string): Promise<void> {
	const { orderStore } = adapters(storage);
	const usd = toCurrency("USD");
	const oid = toOrderId(id);
	await orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
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
	await orderStore.markPaid(oid);
}

function emailLeg(summary: Awaited<ReturnType<typeof runCommerceSweeps>>) {
	const found = summary.legs.find((entry) => entry.leg === "order-emails");
	if (found === undefined) throw new Error("no order-emails leg in the summary");
	return found;
}

/** The context with a recording EmDash email provider behind `ctx.email`. */
function withEmail(base: PluginContext, sent: EmailMessage[]): PluginContext {
	return {
		...base,
		email: {
			send: async (message) => {
				sent.push(message);
			},
		},
	};
}

describe("order-emails leg, trusted mode", () => {
	test("NO provider (ctx.email absent): skipped, nothing claimed, no attempt spent", async () => {
		const id = `ord-unwired-${crypto.randomUUID()}`;
		await paidOrder(id);
		const summary = await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
			cursors: memoryCursors(),
			queryBudget: 100_000,
		});
		expect(emailLeg(summary)).toMatchObject({ count: 0, skipped: true });
		// Never claimed: the claim below is the row's first attempt.
		const row = await adapters(storage).orderStore.claimNextEmailForOrder(
			toOrderId(id),
			"2099-01-01T00:00:00.000Z",
			"2099-01-01T00:00:00.000Z",
		);
		expect(row).toMatchObject({ attempts: 1, timeouts: 0 });
	}, 60_000);

	test("a provider selected: the leg runs and the email goes through ctx.email", async () => {
		await paidOrder(`ord-wired-${crypto.randomUUID()}`);
		const sent: EmailMessage[] = [];
		const summary = await runCommerceSweeps(
			withEmail(sweepContext(storage), sent),
			SWEEP_TASK_NAME,
			{
				cursors: memoryCursors(),
				queryBudget: 100_000,
			},
		);
		const leg = emailLeg(summary);
		expect(leg.skipped).toBeUndefined();
		expect(leg.count).toBeGreaterThanOrEqual(1);
		expect(sent.length).toBeGreaterThanOrEqual(1);
	}, 60_000);
});

describe("order-emails on a busy tick: a refused availability read is a deferral, never 'unconfigured'", () => {
	const FREE = 30;
	// The Free preset keeps one call for the cadence-state write and no commit
	// window (`tick-budget.ts`): the units' ceiling is 29.
	const CEILING = FREE - 1;

	test("no room left at all (headroom 0): deferred, and it ages; the first quiet tick sends", async () => {
		const now = new Date();
		await placeLapsedOrder(storage, `busy-${crypto.randomUUID()}`, now);
		await paidOrder(`ord-busy-${crypto.randomUUID()}`);
		const counter: CallCounter = { calls: 0 };
		const sent: EmailMessage[] = [];
		const ctx = withEmail(sweepContext(storage, counter), sent);
		// Leaves no call under the ceiling for the legs after it.
		const spendTheTick = async (counted: PluginContext): Promise<number> => {
			while (counter.calls < CEILING) await counted.kv.get("busy-work");
			return 0;
		};
		const cursors = memoryCursors();
		const legs: ReturnType<typeof emailLeg>[] = [];
		const waits: (number | undefined)[] = [];
		for (let tick = 0; tick < 4; tick++) {
			counter.calls = 0;
			const summary = await runCommerceSweeps(
				ctx,
				SWEEP_TASK_NAME,
				tick < 3
					? { cursors, queryBudget: FREE, legBodies: { "expire-orders": spendTheTick } }
					: { cursors, queryBudget: 100_000 },
			);
			legs.push(emailLeg(summary));
			const state = JSON.parse((await cursors.read("state")) ?? "{}") as {
				waits?: Record<string, number>;
			};
			waits.push(state.waits?.["order-emails"]);
		}
		for (const leg of legs.slice(0, 3)) {
			expect(leg.skipped).toBeUndefined();
			expect(leg).toMatchObject({ count: 0, deferred: true });
		}
		expect(waits.slice(0, 3)).toEqual([1, 2, 3]);
		expect(legs[3]?.skipped).toBeUndefined();
		expect(legs[3]?.count).toBeGreaterThanOrEqual(1);
		expect(waits[3]).toBeUndefined();
		expect(sent.length).toBeGreaterThanOrEqual(1);
	}, 60_000);
});
