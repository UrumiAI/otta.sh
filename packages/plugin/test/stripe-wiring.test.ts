/**
 * Stripe payment gateway, in-process — the missing half of INC-C5's pattern.
 *
 * See `src/payments/stripe-wiring.ts`'s module doc for why BOTH
 * `settings:stripeSecretKey` and `settings:stripeWebhookSecret` are required
 * before a gateway is wired at all, mirroring `x402-wiring.test.ts`'s
 * fail-closed shape.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@otta-sh/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { STRIPE_SECRET_KEY_KEY, STRIPE_WEBHOOK_SECRET_KEY } from "../src/payment-secrets.js";
import { devStripeOfflineEnabled, stripeGatewayFromCtx } from "../src/payments/stripe-wiring.js";
import type { PluginContext } from "../src/types.js";

const SECRET_KEY = "sk_test_abc1234567890";
const WEBHOOK_SECRET = "whsec_abc1234567890";

function makeCtx(
	seed: Record<string, unknown> = {},
	failingKeys: ReadonlySet<string> = new Set(),
): { ctx: PluginContext; calls: Array<{ url: string; init: RequestInit | undefined }> } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	const ctx: PluginContext = {
		http: {
			fetch: (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return Promise.resolve(
					new Response(JSON.stringify({ id: "pi_test", client_secret: "pi_test_secret" }), {
						status: 200,
					}),
				);
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (failingKeys.has(k)) throw new Error(`kv unavailable: ${k}`);
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

describe("stripeGatewayFromCtx", () => {
	test("neither secret configured ⇒ no gateway", async () => {
		const { ctx } = makeCtx();
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("only the secret key ⇒ no gateway (a live intent nothing could ever verify)", async () => {
		const { ctx } = makeCtx({ [STRIPE_SECRET_KEY_KEY]: SECRET_KEY });
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("only the webhook secret ⇒ no gateway (verification with nothing that can create)", async () => {
		const { ctx } = makeCtx({ [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET });
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("both configured ⇒ a refundable stripe gateway", async () => {
		const { ctx } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SECRET_KEY,
			[STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET,
		});
		const gateway = await stripeGatewayFromCtx(ctx);
		expect(gateway?.id).toBe("stripe");
		expect(gateway?.refundable).toBe(true);
	});

	test("a kv rejection on either key degrades to no gateway, never a thrown route", async () => {
		const { ctx } = makeCtx(
			{ [STRIPE_SECRET_KEY_KEY]: SECRET_KEY, [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET },
			new Set([STRIPE_SECRET_KEY_KEY]),
		);
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("createIntent's live call goes over ctx.http, not the global fetch", async () => {
		const { ctx, calls } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SECRET_KEY,
			[STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET,
		});
		const gateway = await stripeGatewayFromCtx(ctx);
		const handle = await gateway?.createIntent({
			orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
			amount: cents(2599),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_1"),
			lines: [],
		});
		expect(handle?.clientAction).toEqual({
			kind: "stripe_client_secret",
			clientSecret: "pi_test_secret",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("api.stripe.com");
		expect(
			((calls[0]?.init?.headers ?? {}) as Record<string, string>)["authorization"] ??
				((calls[0]?.init?.headers ?? {}) as Record<string, string>)["Authorization"],
		).toContain(SECRET_KEY);
	});
});

/**
 * The DEV-ONLY offline gateway (issue #378). A local or CI e2e stack has no
 * Stripe account, and the arm above refuses to create an order without one, so
 * the e2e order seed could never produce a paid order. The offline arm wires the
 * adapter's existing deterministic, no-network `createIntent` — but ONLY when the
 * site baked the dev define AND the bundle is a Vite dev build. Every other
 * combination must keep the fail-closed answer the cases above pin.
 */
describe("stripeGatewayFromCtx — the dev-only offline arm (issue #378)", () => {
	const DEFINE = "__OTTA_DEV_STRIPE_OFFLINE__";

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	test("off by default: the define is not set in an ordinary build", async () => {
		expect(devStripeOfflineEnabled()).toBe(false);
		const { ctx } = makeCtx({ [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET });
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("define + dev build + webhook secret only ⇒ an OFFLINE gateway that never touches the network", async () => {
		vi.stubGlobal(DEFINE, true);
		expect(devStripeOfflineEnabled()).toBe(true);
		const { ctx, calls } = makeCtx({ [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET });
		const gateway = await stripeGatewayFromCtx(ctx);
		expect(gateway?.id).toBe("stripe");
		// No secret key ⇒ no refund credential: the console records a manual refund
		// rather than pretending to move money.
		expect(gateway?.refundable).toBe(false);
		const orderId = toOrderId("22222222-2222-4222-8222-222222222222");
		const handle = await gateway?.createIntent({
			orderId,
			amount: cents(1800),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_offline"),
			lines: [],
		});
		expect(handle?.intentId).toBe(`pi_${orderId}`);
		expect(calls).toHaveLength(0);
	});

	test("a PRODUCTION build ignores the define: import.meta.env.DEV false ⇒ no gateway", async () => {
		vi.stubGlobal(DEFINE, true);
		vi.stubEnv("DEV", false);
		expect(devStripeOfflineEnabled()).toBe(false);
		const { ctx } = makeCtx({ [STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET });
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("only the literal `true` arms it — a truthy non-boolean define does not", async () => {
		vi.stubGlobal(DEFINE, "true");
		expect(devStripeOfflineEnabled()).toBe(false);
		vi.stubGlobal(DEFINE, 1);
		expect(devStripeOfflineEnabled()).toBe(false);
	});

	test("still needs the webhook secret: offline with nothing to verify a settlement is no gateway", async () => {
		vi.stubGlobal(DEFINE, true);
		const { ctx } = makeCtx();
		expect(await stripeGatewayFromCtx(ctx)).toBeUndefined();
	});

	test("a configured secret key always wins: the live gateway, never the offline one", async () => {
		vi.stubGlobal(DEFINE, true);
		const { ctx, calls } = makeCtx({
			[STRIPE_SECRET_KEY_KEY]: SECRET_KEY,
			[STRIPE_WEBHOOK_SECRET_KEY]: WEBHOOK_SECRET,
		});
		const gateway = await stripeGatewayFromCtx(ctx);
		expect(gateway?.refundable).toBe(true);
		await gateway?.createIntent({
			orderId: toOrderId("33333333-3333-4333-8333-333333333333"),
			amount: cents(600),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_live"),
			lines: [],
		});
		expect(calls).toHaveLength(1);
	});
});
