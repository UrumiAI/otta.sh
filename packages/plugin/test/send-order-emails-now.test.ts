/**
 * `sendOrderEmailsNow` — the settle routes' inline, best-effort order-email attempt
 * (ADR-0005, amended 2026-10-02), driven directly over a REAL document store.
 *
 * The route suites (`stripe-settle-route.test.ts`, `x402-settle-route.test.ts`) pin
 * that a dispatch problem can never change a settle's status. This file pins the
 * helper's own budget rules, which a route-level case cannot observe precisely:
 *
 *  - a replay or no-op costs ONE order read — the sender (two kv reads) is built only
 *    once a row has actually been claimed;
 *  - the time budget is measured from REQUEST START, so a slow settle shortens the
 *    inline wait and a spent budget skips the attempt;
 *  - after the deadline the abandoned drain claims nothing new;
 *  - only a never-attempted row is claimed inline; retries are the cron's.
 *
 * Time is fake where the subject is a timer (`setTimeout` only — the store's async
 * work is not timer-driven), and injected (`now`) where the subject is the budget.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	EmailSendTimeoutError,
	type EmailSender,
	type OrderId,
} from "@otta-sh/domain";
import { FakeEmailSender } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	ORDER_EMAIL_INLINE_DEADLINE_MS,
	ORDER_EMAIL_INLINE_TIMEOUT_MS,
	cutShortTimeouts,
	sendOrderEmailsNow,
} from "../src/email/send-order-emails-now.js";
import { SETTLE_REQUEST_BUDGET_MS, settleDeadline } from "../src/settle-deadline.js";
import { LOGIN_EMAIL_TIMEOUT_MS } from "../src/email/ctx-http-email-sender.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";
import { runUnderFakeTime } from "./helpers/run-under-fake-time.js";

const MAIL_URL = "https://mail.example.test/send";
const FAR = "2099-01-01T00:00:00.000Z";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

/** A pending order, optionally paid (which enqueues its confirmation row). */
async function seedOrder(id: string, paid: boolean): Promise<OrderId> {
	const usd = toCurrency("USD");
	const oid = toOrderId(id);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: FAR,
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
	if (paid) await harness.stores.orderStore.markPaid(oid);
	return oid;
}

/** A deadline whose request started `elapsedMs` ago. */
function deadlineAfter(elapsedMs: number) {
	let clock = 0;
	const deadline = settleDeadline(() => clock);
	clock = elapsedMs;
	return deadline;
}

/** The row, claimed as of the REAL now — `null` if it is backed off to later. */
function dueNow(id: OrderId) {
	return harness.stores.orderStore.claimNextEmailForOrder(id, new Date().toISOString(), FAR);
}

/** The row as the cron would next see it (`null` ⇒ nothing left, i.e. sent). */
function cronView(id: OrderId) {
	return harness.stores.orderStore.claimNextEmailForOrder(id, FAR, FAR);
}

describe("constants", () => {
	test("the inline send ceiling IS the login one, and both ceilings sit inside Stripe's ~10 s", () => {
		expect(ORDER_EMAIL_INLINE_TIMEOUT_MS).toBe(LOGIN_EMAIL_TIMEOUT_MS);
		expect(ORDER_EMAIL_INLINE_DEADLINE_MS).toBeGreaterThan(ORDER_EMAIL_INLINE_TIMEOUT_MS);
		expect(SETTLE_REQUEST_BUDGET_MS).toBeLessThan(10_000);
	});
});

describe("a replay costs one order read: the sender is built lazily", () => {
	test("nothing due ⇒ no kv read, no egress — only the claim's read of the order", async () => {
		const id = await seedOrder("ord-noop", false); // pending: no outbox row
		const kvGet = vi.spyOn(harness.ctx.kv, "get");
		const getVersioned = vi.spyOn(harness.ctx.storage!["orders"]!, "getVersioned");

		await sendOrderEmailsNow(harness.ctx, harness.stores, id, { egress: { apiUrl: MAIL_URL } });

		expect(kvGet).not.toHaveBeenCalled();
		expect(getVersioned).toHaveBeenCalledTimes(1);
		expect(harness.egressAttempts()).toBe(0);
	});

	test("a due row ⇒ the sender is built (kv) and the real send is attempted", async () => {
		const id = await seedOrder("ord-due", true);
		const kvGet = vi.spyOn(harness.ctx.kv, "get");
		vi.spyOn(console, "error").mockImplementation(() => {});

		await sendOrderEmailsNow(harness.ctx, harness.stores, id, { egress: { apiUrl: MAIL_URL } });

		expect(kvGet).toHaveBeenCalled();
		expect(harness.egressAttempts()).toBe(1); // the harness's ctx.http rejects it
		expect(await cronView(id)).toMatchObject({ attempts: 2 }); // backed off for the cron
	});

	test("no email API URL ⇒ returns before claiming anything", async () => {
		const id = await seedOrder("ord-unconfigured", true);
		await sendOrderEmailsNow(harness.ctx, harness.stores, id, { egress: {} });
		expect(await cronView(id)).toMatchObject({ attempts: 1 }); // never claimed
	});

	test("no email API URL is a QUIET no-op even when the budget is spent — nothing to say", async () => {
		// "Skipped; the cron will deliver it" would be false here: with no sender the cron
		// leg reports `skipped` too. Configured-ness is decided before the budget.
		const id = await seedOrder("ord-unconfigured-late", true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await sendOrderEmailsNow(harness.ctx, harness.stores, id, {
			egress: {},
			deadline: deadlineAfter(SETTLE_REQUEST_BUDGET_MS),
		});
		expect(warn).not.toHaveBeenCalled();
		expect(await cronView(id)).toMatchObject({ attempts: 1 });
	});
});

describe("at most one inline attempt per row — every retry is the cron's", () => {
	test("a row a previous inline attempt already tried is not claimed again", async () => {
		const id = await seedOrder("ord-retry", true);
		const failing = new FakeEmailSender();
		failing.failNextSends(5);
		const later = Date.now() + 10 * 60_000; // long past the inline backoff

		await sendOrderEmailsNow(harness.ctx, harness.stores, id, { emailSender: failing });
		// The redelivery arrives after the backoff lapsed: the row is DUE again.
		const laterStores = { ...harness.stores, clock: { now: () => new Date(later) } };
		const sender = new FakeEmailSender();
		await sendOrderEmailsNow(harness.ctx, laterStores, id, { emailSender: sender });

		expect(sender.sends).toHaveLength(0);
		expect(await cronView(id)).toMatchObject({ attempts: 2 }); // one attempt spent, not two
	});
});

describe("the budget runs from request start", () => {
	test("a settle that already spent the request budget skips the attempt, and says so with the order id", async () => {
		const id = await seedOrder("ord-late", true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sender = new FakeEmailSender();

		await sendOrderEmailsNow(harness.ctx, harness.stores, id, {
			emailSender: sender,
			deadline: deadlineAfter(SETTLE_REQUEST_BUDGET_MS),
		});

		expect(sender.sends).toHaveLength(0);
		expect(await cronView(id)).toMatchObject({ attempts: 1 }); // untouched
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ord-late"));
	});

	test("a slow settle shortens the wait to what is left of the budget", async () => {
		const id = await seedOrder("ord-slow", true);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const hanging: EmailSender = { send: () => new Promise<void>(() => {}) };
		const remaining = 2_000;

		const waited = await runUnderFakeTime(
			sendOrderEmailsNow(harness.ctx, harness.stores, id, {
				emailSender: hanging,
				deadline: deadlineAfter(SETTLE_REQUEST_BUDGET_MS - remaining),
			}),
		);

		expect(waited).toBeGreaterThanOrEqual(remaining);
		expect(waited).toBeLessThan(ORDER_EMAIL_INLINE_DEADLINE_MS);
	});
});

describe("a send never outlives the wait", () => {
	test("when the claim and reads used most of the wait, the send's timeout is the remainder", async () => {
		// The wait is 5 s on the injected clock; the claim "takes" 4.8 s of it. The real
		// sender's per-request abort must then be ~200 ms — not the 3 s ceiling, which
		// would run 2.8 s past the point the request stopped waiting.
		const id = await seedOrder("ord-late-send", true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		let clock = 0;
		const deadline = settleDeadline(() => clock);
		const { orderStore } = harness.stores;
		const realClaim = orderStore.claimNextEmailForOrder.bind(orderStore);
		vi.spyOn(orderStore, "claimNextEmailForOrder").mockImplementation(async (...args) => {
			const row = await realClaim(...args);
			clock += ORDER_EMAIL_INLINE_DEADLINE_MS - 200;
			return row;
		});
		let abortedAfterMs: number | undefined;
		const ctx = {
			...harness.ctx,
			http: {
				// A provider that never answers: only the per-request abort ends the send.
				fetch: (_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						const started = performance.now();
						init?.signal?.addEventListener("abort", () => {
							abortedAfterMs = performance.now() - started;
							reject(new Error("aborted"));
						});
					}),
			},
		};

		await sendOrderEmailsNow(ctx, harness.stores, id, {
			egress: { apiUrl: MAIL_URL },
			deadline,
		});

		expect(abortedAfterMs).toBeDefined();
		expect(abortedAfterMs!).toBeLessThan(ORDER_EMAIL_INLINE_TIMEOUT_MS / 2);
		// And the abort was OURS, not the provider's failing: released uncounted, no
		// timeout recorded against the provider, due at once.
		expect(await dueNow(id)).toMatchObject({ attempts: 1, timeouts: 0 });
	});

	test("an inline timeout is CUT SHORT, never charged to the provider — even from an injected sender", async () => {
		// Inline sends get less than the sweep's full per-send allowance (3 s, not 5 s),
		// so a timeout here says nothing about the provider: it must be released
		// uncounted and due at once — not recorded as a timeout and backed off.
		const id = await seedOrder("ord-inline-timeout", true);
		const slow: EmailSender = {
			send: () => Promise.reject(new EmailSendTimeoutError(ORDER_EMAIL_INLINE_TIMEOUT_MS)),
		};
		await sendOrderEmailsNow(harness.ctx, harness.stores, id, { emailSender: slow });
		expect(await dueNow(id)).toMatchObject({ attempts: 1, timeouts: 0 });
	});
});

describe("the deadline", () => {
	test("a hanging sender is abandoned at the deadline, logged with the order id, never thrown", async () => {
		const id = await seedOrder("ord-hang", true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const hanging: EmailSender = { send: () => new Promise<void>(() => {}) };

		const waited = await runUnderFakeTime(
			sendOrderEmailsNow(harness.ctx, harness.stores, id, { emailSender: hanging }),
		);

		expect(waited).toBeGreaterThanOrEqual(ORDER_EMAIL_INLINE_DEADLINE_MS);
		expect(waited).toBeLessThan(ORDER_EMAIL_INLINE_DEADLINE_MS + 1_000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("ord-hang"));
	});

	test("after the deadline the abandoned drain claims nothing new", async () => {
		// Two due rows on one order. The first send hangs until released AFTER the
		// deadline; the drain must then stop rather than claim the second row.
		const id = await seedOrder("ord-two", true);
		const { orderStore } = harness.stores;
		await orderStore.transition({
			orderId: id,
			fromState: "paid",
			toState: "processing",
			idempotencyKey: toIdempotencyKey("t-processing"),
			enqueueEmail: true,
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let release: (() => void) | undefined;
		const sent: string[] = [];
		const gated: EmailSender = {
			send: (input) =>
				new Promise<void>((resolve) => {
					sent.push(input.template);
					release = resolve;
				}),
		};
		const claim = vi.spyOn(orderStore, "claimNextEmailForOrder");
		const mark = vi.spyOn(orderStore, "markEmailSent");

		await runUnderFakeTime(
			sendOrderEmailsNow(harness.ctx, harness.stores, id, { emailSender: gated }),
		);
		vi.useRealTimers();
		expect(claim).toHaveBeenCalledTimes(1);
		expect(mark).not.toHaveBeenCalled(); // the first send is still in flight

		release?.(); // the provider finally answers, after the response went out
		// Wait until the abandoned drain has OBSERVABLY finished its row — marked sent —
		// which is the exact point an unguarded loop would go on to claim the next one.
		await vi.waitFor(() => expect(mark).toHaveBeenCalledTimes(1));
		await mark.mock.results[0]!.value;
		await new Promise((resolve) => setImmediate(resolve));

		expect(sent).toEqual(["order-confirmation"]);
		expect(claim).toHaveBeenCalledTimes(1);
		// And the second row is still a FIRST attempt, waiting for the cron.
		expect(
			await orderStore.claimNextEmailForOrder(id, FAR, FAR, { onlyUnattempted: true }),
		).toMatchObject({ toState: "processing", attempts: 1 });
	});
});

describe("failures are logged with the order id and the message only", () => {
	test("a store rejection lands in console.error as strings, never the error object", async () => {
		const id = await seedOrder("ord-store-err", true);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(harness.stores.orderStore, "claimNextEmailForOrder").mockRejectedValue(
			new Error("storage exploded"),
		);

		await sendOrderEmailsNow(harness.ctx, harness.stores, id, {
			emailSender: new FakeEmailSender(),
		});

		expect(error).toHaveBeenCalledTimes(1);
		const args = error.mock.calls[0]!;
		expect(args.every((a) => typeof a === "string")).toBe(true);
		expect(args.join(" ")).toContain("ord-store-err");
		expect(args.join(" ")).toContain("storage exploded");
	});
});

/** What `cutShortTimeouts(sender).send` rejects with, or `undefined`. */
async function rejectionOf(sender: EmailSender): Promise<unknown> {
	return cutShortTimeouts(sender)
		.send({
			to: "a@example.com" as never,
			template: "order-confirmation",
			data: {},
			idempotencyKey: "k",
		})
		.then(
			() => undefined,
			(err: unknown) => err,
		);
}

describe("cutShortTimeouts", () => {
	test("re-marks a timeout cut short and KEEPS its real allowance", async () => {
		const err = await rejectionOf({
			send: () => Promise.reject(new EmailSendTimeoutError(1_234)),
		});
		expect(err).toBeInstanceOf(EmailSendTimeoutError);
		expect(err).toMatchObject({ cutShort: true, timeoutMs: 1_234 });
	});

	test("a bridged timeout that dropped its allowance falls back to the inline ceiling", async () => {
		const err = await rejectionOf({
			send: () => Promise.reject({ name: "EmailSendTimeoutError" }),
		});
		expect(err).toMatchObject({ cutShort: true, timeoutMs: ORDER_EMAIL_INLINE_TIMEOUT_MS });
	});

	test("any other failure passes through untouched", async () => {
		const boom = new Error("provider said no");
		expect(await rejectionOf({ send: () => Promise.reject(boom) })).toBe(boom);
	});
});
