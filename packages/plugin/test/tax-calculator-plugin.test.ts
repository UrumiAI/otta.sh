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
	// Deliberately NO tax settings saved and NO rates: a store whose calculator
	// replaces the rate table. ADR-0031 reads it as already charging tax (tax on),
	// so every case below runs on the default a real such store has.
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
	const { makeAdminClients } = await import("../src/admin/make-admin-clients.js");
	return { ...pluginModule, makeCommerceClient, makeAdminClients };
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

	test("no rates and nothing saved: the calculator is still asked and tax charged (ADR-0031 upgrade rule)", async () => {
		expect((await h.stores.settingsStore.get()).tax).toBeUndefined();
		expect(await h.stores.taxRules.hasAnyRate()).toBe(false);
		const { createOttaPlugin, makeCommerceClient, makeAdminClients } = await load();
		const calc = fake();
		createOttaPlugin({ taxCalculator: calc });
		const client = await makeCommerceClient(h.ctx);
		const quote = await client.quoteCheckout({ cartId: await cartId() });
		expect(calc.seen).toHaveLength(1);
		expect(quote.ok && quote.breakdown).toMatchObject({ taxCents: 300, totalCents: 3300 });
		// The admin, built by its own composition root, agrees: tax is on.
		const admin = await makeAdminClients(h.ctx);
		const read = await admin.rules.getTaxSettings();
		expect(read).toMatchObject({ saved: false, hasRates: false });
		expect(read.settings.enabled).toBe(true);
	});

	test("without registration the admin reads a rate-less store as a new store: tax off", async () => {
		const { makeAdminClients } = await load();
		const admin = await makeAdminClients(h.ctx);
		expect((await admin.rules.getTaxSettings()).settings.enabled).toBe(false);
	});

	test("registering the same calculator twice is fine; a different one throws", async () => {
		const { createOttaPlugin } = await load();
		const calc = fake();
		createOttaPlugin({ taxCalculator: calc });
		expect(() => createOttaPlugin({ taxCalculator: calc })).not.toThrow();
		expect(() => createOttaPlugin({ taxCalculator: fake("other.tax") })).toThrow(/already/);
	});

	test("a NEW object with the SAME id replaces the registered one (dev hot reload)", async () => {
		const { createOttaPlugin, makeCommerceClient } = await load();
		const first = fake();
		const reloaded = fake();
		createOttaPlugin({ taxCalculator: first });
		expect(() => createOttaPlugin({ taxCalculator: reloaded })).not.toThrow();
		const client = await makeCommerceClient(h.ctx);
		const quote = await client.quoteCheckout({ cartId: await cartId() });
		expect(quote.ok).toBe(true);
		expect(first.seen).toEqual([]);
		expect(reloaded.seen.map((r) => r.purpose)).toEqual(["quote"]);
		// A different id after the replacement still throws.
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

	test("a postcode and city on the quote's destination reach the calculator", async () => {
		await h.stores.productCommerce.upsert(
			{
				productId: brandProductId("p2"),
				sku: brandSku("BOX"),
				price: money(cents(2000), USD),
				title: "Box",
				productKind: "physical",
			},
			idempotencyKey("seed-2"),
		);
		await h.stores.productCommerce.activate(
			brandProductId("p2"),
			idempotencyKey("publish-2"),
			"2026-01-01T00:00:00.000Z",
		);
		await h.stores.inventory.seedOnHand("BOX", 5);
		await h.stores.shippingRules.createZone({ id: "z-us", name: "US", regions: ["US"] });
		const { cartId: id } = await h.client.createCart(USD);
		const added = await h.client.addCartLine(id, "BOX", "p2", 1, "add-box");
		expect(added.ok).toBe(true);

		const calc = fake();
		const client = new InProcessCommerceClient(h.ctx, { taxCalculator: calc });
		const quote = await client.quoteCheckout({
			cartId: id,
			destination: { country: "US", region: "NY", postalCode: " 10001 ", city: "New York" },
		});
		expect(quote.ok).toBe(true);
		expect(calc.seen[0]?.destination).toEqual({
			country: "US",
			region: "NY",
			postalCode: "10001",
			city: "New York",
		});

		// Bounds apply AFTER trimming, as in the domain: a 32-char postcode and a
		// 120-char city with surrounding spaces are accepted, not thrown on.
		const padded = await client.quoteCheckout({
			cartId: id,
			destination: {
				country: "US",
				region: "NY",
				postalCode: ` ${"1".repeat(32)} `,
				city: ` ${"x".repeat(120)} `,
			},
		});
		expect(padded.ok).toBe(true);
		expect(calc.seen[1]?.destination).toMatchObject({
			postalCode: "1".repeat(32),
			city: "x".repeat(120),
		});
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
