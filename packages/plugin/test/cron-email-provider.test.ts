/**
 * The cron's `order-emails` leg and the "Email provider" setting.
 *
 * Before SMTP2GO the leg's question "can this deployment send?" was answered by
 * the build-time email URL alone. A store on SMTP2GO needs no URL — its hosts
 * are granted in every build — so the leg must also ask the store's provider
 * choice, or an SMTP2GO store built without `EMAIL_API_URL` would report
 * `skipped` forever and never drain its outbox.
 *
 * This vitest bundle bakes no email URL (`IN_PROCESS_EGRESS_URLS` is `{}`), so
 * these cases are exactly the no-URL arm. No request leaves the machine: the
 * context's fetch records and answers like SMTP2GO.
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
import { EMAIL_PROVIDER_KEY } from "../src/email/email-provider.js";
import { IN_PROCESS_EGRESS_URLS } from "../src/manifest.js";
import { EMAIL_API_KEY_KEY, SMTP2GO_API_KEY_KEY } from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";
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

const OK_BODY = JSON.stringify({ data: { succeeded: 1, failed: 0, failures: [], email_id: "e1" } });

function ctxWith(seed: Record<string, unknown>): { ctx: PluginContext; urls: string[] } {
	const urls: string[] = [];
	const base = sweepContext(storage, undefined, seed);
	return {
		urls,
		ctx: {
			...base,
			http: {
				fetch: (url: string) => {
					urls.push(url);
					return Promise.resolve(new Response(OK_BODY, { status: 200 }));
				},
			},
		},
	};
}

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

describe("order-emails leg: the provider choice decides whether a URL-less build can send", () => {
	test("this bundle bakes no email URL", () => {
		expect(IN_PROCESS_EGRESS_URLS.emailApiUrl).toBeUndefined();
	});

	// Each "skipped" case has an email DUE: the leg asks "is any row due?" before it
	// resolves the provider, so an unconfigured store with an empty outbox is simply
	// idle — and `skipped` is the report for work that cannot be sent.
	test("no URL and the default provider: skipped, as before", async () => {
		await paidOrder(`ord-unwired-${crypto.randomUUID()}`);
		const { ctx, urls } = ctxWith({});
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors: memoryCursors(),
			queryBudget: 100_000,
		});
		expect(emailLeg(summary)).toMatchObject({ count: 0, skipped: true });
		expect(urls).toEqual([]);
	});

	test("SMTP2GO chosen with only the Resend key saved: skipped, and that key never leaves", async () => {
		await paidOrder(`ord-keyless-${crypto.randomUUID()}`);
		const { ctx, urls } = ctxWith({
			[EMAIL_PROVIDER_KEY]: "smtp2go",
			[EMAIL_API_KEY_KEY]: "re_0123456789abcdef",
		});
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors: memoryCursors(),
			queryBudget: 100_000,
		});
		expect(emailLeg(summary)).toMatchObject({ count: 0, skipped: true });
		expect(urls).toEqual([]);
	});

	test("no URL and SMTP2GO chosen: the leg runs and sends through SMTP2GO", async () => {
		await paidOrder(`ord-smtp2go-${crypto.randomUUID()}`);
		const { ctx, urls } = ctxWith({
			[EMAIL_PROVIDER_KEY]: "smtp2go",
			[SMTP2GO_API_KEY_KEY]: "api-0123456789ABCDEF0123456789ABCDEF",
		});
		const summary = await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors: memoryCursors(),
			queryBudget: 100_000,
		});
		const leg = emailLeg(summary);
		expect(leg.skipped).toBeUndefined();
		expect(leg.count).toBeGreaterThanOrEqual(1);
		expect(urls.length).toBeGreaterThanOrEqual(1);
		expect(urls.every((url) => url === "https://api.smtp2go.com/v3/email/send")).toBe(true);
	});
});

describe("order-emails leg on SMTP2GO: a timeout is a counted attempt (no idempotency key)", () => {
	test("a hung SMTP2GO send spends one of the row's attempts instead of coming back uncounted", async () => {
		const id = `ord-smtp2go-hang-${crypto.randomUUID()}`;
		await paidOrder(id);
		const base = sweepContext(storage, undefined, {
			[EMAIL_PROVIDER_KEY]: "smtp2go",
			[SMTP2GO_API_KEY_KEY]: "api-0123456789ABCDEF0123456789ABCDEF",
		});
		const ctx: PluginContext = {
			...base,
			http: {
				fetch: (_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			},
		};
		await runCommerceSweeps(ctx, SWEEP_TASK_NAME, {
			cursors: memoryCursors(),
			queryBudget: 100_000,
		});
		const { orderStore } = adapters(storage);
		const row = await orderStore.claimNextEmailForOrder(
			toOrderId(id),
			"2099-01-01T00:00:00.000Z",
			"2099-01-01T00:00:00.000Z",
		);
		// Claimed once by the tick (counted), and once more here: two. An uncounted
		// timeout would have left it at one, free to be re-sent without bound.
		expect(row).toMatchObject({ attempts: 2, timeouts: 0 });
	}, 30_000);
});

interface BusyTicks {
	legs: ReturnType<typeof emailLeg>[];
	/** `order-emails`' wait in the cadence state after each tick. */
	waits: (number | undefined)[];
	urls: string[];
}

function expectDeferredAndAging(result: BusyTicks): void {
	// Three busy ticks: not reached, so deferred — never `skipped` — and its wait
	// grows by one each tick instead of being cleared.
	for (const leg of result.legs.slice(0, 3)) {
		expect(leg.skipped).toBeUndefined();
		expect(leg).toMatchObject({ count: 0, deferred: true });
	}
	expect(result.waits.slice(0, 3)).toEqual([1, 2, 3]);
	// The store was configured all along: the first tick with room sends, and the
	// wait is cleared by a run, not by a false "skipped".
	expect(result.legs[3]?.skipped).toBeUndefined();
	expect(result.legs[3]?.count).toBeGreaterThanOrEqual(1);
	expect(result.waits[3]).toBeUndefined();
}

/**
 * Review of #383: the provider resolve is part of the leg's gated work.
 *
 * It was once read BEFORE the leg's budget check, outside the leg's charge, and
 * its fail-soft readers turned the tick's query-ceiling refusal into "no
 * provider" — so on a busy tick a configured store's leg reported `skipped`, and
 * `skipped` clears the leg's wait. Every busy tick did the same, the leg never
 * aged to the head of a tick, and order emails could wait without bound.
 *
 * The busy tick is built for real: a lapsed order keeps `expire-orders` (ahead of
 * the outbox in `LEG_PRIORITY`) due on every tick, and its body is replaced by
 * one that spends the tick down to exactly `headroom` calls below the ceiling.
 */
describe("order-emails on a busy tick: a refused provider read is a deferral, never 'unconfigured'", () => {
	const FREE = 30;
	// The Free preset keeps one call for the cadence-state write and no commit
	// window (`tick-budget.ts`): the units' ceiling is 29.
	const CEILING = FREE - 1;
	const SMTP2GO_SEED = {
		[EMAIL_PROVIDER_KEY]: "smtp2go",
		[SMTP2GO_API_KEY_KEY]: "api-0123456789ABCDEF0123456789ABCDEF",
	};

	async function busyTicks(seed: Record<string, unknown>, headroom: number): Promise<BusyTicks> {
		const now = new Date();
		await placeLapsedOrder(storage, `busy-${crypto.randomUUID()}`, now);
		await paidOrder(`ord-busy-${crypto.randomUUID()}`);
		const counter: CallCounter = { calls: 0 };
		const urls: string[] = [];
		const ctx: PluginContext = {
			...sweepContext(storage, counter, seed),
			http: {
				fetch: (url: string) => {
					urls.push(url);
					return Promise.resolve(new Response(OK_BODY, { status: 200 }));
				},
			},
		};
		// Leaves exactly `headroom` calls under the ceiling for the legs after it.
		const spendTheTick = async (counted: PluginContext): Promise<number> => {
			while (counter.calls < CEILING - headroom) await counted.kv.get("busy-work");
			return 0;
		};
		const cursors = memoryCursors();
		const legs: ReturnType<typeof emailLeg>[] = [];
		const waits: (number | undefined)[] = [];
		// Three busy ticks, then a quiet one with room to spare.
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
		return { legs, waits, urls };
	}

	test("SMTP2GO with room for the provider read but not the key read: deferred, and it ages", async () => {
		const result = await busyTicks(SMTP2GO_SEED, 1);
		expectDeferredAndAging(result);
		expect(result.urls.length).toBeGreaterThanOrEqual(1);
		expect(result.urls.every((url) => url === "https://api.smtp2go.com/v3/email/send")).toBe(true);
	}, 60_000);

	test("Resend with no room left at all (headroom 0): deferred, and it ages", async () => {
		// A Resend store needs the build's email URL, which this bundle does not bake;
		// set it for this case only, so the store is CONFIGURED and only the budget
		// stands between it and its outbox.
		const egress = IN_PROCESS_EGRESS_URLS as { emailApiUrl?: string | undefined };
		egress.emailApiUrl = "https://mail.example.test/emails";
		try {
			const result = await busyTicks({}, 0);
			expectDeferredAndAging(result);
			expect(result.urls.length).toBeGreaterThanOrEqual(1);
			expect(result.urls.every((url) => url === "https://mail.example.test/emails")).toBe(true);
		} finally {
			delete egress.emailApiUrl;
		}
	}, 60_000);
});
