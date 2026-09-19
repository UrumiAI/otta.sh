/**
 * B4 (storefront-checkout plan §3) — the plugin's checkout routes under the
 * REAL workerd sandbox (DEVELOPMENT.md §5: if it only works trusted, it's
 * broken), against the REAL document store.
 *
 * WHAT INC-D3a CHANGED HERE. These routes used to compose their work out of
 * HTTP calls to `@otta-sh/service`, and this suite drove them by scripting a
 * stub's replies: a quote could be made to answer `CART_EMPTY`, a create could
 * be made to answer a 502, an order could be made to carry a fractional total.
 * The transport is gone — the routes run the cart/quote/order use-cases in
 * process over `ctx.storage` — so a scripted reply can no longer be injected
 * anywhere, and every reason this suite asserts now has to be PRODUCED by real
 * data. Each case below therefore arranges the condition (an empty cart, a line
 * with no product reference, a product priced in another currency) instead of
 * declaring the answer, which is a stronger test of the same contract.
 *
 * WHAT IS NOT ASSERTABLE THIS INCREMENT, AND WHY IT IS NOT QUIETLY DROPPED.
 * `checkout/place` asks the domain for the `stripe` gateway, and the in-process
 * composition root wires NONE yet (`make-commerce-client.ts` fills the `x402`
 * slot only; `createOrderFromCart` refuses a method it has no gateway for, by
 * throwing). So there is no reachable success path through `place` at all in
 * this build, and the cases that pinned its successful shape — the idempotency-key
 * forwarding, the buyerRef and client-secret passthrough, the ship-to forward, the
 * private-field stripping, the replay's `alreadyPlaced`, the formatted order total
 * with its locale and its degradation, and the typed error-code mapping — assert
 * nothing that can happen and are PARKED rather than mocked back into existence:
 * each is a `test.todo` at the foot of the `place` describe, naming the blocking
 * issue `#286`, so every run reports them as outstanding
 * instead of leaving the gap visible only in a commit message. What CAN be
 * asserted, and is
 * below, is that the refusal is contained: it reaches the caller as the guard's
 * `RENDER_FAILED` with no internals attached, and it leaves the cart and its
 * stock hold exactly as it found them. `commerce-client-contract.in-process.test.ts`
 * pins the same gap one layer down; both cases come back to life, unchanged,
 * when the stripe gateway is wired.
 *
 * EGRESS IS STILL ASSERTED, more strictly than before. The boot declares NO
 * allowed hosts, so any `ctx.http` call from these routes throws — a checkout
 * that completes on this boot reached the network for nothing. That replaces
 * the old "the stub recorded every request" argument, and it also replaces the
 * `X-Internal-Token` case: there is no request to inspect for a header, so what
 * that header guarded (a guest-readable page must never see the operator's
 * projection) is asserted against the payload itself.
 *
 * What this file still pins that a unit test cannot:
 *  - `checkout/summary` composes cart read → ONE batched commerce read per leg
 *    → quote, regardless of line count (the N+1 guard, now counted at the store);
 *  - a typed failure (`CART_EMPTY`, `PRODUCT_NOT_PRICED`, `CURRENCY_MISMATCH`)
 *    reaches the caller as that reason — never `RENDER_FAILED`, never a partial
 *    `ok: true` view with a payable-looking button on it;
 *  - `storefront/order` renders the PUBLIC projection of a real order and
 *    nothing else.
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
	EmdashInventoryStore,
	EmdashOrderStore,
	EmdashProductCommerceStore,
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/** A namespace no other suite writes under — the document store is
 *  process-scoped and shared by every sandbox suite in this process. */
const NS = "ck";

const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

let sandboxHandle: SandboxHandle;
let storage: StorageAccess;
let orderStore: EmdashOrderStore;
let productQueries: unknown[];
let productGets: string[];
/** Every method name the plugin invoked on the `orders` collection — the store
 *  work a route that rejects its input must not have done. */
let orderOps: string[];
let seq = 0;

function commerceStore(): EmdashProductCommerceStore {
	return new EmdashProductCommerceStore({ storage, clock: systemClock });
}

function inventoryStore(): EmdashInventoryStore {
	return new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
}

/**
 * Record every operation the plugin performs on one collection. The isolate's
 * `ctx.storage` is a proxy to the store THIS process owns and the bridge resolves
 * the collection per call (see `sandbox/storage-bridge.ts`), so wrapping it here
 * counts the plugin's real reads with nothing added to `src/`.
 */
function instrument(
	collection: string,
	record: (method: string, args: readonly unknown[]) => void,
): void {
	const target = storage[collection];
	if (target === undefined) throw new Error(`no '${collection}' collection to instrument`);
	storage[collection] = new Proxy(target, {
		get(_holder, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== "function") return value;
			const bound = (value as (...args: unknown[]) => unknown).bind(target);
			return (...args: unknown[]) => {
				record(String(property), args);
				return bound(...args);
			};
		},
	}) as (typeof storage)[string];
}

/** The ids one `product_commerce.query` asked for. */
function queriedIds(call: unknown): string[] {
	const where = (call as { where?: { productId?: { in?: string[] } } }).where;
	return where?.productId?.in ?? [];
}

interface SeedProduct {
	readonly id: string;
	readonly sku: string;
	readonly amount: number;
	readonly currency?: string;
}

/** A live, priced, activated product with stock — the state an add's SKU guard
 *  and the quote's price resolution both require. */
async function seedProduct(product: SeedProduct): Promise<void> {
	const commerce = commerceStore();
	await commerce.upsert(
		{
			productId: toProductId(product.id),
			sku: toSku(product.sku),
			price: { amount: cents(product.amount), currency: currency(product.currency ?? "USD") },
			title: "Bamboo Water Bottle",
		},
		idempotencyKey(`seed-${product.id}`),
	);
	// Deep stock on purpose: every case that needs a priced cart holds units out
	// of the SAME seeded rows, and an exhausted fixture would fail a later case as
	// OUT_OF_STOCK for a reason that has nothing to do with what it asserts.
	await inventoryStore().seedOnHand(toSku(product.sku), 500);
	await commerce.activate(
		toProductId(product.id),
		idempotencyKey(`pub-${product.id}`),
		PUBLISHED_AT,
	);
}

function resultOf(outcome: unknown): Record<string, unknown> {
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

async function createCart(): Promise<string> {
	const created = resultOf(await sandboxHandle.invokeRoute("storefront/cart/create", {}));
	expect(created["ok"]).toBe(true);
	return created["cartId"] as string;
}

async function addLine(
	cartId: string,
	sku: string,
	productId: string | null,
	qty: number,
): Promise<void> {
	seq += 1;
	const result = resultOf(
		await sandboxHandle.invokeRoute("storefront/cart/lines/add", {
			cartId,
			sku,
			...(productId === null ? {} : { productId }),
			qty,
			idempotencyKey: `add-${NS}-${String(seq)}`,
		}),
	);
	expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

/** The three-line cart the totals cases price: 1×$19.99 + 2×$10.00 + 3×$3.33. */
const LINE_SKUS = [`SKU-${NS}-1`, `SKU-${NS}-2`, `SKU-${NS}-3`];
const LINE_PRODUCT_IDS = [`prod-${NS}-1`, `prod-${NS}-2`, `prod-${NS}-3`];
/** 1999 + 2×1000 + 3×333 — computed here so a fixture edit cannot silently
 *  change what "the subtotal" means below. */
const SUBTOTAL_CENTS = 1999 + 2 * 1000 + 3 * 333;

async function seedThreeLineCart(): Promise<string> {
	const cartId = await createCart();
	await addLine(cartId, LINE_SKUS[0]!, LINE_PRODUCT_IDS[0]!, 1);
	await addLine(cartId, LINE_SKUS[1]!, LINE_PRODUCT_IDS[1]!, 2);
	await addLine(cartId, LINE_SKUS[2]!, LINE_PRODUCT_IDS[2]!, 3);
	return cartId;
}

async function summary(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	return resultOf(await sandboxHandle.invokeRoute("storefront/checkout/summary", input));
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	productQueries = [];
	productGets = [];
	orderOps = [];
	instrument(PRODUCT_COMMERCE_COLLECTION, (method, args) => {
		if (method === "query") productQueries.push(args[0]);
		if (method === "get") productGets.push(String(args[0]));
	});
	instrument(ORDERS_COLLECTION, (method) => {
		orderOps.push(method);
	});
	orderStore = new EmdashOrderStore({
		storage,
		inventory: inventoryStore(),
		idGen: uuidIdGen,
		clock: systemClock,
	});
	// NO allowed hosts — see the module doc's egress note.
	sandboxHandle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
	await seedProduct({ id: LINE_PRODUCT_IDS[0]!, sku: LINE_SKUS[0]!, amount: 1999 });
	await seedProduct({ id: LINE_PRODUCT_IDS[1]!, sku: LINE_SKUS[1]!, amount: 1000 });
	await seedProduct({ id: LINE_PRODUCT_IDS[2]!, sku: LINE_SKUS[2]!, amount: 333 });
}, 300_000);

afterAll(async () => {
	await sandboxHandle?.close();
});

beforeEach(() => {
	// Arrangement runs through the instrumented collection too, so the counters
	// are cleared immediately before each exercise rather than after each case.
	productQueries.length = 0;
	productGets.length = 0;
	orderOps.length = 0;
});

describe("storefront/checkout/summary (workerd sandbox)", () => {
	test("a MULTI-line cart costs ONE batched commerce read per leg and ZERO per-line reads (the N+1 guard)", async () => {
		const cartId = await seedThreeLineCart();
		productQueries.length = 0;
		productGets.length = 0;

		const result = await summary({ cartId });

		expect(result["ok"]).toBe(true);
		// The route's two commerce legs — the display join and the quote's own
		// price resolution — each read the whole cart in ONE query carrying every
		// product id. That is what "one batch, never one call per line" means now
		// that the batch is a store read rather than an HTTP POST.
		expect(productQueries).toHaveLength(2);
		for (const call of productQueries) {
			expect(queriedIds(call).toSorted()).toEqual([...LINE_PRODUCT_IDS].toSorted());
		}
		expect(productGets).toHaveLength(0);
	});

	test("returns the QUOTE's totals as authoritative, with honest 'Not calculated' shipping/tax and per-line formatted money", async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId });

		const totals = result["totals"] as Record<string, { money: unknown; label: string }>;
		expect(totals["subtotal"]!.label).toBe("$49.98");
		expect(totals["total"]!.label).toBe("$49.98");
		expect(SUBTOTAL_CENTS).toBe(4998);
		// No shipping method and no tax zone were selected this slice, so the
		// pipeline's synthetic zeros are reported as uncomputed rather than as
		// "Free" / "$0.00".
		expect(totals["shipping"]!.money).toBeNull();
		expect(totals["shipping"]!.label).toBe("Not calculated");
		expect(totals["tax"]!.money).toBeNull();
		expect(totals["tax"]!.label).toBe("Not calculated");

		const lines = result["lines"] as {
			sku: string;
			qty: number;
			lineTotal: { formatted: string };
		}[];
		expect(lines).toHaveLength(3);
		const first = lines.find((l) => l.sku === LINE_SKUS[0]);
		expect(first).toMatchObject({ qty: 1 });
		expect(first!.lineTotal.formatted).toBe("$19.99");
		expect(result["hasUnpricedLines"]).toBe(false);
	});

	test("carries the STABLE per-cart idempotency key the form embeds (never a fresh one per render)", async () => {
		const cartId = await seedThreeLineCart();
		const first = await summary({ cartId });
		const second = await summary({ cartId });
		expect(first["idempotencyKey"]).toBe(`checkout:${cartId}`);
		expect(second["idempotencyKey"]).toBe(first["idempotencyKey"]);
	});

	test("an EMPTY cart surfaces the quote's typed CART_EMPTY — never RENDER_FAILED, never a partial ok:true view", async () => {
		const cartId = await createCart();

		const result = await summary({ cartId });

		// §1.7: "303 to /cart — never render an empty checkout with a
		// payable-looking button". The route's half of that contract is the
		// TYPED reason; the site's half is asserted in checkout-place.test.ts.
		expect(result).toEqual({ ok: false, reason: "CART_EMPTY" });
		expect(result["ok"]).not.toBe(true);
	});

	test("a line with NO product reference surfaces PRODUCT_NOT_PRICED (a bare/legacy add cannot be ordered)", async () => {
		// Arranged, not scripted: a bare add is exactly the line the quote refuses
		// to price, because price and title are read off the product row.
		await inventoryStore().seedOnHand(toSku(`SKU-${NS}-BARE`), 5);
		const cartId = await createCart();
		await addLine(cartId, `SKU-${NS}-BARE`, null, 1);

		expect(await summary({ cartId })).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
	});

	test("a line priced in another currency surfaces CURRENCY_MISMATCH", async () => {
		// The cart is minted in the default USD; this product is priced in EUR, so
		// the two disagree at the quote — the one place that comparison can be made.
		await seedProduct({
			id: `prod-${NS}-eur`,
			sku: `SKU-${NS}-EUR`,
			amount: 900,
			currency: "EUR",
		});
		const cartId = await createCart();
		await addLine(cartId, `SKU-${NS}-EUR`, `prod-${NS}-eur`, 1);

		expect(await summary({ cartId })).toEqual({ ok: false, reason: "CURRENCY_MISMATCH" });
	});

	test("a missing cart surfaces CART_NOT_FOUND from the cart leg, with NO commerce read at all", async () => {
		const result = await summary({ cartId: `no-such-cart-${NS}` });
		expect(result).toEqual({ ok: false, reason: "CART_NOT_FOUND" });
		// The cart leg is first and it short-circuits: nothing downstream of it ran.
		expect(productQueries).toHaveLength(0);
		expect(productGets).toHaveLength(0);
	});

	test("a blank cartId is rejected BEFORE any store work", async () => {
		const result = await summary({});
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(productQueries).toHaveLength(0);
	});
});

describe("storefront/checkout/place (workerd sandbox)", () => {
	/**
	 * THE GAP, CONTAINED. No `stripe` gateway is wired in process (module doc), so
	 * the domain refuses the method by throwing and `renderGuard` collapses that to
	 * RENDER_FAILED. Two things matter about that and are asserted here: the caller
	 * is told nothing about the plugin's insides, and — far more importantly — the
	 * buyer's cart is not damaged on the way out. A refusal that consumed the cart
	 * or dropped its stock hold would be worse than the missing gateway.
	 */
	test("with no payment gateway wired, place refuses cleanly and leaves the cart and its hold intact", async () => {
		const cartId = await seedThreeLineCart();
		const before = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", { cartId }));
		const beforeLines = (before["cart"] as { lines: { reservationId: string | null }[] }).lines;

		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/place", {
				cartId,
				buyerRef: "Buyer@Example.com",
				idempotencyKey: `checkout:${cartId}`,
			}),
		);

		expect(result).toEqual({ ok: false, error: "RENDER_FAILED" });
		// Nothing about the composition root reaches the caller.
		expect(JSON.stringify(result)).not.toMatch(/gateway|stripe|storage/i);

		const after = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", { cartId }));
		const cart = after["cart"] as {
			state: string;
			orderId: string | null;
			lines: { reservationId: string | null }[];
		};
		expect(cart.state).toBe("active");
		expect(cart.orderId).toBeNull();
		expect(cart.lines.map((l) => l.reservationId)).toEqual(beforeLines.map((l) => l.reservationId));
	});

	test.each([
		["a blank buyerRef", { cartId: "cart-1", buyerRef: "  ", idempotencyKey: "checkout:cart-1" }],
		["a missing idempotencyKey", { cartId: "cart-1", buyerRef: "a@b.co" }],
		[
			"a malformed ship-to",
			{
				cartId: "cart-1",
				buyerRef: "a@b.co",
				idempotencyKey: "checkout:cart-1",
				shippingAddress: { name: "A", line1: 42 },
			},
		],
	])("%s is rejected BEFORE any store work", async (_label, input) => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/checkout/place", input));
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(productQueries).toHaveLength(0);
		// ...and no order was minted on the way to refusing, which is the half the
		// old `stubServer.requests` count carried.
		expect(orderOps).toEqual([]);
	});

	/**
	 * PARKED, NOT DELETED — the `place` SUCCESS PATH.
	 *
	 * Every case below asserted the shape of a SUCCESSFUL place, and there is no
	 * reachable success path through `place` in this build: the domain asks for the
	 * `stripe` gateway and the in-process composition root wires none
	 * (`make-commerce-client.ts` fills the `x402` slot only), so `createOrderFromCart`
	 * throws before any of these properties can exist. They are recorded as
	 * `test.todo` rather than deleted so the coverage they represent is visible in
	 * every run's output instead of living only in a commit message — a deleted test
	 * is indistinguishable from a property nobody ever cared about.
	 *
	 * BLOCKED ON: the stripe gateway is not wired in process —
	 * issue #286. Each one comes back by ARRANGING the
	 * condition against real data (a placed order, a replayed key, a ship-to on the
	 * cart) rather than by scripting a reply; the names are kept verbatim as they
	 * were deleted so the restoration is greppable against this file's history, and
	 * the transport wording in a few of them ("issues EXACTLY one call", "a 502")
	 * is what should be reworded at that point, not the property.
	 */
	test.todo("issues EXACTLY one call — POST /checkout/orders — forwarding Idempotency-Key verbatim and buyerRef un-rewritten", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("passes clientAction through UNMODIFIED — the client secret is data in transit", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("NEVER echoes the order's private fields (buyerRef / shippingAddress) back to the caller", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("forwards the optional ship-to snapshot (ADR-0009 slice c)", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("a REPLAY of an order that has left pending (clientAction none, intentId '') is alreadyPlaced — not an error", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("returns the ORDER's own total, formatted — the figure the pay button states", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("the total honours the requested locale, and falls back rather than failing", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("a REPLAY still carries the total — an order always has one", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("a reply with NO totals block still places the order — total simply absent", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("an unformattable total drops the total and keeps the order (a lowercase currency, a symbol for a currency, a fractional total, a null total)", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("a 502 becomes the typed PAYMENT_INTENT_FAILED, never RENDER_FAILED", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("a 409 CART_CHECKED_OUT / RESERVATION_LOST / PRODUCT_NOT_PRICED becomes the typed reason", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
	test.todo("a 400 INVALID_SHIPPING_ADDRESS becomes the typed reason", () => {
		/* blocked on: stripe gateway not wired in-process — see issue #286 */
	});
});

describe("storefront/order (workerd sandbox)", () => {
	const ORDER_ID = `order-${NS}-public`;

	/** A REAL order, written through the same store the route reads — including
	 *  the private fields the public projection must not carry. */
	beforeAll(async () => {
		await orderStore.createFromCart({
			orderId: toOrderId(ORDER_ID),
			cartId: null,
			currency: currency("USD"),
			idempotencyKey: idempotencyKey(`create-${ORDER_ID}`),
			holdExpiresAt: "2099-01-01T00:00:00.000Z",
			buyerRef: "Buyer@Example.com",
			paymentMethod: "stripe",
			shippingAddress: {
				name: "A Buyer",
				line1: "1 Test St",
				line2: null,
				city: "Testville",
				region: null,
				postalCode: "12345",
				country: "Testland",
				email: null,
				phone: null,
			},
			lines: [
				{
					productId: toProductId(`prod-${NS}-order`),
					sku: toSku(`SKU-${NS}-ORDER`),
					title: "Bamboo Water Bottle",
					unitPrice: cents(1999),
					currency: currency("USD"),
					quantity: 3,
					fulfillmentKind: "digital",
					reservationId: null,
				},
			],
			totals: { subtotal: cents(5997), total: cents(5997), currency: currency("USD") },
		});
	});

	test("renders the order's OWN state plus formatted totals and lines", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: ORDER_ID }),
		);
		expect(result["ok"]).toBe(true);
		const order = result["order"] as Record<string, unknown>;
		expect(order["state"]).toBe("pending");
		expect((order["totals"] as Record<string, { label: string }>)["total"]!.label).toBe("$59.97");
		const lines = order["lines"] as { title: string; lineTotal: { formatted: string } }[];
		expect(lines[0]!.title).toBe("Bamboo Water Bottle");
		expect(lines[0]!.lineTotal.formatted).toBe("$59.97");
	});

	test("answers the PUBLIC projection only — the buyer reference and ship-to snapshot never reach this page", async () => {
		// This route is authenticated by nothing but an unguessable order id, so the
		// projection IS the access control. It used to be guarded on the wire by the
		// absence of `X-Internal-Token`; with no request left to inspect, the
		// property is asserted where it now lives — in what the route returns.
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: ORDER_ID }),
		);
		const wire = JSON.stringify(result);
		expect(wire).not.toContain("Buyer@Example.com");
		expect(wire).not.toContain("1 Test St");
		expect(result["order"]).not.toHaveProperty("buyerRef");
		expect(result["order"]).not.toHaveProperty("shippingAddress");
	});

	test("an unknown order surfaces the typed ORDER_NOT_FOUND", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: `no-such-order-${NS}` }),
		);
		expect(result).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
	});

	test("a blank orderId is rejected BEFORE any store work", async () => {
		const result = resultOf(await sandboxHandle.invokeRoute("storefront/order", {}));
		expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
		// WHAT "BEFORE ANY STORE WORK" MEANS NOW. The old proof was
		// `stubServer.requests` being empty; with no request to count, the same claim
		// is made against the `orders` collection the route would have read — every
		// method call on it is recorded (see `instrument`), and a guard that ran
		// AFTER the read would show up here as a `get`.
		expect(orderOps).toEqual([]);
		expect(productQueries).toHaveLength(0);
	});
});

describe("checkout egress is the whole story", () => {
	test("a full summary → order cycle completes on a boot with ZERO allowed hosts — checkout reaches the network for nothing", async () => {
		const cartId = await seedThreeLineCart();
		const review = await summary({ cartId });
		expect(review["ok"]).toBe(true);
		const order = resultOf(
			await sandboxHandle.invokeRoute("storefront/order", { orderId: `order-${NS}-public` }),
		);
		expect(order["ok"]).toBe(true);
		// Every `ctx.http` call on this boot throws, so both routes completing is
		// the proof that neither made one — and in particular that nothing reached
		// js.stripe.com: card entry is a BROWSER hop (ADR-0012 decision 3), never
		// plugin egress.
	});
});
