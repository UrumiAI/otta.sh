import { afterEach, describe, expect, test, vi } from "vitest";
import {
	SPEC_NONCE,
	SPEC_PAY_TO,
	SPEC_PAYER,
	SPEC_PAYMENT_SIGNATURE_HEADER,
	SPEC_SIGNATURE,
	SPEC_VERIFY_INVALID,
	SPEC_VERIFY_VALID,
	USDC_BASE_SEPOLIA,
	X402_ORG_BAD_SIGNATURE,
	X402_ORG_MALFORMED,
	BASE_SEPOLIA,
} from "./support/fixtures.js";
import { FAKE_FACILITATOR_URL } from "./support/fake-facilitator.js";
import { decodeOrThrow, makeRail, offerOrThrow } from "./support/harness.js";

function setup(options: Parameters<typeof makeRail>[0] = {}) {
	const { rail, facilitator } = makeRail(options);
	const offer = offerOrThrow(rail);
	const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
	return { rail, facilitator, offer, payment, verify: () => rail.verify(payment, offer) };
}

afterEach(() => {
	vi.useRealTimers();
});

/**
 * ADR-0028 Decision 8, `/verify`, and Decision 12's "What gets sent" and
 * "Classification".
 */
describe("X402Rail.verify — what gets sent", () => {
	test("POSTs {x402Version, paymentPayload, paymentRequirements} to {base}/verify with OUR requirements, never the echoed accepted", async () => {
		const { facilitator, offer, verify } = setup();
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		await verify();

		expect(facilitator.calls).toEqual({ verify: 1, settle: 0, other: 0 });
		const [request] = facilitator.requests;
		expect(request?.url).toBe(`${FAKE_FACILITATOR_URL}/verify`);
		expect(request?.method).toBe("POST");
		expect(request?.headers["content-type"]).toBe("application/json");
		expect(request?.hadSignal).toBe(true);
		expect(request?.body).toEqual({
			x402Version: 2,
			paymentPayload: {
				x402Version: 2,
				// The payload's own `accepted` (60 s, no assetTransferMethod) travels
				// inside the payload, as the client signed it up…
				accepted: {
					scheme: "exact",
					network: BASE_SEPOLIA,
					amount: "10000",
					asset: USDC_BASE_SEPOLIA,
					payTo: SPEC_PAY_TO,
					maxTimeoutSeconds: 60,
					extra: { name: "USDC", version: "2" },
				},
				payload: {
					signature: SPEC_SIGNATURE,
					authorization: {
						from: SPEC_PAYER,
						to: SPEC_PAY_TO,
						value: "10000",
						validAfter: "1740672089",
						validBefore: "1740672154",
						nonce: SPEC_NONCE,
					},
				},
			},
			// …but the requirements are ours: 180 s and eip3009, from our offer.
			paymentRequirements: offer.paymentRequired.accepts[0],
		});
		expect(request?.body).toHaveProperty(
			"paymentRequirements",
			expect.objectContaining({
				maxTimeoutSeconds: 180,
				extra: expect.objectContaining({ assetTransferMethod: "eip3009" }),
			}),
		);
	});

	test("a trailing slash on the base URL does not double the path separator", async () => {
		const { facilitator, verify } = setup({ facilitatorUrl: `${FAKE_FACILITATOR_URL}/` });
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		expect(await verify()).toMatchObject({ outcome: "valid" });
		expect(facilitator.requests[0]?.url).toBe(`${FAKE_FACILITATOR_URL}/verify`);
	});

	test("asks fetch not to follow redirects (belt and braces: the url check below is the rule)", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		await verify();
		expect(facilitator.requests[0]?.redirect).toBe("manual");
	});
});

describe("X402Rail.verify — classification", () => {
	test("the spec's success body is valid; the payer is authorization.from", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		expect(await verify()).toEqual({ outcome: "valid", payer: SPEC_PAYER.toLowerCase() });
	});

	test("isValid true with no payer is valid", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 200, body: { isValid: true } });
		expect(await verify()).toEqual({ outcome: "valid", payer: SPEC_PAYER.toLowerCase() });
	});

	test.each([
		["the spec's error body on 200", 200, SPEC_VERIFY_INVALID, "insufficient_funds"],
		[
			"x402.org's bad-signature answer",
			X402_ORG_BAD_SIGNATURE.status,
			X402_ORG_BAD_SIGNATURE.body,
			"invalid_exact_evm_signature",
		],
		["a well-formed rejection on 400", 400, SPEC_VERIFY_INVALID, "insufficient_funds"],
		["a well-formed rejection on 402", 402, SPEC_VERIFY_INVALID, "insufficient_funds"],
		["a well-formed rejection on 422", 422, SPEC_VERIFY_INVALID, "insufficient_funds"],
	])("%s is a verdict: invalid", async (_label, status, body, reason) => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status, body });
		expect(await verify()).toEqual({ outcome: "invalid", reason });
	});

	test("an invalidReason that is not a plain token is not passed on", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({
			status: 200,
			body: { isValid: false, invalidReason: "bad sig for 0xabc <script>" },
		});
		expect(await verify()).toEqual({ outcome: "invalid", reason: undefined });
	});

	test("a rejection with no reason is still a verdict", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 200, body: { isValid: false } });
		expect(await verify()).toEqual({ outcome: "invalid", reason: undefined });
	});

	test.each([401, 403, 408, 429, 500, 502, 503, 504])(
		"%i is unavailable even with a well-formed rejection body",
		async (status) => {
			const { facilitator, verify } = setup();
			facilitator.onVerify({ status, body: SPEC_VERIFY_INVALID });
			expect(await verify()).toEqual({ outcome: "unavailable", cause: "status" });
		},
	);

	test("x402.org's 500 unexpected_error is unavailable, never a verdict", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify(X402_ORG_MALFORMED);
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "status" });
	});

	test("a 3xx that was not followed is unavailable", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({
			status: 307,
			body: SPEC_VERIFY_INVALID,
			headers: { location: "https://elsewhere.test/verify" },
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "status" });
	});

	test("a valid answer on a non-2xx status is unavailable", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 400, body: SPEC_VERIFY_VALID });
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "body" });
	});

	test("a non-2xx without a well-formed verdict is unavailable", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 400, body: { error: "bad request" } });
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "body" });
	});

	test.each([
		["a non-JSON 2xx", "OK"],
		["an empty 2xx", ""],
		["a JSON array", [true]],
		["isValid missing", { payer: SPEC_PAYER }],
		["the truthy string 'true'", { isValid: "true" }],
		["the truthy number 1", { isValid: 1 }],
		["the string 'false'", { isValid: "false" }],
		["invalidReason that is not a string", { isValid: false, invalidReason: 42 }],
		["payer that is not a string", { isValid: true, payer: 7 }],
		[
			"a payer other than authorization.from",
			{ isValid: true, payer: "0x1111111111111111111111111111111111111111" },
		],
	])("%s is unavailable (a truthy-but-not-true answer is refused)", async (_label, body) => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ status: 200, body });
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "body" });
	});

	test("the payer compares as 20 bytes: an upper-case echo of from is valid", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({
			status: 200,
			body: { isValid: true, payer: `0x${SPEC_PAYER.slice(2).toUpperCase()}` },
		});
		expect(await verify()).toMatchObject({ outcome: "valid" });
	});

	test("a redirected response (final url changed) is unavailable, even with a valid body", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({
			status: 200,
			body: SPEC_VERIFY_VALID,
			url: "https://elsewhere.test/verify",
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "redirect" });
	});

	test("an oversize body (over 16 KiB) is unavailable", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({
			status: 200,
			body: JSON.stringify({ isValid: false, pad: "x".repeat(16 * 1024) }),
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "oversize" });
	});

	test("an oversize Content-Length is unavailable without reading the body", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({
			status: 200,
			body: SPEC_VERIFY_VALID,
			headers: { "content-length": String(16 * 1024 + 1) },
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "oversize" });
	});

	test("a transport error is unavailable", async () => {
		const { facilitator, verify } = setup();
		facilitator.onVerify({ throws: new TypeError("fetch failed") });
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "transport" });
	});

	test("a fetch that throws synchronously is unavailable, not an exception", async () => {
		const { rail, offer, payment } = (() => {
			const built = makeRail({
				fetch: () => {
					throw new Error("blocked by allowedHosts");
				},
			});
			return {
				rail: built.rail,
				offer: offerOrThrow(built.rail),
				payment: decodeOrThrow(built.rail, SPEC_PAYMENT_SIGNATURE_HEADER),
			};
		})();
		expect(await rail.verify(payment, offer)).toEqual({
			outcome: "unavailable",
			cause: "transport",
		});
	});

	describe("the 10 s timeout", () => {
		test.each([
			["a facilitator that never answers", { hang: true } as const],
			["a fetch that ignores the abort signal", { hangIgnoringSignal: true } as const],
		])("%s is unavailable at 10 s, and not before", async (_label, script) => {
			vi.useFakeTimers();
			const { facilitator, verify } = setup();
			facilitator.onVerify(script);
			let settled: unknown;
			void verify().then((r) => (settled = r));
			await vi.advanceTimersByTimeAsync(9_999);
			expect(settled).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toEqual({ outcome: "unavailable", cause: "timeout" });
		});

		test("a body that never finishes is cut off by the same timeout", async () => {
			vi.useFakeTimers();
			const { facilitator, verify } = setup();
			facilitator.onVerify({ status: 200, body: '{"isValid":', bodyNeverEnds: true });
			let settled: unknown;
			void verify().then((r) => (settled = r));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(settled).toEqual({ outcome: "unavailable", cause: "timeout" });
		});
	});
});
