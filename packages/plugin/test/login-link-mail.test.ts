/**
 * #306 — the sign-in email.
 *
 * Two layers. The client (over a real document store): an issued challenge is
 * mailed exactly once, the mailed token verifies once and only once, and a
 * throttled request sends nothing while answering the same generic success.
 * The ctx mailer: the link comes from `settings:loginLinkUrl`, never from the
 * request, and an unconfigured deployment sends nothing.
 */
import { email as toEmail, renderEmail } from "@otta-sh/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EMAIL_FROM_KEY } from "../src/email/ctx-http-email-sender.js";
import {
	buildLoginLinkUrl,
	ctxLoginLinkMailer,
	EMAIL_LOCALE_KEY,
	isValidLoginLinkUrl,
	LOGIN_LINK_URL_KEY,
	type LoginLinkMailer,
} from "../src/email/login-link-mailer.js";
import type { PluginContext } from "../src/types.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

interface Sent {
	to: string;
	challengeId: string;
	token: string;
}

function recordingMailer(): { mailer: LoginLinkMailer; sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		sent,
		mailer: {
			async send(input) {
				sent.push({ to: input.to, challengeId: input.challengeId, token: input.token });
			},
		},
	};
}

describe("requestLoginLink mails the link (in-process, real store)", () => {
	let harness: InProcessCommerceHarness;
	let sent: Sent[];

	beforeEach(async () => {
		const recording = recordingMailer();
		sent = recording.sent;
		harness = await makeInProcessCommerce({ loginLinkMailer: recording.mailer });
	});
	afterEach(async () => {
		await harness.close();
	});

	test("a new address gets exactly one email, whose token verifies once and only once", async () => {
		expect(await harness.client.requestLoginLink("new@example.test")).toEqual({ ok: true });
		expect(sent).toHaveLength(1);
		const [mail] = sent;
		if (mail === undefined) throw new Error("no mail");
		expect(mail.to).toBe("new@example.test");

		const first = await harness.client.verifyLogin(mail.challengeId, mail.token);
		expect(first.ok).toBe(true);
		const second = await harness.client.verifyLogin(mail.challengeId, mail.token);
		expect(second).toEqual({ ok: false, reason: "CONSUMED" });
	});

	test("a throttled request sends nothing and answers exactly like a sent one", async () => {
		const answers = [];
		for (let i = 0; i < 5; i += 1) {
			answers.push(await harness.client.requestLoginLink("flood@example.test"));
		}
		// The per-address cap is 3 live challenges: two requests were throttled.
		expect(sent).toHaveLength(3);
		expect(answers.every((answer) => JSON.stringify(answer) === '{"ok":true}')).toBe(true);
	});

	test("a malformed address sends nothing and still answers the generic success", async () => {
		expect(await harness.client.requestLoginLink("not-an-email")).toEqual({ ok: true });
		expect(sent).toHaveLength(0);
	});

	test("a transport failure rejects — infrastructure, the same for every address", async () => {
		const failing = await makeInProcessCommerce({
			loginLinkMailer: { send: () => Promise.reject(new Error("provider down")) },
		});
		try {
			await expect(failing.client.requestLoginLink("x@example.test")).rejects.toThrow(
				"provider down",
			);
		} finally {
			await failing.close();
		}
	});
});

interface Call {
	url: string;
	body: Record<string, unknown>;
}

function mailCtx(seed: Record<string, unknown>): { ctx: PluginContext; calls: Call[] } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const calls: Call[] = [];
	const ctx: PluginContext = {
		http: {
			fetch: (url: string, init?: RequestInit) => {
				calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
				return Promise.resolve(new Response("{}", { status: 202 }));
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
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
	return { ctx, calls };
}

const API_URL = "https://mail.example.test/v1/send";
const to = toEmail("buyer@example.test");

describe("ctxLoginLinkMailer", () => {
	test("builds the link from settings:loginLinkUrl and renders in the configured locale", async () => {
		const { ctx, calls } = mailCtx({
			[LOGIN_LINK_URL_KEY]: "https://boutique.example/compte/verifier?src=mail",
			[EMAIL_LOCALE_KEY]: "fr",
			[EMAIL_FROM_KEY]: "boutique@example.test",
		});
		await ctxLoginLinkMailer(ctx, { apiUrl: API_URL }).send({
			to,
			challengeId: "ch-1",
			token: "t/k",
		});

		expect(calls).toHaveLength(1);
		const [call] = calls;
		if (call === undefined) throw new Error("no call");
		expect(call.url).toBe(API_URL);
		const link = "https://boutique.example/compte/verifier?src=mail&challengeId=ch-1&token=t%2Fk";
		const expected = renderEmail("customer-login-link", { loginUrl: link, locale: "fr" });
		expect(call.body).toMatchObject({
			from: "boutique@example.test",
			to: "buyer@example.test",
			subject: "Votre lien de connexion",
			text: expected.text,
			template: "customer-login-link",
		});
	});

	test("sends nothing when no verify page is configured", async () => {
		const { ctx, calls } = mailCtx({});
		await ctxLoginLinkMailer(ctx, { apiUrl: API_URL }).send({ to, challengeId: "c", token: "t" });
		expect(calls).toHaveLength(0);
	});

	test("sends nothing when this build has no email API URL", async () => {
		const { ctx, calls } = mailCtx({ [LOGIN_LINK_URL_KEY]: "https://shop.example/verify" });
		await ctxLoginLinkMailer(ctx, { apiUrl: undefined }).send({ to, challengeId: "c", token: "t" });
		expect(calls).toHaveLength(0);
	});

	test("an invalid stored verify URL is treated as unconfigured", async () => {
		const { ctx, calls } = mailCtx({ [LOGIN_LINK_URL_KEY]: "javascript:alert(1)" });
		await ctxLoginLinkMailer(ctx, { apiUrl: API_URL }).send({ to, challengeId: "c", token: "t" });
		expect(calls).toHaveLength(0);
	});
});

describe("the verify URL", () => {
	test("accepts absolute http(s) only, with no credentials", () => {
		expect(isValidLoginLinkUrl("https://shop.example/account/verify")).toBe(true);
		expect(isValidLoginLinkUrl("http://localhost:4321/account/verify")).toBe(true);
		expect(isValidLoginLinkUrl("/account/verify")).toBe(false);
		expect(isValidLoginLinkUrl("javascript:alert(1)")).toBe(false);
		expect(isValidLoginLinkUrl("https://user:pw@shop.example/verify")).toBe(false);
	});

	test("appends challengeId and token, encoded, keeping existing parameters", () => {
		expect(buildLoginLinkUrl("https://shop.example/v?a=1", "ch", "a b&c")).toBe(
			"https://shop.example/v?a=1&challengeId=ch&token=a+b%26c",
		);
	});
});
