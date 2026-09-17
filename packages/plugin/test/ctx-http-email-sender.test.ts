/**
 * INC-C5 — the in-process `EmailSender`.
 *
 * WHAT MOVED AND WHAT DID NOT. The port (`EmailSender`) is unchanged, the
 * rendering is unchanged (it moved verbatim from `service/src/email/render.ts`
 * to `@otta-sh/domain`, whose suite still pins every template), and the wire
 * shape is unchanged — same JSON body, same `Idempotency-Key`, same bearer.
 * The ONE thing that changed is the transport: `globalThis.fetch` inside a Node
 * service becomes `ctx.http.fetch` inside the sandboxed plugin, gated by
 * `allowedHosts`. Everything below exists to pin that the swap really was only
 * the transport.
 *
 * REJECTED, and the plan says so explicitly (§D5): EmDash's native `ctx.email`.
 * It needs an `email:send` capability grant and a host-configured provider we do
 * not have, and it would delete the `EmailSender` port rather than re-adapt it.
 *
 * IDEMPOTENCY IS THE LOAD-BEARING HEADER. `SendEmailInput.idempotencyKey` IS the
 * outbox row id; the outbox gives at-least-once delivery, so effectively-once is
 * whatever the provider's own dedupe makes of that header. Dropping it in the
 * port-to-`ctx.http` swap would turn every retried sweep tick into a duplicate
 * customer email — silently, since the outbox would still look correctly drained.
 */
import { renderEmail } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	CtxHttpEmailSender,
	EMAIL_FROM_KEY,
	makeEmailSender,
} from "../src/email/ctx-http-email-sender.js";
import { EMAIL_API_KEY_KEY } from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

/** A fake ctx whose `http.fetch` records what the adapter asked for. `status`
 *  drives the failure case; `throws` drives a transport-level rejection. */
function makeCtx(
	options: {
		seed?: Record<string, unknown>;
		status?: number;
		failingKeys?: ReadonlySet<string>;
	} = {},
): { ctx: PluginContext; calls: Call[] } {
	const kv = new Map<string, unknown>(Object.entries(options.seed ?? {}));
	const failing = options.failingKeys ?? new Set<string>();
	const calls: Call[] = [];
	const ctx: PluginContext = {
		http: {
			fetch: (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return Promise.resolve(new Response("{}", { status: options.status ?? 202 }));
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (failing.has(k)) throw new Error(`kv unavailable: ${k}`);
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

const input = {
	to: "buyer@example.test" as never,
	template: "order-confirmation" as const,
	data: { orderId: "ord_1", totalCents: 2599, currency: "USD" },
	idempotencyKey: "outbox_row_1",
};

describe("CtxHttpEmailSender — the transport, and only the transport", () => {
	test("posts the rendered mail through ctx.http.fetch, never a bare fetch", async () => {
		const { ctx, calls } = makeCtx();
		const sender = new CtxHttpEmailSender({
			fetch: ctx.http.fetch,
			apiUrl: API_URL,
			from: "shop@example.test",
		});
		await sender.send(input);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url).toBe(API_URL);
		expect(call?.init?.method).toBe("POST");
		const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
		const rendered = renderEmail(input.template, input.data);
		expect(body).toEqual({
			from: "shop@example.test",
			to: input.to,
			subject: rendered.subject,
			text: rendered.text,
			html: rendered.html,
			template: input.template,
		});
	});

	test("forwards the outbox row id as Idempotency-Key — the provider's dedupe hinge", async () => {
		const { ctx, calls } = makeCtx();
		await new CtxHttpEmailSender({
			fetch: ctx.http.fetch,
			apiUrl: API_URL,
			from: "shop@example.test",
		}).send(input);
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers["Idempotency-Key"]).toBe("outbox_row_1");
		expect(headers["content-type"]).toBe("application/json");
	});

	test("attaches the bearer only when one was provisioned", async () => {
		const withKey = makeCtx();
		await new CtxHttpEmailSender({
			fetch: withKey.ctx.http.fetch,
			apiUrl: API_URL,
			from: "shop@example.test",
			apiKey: "sk_mail",
		}).send(input);
		expect(
			((withKey.calls[0]?.init?.headers ?? {}) as Record<string, string>)["authorization"],
		).toBe("Bearer sk_mail");

		const without = makeCtx();
		await new CtxHttpEmailSender({
			fetch: without.ctx.http.fetch,
			apiUrl: API_URL,
			from: "shop@example.test",
		}).send(input);
		expect(Object.hasOwn((without.calls[0]?.init?.headers ?? {}) as object, "authorization")).toBe(
			false,
		);
	});

	test("a non-2xx provider response THROWS, so the outbox row is not marked sent", async () => {
		// The outbox's at-least-once contract depends on this: a swallowed 500
		// would drain the row and lose the email permanently.
		const { ctx } = makeCtx({ status: 500 });
		await expect(
			new CtxHttpEmailSender({
				fetch: ctx.http.fetch,
				apiUrl: API_URL,
				from: "shop@example.test",
			}).send(input),
		).rejects.toThrow(/500/u);
	});

	test("money in the rendered body is the integer minor units it was handed", async () => {
		const { ctx, calls } = makeCtx();
		await new CtxHttpEmailSender({
			fetch: ctx.http.fetch,
			apiUrl: API_URL,
			from: "shop@example.test",
		}).send(input);
		const body = JSON.parse(String(calls[0]?.init?.body)) as { text: string };
		// 2599 minor units renders as 25.99 — the ONLY place a decimal point is
		// allowed to appear, and it is produced by the domain's renderer, not by
		// any float arithmetic on this side of the port.
		expect(body.text).toContain("25.99");
	});
});

describe("makeEmailSender — the composition root's fail-closed wiring", () => {
	test("returns undefined when the bundle was built with no email API URL", async () => {
		const { ctx } = makeCtx();
		expect(await makeEmailSender(ctx, { apiUrl: undefined })).toBeUndefined();
	});

	test("reads the API key from write-only kv and the from-address from readable kv", async () => {
		const { ctx, calls } = makeCtx({
			seed: { [EMAIL_API_KEY_KEY]: "sk_mail", [EMAIL_FROM_KEY]: "orders@shop.test" },
		});
		const sender = await makeEmailSender(ctx, { apiUrl: API_URL });
		expect(sender).toBeDefined();
		await sender?.send(input);
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers["authorization"]).toBe("Bearer sk_mail");
		expect(JSON.parse(String(calls[0]?.init?.body))["from"]).toBe("orders@shop.test");
	});

	test("a kv rejection degrades to an unauthenticated send, never a thrown sweep", async () => {
		// Same fail-closed posture as `serviceTokenFromKv`: a kv outage must not
		// take down the cron tick that was about to drain the outbox.
		const { ctx, calls } = makeCtx({
			failingKeys: new Set([EMAIL_API_KEY_KEY, EMAIL_FROM_KEY]),
		});
		const sender = await makeEmailSender(ctx, { apiUrl: API_URL });
		await sender?.send(input);
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(Object.hasOwn(headers, "authorization")).toBe(false);
		// And the from-address falls back to the documented default rather than
		// posting `undefined`.
		expect(JSON.parse(String(calls[0]?.init?.body))["from"]).toBe("no-reply@otta.local");
	});
});
