/**
 * Issue #447 (from #409): `trustedHost` reaches every Stripe call the plugin
 * makes. `@urumi-ai/otta-payments-stripe` puts an `AbortSignal` in `init` only when
 * told the host is in-process (`trustedHost: true`), so a timed-out request's
 * socket is released; under EmDash's sandbox runner a signal must never be
 * sent. The plugin cannot tell the two apart at runtime (staging's trusted mode
 * is workerd too), so a site says so in its own entry module:
 * `export default createOttaPlugin({ trustedHost: true })`. Each case
 * re-imports the plugin so the slot starts unset.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@urumi-ai/otta-domain";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import type { PluginContext } from "../src/types.js";

const SECRET_KEY = ["sk_test_", "trustedHostFixture"].join("");
const WEBHOOK_SECRET = "whsec_trustedHostFixture";

/** A `ctx.http` that never answers on its own — like a hung Stripe. It
 *  rejects when its signal aborts, as a real `fetch` does. */
function hangingCtx(): { ctx: PluginContext; inits: Array<RequestInit | undefined> } {
	const kv = new Map<string, unknown>([
		[STRIPE_SECRET_KEY_KEY, SECRET_KEY],
		[STRIPE_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET],
	]);
	const inits: Array<RequestInit | undefined> = [];
	const ctx: PluginContext = {
		http: {
			fetch: (_url: string, init?: RequestInit) => {
				inits.push(init);
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				});
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
	return { ctx, inits };
}

async function load() {
	const { createOttaPlugin } = await import("../src/plugin.js");
	const { stripeGatewayFromCtx } = await import("../src/payments/stripe-wiring.js");
	const { refreshStripeAccountCountry } = await import("../src/payments/stripe-account-country.js");
	return { createOttaPlugin, stripeGatewayFromCtx, refreshStripeAccountCountry };
}

async function createIntentTimingOut(
	stripeGatewayFromCtx: Awaited<ReturnType<typeof load>>["stripeGatewayFromCtx"],
	ctx: PluginContext,
): Promise<void> {
	const gateway = await stripeGatewayFromCtx(ctx, { requestTimeoutMs: 20 });
	if (gateway === undefined) throw new Error("expected a live gateway");
	await gateway
		.createIntent({
			orderId: toOrderId("44444444-4444-4444-8444-444444444444"),
			amount: cents(1000),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_trusted"),
			lines: [],
		})
		.catch(() => undefined);
}

beforeEach(() => {
	vi.resetModules();
});

describe("createOttaPlugin({ trustedHost }) — issue #447", () => {
	test("default (no option): the gateway's call carries NO signal — sandbox-safe", async () => {
		const { createOttaPlugin, stripeGatewayFromCtx } = await load();
		createOttaPlugin();
		const { ctx, inits } = hangingCtx();
		await createIntentTimingOut(stripeGatewayFromCtx, ctx);
		expect(inits).toHaveLength(1);
		expect(inits[0]?.signal).toBeUndefined();
	});

	test("trustedHost: the gateway's timed-out request is ABORTED at the transport", async () => {
		const { createOttaPlugin, stripeGatewayFromCtx } = await load();
		createOttaPlugin({ trustedHost: true });
		const { ctx, inits } = hangingCtx();
		await createIntentTimingOut(stripeGatewayFromCtx, ctx);
		expect(inits).toHaveLength(1);
		const signal = inits[0]?.signal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal?.aborted).toBe(true);
	});

	test("default: the account-country read carries NO signal", async () => {
		const { createOttaPlugin, refreshStripeAccountCountry } = await load();
		createOttaPlugin();
		const { ctx, inits } = hangingCtx();
		const status = await refreshStripeAccountCountry(ctx, { timeoutMs: 20 });
		expect(status.status).toBe("unavailable");
		expect(inits[0]?.signal).toBeUndefined();
	});

	test("trustedHost: the account-country read's timed-out request is ABORTED", async () => {
		const { createOttaPlugin, refreshStripeAccountCountry } = await load();
		createOttaPlugin({ trustedHost: true });
		const { ctx, inits } = hangingCtx();
		const status = await refreshStripeAccountCountry(ctx, { timeoutMs: 20 });
		expect(status.status).toBe("unavailable");
		expect(inits[0]?.signal?.aborted).toBe(true);
	});

	test("only the literal `true` opts in", async () => {
		const { createOttaPlugin, stripeGatewayFromCtx } = await load();
		createOttaPlugin({ trustedHost: "yes" as unknown as boolean });
		const { ctx, inits } = hangingCtx();
		await createIntentTimingOut(stripeGatewayFromCtx, ctx);
		expect(inits[0]?.signal).toBeUndefined();
	});
});
