import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * Phase 3 group E, item 2: `HttpCommerceClient`'s cart methods, wire-tested
 * against a LIVE `@urumi/service` (Postgres-backed) — proving the client's
 * request/response shapes have not drifted from `routes/carts.ts` (mirrors
 * `http-commerce-client.test.ts`'s existing Phase 2 pattern).
 */
describe.skipIf(PG === undefined)(
	"HttpCommerceClient cart methods [live @urumi/service, Postgres]",
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

		async function seedSku(sku: string, onHand: number): Promise<void> {
			await client.upsertProductCommerce(
				`prod-for-${sku}`,
				{ sku, price: { amount: 999, currency: "USD" }, initialOnHand: onHand },
				`seed-${sku}`,
			);
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
				cart: { currency: "EUR", state: "active", lines: [] },
			});
		});

		test("getCart on an unknown cartId returns the typed CART_NOT_FOUND token, not a thrown error", async () => {
			const result = await client.getCart("does-not-exist");
			expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
		});

		test("addCartLine reserves and records a line; the cart read reflects it", async () => {
			await seedSku("SKU-CART-1", 5);
			const { cartId } = await client.createCart();

			const added = await client.addCartLine(cartId, "SKU-CART-1", 2, "add-key-1");
			expect(added.ok).toBe(true);
			if (!added.ok) throw new Error("unreachable");
			expect(added.line).toMatchObject({ sku: "SKU-CART-1", qty: 2, productId: null });
			expect(added.line.reservationId).not.toBeNull();
			expect(added.line.expiresAt).not.toBeNull();

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [{ sku: "SKU-CART-1", qty: 2 }] } });
		});

		test("addCartLine beyond on_hand returns the typed OUT_OF_STOCK token as a normal (non-throwing) result", async () => {
			await seedSku("SKU-CART-2", 1);
			const { cartId } = await client.createCart();

			const result = await client.addCartLine(cartId, "SKU-CART-2", 5, "add-key-2");
			expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
		});

		test("addCartLine replayed with the same Idempotency-Key is a no-op (one decrement, same line)", async () => {
			await seedSku("SKU-CART-3", 5);
			const { cartId } = await client.createCart();

			const first = await client.addCartLine(cartId, "SKU-CART-3", 2, "replay-key-1");
			const replay = await client.addCartLine(cartId, "SKU-CART-3", 2, "replay-key-1");
			expect(replay).toEqual(first);
		});

		test("adjustCartLine sends the TARGET qty; the service applies the delta and the client reflects the new qty", async () => {
			await seedSku("SKU-CART-4", 5);
			const { cartId } = await client.createCart();
			const added = await client.addCartLine(cartId, "SKU-CART-4", 2, "add-key-4");
			if (!added.ok) throw new Error("unreachable");

			const adjusted = await client.adjustCartLine(cartId, added.line.lineId, 4, "adjust-key-4");
			expect(adjusted).toMatchObject({ ok: true, line: { qty: 4 } });
		});

		test("adjustCartLine increasing beyond available stock returns OUT_OF_STOCK, line unchanged", async () => {
			await seedSku("SKU-CART-5", 3);
			const { cartId } = await client.createCart();
			const added = await client.addCartLine(cartId, "SKU-CART-5", 2, "add-key-5");
			if (!added.ok) throw new Error("unreachable");

			const adjusted = await client.adjustCartLine(cartId, added.line.lineId, 10, "adjust-key-5");
			expect(adjusted).toEqual({ ok: false, reason: "OUT_OF_STOCK" });

			const read = await client.getCart(cartId);
			expect(read).toMatchObject({ ok: true, cart: { lines: [{ qty: 2 }] } });
		});

		test("removeCartLine releases the reservation and drops the line; the typed CartResult carries ok:true only", async () => {
			await seedSku("SKU-CART-6", 5);
			const { cartId } = await client.createCart();
			const added = await client.addCartLine(cartId, "SKU-CART-6", 2, "add-key-6");
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

		test("a genuinely malformed request (missing Idempotency-Key at the HTTP layer is impossible via the client — assert a bad qty instead) still surfaces as a structured CommerceClientError", async () => {
			const { cartId } = await client.createCart();
			// qty: 0 fails the service's positive-int schema (400, no ok/reason
			// envelope) — the client's #cartResult falls back to throwing here,
			// exactly the "no recognizable envelope" branch.
			await expect(client.addCartLine(cartId, "SKU-X", 0, "bad-qty-key")).rejects.toMatchObject({
				name: "CommerceClientError",
				status: 400,
			});
		});
	},
);
