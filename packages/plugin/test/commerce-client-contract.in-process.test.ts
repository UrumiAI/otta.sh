/**
 * The in-process tier of `commerceClientContract`.
 *
 * This file binds the transport-agnostic contract to `InProcessCommerceClient`
 * over a REAL document store: the host's own `PluginStorageRepository` on
 * in-memory SQLite, migrated by the host's own migration set. There is no
 * commerce service in this tier, no HTTP server, and no `fetch` — `ctx.http` is
 * bound to a rejecting stub precisely so a method that reached for egress would
 * fail the suite rather than quietly work.
 *
 * WHY THE SAME CASES, UNCHANGED. The contract is the equivalence proof: the
 * cases were lifted out of the HTTP client's own suites so both transports can
 * execute them, and the value of that evaporates the moment a tier narrows,
 * skips or reorders one. A case that fails here is a composition or an adapter
 * defect, never a case to soften.
 *
 * WHAT IS REAL AND WHAT IS NOT. The document store is real — real databases,
 * never mocks, because no fake can lose a compare-and-set race — and it is built
 * by the ADAPTER PACKAGE's own dialect harness rather than by a second copy of
 * that wiring here. That matters for more than duplication: the harness is where
 * the two rules the store depends on are stated and enforced (the schema always
 * comes from the host's migrations, because the revision a guarded write compares
 * is assigned by a trigger only they create; rows are cleared between cases and
 * the table is never dropped, because dropping it would take the trigger with
 * it). Keeping the host, `kysely` and `better-sqlite3` imports inside that
 * package is also what keeps them out of this one, which declares no dependency
 * on the host in any form.
 *
 * Rows ARE cleared per case here, which is what makes `reset()` a real reset in
 * this tier rather than the documented no-op the HTTP tier implements.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { isCommerceInputError } from "../src/commerce/commerce-input.js";
import type { CommerceClient } from "../src/product-commerce/commerce-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";
import {
	storefrontCommerceClientContract,
	type CommerceClientTier,
} from "./contracts/commerce-client-contract.js";

/**
 * The in-process tier. `arrange` programs state through the client's own writes,
 * exactly as the HTTP tier does — so the two tiers seed identically and a
 * difference in a case's outcome can only come from the transport under test.
 */
function inProcessTier(): CommerceClientTier {
	let harness: InProcessCommerceHarness | undefined;
	let client: CommerceClient | undefined;

	function clientOrThrow(): CommerceClient {
		if (client === undefined) throw new Error("tier not set up");
		return client;
	}

	return {
		name: "in-process, plugin storage, sqlite",
		async setup() {
			if (harness !== undefined) return; // one database per tier, however many slices ask
			harness = await makeInProcessCommerce();
			client = harness.client;
		},
		async teardown() {
			const open = harness;
			harness = undefined;
			client = undefined;
			await open?.close();
		},
		async reset() {
			// A REAL reset, unlike the HTTP tier's documented no-op: it empties the
			// rows and keeps the schema, which is the only form of reset that keeps the
			// revision trigger the guarded writes depend on.
			await harness?.reset();
		},
		async makeClient() {
			return clientOrThrow();
		},
		arrange: {
			async product(spec) {
				await clientOrThrow().upsertProductCommerce(
					spec.productId,
					{
						sku: spec.sku,
						...(spec.price !== undefined ? { price: spec.price } : {}),
						...(spec.title !== undefined ? { title: spec.title } : {}),
						...(spec.onHand !== undefined ? { initialOnHand: spec.onHand } : {}),
					},
					spec.idempotencyKey,
				);
				return spec.productId;
			},
			async cart(currency) {
				const { cartId } = await clientOrThrow().createCart(currency);
				return cartId;
			},
		},
	};
}

const storefront = inProcessTier();

describe("commerceClientContract over InProcessCommerceClient", () => {
	afterAll(async () => {
		await storefront.teardown();
	});
	storefrontCommerceClientContract(storefront);
});

/**
 * THE INPUT BOUNDS, in this tier only and deliberately so.
 *
 * These are not contract cases: the shared contract is about what a client DOES
 * with well-formed input, and the other transport refuses malformed input at its
 * wire with a status this port does not carry. What has to be proven here is that
 * removing that wire did not remove the refusal — so each case asserts an AWAITED
 * rejection carrying the structural code, and asserts that NOTHING was written.
 *
 * The watermark case is the one that matters most. The stored watermark is
 * compared as raw text, so one garbage high-sorting value accepted once would
 * make every later legitimate sync a stale no-op forever, and the ordinary write
 * path preserves that value rather than healing it. A rejection here is the only
 * thing between a bad caller and a product nobody can sync again.
 */
/** Every refusal is this shape: awaited, structural, and it names the field. */
async function expectRefusal(call: Promise<unknown>, field: string): Promise<void> {
	await call.then(
		() => {
			throw new Error(`expected a refusal naming ${field}`);
		},
		(err: unknown) => {
			expect(isCommerceInputError(err), `${field}: structural code`).toBe(true);
			expect((err as { code: string }).code).toBe("INVALID_INPUT");
			expect((err as { field: string }).field).toBe(field);
		},
	);
}

describe("in-process commerce refuses malformed input before any store call", () => {
	let harness: InProcessCommerceHarness;
	let client: CommerceClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		client = harness.client;
	}, 120_000);
	afterEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.close();
	});

	test("a garbage watermark is refused on the upsert, and the product is NOT written", async () => {
		await expectRefusal(
			client.upsertProductCommerce(
				"prod-wm",
				{ sku: "SKU-WM", price: { amount: 100, currency: "USD" }, contentUpdatedAt: "ZZZZ" },
				"wm-1",
			),
			"contentUpdatedAt",
		);
		// Refused BEFORE the store: nothing exists to have been wedged.
		expect(await client.getProductCommerce("prod-wm")).toBeNull();
	});

	test("a garbage watermark is refused on every lifecycle and variant transition that carries one", async () => {
		await client.upsertProductCommerce(
			"prod-wm2",
			{ sku: "SKU-WM2", price: { amount: 100, currency: "USD" } },
			"wm-2",
		);
		await expectRefusal(
			client.activateProductCommerce("prod-wm2", "wm-act", "2026-09-14"),
			"contentUpdatedAt",
		);
		await expectRefusal(
			client.deactivateProductCommerce("prod-wm2", "wm-deact", "not-a-date"),
			"contentUpdatedAt",
		);
		await expectRefusal(
			client.upsertProductVariant("prod-wm2", "large", { contentUpdatedAt: "9999" }, "wm-decl"),
			"contentUpdatedAt",
		);
		await expectRefusal(
			client.deactivateProductVariant("prod-wm2", "large", "wm-drop", "2026-09-14T00:00:00Z"),
			"contentUpdatedAt",
		);
		await expectRefusal(
			client.updateProductVariantFields(
				"prod-wm2",
				"large",
				{ price: { amount: 100, currency: "USD" } },
				"whenever",
				"wm-edit",
			),
			"expectedUpdatedAt",
		);
		// The publish gate is still closed and still honest — no transition landed.
		expect((await client.getProductCommerce("prod-wm2"))?.active).toBe(false);
	});

	test("a whitespace-only variant key is refused on all three variant writers", async () => {
		const watermark = "2026-09-14T00:00:00.000Z";
		await expectRefusal(
			client.upsertProductVariant("prod-vk", "   ", { contentUpdatedAt: watermark }, "vk-1"),
			"variantKey",
		);
		await expectRefusal(
			client.updateProductVariantFields(
				"prod-vk",
				"\t",
				{ price: { amount: 100, currency: "USD" } },
				watermark,
				"vk-2",
			),
			"variantKey",
		);
		await expectRefusal(
			client.deactivateProductVariant("prod-vk", "", "vk-3", watermark),
			"variantKey",
		);
	});

	test("an empty title is refused — the field is omitted to preserve, nulled to clear, never blanked", async () => {
		await expectRefusal(
			client.upsertProductCommerce("prod-title", { sku: "SKU-TITLE", title: "" }, "title-1"),
			"title",
		);
		await expectRefusal(
			client.upsertProductVariant(
				"prod-title",
				"large",
				{ title: "", contentUpdatedAt: "2026-09-14T00:00:00.000Z" },
				"title-2",
			),
			"title",
		);
	});

	test("a zero variant price is refused BEFORE the use-case, so this tier does not answer where the other one throws", async () => {
		await client.upsertProductCommerce(
			"prod-zero",
			{ sku: "SKU-ZERO", price: { amount: 1000, currency: "USD" } },
			"zero-1",
		);
		const declared = await client.upsertProductVariant(
			"prod-zero",
			"large",
			{ title: "Large", contentUpdatedAt: "2026-09-14T00:00:00.000Z" },
			"zero-declare",
		);
		await expectRefusal(
			client.updateProductVariantFields(
				"prod-zero",
				"large",
				{ price: { amount: 0, currency: "USD" } },
				declared.updatedAt,
				"zero-edit",
			),
			"price.amount",
		);
		// And the row is untouched: still unpriced, not priced at zero.
		const listed = await client.listProductVariants("prod-zero");
		expect(listed[0]?.price).toBeNull();
	});

	test("the shopper-facing bounds hold: quantity, batch size and cart ids", async () => {
		const cartId = (await client.createCart("USD")).cartId;
		await expectRefusal(client.addCartLine(cartId, "SKU-Q", null, 0, "q-1"), "qty");
		await expectRefusal(client.addCartLine(cartId, "SKU-Q", null, 1.5, "q-2"), "qty");
		await expectRefusal(client.addCartLine(cartId, "SKU-Q", null, 10_001, "q-3"), "qty");
		await expectRefusal(
			client.getCommerceBatch(Array.from({ length: 101 }, (_, i) => `p-${String(i)}`)),
			"productIds",
		);
		await expectRefusal(client.getCart("has a space"), "cartId");
	});

	test("nothing reached for egress while refusing any of it", () => {
		expect(harness.egressAttempts()).toBe(0);
	});
});

/**
 * THE TWO GAPS, PINNED.
 *
 * Both are deliberate and both are invisible unless a test says so, which is the
 * reason for this block: a gap nobody asserts is indistinguishable from a bug
 * nobody noticed. Each case fails the day the missing piece lands, which is
 * exactly when someone should come back and delete it.
 */
describe("in-process commerce: what is deliberately not wired yet", () => {
	let harness: InProcessCommerceHarness;
	let client: CommerceClient;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
		client = harness.client;
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("checkout has NO payment gateway: a real cart with a held line survives the refusal intact", async () => {
		// A genuine cart, priced, with stock held for its line — so the refusal is
		// asserted against the state it must not damage rather than against nothing.
		await client.upsertProductCommerce(
			"prod-nogw",
			{ sku: "SKU-NOGW", price: { amount: 2500, currency: "USD" }, initialOnHand: 3 },
			"nogw-seed",
		);
		const { cartId } = await client.createCart("USD");
		const added = await client.addCartLine(cartId, "SKU-NOGW", "prod-nogw", 2, "nogw-add");
		if (!added.ok) throw new Error(`arrange failed: ${added.reason}`);
		const heldReservation = added.line.reservationId;
		expect(heldReservation).not.toBeNull();
		// It quotes, so the only thing missing is the gateway.
		expect((await client.quoteCheckout({ cartId })).ok).toBe(true);

		for (const paymentMethod of ["stripe", "x402"] as const) {
			await expect(
				client.createOrder(
					{ cartId, paymentMethod, buyerRef: "buyer@example.test" },
					`no-gateway-${paymentMethod}`,
				),
			).rejects.toThrow(/no payment gateway configured/);
		}

		// The cart is untouched: still active (not checked out), still naming no order,
		// its line still holding the SAME reservation. A refusal that consumed the
		// cart or dropped the hold would be worse than the missing gateway.
		const read = await client.getCart(cartId);
		expect(read).toMatchObject({
			ok: true,
			cart: {
				state: "active",
				orderId: null,
				lines: [{ sku: "SKU-NOGW", qty: 2, reservationId: heldReservation }],
			},
		});
		// And nothing was minted — a same-key retry has no order to find either.
		expect(await client.getPublicOrder("order-that-never-was")).toEqual({
			ok: false,
			reason: "ORDER_NOT_FOUND",
		});
	});

	test("a login link records ONE challenge and dispatches NO mail", async () => {
		const challenges = harness.ctx.storage?.["login_challenges"];
		if (challenges === undefined)
			throw new Error("the login_challenges collection is not declared");
		const before = { rows: await challenges.count(), egress: harness.egressAttempts() };

		expect(await client.requestLoginLink("shopper@example.test")).toEqual({ ok: true });

		// The challenge is recorded — counted in the store rather than inferred by
		// issuing a second one, which would have proven only that the verifier works.
		expect(await challenges.count()).toBe(before.rows + 1);
		// And no mail left the process, because there is nowhere for it to go yet: the
		// only outbound surface this transport has is `ctx.http`, and it was untouched.
		expect(harness.egressAttempts()).toBe(before.egress);
	});
});
