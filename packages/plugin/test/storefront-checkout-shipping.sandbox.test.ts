/**
 * Issue #305 — the storefront checkout prices shipping, tax and coupons, with the
 * shipping zone DERIVED from the buyer's address, server-side. Under the REAL
 * workerd sandbox (DEVELOPMENT.md §5), against the REAL document store.
 *
 * A FILE OF ITS OWN, on purpose. Shipping zones are store-wide config, not
 * per-case ids: the moment a zone exists, every physical checkout in the same
 * store needs an address in a zone. `storefront-checkout.sandbox.test.ts` pins
 * the "no zones configured" behaviour (today's), so its store must stay
 * zone-free — and the document store is one per test file.
 *
 * What is arranged here, through the real stores on the bridge:
 *  - US (whole country): Standard $5.99 flat, 10% tax that also taxes shipping;
 *  - US-West (US-CA, US-OR): West $9.99 flat, 5% tax, shipping untaxed;
 *  - NoTax (CH): a $1.00 method and a 0% rate — the zone a spoofer would want;
 *  - coupons: SAVE5 ($5 off), OLD5 (expired).
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashCouponStore,
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashProductCommerceStore,
	EmdashShippingRulesStore,
	EmdashTaxRulesStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { startStripeApiStub, type StripeApiStub } from "./helpers/stripe-api-stub.js";
import {
	loadPluginInSandbox,
	productionAllowedHosts,
	type SandboxHandle,
} from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const NS = "cs";
const USD = currency("USD");
const BUYER_REF = "buyer@example.com";

let storage: StorageAccess;
let boot: SandboxHandle;
let stripe: StripeApiStub;
let orderStore: EmdashOrderStore;
let seq = 0;

function inventoryStore(): EmdashInventoryStore {
	return new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
}

async function seedProduct(id: string, sku: string, amount: number, kind: "physical" | "digital") {
	const commerce = new EmdashProductCommerceStore({ storage, clock: systemClock });
	await commerce.upsert(
		{
			productId: toProductId(id),
			sku: toSku(sku),
			price: { amount: cents(amount), currency: USD },
			title: `Product ${id}`,
			productKind: kind,
		},
		idempotencyKey(`seed-${id}`),
	);
	await inventoryStore().seedOnHand(toSku(sku), 500);
	await commerce.activate(toProductId(id), idempotencyKey(`pub-${id}`), "2026-01-01T00:00:00.000Z");
}

async function seedRules(): Promise<void> {
	const shipping = new EmdashShippingRulesStore({ storage, clock: systemClock });
	const tax = new EmdashTaxRulesStore({ storage, clock: systemClock });
	const zones = [
		{ id: "z-us", name: "United States", regions: ["US"], method: "m-us", amount: 599 },
		{ id: "z-west", name: "US West", regions: ["US-CA", "US-OR"], method: "m-west", amount: 999 },
		{ id: "z-notax", name: "Switzerland", regions: ["CH"], method: "m-notax", amount: 100 },
	];
	for (const z of zones) {
		await shipping.createZone({ id: z.id, name: z.name, regions: z.regions });
		await shipping.createMethod({ id: z.method, zoneId: z.id, name: z.name, type: "flat_rate" });
		await shipping.createRate({
			methodId: z.method,
			currency: USD,
			amountCents: cents(z.amount),
			minSubtotalCents: null,
		});
	}
	await tax.createRate({
		id: "t-us",
		taxClassId: "standard",
		zoneId: "z-us",
		rateBps: 1000,
		appliesToShipping: true,
	});
	await tax.createRate({
		id: "t-west",
		taxClassId: "standard",
		zoneId: "z-west",
		rateBps: 500,
		appliesToShipping: false,
	});
	await tax.createRate({
		id: "t-notax",
		taxClassId: "standard",
		zoneId: "z-notax",
		rateBps: 0,
		appliesToShipping: false,
	});
	const coupons = new EmdashCouponStore({ storage, idGen: uuidIdGen, clock: systemClock });
	for (const [id, code, expiresAt] of [
		["c-save5", "SAVE5", null],
		["c-old5", "OLD5", "2000-01-01T00:00:00.000Z"],
	] as const) {
		await coupons.create({
			id,
			code,
			type: "fixed_amount",
			amountCents: cents(500),
			rateBps: null,
			capCents: null,
			currency: USD,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
	}
}

function resultOf(outcome: unknown): Record<string, unknown> {
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

async function cartOf(lines: ReadonlyArray<[sku: string, productId: string, qty: number]>) {
	const created = resultOf(await boot.invokeRoute("storefront/cart/create", {}));
	const cartId = created["cartId"] as string;
	for (const [sku, productId, qty] of lines) {
		seq += 1;
		const added = resultOf(
			await boot.invokeRoute("storefront/cart/lines/add", {
				cartId,
				sku,
				productId,
				qty,
				idempotencyKey: `add-${NS}-${String(seq)}`,
			}),
		);
		expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
	}
	return cartId;
}

/** 2 × $15.00 of a physical product — a $30.00 subtotal. */
async function physicalCart(): Promise<string> {
	return cartOf([[`SKU-${NS}-PHYS`, `prod-${NS}-phys`, 2]]);
}

async function summary(input: Record<string, unknown>) {
	return resultOf(await boot.invokeRoute("storefront/checkout/summary", input));
}

async function place(cartId: string, extra: Record<string, unknown>) {
	return resultOf(
		await boot.invokeRoute("storefront/checkout/place", {
			cartId,
			buyerRef: BUYER_REF,
			idempotencyKey: `checkout:${cartId}`,
			...extra,
		}),
	);
}

function address(country: string, region?: string) {
	return {
		name: "A Buyer",
		line1: "1 Test St",
		city: "Testville",
		postalCode: "12345",
		country,
		...(region !== undefined ? { region } : {}),
	};
}

type Totals = Record<string, { money: { amount: number } | null; label: string }>;

function amounts(result: Record<string, unknown>) {
	const t = result["totals"] as Totals;
	return {
		subtotal: t["subtotal"]!.money?.amount ?? null,
		discount: t["discount"]!.money?.amount ?? null,
		shipping: t["shipping"]!.money?.amount ?? null,
		tax: t["tax"]!.money?.amount ?? null,
		total: t["total"]!.money?.amount ?? null,
	};
}

beforeAll(async () => {
	const bridge = await storageBridge();
	storage = bridge.storage;
	stripe = await startStripeApiStub({ forwardTo: [bridge.baseUrl] });
	boot = await loadPluginInSandbox({
		allowedHosts: productionAllowedHosts(),
		storage: true,
		globalOutbound: stripe.address,
	});
	for (const [action, field, value] of [
		["save-stripe-secret-key", "stripeSecretKey", "sk_test_shipping"],
		["save-stripe-webhook-secret", "stripeWebhookSecret", "whsec_shipping"],
	] as const) {
		expect(
			await boot.invokeRoute("admin", {
				type: "form_submit",
				action_id: action,
				values: { [field]: value },
			}),
		).toHaveProperty("result");
	}
	orderStore = new EmdashOrderStore({
		storage,
		inventory: inventoryStore(),
		idGen: uuidIdGen,
		clock: systemClock,
	});
	await seedProduct(`prod-${NS}-phys`, `SKU-${NS}-PHYS`, 1500, "physical");
	await seedProduct(`prod-${NS}-dig`, `SKU-${NS}-DIG`, 1500, "digital");
	await seedRules();
}, 300_000);

afterAll(async () => {
	await boot?.close();
	await stripe?.close();
});

beforeEach(() => {
	stripe.reset();
});

afterEach(() => {
	expect(stripe.refused).toEqual([]);
});

describe("storefront/checkout/summary — the zone derived from the address (workerd sandbox)", () => {
	test("an address in a configured zone offers that zone's methods, priced, and names the zone", async () => {
		const result = await summary({
			cartId: await physicalCart(),
			shippingAddress: { country: "US" },
		});

		expect(result["ok"]).toBe(true);
		expect(result["shipping"]).toEqual({
			status: "resolved",
			zone: { id: "z-us", name: "United States" },
			methods: [
				{
					id: "m-us",
					name: "United States",
					type: "flat_rate",
					price: { amount: 599, currency: "USD", formatted: "$5.99" },
				},
			],
			selectedMethodId: null,
			selectionError: null,
		});
		// No method chosen yet: shipping honestly not calculated, tax already priced.
		expect(amounts(result)).toMatchObject({ shipping: null, tax: 300, total: 3300 });
	});

	test("choosing the method puts shipping AND tax on shipping into the totals — no more hard-coded 'not selected'", async () => {
		const result = await summary({
			cartId: await physicalCart(),
			shippingAddress: address("US", "NY"),
			shippingMethodId: "m-us",
		});

		expect(amounts(result)).toEqual({
			subtotal: 3000,
			discount: null,
			shipping: 599,
			tax: 360, // 10% of 3000 + 10% of 599 (59.9 → 60)
			total: 3959,
		});
		expect(
			(result["totals"] as { totalExcludesUncalculated: boolean }).totalExcludesUncalculated,
		).toBe(false);
	});

	test("an address no zone lists is the typed NO_ZONE_FOR_ADDRESS, never a $0 shipping line", async () => {
		const result = await summary({
			cartId: await physicalCart(),
			shippingAddress: { country: "JP" },
		});

		expect(result["shipping"]).toEqual({ status: "unavailable", reason: "NO_ZONE_FOR_ADDRESS" });
		expect(amounts(result)).toMatchObject({ shipping: null, tax: null });
	});

	test("the tax zone cannot be spoofed: a sent zone id is ignored and another zone's method is not available", async () => {
		const result = await summary({
			cartId: await physicalCart(),
			shippingAddress: address("US", "CA"),
			shippingZoneId: "z-notax",
			shippingMethodId: "m-notax",
		});

		expect(result["shipping"]).toMatchObject({
			status: "resolved",
			zone: { id: "z-west" },
			selectedMethodId: null,
			selectionError: "SHIPPING_METHOD_NOT_AVAILABLE",
		});
		// Taxed at US-West's 5%, not the spoofed zone's 0%.
		expect(amounts(result)).toMatchObject({ shipping: null, tax: 150 });
	});

	test("a valid coupon is applied; an unknown or expired one is reported with its reason and not applied", async () => {
		const cartId = await physicalCart();
		const base = { cartId, shippingAddress: { country: "US" }, shippingMethodId: "m-us" };

		const ok = await summary({ ...base, couponCode: "SAVE5" });
		expect(ok["coupon"]).toEqual({
			status: "applied",
			code: "SAVE5",
			discount: { amount: 500, currency: "USD", formatted: "$5.00" },
		});
		// 3000 − 500 = 2500; + 599; tax 10% of 2500 (250) + 60.
		expect(amounts(ok)).toMatchObject({ discount: 500, total: 2500 + 599 + 250 + 60 });

		for (const [code, reason] of [
			["NOPE", "COUPON_NOT_FOUND"],
			["OLD5", "COUPON_NOT_ACTIVE"],
		] as const) {
			const bad = await summary({ ...base, couponCode: code });
			expect(bad["ok"]).toBe(true);
			expect(bad["coupon"]).toEqual({ status: "invalid", code, reason });
			expect(amounts(bad)).toMatchObject({ discount: null, total: 3959 });
		}
	});

	test("a digital-only cart needs no address and no zone", async () => {
		const result = await summary({
			cartId: await cartOf([[`SKU-${NS}-DIG`, `prod-${NS}-dig`, 1]]),
		});

		expect(result["shipping"]).toEqual({ status: "not_required" });
		expect(amounts(result)).toMatchObject({ total: 1500 });
	});
});

describe("storefront/checkout/place — derives the zone itself (workerd sandbox, Stripe stubbed)", () => {
	test("the created order's totals EQUAL the summary's for the same address, method and coupon", async () => {
		const cartId = await physicalCart();
		const inputs = {
			shippingAddress: address("US", "CA"),
			shippingMethodId: "m-west",
			couponCode: "SAVE5",
		};
		const preview = await summary({ cartId, ...inputs });

		const placed = await place(cartId, inputs);

		expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true, state: "pending" });
		const order = await orderStore.getById(toOrderId(placed["orderId"] as string));
		expect(order).not.toBeNull();
		const t = order!.totals;
		expect({
			subtotal: t.subtotal,
			discount: t.discount,
			shipping: t.shipping,
			tax: t.tax,
			total: t.total,
		}).toEqual(amounts(preview));
		// 2500 + 999 + 5% of 2500 (125); US-West does not tax shipping.
		expect(t.total).toBe(2500 + 999 + 125);
		expect(t.shippingMethodSnapshot).toEqual({ zoneId: "z-west", methodId: "m-west" });
		expect(t.appliedCouponCode).toBe("SAVE5");
		// The PaymentIntent is for exactly that total.
		expect(stripe.requests[0]!.form.get("amount")).toBe(String(t.total));
		expect((placed["total"] as { amount: number }).amount).toBe(t.total);
	});

	test("an address no zone lists is refused SHIPPING_UNAVAILABLE_FOR_ADDRESS before any order exists", async () => {
		const cartId = await physicalCart();
		const result = await place(cartId, {
			shippingAddress: address("JP"),
			shippingMethodId: "m-us",
		});

		expect(result).toEqual({ ok: false, reason: "SHIPPING_UNAVAILABLE_FOR_ADDRESS" });
		expect(stripe.requests).toHaveLength(0);
	});

	test("a physical cart with no address, or no method chosen, is refused with its own reason", async () => {
		expect(await place(await physicalCart(), {})).toEqual({
			ok: false,
			reason: "SHIPPING_ADDRESS_REQUIRED",
		});
		expect(await place(await physicalCart(), { shippingAddress: address("US") })).toEqual({
			ok: false,
			reason: "SHIPPING_METHOD_REQUIRED",
		});
		expect(stripe.requests).toHaveLength(0);
	});

	test("the zone cannot be spoofed at place: a sent zone is ignored, another zone's method is refused", async () => {
		const result = await place(await physicalCart(), {
			shippingAddress: address("US", "CA"),
			shippingZoneId: "z-notax",
			shippingMethodId: "m-notax",
		});

		expect(result).toEqual({ ok: false, reason: "SHIPPING_METHOD_NOT_AVAILABLE" });
		expect(stripe.requests).toHaveLength(0);
	});

	test("an expired coupon at place is the typed COUPON_NOT_ACTIVE, and nothing is charged", async () => {
		const result = await place(await physicalCart(), {
			shippingAddress: address("US"),
			shippingMethodId: "m-us",
			couponCode: "OLD5",
		});

		expect(result).toEqual({ ok: false, reason: "COUPON_NOT_ACTIVE" });
		expect(stripe.requests).toHaveLength(0);
	});

	test("a digital-only cart still places with no address and no zone", async () => {
		const cartId = await cartOf([[`SKU-${NS}-DIG`, `prod-${NS}-dig`, 1]]);

		const result = await place(cartId, {});

		expect(result).toMatchObject({ ok: true, state: "pending" });
		const order = await orderStore.getById(toOrderId(result["orderId"] as string));
		expect(order!.totals).toMatchObject({ shipping: 0, tax: 0, total: 1500 });
	});
});
