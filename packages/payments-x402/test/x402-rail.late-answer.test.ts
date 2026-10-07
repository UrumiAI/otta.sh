import { afterEach, describe, expect, test, vi } from "vitest";
import type { FacilitatorFetch, FacilitatorResponse } from "../src/index.js";
import { SPEC_PAYMENT_SIGNATURE_HEADER } from "./support/fixtures.js";
import { decodeOrThrow, makeRail, offerOrThrow } from "./support/harness.js";

// The rail sends no `AbortSignal` (EmDash's sandbox RPC refuses one) and bounds
// each exchange with its own race. Once that race is lost, nothing more is read:
// an answer that arrives late is discarded with its body cancelled, and a body
// that was being read when time ran out has its reader cancelled.

afterEach(() => {
	vi.useRealTimers();
});

function withFetch(fetch: FacilitatorFetch) {
	const { rail } = makeRail({ fetch });
	const offer = offerOrThrow(rail);
	const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
	return { verify: () => rail.verify(payment, offer) };
}

function endlessBody(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"isValid":'));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { body, cancelled: () => cancelled };
}

function streamed(body: ReadableStream<Uint8Array>): FacilitatorResponse {
	return {
		status: 200,
		headers: { get: () => null },
		body,
		text: () => Promise.reject(new Error("text() is not used for a streamed body")),
	};
}

describe("X402Rail: nothing is read after the timeout", () => {
	test("an answer after the 10 s timeout is discarded with its body cancelled unread", async () => {
		vi.useFakeTimers();
		let deliver: ((res: FacilitatorResponse) => void) | undefined;
		const { verify } = withFetch(
			() =>
				new Promise<FacilitatorResponse>((resolve) => {
					deliver = resolve;
				}),
		);
		const result = verify();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toEqual({ outcome: "unavailable", cause: "timeout" });
		const late = endlessBody();
		deliver?.(streamed(late.body));
		await vi.advanceTimersByTimeAsync(1);
		expect(late.cancelled()).toBe(true);
	});

	test("a body still being read at the timeout has its reader cancelled", async () => {
		vi.useFakeTimers();
		const endless = endlessBody();
		const { verify } = withFetch(async () => streamed(endless.body));
		const result = verify();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toEqual({ outcome: "unavailable", cause: "timeout" });
		await vi.advanceTimersByTimeAsync(1);
		expect(endless.cancelled()).toBe(true);
	});

	test("an answer in time is unaffected, and leaves no timer behind", async () => {
		vi.useFakeTimers();
		const { verify } = withFetch(async () => ({
			status: 200,
			headers: { get: () => null },
			text: async () => JSON.stringify({ isValid: true }),
		}));
		const result = await verify();
		expect(result.outcome).not.toBe("unavailable");
		expect(vi.getTimerCount()).toBe(0);
	});
});
