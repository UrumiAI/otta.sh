import { beforeEach, describe, expect, test } from "vitest";
import {
	cents,
	idempotencyKey,
	NEW_STORE_TAX_SETTINGS,
	type TaxSettings,
} from "../../src/index.js";
import {
	type CreateOrderCommand,
	createOrderFromCart,
} from "../../src/orders/create-order-from-cart.js";
import { readOrderTaxSnapshot } from "../../src/orders/order-tax-snapshot.js";
import { InMemorySettingsStore } from "../../src/testing/in-memory-settings-store.js";
import { makeOrderHarness, type OrderHarness, USD } from "./fake-harness.js";

/**
 * Issue #426: with "based on the customer's billing address", a cart that
 * ships nothing is taxed at the billing location the checkout sent — the same
 * location the review quote was priced for — and the frozen tax snapshot says
 * which address that was. Every other option, and every cart that ships, is
 * priced and snapshotted exactly as before.
 */
let h: OrderHarness;
let settings: InMemorySettingsStore;
let seq = 0;

const SHOP_IN_GB: TaxSettings = {
	...NEW_STORE_TAX_SETTINGS,
	enabled: true,
	baseAddress: { country: "GB", region: null },
};
const BY_BUYER: TaxSettings = { ...SHOP_IN_GB, basedOn: "billing" };

beforeEach(async () => {
	h = makeOrderHarness();
	settings = new InMemorySettingsStore();
	await h.shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await h.shippingRules.createZone({ id: "z-de", name: "Germany", regions: ["DE"] });
	await h.shippingRules.createMethod({ id: "m", zoneId: "z-gb", name: "Flat", type: "flat_rate" });
	await h.shippingRules.createRate({
		methodId: "m",
		currency: USD,
		amountCents: cents(500),
		minSubtotalCents: null,
	});
	await h.taxRules.createClass({ id: "standard", name: "VAT" });
	await h.taxRules.createRate({
		id: "t-gb",
		taxClassId: "standard",
		zoneId: "z-gb",
		rateBps: 2000,
		appliesToShipping: true,
	});
	await h.taxRules.createRate({
		id: "t-de",
		taxClassId: "standard",
		zoneId: "z-de",
		rateBps: 1900,
		appliesToShipping: true,
	});
	await h.seedDigital({ productId: "d1", sku: "EBOOK", priceCents: 1000, title: "E-book" });
	await h.seedPhysical({ productId: "p1", sku: "MUG", priceCents: 1000, title: "Mug", onHand: 5 });
});

async function save(tax: TaxSettings): Promise<void> {
	await settings.update({ tax }, idempotencyKey(`s-${seq++}`));
}

function place(command: CreateOrderCommand) {
	return createOrderFromCart({ ...h.createDeps, settings }, command);
}

const digitalCommand = (
	cartId: string,
	extra: Partial<CreateOrderCommand> = {},
): CreateOrderCommand => ({
	cartId,
	idempotencyKey: idempotencyKey(`k-${cartId}`),
	buyerRef: "ada@example.com",
	paymentMethod: "stripe",
	...extra,
});

const ebook = () => h.cartWith([{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);

describe("setting OFF: digital orders priced and snapshotted exactly as before", () => {
	test("a billing location is ignored: base-address tax, the same snapshot", async () => {
		await save(SHOP_IN_GB);
		const plain = await place(digitalCommand(await ebook()));
		const located = await place(
			digitalCommand(await ebook(), { billingLocation: { country: "DE", region: null } }),
		);
		if (!plain.ok || !located.ok) throw new Error("refused");
		expect(located.order.totals.tax).toBe(200);
		expect(located.order.totals.taxBreakdown).toEqual(plain.order.totals.taxBreakdown);
		expect(located.order.totals.taxBreakdown).not.toHaveProperty("taxAddress");
	});
});

describe("setting ON: based on the customer's billing address", () => {
	test("a digital-only order is taxed at the billing country, and the snapshot records it", async () => {
		await save(BY_BUYER);
		const res = await place(
			digitalCommand(await ebook(), { billingLocation: { country: "de", region: null } }),
		);
		if (!res.ok) throw new Error(res.reason);
		expect(res.order.totals.tax).toBe(190);
		expect(res.order.totals.total).toBe(1190);
		const snapshot = readOrderTaxSnapshot(res.order.totals.taxBreakdown);
		expect(snapshot).toMatchObject({
			v: 1,
			located: true,
			taxAddress: { basis: "billing", country: "DE", region: null },
			lines: [{ rateBps: 1900, taxCents: 190 }],
		});
	});

	test("a buyer address alone (issue #382) is not the billing location: the review was not priced for it", async () => {
		await save(BY_BUYER);
		const res = await place(
			digitalCommand(await ebook(), {
				shippingAddress: {
					name: "Ada",
					line1: "1 Hauptstr.",
					city: "Berlin",
					postalCode: "10115",
					country: "DE",
				},
			}),
		);
		if (!res.ok) throw new Error(res.reason);
		expect(res.order.totals.tax).toBe(200); // the base address, as the review priced it
		expect(res.order.totals.taxBreakdown).not.toHaveProperty("taxAddress");
	});

	test("no billing location at all ⇒ the base address, nothing recorded", async () => {
		await save(BY_BUYER);
		const res = await place(digitalCommand(await ebook()));
		if (!res.ok) throw new Error(res.reason);
		expect(res.order.totals.tax).toBe(200);
		expect(res.order.totals.taxBreakdown).not.toHaveProperty("taxAddress");
	});

	test("a malformed billing location refuses the checkout before anything is minted", async () => {
		await save(BY_BUYER);
		const cartId = await ebook();
		const res = await place(digitalCommand(cartId, { billingLocation: { country: "ZZ" } }));
		expect(res).toEqual({ ok: false, reason: "INVALID_SHIPPING_ADDRESS" });
		expect(await h.orderStore.getByIdempotencyKey(idempotencyKey(`k-${cartId}`))).toBeNull();
		expect(h.stripeGw.intentCalls).toEqual([]);
	});

	test("REPLAY: the same key returns the same order, never re-priced for a new location", async () => {
		await save(BY_BUYER);
		const cartId = await ebook();
		const first = await place(digitalCommand(cartId, { billingLocation: { country: "DE" } }));
		const replay = await place(digitalCommand(cartId, { billingLocation: { country: "GB" } }));
		if (!first.ok || !replay.ok) throw new Error("refused");
		expect(replay.order.id).toBe(first.order.id);
		expect(replay.order.totals).toEqual(first.order.totals);
		expect(replay.order.totals.tax).toBe(190);
	});

	test("a mixed cart (something ships) is taxed by its ship-to, nothing recorded", async () => {
		await save(BY_BUYER);
		const cartId = await h.cartWith([
			{ sku: "MUG", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" },
		]);
		const res = await place(
			digitalCommand(cartId, {
				shippingMethodId: "m",
				billingLocation: { country: "DE" },
				shippingAddress: {
					name: "Ada",
					line1: "1 High St",
					city: "London",
					postalCode: "N1 1AA",
					country: "GB",
				},
			}),
		);
		if (!res.ok) throw new Error(res.reason);
		expect(res.order.totals.tax).toBe(400 + 100); // UK 20% on 2000 + shipping
		expect(res.order.totals.taxBreakdown).not.toHaveProperty("taxAddress");
	});
});
