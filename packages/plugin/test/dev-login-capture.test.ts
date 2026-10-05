/**
 * The DEV-ONLY login-link capture (follow-up to issue #378).
 *
 * A local or CI e2e stack cannot receive the sign-in email: the plugin's email
 * egress is `ctx.http`, which refuses loopback, so no local mailbox can catch
 * the link. `makeLoginEmailSender` therefore has one exception, built exactly
 * like the offline Stripe gateway's (`stripe-wiring.test.ts`): with NO email
 * API URL in the bundle, AND the site's `__OTTA_DEV_LOGIN_CAPTURE__` define
 * baked `true`, AND a Vite dev build, the login link is written to the
 * plugin's own kv instead of being sent. Every other combination keeps the
 * fail-closed answer: no sender, nothing captured.
 */
import { email as toEmail } from "@otta-sh/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CtxHttpEmailSender,
	makeEmailSender,
	makeLoginEmailSender,
} from "../src/email/ctx-http-email-sender.js";
import {
	DEV_LOGIN_CAPTURE_KEY_PREFIX,
	devLoginCaptureEnabled,
	devLoginCaptureKey,
} from "../src/email/dev-login-capture.js";
import type { PluginContext } from "../src/types.js";

const DEFINE = "__OTTA_DEV_LOGIN_CAPTURE__";
const LINK = "http://127.0.0.1:4650/account/verify?challenge=c1&token=t1";

function makeCtx(): {
	ctx: PluginContext;
	kv: Map<string, unknown>;
	calls: string[];
} {
	const kv = new Map<string, unknown>();
	const calls: string[] = [];
	const ctx: PluginContext = {
		http: {
			fetch: (url: string) => {
				calls.push(url);
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
	return { ctx, kv, calls };
}

const loginInput = {
	to: toEmail("Shopper@Example.test"),
	template: "customer-login-link" as const,
	data: { loginUrl: LINK, expiresInMinutes: 15 },
	idempotencyKey: "login:c1",
};

/** The captured entries, whatever their keys. */
function captured(kv: Map<string, unknown>): Array<[string, unknown]> {
	return [...kv].filter(([key]) => key.startsWith(DEV_LOGIN_CAPTURE_KEY_PREFIX));
}

describe("the dev-only login-link capture", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	test("off by default: no define ⇒ no sender, as before", async () => {
		expect(devLoginCaptureEnabled()).toBe(false);
		expect(await makeLoginEmailSender(makeCtx().ctx, {})).toBeUndefined();
	});

	test("define + dev build + no email URL ⇒ the link is written to kv, and nothing is sent", async () => {
		vi.stubGlobal(DEFINE, true);
		expect(devLoginCaptureEnabled()).toBe(true);
		const { ctx, kv, calls } = makeCtx();
		const sender = await makeLoginEmailSender(ctx, {});
		if (sender === undefined) throw new Error("no capture sender built");
		await sender.send(loginInput);
		expect(calls).toHaveLength(0);
		const entries = captured(kv);
		expect(entries).toHaveLength(1);
		const [key, value] = entries[0] ?? [];
		// Keyed by the LOWER-CASED address, so the harness can find it by the
		// address it typed whatever case the store kept.
		expect(key).toBe(devLoginCaptureKey("shopper@example.test"));
		expect(value).toMatchObject({ loginUrl: LINK });
		expect(typeof (value as { capturedAt?: unknown }).capturedAt).toBe("string");
	});

	test("a PRODUCTION build ignores the define: import.meta.env.DEV false ⇒ no sender", async () => {
		vi.stubGlobal(DEFINE, true);
		vi.stubEnv("DEV", false);
		expect(devLoginCaptureEnabled()).toBe(false);
		expect(await makeLoginEmailSender(makeCtx().ctx, {})).toBeUndefined();
	});

	test("only the literal `true` arms it — a truthy non-boolean define does not", () => {
		vi.stubGlobal(DEFINE, "true");
		expect(devLoginCaptureEnabled()).toBe(false);
		vi.stubGlobal(DEFINE, 1);
		expect(devLoginCaptureEnabled()).toBe(false);
	});

	test("a configured email API URL always wins: the real sender, nothing captured", async () => {
		vi.stubGlobal(DEFINE, true);
		const { ctx, kv, calls } = makeCtx();
		const sender = await makeLoginEmailSender(ctx, { apiUrl: "https://api.resend.com/emails" });
		expect(sender).toBeInstanceOf(CtxHttpEmailSender);
		await sender?.send(loginInput);
		expect(calls).toEqual(["https://api.resend.com/emails"]);
		expect(captured(kv)).toHaveLength(0);
	});

	test("ORDER emails are never captured: the general sender stays fail-closed even when armed", async () => {
		vi.stubGlobal(DEFINE, true);
		expect(await makeEmailSender(makeCtx().ctx, {})).toBeUndefined();
	});

	test("the capture sender refuses any template but the login link, and writes nothing", async () => {
		vi.stubGlobal(DEFINE, true);
		const { ctx, kv } = makeCtx();
		const sender = await makeLoginEmailSender(ctx, {});
		await expect(
			sender?.send({ ...loginInput, template: "order-confirmation", data: { orderId: "o1" } }),
		).rejects.toThrow(/customer-login-link/);
		await expect(sender?.send({ ...loginInput, data: { loginUrl: 42 } })).rejects.toThrow(
			/loginUrl/,
		);
		expect(captured(kv)).toHaveLength(0);
	});

	test("the kv key is pinned: the e2e harness reads it by this exact name", () => {
		expect(DEV_LOGIN_CAPTURE_KEY_PREFIX).toBe("e2e:loginLink:");
		expect(devLoginCaptureKey("A@B.test")).toBe("e2e:loginLink:a@b.test");
	});
});
