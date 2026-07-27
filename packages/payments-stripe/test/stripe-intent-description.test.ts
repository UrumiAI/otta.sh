import {
	cents,
	currency,
	idempotencyKey,
	orderId,
	PaymentIntentError,
	type CreateIntentInput,
	type CreateIntentLine,
} from "@urumi/domain";
import { describe, expect, test } from "vitest";
import {
	createStripeHttpTransport,
	formatStripeIntentDescription,
	STRIPE_DESCRIPTION_MAX_LENGTH,
	StripePaymentGateway,
	type StripeCreatePaymentIntentInput,
	type StripeCreatePaymentIntentResult,
	type StripeCreateRefundResult,
	type StripePreflightResult,
	type StripeTransport,
} from "../src/index.js";

/**
 * The India-export regression (found 2026-07-27 driving a real Stripe test card
 * through staging checkout): an INDIA-based Stripe account renders
 *   "As per Indian regulations, export transactions require a description"
 * and the Payment Element refuses to complete, because `createIntent` sent only
 * amount / currency / metadata / automatic_payment_methods. Neither a unit nor a
 * contract test could catch it — it depends on the ACCOUNT's country, not on our
 * code shape. What IS testable, and is what this file pins, is that the adapter
 * now renders the domain's structured line data into Stripe's `description` (and
 * the ship-to into `shipping`), deterministically.
 */

const WEBHOOK = "whsec_test";
const SK = "sk_test_51IndiaExports";
const USD = currency("USD");

class MockTransport implements StripeTransport {
	result: StripeCreatePaymentIntentResult = {
		ok: true,
		intentId: "pi_live_1",
		clientSecret: "pi_live_1_secret_stripe",
	};
	readonly intents: StripeCreatePaymentIntentInput[] = [];

	async readRefundedAmount(): Promise<StripePreflightResult> {
		throw new Error("not used by the description suite");
	}
	async createRefund(): Promise<StripeCreateRefundResult> {
		throw new Error("not used by the description suite");
	}
	async createPaymentIntent(
		input: StripeCreatePaymentIntentInput,
	): Promise<StripeCreatePaymentIntentResult> {
		this.intents.push(input);
		return this.result;
	}
}

const SHIP_TO = {
	name: "Jenny Rosen",
	line1: "510 Townsend St",
	line2: "Apt 4",
	city: "San Francisco",
	region: "CA",
	postalCode: "94103",
	country: "US",
};

function intentInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
	return {
		orderId: orderId("ord-1"),
		amount: cents(2500),
		currency: USD,
		idempotencyKey: idempotencyKey("key-1"),
		lines: [
			{ title: "Blue Mug", quantity: 2 },
			{ title: "Red Hat", quantity: 1 },
		],
		...overrides,
	};
}

function liveGateway(transport: StripeTransport): StripePaymentGateway {
	return new StripePaymentGateway({ webhookSecret: WEBHOOK, secretKey: SK, transport });
}

describe("StripePaymentGateway.createIntent — the LIVE path always sends a description", () => {
	test("the description is NON-EMPTY and derived from the snapshotted line titles", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(intentInput());
		const description = transport.intents[0]?.description;
		expect(description).toBeTruthy();
		expect(description).toContain("Blue Mug");
		expect(description).toContain("Red Hat");
		expect(description).toBe("2 × Blue Mug, 1 × Red Hat");
	});

	test("a single-line order describes that line", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(
			intentInput({ lines: [{ title: "Ebook", quantity: 1 }] }),
		);
		expect(transport.intents[0]?.description).toBe("1 × Ebook");
	});

	test("two IDENTICAL calls produce a byte-identical description (a same-key Stripe replay must not drift)", async () => {
		const transport = new MockTransport();
		const gw = liveGateway(transport);
		await gw.createIntent(intentInput());
		await gw.createIntent(intentInput());
		expect(transport.intents[0]?.description).toBe(transport.intents[1]?.description);
	});

	test("no lines at all still yields a non-empty description (never a description-less intent)", async () => {
		for (const lines of [[], [{ title: "   ", quantity: 1 }]] as CreateIntentLine[][]) {
			const transport = new MockTransport();
			await liveGateway(transport).createIntent(intentInput({ lines }));
			expect(transport.intents[0]?.description).toBe("Order ord-1");
		}
	});

	test("the description carries NO money — the hundredths-scale minor units never leak into free text", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(intentInput({ amount: cents(2500) }));
		expect(transport.intents[0]?.description).not.toContain("2500");
		expect(transport.intents[0]?.description).not.toContain("25.00");
	});
});

describe("formatStripeIntentDescription — deterministic joining + truncation", () => {
	test("is a pure function: the same input always renders the same string", () => {
		const lines = Array.from({ length: 40 }, (_v, i) => ({
			title: `Product number ${i} with a fairly long name`,
			quantity: i + 1,
		}));
		const a = formatStripeIntentDescription({ orderId: "ord-x", lines });
		const b = formatStripeIntentDescription({ orderId: "ord-x", lines });
		expect(a).toBe(b);
	});

	test("a many-line order is truncated WITHIN Stripe's limit and says how many were dropped", () => {
		const lines = Array.from({ length: 60 }, (_v, i) => ({
			title: `A reasonably long product title number ${i}`,
			quantity: 1,
		}));
		const out = formatStripeIntentDescription({ orderId: "ord-x", lines });
		expect(out.length).toBeLessThanOrEqual(STRIPE_DESCRIPTION_MAX_LENGTH);
		expect(out).toMatch(/ \+ \d+ more$/);
		// It truncates at a LINE boundary, so the surviving text is whole lines.
		expect(out.startsWith("1 × A reasonably long product title number 0")).toBe(true);
	});

	test("a single absurdly long title is clipped, never emitted past the limit", () => {
		const out = formatStripeIntentDescription({
			orderId: "ord-x",
			lines: [{ title: "x".repeat(5000), quantity: 1 }],
		});
		expect(out.length).toBeLessThanOrEqual(STRIPE_DESCRIPTION_MAX_LENGTH);
		expect(out.endsWith("…")).toBe(true);
	});

	test("clipping respects code points — an astral-plane title never ends in a lone surrogate", () => {
		const out = formatStripeIntentDescription({
			orderId: "ord-x",
			lines: [{ title: "🧵".repeat(400), quantity: 1 }],
		});
		expect(out.length).toBeLessThanOrEqual(STRIPE_DESCRIPTION_MAX_LENGTH);
		// A lone surrogate would survive a naive `slice`; encoding round-trips clean.
		expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
		expect(out).not.toMatch(/[\uD800-\uDFFF]/u);
	});

	test("newlines / runs of whitespace in a merchant title collapse to single spaces", () => {
		expect(
			formatStripeIntentDescription({
				orderId: "ord-x",
				lines: [{ title: "  Blue\n\tMug   XL  ", quantity: 3 }],
			}),
		).toBe("3 × Blue Mug XL");
	});

	test("line ORDER is preserved (never sorted) — the order's own line order is the description's", () => {
		expect(
			formatStripeIntentDescription({
				orderId: "ord-x",
				lines: [
					{ title: "Zebra", quantity: 1 },
					{ title: "Apple", quantity: 1 },
				],
			}),
		).toBe("1 × Zebra, 1 × Apple");
	});
});

describe("StripePaymentGateway.createIntent — the ship-to becomes Stripe `shipping`", () => {
	test("a captured address maps to Stripe's shipping name + address fields (region → state)", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(intentInput({ shipTo: SHIP_TO }));
		expect(transport.intents[0]?.shipping).toEqual({
			name: "Jenny Rosen",
			line1: "510 Townsend St",
			line2: "Apt 4",
			city: "San Francisco",
			state: "CA",
			postalCode: "94103",
			country: "US",
		});
	});

	test("an order with NO ship-to sends no shipping at all (honest absence)", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(intentInput());
		expect(transport.intents[0]?.shipping).toBeUndefined();
	});

	test("absent optional fields (line2 / region) are omitted rather than sent as null", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(
			intentInput({ shipTo: { ...SHIP_TO, line2: null, region: null } }),
		);
		expect(transport.intents[0]?.shipping).toEqual({
			name: "Jenny Rosen",
			line1: "510 Townsend St",
			city: "San Francisco",
			postalCode: "94103",
			country: "US",
		});
	});

	test("the country is normalized to the ISO-3166 2-letter form Stripe demands", async () => {
		const transport = new MockTransport();
		await liveGateway(transport).createIntent(
			intentInput({ shipTo: { ...SHIP_TO, country: " us " } }),
		);
		expect(transport.intents[0]?.shipping?.country).toBe("US");
	});

	test("a thrown PaymentIntentError leaks NO buyer PII (nor the secret key)", async () => {
		const transport = new MockTransport();
		transport.result = { ok: false, class: "terminal", status: 402, code: "card_declined" };
		const err = (await liveGateway(transport)
			.createIntent(intentInput({ shipTo: SHIP_TO }))
			.catch((e: unknown) => e)) as PaymentIntentError;
		expect(err).toBeInstanceOf(PaymentIntentError);
		const exposed = [
			err.message,
			String(err.stack),
			JSON.stringify(err),
			JSON.stringify({ ...err }),
			JSON.stringify(Object.getOwnPropertyDescriptors(err)),
		].join(" ");
		for (const secret of ["Jenny Rosen", "510 Townsend St", "94103", SK]) {
			expect(exposed, secret).not.toContain(secret);
		}
	});
});

describe("StripePaymentGateway.createIntent — the OFFLINE path is UNCHANGED by all of this", () => {
	test("no secretKey ⇒ the same deterministic handle, whatever the lines / ship-to say", async () => {
		const gw = new StripePaymentGateway({ webhookSecret: WEBHOOK });
		expect(await gw.createIntent(intentInput({ shipTo: SHIP_TO }))).toEqual({
			gateway: "stripe",
			intentId: "pi_ord-1",
			clientAction: { kind: "stripe_client_secret", clientSecret: "pi_ord-1_secret_key-1" },
		});
	});

	test("the exponent-2 currency gate still fires BEFORE any description work (nothing reaches Stripe)", async () => {
		const transport = new MockTransport();
		await expect(
			liveGateway(transport).createIntent(intentInput({ currency: currency("JPY") })),
		).rejects.toBeInstanceOf(PaymentIntentError);
		expect(transport.intents).toHaveLength(0);
	});
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
	return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
		handler(String(target), init)) as unknown as typeof fetch;
}

const OK_BODY = JSON.stringify({ id: "pi_3Nxyz", client_secret: "pi_3Nxyz_secret_abc" });

function httpCall(
	capture: (body: string) => void,
	input: Partial<StripeCreatePaymentIntentInput> = {},
): Promise<StripeCreatePaymentIntentResult> {
	const transport = createStripeHttpTransport({
		baseUrl: "https://api.example",
		fetch: stubFetch((_url, init) => {
			capture(String(init?.body));
			return new Response(OK_BODY, { status: 200 });
		}),
	});
	return transport.createPaymentIntent({
		orderId: "ord-7",
		amountCents: 2500,
		currency: "usd",
		idempotencyKey: "key-7",
		secretKey: SK,
		description: "2 × Blue Mug",
		...input,
	});
}

describe("createStripeHttpTransport.createPaymentIntent — description + shipping on the wire", () => {
	test("the form carries `description`", async () => {
		let body = "";
		await httpCall((b) => {
			body = b;
		});
		expect(new URLSearchParams(body).get("description")).toBe("2 × Blue Mug");
	});

	test("the form carries Stripe's bracketed shipping keys when a ship-to is present", async () => {
		let body = "";
		await httpCall(
			(b) => {
				body = b;
			},
			{
				shipping: {
					name: "Jenny Rosen",
					line1: "510 Townsend St",
					line2: "Apt 4",
					city: "San Francisco",
					state: "CA",
					postalCode: "94103",
					country: "US",
				},
			},
		);
		const form = new URLSearchParams(body);
		expect(form.get("shipping[name]")).toBe("Jenny Rosen");
		expect(form.get("shipping[address][line1]")).toBe("510 Townsend St");
		expect(form.get("shipping[address][line2]")).toBe("Apt 4");
		expect(form.get("shipping[address][city]")).toBe("San Francisco");
		expect(form.get("shipping[address][state]")).toBe("CA");
		expect(form.get("shipping[address][postal_code]")).toBe("94103");
		expect(form.get("shipping[address][country]")).toBe("US");
	});

	test("no shipping ⇒ not one shipping key on the wire", async () => {
		let body = "";
		await httpCall((b) => {
			body = b;
		});
		expect(body).not.toContain("shipping");
	});

	test("two identical calls serialize a BYTE-IDENTICAL body (Stripe rejects a drifted same-key replay)", async () => {
		const bodies: string[] = [];
		const shipping = {
			name: "Jenny Rosen",
			line1: "510 Townsend St",
			line2: "Apt 4",
			city: "San Francisco",
			state: "CA",
			postalCode: "94103",
			country: "US",
		};
		for (let i = 0; i < 2; i++) {
			await httpCall(
				(b) => {
					bodies.push(b);
				},
				{ shipping },
			);
		}
		expect(bodies[0]).toBe(bodies[1]);
	});

	test("the pre-existing params are untouched (amount / currency / metadata / automatic_payment_methods)", async () => {
		let body = "";
		await httpCall((b) => {
			body = b;
		});
		const form = new URLSearchParams(body);
		expect(form.get("amount")).toBe("2500");
		expect(form.get("currency")).toBe("usd");
		expect(form.get("metadata[order_id]")).toBe("ord-7");
		expect(form.get("automatic_payment_methods[enabled]")).toBe("true");
	});
});
