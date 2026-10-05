/**
 * The SMTP2GO `EmailSender`, and the provider choice that picks it.
 *
 * SMTP2GO's send API (`POST /v3/email/send`, checked against the live API on
 * 2026-10-05) differs from Resend's in the three ways that matter here:
 *  - the key rides in `X-Smtp2go-Api-Key`, not `Authorization: Bearer`;
 *  - `to` is an ARRAY, the sender is `sender`, the bodies are
 *    `html_body`/`text_body`, and headers go in `custom_headers`;
 *  - a REFUSED send can come back as HTTP 200, with `data.failed > 0` and the
 *    reason in `data.failures`. Reading only the status would mark the outbox
 *    row sent for a mail that never left, so a 200 is a success only when
 *    `data.succeeded` says one message was accepted.
 * It also has no idempotency key: the outbox's claim is the only dedupe.
 *
 * Everything here runs over a fake `fetch`; no request leaves the machine.
 */
import { renderEmail } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	CtxHttpEmailSender,
	EMAIL_FROM_KEY,
	emailSendingConfigured,
	makeEmailSender,
	makeLoginEmailSender,
} from "../src/email/ctx-http-email-sender.js";
import { storefrontEmailMoney } from "../src/email/email-render-context.js";
import { EMAIL_PROVIDER_KEY, SMTP2GO_REGION_KEY } from "../src/email/email-provider.js";
import { EmailProviderError } from "../src/email/http-email-sender.js";
import { Smtp2goEmailSender } from "../src/email/smtp2go-email-sender.js";
import { SMTP2GO_API_HOSTS } from "../src/manifest.js";
import { EMAIL_API_KEY_KEY } from "../src/payment-secrets.js";
import { STOREFRONT_LOCALE } from "../src/storefront/route-input.js";
import type { PluginContext } from "../src/types.js";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

/** A fake key with SMTP2GO's shape. Never a real one. */
const FAKE_KEY = "api-0123456789ABCDEF0123456789ABCDEF";

const OK_BODY = JSON.stringify({
	request_id: "aa253464-0bd0-467a-b24b-6159dcd7be60",
	data: { succeeded: 1, failed: 0, failures: [], email_id: "1er8bV-6Tw0Mi-7h" },
});

/** The live refusal for an unverified sender domain, as SMTP2GO words it — a
 *  200 status, a newline inside the message, and a code at the end. */
const UNVERIFIED_SENDER_BODY = JSON.stringify({
	request_id: "c0ffee00-0000-4000-8000-000000000000",
	data: {
		succeeded: 0,
		failed: 1,
		failures: [
			"An error occurred during the SMTP request: From header sender domain not verified (shop.test)\nOn your Sending > Verified Senders page add and verify the sender domain - Code(550)",
		],
		email_id: "",
	},
});

function recordingFetch(
	status: number,
	body: string,
): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: (url, init) => {
			calls.push({ url, init });
			return Promise.resolve(new Response(body, { status }));
		},
	};
}

const input = {
	to: "buyer@example.test" as never,
	template: "order-confirmation" as const,
	data: { orderId: "ord_1", totalCents: 2599, currency: "USD" },
	idempotencyKey: "outbox_row_1",
};

function sender(
	status: number,
	body: string,
	options: { region?: "global" | "us" | "eu" | "au"; apiKey?: string } = {},
): { sender: Smtp2goEmailSender; calls: Call[] } {
	const { fetch, calls } = recordingFetch(status, body);
	return {
		calls,
		sender: new Smtp2goEmailSender({
			fetch,
			from: "Shop <orders@shop.test>",
			region: options.region ?? "global",
			apiKey: "apiKey" in options ? options.apiKey : FAKE_KEY,
		}),
	};
}

async function failure(status: number, body: string, to = input.to): Promise<unknown> {
	const { sender: s } = sender(status, body);
	try {
		await s.send({ ...input, to });
	} catch (err) {
		return err;
	}
	throw new Error("expected the send to fail");
}

describe("Smtp2goEmailSender — SMTP2GO's send API, exactly", () => {
	test("posts SMTP2GO's body to /v3/email/send, with the key in X-Smtp2go-Api-Key", async () => {
		const { sender: s, calls } = sender(200, OK_BODY);
		await s.send(input);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe("https://api.smtp2go.com/v3/email/send");
		expect(call?.init?.method).toBe("POST");
		const headers = call?.init?.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["X-Smtp2go-Api-Key"]).toBe(FAKE_KEY);
		// Not Resend's bearer, and no Idempotency-Key: SMTP2GO defines neither.
		expect(Object.hasOwn(headers, "authorization")).toBe(false);
		expect(Object.hasOwn(headers, "Idempotency-Key")).toBe(false);

		const rendered = renderEmail(input.template, input.data, {
			formatMoney: storefrontEmailMoney,
			locale: STOREFRONT_LOCALE,
		});
		expect(JSON.parse(String(call?.init?.body))).toEqual({
			sender: "Shop <orders@shop.test>",
			to: [input.to],
			subject: rendered.subject,
			html_body: rendered.html,
			text_body: rendered.text,
			// The outbox row id, for finding the message in SMTP2GO's activity log.
			// A correlation header only: SMTP2GO does not dedupe on it.
			custom_headers: [{ header: "X-Otta-Id", value: input.idempotencyKey }],
		});
	});

	test("an unset key sends no key header — SMTP2GO then refuses it, the honest failure", async () => {
		const { sender: s, calls } = sender(200, OK_BODY, { apiKey: undefined });
		await s.send(input);
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(Object.hasOwn(headers, "X-Smtp2go-Api-Key")).toBe(false);
	});

	test.each([
		["global", "https://api.smtp2go.com/v3/email/send"],
		["us", "https://us-api.smtp2go.com/v3/email/send"],
		["eu", "https://eu-api.smtp2go.com/v3/email/send"],
		["au", "https://au-api.smtp2go.com/v3/email/send"],
	] as const)("region %s posts to %s", async (region, url) => {
		const { sender: s, calls } = sender(200, OK_BODY, { region });
		await s.send(input);
		expect(calls[0]?.url).toBe(url);
		// Every region's host is one the build grants.
		expect(Object.values(SMTP2GO_API_HOSTS)).toContain(new URL(url).hostname);
	});

	test("a 200 that accepted the message resolves", async () => {
		const { sender: s } = sender(200, OK_BODY);
		await expect(s.send(input)).resolves.toBeUndefined();
	});
});

describe("Smtp2goEmailSender — a refused send throws, says why, and never echoes the request", () => {
	test("a 200 with failed > 0 is a FAILED send, carrying SMTP2GO's reason", async () => {
		const err = await failure(200, UNVERIFIED_SENDER_BODY);
		expect(err).toBeInstanceOf(EmailProviderError);
		expect(err).toMatchObject({ kind: "refused", status: 200 });
		const message = (err as Error).message;
		expect(message).toContain("From header sender domain not verified (shop.test)");
		// The newline inside SMTP2GO's message cannot start a forged log line.
		expect(message).not.toMatch(/[\r\n]/u);
		expect(message.length).toBeLessThanOrEqual(300);
	});

	test("a 200 with succeeded 0 and no failure text is still a failed send", async () => {
		const body = JSON.stringify({ data: { succeeded: 0, failed: 0, failures: [] } });
		await expect(failure(200, body)).resolves.toMatchObject({ kind: "refused" });
	});

	test("a 200 whose body is not SMTP2GO's JSON is not taken as sent", async () => {
		const err = await failure(200, "<html>gateway says hi</html>");
		expect(err).toMatchObject({ kind: "ambiguous", status: 200 });
		expect((err as Error).message).not.toContain("gateway says hi");
	});

	test.each([
		[401, "auth"],
		[403, "auth"],
		[429, "rate_limited"],
		[500, "unavailable"],
		[503, "unavailable"],
		[400, "invalid"],
	] as const)(
		"status %i is a %s failure, with SMTP2GO's error code and message",
		async (status, kind) => {
			const body = JSON.stringify({
				request_id: "r1",
				data: { error_code: "E_ApiResponseCodes.API_EXCEPTION", error: "Something specific" },
			});
			const err = await failure(status, body);
			expect(err).toBeInstanceOf(EmailProviderError);
			expect(err).toMatchObject({ kind, status });
			expect((err as Error).message).toBe(
				`email transport failed with status ${String(status)}: E_ApiResponseCodes.API_EXCEPTION: Something specific`,
			);
		},
	);

	test("a non-JSON error body throws with the status alone, quoting none of it", async () => {
		const err = await failure(502, "<html>Bad gateway</html>");
		expect((err as Error).message).toBe("email transport failed with status 502");
		expect(err).toMatchObject({ kind: "unavailable" });
	});

	test("the key, the recipient and the rendered body are never in the error", async () => {
		// A provider that quotes everything back at us.
		const echo = JSON.stringify({
			data: {
				succeeded: 0,
				failed: 1,
				failures: [`key ${FAKE_KEY} to BUYER@example.test`],
			},
		});
		const message = ((await failure(200, echo)) as Error).message;
		expect(message).not.toContain("buyer@example.test");
		expect(message).not.toContain("BUYER@example.test");
		expect(message).toContain("<recipient>");
		// The key is the sender's own secret: redacted even when the provider quotes it.
		expect(message).not.toContain(FAKE_KEY);

		const authEcho = JSON.stringify({ data: { error_code: "E", error: `bad key ${FAKE_KEY}` } });
		expect(((await failure(401, authEcho)) as Error).message).not.toContain(FAKE_KEY);
	});

	test("a verbose failure list is bounded", async () => {
		const body = JSON.stringify({
			data: { succeeded: 0, failed: 1, failures: ["x".repeat(5000)] },
		});
		const message = ((await failure(200, body)) as Error).message;
		expect(message.length).toBeLessThanOrEqual(300);
	});
});

describe("Smtp2goEmailSender — the same timeout and abort behaviour as the Resend sender", () => {
	test("a hung provider is aborted and reported as an EmailSendTimeoutError", async () => {
		const s = new Smtp2goEmailSender({
			fetch: (_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
			from: "orders@shop.test",
			region: "global",
			requestTimeoutMs: 20,
		});
		await expect(s.send(input)).rejects.toMatchObject({ name: "EmailSendTimeoutError" });
	});

	test("a transport failure that is not its own abort stays a failure", async () => {
		const s = new Smtp2goEmailSender({
			fetch: () => Promise.reject(new Error("connection reset")),
			from: "orders@shop.test",
			region: "global",
			requestTimeoutMs: 1000,
		});
		await expect(s.send(input)).rejects.toThrow("connection reset");
	});
});

/** A fake ctx over a Map kv and a recording fetch. */
function makeCtx(seed: Record<string, unknown>, status = 200, body = OK_BODY) {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const reads: string[] = [];
	const { fetch, calls } = recordingFetch(status, body);
	const ctx: PluginContext = {
		http: { fetch },
		kv: {
			async get<T>(k: string): Promise<T | null> {
				reads.push(k);
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, calls, reads };
}

const RESEND_URL = "https://api.resend.com/emails";

describe("makeEmailSender — the provider setting picks the sender", () => {
	test("no provider saved: the Resend-shaped sender, exactly as before", async () => {
		const { ctx } = makeCtx({ [EMAIL_API_KEY_KEY]: "re_testkey_123456" });
		const built = await makeEmailSender(ctx, { apiUrl: RESEND_URL });
		expect(built).toBeInstanceOf(CtxHttpEmailSender);
	});

	test("provider resend: the Resend-shaped sender", async () => {
		const { ctx } = makeCtx({ [EMAIL_PROVIDER_KEY]: "resend" });
		expect(await makeEmailSender(ctx, { apiUrl: RESEND_URL })).toBeInstanceOf(CtxHttpEmailSender);
	});

	test("provider smtp2go: the SMTP2GO sender, with the stored key, from-address and region", async () => {
		const { ctx, calls } = makeCtx({
			[EMAIL_PROVIDER_KEY]: "smtp2go",
			[SMTP2GO_REGION_KEY]: "eu",
			[EMAIL_API_KEY_KEY]: FAKE_KEY,
			[EMAIL_FROM_KEY]: "Shop <orders@shop.test>",
		});
		const built = await makeEmailSender(ctx, { apiUrl: RESEND_URL });
		expect(built).toBeInstanceOf(Smtp2goEmailSender);
		await built?.send(input);
		expect(calls[0]?.url).toBe("https://eu-api.smtp2go.com/v3/email/send");
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers["X-Smtp2go-Api-Key"]).toBe(FAKE_KEY);
		expect(JSON.parse(String(calls[0]?.init?.body))["sender"]).toBe("Shop <orders@shop.test>");
	});

	test("smtp2go needs no build-time email URL: its hosts are always granted", async () => {
		const { ctx } = makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go" });
		expect(await makeEmailSender(ctx, { apiUrl: undefined })).toBeInstanceOf(Smtp2goEmailSender);
		expect(await makeLoginEmailSender(ctx, {})).toBeInstanceOf(Smtp2goEmailSender);
	});

	test("resend with no build-time email URL is still unconfigured", async () => {
		const { ctx } = makeCtx({ [EMAIL_PROVIDER_KEY]: "resend" });
		expect(await makeEmailSender(ctx, { apiUrl: undefined })).toBeUndefined();
	});

	test("an unknown stored provider or region falls back to the defaults", async () => {
		const { ctx, calls } = makeCtx({ [EMAIL_PROVIDER_KEY]: "carrier-pigeon" });
		expect(await makeEmailSender(ctx, { apiUrl: RESEND_URL })).toBeInstanceOf(CtxHttpEmailSender);
		const second = makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go", [SMTP2GO_REGION_KEY]: "mars" });
		const built = await makeEmailSender(second.ctx, {});
		await built?.send(input);
		expect(second.calls[0]?.url).toBe("https://api.smtp2go.com/v3/email/send");
		expect(calls).toHaveLength(0);
	});
});

describe("emailSendingConfigured — can this store send at all", () => {
	test("a build-time email URL is enough, and costs no kv read", async () => {
		const { ctx, reads } = makeCtx({});
		expect(await emailSendingConfigured(ctx, { apiUrl: RESEND_URL })).toBe(true);
		expect(reads).toEqual([]);
	});

	test("no URL: configured only when SMTP2GO is the chosen provider", async () => {
		expect(await emailSendingConfigured(makeCtx({}).ctx, {})).toBe(false);
		expect(await emailSendingConfigured(makeCtx({ [EMAIL_PROVIDER_KEY]: "resend" }).ctx, {})).toBe(
			false,
		);
		expect(await emailSendingConfigured(makeCtx({ [EMAIL_PROVIDER_KEY]: "smtp2go" }).ctx, {})).toBe(
			true,
		);
	});
});
