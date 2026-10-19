/**
 * ADR-0021 through REAL documents: the shipping/tax zone derived from the
 * ship-to address, with the order, cart and inventory stores AND the shipping
 * and tax rules stores all on the dialect under test. What this proves that
 * the domain's fake suite cannot: the rules documents hand the zone matcher
 * its regions intact, the method-in-zone check reads a real method document,
 * and the order document round-trips the `{ zoneId, methodId, matchedRegion }`
 * snapshot.
 */
import {
	cents,
	createOrderFromCart,
	currency,
	idempotencyKey,
	readOrderTaxSnapshot,
	type CreateOrderDeps,
} from "@urumi-ai/otta-domain";
import { expect, test } from "vitest";
import { EmdashShippingRulesStore, EmdashTaxRulesStore } from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import { ORDER_LAYOUT } from "./order-collections.js";
import { makeOrderHarness, type OrderHarness } from "./order-harness.js";
import { RULES_LAYOUT } from "./rules-collections.js";

const USD = currency("USD");

const address = (country: string, region?: string) => ({
	name: "Ada Lovelace",
	line1: "1 Main St",
	city: "Los Angeles",
	postalCode: "90001",
	country,
	...(region !== undefined ? { region } : {}),
});

const cmd = (cartId: string, over: Record<string, unknown>) => ({
	cartId,
	idempotencyKey: idempotencyKey(`k-${cartId}`),
	buyerRef: "ada@example.com",
	paymentMethod: "stripe" as const,
	...over,
});

describeEachDialect("checkout zone derivation (ADR-0021)", (ctx) => {
	const bound = ctx.useStorage({ ...ORDER_LAYOUT, ...RULES_LAYOUT });

	async function setup(): Promise<{ h: OrderHarness; deps: CreateOrderDeps; cartId: string }> {
		const h = makeOrderHarness(bound.storage);
		const shippingRules = new EmdashShippingRulesStore({ storage: bound.storage, clock: h.clock });
		const taxRules = new EmdashTaxRulesStore({ storage: bound.storage, clock: h.clock });
		for (const [id, regions, bps, ppm] of [
			["z-us", ["US"], 0, undefined],
			["z-us-ca", ["US-CA"], 725, undefined],
			// #425: New York City's 8.875%, finer than a basis point.
			["z-us-ny", ["US-NY"], 888, 88_750],
		] as const) {
			await shippingRules.createZone({ id, name: id, regions: [...regions] });
			await shippingRules.createMethod({
				id: `m-${id}`,
				zoneId: id,
				name: "Flat",
				type: "flat_rate",
			});
			await shippingRules.createRate({
				methodId: `m-${id}`,
				currency: USD,
				amountCents: cents(599),
				minSubtotalCents: null,
			});
			await taxRules.createRate({
				id: `t-${id}`,
				taxClassId: "standard",
				zoneId: id,
				rateBps: bps,
				...(ppm === undefined ? {} : { ratePpm: ppm }),
				appliesToShipping: false,
			});
		}
		await h.seedPhysical({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1500,
			title: "Widget",
			onHand: 10,
		});
		const cartId = await h.cartWith([{ sku: "SKU-1", productId: "p1", qty: 2, kind: "physical" }]);
		return { h, deps: { ...h.createDeps, shippingRules, taxRules }, cartId };
	}

	test("US-CA: 3000 + 599 + 218 = 3817, and the stored order round-trips the snapshot", async () => {
		const { h, deps, cartId } = await setup();
		const res = await createOrderFromCart(
			deps,
			cmd(cartId, { shippingAddress: address("US", "us-ca"), shippingMethodId: "m-z-us-ca" }),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const stored = await h.store.getById(res.order.id);
		expect(stored?.totals).toMatchObject({
			shipping: 599,
			tax: 218,
			total: 3817,
			shippingMethodSnapshot: { zoneId: "z-us-ca", methodId: "m-z-us-ca", matchedRegion: "US-CA" },
		});
		expect(stored?.shippingAddress).toMatchObject({ country: "US", region: "CA" });
	});

	test("US-NY at 8.875% (#425): $1,000.00 is taxed $88.75 — not the $88.80 of 8.88% — and the snapshot keeps the exact rate", async () => {
		const { h, deps } = await setup();
		await h.seedPhysical({
			productId: "p2",
			sku: "SKU-2",
			priceCents: 100_000,
			title: "Espresso machine",
			onHand: 1,
		});
		const cartId = await h.cartWith([{ sku: "SKU-2", productId: "p2", qty: 1, kind: "physical" }]);
		const res = await createOrderFromCart(
			deps,
			cmd(cartId, { shippingAddress: address("US", "NY"), shippingMethodId: "m-z-us-ny" }),
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const stored = await h.store.getById(res.order.id);
		expect(stored?.totals).toMatchObject({ tax: 8875, total: 100_000 + 599 + 8875 });
		expect(readOrderTaxSnapshot(stored?.totals.taxBreakdown)).toMatchObject({
			v: 1,
			calculatorId: "otta.rate-table",
			lines: [{ taxableCents: 100_000, rateBps: 888, ratePpm: 88_750, taxCents: 8875 }],
			shipping: null,
		});
	});

	test.each([
		[{ shippingAddress: address("FR"), shippingMethodId: "m-z-us" }, "SHIPPING_ZONE_NOT_MATCHED"],
		[
			{ shippingAddress: address("US", "CA"), shippingMethodId: "m-z-us" },
			"SHIPPING_METHOD_NOT_IN_ZONE",
		],
		[
			{ shippingAddress: address("US"), shippingMethodId: "m-z-us" },
			"SHIPPING_REGION_CODE_REQUIRED",
		],
		[
			{ shippingAddress: address("US", "XX"), shippingMethodId: "m-z-us" },
			"SHIPPING_REGION_CODE_REQUIRED",
		],
	])("%j → %s, and the cart is still active", async (over, reason) => {
		const { h, deps, cartId } = await setup();
		expect(await createOrderFromCart(deps, cmd(cartId, over))).toEqual({ ok: false, reason });
		expect((await h.cartStore.get(cartId))?.state).toBe("active");
	});
});
