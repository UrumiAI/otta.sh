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
 * THE VERIFICATION IS FAIL-CLOSED IN EVERY DIRECTION. A transport error, a
 * non-2xx, an unparseable body, a body that does not say `valid: true` — all of
 * them are `{ valid: false }`, never a throw and never an optimistic default.
 * `verifyReceipt` sits directly in front of `settleOrder`; a thrown rejection
 * there would surface as a 500 on a settlement the buyer already paid for, and
 * an optimistic default would settle an unverified receipt.
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

	test("anything short of an explicit `valid: true` is NOT valid", async () => {
		const cases: unknown[] = [{ valid: false }, {}, { valid: "true" }, null, [], "yes"];
		for (const body of cases) {
			const t = recorder(() => ok(body));
			expect(
				await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
			).toEqual({ valid: false });
		}
	});

	test("a non-2xx facilitator response is not valid, and does not throw", async () => {
		const t = recorder(() => Promise.resolve(new Response("nope", { status: 503 })));
		expect(
			await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
		).toEqual({
			valid: false,
		});
	});

	test("an unparseable body is not valid, and does not throw", async () => {
		const t = recorder(() => Promise.resolve(new Response("<html>", { status: 200 })));
		expect(
			await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
		).toEqual({
			valid: false,
		});
	});

	test("a transport REJECTION is not valid, and does not escape", async () => {
		// The allowedHosts gate rejects exactly like this when the facilitator host
		// is missing from the descriptor — a misconfiguration must read as "not
		// verified", never as a 500 on the settle path.
		const t = recorder(() => Promise.reject(new Error("host not allowed")));
		expect(
			await createHttpFacilitator({ fetch: t.fetch, url: FACILITATOR_URL }).verifyReceipt(proof),
		).toEqual({
			valid: false,
		});
	});
});
