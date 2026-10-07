import {
	cents,
	currency,
	idempotencyKey,
	money,
	productId as brandProductId,
	sku as brandSku,
	type TaxCalculator,
	type TaxRequest,
} from "@otta-sh/domain";
import { FakePaymentGateway } from "@otta-sh/domain/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InProcessCommerceClient } from "../src/commerce/in-process-commerce-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

/**
 * Registration (PR 1): a site opts in with its own entry module,
 * `export default createOttaPlugin({ taxCalculator })`, pointed at by the
 * descriptor's `entrypoint`. The calculator lands in a module slot that the
 * commerce composition root reads; the default export stays the built-in.
 * Each case re-imports the plugin so the slot starts empty.
 */
const USD = currency("USD");
let h: InProcessCommerceHarness;

beforeEach(async () => {
	vi.resetModules();
	h = await makeInProcessCommerce({
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
	await h.stores.productCommerce.upsert(
		{
			productId: brandProductId("p1"),
			sku: brandSku("MUG"),
			price: money(cents(1500), USD),
			title: "Mug",
			productKind: "digital",
		},
		idempotencyKey("seed"),
	);
	await h.stores.productCommerce.activate(
		brandProductId("p1"),
		idempotencyKey("publish"),
		"2026-01-01T00:00:00.000Z",
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await h.close();
});

async function cartId(): Promise<string> {
	const { cartId: id } = await h.client.createCart(USD);
	const added = await h.client.addCartLine(id, "MUG", "p1", 2, "add-1");
	if (!added.ok) throw new Error(added.reason);
	return id;
}

function fake(id = "acme.tax"): TaxCalculator & { seen: TaxRequest[] } {
	const seen: TaxRequest[] = [];
	return {
		id,
		seen,
		async calculate(req) {
			seen.push(req);
			return {
				ok: true,
				currency: req.currency,
				lines: req.lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 1000,
					label: "VAT",
					taxCents: cents(300),
				})),
				shipping: null,
			};
		},
	};
}

async function load() {
	const pluginModule = await import("../src/plugin.js");
	const { makeCommerceClient } = await import("../src/commerce/make-commerce-client.js");
	return { ...pluginModule, makeCommerceClient };
}

describe("createOttaPlugin({ taxCalculator })", () => {
	test("returns the same plugin object the default export is", async () => {
		const { createOttaPlugin, default: plugin } = await load();
		expect(createOttaPlugin()).toBe(plugin);
		expect(createOttaPlugin({ taxCalculator: fake() })).toBe(plugin);
	});

	test("without registration, checkout uses the built-in rate table", async () => {
		const { makeCommerceClient } = await load();
		const client = await makeCommerceClient(h.ctx);
		const quote = await client.quoteCheckout({ cartId: await cartId() });
		expect(quote.ok && quote.breakdown.taxCents).toBe(0);
	});

	test("a registered calculator prices the quote made through the composition root", async () => {
		const { createOttaPlugin, makeCommerceClient } = await load();
		const calc = fake();
		createOttaPlugin({ taxCalculator: calc });
		const client = await makeCommerceClient(h.ctx);
		const quote = await client.quoteCheckout({ cartId: await cartId() });
		expect(quote.ok && quote.breakdown).toMatchObject({ taxCents: 300, totalCents: 3300 });
		expect(calc.seen.map((r) => r.purpose)).toEqual(["quote"]);
	});

	test("registering the same calculator twice is fine; a different one throws", async () => {
		const { createOttaPlugin } = await load();
		const calc = fake();
		createOttaPlugin({ taxCalculator: calc });
		expect(() => createOttaPlugin({ taxCalculator: calc })).not.toThrow();
		expect(() => createOttaPlugin({ taxCalculator: fake("other.tax") })).toThrow(/already/);
	});

	test.each<[string, unknown]>([
		["no calculate()", { id: "acme.tax" }],
		["an empty id", { id: "", calculate: async () => ({}) }],
		["an id with spaces", { id: "acme tax", calculate: async () => ({}) }],
	])("an unusable calculator (%s) is refused at registration", async (_name, calc) => {
		const { createOttaPlugin } = await load();
		expect(() => createOttaPlugin({ taxCalculator: calc as TaxCalculator })).toThrow(TypeError);
	});
});

describe("the in-process client hands its calculator to quote and place", () => {
	test("place asks for purpose 'order' and freezes the answer", async () => {
		const calc = fake();
		const client = new InProcessCommerceClient(h.ctx, {
			gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
			taxCalculator: calc,
		});
		const id = await cartId();
		const placed = await client.createOrder(
			{ cartId: id, paymentMethod: "stripe", buyerRef: "ada@example.com" },
			`place-${id}`,
		);
		expect(placed.ok).toBe(true);
		expect(calc.seen.map((r) => r.purpose)).toEqual(["order"]);
	});

	test("a refusing calculator ⇒ TAX_UNAVAILABLE at quote and at place", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = new InProcessCommerceClient(h.ctx, {
			gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
			taxCalculator: {
				id: "acme.tax",
				calculate: async () => ({ ok: false, reason: "unavailable" }),
			},
		});
		const id = await cartId();
		expect(await client.quoteCheckout({ cartId: id })).toEqual({
			ok: false,
			reason: "TAX_UNAVAILABLE",
		});
		expect(
			await client.createOrder(
				{ cartId: id, paymentMethod: "stripe", buyerRef: "ada@example.com" },
				`place-${id}`,
			),
		).toEqual({ ok: false, reason: "TAX_UNAVAILABLE" });
	});
});
