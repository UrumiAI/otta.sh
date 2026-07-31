import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * Phase 3 group E, item 2: `HttpCommerceClient`'s cart methods, wire-tested
 * against a LIVE `@otta-sh/service` (Postgres-backed) — proving the client's
 * request/response shapes have not drifted from `routes/carts.ts` (mirrors
 * `http-commerce-client.test.ts`'s existing Phase 2 pattern).
 */
describe.skipIf(PG === undefined)(
	"HttpCommerceClient cart methods [live @otta-sh/service, Postgres]",
	() => {
		let service: LiveService;
		let client: HttpCommerceClient;

		beforeAll(async () => {
			service = await startLiveService();
			client = new HttpCommerceClient({ fetch: globalThis.fetch, baseUrl: service.baseUrl });
		});
		afterAll(async () => {
			await service.stop();
		});

		/** Seed a `product_commerce` row keyed by its CMS content id (the productId
		 *  join key), optionally priced. Returns the productId so a cart add can
		 *  thread it, exactly as the storefront now does (issue #80). */
		async function seedProduct(opts: {
			sku: string;
			onHand: number;
			price?: { amount: number; currency: string };
		}): Promise<string> {
			const productId = `prod-for-${opts.sku}`;
			await client.upsertProductCommerce(
				productId,
				{
					sku: opts.sku,
					...(opts.price !== undefined ? { price: opts.price } : {}),
					initialOnHand: opts.onHand,
				},
				`seed-${opts.sku}`,
			);
			return productId;
		}

		/** Raw `POST /checkout/quote` — the client has no quote method (a page-layer
		 *  concern), so hit the wire directly. This is the exact call the issue-#80
		 *  repro made against a live storefront cart. */
		async function quote(
			cartId: string,
		): Promise<{ status: number; body: Record<string, unknown> }> {
			const res = await globalThis.fetch(`${service.baseUrl}/checkout/quote`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cartId }),
			});
			return { status: res.status, body: (await res.json()) as Record<string, unknown> };
		}

		test("createCart mints a cartId with no ok-envelope (a bare success shape)", async () => {
			const { cartId } = await client.createCart();
			expect(typeof cartId).toBe("string");
			expect(cartId.length).toBeGreaterThan(0);
		});

		test("createCart accepts an explicit currency, defaulting server-side otherwise", async () => {
			const { cartId } = await client.createCart("EUR");
			const result = await client.getCart(cartId);
			expect(result).toMatchObject({
				ok: true,
				// `orderId: null` over the live wire (#132): a fresh cart names no
				// order. (`getCart` also normalizes it, but here the service really
				// does emit it.)
				cart: { currency: "EUR", state: "active", orderId: null, lines: [] },
			});
		});

		test("getCart on an unknown cartId returns the typed CART_NOT_FOUND token, not a thrown error", async () => {
			const result = await client.getCart("does-not-exist");
			expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
		});

		// ── issue #80: the storefront now threads productId end-to-end ─────────
		test("addCartLine threads productId; the persisted line carries it (non-null) and the cart read reflects it", async () => {
			const productId = await seedProduct({
				sku: "SKU-PID-1",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const { cartId } = await client.createCart();

			const added = await client.addCartLine(cartId, "SKU-PID-1", productId, 2, "pid-add-1");
			expect(added.ok).toBe(true);
			if (!added.ok) throw new Error("unreachable");
			expect(added.line).toMatchObject({ sku: "SKU-PID-1", qty: 2, productId });
			expect(added.line.productId).not.toBeNull();

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({
				ok: true,
				cart: { lines: [{ sku: "SKU-PID-1", qty: 2, productId }] },
			});
		});

		test("a storefront cart for a priced+active product QUOTES (computed totals) — NOT 409 PRODUCT_NOT_PRICED (issue #80 repro)", async () => {
			const productId = await seedProduct({
				sku: "SKU-QUOTE-OK",
				onHand: 10,
				price: { amount: 1500, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");
			const added = await client.addCartLine(cartId, "SKU-QUOTE-OK", productId, 2, "quote-ok-1");
			if (!added.ok) throw new Error("unreachable");

			const q = await quote(cartId);
			expect(q.status).toBe(200);
			expect(q.body.ok).toBe(true);
			const b = q.body.breakdown as Record<string, unknown>;
			// 2 × $15.00, no shipping/tax/coupon selected ⇒ subtotal == total.
			expect(b.subtotalCents).toBe(3000);
			expect(b.totalCents).toBe(3000);
		});

		test("no false positive: an UNPRICED product (row exists, no price) still QUOTES 409 PRODUCT_NOT_PRICED even with productId threaded", async () => {
			const productId = await seedProduct({ sku: "SKU-UNPRICED", onHand: 5 }); // no price
			const { cartId } = await client.createCart("USD");
			const added = await client.addCartLine(cartId, "SKU-UNPRICED", productId, 1, "unpriced-1");
			if (!added.ok) throw new Error("unreachable");
			expect(added.line.productId).toBe(productId); // productId DID thread…

			const q = await quote(cartId); // …but there is genuinely no price
			expect(q.status).toBe(409);
			expect(q.body.reason).toBe("PRODUCT_NOT_PRICED");
		});

		test("a legacy add with NO productId (absent) is preserved as null and still quotes PRODUCT_NOT_PRICED", async () => {
			await seedProduct({
				sku: "SKU-LEGACY",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");
			const added = await client.addCartLine(cartId, "SKU-LEGACY", null, 1, "legacy-1");
			if (!added.ok) throw new Error("unreachable");
			expect(added.line.productId).toBeNull(); // absent ⇒ null round-trips

			const q = await quote(cartId);
			expect(q.status).toBe(409);
			expect(q.body.reason).toBe("PRODUCT_NOT_PRICED");
		});

		test("SECURITY (issue #80 review): a mismatched sku/productId pair (sku of product B, productId of product A) is rejected SKU_MISMATCH and never reaches checkout", async () => {
			const cheapId = await seedProduct({
				sku: "SKU-CHEAP",
				onHand: 10,
				price: { amount: 100, currency: "USD" },
			});
			await seedProduct({
				sku: "SKU-PRICEY",
				onHand: 10,
				price: { amount: 100000, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");

			// Attack: pair the cheap product's productId with the pricey product's sku.
			const added = await client.addCartLine(cartId, "SKU-PRICEY", cheapId, 1, "mismatch-1");
			expect(added).toEqual({ ok: false, reason: "SKU_MISMATCH" });

			// Nothing was persisted ⇒ the cart is empty ⇒ no priced checkout.
			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [] } });
			const q = await quote(cartId);
			expect(q.status).toBe(409);
			expect(q.body.reason).toBe("CART_EMPTY");
		});

		test("currency mismatch: a product priced in EUR in a USD cart quotes 409 CURRENCY_MISMATCH (not PRODUCT_NOT_PRICED)", async () => {
			const productId = await seedProduct({
				sku: "SKU-EUR",
				onHand: 5,
				price: { amount: 1500, currency: "EUR" },
			});
			const { cartId } = await client.createCart("USD");
			const added = await client.addCartLine(cartId, "SKU-EUR", productId, 1, "eur-1");
			if (!added.ok) throw new Error("unreachable");

			const q = await quote(cartId);
			expect(q.status).toBe(409);
			expect(q.body.reason).toBe("CURRENCY_MISMATCH");
		});

		test("idempotency: replaying the add with the same key threads productId once and does NOT duplicate the line", async () => {
			const productId = await seedProduct({
				sku: "SKU-PID-IDEM",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");

			const first = await client.addCartLine(cartId, "SKU-PID-IDEM", productId, 2, "pid-replay-1");
			const replay = await client.addCartLine(cartId, "SKU-PID-IDEM", productId, 2, "pid-replay-1");
			expect(replay).toEqual(first);

			const read = await client.getCart(cartId);
			expect(read.ok).toBe(true);
			if (!read.ok) throw new Error("unreachable");
			expect(read.cart.lines).toHaveLength(1);
			expect(read.cart.lines[0]).toMatchObject({ productId, qty: 2 });
		});

		test("addCartLine beyond on_hand returns the typed OUT_OF_STOCK token as a normal (non-throwing) result", async () => {
			const productId = await seedProduct({ sku: "SKU-CART-2", onHand: 1 });
			const { cartId } = await client.createCart();

			const result = await client.addCartLine(cartId, "SKU-CART-2", productId, 5, "add-key-2");
			expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		});

		test("adjustCartLine sends the TARGET qty; the service applies the delta and the client reflects the new qty", async () => {
			const productId = await seedProduct({ sku: "SKU-CART-4", onHand: 5 });
			const { cartId } = await client.createCart();
			const added = await client.addCartLine(cartId, "SKU-CART-4", productId, 2, "add-key-4");
			if (!added.ok) throw new Error("unreachable");

			const adjusted = await client.adjustCartLine(cartId, added.line.lineId, 4, "adjust-key-4");
			expect(adjusted).toMatchObject({ ok: true, line: { qty: 4 } });
		});

		test("adjustCartLine increasing beyond available stock returns OUT_OF_STOCK, line unchanged", async () => {
			const productId = await seedProduct({ sku: "SKU-CART-5", onHand: 3 });
			const { cartId } = await client.createCart();
			const added = await client.addCartLine(cartId, "SKU-CART-5", productId, 2, "add-key-5");
			if (!added.ok) throw new Error("unreachable");

			const adjusted = await client.adjustCartLine(cartId, added.line.lineId, 10, "adjust-key-5");
			expect(adjusted).toEqual({ ok: false, reason: "OUT_OF_STOCK" });

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [{ qty: 2 }] } });
		});

		test("removeCartLine releases the reservation and drops the line; the typed CartResult carries ok:true only", async () => {
			const productId = await seedProduct({ sku: "SKU-CART-6", onHand: 5 });
			const { cartId } = await client.createCart();
			const added = await client.addCartLine(cartId, "SKU-CART-6", productId, 2, "add-key-6");
			if (!added.ok) throw new Error("unreachable");

			const removed = await client.removeCartLine(cartId, added.line.lineId, "remove-key-6");
			expect(removed).toEqual({ ok: true });

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [] } });
		});

		test("a mutation against an unknown lineId returns the typed LINE_NOT_FOUND token (a 404 normalized, not thrown)", async () => {
			const { cartId } = await client.createCart();
			const result = await client.adjustCartLine(cartId, "does-not-exist", 1, "adjust-key-missing");
			expect(result).toEqual({ ok: false, reason: "LINE_NOT_FOUND" });
		});

		test("a genuinely malformed request (a bad qty) still surfaces as a structured CommerceClientError", async () => {
			const { cartId } = await client.createCart();
			// qty: 0 fails the service's positive-int schema (400, no ok/reason
			// envelope) — the client's #cartResult falls back to throwing here,
			// exactly the "no recognizable envelope" branch.
			await expect(
				client.addCartLine(cartId, "SKU-X", null, 0, "bad-qty-key"),
			).rejects.toMatchObject({
				name: "CommerceClientError",
				status: 400,
			});
		});
	},
);
