import { beforeEach, describe, expect, test } from "vitest";
import { cents } from "../../src/money/cents.js";
import { idempotencyKey } from "../../src/money/ids.js";
import {
	createOrderFromCart,
	type CreateOrderCommand,
} from "../../src/orders/create-order-from-cart.js";
import type { OrderAddressInput } from "../../src/orders/order-address.js";
import { makeOrderHarness, USD, type OrderHarness } from "./fake-harness.js";

/**
 * ADR-0021 at the order: the zone is derived from the ship-to address, a
 * physical cart in a zoned store needs an address and a method of the matched
 * zone, and every refusal happens BEFORE anything is minted or redeemed.
 * Carts are one line of 2 × 1500 = 3000 unless stated.
 */
let h: OrderHarness;

beforeEach(() => {
	h = makeOrderHarness();
});

const addressIn = (country: string, region?: string): OrderAddressInput => ({
	name: "Ada Lovelace",
	line1: "1 Main St",
	city: "Springfield",
	postalCode: "90001",
	country,
	...(region !== undefined ? { region } : {}),
});

function cmd(cartId: string, over: Partial<CreateOrderCommand> = {}): CreateOrderCommand {
	return {
		cartId,
		idempotencyKey: idempotencyKey(`k-${cartId}`),
		buyerRef: "ada@example.com",
		paymentMethod: "stripe",
		...over,
	};
}

/** {US 0%, US-CA 7.25%} with a flat 599 method in each, and DE 19%. */
async function seedZones(): Promise<void> {
	const zones: Array<[string, string[], number, number]> = [
		["z-us", ["US"], 0, 499],
		["z-us-ca", ["US-CA"], 725, 599],
		["z-de", ["DE"], 1900, 900],
	];
	for (const [id, regions, bps, amount] of zones) {
		await h.shippingRules.createZone({ id, name: id, regions });
		await h.shippingRules.createMethod({
			id: `m-${id}`,
			zoneId: id,
			name: "Flat",
			type: "flat_rate",
		});
		await h.shippingRules.createRate({
			methodId: `m-${id}`,
			currency: USD,
			amountCents: cents(amount),
			minSubtotalCents: null,
		});
		await h.taxRules.createRate({
			id: `t-${id}`,
			taxClassId: "standard",
			zoneId: id,
			rateBps: bps,
			appliesToShipping: false,
		});
	}
}

async function seedCoupon(): Promise<void> {
	await h.couponStore.create({
		id: "cpn",
		code: "SAVE5",
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: USD,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: 10,
		maxUsesPerCustomer: null,
	});
}

async function physicalCart(): Promise<string> {
	await h.seedPhysical({
		productId: "p1",
		sku: "SKU-1",
		priceCents: 1500,
		title: "Widget",
		onHand: 10,
	});
	return h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
}

async function digitalCart(): Promise<string> {
	await h.seedDigital({ productId: "d1", sku: "EBOOK", priceCents: 1500, title: "Ebook" });
	return h.cartWith([{ sku: "EBOOK", productId: "d1", qty: 2, kind: "digital" }]);
}

/** Nothing minted: no order, the cart still active, its hold still held, the
 *  coupon unredeemed. */
async function expectNothingMinted(cartId: string): Promise<void> {
	const cart = await h.cartStore.get(cartId);
	expect(cart?.state).toBe("active");
	expect(await h.orderStore.getByIdempotencyKey(idempotencyKey(`k-${cartId}`))).toBeNull();
	for (const line of cart?.lines ?? []) {
		if (line.reservationId !== null)
			expect(h.inventory.reservationState(line.reservationId)).toBe("held");
	}
	const coupon = await h.couponStore.findByCode("SAVE5");
	if (coupon !== null) expect(coupon.usesCount).toBe(0);
}

describe("createOrderFromCart derives the zone from the address", () => {
	beforeEach(async () => {
		await seedZones();
		await seedCoupon();
	});

	test("physical, zones, no address → MISSING_SHIPPING_ADDRESS; nothing minted", async () => {
		const cartId = await physicalCart();
		expect(await createOrderFromCart(h.createDeps, cmd(cartId, { couponCode: "SAVE5" }))).toEqual({
			ok: false,
			reason: "MISSING_SHIPPING_ADDRESS",
		});
		await expectNothingMinted(cartId);
	});

	test("an address no zone matches → SHIPPING_ZONE_NOT_MATCHED; nothing minted, coupon not redeemed", async () => {
		const cartId = await physicalCart();
		const res = await createOrderFromCart(
			h.createDeps,
			cmd(cartId, {
				shippingAddress: addressIn("FR"),
				shippingMethodId: "m-z-us",
				couponCode: "SAVE5",
			}),
		);
		expect(res).toEqual({ ok: false, reason: "SHIPPING_ZONE_NOT_MATCHED" });
		await expectNothingMinted(cartId);
	});

	test.each([
		["US", undefined],
		["DE", "Bavaria"],
		["US", "XX"],
	])("(%s, %j) → SHIPPING_REGION_CODE_REQUIRED; nothing minted", async (country, region) => {
		const cartId = await physicalCart();
		const res = await createOrderFromCart(
			h.createDeps,
			cmd(cartId, { shippingAddress: addressIn(country, region), shippingMethodId: "m-z-us" }),
		);
		expect(res).toEqual({ ok: false, reason: "SHIPPING_REGION_CODE_REQUIRED" });
		await expectNothingMinted(cartId);
	});

	test("matched, no method → SHIPPING_METHOD_REQUIRED; nothing minted", async () => {
		const cartId = await physicalCart();
		const res = await createOrderFromCart(
			h.createDeps,
			cmd(cartId, { shippingAddress: addressIn("US", "TX"), couponCode: "SAVE5" }),
		);
		expect(res).toEqual({ ok: false, reason: "SHIPPING_METHOD_REQUIRED" });
		await expectNothingMinted(cartId);
	});

	test("a method from another zone → SHIPPING_METHOD_NOT_IN_ZONE", async () => {
		const cartId = await physicalCart();
		const res = await createOrderFromCart(
			h.createDeps,
			cmd(cartId, { shippingAddress: addressIn("US", "CA"), shippingMethodId: "m-z-us" }),
		);
		expect(res).toEqual({ ok: false, reason: "SHIPPING_METHOD_NOT_IN_ZONE" });
		await expectNothingMinted(cartId);
	});

	test("US-CA: 3000 + 599 + 218 = 3817; snapshot {zoneId, methodId, matchedRegion}; region stored as CA; intent 3817", async () => {
		const cartId = await physicalCart();
		const res = await createOrderFromCart(
			h.createDeps,
			cmd(cartId, { shippingAddress: addressIn("us", "US-CA"), shippingMethodId: "m-z-us-ca" }),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.totals).toMatchObject({
			subtotal: 3000,
			shipping: 599,
			tax: 218,
			total: 3817,
			shippingMethodSnapshot: { zoneId: "z-us-ca", methodId: "m-z-us-ca", matchedRegion: "US-CA" },
		});
		expect(res.order.shippingAddress).toMatchObject({ country: "US", region: "CA" });
		expect(h.stripeGw.intentCalls.at(-1)?.amount).toBe(3817);
		expect(h.stripeGw.intentCalls.at(-1)?.shipTo).toMatchObject({ country: "US", region: "CA" });
	});

	test("a mixed cart without an address → MISSING_SHIPPING_ADDRESS; with a DE address the zone taxes BOTH lines (285 + 190)", async () => {
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 10,
		});
		await h.seedDigital({ productId: "d1", sku: "EBOOK", priceCents: 1000, title: "Ebook" });
		const cartId = await h.cartWith([
			{ sku: "SKU-1", productId: "p1", qty: 1, kind: "physical" },
			{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" },
		]);
		expect(await createOrderFromCart(h.createDeps, cmd(cartId))).toEqual({
			ok: false,
			reason: "MISSING_SHIPPING_ADDRESS",
		});
		const res = await createOrderFromCart(
			h.createDeps,
			cmd(cartId, { shippingAddress: addressIn("DE"), shippingMethodId: "m-z-de" }),
		);
		expect(res.ok && res.order.totals.tax).toBe(475);
	});

	describe("a digital-only cart (U3)", () => {
		test("an address no zone matches still orders, untaxed, and the address is stored", async () => {
			const cartId = await digitalCart();
			const res = await createOrderFromCart(
				h.createDeps,
				cmd(cartId, { shippingAddress: addressIn("FR") }),
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.order.totals).toMatchObject({
				tax: 0,
				shipping: 0,
				total: 3000,
				shippingMethodSnapshot: null,
			});
			expect(res.order.shippingAddress?.country).toBe("FR");
		});

		test("a blank region orders even where the country has a subdivision zone (US + US-CA)", async () => {
			const cartId = await digitalCart();
			const res = await createOrderFromCart(
				h.createDeps,
				cmd(cartId, { shippingAddress: addressIn("US") }),
			);
			expect(res.ok).toBe(true);
		});

		test("the address must still be valid: country 'United States' → INVALID_SHIPPING_ADDRESS; region 'Bavaria' → SHIPPING_REGION_CODE_REQUIRED", async () => {
			const cartId = await digitalCart();
			expect(
				await createOrderFromCart(
					h.createDeps,
					cmd(cartId, { shippingAddress: addressIn("United States") }),
				),
			).toEqual({ ok: false, reason: "INVALID_SHIPPING_ADDRESS" });
			expect(
				await createOrderFromCart(
					h.createDeps,
					cmd(cartId, { shippingAddress: addressIn("DE", "Bavaria") }),
				),
			).toEqual({ ok: false, reason: "SHIPPING_REGION_CODE_REQUIRED" });
		});

		test("with no address at all it orders", async () => {
			const cartId = await digitalCart();
			expect((await createOrderFromCart(h.createDeps, cmd(cartId))).ok).toBe(true);
		});

		test("a method → SHIPPING_METHOD_NOT_APPLICABLE", async () => {
			const cartId = await digitalCart();
			expect(
				await createOrderFromCart(h.createDeps, cmd(cartId, { shippingMethodId: "m-z-us" })),
			).toEqual({
				ok: false,
				reason: "SHIPPING_METHOD_NOT_APPLICABLE",
			});
		});
	});

	describe("replays return the ORIGINAL order and re-evaluate nothing (Decision 8)", () => {
		async function placed(): Promise<{ cartId: string; orderId: string; total: number }> {
			const cartId = await physicalCart();
			const res = await createOrderFromCart(
				h.createDeps,
				cmd(cartId, {
					shippingAddress: addressIn("US", "CA"),
					shippingMethodId: "m-z-us-ca",
					couponCode: "SAVE5",
				}),
			);
			if (!res.ok) throw new Error(res.reason);
			return { cartId, orderId: res.order.id, total: res.order.totals.total };
		}

		test("with a zone-B address: same order, same totals, no second redemption", async () => {
			const first = await placed();
			const replay = await createOrderFromCart(
				h.createDeps,
				cmd(first.cartId, { shippingAddress: addressIn("DE"), shippingMethodId: "m-z-de" }),
			);
			expect(replay.ok && replay.order.id).toBe(first.orderId);
			expect(replay.ok && replay.order.totals.total).toBe(first.total);
			expect((await h.couponStore.findByCode("SAVE5"))?.usesCount).toBe(1);
		});

		test("with NO address and NO method in a zoned store — the locked review's retry", async () => {
			const first = await placed();
			const replay = await createOrderFromCart(h.createDeps, cmd(first.cartId));
			expect(replay.ok && replay.order.id).toBe(first.orderId);
		});

		test("after the zone was deleted", async () => {
			const first = await placed();
			await h.shippingRules.deleteRate("m-z-us-ca", USD);
			await h.shippingRules.deleteMethod("m-z-us-ca");
			await h.shippingRules.deleteZone("z-us-ca");
			const replay = await createOrderFromCart(h.createDeps, cmd(first.cartId));
			expect(replay.ok && replay.order.id).toBe(first.orderId);
		});
	});
});

describe("a store with NO zones", () => {
	test("a physical cart with no address orders at 0 shipping / 0 tax, snapshot null", async () => {
		const cartId = await physicalCart();
		const res = await createOrderFromCart(h.createDeps, cmd(cartId));
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.order.totals).toMatchObject({
			shipping: 0,
			tax: 0,
			total: 3000,
			shippingMethodSnapshot: null,
		});
	});

	test("an address must still carry ISO codes (Decision 6)", async () => {
		const cartId = await physicalCart();
		expect(
			await createOrderFromCart(
				h.createDeps,
				cmd(cartId, { shippingAddress: addressIn("Testland") }),
			),
		).toEqual({ ok: false, reason: "INVALID_SHIPPING_ADDRESS" });
	});
});
