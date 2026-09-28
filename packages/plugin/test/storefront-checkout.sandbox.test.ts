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
 * process over `ctx.storage` — so a scripted commerce reply can no longer be
 * injected anywhere, and every reason this suite asserts now has to be PRODUCED
 * by real data. (The one remaining outside party is Stripe, stubbed on the
 * second boot below.) Each case below therefore arranges the condition (an empty cart, a line
 * with no product reference, a product priced in another currency) instead of
 * declaring the answer, which is a stronger test of the same contract.
 *
 * THE `place` SUCCESS PATH (issue #286). `checkout/place` asks the domain for
 * the `stripe` gateway, which `payments/stripe-wiring.ts` arms only when both
 * Stripe secrets are in kv. The success cases therefore run on a SECOND boot that
 * provisions them and reaches a stubbed Stripe API — see the doc on that
 * describe. On this file's main boot no secret is set, so the gateway is absent
 * and the unconfigured refusal is pinned there: it reaches the caller as the
 * guard's `RENDER_FAILED` with no internals attached, and it leaves the cart and
 * its stock hold exactly as it found them.
 *
 * EGRESS IS STILL ASSERTED, more strictly than before. The MAIN boot declares
 * NO allowed hosts, so any `ctx.http` call from these routes throws — a checkout
 * that completes on that boot reached the network for nothing. That replaces
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
 *    nothing else;
 *  - `checkout/place` creates the order and its PaymentIntent under the form's
 *    idempotency key, hands back only the public fields, and maps every failure
 *    to its typed reason — with the real Stripe gateway armed from kv.
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
	ORDERS_COLLECTION,
	PRODUCT_COMMERCE_COLLECTION,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	startStripeApiStub,
	stripeLikeResponder,
	type StripeApiStub,
} from "./helpers/stripe-api-stub.js";
import {
	loadPluginInSandbox,
	productionAllowedHosts,
	type SandboxHandle,
} from "./sandbox/harness.js";
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

function couponStore(): EmdashCouponStore {
	return new EmdashCouponStore({ storage, idGen: uuidIdGen, clock: systemClock });
}

/** One fixed-amount coupon, seeded through the real store (the admin's own write
 *  path), under a `ck-` id and code so nothing collides with another suite. */
async function seedCoupon(spec: {
	id: string;
	code: string;
	amount: number;
	currency?: string;
	minSubtotalCents?: number;
	expiresAt?: string;
	maxUses?: number;
}): Promise<void> {
	await couponStore().create({
		id: spec.id,
		code: spec.code,
		type: "fixed_amount",
		amountCents: cents(spec.amount),
		rateBps: null,
		capCents: null,
		currency: currency(spec.currency ?? "USD"),
		minSubtotalCents: spec.minSubtotalCents === undefined ? null : cents(spec.minSubtotalCents),
		startsAt: null,
		expiresAt: spec.expiresAt ?? null,
		maxUses: spec.maxUses ?? null,
		maxUsesPerCustomer: null,
	});
}

async function usesOf(code: string): Promise<number> {
	const record = await couponStore().findByCode(code);
	expect(record).not.toBeNull();
	return record!.usesCount;
}

/** The shipping fixtures every selection case prices against. The zone carries a
 *  10% `standard` tax rate that applies to shipping — which is what lets a case
 *  prove a client-supplied zone is IGNORED (it would otherwise add tax). */
const ZONE_ID = `${NS}-zone`;
const METHOD_ID = `${NS}-ship`;
const FREE_METHOD_ID = `${NS}-ship-free`;
const NORATE_METHOD_ID = `${NS}-ship-norate`;
const SHIPPING_CENTS = 599;

async function seedShippingRules(): Promise<void> {
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	await rules.createZone({ id: ZONE_ID, name: "CK zone", regions: null });
	await rules.createMethod({ id: METHOD_ID, zoneId: ZONE_ID, name: "Flat", type: "flat_rate" });
	await rules.createRate({
		methodId: METHOD_ID,
		currency: currency("USD"),
		amountCents: cents(SHIPPING_CENTS),
		minSubtotalCents: null,
	});
	await rules.createMethod({
		id: FREE_METHOD_ID,
		zoneId: ZONE_ID,
		name: "Free over $10",
		type: "free_shipping",
	});
	await rules.createRate({
		methodId: FREE_METHOD_ID,
		currency: currency("USD"),
		amountCents: cents(SHIPPING_CENTS),
		minSubtotalCents: cents(1000),
	});
	// Declared and never priced: the rate-missing refusal.
	await rules.createMethod({
		id: NORATE_METHOD_ID,
		zoneId: ZONE_ID,
		name: "Unpriced",
		type: "flat_rate",
	});
	await new EmdashTaxRulesStore({ storage, clock: systemClock }).createRate({
		id: `${NS}-zone-standard`,
		taxClassId: "standard",
		zoneId: ZONE_ID,
		rateBps: 1000,
		appliesToShipping: true,
	});
}

/** Undo `seedShippingRules`, children first (the store forbids deleting a zone
 *  that still has methods, or a method that still has rates). */
async function removeShippingRules(): Promise<void> {
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	for (const methodId of [METHOD_ID, FREE_METHOD_ID]) {
		expect(await rules.deleteRate(methodId, currency("USD"))).toEqual({ ok: true });
	}
	for (const methodId of [METHOD_ID, FREE_METHOD_ID, NORATE_METHOD_ID]) {
		expect(await rules.deleteMethod(methodId)).toEqual({ ok: true });
	}
	expect(await rules.deleteZone(ZONE_ID)).toEqual({ ok: true });
	expect(
		await new EmdashTaxRulesStore({ storage, clock: systemClock }).deleteRate(
			`${NS}-zone-standard`,
		),
	).toEqual({ ok: true });
}

/** true only while a `useShippingRules` describe is running. */
let shippingRulesSeeded = false;

/**
 * Shipping zones are STORE-WIDE — a zone is not namespaced by cart or product —
 * so a zone seeded for the whole file would be present for every case in it.
 * That is not neutral: #305 part 2 makes "a zone exists" change what a physical
 * cart needs to check out, which would change the #286 success-path cases for a
 * reason that has nothing to do with them. So the rules exist only for the
 * describe that calls this: seeded in its `beforeAll`, removed in its
 * `afterAll` (vitest runs a file's describes sequentially, so no other case
 * overlaps that window), and every case outside asserts it sees no zone.
 */
function useShippingRules(): void {
	beforeAll(async () => {
		await seedShippingRules();
		shippingRulesSeeded = true;
	});
	afterAll(async () => {
		shippingRulesSeeded = false;
		await removeShippingRules();
	});
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
	await seedCoupon({ id: `${NS}-save5`, code: "CK-SAVE5", amount: 500 });
	await seedCoupon({
		id: `${NS}-expired`,
		code: "CK-EXPIRED",
		amount: 500,
		expiresAt: "2020-01-01T00:00:00.000Z",
	});
	await seedCoupon({ id: `${NS}-min`, code: "CK-MIN", amount: 500, minSubtotalCents: 100_000 });
	await seedCoupon({ id: `${NS}-eur`, code: "CK-EUR", amount: 500, currency: "EUR" });
}, 300_000);

afterAll(async () => {
	await sandboxHandle?.close();
});

beforeEach(async () => {
	// Outside a `useShippingRules` describe there is NO zone at all (see its doc).
	// The store is this file's own — vitest's default per-file isolation
	// re-evaluates `storageBridge`'s module state for each file — so "no zone" is a
	// claim about the whole store. Should that ever change, this fails loudly
	// rather than letting another suite's zone leak into these cases.
	if (!shippingRulesSeeded) {
		const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
		expect(await rules.listZones()).toEqual([]);
	}
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

	test.each([["UNPUBLISHED"], ["DELETED"]] as const)(
		"a line whose product was %s after the add surfaces PRODUCT_NOT_PRICED — the old price is never quoted",
		async (lifecycle) => {
			const id = `prod-${NS}-${lifecycle.toLowerCase()}`;
			const sku = `SKU-${NS}-${lifecycle}`;
			await seedProduct({ id, sku, amount: 1400 });
			const cartId = await createCart();
			await addLine(cartId, sku, id, 1);
			expect((await summary({ cartId }))["ok"]).toBe(true);

			if (lifecycle === "UNPUBLISHED") {
				await commerceStore().deactivate(
					toProductId(id),
					idempotencyKey(`unpub-${id}`),
					"2026-02-01T00:00:00.000Z",
				);
			} else {
				await commerceStore().softDelete(toProductId(id), idempotencyKey(`del-${id}`));
			}

			expect(await summary({ cartId })).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
		},
	);

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

/**
 * #305 part 1 — the buyer's SELECTION (coupon, shipping method) through the
 * summary. A rejected selection must NOT bounce the buyer to `/cart` (every
 * `ok: false` summary does — `sites/staging/src/lib/checkout-redirect.ts`), so
 * the route reports it beside totals computed WITHOUT it, and still renders.
 */
describe("storefront/checkout/summary — the buyer's selection (workerd sandbox)", () => {
	useShippingRules();

	type Totals = Record<string, { money: { amount: number } | null; label: string }> & {
		appliedCouponCode: string | null;
		totalExcludesUncalculated: boolean;
	};
	const totalsOf = (result: Record<string, unknown>) => result["totals"] as Totals;

	test("a valid couponCode discounts the quote — and still costs exactly 2 product queries", async () => {
		const cartId = await seedThreeLineCart();
		productQueries.length = 0;

		const result = await summary({ cartId, couponCode: "CK-SAVE5" });

		expect(result["ok"]).toBe(true);
		const totals = totalsOf(result);
		expect(totals["discount"]!.label).toBe("$5.00");
		expect(totals["total"]!.label).toBe("$44.98");
		expect(totals.appliedCouponCode).toBe("CK-SAVE5");
		expect(result["selection"]).toEqual({ couponCode: "CK-SAVE5", shippingMethodId: null });
		expect(result["selectionErrors"]).toEqual({});
		expect(result["orderCreated"]).toBe(false);
		expect(productQueries).toHaveLength(2);
	});

	test("coupon codes are matched case-SENSITIVELY and the typed code is echoed back verbatim", async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId, couponCode: " ck-save5 " });

		expect(result["ok"]).toBe(true);
		expect(result["selectionErrors"]).toEqual({
			coupon: { code: "ck-save5", reason: "COUPON_NOT_FOUND" },
		});
		expect(result["selection"]).toEqual({ couponCode: null, shippingMethodId: null });
	});

	// COUPON_EXHAUSTED is proven by a REAL redemption on the Stripe boot below —
	// never by seeding a cap of zero.
	test.each([
		["COUPON_NOT_FOUND", "CK-NO-SUCH-CODE"],
		["COUPON_NOT_ACTIVE", "CK-EXPIRED"],
		["COUPON_MIN_SUBTOTAL", "CK-MIN"],
		["COUPON_CURRENCY_MISMATCH", "CK-EUR"],
	])(
		"a %s coupon is reported beside the UNDISCOUNTED totals — ok:true, never a bounce to /cart",
		async (reason, code) => {
			const cartId = await seedThreeLineCart();
			const bare = await summary({ cartId });

			const result = await summary({ cartId, couponCode: code });

			expect(result["ok"]).toBe(true);
			expect(result["selectionErrors"]).toEqual({ coupon: { code, reason } });
			expect(result["selection"]).toEqual({ couponCode: null, shippingMethodId: null });
			expect(result["totals"]).toEqual(bare["totals"]);
		},
	);

	test('a shippingMethodId adds its rate as real money; tax stays "Not calculated" (transitional — replaced by #305 part 2)', async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId, shippingMethodId: METHOD_ID });

		expect(result["ok"]).toBe(true);
		const totals = totalsOf(result);
		expect(totals["shipping"]!.label).toBe("$5.99");
		expect(totals["total"]!.label).toBe("$55.97");
		// TRANSITIONAL: no zone is derived until PR 2, so no tax was calculated.
		expect(totals["tax"]).toEqual({ money: null, label: "Not calculated" });
		expect(totals.totalExcludesUncalculated).toBe(true);
		expect(result["selection"]).toEqual({ couponCode: null, shippingMethodId: METHOD_ID });
	});

	test('a method whose free-shipping threshold the cart meets is a COMPUTED $0.00, never "Not calculated"', async () => {
		const cartId = await seedThreeLineCart();

		const totals = totalsOf(await summary({ cartId, shippingMethodId: FREE_METHOD_ID }));

		expect(totals["shipping"]!.money).toMatchObject({ amount: 0 });
		expect(totals["shipping"]!.label).toBe("$0.00");
		expect(totals["total"]!.label).toBe("$49.98");
	});

	test.each([
		["SHIPPING_METHOD_NOT_FOUND", `${NS}-ship-never-declared`],
		["SHIPPING_RATE_NOT_FOUND", NORATE_METHOD_ID],
	])(
		'a %s method is reported, and shipping reads "Not calculated" — ok:true',
		async (reason, shippingMethodId) => {
			const cartId = await seedThreeLineCart();

			const result = await summary({ cartId, shippingMethodId });

			expect(result["ok"]).toBe(true);
			expect(result["selectionErrors"]).toEqual({ shippingMethod: { reason } });
			expect(result["selection"]).toEqual({ couponCode: null, shippingMethodId: null });
			expect(totalsOf(result)["shipping"]).toEqual({ money: null, label: "Not calculated" });
		},
	);

	test("a bad method does not discard a good coupon", async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({
			cartId,
			couponCode: "CK-SAVE5",
			shippingMethodId: `${NS}-ship-never-declared`,
		});

		expect(result["selectionErrors"]).toEqual({
			shippingMethod: { reason: "SHIPPING_METHOD_NOT_FOUND" },
		});
		expect(result["selection"]).toEqual({ couponCode: "CK-SAVE5", shippingMethodId: null });
		expect(totalsOf(result)["total"]!.label).toBe("$44.98");
	});

	test("both selections bad ⇒ both reported, bare totals, and the retry is BOUNDED (1 display read + 3 quotes)", async () => {
		const cartId = await seedThreeLineCart();
		const bare = await summary({ cartId });
		productQueries.length = 0;

		const result = await summary({
			cartId,
			couponCode: "CK-NO-SUCH-CODE",
			shippingMethodId: `${NS}-ship-never-declared`,
		});

		expect(result["selectionErrors"]).toEqual({
			coupon: { code: "CK-NO-SUCH-CODE", reason: "COUPON_NOT_FOUND" },
			shippingMethod: { reason: "SHIPPING_METHOD_NOT_FOUND" },
		});
		expect(result["totals"]).toEqual(bare["totals"]);
		expect(productQueries).toHaveLength(4);
	});

	test('a client-supplied shippingZoneId is IGNORED — a zone with a 10% rate still yields tax "Not calculated" and total = subtotal', async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId, shippingZoneId: ZONE_ID });

		expect(result["ok"]).toBe(true);
		const totals = totalsOf(result);
		expect(totals["tax"]).toEqual({ money: null, label: "Not calculated" });
		expect(totals["total"]!.label).toBe("$49.98");
		expect(JSON.stringify(result)).not.toContain(ZONE_ID);
	});

	test.each([
		["an over-long couponCode", { couponCode: "X".repeat(201) }],
		["a non-string couponCode", { couponCode: 42 }],
		["a shippingMethodId with whitespace", { shippingMethodId: "a b" }],
	])("%s is INVALID_INPUT before any store work", async (_label, extra) => {
		const cartId = await seedThreeLineCart();
		productQueries.length = 0;

		expect(await summary({ cartId, ...extra })).toEqual({ ok: false, error: "INVALID_INPUT" });
		expect(productQueries).toHaveLength(0);
	});
});

describe("storefront/checkout/place (workerd sandbox)", () => {
	/**
	 * UNCONFIGURED, CONTAINED. This boot provisions no Stripe secrets, so no
	 * `stripe` gateway is armed (module doc); the domain refuses the method by
	 * throwing and `renderGuard` collapses that to RENDER_FAILED. Two things
	 * matter about that and are asserted here: the caller is told nothing about
	 * the plugin's insides, and — far more importantly — the buyer's cart is not
	 * damaged on the way out. A refusal that consumed the cart
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
});

/**
 * The `place` SUCCESS PATH — issue #286.
 *
 * These cases were parked as `test.todo` while no `stripe` gateway was wired in
 * process. It is now (`payments/stripe-wiring.ts`), and it arms only when BOTH
 * Stripe secrets are in kv, so this boot provisions them the way an operator does:
 * through the Settings form's own save actions.
 *
 * WHERE STRIPE IS. A configured gateway makes a LIVE `POST /v1/payment_intents`
 * to `api.stripe.com` over `ctx.http`. This boot grants production's own
 * allowlist and sets workerd's global outbound to a local stub, so that request
 * passes the plugin's real allowlist check and then lands on the stub instead of
 * the internet (`helpers/stripe-api-stub.ts`). By default the stub answers the
 * way Stripe does — including its refusals of a non-integer amount, a malformed
 * currency and a reused key with different parameters — so no case can pass on
 * a reply real Stripe would never give. Two cases script the reply outright and
 * say so (an unusual client secret, a 502). Every other condition — a replayed
 * key, a paid order, a lost hold, a checked-out cart — is arranged against the
 * real document store.
 *
 * A SEPARATE BOOT, on purpose. The suites above boot with NO allowed hosts and
 * make the stronger claim that summary and order reads reach the network for
 * nothing. `place` cannot make that claim — creating a PaymentIntent IS egress —
 * so it gets its own isolate rather than widening theirs. Both isolates share the
 * process-scoped document store, which is why carts made through the first boot
 * can be placed through this one.
 *
 * TWO PARKED NAMES DID NOT COME BACK, because neither property exists in process:
 *  - "a reply with NO totals block still places the order — total simply absent".
 *    A service REPLY could omit its totals; an in-process `Order` cannot. On a
 *    pending replay the domain reads `order.totals` to build the PaymentIntent
 *    (`intentInputFor` in `create-order-from-cart.ts`), and on a paid replay the
 *    client's serializer reads it (`serializeOrderSummary` in
 *    `in-process-commerce-client.ts`) — both before the route formats anything,
 *    so a missing block throws first and the route answers RENDER_FAILED. The
 *    route's own containment is still pinned, by the unformattable-total cases.
 *  - "a 400 INVALID_SHIPPING_ADDRESS becomes the typed reason". The route's
 *    parser applies the domain's own address rules (the same required fields,
 *    trimming and caps), so no ship-to the domain would refuse gets past it.
 *    What IS true is pinned instead: such an address is refused as INVALID_INPUT
 *    before an order, a hold adoption or a PaymentIntent exists.
 */
describe("storefront/checkout/place success path (workerd sandbox, Stripe stubbed)", () => {
	const STRIPE_SECRET_KEY = "sk_test_sandbox_NEVER_LEAK";
	const STRIPE_WEBHOOK_SECRET = "whsec_sandbox_NEVER_LEAK";
	const BUYER_REF = "Buyer@Example.com";
	const SHIP_TO = {
		name: "A Buyer",
		line1: "1 Test St",
		city: "Testville",
		postalCode: "12345",
		country: "US",
	};

	let stripeBoot: SandboxHandle;
	let stripe: StripeApiStub;

	beforeAll(async () => {
		// The storage bridge is the ONLY non-Stripe destination this isolate may
		// reach through the stub (see its doc).
		stripe = await startStripeApiStub({ forwardTo: [(await storageBridge()).baseUrl] });
		stripeBoot = await loadPluginInSandbox({
			allowedHosts: productionAllowedHosts(),
			storage: true,
			globalOutbound: stripe.address,
		});
		for (const [action, field, value] of [
			["save-stripe-secret-key", "stripeSecretKey", STRIPE_SECRET_KEY],
			["save-stripe-webhook-secret", "stripeWebhookSecret", STRIPE_WEBHOOK_SECRET],
		] as const) {
			const saved = await stripeBoot.invokeRoute("admin", {
				type: "form_submit",
				action_id: action,
				values: { [field]: value },
			});
			expect(saved).toHaveProperty("result");
		}
	}, 300_000);

	afterAll(async () => {
		await stripeBoot?.close();
		await stripe?.close();
	});

	beforeEach(() => {
		stripe.reset();
	});

	afterEach(() => {
		// A refused forward is a 502 INSIDE the isolate, which a route may report as
		// an ordinary provider failure — so it is asserted here, not left to the case.
		expect(stripe.refused).toEqual([]);
	});

	async function place(input: Record<string, unknown>): Promise<Record<string, unknown>> {
		return resultOf(await stripeBoot.invokeRoute("storefront/checkout/place", input));
	}

	async function placeCart(
		cartId: string,
		extra: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		return place({ cartId, buyerRef: BUYER_REF, idempotencyKey: `checkout:${cartId}`, ...extra });
	}

	async function storedOrder(orderId: string) {
		const order = await orderStore.getById(toOrderId(orderId));
		expect(order).not.toBeNull();
		return order!;
	}

	test("forwards the idempotency key verbatim — one PaymentIntent create per place, a same-key replay returns the SAME order — and stores buyerRef un-rewritten", async () => {
		const cartId = await seedThreeLineCart();

		const first = await placeCart(cartId);

		expect(first, JSON.stringify(first)).toMatchObject({
			ok: true,
			state: "pending",
			alreadyPlaced: false,
		});
		expect(stripe.requests).toHaveLength(1);
		const create = stripe.requests[0]!;
		expect(create.method).toBe("POST");
		expect(create.path).toBe("/v1/payment_intents");
		// The key the form carried is the key Stripe sees — not re-derived, not wrapped.
		expect(create.headers["idempotency-key"]).toBe(`checkout:${cartId}`);
		// ...and the gateway is the one the Settings form armed, not some other key.
		expect(create.headers.authorization).toBe(`Bearer ${STRIPE_SECRET_KEY}`);
		expect(create.form.get("metadata[order_id]")).toBe(first["orderId"]);
		expect(create.form.get("amount")).toBe(String(SUBTOTAL_CENTS));
		expect(create.form.get("currency")).toBe("usd");

		// Case preserved: ADR-0004's guest-order claiming matches on the stored value.
		expect((await storedOrder(first["orderId"] as string)).buyerRef).toBe(BUYER_REF);

		const replay = await placeCart(cartId);
		expect(replay).toMatchObject({ ok: true, orderId: first["orderId"], alreadyPlaced: false });
		// The replay re-issues the create under the SAME key with the SAME parameters,
		// so Stripe's own idempotency hands back the SAME intent (a changed parameter
		// would be a 400 `idempotency_error` from the stub, as from Stripe).
		expect(stripe.requests).toHaveLength(2);
		expect(stripe.requests[1]!.headers["idempotency-key"]).toBe(`checkout:${cartId}`);
		expect(stripe.requests[1]!.form.toString()).toBe(create.form.toString());
		expect(replay["clientAction"]).toEqual(first["clientAction"]);
	});

	test("passes clientAction through UNMODIFIED — the client secret is data in transit", async () => {
		const cartId = await seedThreeLineCart();
		stripe.respondWith(() => ({
			status: 200,
			body: { id: "pi_passthrough", client_secret: "pi_passthrough_secret_AbC+/=" },
		}));

		const result = await placeCart(cartId);

		expect(result["clientAction"]).toEqual({
			kind: "stripe_client_secret",
			clientSecret: "pi_passthrough_secret_AbC+/=",
		});
	});

	test("NEVER echoes the order's private fields (buyerRef / shippingAddress) back to the caller", async () => {
		const cartId = await seedThreeLineCart();

		const result = await placeCart(cartId, { shippingAddress: SHIP_TO });

		expect(result["ok"]).toBe(true);
		expect(Object.keys(result).toSorted()).toEqual(
			["alreadyPlaced", "clientAction", "ok", "orderId", "state", "total"].toSorted(),
		);
		const wire = JSON.stringify(result);
		expect(wire).not.toContain(BUYER_REF);
		expect(wire).not.toContain(SHIP_TO.line1);
		// Nor any Stripe credential, which now lives in the same process.
		expect(wire).not.toContain(STRIPE_SECRET_KEY);
		expect(wire).not.toContain(STRIPE_WEBHOOK_SECRET);
	});

	test("forwards the optional ship-to snapshot (ADR-0009 slice c) — onto the order and onto the PaymentIntent", async () => {
		const cartId = await seedThreeLineCart();

		const result = await placeCart(cartId, { shippingAddress: { ...SHIP_TO, line2: "  " } });

		const order = await storedOrder(result["orderId"] as string);
		expect(order.shippingAddress).toEqual({
			...SHIP_TO,
			// A blank optional is simply absent, never a stored "  ".
			line2: null,
			region: null,
			email: null,
			phone: null,
		});
		const create = stripe.requests[0]!;
		expect(create.form.get("shipping[name]")).toBe(SHIP_TO.name);
		expect(create.form.get("shipping[address][line1]")).toBe(SHIP_TO.line1);
		expect(create.form.get("shipping[address][postal_code]")).toBe(SHIP_TO.postalCode);
		expect(create.form.get("shipping[address][country]")).toBe(SHIP_TO.country);
	});

	test("a REPLAY of an order that has left pending (clientAction none) is alreadyPlaced — not an error, and no new intent", async () => {
		const cartId = await seedThreeLineCart();
		const first = await placeCart(cartId);
		const orderId = first["orderId"] as string;
		expect(await orderStore.markPaid(toOrderId(orderId))).toBe(true);
		stripe.requests.length = 0;

		const replay = await placeCart(cartId);

		expect(replay).toMatchObject({
			ok: true,
			orderId,
			state: "paid",
			alreadyPlaced: true,
			clientAction: { kind: "none" },
		});
		// A paid order has nothing left to pay for: no live provider call is made,
		// so a Stripe outage can never turn this replay into a failure.
		expect(stripe.requests).toHaveLength(0);
	});

	test("returns the ORDER's own total, formatted — the figure the pay button states", async () => {
		const cartId = await seedThreeLineCart();

		const result = await placeCart(cartId);

		expect(result["total"]).toEqual({
			amount: SUBTOTAL_CENTS,
			currency: "USD",
			formatted: "$49.98",
		});
	});

	test("the total honours the requested locale, and falls back rather than failing", async () => {
		const german = await placeCart(await seedThreeLineCart(), { locale: "de-DE" });
		const formatted = (german["total"] as { formatted: string }).formatted;
		// Decimal comma, not the en-US fallback. Matched rather than pinned whole:
		// the space before the symbol differs between ICU versions (NBSP vs NNBSP).
		expect(formatted).toMatch(/^49,98\s\$$/u);
		expect(formatted).not.toBe("$49.98");

		const garbage = await placeCart(await seedThreeLineCart(), { locale: "not a locale!!" });
		expect(garbage["ok"]).toBe(true);
		expect((garbage["total"] as { formatted: string }).formatted).toBe("$49.98");
	});

	test("a REPLAY still carries the total — an order always has one", async () => {
		const cartId = await seedThreeLineCart();
		await placeCart(cartId);

		const replay = await placeCart(cartId);

		expect(replay["total"]).toEqual({
			amount: SUBTOTAL_CENTS,
			currency: "USD",
			formatted: "$49.98",
		});
	});

	/**
	 * THE CONTAINMENT. Formatting the total runs `cents()`/`currency()`, which
	 * throw, and it runs AFTER the order exists. The domain never mints an order
	 * whose totals would fail them, so the condition is arranged the only way it
	 * can arise — a stored order that is not what the current build writes — by
	 * rewriting the document of a PAID order and replaying the place.
	 *
	 * PAID, not pending, on purpose. A pending replay re-sends the totals to Stripe,
	 * which refuses every one of these but the lowercase currency — so on that path
	 * the answer is PAYMENT_INTENT_FAILED and the formatter is never reached. A paid
	 * replay makes no provider call at all, which is the one path where a stored
	 * total reaches the formatter untouched: the place must still succeed, as
	 * `alreadyPlaced`, and only the label is lost.
	 */
	test.each([
		["a lowercase currency", { currency: "usd" }],
		["a symbol for a currency", { currency: "$" }],
		["a fractional total", { total: 4998.5 }],
		["a null total", { total: null }],
	])(
		"an unformattable total (%s) drops the total and keeps the order",
		async (_label, corruption) => {
			const cartId = await seedThreeLineCart();
			const first = await placeCart(cartId);
			const orderId = first["orderId"] as string;
			expect(await orderStore.markPaid(toOrderId(orderId))).toBe(true);
			const orders = storage[ORDERS_COLLECTION]!;
			const doc = (await orders.get(orderId)) as { totals: Record<string, unknown> };
			await orders.put(orderId, { ...doc, totals: { ...doc.totals, ...corruption } });
			stripe.requests.length = 0;

			const replay = await placeCart(cartId);

			expect(replay, JSON.stringify(replay)).toEqual({
				ok: true,
				orderId,
				state: "paid",
				alreadyPlaced: true,
				clientAction: { kind: "none" },
			});
			expect(replay).not.toHaveProperty("total");
			expect(stripe.requests).toHaveLength(0);
		},
	);

	test("a Stripe 502 becomes the typed PAYMENT_INTENT_FAILED, never RENDER_FAILED — and leaks no secret", async () => {
		const cartId = await seedThreeLineCart();
		stripe.respondWith(() => ({ status: 502, body: { error: { code: "api_error" } } }));

		const result = await placeCart(cartId);

		expect(result).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
		// Stripe really was asked, and really said 502: the failure is the provider's
		// answer, not an egress refusal that would produce the same reason.
		expect(stripe.requests).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain(STRIPE_SECRET_KEY);
	});

	test("a second checkout of a placed cart under a NEW key is the typed CART_CHECKED_OUT", async () => {
		const cartId = await seedThreeLineCart();
		expect((await placeCart(cartId))["ok"]).toBe(true);

		const second = await place({
			cartId,
			buyerRef: BUYER_REF,
			idempotencyKey: `checkout:${cartId}:again`,
		});

		expect(second).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
	});

	test("a line whose hold was released before checkout is the typed RESERVATION_LOST", async () => {
		const cartId = await seedThreeLineCart();
		const read = resultOf(await stripeBoot.invokeRoute("storefront/cart/read", { cartId }));
		const lines = (read["cart"] as { lines: { reservationId: string | null }[] }).lines;
		// The hold goes away the way the expiry sweep takes it: released at the store.
		await inventoryStore().release(lines[0]!.reservationId!);

		expect(await placeCart(cartId)).toEqual({ ok: false, reason: "RESERVATION_LOST" });
		expect(stripe.requests).toHaveLength(0);
	});

	test.each([
		["a whitespace-only required field", { ...SHIP_TO, name: "   " }],
		["a field over the domain's cap", { ...SHIP_TO, country: "X".repeat(101) }],
	])(
		"a ship-to the domain would refuse (%s) is refused as INVALID_INPUT before any order or intent exists",
		async (_label, shippingAddress) => {
			const cartId = await seedThreeLineCart();
			orderOps.length = 0;

			expect(await placeCart(cartId, { shippingAddress })).toEqual({
				ok: false,
				error: "INVALID_INPUT",
			});
			expect(orderOps).toEqual([]);
			expect(stripe.requests).toHaveLength(0);
		},
	);

	test("a line with no product reference is the typed PRODUCT_NOT_PRICED — with a gateway armed, not just without one", async () => {
		await inventoryStore().seedOnHand(toSku(`SKU-${NS}-BARE-PLACE`), 5);
		const cartId = await createCart();
		await addLine(cartId, `SKU-${NS}-BARE-PLACE`, null, 1);

		expect(await placeCart(cartId)).toEqual({ ok: false, reason: "PRODUCT_NOT_PRICED" });
		expect(stripe.requests).toHaveLength(0);
	});

	/**
	 * #305 part 1 — the selection at place, and the locked review. Nested so the
	 * store-wide shipping/tax rules exist ONLY for these cases (see
	 * `useShippingRules`); every #286 case above runs with no zone at all.
	 */
	describe("#305 — the selection at place, and the locked review", () => {
		useShippingRules();

		/** The order a place minted, read back from the real store. */
		async function totalsSnapshot(orderId: string) {
			return (await storedOrder(orderId)).totals;
		}

		test("a coupon is redeemed WITH the order: summary total, place total, order total and Stripe amount are the SAME discounted figure", async () => {
			await seedCoupon({ id: `${NS}-place-once`, code: "CK-PLACE-ONCE", amount: 500 });
			const cartId = await seedThreeLineCart();
			const review = await summary({ cartId, couponCode: "CK-PLACE-ONCE" });
			const reviewed = (review["totals"] as { total: { money: { amount: number } } }).total.money;

			const placed = await placeCart(cartId, { couponCode: "CK-PLACE-ONCE" });

			expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true });
			const expected = SUBTOTAL_CENTS - 500;
			expect(reviewed.amount).toBe(expected);
			expect((placed["total"] as { amount: number }).amount).toBe(expected);
			const totals = await totalsSnapshot(placed["orderId"] as string);
			expect(totals.total).toBe(expected);
			expect(totals.appliedCouponCode).toBe("CK-PLACE-ONCE");
			expect(stripe.requests[0]!.form.get("amount")).toBe(String(expected));
			expect(await usesOf("CK-PLACE-ONCE")).toBe(1);
		});

		test("a same-key replay of a coupon checkout neither redeems twice nor fails a maxUses=1 coupon", async () => {
			await seedCoupon({ id: `${NS}-replay-one`, code: "CK-REPLAY-ONE", amount: 500, maxUses: 1 });
			const cartId = await seedThreeLineCart();

			const first = await placeCart(cartId, { couponCode: "CK-REPLAY-ONE" });
			const replay = await placeCart(cartId, { couponCode: "CK-REPLAY-ONE" });

			expect(first["ok"]).toBe(true);
			expect(replay).toMatchObject({ ok: true, orderId: first["orderId"] });
			expect(await usesOf("CK-REPLAY-ONE")).toBe(1);
		});

		test("COUPON_EXHAUSTED by a REAL redemption: once another cart has used the last use, the summary reports it and the place refuses it — no order, no intent, the cart and its hold intact", async () => {
			await seedCoupon({ id: `${NS}-last-use`, code: "CK-LAST-USE", amount: 500, maxUses: 1 });
			const spent = await placeCart(await seedThreeLineCart(), { couponCode: "CK-LAST-USE" });
			expect(spent["ok"]).toBe(true);
			expect(await usesOf("CK-LAST-USE")).toBe(1);
			stripe.requests.length = 0;

			const cartId = await seedThreeLineCart();
			const review = await summary({ cartId, couponCode: "CK-LAST-USE" });
			expect(review["ok"]).toBe(true);
			expect(review["selectionErrors"]).toEqual({
				coupon: { code: "CK-LAST-USE", reason: "COUPON_EXHAUSTED" },
			});

			await expectRefusedAtPlace(cartId, { couponCode: "CK-LAST-USE" }, "COUPON_EXHAUSTED");
		});

		test("an unknown coupon at place is the typed COUPON_NOT_FOUND — no order, no intent, the cart and its hold intact", async () => {
			await expectRefusedAtPlace(
				await seedThreeLineCart(),
				{ couponCode: "CK-NEVER-ISSUED" },
				"COUPON_NOT_FOUND",
			);
		});

		test("an undeclared shippingMethodId at place is the typed SHIPPING_METHOD_NOT_FOUND — no order, no intent", async () => {
			await expectRefusedAtPlace(
				await seedThreeLineCart(),
				{ shippingMethodId: `${NS}-ship-never-declared` },
				"SHIPPING_METHOD_NOT_FOUND",
			);
		});

		async function expectRefusedAtPlace(
			cartId: string,
			extra: Record<string, unknown>,
			reason: string,
		): Promise<void> {
			const before = resultOf(await stripeBoot.invokeRoute("storefront/cart/read", { cartId }));
			const heldBefore = (before["cart"] as { lines: { reservationId: string | null }[] }).lines;

			expect(await placeCart(cartId, extra)).toEqual({ ok: false, reason });

			// Refused BEFORE anything was minted: no order under the checkout key, and
			// no PaymentIntent asked for.
			expect(await orderStore.getByIdempotencyKey(idempotencyKey(`checkout:${cartId}`))).toBeNull();
			expect(stripe.requests).toHaveLength(0);
			const after = resultOf(await stripeBoot.invokeRoute("storefront/cart/read", { cartId }));
			const cart = after["cart"] as {
				state: string;
				orderId: string | null;
				lines: { reservationId: string | null }[];
			};
			expect(cart.state).toBe("active");
			expect(cart.orderId).toBeNull();
			expect(cart.lines.map((l) => l.reservationId)).toEqual(
				heldBefore.map((l) => l.reservationId),
			);
		}

		test("a shippingMethodId's rate reaches the order and the PaymentIntent", async () => {
			const cartId = await seedThreeLineCart();

			const placed = await placeCart(cartId, { shippingMethodId: METHOD_ID });

			expect(placed["ok"]).toBe(true);
			const expected = SUBTOTAL_CENTS + SHIPPING_CENTS;
			const totals = await totalsSnapshot(placed["orderId"] as string);
			expect(totals.shipping).toBe(SHIPPING_CENTS);
			expect(totals.total).toBe(expected);
			expect(stripe.requests[0]!.form.get("amount")).toBe(String(expected));
			// TRANSITIONAL — replaced by #305 part 2 (which derives the zone from the
			// address): the snapshot records the method and NO zone, and no tax.
			expect(totals.shippingMethodSnapshot).toEqual({ zoneId: null, methodId: METHOD_ID });
			expect(totals.tax).toBe(0);
		});

		test("a supplied shippingZoneId is never forwarded: the client's zone reaches neither the order nor its tax", async () => {
			const cartId = await seedThreeLineCart();

			const placed = await placeCart(cartId, {
				shippingMethodId: METHOD_ID,
				shippingZoneId: ZONE_ID,
			});

			expect(placed["ok"]).toBe(true);
			const totals = await totalsSnapshot(placed["orderId"] as string);
			// The zone carries a 10% rate that applies to shipping; had it been
			// forwarded, tax would be non-zero here.
			expect(totals.tax).toBe(0);
			expect((totals.shippingMethodSnapshot as { zoneId: unknown }).zoneId).not.toBe(ZONE_ID);
		});

		test("after PAYMENT_INTENT_FAILED with coupon A, a same-key place with coupon B returns the ORIGINAL order at A's total, and Stripe sees A's identical form", async () => {
			await seedCoupon({ id: `${NS}-a`, code: "CK-A", amount: 500 });
			await seedCoupon({ id: `${NS}-b`, code: "CK-B", amount: 900 });
			const cartId = await seedThreeLineCart();
			const fallback = stripeLikeResponder();
			let first = true;
			stripe.respondWith((req) => {
				if (first) {
					first = false;
					return { status: 502, body: { error: { code: "api_error" } } };
				}
				return fallback(req);
			});

			expect(await placeCart(cartId, { couponCode: "CK-A" })).toEqual({
				ok: false,
				reason: "PAYMENT_INTENT_FAILED",
			});
			const retry = await placeCart(cartId, { couponCode: "CK-B" });

			expect(retry["ok"]).toBe(true);
			expect((retry["total"] as { amount: number }).amount).toBe(SUBTOTAL_CENTS - 500);
			expect(stripe.requests).toHaveLength(2);
			expect(stripe.requests[1]!.form.toString()).toBe(stripe.requests[0]!.form.toString());
			expect(await usesOf("CK-B")).toBe(0);
		});

		/**
		 * THE LOCKED REVIEW. Once the cart has become an order, the review page states
		 * the ORDER — the same-key place replays it and ignores any new selection, so
		 * a review re-quoted from the cart would show a figure nobody will charge.
		 */
		test("the summary of a cart that became a PENDING order is LOCKED to the order: its totals, its coupon, a different input coupon ignored", async () => {
			await seedCoupon({ id: `${NS}-lock`, code: "CK-LOCK", amount: 500 });
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId, { couponCode: "CK-LOCK" });
			productQueries.length = 0;

			const locked = await summary({ cartId, couponCode: "CK-SAVE5", shippingMethodId: METHOD_ID });

			expect(locked, JSON.stringify(locked)).toMatchObject({
				ok: true,
				orderCreated: true,
				order: { id: placed["orderId"], state: "pending", phase: "payable" },
				selection: { couponCode: "CK-LOCK", shippingMethodId: null },
				selectionErrors: {},
				idempotencyKey: `checkout:${cartId}`,
				hasUnpricedLines: false,
			});
			const totals = locked["totals"] as Record<string, { label: string }>;
			expect(totals["total"]!.label).toBe("$44.98");
			expect(totals["discount"]!.label).toBe("$5.00");
			// The lines are the ORDER's snapshot, not a live re-join.
			const lines = locked["lines"] as {
				sku: string;
				qty: number;
				lineTotal: { formatted: string };
			}[];
			// (The store's line order, not the cart's — so compared as a set.)
			expect(lines.map((l) => `${l.sku}×${String(l.qty)}`).toSorted()).toEqual([
				`${LINE_SKUS[0]!}×1`,
				`${LINE_SKUS[1]!}×2`,
				`${LINE_SKUS[2]!}×3`,
			]);
			expect(lines.find((l) => l.sku === LINE_SKUS[1])!.lineTotal.formatted).toBe("$20.00");
			// Nothing was priced from the live catalogue at all.
			expect(productQueries).toHaveLength(0);
		});

		test("a locked summary survives the product being unpublished AFTER the order — it renders the order, not PRODUCT_NOT_PRICED", async () => {
			const id = `prod-${NS}-locked-unpub`;
			const sku = `SKU-${NS}-LOCKED-UNPUB`;
			await seedProduct({ id, sku, amount: 1400 });
			const cartId = await createCart();
			await addLine(cartId, sku, id, 1);
			expect((await placeCart(cartId))["ok"]).toBe(true);
			await commerceStore().deactivate(
				toProductId(id),
				idempotencyKey(`unpub-${id}`),
				"2026-02-01T00:00:00.000Z",
			);

			const locked = await summary({ cartId });

			expect(locked).toMatchObject({ ok: true, orderCreated: true, order: { phase: "payable" } });
			expect((locked["totals"] as Record<string, { label: string }>)["total"]!.label).toBe(
				"$14.00",
			);
		});

		test("a locked summary whose order was PAID answers phase 'placed' — the site sends the buyer to the confirmation", async () => {
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId);
			expect(await orderStore.markPaid(toOrderId(placed["orderId"] as string))).toBe(true);

			expect(await summary({ cartId })).toMatchObject({
				ok: true,
				orderCreated: true,
				order: { id: placed["orderId"], state: "paid", phase: "placed" },
			});
		});

		test("a locked summary whose order EXPIRED answers phase 'ended' — the cart is not reopened, so the only way on is a new cart", async () => {
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId);
			// Expired through the store's own guarded flip — a `now` past the hold.
			expect(
				await orderStore.expire(toOrderId(placed["orderId"] as string), "2999-01-01T00:00:00.000Z"),
			).toBe(true);

			const locked = await summary({ cartId });

			expect(locked).toMatchObject({
				ok: true,
				orderCreated: true,
				order: { id: placed["orderId"], state: "expired", phase: "ended" },
			});
			// `expireOrders` does not reopen the cart.
			const read = resultOf(await sandboxHandle.invokeRoute("storefront/cart/read", { cartId }));
			expect((read["cart"] as { state: string }).state).not.toBe("active");
		});

		test("a locked summary whose PAID order was then CANCELLED answers phase 'placed' — never 'ended': a cancelled order may have been charged", async () => {
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId);
			const orderId = toOrderId(placed["orderId"] as string);
			expect(await orderStore.markPaid(orderId)).toBe(true);
			const cancelled = await orderStore.cancelOrder({
				orderId,
				fromState: "paid",
				reason: "out_of_stock",
				detail: null,
				cancelledBy: "ops",
				idempotencyKey: idempotencyKey(`cx-${cartId}`),
				enqueueEmail: false,
			});
			expect(cancelled.cancelled).toBe(true);

			expect(await summary({ cartId })).toMatchObject({
				ok: true,
				orderCreated: true,
				order: { id: placed["orderId"], state: "cancelled", phase: "placed" },
			});
		});

		test("a checked-out cart whose order cannot be read degrades to the typed CART_CHECKED_OUT — never RENDER_FAILED", async () => {
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId);
			// The order row is gone (a purge, a restore from an older backup): the cart
			// still names it, and it can never be paid.
			await storage[ORDERS_COLLECTION]!.delete(placed["orderId"] as string);

			expect(await summary({ cartId })).toEqual({ ok: false, reason: "CART_CHECKED_OUT" });
		});

		test('storefront/order for an order placed with a method states shipping as money and tax "Not calculated" (transitional — replaced by #305 part 2)', async () => {
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId, { shippingMethodId: METHOD_ID });

			const read = resultOf(
				await sandboxHandle.invokeRoute("storefront/order", { orderId: placed["orderId"] }),
			);

			expect(read["ok"]).toBe(true);
			const totals = (
				read["order"] as { totals: Record<string, { money: unknown; label: string }> }
			).totals;
			expect(totals["shipping"]!.label).toBe("$5.99");
			expect(totals["total"]!.label).toBe("$55.97");
			expect(totals["tax"]).toEqual({ money: null, label: "Not calculated" });
		});
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
