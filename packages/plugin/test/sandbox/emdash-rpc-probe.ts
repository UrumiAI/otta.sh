/**
 * The PLUGIN half of `emdash-sandbox-rpc.sandbox.test.ts`: a module loaded as
 * `sandbox-plugin.js` beside EmDash's own generated wrapper (`plugin.js`) in a
 * Worker Loader isolate, exactly as `@emdash-cms/cloudflare`'s sandbox runner
 * loads a plugin. Its `ctx` is the wrapper's, so `ctx.http.fetch(url, init)` is
 * the wrapper's `bridge.httpFetch(url, init)` — a Workers RPC call, whose
 * arguments are structured-cloned.
 *
 * Each route answers a plain report of what happened (never throws), so the
 * suite sees the outcome, not a wrapper error. Every secret here is a fake, and
 * the isolate's only way out is the suite's recording stub.
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	type IdempotencyKey,
	type OrderId,
} from "@otta-sh/domain";
import { StripePaymentGateway } from "@otta-sh/payments-stripe";
import { createX402Rail } from "@otta-sh/payments-x402";
import { isEmailTransportUnavailableError } from "@otta-sh/domain";
import { CtxEmailSender, isEmailNotConfiguredError } from "../../src/email/ctx-email-sender.js";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../../src/payment-secrets.js";
import { refreshStripeAccountCountry } from "../../src/payments/stripe-account-country.js";
import { stripeGatewayFromCtx } from "../../src/payments/stripe-wiring.js";
import type { KvAccess, PluginContext } from "../../src/types.js";

/** The hosts the probe plugin's manifest allows. */
export const PROBE_HOST = "probe.example.com";
export const STRIPE_HOST = "api.stripe.com";
export const X402_HOST = "x402.example.com";

const PROBE_URL = `https://${PROBE_HOST}/ping`;

/** Fakes: never a real credential. */
const FAKE_STRIPE_SECRET = "sk_test_sandbox_probe_fake";
const FAKE_WEBHOOK_SECRET = "whsec_sandboxprobe_fake";

/** `@otta-sh/payments-x402`'s `SPEC_PAYMENT_SIGNATURE_HEADER` and `SPEC_PAY_TO`
 *  (test/support/fixtures.ts — the x402 spec's own example, copied: that file is
 *  outside this package's root). Base Sepolia, 1¢. */
const SPEC_PAYMENT_SIGNATURE_HEADER =
	"eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJlbWl1bS1kYXRhIiwiZGVzY3JpcHRpb24iOiJBY2Nlc3MgdG8gcHJlbWl1bSBtYXJrZXQgZGF0YSIsIm1pbWVUeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LCJhY2NlcHRlZCI6eyJzY2hlbWUiOiJleGFjdCIsIm5ldHdvcmsiOiJlaXAxNTU6ODQ1MzIiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwicGF5VG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0RDIiwidmVyc2lvbiI6IjIifX0sInBheWxvYWQiOnsic2lnbmF0dXJlIjoiMHgyZDZhNzU4OGQ2YWNjYTUwNWNiZjBkOWE0YTIyN2UwYzUyYzZjMzQwMDhjOGU4OTg2YTEyODMyNTk3NjQxNzM2MDhhMmNlNjQ5NjY0MmUzNzdkNmRhOGRiYmY1ODM2ZTliZDE1MDkyZjllY2FiMDVkZWQzZDYyOTNhZjE0OGI1NzFjIiwiYXV0aG9yaXphdGlvbiI6eyJmcm9tIjoiMHg4NTdiMDY1MTlFOTFlM0E1NDUzODc5MWJEYmIwRTIyMzczZTM2YjY2IiwidG8iOiIweDIwOTY5M0JjNmFmYzBDNTMyOGJBMzZGYUYwM0M1MTRFRjMxMjI4N0MiLCJ2YWx1ZSI6IjEwMDAwIiwidmFsaWRBZnRlciI6IjE3NDA2NzIwODkiLCJ2YWxpZEJlZm9yZSI6IjE3NDA2NzIxNTQiLCJub25jZSI6IjB4ZjM3NDY2MTNjMmQ5MjBiNWZkYWJjMDg1NmYyYWViMmQ0Zjg4ZWU2MDM3YjhjYzVkMDRhNzFhNDQ2MmYxMzQ4MCJ9fX0=";
const SPEC_PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const BASE_SEPOLIA = "eip155:84532";

function describeError(err: unknown): string {
	if (typeof err === "object" && err !== null) {
		const { name, code, message } = err as { name?: unknown; code?: unknown; message?: unknown };
		return `threw ${String(name)}${code === undefined ? "" : ` ${String(code)}`}: ${String(message)}`;
	}
	return `threw ${String(err)}`;
}

/** An in-isolate kv holding the fake Stripe secrets: the wrapper's own kv
 *  bridges to the host's D1, which this suite does not run. */
function withStripeKv(ctx: PluginContext): PluginContext {
	const values = new Map<string, unknown>([
		[STRIPE_SECRET_KEY_KEY, FAKE_STRIPE_SECRET],
		[STRIPE_WEBHOOK_SECRET_KEY, FAKE_WEBHOOK_SECRET],
	]);
	const kv: KvAccess = {
		get: async <T>(key: string) => (values.get(key) ?? null) as T | null,
		set: async (key: string, value: unknown) => {
			values.set(key, value);
		},
		delete: async (key: string) => values.delete(key),
		list: async () => [],
	};
	return { ...ctx, kv };
}

type RouteContext = { input: unknown };

function trustedHostOf(input: unknown): boolean {
	return (input as { trustedHost?: unknown } | null)?.trustedHost === true;
}

const ORDER: OrderId = orderId("ord_sandbox_1");
const key = (value: string): IdempotencyKey => idempotencyKey(value);

export default {
	routes: {
		/** `ctx.http.fetch` straight: with or without an `AbortSignal` in `init` (`aborted`:
		 *  one that has already fired), or with a null-prototype `init`. */
		raw: {
			async handler({ input }: RouteContext, ctx: PluginContext): Promise<string> {
				const options = (input ?? {}) as {
					withSignal?: unknown;
					aborted?: unknown;
					nullPrototype?: unknown;
				};
				const controller = new AbortController();
				if (options.aborted === true) controller.abort();
				const init: RequestInit = {
					method: "GET",
					...(options.withSignal === true ? { signal: controller.signal } : {}),
				};
				try {
					const res = await ctx.http.fetch(
						PROBE_URL,
						options.nullPrototype === true
							? (Object.assign(Object.create(null), init) as RequestInit)
							: init,
					);
					return `status ${String(res.status)}: ${await res.text()}`;
				} catch (err) {
					return describeError(err);
				}
			},
		},
		/**
		 * A Stripe refund (pre-flight GET, then the refund POST) through the
		 * plugin's own wiring (`stripeGatewayFromCtx`). `trustedHost` (input)
		 * builds the gateway with the in-process opt-in instead — what a site that
		 * WRONGLY declared a sandboxed plugin trusted would get.
		 */
		stripeRefund: {
			async handler({ input }: RouteContext, ctx: PluginContext): Promise<string> {
				try {
					const gw = trustedHostOf(input)
						? new StripePaymentGateway({
								secretKey: FAKE_STRIPE_SECRET,
								webhookSecret: FAKE_WEBHOOK_SECRET,
								fetch: (url, init) => ctx.http.fetch(String(url), init),
								trustedHost: true,
							})
						: await stripeGatewayFromCtx(withStripeKv(ctx));
					if (gw === undefined) return "no gateway";
					const result = await gw.refund({
						orderId: ORDER,
						providerRef: "pi_sandbox_1",
						amount: cents(500),
						currency: currency("USD"),
						priorRefunded: cents(0),
						idempotencyKey: key("rf_sandbox_1"),
					});
					return JSON.stringify(result);
				} catch (err) {
					return describeError(err);
				}
			},
		},
		/**
		 * A refund whose CREATE the host answers after a short bound (300 ms): the
		 * verdict and how long it took. `lingerMs` (input) keeps the route running
		 * that much longer after the verdict, so the late answer reaches the
		 * isolate while the call that gave up on it is still in scope.
		 */
		slowRefund: {
			async handler({ input }: RouteContext, ctx: PluginContext): Promise<string> {
				const { lingerMs, key: refundKey } = (input ?? {}) as { lingerMs?: unknown; key?: unknown };
				const started = Date.now();
				try {
					const gw = await stripeGatewayFromCtx(withStripeKv(ctx), { refundCreateTimeoutMs: 300 });
					if (gw === undefined) return "no gateway";
					const result = await gw.refund({
						orderId: ORDER,
						providerRef: "pi_sandbox_1",
						amount: cents(500),
						currency: currency("USD"),
						priorRefunded: cents(0),
						idempotencyKey: key(typeof refundKey === "string" ? refundKey : "rf_slow_1"),
					});
					const ms = Date.now() - started;
					if (typeof lingerMs === "number") await new Promise((r) => setTimeout(r, lingerMs));
					return JSON.stringify({ result, ms });
				} catch (err) {
					return describeError(err);
				}
			},
		},
		/** A PaymentIntent create the host answers after the bound (300 ms). */
		slowIntent: {
			async handler(_route: RouteContext, ctx: PluginContext): Promise<string> {
				const started = Date.now();
				try {
					const gw = await stripeGatewayFromCtx(withStripeKv(ctx), { requestTimeoutMs: 300 });
					if (gw === undefined) return "no gateway";
					await gw.createIntent({
						orderId: ORDER,
						amount: cents(1000),
						currency: currency("USD"),
						idempotencyKey: key("pi_slow_1"),
						lines: [{ title: "Coffee", quantity: 1 }],
						customerRequired: false,
					});
					return JSON.stringify({ result: "created", ms: Date.now() - started });
				} catch (err) {
					const { name, retryable } = err as { name?: unknown; retryable?: unknown };
					return JSON.stringify({
						result: { name: String(name), retryable },
						ms: Date.now() - started,
					});
				}
			},
		},
		/** A PaymentIntent cancel through the plugin's wiring (the cron sweep's call). */
		stripeCancel: {
			async handler(_route: RouteContext, ctx: PluginContext): Promise<string> {
				try {
					const gw = await stripeGatewayFromCtx(withStripeKv(ctx));
					if (gw === undefined) return "no gateway";
					return JSON.stringify(
						await gw.cancelIntent({
							orderId: ORDER,
							intentId: "pi_sandbox_1",
							idempotencyKey: key("cx_sandbox_1"),
						}),
					);
				} catch (err) {
					return describeError(err);
				}
			},
		},
		/** The account-country read (Settings save of the secret key). */
		stripeAccount: {
			async handler(_route: RouteContext, ctx: PluginContext): Promise<string> {
				try {
					return JSON.stringify(
						await refreshStripeAccountCountry(withStripeKv(ctx), {
							now: Date.parse("2026-10-07T00:00:00.000Z"),
						}),
					);
				} catch (err) {
					return describeError(err);
				}
			},
		},
		/** An x402 `/verify` through the rail, with `ctx.http.fetch` as its only egress. */
		x402Verify: {
			async handler(_route: RouteContext, ctx: PluginContext): Promise<string> {
				try {
					const rail = createX402Rail({
						facilitatorUrl: `https://${X402_HOST}/x402`,
						payTo: SPEC_PAY_TO,
						networks: [BASE_SEPOLIA],
						fetch: ctx.http.fetch,
					});
					const offered = rail.offer(
						{ amount: cents(1), currency: currency("USD") },
						"https://shop.example/x402/products/ebook",
					);
					if (!offered.ok) return `not offered: ${offered.detail}`;
					const decoded = rail.decode(SPEC_PAYMENT_SIGNATURE_HEADER);
					if (!decoded.ok) return `malformed: ${decoded.detail}`;
					return JSON.stringify(await rail.verify(decoded.payment, offered.offer));
				} catch (err) {
					return describeError(err);
				}
			},
		},
		/** The order email through `ctx.email` — the wrapper's `bridge.emailSend`,
		 *  an RPC to the host (ADR-0031). Answers "sent", "unavailable" (the host's
		 *  "no provider", as the adapter classifies it) or the error. */
		email: {
			async handler(_route: RouteContext, ctx: PluginContext): Promise<string> {
				if (ctx.email === undefined) return "no ctx.email";
				const sender = new CtxEmailSender({ email: ctx.email, requestTimeoutMs: 5_000 });
				try {
					await sender.send({
						to: "buyer@example.test" as never,
						template: "order-confirmation",
						data: { orderId: "ord_1", totalCents: 2599, currency: "USD" },
						idempotencyKey: "outbox_row_1",
					});
					return "sent";
				} catch (err) {
					return isEmailTransportUnavailableError(err) ? "unavailable" : describeError(err);
				}
			},
		},
		/** The host's raw "no provider" answer, as it reaches the plugin over the RPC:
		 *  its name, its message, and whether the adapter recognises it. */
		rawEmail: {
			async handler(_route: RouteContext, ctx: PluginContext): Promise<string> {
				if (ctx.email === undefined) return "no ctx.email";
				try {
					await ctx.email.send({ to: "buyer@example.test", subject: "s", text: "t" });
					return "sent";
				} catch (err) {
					const { name, message } = err as { name?: unknown; message?: unknown };
					return JSON.stringify({
						name,
						message,
						recognised: isEmailNotConfiguredError(err),
					});
				}
			},
		},
	},
};
