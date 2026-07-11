import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "./helpers/start-test-server.js";

// Phase 6 HTTP contract (§6 DoD): /checkout/quote against a LIVE server backed by
// Postgres. Proves the wire format matches the port and that the preview does NOT
// redeem the coupon (read-only, safe to repeat).

const PG = process.env.PG_CONNECTION_STRING;

async function json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(PG === undefined)("checkout quote HTTP contract", () => {
	let server: TestServer;
	let token: string;
	beforeEach(async () => {
		server = await startTestServer();
		token = server.internalToken as string;
	});
	afterEach(async () => {
		await server.stop();
	});

	async function admin(path: string, body: unknown): Promise<Response> {
		return fetch(`${server.baseUrl}/admin${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "X-Internal-Token": token },
			body: JSON.stringify(body),
		});
	}

	async function seedRulesAndCart(): Promise<string> {
		// Product $10 physical, stock 10.
		await server.seedProduct({
			productId: "p1",
			sku: "SKU-1",
			priceCents: 1000,
			title: "Widget",
			kind: "physical",
			onHand: 10,
		});
		// Shipping: US zone, flat $5.99.
		await admin("/shipping/zones", { id: "z-us", name: "US" });
		await admin("/shipping/zones/z-us/methods", { id: "m-flat", name: "Flat", type: "flat_rate" });
		await admin("/shipping/methods/m-flat/rates", { currency: "USD", amountCents: 599 });
		// Tax: standard 10% in z-us.
		await admin("/tax/classes", { id: "standard", name: "Standard" });
		await admin("/tax/rates", { id: "t1", taxClassId: "standard", zoneId: "z-us", rateBps: 1000 });
		// Coupon: $5 fixed off.
		await admin("/coupons", {
			id: "cpn",
			code: "SAVE5",
			type: "fixed_amount",
			amountCents: 500,
			currency: "USD",
			maxUses: 100,
		});

		// Cart with 2 units.
		const createCart = await fetch(`${server.baseUrl}/carts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ currency: "USD" }),
		});
		const cartId = (await json(createCart)).cartId as string;
		await fetch(`${server.baseUrl}/carts/${cartId}/lines`, {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "add-1" },
			body: JSON.stringify({ sku: "SKU-1", qty: 2, productId: "p1" }),
		});
		return cartId;
	}

	test("quote computes coupon/shipping/tax breakdown and matches computeTotals", async () => {
		const cartId = await seedRulesAndCart();
		const res = await fetch(`${server.baseUrl}/checkout/quote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cartId,
				shippingZoneId: "z-us",
				shippingMethodId: "m-flat",
				couponCode: "SAVE5",
			}),
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.ok).toBe(true);
		const b = body.breakdown as Record<string, unknown>;
		// subtotal 2000; -500 coupon ⇒ 1500 discounted; +599 shipping; +150 tax (1500×10%).
		expect(b.subtotalCents).toBe(2000);
		expect(b.discountCents).toBe(500);
		expect(b.shippingCents).toBe(599);
		expect(b.taxCents).toBe(150);
		expect(b.totalCents).toBe(1500 + 599 + 150);
		expect(b.appliedCouponCode).toBe("SAVE5");
	});

	test("quote is read-only: repeated calls do NOT redeem the coupon (uses_count stays 0)", async () => {
		const cartId = await seedRulesAndCart();
		const q = () =>
			fetch(`${server.baseUrl}/checkout/quote`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cartId, shippingMethodId: "m-flat", couponCode: "SAVE5" }),
			});
		await q();
		await q();
		await q();
		// Read the coupon back — no redemption happened.
		const coupon = await json(
			await fetch(`${server.baseUrl}/admin/coupons/SAVE5`, {
				headers: { "X-Internal-Token": token },
			}),
		);
		expect((coupon.coupon as Record<string, unknown>).usesCount).toBe(0);
	});

	test("unknown coupon code ⇒ 404 COUPON_NOT_FOUND", async () => {
		const cartId = await seedRulesAndCart();
		const res = await fetch(`${server.baseUrl}/checkout/quote`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cartId, shippingMethodId: "m-flat", couponCode: "NOPE" }),
		});
		expect(res.status).toBe(404);
		expect((await json(res)).reason).toBe("COUPON_NOT_FOUND");
	});
});
