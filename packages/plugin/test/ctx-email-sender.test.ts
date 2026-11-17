/**
 * `CtxEmailSender` — the plugin's one `EmailSender`, over the EmDash host's
 * `ctx.email` (ADR-0031). What the rendering is lives in
 * `order-email-rendering.test.ts`; this file pins the transport contract:
 *
 *  - the host's two "no provider" answers (emdash 0.38) become
 *    `EmailTransportUnavailableError`, which the dispatcher releases uncounted.
 *    The sandbox bridge rebuilds a plain Error, so the MESSAGE is what crosses.
 *    The match is EXACT (security review F1): a provider error that merely
 *    QUOTES either text — or a buyer-chosen address containing it — is an
 *    ordinary failure. The pipeline text is pinned here against the installed
 *    EmDash source; the bridge text is pinned against EmDash's real bridge over
 *    the real RPC (`emdash-sandbox-rpc.sandbox.test.ts`);
 *  - a hung host is cut off at the ceiling as `EmailSendTimeoutError`;
 *  - any other failure passes through untouched (a counted attempt);
 *  - `countTimeoutsAsAttempts` turns a timeout into a counted failure, because
 *    `ctx.email` has no idempotency key.
 */
import {
	EmailSendTimeoutError,
	TRANSPORT_UNAVAILABLE_RETRY_MS,
	isCutShortEmailTimeout,
	isEmailSendTimeoutError,
	isEmailTransportUnavailableError,
	type EmailTemplate,
	type SendEmailInput,
} from "@urumi.ai/otta-domain";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	countTimeoutsAsAttempts,
	CtxEmailSender,
	EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE,
	EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE,
	EMAIL_LAST_FAILURE_KEY,
	EMAIL_LAST_SENT_KEY,
	EMAIL_TRANSPORT_UNAVAILABLE_KEY,
	emailSendingAvailable,
	emailSendingReport,
	emailSendingStatus,
	emailSendingConfigured,
	isEmailNotConfiguredError,
	LOGIN_EMAIL_TIMEOUT_MS,
	makeEmailSender,
	makeLoginEmailSender,
	SEND_FAILURE_REASON_MAX,
	sendFailureReason,
} from "../src/email/ctx-email-sender.js";
import type { EmailAccess, EmailMessage, PluginContext } from "../src/types.js";

afterEach(() => {
	vi.useRealTimers();
});

const INPUT: SendEmailInput = {
	to: "buyer@example.com" as never,
	template: "order-confirmation",
	data: { orderId: "ord-1", currency: "USD", totalCents: 1000 },
	idempotencyKey: "row-1",
};

/** What `send` rejects with, or `undefined`. */
function rejectionOf(promise: Promise<void>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(err: unknown) => err,
	);
}

function senderOver(send: EmailAccess["send"], requestTimeoutMs?: number) {
	return new CtxEmailSender({ email: { send }, requestTimeoutMs });
}

function ctxWith(email?: EmailAccess, kv = new Map<string, unknown>()): PluginContext {
	return {
		http: { fetch: () => Promise.reject(new Error("email never uses ctx.http")) },
		kv: {
			get: async <T>(key: string) => (kv.has(key) ? (kv.get(key) as T) : null),
			set: async (key: string, value: unknown) => {
				kv.set(key, value);
			},
			delete: async (key: string) => kv.delete(key),
			list: async () => [],
		},
		...(email === undefined ? {} : { email }),
	};
}

describe("no EmDash email provider", () => {
	test.each([
		// The host's sandbox bridge (`@emdash-cms/cloudflare` runner, `emailSend`).
		EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE,
		// The pipeline's `EmailNotConfiguredError` (trusted, or a bridge forwarding it).
		EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE,
	])("%j becomes EmailTransportUnavailableError", async (message) => {
		const err = await rejectionOf(senderOver(() => Promise.reject(new Error(message))).send(INPUT));
		expect(isEmailTransportUnavailableError(err)).toBe(true);
	});

	test("the pipeline text is EmDash's own: read from the installed package's source", () => {
		// `emdash` is not this package's dependency; resolve it the way the sites do,
		// through `@urumi.ai/otta-store-emdash` → `@emdash-cms/cloudflare` → `emdash`.
		const fromStore = createRequire(
			path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../store-emdash/package.json"),
		);
		const cloudflare = path.resolve(
			path.dirname(fromStore.resolve("@emdash-cms/cloudflare")),
			"..",
		);
		const fromCloudflare = createRequire(path.join(cloudflare, "package.json"));
		const emdashRoot = path.resolve(path.dirname(fromCloudflare.resolve("emdash")), "..");
		const pipeline = readFileSync(path.join(emdashRoot, "src/plugins/email.ts"), "utf8");
		const bridge = readFileSync(path.join(cloudflare, "src/sandbox/bridge.ts"), "utf8");
		// The constructor's message, as the string literals it is concatenated from.
		const ctor = /class EmailNotConfiguredError[\s\S]*?super\(([\s\S]*?)\);/.exec(pipeline)?.[1];
		const text = [...(ctor ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)]
			.map((m) => JSON.parse(`"${m[1] ?? ""}"`) as string)
			.join("");
		expect(text).toBe(EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE);
		expect(pipeline).toContain('this.name = "EmailNotConfiguredError"');
		expect(bridge).toContain(JSON.stringify(EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE));
	});

	test.each([
		// A provider error that QUOTES the text — e.g. a recipient a buyer chose.
		`Invalid recipient: email is not configured@attacker.test`,
		`Illegal address 'no email provider is configured@x.test'`,
		`SMTP email is not configured: missing API key`,
		`${EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE} (quoted by a provider)`,
		` ${EMDASH_PIPELINE_NOT_CONFIGURED_MESSAGE}`,
	])(
		"security F1: %j is an ORDINARY (counted) failure, and never records 'no provider'",
		async (message) => {
			const kv = new Map<string, unknown>();
			const boom = new Error(message);
			const ctx = ctxWith({ send: () => Promise.reject(boom) }, kv);
			expect(isEmailNotConfiguredError(boom)).toBe(false);
			const sender = await makeEmailSender(ctx);
			const err = await rejectionOf(sender!.send(INPUT));
			expect(err).toBe(boom);
			expect(isEmailTransportUnavailableError(err)).toBe(false);
			// No "no provider" record: email stays on for every other buyer.
			expect(kv.has(EMAIL_TRANSPORT_UNAVAILABLE_KEY)).toBe(false);
			expect(await emailSendingAvailable(ctx)).toBe(true);
		},
	);

	test("recognised by name too, when a bridge keeps it", () => {
		expect(isEmailNotConfiguredError({ name: "EmailNotConfiguredError", message: "x" })).toBe(true);
		expect(isEmailNotConfiguredError(new Error("provider said no"))).toBe(false);
		expect(isEmailNotConfiguredError(undefined)).toBe(false);
	});

	test("trusted mode: ctx.email absent ⇒ not configured, and no sender is built", async () => {
		expect(emailSendingConfigured(ctxWith())).toBe(false);
		expect(await makeEmailSender(ctxWith())).toBeUndefined();
		expect(await makeLoginEmailSender(ctxWith())).toBeUndefined();
	});
});

/** The host's sandbox bridge answer with no provider selected. */
const notConfigured = () =>
	Promise.reject(new Error("Email is not configured. No email provider is available."));

describe("a sandboxed host's 'no provider' answer is remembered (ADR-0031)", () => {
	test("the answer is recorded, and while it is fresh nothing tries to send — the sign-in sender is not even built", async () => {
		const kv = new Map<string, unknown>();
		const ctx = ctxWith({ send: notConfigured }, kv);
		expect(await emailSendingAvailable(ctx)).toBe(true);
		const sender = await makeEmailSender(ctx);
		const err = await rejectionOf(sender!.send(INPUT));
		expect(isEmailTransportUnavailableError(err)).toBe(true);
		expect(typeof kv.get(EMAIL_TRANSPORT_UNAVAILABLE_KEY)).toBe("string");

		expect(await emailSendingAvailable(ctx)).toBe(false);
		// No sender ⇒ `requestLoginLink` mints no challenge and spends no throttle slot.
		expect(await makeLoginEmailSender(ctx)).toBeUndefined();
	});

	test("it lapses: after the retry window one send is tried again", async () => {
		const kv = new Map<string, unknown>([
			[
				EMAIL_TRANSPORT_UNAVAILABLE_KEY,
				new Date(Date.now() - TRANSPORT_UNAVAILABLE_RETRY_MS - 1).toISOString(),
			],
		]);
		const ctx = ctxWith({ send: async () => undefined }, kv);
		expect(await emailSendingAvailable(ctx)).toBe(true);
		expect(await makeLoginEmailSender(ctx)).toBeDefined();
	});

	test("an unreadable or garbage record reads as 'try' (fail-soft)", async () => {
		const garbage = ctxWith(
			{ send: async () => undefined },
			new Map([[EMAIL_TRANSPORT_UNAVAILABLE_KEY, 42]]),
		);
		expect(await emailSendingAvailable(garbage)).toBe(true);
		const failing = ctxWith({ send: async () => undefined });
		failing.kv.get = () => Promise.reject(new Error("kv down"));
		expect(await emailSendingAvailable(failing)).toBe(true);
	});
});

/** Let the un-awaited "last sent" write settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("PR #418 review: a delivered send is recorded, and the status has three states", () => {
	test("a send the host accepts records `state:emailLastSentAt`", async () => {
		const kv = new Map<string, unknown>();
		const ctx = ctxWith({ send: async () => undefined }, kv);
		await (await makeEmailSender(ctx))!.send(INPUT);
		await settle();
		expect(typeof kv.get(EMAIL_LAST_SENT_KEY)).toBe("string");
	});

	test("a failed, refused or timed-out send records nothing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		for (const send of [
			() => Promise.reject(new Error("provider said no")),
			notConfigured,
			() => new Promise<void>(() => {}),
		]) {
			const kv = new Map<string, unknown>();
			const ctx = ctxWith({ send }, kv);
			const pending = rejectionOf(
				(await makeEmailSender(ctx, { requestTimeoutMs: 10 }))!.send(INPUT),
			);
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toBeDefined();
			expect(kv.has(EMAIL_LAST_SENT_KEY)).toBe(false);
		}
	});

	test("a failing record write never fails the send (the email went)", async () => {
		const ctx = ctxWith({ send: async () => undefined });
		ctx.kv.set = () => Promise.reject(new Error("kv down"));
		const sender = await makeEmailSender(ctx);
		expect(await rejectionOf(sender!.send(INPUT))).toBeUndefined();
		await settle();
	});

	test("unavailable: no ctx.email, or a fresh 'no provider' answer", async () => {
		expect(await emailSendingStatus(ctxWith())).toBe("unavailable");
		const now = Date.parse("2026-10-08T12:00:00.000Z");
		const ctx = ctxWith(
			{ send: async () => undefined },
			new Map([
				[EMAIL_LAST_SENT_KEY, "2026-10-08T11:00:00.000Z"],
				[EMAIL_TRANSPORT_UNAVAILABLE_KEY, new Date(now - 1_000).toISOString()],
			]),
		);
		expect(await emailSendingStatus(ctx, now)).toBe("unavailable");
	});

	test("unconfirmed: ctx.email there (an idle sandboxed host always looks so) but nothing sent through it yet", async () => {
		expect(await emailSendingStatus(ctxWith({ send: notConfigured }))).toBe("unconfirmed");
	});

	test("unconfirmed: the last send is OLDER than a lapsed 'no provider' answer", async () => {
		const now = Date.parse("2026-10-08T12:00:00.000Z");
		const ctx = ctxWith(
			{ send: async () => undefined },
			new Map([
				[EMAIL_LAST_SENT_KEY, "2026-10-08T10:00:00.000Z"],
				[EMAIL_TRANSPORT_UNAVAILABLE_KEY, "2026-10-08T11:00:00.000Z"],
			]),
		);
		expect(await emailSendingStatus(ctx, now)).toBe("unconfirmed");
	});

	test("confirmed: a send went through, more recently than any 'no provider' answer", async () => {
		const now = Date.parse("2026-10-08T12:00:00.000Z");
		const ctx = ctxWith(
			{ send: async () => undefined },
			new Map([
				[EMAIL_TRANSPORT_UNAVAILABLE_KEY, "2026-10-08T10:00:00.000Z"],
				[EMAIL_LAST_SENT_KEY, "2026-10-08T11:00:00.000Z"],
			]),
		);
		expect(await emailSendingStatus(ctx, now)).toBe("confirmed");
	});

	test("unreadable or garbage records err toward unconfirmed (fail-soft)", async () => {
		const garbage = ctxWith({ send: async () => undefined }, new Map([[EMAIL_LAST_SENT_KEY, 42]]));
		expect(await emailSendingStatus(garbage)).toBe("unconfirmed");
		const failing = ctxWith({ send: async () => undefined });
		failing.kv.get = () => Promise.reject(new Error("kv down"));
		expect(await emailSendingStatus(failing)).toBe("unconfirmed");
	});
});

describe("issue #677: a failed send is recorded for Settings, without the recipient", () => {
	/** A context whose kv counts its writes. */
	function counted(send: EmailAccess["send"], kv = new Map<string, unknown>()) {
		const ctx = ctxWith({ send }, kv);
		const writes: string[] = [];
		const set = ctx.kv.set.bind(ctx.kv);
		ctx.kv.set = async (key, value) => {
			writes.push(key);
			await set(key, value);
		};
		return { ctx, kv, writes };
	}

	test("a provider error is recorded with its time and a reason that names no recipient, URL or key", async () => {
		const { ctx, kv } = counted(() =>
			Promise.reject(
				new Error(
					"[cloudflare-email] daily sending quota exceeded for buyer@example.com; see https://dash.example/x?token=abc key " +
						["sk", "live", "0123456789abcdefghijklmnop"].join("_"),
				),
			),
		);
		const before = Date.now();
		expect(await rejectionOf((await makeEmailSender(ctx))!.send(INPUT))).toBeDefined();
		await settle();
		const failure = kv.get(EMAIL_LAST_FAILURE_KEY) as { at: string; reason: string };
		expect(Date.parse(failure.at)).toBeGreaterThanOrEqual(before);
		expect(failure.reason).toContain("daily sending quota exceeded for [address]");
		expect(failure.reason).not.toMatch(/buyer|example\.com|https|token|sk_live/);
		expect(failure.reason.length).toBeLessThanOrEqual(SEND_FAILURE_REASON_MAX);
		// Nothing claims it was sent.
		expect(kv.has(EMAIL_LAST_SENT_KEY)).toBe(false);
	});

	test("a timed-out send is recorded as one", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { ctx, kv } = counted(() => new Promise<void>(() => {}));
		const pending = rejectionOf(
			(await makeEmailSender(ctx, { requestTimeoutMs: 10 }))!.send(INPUT),
		);
		await vi.advanceTimersByTimeAsync(10);
		expect(await pending).toBeDefined();
		expect((kv.get(EMAIL_LAST_FAILURE_KEY) as { reason: string }).reason).toBe(
			"timed out (may have been delivered)",
		);
	});

	test("'no provider', a cut-short send and a delivered send record no failure", async () => {
		for (const [send, canStart] of [
			[notConfigured, undefined],
			[async () => undefined, () => false],
			[async () => undefined, undefined],
		] as const) {
			const { ctx, kv } = counted(send);
			const sender = await makeEmailSender(ctx, canStart === undefined ? {} : { canStart });
			await rejectionOf(sender!.send(INPUT));
			await settle();
			expect(kv.has(EMAIL_LAST_FAILURE_KEY)).toBe(false);
		}
	});

	test("writes stay bounded: one record per sender, failing or delivering", async () => {
		const failing = counted(() => Promise.reject(new Error("quota")));
		const sender = (await makeEmailSender(failing.ctx))!;
		for (let i = 0; i < 3; i++) await rejectionOf(sender.send(INPUT));
		await settle();
		expect(failing.writes).toEqual([EMAIL_LAST_FAILURE_KEY]);

		const delivering = counted(async () => undefined);
		const ok = (await makeEmailSender(delivering.ctx))!;
		for (let i = 0; i < 3; i++) await ok.send(INPUT);
		await settle();
		expect(delivering.writes).toEqual([EMAIL_LAST_SENT_KEY]);
	});

	test("the record follows the provider's latest outcome: fail, deliver, fail writes each change once", async () => {
		const outcomes = ["fail", "fail", "ok", "ok", "fail", "fail"];
		const { ctx, kv, writes } = counted(() =>
			outcomes.shift() === "ok" ? Promise.resolve() : Promise.reject(new Error("quota")),
		);
		const sender = (await makeEmailSender(ctx))!;
		for (let i = 0; i < 6; i++) {
			await rejectionOf(sender.send(INPUT));
			// Distinct timestamps, as sends seconds apart have.
			await new Promise<void>((resolve) => setTimeout(resolve, 2));
		}
		await settle();
		// One write per change of outcome, never one per email.
		expect(writes).toEqual([EMAIL_LAST_FAILURE_KEY, EMAIL_LAST_SENT_KEY, EMAIL_LAST_FAILURE_KEY]);
		// The last word is the failure after the delivery: Settings shows it.
		expect((await emailSendingReport(ctx)).lastFailure).toMatchObject({ reason: "quota" });
		expect(kv.has(EMAIL_LAST_SENT_KEY)).toBe(true);
	});

	test("a sign-in email's failure is not recorded: it spends no order-email attempt", async () => {
		const { ctx, kv } = counted(() => Promise.reject(new Error("quota")));
		await rejectionOf((await makeLoginEmailSender(ctx))!.send(INPUT));
		await settle();
		expect(kv.has(EMAIL_LAST_FAILURE_KEY)).toBe(false);
	});

	test("a failing record write never changes the send's own error", async () => {
		const ctx = ctxWith({ send: () => Promise.reject(new Error("quota")) });
		ctx.kv.set = () => Promise.reject(new Error("kv down"));
		const err = await rejectionOf((await makeEmailSender(ctx))!.send(INPUT));
		expect((err as Error).message).toBe("quota");
		await settle();
	});

	test("the reason: control characters collapse, long ones are cut, and an empty one says so", () => {
		expect(sendFailureReason(new Error("line one\r\nline\ttwo"), "x@y.test")).toBe(
			"line one line two",
		);
		const long = sendFailureReason(new Error("word ".repeat(40)), "x@y.test");
		expect(long.length).toBe(SEND_FAILURE_REASON_MAX);
		expect(long.endsWith("…")).toBe(true);
		expect(sendFailureReason(new Error(""), "x@y.test")).toBe("no reason given");
		expect(sendFailureReason({}, "x@y.test")).toBe("no reason given");
		// The recipient is removed even when it is not address-shaped.
		expect(sendFailureReason(new Error("rejected Buyer-Name"), "Buyer-Name")).toBe(
			"rejected [address]",
		);
	});

	// #677 review: a provider may answer with a long minified, base64 or HTML
	// body. The reason runs synchronously before the send's own error is
	// rethrown, inside a cron tick or the settle request, so it must be linear.
	test("a 100 KB message with no spaces is reduced in a few ms", () => {
		for (const huge of [
			"a".repeat(100_000),
			"a@".repeat(50_000),
			"a.".repeat(50_000) + "/",
			"http://" + "x".repeat(100_000),
			"x".repeat(100_000) + "@" + "y".repeat(100_000),
			'"' + "q".repeat(100_000) + '"@example.com',
		]) {
			const start = performance.now();
			const reason = sendFailureReason(new Error(huge), "buyer@example.com");
			expect(performance.now() - start).toBeLessThan(50);
			expect(reason.length).toBeLessThanOrEqual(SEND_FAILURE_REASON_MAX);
		}
	});

	test("the reason redacts addresses however they are encoded, keys, tokens and URLs", () => {
		const to = "Jane.Buyer@Example.com";
		const cases: [string, RegExp][] = [
			["rejected JANE.BUYER@EXAMPLE.COM", /jane|example/i],
			["rejected mailbox jane.buyer", /jane/i],
			["bad rcpt jane.buyer%40example.com", /jane|example/i],
			["bad rcpt other%40mail.test", /other|mail\.test/i],
			["bad rcpt other=40mail.test", /other|mail\.test/i],
			["To: =?UTF-8?Q?other=40mail.test?=", /other|mail\.test/i],
			["bad rcpt other&#64;mail.test", /other|mail\.test/i],
			["bad rcpt other&#x40;mail.test", /other|mail\.test/i],
			["bad rcpt other&commat;mail.test", /other|mail\.test/i],
			["bad rcpt other＠mail.test", /other|mail\.test/i],
			["bad rcpt other﹫mail.test", /other|mail\.test/i],
			["bad rcpt other (at) mail.test", /other|mail\.test/i],
			["bad rcpt other[at]mail.test", /other|mail\.test/i],
			['bad rcpt "Jane Doe"@mail.test', /jane|doe|mail\.test/i],
			["auth failed key=abc123", /abc123/],
			["Authorization: Bearer abcdef", /abcdef/],
			["api_key: s3cr3tvalue", /s3cr3t/],
			["password=hunter2 rejected", /hunter2/],
			["signature=deadbeef invalid", /deadbeef/],
			["Basic dXNlcjpwYXNz rejected", /dXNlcjpwYXNz/],
			["token sk_live_51Habc123", /sk_live|51Habc/],
			["AKIAIOSFODNN7EXAMPLE denied", /AKIAIOSFODNN7/],
			["see dash.example.com/acct/9?token=q", /dash\.example|acct|token=q/],
			["see https://dash.example/x?y=1", /dash\.example|y=1/],
		];
		for (const [message, leak] of cases) {
			const reason = sendFailureReason(new Error(message), to);
			expect(reason, message).not.toMatch(leak);
			expect(reason, message).not.toBe("no reason given");
		}
		// Words the merchant needs survive.
		expect(sendFailureReason(new Error("daily sending quota exceeded."), to)).toBe(
			"daily sending quota exceeded",
		);
		expect(
			sendFailureReason(new Error('[cloudflare-email] send_email binding "EMAIL" not found'), to),
		).toBe('[cloudflare-email] send_email binding "EMAIL" not found');
	});

	// #677 review round 2: redaction must not eat the operator's own words.
	test("a short or plain recipient local part never redacts ordinary words", () => {
		const cases: [string, string, string][] = [
			["not@shop.test", "sender domain not verified", "sender domain not verified"],
			["info@shop.test", "insufficient information", "insufficient information"],
			["max@shop.test", "max sends per day reached", "max sends per day reached"],
			["user@shop.test", "username rejected for user", "username rejected for user"],
			["the@shop.test", "the binding is missing", "the binding is missing"],
			["email@shop.test", "Email sending disabled", "Email sending disabled"],
		];
		for (const [to, message, expected] of cases) {
			expect(sendFailureReason(new Error(message), to), to).toBe(expected);
		}
		// An identifier-like local part is still redacted, as a whole token only.
		expect(sendFailureReason(new Error("no mailbox jane.doe here"), "jane.doe@x.test")).toBe(
			"no mailbox [address] here",
		);
		expect(sendFailureReason(new Error("no mailbox jane.doex"), "jane.doe@x.test")).toBe(
			"no mailbox jane.doex",
		);
		expect(sendFailureReason(new Error("rejected buyer42"), "buyer42@x.test")).toBe(
			"rejected [address]",
		);
	});

	test("=40, %40 and (at) become @ only between address-like text", () => {
		for (const message of [
			"rate limit=400 per day",
			"code=403 forbidden",
			"failed (at) 10:00 UTC",
			"retry [at] noon",
			"usage 100%40 of quota",
		]) {
			expect(sendFailureReason(new Error(message), "b@x.test")).toBe(message);
		}
	});

	test("only a whole RFC 2047 encoded word is unwrapped; a URL's ?= stays in the URL", () => {
		expect(sendFailureReason(new Error("see https://x.test/a?=SECRETVALUE now"), "b@x.test")).toBe(
			"see [url] now",
		);
		expect(sendFailureReason(new Error("to =?utf-8?q?al=40mail.test?= failed"), "b@x.test")).toBe(
			"to [address] failed",
		);
	});

	test("provider error codes survive; long hex, digit and blob runs do not", () => {
		for (const code of [
			"E_SENDER_DOMAIN_NOT_VERIFIED",
			"daily_sending_quota_exceeded",
			"destination_address_not_verified",
			"insufficient_permissions",
			"cloudflare-email-sending-is-not-enabled",
		]) {
			expect(sendFailureReason(new Error(`failed: ${code}`), "b@x.test")).toBe(`failed: ${code}`);
		}
		for (const [message, leak] of [
			["req 9f8e7d6c5b4a39281706f5e4d3c2b1a0", /9f8e7d/],
			["ref 12345678901234567890", /1234567890/],
			["blob abcdefghijklmnopqrstuvwxyzABCDEFGH", /abcdefghij/],
			["blob ab+cdefghij/klmnopqrstuvwxyzABCDEF==", /cdefghij/],
		] as const) {
			expect(sendFailureReason(new Error(message), "b@x.test")).not.toMatch(leak);
		}
	});

	test("a reporter that throws at once leaves the sender able to record the next failure", async () => {
		const reasons: string[] = [];
		let calls = 0;
		const sender = new CtxEmailSender({
			email: { send: () => Promise.reject(new Error("quota")) },
			onFailed: (reason) => {
				calls++;
				if (calls === 1) throw new Error("sync boom");
				reasons.push(reason);
				return Promise.resolve();
			},
		});
		await rejectionOf(sender.send(INPUT));
		await rejectionOf(sender.send(INPUT));
		expect(calls).toBe(2);
		expect(reasons).toEqual(["quota"]);
	});

	test("an error whose message cannot be read never replaces the send's own error", async () => {
		const odd = {
			get message(): string {
				throw new Error("getter boom");
			},
		};
		const { ctx, kv } = counted(() => Promise.reject(odd));
		const err = await rejectionOf((await makeEmailSender(ctx))!.send(INPUT));
		expect(err).toBe(odd);
		await settle();
		expect((kv.get(EMAIL_LAST_FAILURE_KEY) as { reason: string }).reason).toBe("no reason given");
	});

	describe("emailSendingReport", () => {
		const now = Date.parse("2026-10-08T12:00:00.000Z");
		const failure = { at: "2026-10-08T11:30:00.000Z", reason: "quota exceeded" };

		test("a failure AFTER the last delivered send is shown, and the status stays confirmed", async () => {
			const ctx = ctxWith(
				{ send: async () => undefined },
				new Map<string, unknown>([
					[EMAIL_LAST_SENT_KEY, "2026-10-08T11:00:00.000Z"],
					[EMAIL_LAST_FAILURE_KEY, failure],
				]),
			);
			expect(await emailSendingReport(ctx, now)).toEqual({
				status: "confirmed",
				lastFailure: failure,
			});
		});

		test("a failure with nothing ever delivered is shown beside unconfirmed", async () => {
			const ctx = ctxWith(
				{ send: async () => undefined },
				new Map<string, unknown>([[EMAIL_LAST_FAILURE_KEY, failure]]),
			);
			expect(await emailSendingReport(ctx, now)).toEqual({
				status: "unconfirmed",
				lastFailure: failure,
			});
		});

		test("a send in the same millisecond as the failure hides it: ties go to the delivery", async () => {
			const ctx = ctxWith(
				{ send: async () => undefined },
				new Map<string, unknown>([
					[EMAIL_LAST_SENT_KEY, failure.at],
					[EMAIL_LAST_FAILURE_KEY, failure],
				]),
			);
			expect(await emailSendingReport(ctx, now)).toEqual({ status: "confirmed" });
		});

		test("a send delivered since hides it; 'no provider' and garbage show none", async () => {
			const since = ctxWith(
				{ send: async () => undefined },
				new Map<string, unknown>([
					[EMAIL_LAST_SENT_KEY, "2026-10-08T11:45:00.000Z"],
					[EMAIL_LAST_FAILURE_KEY, failure],
				]),
			);
			expect(await emailSendingReport(since, now)).toEqual({ status: "confirmed" });
			expect(await emailSendingReport(ctxWith(), now)).toEqual({ status: "unavailable" });
			for (const garbage of ["2026-10-08", { at: "nope", reason: "x" }, { at: failure.at }]) {
				const ctx = ctxWith(
					{ send: async () => undefined },
					new Map<string, unknown>([[EMAIL_LAST_FAILURE_KEY, garbage]]),
				);
				expect(await emailSendingReport(ctx, now)).toEqual({ status: "unconfirmed" });
			}
		});
	});
});

describe("the send", () => {
	test("hands the host exactly EmDash's EmailMessage — to, subject, text, html", async () => {
		const sent: EmailMessage[] = [];
		await senderOver(async (m) => {
			sent.push(m);
		}).send(INPUT);
		expect(sent).toHaveLength(1);
		expect(Object.keys(sent[0] ?? {}).toSorted()).toEqual(["html", "subject", "text", "to"]);
		expect(sent[0]?.to).toBe("buyer@example.com");
	});

	test("every template goes out through ctx.email, the sign-in email included", async () => {
		const templates: EmailTemplate[] = [
			"customer-login-link",
			"order-confirmation",
			"order-processing",
			"order-shipped",
			"order-delivered",
			"order-completed",
			"order-cancelled",
			"order-refunded",
			"order-expired",
			"order-late-payment-refunded",
			"order-refund-issued",
		];
		const sent: EmailMessage[] = [];
		const sender = await makeEmailSender(
			ctxWith({
				send: async (m) => {
					sent.push(m);
				},
			}),
		);
		for (const template of templates) {
			await sender?.send({
				...INPUT,
				template,
				data:
					template === "customer-login-link"
						? { loginUrl: "https://shop.example/account/verify?c=1&t=2", expiresInMinutes: 15 }
						: { ...INPUT.data, noticeAmountCents: 100, noticeCurrency: "USD" },
			});
		}
		expect(sent).toHaveLength(templates.length);
		for (const mail of sent) {
			expect(mail.subject.length).toBeGreaterThan(0);
			expect(mail.text.length).toBeGreaterThan(0);
		}
	});

	test("a provider failure passes through untouched — a counted attempt", async () => {
		const boom = new Error("provider said no");
		expect(await rejectionOf(senderOver(() => Promise.reject(boom)).send(INPUT))).toBe(boom);
	});

	test("a hung host is cut off at the ceiling as EmailSendTimeoutError", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = rejectionOf(senderOver(() => new Promise<void>(() => {}), 1_234).send(INPUT));
		await vi.advanceTimersByTimeAsync(1_234);
		const err = await pending;
		expect(isEmailSendTimeoutError(err)).toBe(true);
		expect(err).toMatchObject({ timeoutMs: 1_234 });
	});

	test("the login sender's ceiling is 3 s (ADR-0004)", async () => {
		expect(LOGIN_EMAIL_TIMEOUT_MS).toBe(3_000);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const sender = await makeLoginEmailSender(ctxWith({ send: () => new Promise<void>(() => {}) }));
		const pending = rejectionOf(sender!.send(INPUT));
		await vi.advanceTimersByTimeAsync(LOGIN_EMAIL_TIMEOUT_MS);
		expect(await pending).toMatchObject({ timeoutMs: LOGIN_EMAIL_TIMEOUT_MS });
	});
});

describe("countTimeoutsAsAttempts", () => {
	test("a timeout becomes an ordinary (counted) failure that still names the allowance", async () => {
		const err = await rejectionOf(
			countTimeoutsAsAttempts({
				send: () => Promise.reject(new EmailSendTimeoutError(5_000)),
			}).send(INPUT),
		);
		expect(isEmailSendTimeoutError(err)).toBe(false);
		expect(String((err as Error).message)).toContain("5000 ms");
	});

	test("#502: a CUT-SHORT timeout (the send never started) passes through uncounted", async () => {
		const cut = new EmailSendTimeoutError(0, { cutShort: true });
		expect(
			await rejectionOf(countTimeoutsAsAttempts({ send: () => Promise.reject(cut) }).send(INPUT)),
		).toBe(cut);
	});

	test("#502: `canStart` refusing after the render ⇒ a cut-short timeout, and ctx.email is never called", async () => {
		const messages: EmailMessage[] = [];
		const sender = new CtxEmailSender({
			email: {
				async send(message) {
					messages.push(message);
				},
			},
			canStart: () => false,
		});
		const err = await rejectionOf(sender.send(INPUT));
		expect(isCutShortEmailTimeout(err)).toBe(true);
		expect(messages).toEqual([]);
	});

	test("the no-provider error and any other failure pass through untouched", async () => {
		const boom = new Error("provider said no");
		expect(
			await rejectionOf(countTimeoutsAsAttempts({ send: () => Promise.reject(boom) }).send(INPUT)),
		).toBe(boom);
		const unavailable = await rejectionOf(
			countTimeoutsAsAttempts(
				senderOver(() => Promise.reject(new Error(EMDASH_SANDBOX_NOT_CONFIGURED_MESSAGE))),
			).send(INPUT),
		);
		expect(isEmailTransportUnavailableError(unavailable)).toBe(true);
	});
});
