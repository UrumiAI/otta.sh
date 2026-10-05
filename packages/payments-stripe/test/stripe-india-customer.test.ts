import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	PaymentIntentError,
	type CreateIntentInput,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { StripePaymentGateway, STRIPE_CUSTOMER_IDEMPOTENCY_PREFIX } from "../src/index.js";

// Issue #382, review round 1 (B1). For every international payment an
// India-based account takes, Stripe requires the customer's name and BILLING
// address — given as a Customer the PaymentIntent names — besides the
// description (and, for goods, `shipping`). When the account needs it, the
// gateway creates that Customer from the order's address snapshot, under an
// idempotency key derived from the order, and passes `customer` on the intent.
// Every other account's wire is byte-identical to before. Offline: a stub
// `fetch` plays Stripe through the DEFAULT http transport, so these are wire
// tests.

const WEBHOOK = "whsec_test";
const SK = "sk_test_51IndiaCustomer";

interface Call {
	method: string;
	path: string;
	headers: Headers;
	form: URLSearchParams;
	raw: string;
}

type Reply = { status: number; body: unknown } | "network-error";

function stripeStub(reply: (call: Call) => Reply | undefined = () => undefined): {
	calls: Call[];
	fetch: typeof fetch;
} {
	const calls: Call[] = [];
	let customers = 0;
	const byKey = new Map<string, string>();
	const fetchImpl = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = new URL(String(target));
		const raw = typeof init?.body === "string" ? init.body : "";
		const call: Call = {
			method: init?.method ?? "GET",
			path: url.pathname,
			headers: new Headers(init?.headers),
			form: new URLSearchParams(raw),
			raw,
		};
		calls.push(call);
		const scripted = reply(call);
		if (scripted === "network-error") throw new TypeError("fetch failed");
		if (scripted !== undefined) {
			return new Response(JSON.stringify(scripted.body), { status: scripted.status });
		}
		if (call.path === "/v1/customers") {
			// Stripe's native idempotency: the same key returns the same Customer.
			const key = call.headers.get("idempotency-key") ?? "";
			let id = byKey.get(key);
			if (id === undefined) {
				customers += 1;
				id = `cus_${String(customers)}`;
				byKey.set(key, id);
			}
			return new Response(JSON.stringify({ id, object: "customer" }), { status: 200 });
		}
		return new Response(JSON.stringify({ id: "pi_1", client_secret: "pi_1_secret_x" }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchImpl };
}

const SHIP_TO = {
	name: "Asha Rao",
	line1: "12 Park Street",
	line2: "Flat 4",
	city: "Kolkata",
	region: "WB",
	postalCode: "700016",
	country: "in",
};

function input(over: Partial<CreateIntentInput> = {}): CreateIntentInput {
	return {
		orderId: orderId("ord-in-1"),
		amount: cents(2500),
		currency: currency("USD"),
		idempotencyKey: idempotencyKey("checkout:cart-1"),
		lines: [{ title: "Ebook", quantity: 1 }],
		shipTo: SHIP_TO,
		...over,
	};
}

function gateway(fetchImpl: typeof fetch, customerRequired?: () => Promise<boolean>) {
	return new StripePaymentGateway({
		webhookSecret: WEBHOOK,
		secretKey: SK,
		fetch: fetchImpl,
		sleep: async () => {},
		...(customerRequired !== undefined ? { customerRequired } : {}),
	});
}

const route = (c: Call) => `${c.method} ${c.path}`;

describe("an account that needs a Customer (India)", () => {
	test("creates the Customer first — name and billing address, keyed by the order — then the intent names it", async () => {
		const stub = stripeStub();
		const handle = await gateway(stub.fetch, async () => true).createIntent(input());
		expect(handle.intentId).toBe("pi_1");
		expect(stub.calls.map(route)).toEqual(["POST /v1/customers", "POST /v1/payment_intents"]);

		const customer = stub.calls[0]!;
		expect(customer.headers.get("idempotency-key")).toBe(
			`${STRIPE_CUSTOMER_IDEMPOTENCY_PREFIX}ord-in-1`,
		);
		expect(customer.headers.get("idempotency-key")).toBe("otta-cus-ord-in-1");
		expect(customer.headers.get("authorization")).toBe(`Bearer ${SK}`);
		expect([...customer.form.entries()]).toEqual([
			["name", "Asha Rao"],
			["address[line1]", "12 Park Street"],
			["address[line2]", "Flat 4"],
			["address[city]", "Kolkata"],
			["address[state]", "WB"],
			["address[postal_code]", "700016"],
			["address[country]", "IN"],
		]);

		const intent = stub.calls[1]!;
		expect(intent.form.get("customer")).toBe("cus_1");
		expect(intent.form.get("description")).toBe("1 × Ebook");
		expect(intent.form.get("shipping[name]")).toBe("Asha Rao");
		expect(intent.form.get("shipping[address][country]")).toBe("IN");
		// `customer` sits in a FIXED place: right after the description.
		const keys = [...intent.form.keys()];
		expect(keys.indexOf("customer")).toBe(keys.indexOf("description") + 1);
	});

	test("optional fields are omitted, never sent empty", async () => {
		const stub = stripeStub();
		await gateway(stub.fetch, async () => true).createIntent(
			input({ shipTo: { ...SHIP_TO, line2: null, region: null } }),
		);
		const keys = [...stub.calls[0]!.form.keys()];
		expect(keys).not.toContain("address[line2]");
		expect(keys).not.toContain("address[state]");
	});

	test("a replay of the same order — resume, double submit — reuses the Customer and sends a byte-identical intent", async () => {
		const stub = stripeStub();
		const gw = gateway(stub.fetch, async () => true);
		await gw.createIntent(input());
		await gw.createIntent(input());
		expect(stub.calls.map(route)).toEqual([
			"POST /v1/customers",
			"POST /v1/payment_intents",
			"POST /v1/customers",
			"POST /v1/payment_intents",
		]);
		expect(stub.calls[2]!.raw).toBe(stub.calls[0]!.raw);
		expect(stub.calls[2]!.headers.get("idempotency-key")).toBe(
			stub.calls[0]!.headers.get("idempotency-key"),
		);
		expect(stub.calls[3]!.raw).toBe(stub.calls[1]!.raw);
		expect(stub.calls[3]!.form.get("customer")).toBe("cus_1");
	});

	test("an order with no address gets no Customer (nothing to put on one)", async () => {
		const stub = stripeStub();
		const { shipTo: _omitted, ...withoutShipTo } = input();
		await gateway(stub.fetch, async () => true).createIntent(withoutShipTo);
		expect(stub.calls.map(route)).toEqual(["POST /v1/payment_intents"]);
		expect(stub.calls[0]!.form.has("customer")).toBe(false);
	});

	describe("a Customer create that fails is a failed intent create — and no intent is asked for", () => {
		const fail = (reply: Reply) =>
			stripeStub((call) => (call.path === "/v1/customers" ? reply : undefined));

		test("5xx / 429 / network error ⇒ retryable PaymentIntentError", async () => {
			for (const reply of [
				{ status: 500, body: {} },
				{ status: 429, body: {} },
				"network-error",
			] as const) {
				const stub = fail(reply);
				const err = await gateway(stub.fetch, async () => true)
					.createIntent(input())
					.catch((e: unknown) => e);
				expect(err).toBeInstanceOf(PaymentIntentError);
				expect((err as PaymentIntentError).retryable).toBe(true);
				expect(stub.calls.map(route).filter((r) => r.includes("payment_intents"))).toEqual([]);
			}
		});

		test("a 4xx (e.g. a restricted key without write access to customers) ⇒ terminal, with the provider code", async () => {
			const stub = fail({
				status: 403,
				body: { error: { type: "invalid_request_error", code: "secret_key_required" } },
			});
			const err = await gateway(stub.fetch, async () => true)
				.createIntent(input())
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(PaymentIntentError);
			expect((err as PaymentIntentError).retryable).toBe(false);
			expect((err as PaymentIntentError).providerStatus).toBe(403);
			expect(JSON.stringify(err)).not.toContain(SK);
			expect(stub.calls.map(route)).toEqual(["POST /v1/customers"]);
		});

		test("a 2xx with no customer id ⇒ terminal", async () => {
			const stub = fail({ status: 200, body: { object: "customer" } });
			const err = await gateway(stub.fetch, async () => true)
				.createIntent(input())
				.catch((e: unknown) => e);
			expect((err as PaymentIntentError).retryable).toBe(false);
		});

		test("a same-key Customer create still in flight is waited out, then reused", async () => {
			let first = true;
			const stub = stripeStub((call) => {
				if (call.path === "/v1/customers" && first) {
					first = false;
					return { status: 409, body: { error: { code: "idempotency_key_in_use" } } };
				}
				return undefined;
			});
			const handle = await gateway(stub.fetch, async () => true).createIntent(input());
			expect(handle.intentId).toBe("pi_1");
			expect(stub.calls.map(route)).toEqual([
				"POST /v1/customers",
				"POST /v1/customers",
				"POST /v1/payment_intents",
			]);
		});
	});
});

describe("an account that does not need one — the wire is unchanged", () => {
	test("no Customer call, and the intent form is byte-identical to a gateway with no such option", async () => {
		const notRequired = stripeStub();
		await gateway(notRequired.fetch, async () => false).createIntent(input());
		const legacy = stripeStub();
		await gateway(legacy.fetch).createIntent(input());
		expect(notRequired.calls.map(route)).toEqual(["POST /v1/payment_intents"]);
		expect(notRequired.calls[0]!.raw).toBe(legacy.calls[0]!.raw);
		expect(notRequired.calls[0]!.form.has("customer")).toBe(false);
		// Pinned: exactly the fields, in exactly the order, the intent always had.
		expect([...notRequired.calls[0]!.form.keys()]).toEqual([
			"amount",
			"currency",
			"metadata[order_id]",
			"automatic_payment_methods[enabled]",
			"description",
			"shipping[name]",
			"shipping[address][line1]",
			"shipping[address][line2]",
			"shipping[address][city]",
			"shipping[address][state]",
			"shipping[address][postal_code]",
			"shipping[address][country]",
		]);
	});

	test("a resolver that throws is 'not required' — never a failed payment", async () => {
		const stub = stripeStub();
		await gateway(stub.fetch, () => Promise.reject(new Error("kv down"))).createIntent(input());
		expect(stub.calls.map(route)).toEqual(["POST /v1/payment_intents"]);
	});
});
