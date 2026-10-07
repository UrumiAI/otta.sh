import { afterEach, describe, expect, test, vi } from "vitest";
import type { FacilitatorFetch } from "../src/index.js";
import {
	SPEC_PAYER,
	SPEC_PAYMENT_SIGNATURE_HEADER,
	SPEC_SETTLE_ERROR,
	SPEC_SETTLE_SUCCESS,
	SPEC_TRANSACTION,
	SPEC_VERIFY_INVALID,
	SPEC_VERIFY_VALID,
	BASE_SEPOLIA,
} from "./support/fixtures.js";
import { decodeOrThrow, makeRail, offerOrThrow } from "./support/harness.js";

afterEach(() => {
	vi.useRealTimers();
});

function bridgeSetup() {
	const { rail, facilitator } = makeRail({}, { bridge: true });
	const offer = offerOrThrow(rail);
	const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
	return {
		facilitator,
		verify: () => rail.verify(payment, offer),
		settle: () => rail.settle(payment, offer),
	};
}

/**
 * The rail on each platform's `ctx.http.fetch` (ADR-0028 Decision 8, amended
 * after increment 6's review).
 *
 * EmDash's Cloudflare Worker Loader bridge (`@emdash-cms/cloudflare@0.38.0`,
 * `dist/runner-CQpZcxVz.mjs:997-1007`) returns a plain object with no `url` and
 * no `body`, and carries `init` over RPC, where an `AbortSignal` cannot travel.
 * The rail must sell there, not just under a real `Response`.
 */
describe("X402Rail under the Worker Loader bridge's response shape", () => {
	test("a valid /verify is valid — no url is not a redirect", async () => {
		const { facilitator, verify } = bridgeSetup();
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		expect(await verify()).toEqual({ outcome: "valid", payer: SPEC_PAYER.toLowerCase() });
	});

	test("a well-formed rejection is a verdict", async () => {
		const { facilitator, verify } = bridgeSetup();
		facilitator.onVerify({ status: 400, body: SPEC_VERIFY_INVALID });
		expect(await verify()).toEqual({ outcome: "invalid", reason: "insufficient_funds" });
	});

	test("a successful /settle is settled", async () => {
		const { facilitator, settle } = bridgeSetup();
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_SUCCESS });
		expect(await settle()).toEqual({
			outcome: "settled",
			transaction: SPEC_TRANSACTION,
			network: BASE_SEPOLIA,
			payer: SPEC_PAYER.toLowerCase(),
		});
	});

	test("a pre-broadcast rejection is rejected", async () => {
		const { facilitator, settle } = bridgeSetup();
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_ERROR });
		expect(await settle()).toEqual({ outcome: "rejected", reason: "insufficient_funds" });
	});

	test("an oversize text() is refused by its UTF-8 byte length (verify: unavailable)", async () => {
		const { facilitator, verify } = bridgeSetup();
		facilitator.onVerify({
			status: 200,
			body: JSON.stringify({ isValid: true, pad: "x".repeat(16 * 1024) }),
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "oversize" });
	});

	test("an oversize text() on /settle is unconfirmed", async () => {
		const { facilitator, settle } = bridgeSetup();
		facilitator.onSettle({
			status: 200,
			body: JSON.stringify({ ...SPEC_SETTLE_SUCCESS, pad: "x".repeat(16 * 1024) }),
		});
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "oversize" });
	});

	test("the bound is bytes, not UTF-16 code units: 6000 euro signs (18000 bytes) are oversize", async () => {
		const { facilitator, verify } = bridgeSetup();
		const body = JSON.stringify({ isValid: false, invalidReason: "€".repeat(6000) });
		expect(body.length).toBeLessThan(16 * 1024);
		facilitator.onVerify({ status: 200, body });
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "oversize" });
	});

	test("an unavailable status is still unavailable", async () => {
		const { facilitator, verify } = bridgeSetup();
		facilitator.onVerify({ status: 503, body: SPEC_VERIFY_INVALID });
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "status" });
	});

	test("no AbortSignal is sent (it cannot cross the RPC), and the race still times out at 10 s", async () => {
		vi.useFakeTimers();
		const { facilitator, verify } = bridgeSetup();
		facilitator.onVerify({ hang: true });
		let settled: unknown;
		void verify().then((r) => (settled = r));
		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toEqual({ outcome: "unavailable", cause: "timeout" });
		expect(facilitator.requests[0]?.hadSignal).toBe(false);
	});
});

function withFetch(fetch: FacilitatorFetch) {
	const { rail } = makeRail({ fetch });
	const offer = offerOrThrow(rail);
	const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
	return { verify: () => rail.verify(payment, offer), settle: () => rail.settle(payment, offer) };
}

describe("X402Rail never throws, whatever the injected fetch returns", () => {
	test("a fetch resolving null is transport", async () => {
		const { verify, settle } = withFetch(async () => null as never);
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "transport" });
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "transport" });
	});

	test("a text() that rejects is transport", async () => {
		const { verify } = withFetch(async () => ({
			status: 200,
			headers: new Headers(),
			text: async () => {
				throw new Error("stream reset");
			},
		}));
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "transport" });
	});

	test("a headers object that throws is transport", async () => {
		const { settle } = withFetch(async () => ({
			status: 200,
			headers: {
				get() {
					throw new Error("boom");
				},
			},
			text: async () => JSON.stringify(SPEC_SETTLE_SUCCESS),
		}));
		expect(await settle()).toEqual({ outcome: "unconfirmed", cause: "transport" });
	});

	test("an empty url (a constructed Response) is not a redirect", async () => {
		const { verify } = withFetch(async () => new Response(JSON.stringify(SPEC_VERIFY_VALID)));
		expect(await verify()).toMatchObject({ outcome: "valid" });
	});

	test("invalid UTF-8 in a streamed body is a malformed body", async () => {
		const { verify } = withFetch(async (url) => {
			const response = new Response(new Uint8Array([0x7b, 0xff, 0x7d]));
			Object.defineProperty(response, "url", { value: url });
			return response;
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "body" });
	});

	test("a leading BOM in a streamed body is kept, so the body is not JSON", async () => {
		const { verify } = withFetch(async (url) => {
			const text = `﻿${JSON.stringify(SPEC_VERIFY_VALID)}`;
			const response = new Response(new TextEncoder().encode(text));
			Object.defineProperty(response, "url", { value: url });
			return response;
		});
		expect(await verify()).toEqual({ outcome: "unavailable", cause: "body" });
	});
});
