/**
 * INC-C5 — the facilitator that actually talks to a facilitator.
 *
 * `createTestFacilitator` is an OFFLINE shared-secret HMAC stand-in and
 * `x402-wiring.ts` says so in capitals: anyone holding the secret can mint a
 * "verified" proof. The production shape has always been "an HTTP call to the
 * facilitator" — this is that call, written so the ONE thing it needs from its
 * host is an injected `fetch`. That injection is what lets the sandboxed plugin
 * hand it `ctx.http.fetch` (allowedHosts-gated) while this package keeps its
 * sandbox-clean guarantee: no `node:` import, no ambient fetch.
 *
 * THE VERIFICATION IS FAIL-CLOSED IN EVERY DIRECTION — it NEVER returns
 * `valid: true` unless a facilitator said so about THIS receipt, and it never
 * throws. What revision 2 adds is that "not valid" is no longer one bucket:
 * "the facilitator answered, and the answer was no" and "the facilitator could
 * not be asked" are different facts about a buyer whose money already moved, and
 * collapsing them turned a transient outage into a permanent refusal.
 * `unavailable: true` marks the second, and the GATEWAY (not this adapter) is
 * what turns it into a retryable throw.
 *
 * ⚠ The production-swap requirements in `X402Facilitator`'s doc comment still
 * stand and are NOT satisfied by "the endpoint answered 200": the facilitator
 * must attest amount, asset and recipient. This adapter forwards the whole proof
 * so a facilitator CAN attest them, and the domain's own amount equality and
 * tx-hash dedupe remain the load-bearing binding to the order.
 */
import { cents, currency as toCurrency, orderId as toOrderId } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { createHttpFacilitator } from "../src/index.js";

const FACILITATOR_URL = "https://facilitator.example.test/verify";

const proof = {
	orderId: toOrderId("11111111-1111-4111-8111-111111111111"),
	transaction: "0xdeadbeef",
	network: "eip155:8453",
	payer: "0xbuyer",
	amount: cents(2599),
	currency: toCurrency("USD"),
	signature: "",
};

function recorder(response: () => Promise<Response>) {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
	return {
		calls,
		fetch: (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return response();
		},
	};
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("createHttpFacilitator", () => {
	test("POSTs the whole receipt to the facilitator through the INJECTED fetch", async () => {
		const t = recorder(() => ok({ valid: true }));
		const f = createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL });
		expect(await f.verifyReceipt(proof)).toEqual({ valid: true });

		expect(t.calls).toHaveLength(1);
		expect(t.calls[0]?.url).toBe(FACILITATOR_URL);
		expect(t.calls[0]?.init?.method).toBe("POST");
		const body = JSON.parse(String(t.calls[0]?.init?.body)) as Record<string, unknown>;
		// Amount travels as the integer minor units it already is — the facilitator
		// is asked to attest THAT number, so a float here would be attesting a
		// different payment than the one the domain will equality-check.
		expect(body["amount"]).toBe(2599);
		expect(Number.isInteger(body["amount"])).toBe(true);
		expect(body["transaction"]).toBe("0xdeadbeef");
		expect(body["network"]).toBe("eip155:8453");
		expect(body["currency"]).toBe("USD");
	});

	test("attaches the facilitator credential only when one is configured", async () => {
		const withKey = recorder(() => ok({ valid: true }));
		await createHttpFacilitator({
			fetch: withKey.fetch,
			url: FACILITATOR_URL,
			apiKey: "fk",
		}).verifyReceipt(proof);
		expect(
			((withKey.calls[0]?.init?.headers ?? {}) as Record<string, string>)["authorization"],
		).toBe("Bearer fk");

		const without = recorder(() => ok({ valid: true }));
		await createHttpFacilitator({ fetch: without.fetch, url: FACILITATOR_URL }).verifyReceipt(
			proof,
		);
		expect(Object.hasOwn((without.calls[0]?.init?.headers ?? {}) as object, "authorization")).toBe(
			false,
		);
	});

	test("an envelope short of an explicit `valid: true` is a VERDICT: not valid", async () => {
		// A well-formed answer that does not say `valid: true` IS an answer, so it
		// stays terminal — truthiness is never enough.
		for (const body of [{ valid: false }, {}, { valid: "true" }, { valid: 1 }]) {
			const t = recorder(() => ok(body));
			expect(
				await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
			).toEqual({ valid: false });
		}
	});

	test("a 200 whose body is not an envelope at all is UNAVAILABLE", async () => {
		// `null`, an array or a bare string is not a facilitator answering "no" — it
		// is a facilitator (or something in front of it) failing to answer.
		for (const body of [null, [], "yes"]) {
			const t = recorder(() => ok(body));
			expect(
				await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
			).toEqual({ valid: false, unavailable: true });
		}
	});

	test("a 4xx the facilitator understood is a VERDICT: not valid, and not unavailable", async () => {
		// 400/404/422 mean the facilitator read the receipt and rejected it. That is
		// an answer, so it is terminal — the buyer's proof really is no good.
		for (const status of [400, 404, 422]) {
			const t = recorder(() => Promise.resolve(new Response("nope", { status })));
			expect(
				await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
			).toEqual({ valid: false });
		}
	});

	test("an outage-shaped response is UNAVAILABLE, not a verdict", async () => {
		// 5xx / 408 / 429 say nothing about the receipt; 401 / 403 say our own
		// credential is wrong, which is likewise not a statement about the buyer.
		// Reporting any of these as "invalid signature" would permanently refuse a
		// settlement whose money already moved on-chain.
		for (const status of [500, 502, 503, 408, 429, 401, 403]) {
			const t = recorder(() => Promise.resolve(new Response("nope", { status })));
			expect(
				await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
			).toEqual({ valid: false, unavailable: true });
		}
	});

	test("an unparseable body is UNAVAILABLE — a broken answer is not an answer", async () => {
		const t = recorder(() => Promise.resolve(new Response("<html>", { status: 200 })));
		expect(
			await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
		).toEqual({ valid: false, unavailable: true });
	});

	test("a transport REJECTION is UNAVAILABLE, and does not escape", async () => {
		// The allowedHosts gate rejects exactly like this when the facilitator host
		// is missing from the descriptor. Still never a throw from here — but it is
		// "could not ask", not "the receipt is forged".
		const t = recorder(() => Promise.reject(new Error("host not allowed")));
		expect(
			await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
		).toEqual({ valid: false, unavailable: true });
	});

	test("a HUNG facilitator is aborted and reported UNAVAILABLE, never awaited forever", async () => {
		// A hung facilitator must not hang `settleOrder` inside the isolate. The
		// adapter passes an AbortSignal; this fake honours it exactly as a real
		// fetch does, so the assertion is that the await actually completes.
		const seen: Array<AbortSignal | undefined> = [];
		const hang = (_url: string, init?: RequestInit) => {
			const signal = init?.signal ?? undefined;
			seen.push(signal ?? undefined);
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					reject(new Error("aborted"));
				});
			});
		};
		const result = await createHttpFacilitator({
			fetch: hang,
			url: FACILITATOR_URL,
			requestTimeoutMs: 20,
		}).verifyReceipt(proof);
		expect(result).toEqual({ valid: false, unavailable: true });
		expect(seen[0]).toBeInstanceOf(AbortSignal);
	});

	test("a facilitator answering about a DIFFERENT receipt is UNAVAILABLE, not a verdict", async () => {
		// The response is bound to the question: a facilitator that echoes a
		// transaction or order id, and echoes the WRONG one, has attested something
		// else, so it never settles.
		//
		// BUT IT IS NOT A VERDICT ON THIS RECEIPT (review round 2, A4). Round 1 split
		// "not valid" into two facts precisely because a buyer whose USDC has already
		// moved must not be permanently refused by something that was never an
		// answer about them. An unparseable body is classified `unavailable` on
		// exactly that reasoning, and an answer about someone else's transaction is
		// the same class of defect — the facilitator could not be asked. Terminal
		// would make one buggy deployment an irreversible refusal.
		for (const body of [
			{ valid: true, transaction: "0xsomeoneelse" },
			{ valid: true, orderId: "22222222-2222-4222-8222-222222222222" },
		]) {
			const t = recorder(() => ok(body));
			expect(
				await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
			).toEqual({ valid: false, unavailable: true });
		}
		// A facilitator that echoes the RIGHT ids still verifies.
		const matching = recorder(() =>
			ok({ valid: true, transaction: proof.transaction, orderId: proof.orderId }),
		);
		expect(
			await createHttpFacilitator({ fetch: matching.fetch, url: FACILITATOR_URL }).verifyReceipt(
				proof,
			),
		).toEqual({ valid: true });
	});
});
