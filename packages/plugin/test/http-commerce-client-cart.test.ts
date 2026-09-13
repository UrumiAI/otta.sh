import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/**
 * HTTP-WIRE RESIDUE. The cart METHOD contract moved to
 * `test/contracts/commerce-client-contract.ts` (INC-A7) and runs here through
 * `commerce-client-contract.http.test.ts`. What stays is what is only
 * expressible on the wire:
 *
 *  - the HTTP STATUS `POST /checkout/quote` answers. The quote itself is a port
 *    method (`quoteCheckout`) and its computed totals and typed refusal reasons
 *    are asserted in the contract, against the client — an earlier revision of
 *    this file wrongly claimed the port had no quote method. What the client
 *    cannot show is the status code the route chose to carry the answer on, so
 *    each of these five cases is the wire half of a contract case and reaches
 *    past the client with a raw fetch for that one assertion.
 *  - a malformed request arriving as a structured `CommerceClientError` with
 *    its HTTP status.
 *
 * Deleted with the transport at INC-D3b.
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

		/** Raw `POST /checkout/quote`, for its STATUS only — the port's
		 *  `quoteCheckout` hands back `{ ok, breakdown }` / `{ ok:false, reason }`
		 *  and never the status code, so the status is reachable only here. This is
		 *  also the exact call the issue-#80 repro made against a live cart. */
		async function quote(cartId: string): Promise<{ status: number }> {
			const res = await globalThis.fetch(`${service.baseUrl}/checkout/quote`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cartId }),
			});
			return { status: res.status };
		}

		test("a storefront cart for a priced+active product QUOTES on the wire with status 200 (issue #80 repro)", async () => {
			const productId = await seedProduct({
				sku: "SKU-QUOTE-OK",
				onHand: 10,
				price: { amount: 1500, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");
			const added = await client.addCartLine(cartId, "SKU-QUOTE-OK", productId, 2, "quote-ok-1");
			if (!added.ok) throw new Error("unreachable");

			// The computed totals are the contract's ("a priced cart QUOTES computed
			// totals…"); the status the route carries them on is only visible here.
			const q = await quote(cartId);
			expect(q.status).toBe(200);
		});

		// The wire half of the contract's "no false positive: an UNPRICED product
		// … is refused PRODUCT_NOT_PRICED at the ADD" case, which asserts the
		// CART_EMPTY reason through `quoteCheckout`. The status is what is left.
		test("an UNPRICED product refused at the ADD leaves nothing for the quote: the wire status is 409", async () => {
			const productId = await seedProduct({ sku: "SKU-UNPRICED-Q", onHand: 5 }); // no price
			const { cartId } = await client.createCart("USD");
			await client.addCartLine(cartId, "SKU-UNPRICED-Q", productId, 1, "unpriced-q-1");

			const q = await quote(cartId);
			expect(q.status).toBe(409);
		});

		// The wire half of the contract's "a legacy add with NO productId (absent)
		// is preserved as null and still quotes PRODUCT_NOT_PRICED" case.
		test("a legacy add with NO productId quotes PRODUCT_NOT_PRICED: the wire status is 409", async () => {
			await seedProduct({
				sku: "SKU-LEGACY-Q",
				onHand: 5,
				price: { amount: 1500, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");
			const added = await client.addCartLine(cartId, "SKU-LEGACY-Q", null, 1, "legacy-q-1");
			if (!added.ok) throw new Error("unreachable");

			const q = await quote(cartId);
			expect(q.status).toBe(409);
		});

		// The wire half of the contract's SKU_MISMATCH security case: the refused
		// add leaves an empty cart, so the attack never reaches a priced checkout.
		test("SECURITY (issue #80 review): a mismatched sku/productId pair never reaches checkout: the wire status is 409", async () => {
			const cheapId = await seedProduct({
				sku: "SKU-CHEAP-Q",
				onHand: 10,
				price: { amount: 100, currency: "USD" },
			});
			await seedProduct({
				sku: "SKU-PRICEY-Q",
				onHand: 10,
				price: { amount: 100000, currency: "USD" },
			});
			const { cartId } = await client.createCart("USD");
			await client.addCartLine(cartId, "SKU-PRICEY-Q", cheapId, 1, "mismatch-q-1");

			const q = await quote(cartId);
			expect(q.status).toBe(409);
		});

		// The wire half of the contract's CURRENCY_MISMATCH quote case.
		test("currency mismatch: a product priced in EUR in a USD cart quotes on the wire with status 409", async () => {
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
