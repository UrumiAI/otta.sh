import { afterEach, describe, expect, test, vi } from "vitest";
import {
	SPEC_PAYMENT_SIGNATURE_HEADER,
	SPEC_SETTLE_SUCCESS,
	SPEC_VERIFY_VALID,
} from "./support/fixtures.js";
import type { FakeScript } from "./support/fake-facilitator.js";
import {
	decodeOrThrow,
	makeRail,
	offerOrThrow,
	ONE_CENT,
	RESOURCE_URL,
} from "./support/harness.js";

const KEY = "sk_live_facilitator_9f2c1e";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Results carry bigints (the decoded window), which JSON cannot encode. */
const dump = (value: unknown) =>
	JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/**
 * ADR-0028 Decision 8, "Credentials: none, or a static bearer key", and
 * Decision 12's "Credentials".
 */
describe("X402Rail credentials", () => {
	test("with no key, no Authorization header is sent to /verify or /settle", async () => {
		const { rail, facilitator } = makeRail();
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_SUCCESS });
		const offer = offerOrThrow(rail);
		const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		await rail.verify(payment, offer);
		await rail.settle(payment, offer);
		expect(facilitator.requests).toHaveLength(2);
		for (const request of facilitator.requests) {
			expect(request.headers).not.toHaveProperty("authorization");
		}
	});

	test("an empty key is no key", async () => {
		const { rail, facilitator } = makeRail({ facilitatorApiKey: "" });
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		await rail.verify(decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER), offerOrThrow(rail));
		expect(facilitator.requests[0]?.headers).not.toHaveProperty("authorization");
	});

	test("with a key, it is sent only as Authorization: Bearer, on both paths, and nowhere else", async () => {
		const { rail, facilitator } = makeRail({ facilitatorApiKey: KEY });
		facilitator.onVerify({ status: 200, body: SPEC_VERIFY_VALID });
		facilitator.onSettle({ status: 200, body: SPEC_SETTLE_SUCCESS });
		const offer = offerOrThrow(rail);
		const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		await rail.verify(payment, offer);
		await rail.settle(payment, offer);
		expect(facilitator.requests.map((r) => r.path)).toEqual(["/verify", "/settle"]);
		for (const request of facilitator.requests) {
			expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
			const { authorization: _auth, ...others } = request.headers;
			expect(dump(others)).not.toContain(KEY);
			expect(dump(request.body)).not.toContain(KEY);
			expect(request.url).not.toContain(KEY);
		}
	});

	const failures: Array<[string, FakeScript]> = [
		// A transport error whose message quotes the request — the shape a
		// careless fetch wrapper produces.
		[
			"a transport error quoting the request",
			{ throws: new Error(`refused: Authorization: Bearer ${KEY}`) },
		],
		["a 401 echoing the key", { status: 401, body: { error: `bad key ${KEY}` } }],
		[
			"a 200 echoing the key as a reason",
			{ status: 200, body: { isValid: false, invalidReason: KEY } },
		],
		["an unparseable body", { status: 200, body: `not json ${KEY}` }],
	];

	test.each(failures)(
		"no credential appears in any result or log line: %s",
		async (_label, script) => {
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
				vi.spyOn(console, method).mockImplementation(() => {}),
			);
			const { rail, facilitator } = makeRail({ facilitatorApiKey: KEY });
			facilitator.onVerify(script);
			facilitator.onSettle(script);
			const offer = offerOrThrow(rail);
			const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
			const results = [await rail.verify(payment, offer), await rail.settle(payment, offer)];
			expect(dump(results)).not.toContain(KEY);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		},
	);

	test("a key that cannot be a header value is unconfigured: nothing is offered and nothing is sent", async () => {
		const badKey = `${KEY}\r\nX-Injected: 1`;
		const { rail, facilitator } = makeRail({ facilitatorApiKey: badKey });
		const refused = rail.offer(ONE_CENT, RESOURCE_URL);
		expect(refused).toEqual({ ok: false, reason: "NOT_OFFERED", detail: "facilitator" });

		// Even handed an offer built elsewhere, verify and settle send nothing.
		const offer = offerOrThrow(makeRail().rail);
		const payment = decodeOrThrow(rail, SPEC_PAYMENT_SIGNATURE_HEADER);
		const verify = await rail.verify(payment, offer);
		const settle = await rail.settle(payment, offer);
		expect(verify).toEqual({ outcome: "unavailable", cause: "unconfigured" });
		expect(settle).toEqual({ outcome: "unconfirmed", cause: "unconfigured" });
		expect(facilitator.calls).toEqual({ verify: 0, settle: 0, other: 0 });
		expect(dump([refused, verify, settle])).not.toContain(KEY);
	});
});
