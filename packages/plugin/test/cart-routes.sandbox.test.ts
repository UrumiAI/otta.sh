import {
	cents,
	currency,
	idempotencyKey,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	CARTS_COLLECTION,
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	PRODUCT_COMMERCE_COLLECTION,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { totalQty, type CartWire } from "../src/index.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/**
 * Phase 3 §7 step E1 — the plugin's storefront cart routes, exercised under the
 * REAL workerd sandbox.
 *
 * WHAT CHANGED, AND WHY THE SHAPE OF THIS SUITE CHANGED WITH IT. These routes
 * used to be pure proxies over `ctx.http` to `@otta-sh/service`'s `/carts` REST
 * surface, and this suite asserted the wire: the url each verb hit, the
 * `Idempotency-Key` header it carried, the JSON body it sent. INC-D3a retired
 * that deployment — the routes now run the same cart use-cases IN PROCESS over
 * the plugin's document store — so those assertions describe a transport that no
 * longer exists and are deleted rather than weakened into shape checks against a
 * local object. What they were guarding survives as behaviour and is asserted
 * that way instead: the idempotency key still reaches the ledger (a key is
 * required by every command and a command without one fails validation), the
 * target qty still replaces rather than increments, and the removal still
 * removes — all now proved by reading the cart back out of the real store.
 *
 * EGRESS, STILL ASSERTED, AND MORE STRICTLY THAN BEFORE. The old claim was "the
 * stub's recorded requests ARE the plugin's egress". The boot below declares NO
 * allowed hosts at all, so any `ctx.http` call from any of these routes throws —
 * and because the cart read's pricing join catches its own failures, an attempted
 * call would surface as `pricing.degraded: true` rather than as a silent pass.
 * A full create → add → read flow that comes back undegraded is therefore a
 * positive proof that nothing in it reaches the network.
 *
 * THE FIXTURES ARE REAL ROWS. Stock ceilings, prices and the sku↔product pairing
 * come from `product_commerce`/`inventory` documents seeded through the adapter
 * classes, not from a stub's `if` ladder, so the add path's SKU guard and the
 * inventory reserve are exercised against the data they were written to read.
 *
 * Cookie note (unchanged): per cart-routes.ts's platform-verified deviation, a
 * sandboxed route cannot emit `Set-Cookie`, so `cart/create` returns a cookie
 * DESCRIPTOR for a first-party theme shim to apply on its own response — that
 * descriptor is what "sets the cart cookie" means here.
 */

/** Seeded stock per fixture sku — an add past it yields the typed OUT_OF_STOCK
 *  token (a result, not a throw), exactly as the stub's ceiling used to. */
const SEEDED_ON_HAND = 5;

const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

/** Every id and sku here is suffixed, because the document store is shared by
 *  every sandbox suite in this process (see `sandbox/storage-bridge.ts`). */
const SUFFIX = "cartroutes";

interface SeedProduct {
	readonly id: string;
	readonly sku: string;
	readonly amount: number;
	readonly onHand?: number;
}

/** One operation log per instrumented collection. */
interface CollectionCalls {
	/** Every method name the plugin invoked, in order. */
	readonly calls: string[];
	/** The argument object of each `query`. */
	readonly queries: unknown[];
	/** The key of each `get`. */
	readonly gets: string[];
	/** While true, the next `query` fails instead of running — a database fault
	 *  injected at the seam the store itself uses. */
	failQuery: boolean;
	reset(): void;
}

let sandboxHandle: SandboxHandle;
let storage: StorageAccess;
let productCalls: CollectionCalls;
let cartCalls: CollectionCalls;

/**
 * Replace one collection on the shared store with a recording proxy. Every
 * method still reaches the real repository — this observes (and, when asked,
 * fails) without replacing the database the suite runs against.
 */
function instrument(name: string): CollectionCalls {
	const target = storage[name];
	if (target === undefined) throw new Error(`no '${name}' collection to instrument`);
	const calls: string[] = [];
	const queries: unknown[] = [];
	const gets: string[] = [];
	const log: CollectionCalls = {
		calls,
		queries,
		gets,
		failQuery: false,
		reset() {
			calls.length = 0;
			queries.length = 0;
			gets.length = 0;
			this.failQuery = false;
		},
	};
	storage[name] = new Proxy(target, {
		get(_holder, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== "function") return value;
			const bound = (value as (...args: unknown[]) => unknown).bind(target);
			return (...args: unknown[]) => {
				calls.push(String(property));
				if (property === "query") {
					queries.push(args[0]);
					if (log.failQuery) throw new Error("injected storage fault");
				}
				if (property === "get") gets.push(String(args[0]));
				return bound(...args);
			};
		},
	}) as (typeof storage)[string];
	return log;
}

/** The ids one `product_commerce.query` asked for. */
function queriedIds(call: unknown): string[] {
	const where = (call as { where?: { productId?: { in?: string[] } } }).where;
	return where?.productId?.in ?? [];
}

function commerceStore(): EmdashProductCommerceStore {
	return new EmdashProductCommerceStore({ storage, clock: systemClock });
}

function inventoryStore(): EmdashInventoryStore {
	return new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
}

/** A live, priced, activated product with stock — what an add carrying a
 *  productId must resolve to before the guard in `addCartLine` lets it hold
 *  stock. New rows are born behind the publish gate, so the fixture activates
 *  exactly as `content:afterPublish` does in a deploy. */
async function seedProduct(product: SeedProduct): Promise<void> {
	const commerce = commerceStore();
	await commerce.upsert(
		{
			productId: toProductId(product.id),
			sku: toSku(product.sku),
			price: { amount: cents(product.amount), currency: currency("USD") },
			title: `Product ${product.id}`,
		},
		idempotencyKey(`seed-${product.id}`),
	);
	await seedStock(product.sku, product.onHand ?? SEEDED_ON_HAND);
	await commerce.activate(
		toProductId(product.id),
		idempotencyKey(`pub-${product.id}`),
		PUBLISHED_AT,
	);
}

/** Stock WITHOUT a commerce row — what a legacy bare add (no productId) needs,
 *  since the guard is skipped for it but the reserve is not. */
async function seedStock(sku: string, onHand = SEEDED_ON_HAND): Promise<void> {
	await inventoryStore().seedOnHand(toSku(sku), onHand);
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	productCalls = instrument(PRODUCT_COMMERCE_COLLECTION);
	cartCalls = instrument(CARTS_COLLECTION);
	// NO allowed hosts — see the module doc's egress note.
	sandboxHandle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 120_000);

afterAll(async () => {
	await sandboxHandle?.close();
});

beforeEach(() => {
	// Seeding runs through the same instrumented collections, so the counters are
	// cleared immediately before each exercise rather than after each case.
	productCalls.reset();
	cartCalls.reset();
});

/** Unwrap a sandbox `{ result }` outcome to its route result object. */
function resultOf(outcome: unknown): Record<string, unknown> {
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

async function createCart(input: Record<string, unknown> = {}): Promise<string> {
	const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", input));
	expect(created["ok"]).toBe(true);
	return created["cartId"] as string;
}

async function addLine(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	return resultOf(await sandboxHandle.invokeRoute("storefront/cart/lines/add", input));
}

async function readCart(cartId: string): Promise<Record<string, unknown>> {
	return resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", { cartId }));
}

interface PricingWire {
	degraded: boolean;
	lines: Array<{
		lineId: string;
		unitPrice: { amount: number; currency: string } | null;
		lineTotal: { amount: number; currency: string } | null;
	}>;
	total: { amount: number; currency: string } | null;
	allLinesPriced: boolean;
}

describe("storefront cart routes (workerd sandbox)", () => {
	test("cart/create mints a cart and returns the cart-cookie descriptor for the theme shim", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/create", { currency: "USD" }),
		);

		expect(result["ok"]).toBe(true);
		expect(typeof result["cartId"]).toBe("string");
		// The cookie INTENT the plugin cannot itself enact (module doc): a
		// descriptor the first-party theme applies on its own response.
		expect(result["cookie"]).toMatchObject({
			name: "otta_cart",
			value: result["cartId"],
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
		});
		// The cart is REAL: the id names a document the store now holds.
		const cart = await readCart(result["cartId"] as string);
		expect(cart["ok"]).toBe(true);
	});

	test("cart/create rejects a malformed currency BEFORE any store work (pure route validation)", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/create", { currency: "dollars" }),
		);
		expect(result).toEqual({ ok: false, error: "INVALID_CURRENCY" });
		// A validation reject writes nothing and reads nothing.
		expect(cartCalls.calls).toEqual([]);
	});

	test("add-to-cart THREADS productId onto the persisted line, and the line still carries it on re-read (issue #80)", async () => {
		await seedProduct({ id: `prod-thread-${SUFFIX}`, sku: `SKU-THREAD-${SUFFIX}`, amount: 1000 });
		const cartId = await createCart();

		const result = await addLine({
			cartId,
			sku: `SKU-THREAD-${SUFFIX}`,
			productId: `prod-thread-${SUFFIX}`,
			qty: 2,
			idempotencyKey: `idem-add-${SUFFIX}`,
		});

		expect(result["ok"]).toBe(true);
		expect(result["line"]).toMatchObject({
			sku: `SKU-THREAD-${SUFFIX}`,
			qty: 2,
			productId: `prod-thread-${SUFFIX}`,
		});
		// The join key to `product_commerce` is DURABLE, not just echoed back: the
		// read comes from the stored line, and that is what makes the line
		// priceable/quotable/orderable at all.
		const cart = (await readCart(cartId))["cart"] as CartWire;
		expect(cart.lines[0]).toMatchObject({ productId: `prod-thread-${SUFFIX}` });
	});

	test("add-to-cart REFUSES a productId that does not own the submitted sku (SKU_MISMATCH — no stock is held)", async () => {
		await seedProduct({ id: `prod-guard-${SUFFIX}`, sku: `SKU-GUARD-${SUFFIX}`, amount: 900 });
		await seedStock(`SKU-OTHER-${SUFFIX}`);
		const cartId = await createCart();

		// `sku` and `productId` are independent caller inputs; pairing one
		// product's id with another's sku would be charged one price while
		// reserving the other's stock, so the add resolves the pair or refuses it.
		const result = await addLine({
			cartId,
			sku: `SKU-OTHER-${SUFFIX}`,
			productId: `prod-guard-${SUFFIX}`,
			qty: 1,
			idempotencyKey: `idem-mismatch-${SUFFIX}`,
		});
		expect(result).toEqual({ ok: false, reason: "SKU_MISMATCH" });
		const cart = (await readCart(cartId))["cart"] as CartWire;
		expect(cart.lines).toEqual([]);
	});

	test("add-to-cart WITHOUT productId (legacy caller) persists the line with productId null — absent, never a fabricated value", async () => {
		await seedStock(`SKU-BARE-${SUFFIX}`);
		const cartId = await createCart();

		const result = await addLine({
			cartId,
			sku: `SKU-BARE-${SUFFIX}`,
			qty: 1,
			idempotencyKey: `idem-legacy-${SUFFIX}`,
		});

		expect(result["ok"]).toBe(true);
		expect(result["line"]).toMatchObject({ sku: `SKU-BARE-${SUFFIX}`, productId: null });
	});

	test("add-to-cart rejects a present-but-blank productId before any store work (validated, not silently dropped)", async () => {
		const result = await addLine({
			cartId: `cart-x-${SUFFIX}`,
			sku: `SKU-BLANK-${SUFFIX}`,
			productId: "",
			qty: 1,
			idempotencyKey: `idem-blank-${SUFFIX}`,
		});
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(cartCalls.calls).toEqual([]);
	});

	test("add-to-cart surfaces the typed OUT_OF_STOCK token (a normalized non-throw result), not an error", async () => {
		await seedStock(`SKU-OOS-${SUFFIX}`);
		const cartId = await createCart();

		const result = await addLine({
			cartId,
			sku: `SKU-OOS-${SUFFIX}`,
			qty: SEEDED_ON_HAND + 1,
			idempotencyKey: `idem-oos-${SUFFIX}`,
		});
		expect(result).toEqual({ ok: false, reason: "OUT_OF_STOCK" });
	});

	test("add-to-cart rejects invalid input (non-positive qty) before any store work", async () => {
		const result = await addLine({
			cartId: `cart-x-${SUFFIX}`,
			sku: `SKU-BADQTY-${SUFFIX}`,
			qty: 0,
			idempotencyKey: `idem-bad-${SUFFIX}`,
		});
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(cartCalls.calls).toEqual([]);
	});

	test("cart/read returns the live cart, from which totals derive", async () => {
		await seedStock(`SKU-READ-A-${SUFFIX}`);
		await seedStock(`SKU-READ-B-${SUFFIX}`);
		const cartId = await createCart();
		await addLine({
			cartId,
			sku: `SKU-READ-A-${SUFFIX}`,
			qty: 2,
			idempotencyKey: `k-a-${SUFFIX}`,
		});
		await addLine({
			cartId,
			sku: `SKU-READ-B-${SUFFIX}`,
			qty: 3,
			idempotencyKey: `k-b-${SUFFIX}`,
		});

		const result = await readCart(cartId);
		expect(result["ok"]).toBe(true);
		const cart = result["cart"] as CartWire;
		// Unordered: the stub used to return lines in insertion order as an artifact
		// of an array push; the real store makes no such promise and the route makes
		// no claim about line order, so asserting one would pin an accident.
		expect(
			cart.lines.map((l) => ({ sku: l.sku, qty: l.qty })).toSorted((a, b) => a.qty - b.qty),
		).toEqual([
			{ sku: `SKU-READ-A-${SUFFIX}`, qty: 2 },
			{ sku: `SKU-READ-B-${SUFFIX}`, qty: 3 },
		]);
		// `totalQty` (a plugin export) is the one total honestly computable
		// from the price-free cart-line wire — the "live total" this route
		// backs (see cart-routes.ts's read-handler doc).
		expect(totalQty(cart)).toBe(5);
		// The route passes `cart` through VERBATIM, so `orderId` (#132) has to
		// survive the handler as well as the client. PRESENCE is the assertion:
		// `toBeNull()` alone would also pass on an absent key.
		expect(cart).toHaveProperty("orderId");
		expect(cart.orderId).toBeNull();
	});

	test("cart/read maps an unknown cart to the typed CART_NOT_FOUND reason (not a thrown error)", async () => {
		const result = await readCart(`missing-cart-${SUFFIX}`);
		expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
	});

	test("cart/read rejects a missing cartId before any store work", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", {}));
		expect(result).toEqual({ ok: false, error: "INVALID_CART_ID" });
		expect(cartCalls.calls).toEqual([]);
	});

	test("cart/lines/update sets the TARGET qty (not a delta) and the cart re-reads at that qty", async () => {
		await seedStock(`SKU-UPD-${SUFFIX}`);
		const cartId = await createCart();
		const added = await addLine({
			cartId,
			sku: `SKU-UPD-${SUFFIX}`,
			qty: 1,
			idempotencyKey: `k-u-${SUFFIX}`,
		});
		const lineId = (added["line"] as { lineId: string }).lineId;

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/update", {
				cartId,
				lineId,
				qty: 4,
				idempotencyKey: `k-u2-${SUFFIX}`,
			}),
		);
		expect(result["ok"]).toBe(true);
		expect(result["line"]).toMatchObject({ qty: 4 });
		// 4 is the qty, not 1 + 4 — the delta is computed against the held stock,
		// which is the whole reason the route takes a target.
		const cart = (await readCart(cartId))["cart"] as CartWire;
		expect(cart.lines.map((l) => l.qty)).toEqual([4]);
	});

	test("cart/lines/remove returns a bare ok:true; the line is gone on re-read", async () => {
		await seedStock(`SKU-REM-${SUFFIX}`);
		const cartId = await createCart();
		const added = await addLine({
			cartId,
			sku: `SKU-REM-${SUFFIX}`,
			qty: 1,
			idempotencyKey: `k-r-${SUFFIX}`,
		});
		const lineId = (added["line"] as { lineId: string }).lineId;

		const removed = resultOf(
			await sandboxHandle.invokeRoute("storefront/cart/lines/remove", {
				cartId,
				lineId,
				idempotencyKey: `k-r2-${SUFFIX}`,
			}),
		);
		expect(removed).toEqual({ ok: true });

		const read = await readCart(cartId);
		expect((read["cart"] as CartWire).lines).toEqual([]);
	});

	test("a full create→add→read flow completes on a boot with ZERO allowed hosts — the cart path reaches the network for nothing", async () => {
		await seedProduct({
			id: `prod-noegress-${SUFFIX}`,
			sku: `SKU-NOEGRESS-${SUFFIX}`,
			amount: 700,
		});
		const cartId = await createCart();
		const added = await addLine({
			cartId,
			sku: `SKU-NOEGRESS-${SUFFIX}`,
			productId: `prod-noegress-${SUFFIX}`,
			qty: 1,
			idempotencyKey: `k-noegress-${SUFFIX}`,
		});
		expect(added["ok"]).toBe(true);

		const result = await readCart(cartId);
		// Any `ctx.http` call would throw on this boot; the create/add would fail
		// outright and the pricing join would catch and degrade. Undegraded
		// success across all three routes is the positive proof of no egress.
		expect(result["ok"]).toBe(true);
		const pricing = result["pricing"] as PricingWire;
		expect(pricing.degraded).toBe(false);
		expect(pricing.total).toMatchObject({ amount: 700, currency: "USD" });
	});

	describe("cart/read informational pricing join (plugin-side batch join)", () => {
		test("2 priced lines: pricing.lines carries unitPrice/lineTotal, pricing.total sums them, and EXACTLY ONE batched commerce read is issued", async () => {
			await seedProduct({ id: `prod-pa-${SUFFIX}`, sku: `SKU-PA-${SUFFIX}`, amount: 1000 });
			await seedProduct({ id: `prod-pb-${SUFFIX}`, sku: `SKU-PB-${SUFFIX}`, amount: 500 });
			const cartId = await createCart();
			const lineA = await addLine({
				cartId,
				sku: `SKU-PA-${SUFFIX}`,
				productId: `prod-pa-${SUFFIX}`,
				qty: 2,
				idempotencyKey: `k-price-a-${SUFFIX}`,
			});
			const lineB = await addLine({
				cartId,
				sku: `SKU-PB-${SUFFIX}`,
				productId: `prod-pb-${SUFFIX}`,
				qty: 1,
				idempotencyKey: `k-price-b-${SUFFIX}`,
			});
			const lineIdA = (lineA["line"] as { lineId: string }).lineId;
			const lineIdB = (lineB["line"] as { lineId: string }).lineId;
			productCalls.reset();

			const result = await readCart(cartId);
			expect(result["ok"]).toBe(true);
			const pricing = result["pricing"] as PricingWire;
			expect(pricing.degraded).toBe(false);
			expect(pricing.allLinesPriced).toBe(true);
			const priceA = pricing.lines.find((l) => l.lineId === lineIdA);
			const priceB = pricing.lines.find((l) => l.lineId === lineIdB);
			expect(priceA?.unitPrice).toMatchObject({ amount: 1000, currency: "USD" });
			expect(priceA?.lineTotal).toMatchObject({ amount: 2000, currency: "USD" }); // qty 2
			expect(priceB?.unitPrice).toMatchObject({ amount: 500, currency: "USD" });
			expect(priceB?.lineTotal).toMatchObject({ amount: 500, currency: "USD" }); // qty 1
			expect(pricing.total).toMatchObject({ amount: 2500, currency: "USD" });

			// The N+1 guarantee, same proof style as PLP, one layer below where it
			// used to be asserted: the batch HTTP call is gone, so the claim is now
			// that one cart render issues ONE `product_commerce` query carrying both
			// ids — not one read per line.
			expect(productCalls.queries).toHaveLength(1);
			expect(queriedIds(productCalls.queries[0]).toSorted()).toEqual([
				`prod-pa-${SUFFIX}`,
				`prod-pb-${SUFFIX}`,
			]);
			expect(productCalls.gets).toHaveLength(0);
		});

		test("a line whose product row is gone degrades to unpriced; pricing.total sums only the OTHER priced line (partial total)", async () => {
			await seedProduct({ id: `prod-keep-${SUFFIX}`, sku: `SKU-KEEP-${SUFFIX}`, amount: 1200 });
			await seedProduct({ id: `prod-drop-${SUFFIX}`, sku: `SKU-DROP-${SUFFIX}`, amount: 300 });
			const cartId = await createCart();
			const priced = await addLine({
				cartId,
				sku: `SKU-KEEP-${SUFFIX}`,
				productId: `prod-keep-${SUFFIX}`,
				qty: 1,
				idempotencyKey: `k-keep-${SUFFIX}`,
			});
			const dropped = await addLine({
				cartId,
				sku: `SKU-DROP-${SUFFIX}`,
				productId: `prod-drop-${SUFFIX}`,
				qty: 1,
				idempotencyKey: `k-drop-${SUFFIX}`,
			});
			// The add's own guard means an unpriceable line can no longer be CREATED
			// through the route — so the honest way to hold one is the way it happens
			// in a shop: the product is withdrawn after the line was added. The batch
			// read then omits it ("omit, never fail"), which is what the join must
			// survive.
			await commerceStore().softDelete(
				toProductId(`prod-drop-${SUFFIX}`),
				idempotencyKey(`del-drop-${SUFFIX}`),
			);
			const lineIdPriced = (priced["line"] as { lineId: string }).lineId;
			const lineIdDropped = (dropped["line"] as { lineId: string }).lineId;

			const result = await readCart(cartId);
			const pricing = result["pricing"] as PricingWire;
			expect(pricing.allLinesPriced).toBe(false);
			expect(pricing.lines.find((l) => l.lineId === lineIdDropped)?.unitPrice).toBeNull();
			expect(pricing.lines.find((l) => l.lineId === lineIdPriced)?.unitPrice).not.toBeNull();
			expect(pricing.total).toMatchObject({ amount: 1200, currency: "USD" });
		});

		test("a commerce-read failure degrades pricing but the cart STILL renders (ok:true, cart data intact)", async () => {
			await seedProduct({ id: `prod-fault-${SUFFIX}`, sku: `SKU-FAULT-${SUFFIX}`, amount: 400 });
			const cartId = await createCart();
			await addLine({
				cartId,
				sku: `SKU-FAULT-${SUFFIX}`,
				productId: `prod-fault-${SUFFIX}`,
				qty: 1,
				idempotencyKey: `k-fault-${SUFFIX}`,
			});
			// A database fault injected where the join reads — the in-process
			// successor to the stub's 500 on the batch endpoint.
			productCalls.failQuery = true;

			const result = await readCart(cartId);
			expect(result["ok"]).toBe(true);
			expect((result["cart"] as CartWire).lines).toHaveLength(1);
			const pricing = result["pricing"] as PricingWire;
			expect(pricing.degraded).toBe(true);
			expect(pricing.total).toBeNull();
		});

		test("a cart of only legacy bare-add lines (no productId) issues NO commerce read at all; pricing.total stays null", async () => {
			await seedStock(`SKU-ONLYBARE-${SUFFIX}`);
			const cartId = await createCart();
			await addLine({
				cartId,
				sku: `SKU-ONLYBARE-${SUFFIX}`,
				qty: 1,
				idempotencyKey: `k-onlybare-${SUFFIX}`,
			});
			productCalls.reset();

			const result = await readCart(cartId);
			expect(result["ok"]).toBe(true);
			const pricing = result["pricing"] as PricingWire;
			expect(pricing.total).toBeNull();
			expect(pricing.allLinesPriced).toBe(false);
			// Nothing to look up ⇒ nothing is looked up: the read never touches
			// `product_commerce`, the same discipline PDP/PLP hold.
			expect(productCalls.calls).toEqual([]);
		});
	});
});
