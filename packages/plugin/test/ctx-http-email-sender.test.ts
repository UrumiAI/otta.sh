/**
 * INC-C5 — the in-process `EmailSender`.
 *
 * WHAT MOVED AND WHAT DID NOT. The port (`EmailSender`) is unchanged, the
 * rendering is unchanged (it moved verbatim from `service/src/email/render.ts`
 * to `@otta-sh/domain`, whose suite still pins every template), and the
 * `Idempotency-Key` and bearer are unchanged. The transport changed:
 * `globalThis.fetch` inside a Node service becomes `ctx.http.fetch` inside the
 * sandboxed plugin, gated by `allowedHosts`.
 *
 * THE BODY IS RESEND'S, EXACTLY (2026-10-02). The service-era body carried the
 * template name as a top-level `template` STRING. Resend — the provider
 * DEPLOYMENT.md documents — defines `template` as an OBJECT (`{ id, variables }`,
 * a hosted template) that cannot be combined with `html`/`text`, so every send
 * would have been refused. The name now rides as a Resend tag instead, and the
 * first case below pins the whole body so a stray key cannot creep back in.
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
import { renderEmail, type EmailTemplate } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import {
	CtxHttpEmailSender,
	DEFAULT_EMAIL_TIMEOUT_MS,
	EMAIL_FROM_KEY,
	LOGIN_EMAIL_TIMEOUT_MS,
	makeEmailSender,
	makeLoginEmailSender,
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
		/** The provider's response body; `"{}"` when omitted. */
		responseBody?: string;
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
				return Promise.resolve(
					new Response(options.responseBody ?? "{}", { status: options.status ?? 202 }),
				);
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
			// The template name as a Resend tag — NOT a top-level `template`, which
			// Resend reads as a hosted-template object and refuses beside `html`.
			tags: [{ name: "template", value: input.template }],
		});
		expect(Object.hasOwn(body, "template")).toBe(false);
	});

	test("every template name is a legal Resend tag value (ASCII letters, digits, _ and -)", () => {
		// Exhaustive by construction: `satisfies Record<EmailTemplate, true>` fails
		// the typecheck the day a template is added without being listed here, so a
		// new name cannot ship untested against the provider's tag charset (a tag
		// value outside it is a 422 on EVERY send of that template).
		const names = Object.keys({
			"customer-login-link": true,
			"order-confirmation": true,
			"order-processing": true,
			"order-shipped": true,
			"order-delivered": true,
			"order-completed": true,
			"order-cancelled": true,
			"order-refunded": true,
			"order-expired": true,
		} satisfies Record<EmailTemplate, true>);
		for (const name of names) {
			expect(name).toMatch(/^[A-Za-z0-9_-]{1,256}$/u);
		}
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

	/**
	 * DIAGNOSABLE FAILURES. A bare "status 403" says nothing about WHY — and the
	 * reasons a real provider refuses are operator-fixable and specific (an
	 * unverified sending domain, a bad key, a sandbox account sending to a
	 * stranger). Resend answers `{ statusCode, name, message }`; the error carries
	 * the name and message, bounded, and nothing of the REQUEST — the login
	 * route logs this message, and the request body holds the sign-in link.
	 */
	describe("a refused send says why, and only why", () => {
		function senderFor(ctx: PluginContext): CtxHttpEmailSender {
			return new CtxHttpEmailSender({
				fetch: ctx.http.fetch,
				apiUrl: API_URL,
				from: "shop@example.test",
				apiKey: "re_secret_key",
			});
		}

		async function failure(status: number, responseBody: string): Promise<string> {
			const { ctx } = makeCtx({ status, responseBody });
			const err = await senderFor(ctx)
				.send(input)
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			if (!(err instanceof Error)) throw new Error("expected the send to throw an Error");
			return err.message;
		}

		test("includes the provider's error name and message from a JSON body", async () => {
			const message = await failure(
				403,
				JSON.stringify({
					statusCode: 403,
					name: "validation_error",
					message: "The shop.example domain is not verified.",
				}),
			);
			expect(message).toContain("403");
			expect(message).toContain("validation_error");
			expect(message).toContain("The shop.example domain is not verified.");
		});

		test("bounds the provider's message, so a verbose body cannot flood the log", async () => {
			const message = await failure(
				422,
				// Under the 4 KiB read bound, so it IS parsed — and then truncated.
				JSON.stringify({ name: "validation_error", message: "x".repeat(3_000) }),
			);
			expect(message).toContain("validation_error");
			expect(message.length).toBeLessThan(300);
		});

		test("never echoes the request: no key, no recipient, no rendered body", async () => {
			const message = await failure(
				403,
				JSON.stringify({
					name: "validation_error",
					message: `You can only send testing emails to your own address, not ${String(input.to)}.`,
				}),
			);
			expect(message).not.toContain("re_secret_key");
			// A provider that quotes the recipient back has it redacted here.
			expect(message).not.toContain(String(input.to));
			expect(message).not.toContain(renderEmail(input.template, input.data).subject);
		});

		test("redacts the recipient case-insensitively", async () => {
			const message = await failure(
				422,
				JSON.stringify({
					name: "validation_error",
					message: `Invalid \`to\` field: ${String(input.to).toUpperCase()}.`,
				}),
			);
			expect(message.toLowerCase()).not.toContain(String(input.to).toLowerCase());
			expect(message).toContain("<recipient>");
		});

		test("control characters become spaces, so a provider message cannot forge a log line", async () => {
			const message = await failure(
				400,
				JSON.stringify({
					name: "validation_error",
					message: "bad request\r\n[otta] login email sent OK\u0000\u007f\u0085\u2028\u2029",
				}),
			);
			// oxlint-disable-next-line no-control-regex -- asserting their absence IS the point
			expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
			expect(message).toContain("bad request");
		});

		test("reads at most 4 KiB of the body: a larger one contributes nothing", async () => {
			// Bounded BEFORE JSON.parse, so a provider (or an intermediary) answering
			// with megabytes cannot make the error path parse megabytes.
			const huge = JSON.stringify({
				name: "validation_error",
				message: "ok",
				padding: "x".repeat(10_000),
			});
			expect(await failure(500, huge)).toBe("email transport failed with status 500");
		});

		test("a refused LOGIN send never carries the token, even with Resend's testing-mode refusal", async () => {
			// Resend's real wording for an account with no verified domain. It quotes
			// the account OWNER's address — that one is not redacted (it is not the
			// recipient), so it CAN appear in the login route's log line.
			const token = "tok_live_9f8e7d6c5b4a";
			const { ctx } = makeCtx({
				status: 403,
				responseBody: JSON.stringify({
					statusCode: 403,
					name: "validation_error",
					message:
						"You can only send testing emails to your own email address (owner@shop.otta.sh). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.",
				}),
			});
			const err = await senderFor(ctx)
				.send({
					...input,
					template: "customer-login-link",
					data: {
						loginUrl: `https://shop.otta.sh/account/verify?challenge=ch_1&token=${token}`,
					},
					idempotencyKey: "login:ch_1",
				})
				.then(
					() => undefined,
					(e: unknown) => e,
				);
			if (!(err instanceof Error)) throw new Error("expected the send to throw an Error");
			expect(err.message).toContain("403");
			expect(err.message).toContain("validation_error");
			expect(err.message).not.toContain(token);
			expect(err.message).not.toContain("account/verify");
			expect(err.message).toContain("owner@shop.otta.sh");
		});

		test("a non-JSON body still throws with the status, and quotes none of it", async () => {
			const message = await failure(502, "<html><body>Bad gateway at edge-17</body></html>");
			expect(message).toContain("502");
			expect(message).not.toContain("<html>");
			expect(message).not.toContain("edge-17");
		});

		test("JSON without a usable name/message falls back to the bare status", async () => {
			expect(await failure(500, JSON.stringify({ error: { nested: true } }))).toBe(
				"email transport failed with status 500",
			);
			expect(await failure(500, "")).toBe("email transport failed with status 500");
		});
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

	test("a HUNG email provider is aborted, so one bad row cannot starve the sweep", async () => {
		// `dispatchOrderEmails` wraps each row in try/catch, which catches a THROWN
		// send — not an unbounded await. Without a ceiling here a hung provider
		// holds the cron tick open and every sweep leg after `order-emails` never
		// runs. Aborting turns the hang into the throw the dispatcher already
		// handles, which also leaves the row NOT marked sent.
		const seen: Array<AbortSignal | undefined> = [];
		const sender = new CtxHttpEmailSender({
			fetch: (_url: string, init?: RequestInit) => {
				const signal = init?.signal ?? undefined;
				seen.push(signal ?? undefined);
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				});
			},
			apiUrl: API_URL,
			from: "orders@shop.test",
			requestTimeoutMs: 20,
		});
		await expect(sender.send(input)).rejects.toThrow();
		expect(seen[0]).toBeInstanceOf(AbortSignal);
	});
});

/**
 * The LOGIN send (issue #306 review). It is awaited inline on the login-request
 * route, and a throttled request skips it entirely — so a slow provider would
 * make a sent request seconds slower than a throttled one, and the latency
 * would say which it was. The login sender therefore carries a SHORT ceiling,
 * not the 30 s the cron-driven order emails can afford.
 */
describe("makeLoginEmailSender — the short ceiling on the inline login send", () => {
	function hangingCtx(): PluginContext {
		const { ctx } = makeCtx();
		return {
			...ctx,
			http: {
				fetch: (_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			},
		};
	}

	test("is well under the order-email ceiling", () => {
		expect(LOGIN_EMAIL_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
		expect(LOGIN_EMAIL_TIMEOUT_MS).toBeLessThan(DEFAULT_EMAIL_TIMEOUT_MS);
	});

	test("a hung provider is abandoned after LOGIN_EMAIL_TIMEOUT_MS, not the 30 s default", async () => {
		const sender = await makeLoginEmailSender(hangingCtx(), { apiUrl: API_URL });
		if (sender === undefined) throw new Error("no sender built");
		const started = Date.now();
		await expect(
			sender.send({ ...input, template: "customer-login-link", data: { loginUrl: "x" } }),
		).rejects.toThrow();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(LOGIN_EMAIL_TIMEOUT_MS - 50);
		expect(elapsed).toBeLessThan(LOGIN_EMAIL_TIMEOUT_MS + 5_000);
	}, 20_000);

	test("still fails closed with no email API URL", async () => {
		expect(await makeLoginEmailSender(hangingCtx(), {})).toBeUndefined();
	});
});
