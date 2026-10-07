import { afterEach, describe, expect, test, vi } from "vitest";
import {
	BASE,
	BASE_SEPOLIA,
	PRE_BROADCAST_ALLOWLIST,
	REFERENCE_SETTLE_CATCH,
	REFERENCE_SETTLE_REVERTED,
	SPEC_PAYER,
	SPEC_PAYMENT_SIGNATURE_HEADER,
	SPEC_SETTLE_ERROR,
	SPEC_SETTLE_SUCCESS,
	SPEC_TRANSACTION,
} from "./support/fixtures.js";
import { FAKE_FACILITATOR_URL } from "./support/fake-facilitator.js";
import { decodeOrThrow, makeRail, offerOrThrow } from "./support/harness.js";

function setup() {
	const { rail, facilitator } = makeRail();
	const offer = offerOrThrow(rail);
	const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
	return { facilitator, offer, settle: () => rail.settle(payment, offer) };
}

afterEach(() => {
	vi.useRealTimers();
});

const SETTLED = {
	outcome: "settled",
	transaction: SPEC_TRANSACTION,
	network: BASE_SEPOLIA,
	payer: SPEC_PAYER.toLowerCase(),
};

/**
 * ADR-0028 Decision 8, `/settle`, Decision 5 step 8's pre-broadcast allowlist,
 * and Decision 12's "a settle answer with the wrong network, payer or amount is
 * unconfirmed".
 */
describe("X402Rail.settle — what gets sent", () => {
	test("POSTs the same body shape to {base}/settle, with our requirements", async () => {
		const { facilitator, offer, settle } = setup();
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_SUCCESS });
		await settle();
		expect(facilitator.calls).toEqual({ verify: 0, settle: 1, other: 0 });
		const [request] = facilitator.requests;
		expect(request?.url).toBe(`${FAKE_FACILITATOR_URL}/settle`);
		expect(request?.method).toBe("POST");
		expect(request?.body).toMatchObject({
			x402Version: 2,
			paymentRequirements: offer.paymentRequired.accepts[0],
		});
	});
});

describe("X402Rail.settle — settled needs a well-formed success that passes every check", () => {
	test("the spec's success body is settled", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_SUCCESS });
		expect(await settle()).toEqual(SETTLED);
	});

	test("payer and amount are optional; when present and equal it is settled", async () => {
		const { facilitator, settle } = setup();
		const { payer: _payer, ...withoutPayer } = SPEC_SETTLE_SUCCESS;
		facilitator.onSettle({ status: 200, body: withoutPayer });
		expect(await settle()).toEqual(SETTLED);

		const again = setup();
		again.facilitator.onSettle({
			status: 200,
			body: {
				...SPEC_SETTLE_SUCCESS,
				payer: `0x${SPEC_PAYER.slice(2).toUpperCase()}`,
				amount: "10000",
			},
		});
		expect(await again.settle()).toEqual(SETTLED);
	});

	test.each([
		["the wrong network", { network: BASE }],
		["the wrong payer", { payer: "0x1111111111111111111111111111111111111111" }],
		["the wrong amount", { amount: "20000" }],
		["an amount with a leading zero", { amount: "010000" }],
		["an empty transaction", { transaction: "" }],
		["a short transaction hash", { transaction: "0x1234" }],
		["a transaction hash without 0x", { transaction: SPEC_TRANSACTION.slice(2) }],
		["a non-hex transaction hash", { transaction: `${SPEC_TRANSACTION.slice(0, -1)}z` }],
	])("a success with %s is unconfirmed", async (_label, override) => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 200, body: { ...SPEC_SETTLE_SUCCESS, ...override } });
		expect(await settle()).toMatchObject({ outcome: "unconfirmed", cause: "failed_check" });
	});

	test.each([
		["the truthy string 'true'", { ...SPEC_SETTLE_SUCCESS, success: "true" }],
		["the truthy number 1", { ...SPEC_SETTLE_SUCCESS, success: 1 }],
		["no network", { success: true, transaction: SPEC_TRANSACTION }],
		["no transaction", { success: true, network: BASE_SEPOLIA }],
		["a non-JSON body", "settled!"],
	])("%s is unconfirmed, never settled", async (_label, body) => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 200, body });
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "body" });
	});

	test("a success on a non-2xx status is unconfirmed", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 400, body: SPEC_SETTLE_SUCCESS });
		expect(await settle()).toMatchObject({ outcome: "unconfirmed" });
	});
});

describe("X402Rail.settle — rejected only when proven pre-broadcast", () => {
	test.each(PRE_BROADCAST_ALLOWLIST)("%s with an empty transaction is rejected", async (reason) => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({
			status: 200,
			body: { ...SPEC_SETTLE_ERROR, errorReason: reason },
		});
		expect(await settle()).toEqual({ outcome: "rejected", reason });
	});

	test("the spec's own error answer (insufficient_funds, transaction '') is rejected, on a 4xx too", async () => {
		for (const status of [200, 400, 402]) {
			const { facilitator, settle } = setup();
			facilitator.onSettle({ status, body: SPEC_SETTLE_ERROR });
			expect(await settle()).toEqual({ outcome: "rejected", reason: "insufficient_funds" });
		}
	});

	test.each(PRE_BROADCAST_ALLOWLIST)(
		"%s naming a transaction is unconfirmed: something was broadcast",
		async (reason) => {
			const { facilitator, settle } = setup();
			facilitator.onSettle({
				status: 200,
				body: { ...SPEC_SETTLE_ERROR, errorReason: reason, transaction: SPEC_TRANSACTION },
			});
			expect(await settle()).toEqual({
				outcome: "unconfirmed",
				cause: "unproven_rejection",
				reason,
				transaction: SPEC_TRANSACTION,
			});
		},
	);

	test("the reference facilitator's post-broadcast catch (transaction_failed, '') is unconfirmed, not rejected", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 200, body: REFERENCE_SETTLE_CATCH });
		expect(await settle()).toEqual({
			outcome: "unconfirmed",
			cause: "unproven_rejection",
			reason: "invalid_exact_evm_transaction_failed",
		});
	});

	test("the reference facilitator's reverted receipt is unconfirmed and keeps the hash for the operator", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 200, body: REFERENCE_SETTLE_REVERTED });
		expect(await settle()).toEqual({
			outcome: "unconfirmed",
			cause: "unproven_rejection",
			reason: "invalid_exact_evm_transaction_failed",
			transaction: REFERENCE_SETTLE_REVERTED.transaction,
		});
	});

	test.each([
		["unexpected_settle_error"],
		["invalid_exact_evm_nonce_already_used"],
		["invalid_transaction_state"],
		["invalid_exact_evm_transaction_simulation_failed"],
		["some_other_facilitators_reason"],
	])("%s is unconfirmed", async (reason) => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ status: 200, body: { ...SPEC_SETTLE_ERROR, errorReason: reason } });
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "unproven_rejection", reason });
	});

	test("a missing errorReason is unconfirmed", async () => {
		const { facilitator, settle } = setup();
		const { errorReason: _reason, ...body } = SPEC_SETTLE_ERROR;
		facilitator.onSettle({ status: 200, body });
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "unproven_rejection" });
	});

	test("an allowlisted reason in another case is not on the allowlist", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({
			status: 200,
			body: { ...SPEC_SETTLE_ERROR, errorReason: "INSUFFICIENT_FUNDS" },
		});
		expect(await settle()).toMatchObject({ outcome: "unconfirmed" });
	});
});

describe("X402Rail.settle — could not ask is unconfirmed, never rejected", () => {
	test.each([401, 403, 408, 429, 500, 502, 503, 504])(
		"%i is unconfirmed even with an allowlisted pre-broadcast body",
		async (status) => {
			const { facilitator, settle } = setup();
			facilitator.onSettle({ status, body: SPEC_SETTLE_ERROR });
			expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "status" });
		},
	);

	test("a redirected response is unconfirmed, even with a success body", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({
			status: 200,
			body: SPEC_SETTLE_SUCCESS,
			url: "https://elsewhere.test/settle",
		});
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "redirect" });
	});

	test("an oversize body is unconfirmed", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({
			status: 200,
			body: JSON.stringify({ ...SPEC_SETTLE_SUCCESS, pad: "x".repeat(16 * 1024) }),
		});
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "oversize" });
	});

	test("a transport error is unconfirmed", async () => {
		const { facilitator, settle } = setup();
		facilitator.onSettle({ throws: new TypeError("socket hang up") });
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "transport" });
	});

	test("the 30 s timeout: unconfirmed at 30 s, and not at 10 s or 29.999 s", async () => {
		vi.useFakeTimers();
		const { facilitator, settle } = setup();
		facilitator.onSettle({ hang: true });
		let settled: unknown;
		void settle().then((r) => (settled = r));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(19_999);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toEqual({ outcome: "unconfirmed", cause: "timeout" });
	});
});
