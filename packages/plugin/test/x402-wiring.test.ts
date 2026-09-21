/**
 * INC-C5 — x402 settlement, in-process.
 *
 * WHAT FOLDS IN. The service's `wireX402Gateway` read four env vars and built an
 * `X402PaymentGateway` around the OFFLINE test facilitator. In-process the same
 * gateway is built around {@link createHttpFacilitator}, whose one egress goes
 * through `ctx.http.fetch` and whose host INC-C3 already put in `allowedHosts`
 * (`IN_PROCESS_EGRESS_URLS.facilitatorUrl`). Nothing about the gateway itself
 * changes — `refundable` is still `false`, the challenge is still the same
 * `x402_challenge` descriptor — which is the point: the fold-in is a transport
 * change, not a payment-semantics change.
 *
 * WHERE THE CONFIG COMES FROM, and why it is split across three homes:
 *  - the facilitator URL is a BUILD-TIME define (`__OTTA_X402_FACILITATOR_URL__`),
 *    because `allowedHosts` is resolved at module load and the gate and the
 *    caller must not be able to disagree about which host that is;
 *  - the facilitator credential is WRITE-ONLY kv
 *    (`settings:x402FacilitatorApiKey`), because it is a secret;
 *  - `payTo` and the accepted networks are READABLE kv, because they are ordinary
 *    non-secret configuration — exactly the split `payment-secrets.ts` already
 *    records for the service's non-secret companions.
 *
 * FAIL-CLOSED. No facilitator URL, or no `payTo`, means NO GATEWAY — `undefined`,
 * not a half-wired one. The domain refuses a checkout whose method has no
 * gateway, so an unconfigured deployment gets a loud refusal instead of a
 * silently unverified settlement. This mirrors the service's own throw-rather-
 * than-arm posture without needing the test-facilitator opt-in, because the
 * offline HMAC facilitator is no longer reachable from here at all.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { X402_FACILITATOR_API_KEY_KEY } from "../src/payment-secrets.js";
import {
	DEFAULT_X402_ACCEPTS,
	wireX402Gateway,
	X402_ACCEPTS_KEY,
	X402_PAYTO_KEY,
	x402GatewayFromCtx,
} from "../src/payments/x402-wiring.js";
import type { PluginContext } from "../src/types.js";

const FACILITATOR_URL = "https://facilitator.example.test/verify";

/** A real-SHAPED destination wallet. Not a placeholder like `0xshop`: INC-C5's wiring
 *  validates the address shape before it will arm a gateway (see
 *  `isPlausiblePayTo`), because this value is where the buyer's money goes. */
const PAY_TO = "0x00000000000000000000000000000000000000a1";

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
				return Promise.resolve(new Response(JSON.stringify({ valid: true }), { status: 200 }));
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

describe("wireX402Gateway — the pure half", () => {
	test("no facilitator URL ⇒ no gateway", () => {
		expect(
			wireX402Gateway({ fetch: () => Promise.reject(new Error("x")), payTo: PAY_TO }),
		).toBeUndefined();
	});

	test("no payTo ⇒ no gateway, because a challenge with no destination is unpayable", () => {
		expect(
			wireX402Gateway({
				fetch: () => Promise.reject(new Error("x")),
				facilitatorUrl: FACILITATOR_URL,
			}),
		).toBeUndefined();
	});

	/**
	 * INC-C5 review (A4): `payTo` lives in READABLE kv, which `types.ts` documents
	 * as last-writer-wins with no CAS and reserves for values the domain does not
	 * depend on. This one the domain very much depends on — it is the address the
	 * buyer's money goes to — so the tier comes with a shape gate: a value that
	 * cannot be a wallet address never reaches a challenge, and the deployment
	 * reads as unconfigured (no gateway, loud refusal) instead of quietly minting
	 * challenges payable to a typo. See the module doc for why kv and not a
	 * build-time define.
	 */
	test.each([
		["a placeholder word", "0xshop"],
		["the empty string", ""],
		["whitespace", "   "],
		["too few hex digits", "0x00000000000000000000000000000000000000a"],
		["too many hex digits", "0x00000000000000000000000000000000000000a11"],
		["non-hex characters", "0x00000000000000000000000000000000000000zz"],
		["no 0x prefix", "00000000000000000000000000000000000000a1"],
		["a URL", "https://example.com/pay"],
	])("a payTo that is not a wallet address ⇒ NO gateway (%s)", (_why, payTo) => {
		expect(
			wireX402Gateway({
				fetch: () => Promise.reject(new Error("x")),
				facilitatorUrl: FACILITATOR_URL,
				payTo,
			}),
		).toBeUndefined();
	});

	test("a CAIP-10 account id is accepted, and the challenge carries it verbatim", async () => {
		// The networks are CAIP-2, so an operator naming the account in the matching
		// CAIP-10 form is giving MORE information, not less. It is passed through
		// untouched — normalizing a payment destination would be a worse bug than
		// refusing one.
		const payTo = `eip155:8453:${PAY_TO}`;
		const gateway = wireX402Gateway({
			fetch: () => Promise.reject(new Error("x")),
			facilitatorUrl: FACILITATOR_URL,
			payTo,
		});
		const handle = await gateway?.createIntent({
			orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
			amount: cents(100),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_caip10"),
			lines: [],
		});
		expect((handle?.clientAction as { payTo?: string } | undefined)?.payTo).toBe(payTo);
	});

	test("a mixed-case (EIP-55 checksummed) address is accepted", () => {
		expect(
			wireX402Gateway({
				fetch: () => Promise.reject(new Error("x")),
				facilitatorUrl: FACILITATOR_URL,
				payTo: "0xAbC0000000000000000000000000000000000001",
			}),
		).toBeDefined();
	});

	test("configured ⇒ an x402 gateway that is still honestly non-refundable", () => {
		const gateway = wireX402Gateway({
			fetch: () => Promise.reject(new Error("x")),
			facilitatorUrl: FACILITATOR_URL,
			payTo: PAY_TO,
		});
		expect(gateway?.id).toBe("x402");
		// ADR-0008: on-chain settlement is irreversible and this adapter holds no
		// signing wallet. The fold-in must not quietly flip this.
		expect(gateway?.refundable).toBe(false);
	});

	test("the challenge carries the configured payTo and networks, price in minor units", async () => {
		const gateway = wireX402Gateway({
			fetch: () => Promise.reject(new Error("x")),
			facilitatorUrl: FACILITATOR_URL,
			payTo: PAY_TO,
			accepts: ["eip155:8453", "eip155:1"],
		});
		const handle = await gateway?.createIntent({
			orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
			amount: cents(2599),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_1"),
			lines: [],
		});
		expect(handle?.clientAction).toEqual({
			kind: "x402_challenge",
			accepts: ["eip155:8453", "eip155:1"],
			price: 2599,
			payTo: PAY_TO,
		});
	});
});

describe("x402GatewayFromCtx — the wiring the composition root uses", () => {
	test("settlement verification goes over ctx.http to the facilitator, not an offline HMAC", async () => {
		const { ctx, calls } = makeCtx({
			[X402_PAYTO_KEY]: PAY_TO,
			[X402_FACILITATOR_API_KEY_KEY]: "fk",
		});
		const gateway = await x402GatewayFromCtx(ctx, { facilitatorUrl: FACILITATOR_URL });
		const result = await gateway?.verifyConfirmation({
			kind: "page_gate",
			proof: {
				orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
				transaction: "0xdeadbeef",
				network: DEFAULT_X402_ACCEPTS[0] as string,
				payer: "0xbuyer",
				amount: cents(2599),
				currency: toCurrency("USD"),
				// Deliberately NOT an HMAC: the whole point is that the facilitator,
				// not a shared secret this process holds, decides validity.
				signature: "",
			},
		});
		expect(result?.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(FACILITATOR_URL);
		expect(((calls[0]?.init?.headers ?? {}) as Record<string, string>)["authorization"]).toBe(
			"Bearer fk",
		);
	});

	test("an unconfigured deployment gets NO gateway rather than an unverified one", async () => {
		const { ctx } = makeCtx();
		expect(await x402GatewayFromCtx(ctx, { facilitatorUrl: FACILITATOR_URL })).toBeUndefined();
		expect(
			await x402GatewayFromCtx(makeCtx({ [X402_PAYTO_KEY]: PAY_TO }).ctx, {
				facilitatorUrl: undefined,
			}),
		).toBeUndefined();
	});

	test("a kv rejection degrades to no gateway, never a thrown route", async () => {
		const { ctx } = makeCtx({ [X402_PAYTO_KEY]: PAY_TO }, new Set([X402_PAYTO_KEY]));
		expect(await x402GatewayFromCtx(ctx, { facilitatorUrl: FACILITATOR_URL })).toBeUndefined();
	});

	test("accepts falls back to the documented default when kv holds none", async () => {
		const { ctx } = makeCtx({ [X402_PAYTO_KEY]: PAY_TO });
		const gateway = await x402GatewayFromCtx(ctx, { facilitatorUrl: FACILITATOR_URL });
		const handle = await gateway?.createIntent({
			orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
			amount: cents(100),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_2"),
			lines: [],
		});
		expect((handle?.clientAction as { accepts?: string[] } | undefined)?.accepts).toEqual([
			...DEFAULT_X402_ACCEPTS,
		]);
	});

	test("a comma-separated accepts list is split and trimmed, matching X402_ACCEPTS", async () => {
		const { ctx } = makeCtx({
			[X402_PAYTO_KEY]: PAY_TO,
			[X402_ACCEPTS_KEY]: "eip155:8453, eip155:1",
		});
		const gateway = await x402GatewayFromCtx(ctx, { facilitatorUrl: FACILITATOR_URL });
		const handle = await gateway?.createIntent({
			orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
			amount: cents(100),
			currency: toCurrency("USD"),
			idempotencyKey: toIdempotencyKey("idem_3"),
			lines: [],
		});
		expect((handle?.clientAction as { accepts?: string[] } | undefined)?.accepts).toEqual([
			"eip155:8453",
			"eip155:1",
		]);
	});
});
