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
	isEmailSendTimeoutError,
	isEmailTransportUnavailableError,
	type EmailTemplate,
	type SendEmailInput,
} from "@otta-sh/domain";
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
	emailSendingConfigured,
	isEmailNotConfiguredError,
	LOGIN_EMAIL_TIMEOUT_MS,
	makeEmailSender,
	makeLoginEmailSender,
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

function ctxWith(email?: EmailAccess): PluginContext {
	return {
		http: { fetch: () => Promise.reject(new Error("email never uses ctx.http")) },
		kv: {
			get: async () => null,
			set: async () => undefined,
			delete: async () => false,
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
		// through `@otta-sh/store-emdash` → `@emdash-cms/cloudflare` → `emdash`.
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
			const boom = new Error(message);
			const ctx = ctxWith({ send: () => Promise.reject(boom) });
			expect(isEmailNotConfiguredError(boom)).toBe(false);
			const sender = await makeEmailSender(ctx);
			const err = await rejectionOf(sender!.send(INPUT));
			expect(err).toBe(boom);
			expect(isEmailTransportUnavailableError(err)).toBe(false);
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
