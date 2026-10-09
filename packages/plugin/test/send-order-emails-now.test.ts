/**
 * `sendOrderEmailsNow` — the settle routes' inline, best-effort order-email attempt
 * (ADR-0005, amended 2026-10-02), driven directly over a REAL document store.
 *
 * The route suite (`stripe-settle-route.test.ts`) pins that a dispatch problem can
 * never change a settle's status. This file pins the
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
	MIN_INLINE_SEND_MS,
	sendOrderEmailsNow,
} from "../src/email/send-order-emails-now.js";
import { SETTLE_REQUEST_BUDGET_MS, settleDeadline } from "../src/settle-deadline.js";
import {
	EMAIL_LAST_SENT_KEY,
	EMAIL_TRANSPORT_UNAVAILABLE_KEY,
	LOGIN_EMAIL_TIMEOUT_MS,
} from "../src/email/ctx-email-sender.js";
import type { EmailAccess, EmailMessage, PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";
import { STORE_DISPLAY_NAME_KEY } from "../src/email/email-render-context.js";
import { runUnderFakeTime } from "./helpers/run-under-fake-time.js";

const FAR = "2099-01-01T00:00:00.000Z";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
	// kv outlives `reset()`: forget any "no email provider" answer a case recorded.
	await harness.ctx.kv.delete(EMAIL_TRANSPORT_UNAVAILABLE_KEY);
	await harness.ctx.kv.delete(EMAIL_LAST_SENT_KEY);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.close();
});

/** A pending order, optionally paid (which enqueues its confirmation row). */
async function seedOrder(
	id: string,
	paid: boolean,
	buyerRef = "buyer@example.com",
): Promise<OrderId> {
	const usd = toCurrency("USD");
	const oid = toOrderId(id);
	await harness.stores.orderStore.createFromCart({
		orderId: oid,
		cartId: null,
		currency: usd,
		idempotencyKey: toIdempotencyKey(`seed-${id}`),
		holdExpiresAt: FAR,
		buyerRef,
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

/** The harness context with a host email pipeline (`ctx.email`, ADR-0031) whose
 *  `send` is `send` — recording by default. */
function withEmail(send?: EmailAccess["send"]): {
	ctx: PluginContext;
	messages: EmailMessage[];
} {
	const messages: EmailMessage[] = [];
	const email: EmailAccess = {
		send:
			send ??
			(async (message) => {
				messages.push(message);
			}),
	};
	return { ctx: { ...harness.ctx, email }, messages };
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
	test("nothing due ⇒ one kv read (the 'no provider' record), no send — and the claim's read of the order", async () => {
		const id = await seedOrder("ord-noop", false); // pending: no outbox row
		const { ctx, messages } = withEmail();
		const kvGet = vi.spyOn(ctx.kv, "get");
		const getVersioned = vi.spyOn(ctx.storage!["orders"]!, "getVersioned");

		const result = await sendOrderEmailsNow(ctx, harness.stores, id);

		// Whether to try is `ctx.email` plus the host's last "no provider" answer
		// (ADR-0031); the sender's own reads wait for a claimed row.
		expect(kvGet.mock.calls.map((call) => call[0])).toEqual([EMAIL_TRANSPORT_UNAVAILABLE_KEY]);
		expect(getVersioned).toHaveBeenCalledTimes(1);
		expect(messages).toEqual([]);
		expect(result).toEqual({ configured: true, sent: [], skipped: [] });
		expect(harness.egressAttempts()).toBe(0);
	});

	test("a due row ⇒ the sender is built (kv) and the confirmation goes out through ctx.email", async () => {
		const id = await seedOrder("ord-due", true);
		const { ctx, messages } = withEmail();
		const kvGet = vi.spyOn(ctx.kv, "get");

		const result = await sendOrderEmailsNow(ctx, harness.stores, id);

		expect(kvGet).toHaveBeenCalled();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ to: "buyer@example.com" });
		expect(messages[0]!.subject.length).toBeGreaterThan(0);
		expect(messages[0]!.text).toContain("Digital Widget × 1 — $15.00");
		expect(messages[0]!.html).toContain("Digital Widget");
		expect(result.configured).toBe(true);
		expect(result.sent.map((row) => [row.orderId, row.toState])).toEqual([[id, "paid"]]);
		expect(await cronView(id)).toBeNull(); // sent: nothing left for the cron
		expect(harness.egressAttempts()).toBe(0); // never ctx.http
	});

	test("a provider failure ⇒ the row is backed off for the cron, one attempt spent", async () => {
		const id = await seedOrder("ord-fail", true);
		const { ctx } = withEmail(() => Promise.reject(new Error("provider said no")));

		const result = await sendOrderEmailsNow(ctx, harness.stores, id);

		expect(result).toEqual({ configured: true, sent: [], skipped: [] });
		expect(await cronView(id)).toMatchObject({ attempts: 2 }); // backed off for the cron
	});

	test("an order with no email address ⇒ its row is reported skipped, and no sender is built", async () => {
		const id = await seedOrder(
			"ord-wallet",
			true,
			"wallet:0x1111111111111111111111111111111111111111",
		);
		const { ctx, messages } = withEmail();
		const kvGet = vi.spyOn(ctx.kv, "get");

		const result = await sendOrderEmailsNow(ctx, harness.stores, id);

		expect(result.configured).toBe(true);
		expect(result.sent).toEqual([]);
		expect(result.skipped.map((row) => [row.orderId, row.toState])).toEqual([[id, "paid"]]);
		// No sender built: only the availability read, and no send.
		expect(kvGet.mock.calls.map((call) => call[0])).toEqual([EMAIL_TRANSPORT_UNAVAILABLE_KEY]);
		expect(messages).toEqual([]);
		expect(await cronView(id)).toBeNull(); // completed, not left for the cron
	});

	test("no EmDash email provider (trusted: ctx.email absent) ⇒ returns before claiming anything", async () => {
		const id = await seedOrder("ord-unconfigured", true);
		const result = await sendOrderEmailsNow(harness.ctx, harness.stores, id);
		expect(result).toEqual({ configured: false, sent: [], skipped: [] });
		expect(await cronView(id)).toMatchObject({ attempts: 1 }); // never claimed
	});

	test("no EmDash email provider (sandboxed: send says 'not configured') ⇒ released uncounted, reported unconfigured", async () => {
		const id = await seedOrder("ord-sandbox-unconfigured", true);
		const { ctx } = withEmail(() =>
			Promise.reject(new Error("Email is not configured. No email provider is available.")),
		);

		const result = await sendOrderEmailsNow(ctx, harness.stores, id);

		expect(result).toEqual({ configured: false, sent: [], skipped: [] });
		// Not due right now (backed off), and no attempt spent: still a first attempt.
		expect(await dueNow(id)).toBeNull();
		expect(await cronView(id)).toMatchObject({ attempts: 1, timeouts: 0 });
		// The answer was recorded: the next order is not even claimed, and no send is tried.
		const next = await seedOrder("ord-sandbox-unconfigured-2", true);
		let tried = 0;
		const again = withEmail(() => {
			tried += 1;
			return Promise.reject(new Error("Email is not configured. No email provider is available."));
		});
		expect(await sendOrderEmailsNow(again.ctx, harness.stores, next)).toEqual({
			configured: false,
			sent: [],
			skipped: [],
		});
		expect(tried).toBe(0);
		expect(await cronView(next)).toMatchObject({ attempts: 1 }); // never claimed
	});

	test("no email provider is a QUIET no-op even when the budget is spent — nothing to say", async () => {
		// "Skipped; the cron will deliver it" would be false here: with no sender the cron
		// leg reports `skipped` too. Configured-ness is decided before the budget.
		const id = await seedOrder("ord-unconfigured-late", true);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await sendOrderEmailsNow(harness.ctx, harness.stores, id, {
			deadline: deadlineAfter(SETTLE_REQUEST_BUDGET_MS),
		});
		expect(warn).not.toHaveBeenCalled();
		expect(await cronView(id)).toMatchObject({ attempts: 1 });
	});
});

describe("an email older than 72 h (ADR-0031)", () => {
	test("completed unsent and logged with the row id and template, never the address", async () => {
		const buyer = "stale-inline@example.test";
		const id = await seedOrder("ord-stale-inline", true, buyer);
		// Age the queued confirmation past the cap, in the stored document itself.
		const orders = harness.ctx.storage!["orders"]!;
		const doc = (await orders.get(id)) as {
			emailOutbox: { id: string; createdAt: string }[];
		} | null;
		const row = doc?.emailOutbox[0];
		if (doc === null || row === undefined) throw new Error("no outbox row seeded");
		row.createdAt = new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString();
		await orders.put(id, doc);
		const { ctx, messages } = withEmail();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await sendOrderEmailsNow(ctx, harness.stores, id);

		expect(result).toEqual({ configured: true, sent: [], skipped: [] });
		expect(messages).toEqual([]);
		expect(await cronView(id)).toBeNull(); // completed, never sent
		const lines = warn.mock.calls.map((call) => call.map(String).join(" "));
		expect(lines).toEqual([
			`[otta] inline order email for ${id}: 1 email(s) older than 72 h completed unsent (ADR-0031): ${row.id} (order-confirmation)`,
		]);
		expect(lines.join("\n")).not.toContain(buyer);
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
		// The wait is 5 s on the injected clock; the claim "takes" all but 1.2 s of it.
		// The send must then be cut off at ~1.2 s — not the 3 s ceiling, which would
		// run past the point the request stopped waiting.
		const left = MIN_INLINE_SEND_MS + 200;
		const id = await seedOrder("ord-late-send", true);
		let clock = 0;
		const deadline = settleDeadline(() => clock);
		const { orderStore } = harness.stores;
		const realClaim = orderStore.claimNextEmailForOrder.bind(orderStore);
		vi.spyOn(orderStore, "claimNextEmailForOrder").mockImplementation(async (...args) => {
			const row = await realClaim(...args);
			clock += ORDER_EMAIL_INLINE_DEADLINE_MS - left;
			return row;
		});
		// A provider that never answers: only the sender's own timer ends the send.
		const { ctx } = withEmail(() => new Promise<void>(() => {}));
		const started = performance.now();

		await sendOrderEmailsNow(ctx, harness.stores, id, { deadline });

		const took = performance.now() - started;
		expect(took).toBeGreaterThanOrEqual(left - 50);
		expect(took).toBeLessThan(ORDER_EMAIL_INLINE_TIMEOUT_MS - 500);
		// `ctx.email` has no idempotency key, so the timed-out send may have gone: it
		// is a COUNTED attempt (ADR-0031), backed off for the cron.
		expect(await dueNow(id)).toBeNull();
		expect(await cronView(id)).toMatchObject({ attempts: 2, timeouts: 0 });
	});

	test("PR #418 review: with ~100 ms of the wait left, NO send starts — the row goes back untried and uncounted", async () => {
		// A send started this late would time out, be delivered anyway (a race, not an
		// abort), count as an attempt, and be sent AGAIN by the cron — a duplicate
		// confirmation nothing can drop. Below `MIN_INLINE_SEND_MS` it is the cron's.
		const id = await seedOrder("ord-too-late-send", true);
		let clock = 0;
		const deadline = settleDeadline(() => clock);
		const { orderStore } = harness.stores;
		const realClaim = orderStore.claimNextEmailForOrder.bind(orderStore);
		vi.spyOn(orderStore, "claimNextEmailForOrder").mockImplementation(async (...args) => {
			const row = await realClaim(...args);
			clock += ORDER_EMAIL_INLINE_DEADLINE_MS - 100;
			return row;
		});
		const { ctx, messages } = withEmail();

		const result = await sendOrderEmailsNow(ctx, harness.stores, id, { deadline });

		expect(messages).toHaveLength(0);
		expect(result).toEqual({ configured: true, sent: [], skipped: [] });
		// No attempt spent: the cron's claim is this row's FIRST counted attempt.
		expect(await cronView(id)).toMatchObject({ attempts: 1, timeouts: 0 });
	});

	test("r3 S2: the floor is checked again AFTER the sender's kv reads — a build that eats the margin sends nothing, uncounted", async () => {
		const id = await seedOrder("ord-slow-build", true);
		let clock = 0;
		const deadline = settleDeadline(() => clock);
		const { orderStore } = harness.stores;
		const realClaim = orderStore.claimNextEmailForOrder.bind(orderStore);
		vi.spyOn(orderStore, "claimNextEmailForOrder").mockImplementation(async (...args) => {
			const row = await realClaim(...args);
			// `canSend` still sees 1.1 s left…
			clock += ORDER_EMAIL_INLINE_DEADLINE_MS - (MIN_INLINE_SEND_MS + 100);
			return row;
		});
		const { ctx, messages } = withEmail();
		// …but building the sender (its kv reads) takes 200 ms of it.
		const realGet = ctx.kv.get.bind(ctx.kv);
		ctx.kv = {
			...ctx.kv,
			get: async <T>(key: string) => {
				if (key === STORE_DISPLAY_NAME_KEY) clock += 200;
				return realGet<T>(key);
			},
		};

		const result = await sendOrderEmailsNow(ctx, harness.stores, id, { deadline });

		expect(messages).toHaveLength(0);
		expect(result.sent).toEqual([]);
		expect(await cronView(id)).toMatchObject({ attempts: 1, timeouts: 0 });
	});

	test("r3 F5: a delivered inline send records `state:emailLastSentAt` through the real path", async () => {
		const id = await seedOrder("ord-records-sent", true);
		const { ctx, messages } = withEmail();
		expect(await harness.ctx.kv.get(EMAIL_LAST_SENT_KEY)).toBeNull();

		await sendOrderEmailsNow(ctx, harness.stores, id);
		await new Promise<void>((resolve) => setTimeout(resolve, 0)); // the un-awaited write

		expect(messages).toHaveLength(1);
		expect(typeof (await harness.ctx.kv.get(EMAIL_LAST_SENT_KEY))).toBe("string");
	});

	test("with less than MIN_INLINE_SEND_MS of the request left, nothing is even claimed", async () => {
		const id = await seedOrder("ord-short-wait", true);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const claim = vi.spyOn(harness.stores.orderStore, "claimNextEmailForOrder");
		const { ctx, messages } = withEmail();

		await sendOrderEmailsNow(ctx, harness.stores, id, {
			deadline: deadlineAfter(SETTLE_REQUEST_BUDGET_MS - (MIN_INLINE_SEND_MS - 1)),
		});

		expect(claim).not.toHaveBeenCalled();
		expect(messages).toHaveLength(0);
		expect(await cronView(id)).toMatchObject({ attempts: 1 });
	});

	test("an inline timeout is a COUNTED attempt — even from an injected sender", async () => {
		// A timeout may have been delivered and no provider can dedupe a retry, so it
		// spends one of the row's attempts: duplicates stop at `maxAttempts`.
		const id = await seedOrder("ord-inline-timeout", true);
		const slow: EmailSender = {
			send: () => Promise.reject(new EmailSendTimeoutError(ORDER_EMAIL_INLINE_TIMEOUT_MS)),
		};
		await sendOrderEmailsNow(harness.ctx, harness.stores, id, { emailSender: slow });
		expect(await dueNow(id)).toBeNull();
		expect(await cronView(id)).toMatchObject({ attempts: 2, timeouts: 0 });
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
