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
import { signStripeWebhook } from "@otta-sh/payments-stripe";
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
	type StripeRecordedRequest,
	type StripeResponder,
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

/** The shipping fixtures every selection case prices against. The zone matches
 *  the US (ADR-0021: the zone is derived from the destination) and carries a 10%
 *  `standard` tax rate that applies to shipping — which is what lets a case prove
 *  a client-supplied zone is IGNORED (it would otherwise add tax). */
const ZONE_ID = `${NS}-zone`;
const METHOD_ID = `${NS}-ship`;
const FREE_METHOD_ID = `${NS}-ship-free`;
const NORATE_METHOD_ID = `${NS}-ship-norate`;
const SHIPPING_CENTS = 599;

async function seedShippingRules(): Promise<void> {
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	await rules.createZone({ id: ZONE_ID, name: "CK zone", regions: ["US"] });
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

/** A delete that removed the row, or found it already gone. */
function gone(result: { ok: boolean; reason?: string }): boolean {
	return result.ok || result.reason === "not_found";
}

/** Undo `seedShippingRules`, children first (the store forbids deleting a zone
 *  that still has methods, or a method that still has rates). TOLERANT of a
 *  partial seed — it deletes what exists — so a seed failure is reported once,
 *  at its source; the store-wide "no zone left" check below is what must hold. */
async function removeShippingRules(): Promise<void> {
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	for (const methodId of [METHOD_ID, FREE_METHOD_ID]) {
		expect(gone(await rules.deleteRate(methodId, currency("USD")))).toBe(true);
	}
	for (const methodId of [METHOD_ID, FREE_METHOD_ID, NORATE_METHOD_ID]) {
		expect(gone(await rules.deleteMethod(methodId))).toBe(true);
	}
	expect(gone(await rules.deleteZone(ZONE_ID))).toBe(true);
	expect(
		gone(
			await new EmdashTaxRulesStore({ storage, clock: systemClock }).deleteRate(
				`${NS}-zone-standard`,
			),
		),
	).toBe(true);
	expect(await rules.listZones()).toEqual([]);
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
function useShippingRules(
	seed: () => Promise<void> = seedShippingRules,
	remove: () => Promise<void> = removeShippingRules,
): void {
	beforeAll(async () => {
		await seed();
		shippingRulesSeeded = true;
	});
	afterAll(async () => {
		shippingRulesSeeded = false;
		await remove();
	});
}

/**
 * #305 part 2 (ADR-0021) — the zone DERIVED from the destination. Four zones,
 * each shaped for one question the summary must answer:
 *  - US (0% tax): TWO priced methods — nothing to preselect;
 *  - US-CA (7.25%): ONE priced method — preselected; beats US for a CA address;
 *  - DE (19%): one priced and one unpriced method — nothing to preselect, the
 *    unpriced one shown disabled;
 *  - FR: only an unpriced method — "no delivery options for this address".
 * Every cart priced against it is ONE line of 2 × $15.00 (see `p2Cart`), so the
 * per-line half-up rounding is visible: 7.25% of 3000 = 217.5 → 218.
 */
const P2 = {
	US: `${NS}-p2-us`,
	CA: `${NS}-p2-ca`,
	DE: `${NS}-p2-de`,
	FR: `${NS}-p2-fr`,
	US_STD: `${NS}-p2-us-std`,
	US_EXP: `${NS}-p2-us-exp`,
	CA_STD: `${NS}-p2-ca-std`,
	DE_STD: `${NS}-p2-de-std`,
	DE_NORATE: `${NS}-p2-de-norate`,
	FR_NORATE: `${NS}-p2-fr-norate`,
} as const;

const P2_ZONES: ReadonlyArray<{
	id: string;
	regions: string[];
	taxBps: number | null;
	methods: ReadonlyArray<{ id: string; name: string; amount: number | null }>;
}> = [
	{
		id: P2.US,
		regions: ["US"],
		taxBps: 0,
		methods: [
			{ id: P2.US_STD, name: "US Standard", amount: 499 },
			{ id: P2.US_EXP, name: "US Express", amount: 999 },
		],
	},
	{
		id: P2.CA,
		regions: ["US-CA"],
		taxBps: 725,
		methods: [{ id: P2.CA_STD, name: "California Standard", amount: 599 }],
	},
	{
		id: P2.DE,
		regions: ["DE"],
		taxBps: 1900,
		methods: [
			{ id: P2.DE_STD, name: "DHL", amount: 900 },
			{ id: P2.DE_NORATE, name: "Courier", amount: null },
		],
	},
	{
		id: P2.FR,
		regions: ["FR"],
		taxBps: null,
		methods: [{ id: P2.FR_NORATE, name: "Colissimo", amount: null }],
	},
];

async function seedZoneFixture(): Promise<void> {
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	const tax = new EmdashTaxRulesStore({ storage, clock: systemClock });
	for (const zone of P2_ZONES) {
		await rules.createZone({ id: zone.id, name: zone.id, regions: zone.regions });
		for (const method of zone.methods) {
			await rules.createMethod({
				id: method.id,
				zoneId: zone.id,
				name: method.name,
				type: "flat_rate",
			});
			if (method.amount !== null) {
				await rules.createRate({
					methodId: method.id,
					currency: currency("USD"),
					amountCents: cents(method.amount),
					minSubtotalCents: null,
				});
			}
		}
		if (zone.taxBps !== null) {
			await tax.createRate({
				id: `${zone.id}-standard`,
				taxClassId: "standard",
				zoneId: zone.id,
				rateBps: zone.taxBps,
				appliesToShipping: false,
			});
		}
	}
}

async function removeZoneFixture(): Promise<void> {
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	const tax = new EmdashTaxRulesStore({ storage, clock: systemClock });
	for (const zone of P2_ZONES) {
		for (const method of zone.methods) {
			expect(gone(await rules.deleteRate(method.id, currency("USD")))).toBe(true);
			expect(gone(await rules.deleteMethod(method.id))).toBe(true);
		}
		expect(gone(await rules.deleteZone(zone.id))).toBe(true);
		expect(gone(await tax.deleteRate(`${zone.id}-standard`))).toBe(true);
	}
	expect(await rules.listZones()).toEqual([]);
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
	readonly productKind?: "physical" | "digital";
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
			...(product.productKind !== undefined ? { productKind: product.productKind } : {}),
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

/** The delivery options a summary offered. */
function optionsOf(result: Record<string, unknown>): Array<Record<string, unknown>> {
	return (result["shipping"] as { options: Array<Record<string, unknown>> }).options;
}

/** The part-2 carts: ONE line of 2 × $15.00, physical or digital. */
const P2_PRODUCT = { id: `prod-${NS}-p2`, sku: `SKU-${NS}-P2` } as const;
const P2_DIGITAL = { id: `prod-${NS}-p2-dig`, sku: `SKU-${NS}-P2-DIG` } as const;

async function p2Cart(kind: "physical" | "digital" = "physical"): Promise<string> {
	const product = kind === "physical" ? P2_PRODUCT : P2_DIGITAL;
	const cartId = await createCart();
	await addLine(cartId, product.sku, product.id, 2);
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
	await seedProduct({ id: P2_PRODUCT.id, sku: P2_PRODUCT.sku, amount: 1500 });
	await seedProduct({
		id: P2_DIGITAL.id,
		sku: P2_DIGITAL.sku,
		amount: 1500,
		productKind: "digital",
	});
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

/** Is this the Stripe cancel of a PaymentIntent? */
const isCancel = (req: StripeRecordedRequest) =>
	req.method === "POST" && /^\/v1\/payment_intents\/[^/]+\/cancel$/.test(req.path);

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
			title: string | null;
			qty: number;
			lineTotal: { formatted: string };
		}[];
		expect(lines).toHaveLength(3);
		const first = lines.find((l) => l.sku === LINE_SKUS[0]);
		// Named off the same batch read the pricing join made — the title the
		// order will snapshot — so the review never shows a bare SKU as a name.
		expect(first).toMatchObject({ qty: 1, title: "Bamboo Water Bottle" });
		expect(first!.lineTotal.formatted).toBe("$19.99");
		expect(result["hasUnpricedLines"]).toBe(false);
	});

	test("a store with NO zones: nothing to collect, ready to place, delivery 'no_zones' (ADR-0021 Decision 4)", async () => {
		const result = await summary({ cartId: await seedThreeLineCart() });

		expect(result).toMatchObject({
			ok: true,
			requiresShipping: true,
			shipping: { status: "no_zones", matchedRegion: null, noOptions: false, options: [] },
			addressRequired: false,
			readyToPlace: true,
			uncalculatedReason: "no_zones",
			selection: { destination: null },
		});
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
		expect(result["selection"]).toEqual({
			couponCode: "CK-SAVE5",
			shippingMethodId: null,
			destination: null,
		});
		expect(result["selectionErrors"]).toEqual({});
		expect(result["orderCreated"]).toBe(false);
		expect(productQueries).toHaveLength(2);
	});

	test("coupon codes are matched case-INSENSITIVELY — the typed code is trimmed and the merchant's spelling is what applies", async () => {
		// ONE RULE FOR CODES (the `CouponStore.findByCode` port doc): codes are
		// unique after case folding and the admin search was already
		// case-insensitive, so checkout refusing `ck-save5` for `CK-SAVE5` was the
		// one place the rule split. The DISCOUNT carries the coupon's own spelling —
		// that is what the order snapshots and what the buyer sees applied.
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId, couponCode: " ck-save5 " });

		expect(result["ok"]).toBe(true);
		expect(result["selectionErrors"]).toEqual({});
		const totals = totalsOf(result);
		expect(totals["discount"]!.label).toBe("$5.00");
		expect(totals.appliedCouponCode).toBe("CK-SAVE5");
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
			expect(result["selection"]).toEqual({
				couponCode: null,
				shippingMethodId: null,
				destination: null,
			});
			expect(result["totals"]).toEqual(bare["totals"]);
		},
	);

	/** The destination every method case below prices for: the US, which the
	 *  fixture zone matches (ADR-0021). */
	const US = { country: "US" };

	// INVERTS PR 1's transitional "a shippingMethodId adds its rate; tax stays
	// Not calculated": the zone is now derived from the destination, so a method
	// with none is refused, and with one BOTH shipping and tax are computed.
	test("a shippingMethodId with NO destination is refused MISSING_SHIPPING_ADDRESS — ok:true, nothing computed", async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId, shippingMethodId: METHOD_ID });

		expect(result["ok"]).toBe(true);
		expect(result["selectionErrors"]).toEqual({
			shippingMethod: { reason: "MISSING_SHIPPING_ADDRESS" },
		});
		const totals = totalsOf(result);
		expect(totals["shipping"]).toEqual({ money: null, label: "Not calculated" });
		expect(totals["tax"]).toEqual({ money: null, label: "Not calculated" });
		expect(result).toMatchObject({
			shipping: { status: "address_needed", options: [] },
			addressRequired: true,
			readyToPlace: false,
			uncalculatedReason: "address_needed",
		});
	});

	test("a shippingMethodId WITH a destination: shipping and the matched zone's tax are both real money", async () => {
		const cartId = await seedThreeLineCart();

		const result = await summary({ cartId, destination: US, shippingMethodId: METHOD_ID });

		expect(result["ok"]).toBe(true);
		const totals = totalsOf(result);
		expect(totals["shipping"]!.label).toBe("$5.99");
		// 10% per line, half-up: 199.9 → 200, 200, 99.9 → 100; plus 10% of the
		// 599 shipping (the rate applies to shipping) = 59.9 → 60. 560 in all.
		expect(totals["tax"]!.label).toBe("$5.60");
		expect(totals["total"]!.label).toBe("$61.57");
		expect(totals.totalExcludesUncalculated).toBe(false);
		expect(result["selection"]).toEqual({
			couponCode: null,
			shippingMethodId: METHOD_ID,
			destination: { country: "US", region: null },
		});
		expect(result).toMatchObject({
			shipping: { status: "matched", matchedRegion: "US", noOptions: false },
			readyToPlace: true,
			uncalculatedReason: null,
		});
	});

	test('a method whose free-shipping threshold the cart meets is a COMPUTED $0.00, never "Not calculated"', async () => {
		const cartId = await seedThreeLineCart();

		const totals = totalsOf(
			await summary({ cartId, destination: US, shippingMethodId: FREE_METHOD_ID }),
		);

		expect(totals["shipping"]!.money).toMatchObject({ amount: 0 });
		expect(totals["shipping"]!.label).toBe("$0.00");
		expect(totals["total"]!.label).toBe("$54.98");
	});

	test.each([
		["SHIPPING_METHOD_NOT_FOUND", `${NS}-ship-never-declared`],
		["SHIPPING_RATE_NOT_FOUND", NORATE_METHOD_ID],
	])(
		'a %s method is reported, and shipping reads "Not calculated" — ok:true',
		async (reason, shippingMethodId) => {
			const cartId = await seedThreeLineCart();

			const result = await summary({ cartId, destination: US, shippingMethodId });

			expect(result["ok"]).toBe(true);
			expect(result["selectionErrors"]).toEqual({ shippingMethod: { reason } });
			expect(result["selection"]).toEqual({
				couponCode: null,
				shippingMethodId: null,
				destination: { country: "US", region: null },
			});
			expect(totalsOf(result)["shipping"]).toEqual({ money: null, label: "Not calculated" });
		},
	);

	test("a bad method does not discard a good coupon", async () => {
		const cartId = await seedThreeLineCart();
		const couponOnly = await summary({ cartId, destination: US, couponCode: "CK-SAVE5" });

		const result = await summary({
			cartId,
			destination: US,
			couponCode: "CK-SAVE5",
			shippingMethodId: `${NS}-ship-never-declared`,
		});

		expect(result["selectionErrors"]).toEqual({
			shippingMethod: { reason: "SHIPPING_METHOD_NOT_FOUND" },
		});
		expect(result["selection"]).toMatchObject({ couponCode: "CK-SAVE5", shippingMethodId: null });
		expect(result["totals"]).toEqual(couponOnly["totals"]);
		expect(totalsOf(result).appliedCouponCode).toBe("CK-SAVE5");
	});

	test("both selections bad ⇒ both reported, bare totals, and the retry is BOUNDED (1 display read + 3 quotes)", async () => {
		const cartId = await seedThreeLineCart();
		const bare = await summary({ cartId, destination: US });
		productQueries.length = 0;

		const result = await summary({
			cartId,
			destination: US,
			couponCode: "CK-NO-SUCH-CODE",
			shippingMethodId: `${NS}-ship-never-declared`,
		});

		expect(result["selectionErrors"]).toEqual({
			coupon: { code: "CK-NO-SUCH-CODE", reason: "COUPON_NOT_FOUND" },
			shippingMethod: { reason: "SHIPPING_METHOD_NOT_FOUND" },
		});
		expect(result["totals"]).toEqual(bare["totals"]);
		// The zone has three methods, so nothing is preselected: no fourth quote.
		expect(productQueries).toHaveLength(4);
	});

	test('a client-supplied shippingZoneId is IGNORED — with no destination, a zone with a 10% rate still yields tax "Not calculated" and total = subtotal', async () => {
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

/**
 * #305 part 2 (ADR-0021) — the review priced for a DESTINATION: the zone is
 * derived from it, tax follows it, the matched zone's options are offered, and
 * a lone priced option is preselected. See `P2_ZONES` for the fixture.
 */
/** A summary's selection refusals. */
const selectionErrorsOf = (result: Record<string, unknown>): unknown => result["selectionErrors"];

describe("storefront/checkout/summary — the zone derived from the destination (workerd sandbox)", () => {
	useShippingRules(seedZoneFixture, removeZoneFixture);

	type Totals = Record<string, { money: { amount: number } | null; label: string }>;
	const totalsOf = (result: Record<string, unknown>) => result["totals"] as Totals;

	test("storeCountry: with no tax base address, the first zone's (by id: the US-CA zone ⇒ US) — what the review preselects", async () => {
		const result = await summary({ cartId: await p2Cart() });
		expect(result["storeCountry"]).toBe("US");
	});

	test("a state of a country SHIPPED to only by state is refused for its region (blames: region); a tax-only state zone, or a country nobody serves, is not", async () => {
		const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
		const ON = `${NS}-p2-ca-on`;
		const ON_STD = `${NS}-p2-ca-on-std`;
		await rules.createZone({ id: ON, name: "Ontario", regions: ["CA-ON"] });
		try {
			const cartId = await p2Cart();
			// A state zone with NO methods (one that only carries a tax rate) ships
			// nowhere: the refusal is about the country, in the country's words.
			expect(
				selectionErrorsOf(await summary({ cartId, destination: { country: "CA", region: "QC" } })),
			).toEqual({
				destination: { reason: "SHIPPING_ZONE_NOT_MATCHED" },
			});
			await rules.createMethod({ id: ON_STD, zoneId: ON, name: "Ontario Post", type: "flat_rate" });
			expect(
				selectionErrorsOf(await summary({ cartId, destination: { country: "CA", region: "QC" } })),
			).toEqual({
				destination: { reason: "SHIPPING_ZONE_NOT_MATCHED", blames: "region" },
			});
			expect(
				selectionErrorsOf(await summary({ cartId, destination: { country: "JP", region: "13" } })),
			).toEqual({
				destination: { reason: "SHIPPING_ZONE_NOT_MATCHED" },
			});
			await rules.deleteMethod(ON_STD);
		} finally {
			await rules.deleteZone(ON);
		}
	});

	test("B1: (US, CA) matches US-CA over US; its ONE option is preselected; 3000 + 599 + 218 = $38.17", async () => {
		const cartId = await p2Cart();

		const result = await summary({ cartId, destination: { country: "us", region: "ca" } });

		expect(result, JSON.stringify(result)).toMatchObject({
			ok: true,
			shipping: { status: "matched", matchedRegion: "US-CA", noOptions: false },
			selection: {
				shippingMethodId: P2.CA_STD,
				destination: { country: "US", region: "CA" },
			},
			selectionErrors: {},
			addressRequired: true,
			readyToPlace: true,
			uncalculatedReason: null,
		});
		expect(result["selectionErrors"]).toEqual({});
		expect(optionsOf(result)).toEqual([
			{
				id: P2.CA_STD,
				label: "California Standard",
				price: "$5.99",
				disabled: false,
				selected: true,
			},
		]);
		const totals = totalsOf(result);
		expect(totals["shipping"]!.label).toBe("$5.99");
		expect(totals["tax"]!.label).toBe("$2.18");
		expect(totals["total"]!.label).toBe("$38.17");
	});

	test.each([
		[{ country: "US", region: "XX" }, "SHIPPING_REGION_CODE_REQUIRED"],
		// Real subdivisions of ANOTHER country: the pick list only offers the
		// address's own, and the server still refuses anything else.
		[{ country: "US", region: "ON" }, "SHIPPING_REGION_CODE_REQUIRED"],
		[{ country: "US", region: "MX-CA" }, "SHIPPING_REGION_CODE_REQUIRED"],
		[{ country: "US" }, "SHIPPING_REGION_CODE_REQUIRED"],
		[{ country: "JP" }, "SHIPPING_ZONE_NOT_MATCHED"],
		[{ country: "ZZ" }, "INVALID_SHIPPING_ADDRESS"],
	])(
		"%j → ok:true, address_needed, and a destination notice %s (never RENDER_FAILED)",
		async (destination, reason) => {
			const result = await summary({ cartId: await p2Cart(), destination });

			expect(result).toMatchObject({
				ok: true,
				shipping: { status: "address_needed", options: [] },
				selectionErrors: { destination: { reason } },
				selection: { destination: null, shippingMethodId: null },
				addressRequired: true,
				readyToPlace: false,
			});
		},
	);

	test("a region that is not even code-shaped (DE, Bavaria) is INVALID_INPUT before any store work", async () => {
		const cartId = await p2Cart();
		productQueries.length = 0;

		expect(await summary({ cartId, destination: { country: "DE", region: "Bavaria" } })).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
		expect(productQueries).toHaveLength(0);
	});

	test("B3: a destination in DE with a US method → matched DE, DE's options, SHIPPING_METHOD_NOT_IN_ZONE, DE's 19% tax", async () => {
		const result = await summary({
			cartId: await p2Cart(),
			destination: { country: "DE" },
			shippingMethodId: P2.US_STD,
		});

		expect(result).toMatchObject({
			ok: true,
			shipping: { status: "matched", matchedRegion: "DE" },
			selectionErrors: { shippingMethod: { reason: "SHIPPING_METHOD_NOT_IN_ZONE" } },
			selection: { shippingMethodId: null },
			readyToPlace: false,
			uncalculatedReason: "method_needed",
		});
		expect(optionsOf(result).map((o) => o["id"])).toEqual([P2.DE_NORATE, P2.DE_STD]);
		expect(totalsOf(result)["tax"]!.label).toBe("$5.70");
		expect(totalsOf(result)["shipping"]).toEqual({ money: null, label: "Not calculated" });
	});

	describe("the single-option preselect", () => {
		test("two priced options (US) → nothing preselected", async () => {
			const result = await summary({
				cartId: await p2Cart(),
				destination: { country: "US", region: "TX" },
			});

			expect(result).toMatchObject({ selection: { shippingMethodId: null }, readyToPlace: false });
			expect(optionsOf(result).every((o) => o["selected"] === false)).toBe(true);
		});

		test("one priced + one unpriced (DE) → nothing preselected, the unpriced one disabled", async () => {
			const result = await summary({ cartId: await p2Cart(), destination: { country: "DE" } });

			expect(result).toMatchObject({ selection: { shippingMethodId: null } });
			expect(optionsOf(result)).toEqual([
				{
					id: P2.DE_NORATE,
					label: "Courier",
					price: "Unavailable",
					disabled: true,
					selected: false,
				},
				{ id: P2.DE_STD, label: "DHL", price: "$9.00", disabled: false, selected: false },
			]);
		});

		test("an explicit valid method is never overridden", async () => {
			const result = await summary({
				cartId: await p2Cart(),
				destination: { country: "US", region: "TX" },
				shippingMethodId: P2.US_EXP,
			});

			expect(result).toMatchObject({
				selection: { shippingMethodId: P2.US_EXP },
				readyToPlace: true,
			});
			expect(totalsOf(result)["shipping"]!.label).toBe("$9.99");
		});

		test("a method dropped as NOT_IN_ZONE and then filled by the preselect raises NO notice — the delivery line states the truth", async () => {
			const result = await summary({
				cartId: await p2Cart(),
				destination: { country: "US", region: "CA" },
				shippingMethodId: P2.US_STD,
			});

			expect(result).toMatchObject({
				selection: { shippingMethodId: P2.CA_STD },
				readyToPlace: true,
			});
			// `toEqual`, not `toMatchObject`: an empty object matches anything.
			expect(result["selectionErrors"]).toEqual({});
		});
	});

	test("a matched zone with NO priced option (FR): noOptions, not ready to place — and no preselect is even attempted", async () => {
		const cartId = await p2Cart();
		productQueries.length = 0;
		const result = await summary({ cartId, destination: { country: "FR" } });
		// 1 display join + 1 quote: a lone UNPRICED option is never tried.
		expect(productQueries).toHaveLength(2);

		expect(result).toMatchObject({
			ok: true,
			shipping: { status: "matched", matchedRegion: "FR", noOptions: true },
			selection: { shippingMethodId: null },
			addressRequired: true,
			readyToPlace: false,
		});
		expect(optionsOf(result)).toEqual([
			{
				id: P2.FR_NORATE,
				label: "Colissimo",
				price: "Unavailable",
				disabled: true,
				selected: false,
			},
		]);
	});

	test("the truth table: addressRequired / readyToPlace by delivery status", async () => {
		const physical = await p2Cart();
		const digital = await p2Cart("digital");
		const rows = [
			[await summary({ cartId: physical }), "address_needed", true, false],
			[
				await summary({ cartId: physical, destination: { country: "US", region: "TX" } }),
				"matched",
				true,
				false,
			],
			[
				await summary({
					cartId: physical,
					destination: { country: "US", region: "TX" },
					shippingMethodId: P2.US_STD,
				}),
				"matched",
				true,
				true,
			],
			[await summary({ cartId: physical, destination: { country: "FR" } }), "matched", true, false],
			[await summary({ cartId: digital }), "not_required", false, true],
		] as const;
		for (const [result, status, addressRequired, readyToPlace] of rows) {
			expect(result).toMatchObject({
				ok: true,
				shipping: { status },
				addressRequired,
				readyToPlace,
			});
		}
		// (no_zones is the store-without-zones summary case above.)
	});

	test("a digital-only cart: a stale shippingMethodId is dropped SILENTLY (D10); nothing ships and no tax is calculated", async () => {
		const result = await summary({
			cartId: await p2Cart("digital"),
			destination: { country: "DE" },
			shippingMethodId: P2.DE_STD,
		});

		expect(result).toMatchObject({
			ok: true,
			requiresShipping: false,
			shipping: { status: "not_required", options: [] },
			selection: { shippingMethodId: null },
			selectionErrors: {},
			addressRequired: false,
			readyToPlace: true,
			uncalculatedReason: "digital_only",
		});
		expect(result["selectionErrors"]).toEqual({});
		expect(totalsOf(result)["tax"]).toEqual({ money: null, label: "Not calculated" });
	});

	test("the WORST fallback path is bounded: method NOT_IN_ZONE → coupon refused → bare → preselect = 4 quotes, 5 product reads", async () => {
		const cartId = await p2Cart();
		productQueries.length = 0;

		const result = await summary({
			cartId,
			destination: { country: "US", region: "CA" },
			shippingMethodId: P2.US_STD,
			couponCode: "CK-NO-SUCH-CODE",
		});

		expect(result).toMatchObject({
			ok: true,
			selection: { shippingMethodId: P2.CA_STD, couponCode: null },
			selectionErrors: { coupon: { code: "CK-NO-SUCH-CODE", reason: "COUPON_NOT_FOUND" } },
		});
		// 1 display join + 4 quotes, each ONE batched read.
		expect(productQueries).toHaveLength(5);
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

	/**
	 * Review R3-B X1, over the real wire: `JSON.parse` keeps a lone UTF-16
	 * surrogate (and U+0000), and Postgres's `jsonb` cannot read either back — one
	 * stored copy used to make every order query fail. The route refuses them
	 * before anything is read or written: a ship-to field is the buyer's address to
	 * retype (INVALID_SHIPPING_ADDRESS, as an over-long field is); anything else is
	 * a malformed call (INVALID_INPUT).
	 */
	const WF_BASE = { cartId: "cart-wf", buyerRef: "a@b.co", idempotencyKey: "checkout:cart-wf" };
	const WF_ADDRESS = {
		name: "Asha Rao",
		line1: "12 Park Street",
		city: "Kolkata",
		postalCode: "700016",
		country: "IN",
	};
	test.each([
		["a lone high surrogate in the city", { city: "Kolkata\uD800" }],
		["a lone low surrogate in the name", { name: "\uDC00Asha" }],
		["a NUL in line 1", { line1: "12 Park\u0000 Street" }],
		["a reversed pair in the postal code", { postalCode: "7000\uDE00\uD83D" }],
	])("%s is INVALID_SHIPPING_ADDRESS, before any store work", async (_label, field) => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/place", {
				...WF_BASE,
				shippingAddress: { ...WF_ADDRESS, ...field },
			}),
		);
		expect(result).toEqual({ ok: false, reason: "INVALID_SHIPPING_ADDRESS" });
		expect(productQueries).toHaveLength(0);
		expect(orderOps).toEqual([]);
	});

	test.each([
		["buyerRef", { buyerRef: "a\uD800@b.co" }],
		["buyerRef (NUL)", { buyerRef: "a\u0000@b.co" }],
		["couponCode", { couponCode: "SAVE\uDC00" }],
		["cartId", { cartId: "cart\uD800", idempotencyKey: "checkout:cart\uD800" }],
	])(
		"a lone surrogate or NUL in %s is INVALID_INPUT, before any store work",
		async (_label, field) => {
			const result = resultOf(
				await sandboxHandle.invokeRoute("storefront/checkout/place", {
					...WF_BASE,
					shippingAddress: WF_ADDRESS,
					...field,
				}),
			);
			expect(result).toEqual({ ok: false, error: "INVALID_INPUT" });
			expect(orderOps).toEqual([]);
		},
	);

	test("an emoji in the ship-to name is NOT refused — it is well-formed text", async () => {
		const result = resultOf(
			await sandboxHandle.invokeRoute("storefront/checkout/place", {
				...WF_BASE,
				shippingAddress: { ...WF_ADDRESS, name: "Asha \uD83D\uDE00" },
			}),
		);
		// It gets past the parser to the store (this cart does not exist), which is
		// the point: the refusal is about broken text, not about unusual text.
		expect(result).not.toEqual({ ok: false, reason: "INVALID_SHIPPING_ADDRESS" });
		expect(result).not.toEqual({ ok: false, error: "INVALID_INPUT" });
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
 * TWO PARKED NAMES, and what became of them:
 *  - "a reply with NO totals block still places the order — total simply absent".
 *    A service REPLY could omit its totals; an in-process `Order` cannot. On a
 *    pending replay the domain reads `order.totals` to build the PaymentIntent
 *    (`intentInputFor` in `create-order-from-cart.ts`), and on a paid replay the
 *    client's serializer reads it (`serializeOrderSummary` in
 *    `in-process-commerce-client.ts`) — both before the route formats anything,
 *    so a missing block throws first and the route answers RENDER_FAILED. The
 *    route's own containment is still pinned, by the unformattable-total cases.
 *  - "a 400 INVALID_SHIPPING_ADDRESS becomes the typed reason" came back with
 *    #305 part 2 (ADR-0021): the route's parser checks the SHAPE of the codes
 *    and the domain their MEMBERSHIP, so a code-shaped country that is not one
 *    (ZZ) now reaches the domain and is refused as the typed reason (the part-2
 *    describe below). A ship-to that fails the shared required-field / cap rules
 *    is still refused as INVALID_INPUT before an order, a hold adoption or a
 *    PaymentIntent exists.
 */
/**
 * Review round 3: Stripe CREATED the first intent but the answer was lost
 * (the stub keeps the request under its key, as Stripe does, and answers
 * 500) — so nothing was recorded. The retry must still send the request
 * Stripe holds, or Stripe refuses it (`idempotency_error`) for good.
 */
function losingTheFirstIntentAnswer(base: StripeResponder): StripeResponder {
	let lost = false;
	return (req) => {
		const reply = base(req);
		if (req.path === "/v1/payment_intents" && !lost) {
			lost = true;
			return { status: 500, body: { error: { type: "api_error" } } };
		}
		return reply;
	};
}

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
		expect(cart.lines.map((l) => l.reservationId)).toEqual(heldBefore.map((l) => l.reservationId));
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

	test("storefront/order/resume (QA U-2): the order id plus its email gets the SAME PaymentIntent — the same key and body at Stripe, no second order, only a hint of the email", async () => {
		const cartId = await seedThreeLineCart();
		const first = await placeCart(cartId);
		expect(first["ok"]).toBe(true);
		const orderId = first["orderId"] as string;

		// The order id ALONE is not enough (QA U-2): no proof, nothing asked of Stripe.
		expect(resultOf(await stripeBoot.invokeRoute("storefront/order/resume", { orderId }))).toEqual({
			ok: false,
			reason: "PROOF_REQUIRED",
		});
		const wrong = resultOf(
			await stripeBoot.invokeRoute("storefront/order/resume", {
				orderId,
				email: "someone.else@example.com",
			}),
		);
		expect(wrong).toEqual({ ok: false, reason: "EMAIL_MISMATCH" });
		expect(stripe.requests).toHaveLength(1);

		// The order's email, typed again (case aside), is the proof.
		const resumed = resultOf(
			await stripeBoot.invokeRoute("storefront/order/resume", {
				orderId,
				email: ` ${BUYER_REF.toUpperCase()} `,
			}),
		);

		expect(resumed, JSON.stringify(resumed)).toMatchObject({
			ok: true,
			orderId,
			clientAction: first["clientAction"],
			total: { currency: "USD" },
		});
		expect(typeof resumed["buyerRefHint"]).toBe("string");
		expect(JSON.stringify(resumed)).not.toContain(BUYER_REF);
		expect(resumed).not.toHaveProperty("intentId");
		expect(stripe.requests).toHaveLength(2);
		expect(stripe.requests[1]!.path).toBe("/v1/payment_intents");
		expect(stripe.requests[1]!.headers["idempotency-key"]).toBe(`checkout:${cartId}`);
		expect(stripe.requests[1]!.form.toString()).toBe(stripe.requests[0]!.form.toString());
		// Still the one order under the cart's key.
		expect((await storedOrder(orderId)).idempotencyKey).toBe(`checkout:${cartId}`);
	});

	test("storefront/order/abandon (QA2 X4): the cart cancels its own unpaid order — once — and a resume can no longer pay it", async () => {
		const cartId = await seedThreeLineCart();
		const first = await placeCart(cartId);
		expect(first["ok"]).toBe(true);
		const orderId = first["orderId"] as string;

		expect(resultOf(await stripeBoot.invokeRoute("storefront/order/abandon", { cartId }))).toEqual({
			ok: true,
			cancelled: true,
		});
		expect((await storedOrder(orderId)).state).toBe("cancelled");
		// A replay (a double click) cancels nothing more.
		expect(resultOf(await stripeBoot.invokeRoute("storefront/order/abandon", { cartId }))).toEqual({
			ok: true,
			cancelled: false,
		});
		// The cart's own way back to paying is closed: nothing asked of Stripe beyond
		// the create and the abandon's one withdrawal of the intent.
		expect(
			resultOf(await stripeBoot.invokeRoute("storefront/order/resume", { orderId, cartId })),
		).toEqual({ ok: false, reason: "ORDER_NOT_PAYABLE" });
		expect(stripe.requests.map((r) => `${r.method} ${r.path.replace(/pi_[^/]+/, "pi")}`)).toEqual([
			"POST /v1/payment_intents",
			"POST /v1/payment_intents/pi/cancel",
		]);
		// No cart id, no call.
		expect(resultOf(await stripeBoot.invokeRoute("storefront/order/abandon", {}))).toEqual({
			ok: false,
			error: "INVALID_INPUT",
		});
	});

	/**
	 * QA2 X4 follow-up: after the abandon's cancel, the intent is withdrawn at Stripe
	 * IN the request — best-effort, under a small fixed bound — instead of waiting
	 * for the sweep. Anything short of a definite answer is left to the sweep, on
	 * the sweep's own keys.
	 */
	describe("storefront/order/abandon withdraws the PaymentIntent at Stripe, bounded", () => {
		async function abandonedOrder(
			responder?: (fallback: ReturnType<typeof stripeLikeResponder>) => StripeResponder,
		) {
			const fallback = stripeLikeResponder();
			stripe.respondWith(responder === undefined ? fallback : responder(fallback));
			const cartId = await seedThreeLineCart();
			const placed = await placeCart(cartId);
			expect(placed["ok"]).toBe(true);
			const orderId = placed["orderId"] as string;
			const [intent] = await orderStore.listPaymentIntents(toOrderId(orderId));
			const started = Date.now();
			const res = resultOf(await stripeBoot.invokeRoute("storefront/order/abandon", { cartId }));
			const tookMs = Date.now() - started;
			expect(res).toEqual({ ok: true, cancelled: true });
			const [after] = await orderStore.listPaymentIntents(toOrderId(orderId));
			return { orderId, intentId: intent!.intentId, after: after!, tookMs };
		}

		test("a definite cancel is recorded at once, under the sweep's own first key", async () => {
			const { intentId, after } = await abandonedOrder(
				(fallback) => (req) =>
					isCancel(req) ? { status: 200, body: { id: "x", status: "canceled" } } : fallback(req),
			);
			const cancels = stripe.requests.filter(isCancel);
			expect(cancels.map((r) => r.path)).toEqual([`/v1/payment_intents/${intentId}/cancel`]);
			expect(cancels[0]!.headers["idempotency-key"]).toBe(`cancel-intent:${intentId}`);
			expect(after.cancelOutcome).toBe("cancelled");
			expect(after.cancelDueAt).toBeNull();
		});

		test("a Stripe that does not answer in time does not hold the shopper — the intent is left due for the sweep", async () => {
			const { after, tookMs } = await abandonedOrder(
				(fallback) => (req) =>
					isCancel(req) ? { status: 200, body: {}, delayMs: 6_000 } : fallback(req),
			);
			expect(stripe.requests.filter(isCancel)).toHaveLength(1);
			expect(tookMs).toBeLessThan(4_500);
			expect(after.cancelOutcome).toBeNull();
			expect(after.cancelDueAt).not.toBeNull();
		});

		test("an intent that already SUCCEEDED is not_cancellable, and the payment then takes the late-payment refund", async () => {
			const { orderId, intentId, after } = await abandonedOrder((fallback) => (req) => {
				if (isCancel(req)) {
					return {
						status: 400,
						body: {
							error: { type: "invalid_request_error", code: "payment_intent_unexpected_state" },
						},
					};
				}
				if (req.method === "GET") {
					return {
						status: 200,
						body: {
							id: req.path.split("/")[3]?.split("?")[0],
							status: "succeeded",
							latest_charge: {
								amount_refunded: 0,
								amount_captured: SUBTOTAL_CENTS,
								currency: "usd",
							},
						},
					};
				}
				if (req.method === "POST" && req.path === "/v1/refunds") {
					return {
						status: 200,
						body: { id: "re_abandon", amount: SUBTOTAL_CENTS, currency: "usd" },
					};
				}
				return fallback(req);
			});
			expect(after.cancelOutcome).toBe("not_cancellable");

			const signed = await signStripeWebhook(
				{
					eventId: `evt_abandon_${orderId}`,
					type: "payment_intent.succeeded",
					paymentIntentId: intentId,
					orderId,
					amountCents: SUBTOTAL_CENTS,
					currency: "usd",
				},
				STRIPE_WEBHOOK_SECRET,
			);
			resultOf(
				await stripeBoot.invokeRoute("webhooks/stripe/settle", {
					rawBodyBase64: Buffer.from(signed.body).toString("base64"),
					stripeSignature: signed.signatureHeader,
					idempotencyKey: `wh-abandon-${orderId}`,
				}),
			);
			expect((await storedOrder(orderId)).state).toBe("cancelled");
			expect(stripe.requests.some((r) => r.method === "POST" && r.path === "/v1/refunds")).toBe(
				true,
			);
		});
	});

	test("storefront/order/resume refuses an unknown order without asking Stripe", async () => {
		expect(
			resultOf(
				await stripeBoot.invokeRoute("storefront/order/resume", { orderId: `no-such-order-${NS}` }),
			),
		).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
		expect(stripe.requests).toHaveLength(0);
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
			[
				"alreadyPlaced",
				"buyerRefHint",
				"clientAction",
				"emailMatches",
				"ok",
				"orderId",
				"state",
				"total",
			].toSorted(),
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
				// The order's email, masked — never the address (QA2 X2).
				buyerRefHint: expect.stringMatching(/^.•••@.•••\.[a-z]+$/i),
				emailMatches: true,
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

	// QA T1-10: the key is checkout:<cartId> by construction, and the route
	// now ENFORCES that rather than trusting its caller. Forwarded as given, a
	// caller could post checkout:<another cart> against its own cart and bind
	// that key to the wrong order, locking the other cart out with
	// IDEMPOTENCY_KEY_REUSED for good. A key that is not this cart's is
	// CHECKOUT_STALE — a page reviewed for some other cart — and nothing is
	// minted, adopted or asked of Stripe.
	test.each([
		["another cart's key", (cartId: string) => `checkout:${cartId}-other`],
		["a key that is not a checkout key", (cartId: string) => cartId],
		["this cart's key with a suffix", (cartId: string) => `checkout:${cartId}:again`],
	])(
		"%s is the typed CHECKOUT_STALE — no order, no intent, and the cart still places under its own key",
		async (_label, keyFor) => {
			const cartId = await seedThreeLineCart();
			orderOps.length = 0;

			const stale = await place({ cartId, buyerRef: BUYER_REF, idempotencyKey: keyFor(cartId) });

			expect(stale).toEqual({ ok: false, reason: "CHECKOUT_STALE" });
			expect(orderOps).toEqual([]);
			expect(stripe.requests).toHaveLength(0);
			expect(await placeCart(cartId)).toMatchObject({ ok: true, alreadyPlaced: false });
		},
	);

	test("the OLD cart's key submitted against a NEW cart (a stale tab) is CHECKOUT_STALE — and can no longer lock the old cart's key onto the new cart (issue #133, QA T1-10)", async () => {
		const oldCart = await seedThreeLineCart();
		expect((await placeCart(oldCart))["ok"]).toBe(true);
		const newCart = await seedThreeLineCart();
		stripe.reset();

		const stale = await place({
			cartId: newCart,
			buyerRef: BUYER_REF,
			idempotencyKey: `checkout:${oldCart}`,
		});

		expect(stale).toEqual({ ok: false, reason: "CHECKOUT_STALE" });
		expect(stripe.requests).toHaveLength(0);
		expect(await placeCart(newCart)).toMatchObject({ ok: true, alreadyPlaced: false });
	});

	test("a second place of a placed cart under its own key replays the SAME order — the only key the route accepts", async () => {
		const cartId = await seedThreeLineCart();
		const first = await placeCart(cartId);
		expect(first["ok"]).toBe(true);

		const second = await placeCart(cartId);

		expect(second).toMatchObject({ ok: true, orderId: first["orderId"] });
	});

	test("Stripe still answering idempotency_key_in_use after the adapter's wait is BUSY (retryable), never PAYMENT_INTENT_FAILED (QA T1-9)", async () => {
		// The first click's request never lands within the adapter's ~3 s budget.
		// Nothing failed, so the shopper gets the store's "busy, try again in a
		// few seconds", whose retry replays the same key.
		const cartId = await seedThreeLineCart();
		stripe.respondWith(() => ({
			status: 409,
			body: { error: { code: "idempotency_key_in_use", type: "idempotency_error" } },
		}));

		const result = await placeCart(cartId);

		expect(result).toEqual({ ok: false, error: "BUSY", retryable: true });
		expect(stripe.requests.length).toBeGreaterThan(1);
		expect(JSON.stringify(result)).not.toContain(STRIPE_SECRET_KEY);

		// The first request lands: the same key now places the SAME pending order.
		stripe.reset();
		expect(await placeCart(cartId)).toMatchObject({ ok: true, alreadyPlaced: false });
	}, 20_000);

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
		["line1 over the domain's cap", { ...SHIP_TO, line1: "x".repeat(201) }],
		["the country over the domain's cap", { ...SHIP_TO, country: "X".repeat(101) }],
	])(
		"an over-long ship-to field (%s) is the typed INVALID_SHIPPING_ADDRESS before any order or intent exists (QA U-6)",
		async (_label, shippingAddress) => {
			const cartId = await seedThreeLineCart();
			orderOps.length = 0;

			expect(await placeCart(cartId, { shippingAddress })).toEqual({
				ok: false,
				reason: "INVALID_SHIPPING_ADDRESS",
			});
			expect(orderOps).toEqual([]);
			expect(stripe.requests).toHaveLength(0);
		},
	);

	test.each([["a whitespace-only required field", { ...SHIP_TO, name: "   " }]])(
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
	 * ISSUE #304 / ADR-0022, end to end: a DECLINE followed by a successful retry on
	 * the SAME PaymentIntent. Stripe leaves the intent payable after a decline and the
	 * pay page confirms it again, so the webhook route sees `payment_failed` and then
	 * `succeeded` for one order. Both deliveries are correctly signed with the
	 * webhook secret this boot armed and verified inside the isolate; the order must
	 * end `paid` with its stock committed once and no reconciliation flag — not the
	 * `PAID_FLIP_LOST` a fail-and-release decline used to produce.
	 */
	test("a declined card then a successful retry on the same PaymentIntent ends PAID, stock committed once", async () => {
		const sku = `SKU-${NS}-DECLINE`;
		await seedProduct({ id: `prod-${NS}-decline`, sku, amount: 1200 });
		const cartId = await createCart();
		await addLine(cartId, sku, `prod-${NS}-decline`, 2);
		const onHandAtCheckout = await inventoryStore().getOnHand(sku);

		const placed = await placeCart(cartId);
		expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true, state: "pending" });
		const orderId = placed["orderId"] as string;
		const intentId = `pi_${orderId}`;

		async function deliver(
			type: "payment_intent.payment_failed" | "payment_intent.succeeded",
			eventId: string,
		) {
			const signed = await signStripeWebhook(
				{ eventId, type, paymentIntentId: intentId, orderId, amountCents: 2400, currency: "usd" },
				STRIPE_WEBHOOK_SECRET,
			);
			return resultOf(
				await stripeBoot.invokeRoute("webhooks/stripe/settle", {
					rawBodyBase64: Buffer.from(signed.body).toString("base64"),
					stripeSignature: signed.signatureHeader,
					idempotencyKey: `wh-${eventId}`,
				}),
			);
		}

		// 1. The decline (4000 0000 0000 0002): acknowledged, and the order is still
		// payable — pending, its units still held, no flag.
		expect(await deliver("payment_intent.payment_failed", `evt_decline_${orderId}`)).toMatchObject({
			ok: true,
		});
		const declined = await storedOrder(orderId);
		expect(declined.state).toBe("pending");
		expect(declined.reconciliationFlag).toBeNull();
		expect(await inventoryStore().getOnHand(sku)).toBe(onHandAtCheckout);

		// 2. The retry with a good card succeeds on the same intent: a clean settle.
		expect(await deliver("payment_intent.succeeded", `evt_success_${orderId}`)).toMatchObject({
			ok: true,
		});
		const paid = await storedOrder(orderId);
		expect(paid.state).toBe("paid");
		expect(paid.reconciliationFlag).toBeNull();
		// The two units the cart held are the two units sold: none came back at the
		// decline, and none were taken twice at the settle.
		expect(await inventoryStore().getOnHand(sku)).toBe(onHandAtCheckout);
		expect(await orderStore.getCapturedPayments(toOrderId(orderId))).toHaveLength(1);
		// The settle route made no Stripe API call of its own — only the place did.
		expect(stripe.requests.map((r) => r.path)).toEqual(["/v1/payment_intents"]);
	});

	/**
	 * #305 part 1 — the coupon at place, and the locked review, in a store with
	 * NO zones: nothing here is about delivery, so no address is needed
	 * (ADR-0021 Decision 4). The zoned cases are the part-2 describe below.
	 */
	describe("#305 — the coupon at place, and the locked review (a store with no zones)", () => {
		/** The order a place minted, read back from the real store. */
		async function totalsSnapshot(orderId: string) {
			return (await storedOrder(orderId)).totals;
		}

		test("a store with NO zones never needs a region: a US address without one places", async () => {
			const placed = await placeCart(await seedThreeLineCart(), { shippingAddress: SHIP_TO });
			expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true });
			const order = await storedOrder(placed["orderId"] as string);
			expect(JSON.stringify(order)).not.toContain("SHIPPING_REGION_CODE_REQUIRED");
		});

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
				selection: { couponCode: "CK-LOCK", shippingMethodId: null, destination: null },
				selectionErrors: {},
				idempotencyKey: `checkout:${cartId}`,
				hasUnpricedLines: false,
				// Nothing to collect or choose; a pending order can still be paid.
				shipping: { status: "no_zones", options: [] },
				addressRequired: false,
				readyToPlace: true,
			});
			const totals = locked["totals"] as Record<string, { label: string }>;
			expect(totals["total"]!.label).toBe("$44.98");
			expect(totals["discount"]!.label).toBe("$5.00");
			// The lines are the ORDER's snapshot, not a live re-join.
			const lines = locked["lines"] as {
				sku: string;
				title: string | null;
				qty: number;
				lineTotal: { formatted: string };
			}[];
			// The order's own snapshot title rides each locked row.
			expect(lines.every((l) => l.title === "Bamboo Water Bottle")).toBe(true);
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
				readyToPlace: false,
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

		test("the locked review after a Stripe 502 (no zones): delivery 'no_zones', ready to place, and a bare same-key place replays the ORIGINAL order", async () => {
			const cartId = await seedThreeLineCart();
			stripe.respondWith(() => ({ status: 502, body: { error: { code: "api_error" } } }));
			expect(await placeCart(cartId)).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
			const failed = await orderStore.getByIdempotencyKey(idempotencyKey(`checkout:${cartId}`));
			stripe.respondWith(stripeLikeResponder());

			expect(await summary({ cartId })).toMatchObject({
				ok: true,
				orderCreated: true,
				order: { id: failed?.id, phase: "payable" },
				shipping: { status: "no_zones" },
				readyToPlace: true,
			});
			expect(await placeCart(cartId)).toMatchObject({ ok: true, orderId: failed?.id });
		});

		test("an order's method whose ONLY zone was deleted between the review and the place → SHIPPING_METHOD_NOT_FOUND, nothing minted", async () => {
			const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
			const zoneId = `${NS}-only-zone`;
			const methodId = `${NS}-only-method`;
			await rules.createZone({ id: zoneId, name: "Only", regions: ["US"] });
			await rules.createMethod({ id: methodId, zoneId, name: "Only", type: "flat_rate" });
			await rules.createRate({
				methodId,
				currency: currency("USD"),
				amountCents: cents(100),
				minSubtotalCents: null,
			});
			const cartId = await seedThreeLineCart();
			const review = await summary({ cartId, destination: { country: "US" } });
			expect(review).toMatchObject({ selection: { shippingMethodId: methodId } });

			expect(gone(await rules.deleteRate(methodId, currency("USD")))).toBe(true);
			expect(gone(await rules.deleteMethod(methodId))).toBe(true);
			expect(gone(await rules.deleteZone(zoneId))).toBe(true);

			await expectRefusedAtPlace(
				cartId,
				{ shippingAddress: SHIP_TO, shippingMethodId: methodId },
				"SHIPPING_METHOD_NOT_FOUND",
			);
		});
	});

	/**
	 * #305 part 2 (ADR-0021) at place: the zone DERIVED from the ship-to address.
	 * The same `P2_ZONES` fixture as the summary cases, and the same one-line
	 * 2 × $15.00 cart, so a review and its order can be compared figure for figure.
	 */
	describe("#305 part 2 — the zone derived from the ship-to, at place", () => {
		useShippingRules(seedZoneFixture, removeZoneFixture);

		const CA_ADDRESS = { ...SHIP_TO, region: "CA" };

		test("PARITY — (US, CA) + its method + a $5.00 coupon: 2500 + 599 + 181 = 3280 on the review, the place, the stored order AND the PaymentIntent", async () => {
			await seedCoupon({ id: `${NS}-p2-coupon`, code: "CK-P2-500", amount: 500 });
			const cartId = await p2Cart();
			const review = await summary({
				cartId,
				destination: { country: "US", region: "CA" },
				couponCode: "CK-P2-500",
			});
			const reviewed = (review["totals"] as { total: { money: { amount: number } } }).total.money;
			const selection = review["selection"] as { shippingMethodId: string };

			const placed = await placeCart(cartId, {
				shippingAddress: CA_ADDRESS,
				shippingMethodId: selection.shippingMethodId,
				couponCode: "CK-P2-500",
			});

			expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true });
			expect(reviewed.amount).toBe(3280);
			expect((placed["total"] as { amount: number }).amount).toBe(3280);
			const order = await storedOrder(placed["orderId"] as string);
			expect(order.totals).toMatchObject({ discount: 500, shipping: 599, tax: 181, total: 3280 });
			expect(stripe.requests[0]!.form.get("amount")).toBe("3280");
		});

		test("the PRESELECTED method reaches the order: the review preselects it, the form echoes it, the snapshot records {zoneId, methodId, matchedRegion} — 3817", async () => {
			const cartId = await p2Cart();
			const review = await summary({ cartId, destination: { country: "US", region: "CA" } });
			const echoed = (review["selection"] as { shippingMethodId: string }).shippingMethodId;
			expect(echoed).toBe(P2.CA_STD);

			const placed = await placeCart(cartId, {
				shippingAddress: CA_ADDRESS,
				shippingMethodId: echoed,
			});

			expect(placed["ok"]).toBe(true);
			const order = await storedOrder(placed["orderId"] as string);
			// INVERTS PR 1's transitional `{ zoneId: null, methodId }`.
			expect(order.totals.shippingMethodSnapshot).toEqual({
				zoneId: P2.CA,
				methodId: P2.CA_STD,
				matchedRegion: "US-CA",
			});
			expect(order.totals.total).toBe(3817);
			expect(order.shippingAddress?.region).toBe("CA");
			expect(stripe.requests[0]!.form.get("amount")).toBe("3817");
			expect(stripe.requests[0]!.form.get("shipping[address][state]")).toBe("CA");
		});

		test("INVERTS PR 1: a method and NO address in a zoned store is the typed MISSING_SHIPPING_ADDRESS", async () => {
			await expectRefusedAtPlace(
				await p2Cart(),
				{ shippingMethodId: P2.CA_STD },
				"MISSING_SHIPPING_ADDRESS",
			);
		});

		test("INVERTS PR 1: a supplied shippingZoneId (DE, 19%) is IGNORED — the tax comes from the zone the address matched", async () => {
			const placed = await placeCart(await p2Cart(), {
				shippingAddress: CA_ADDRESS,
				shippingMethodId: P2.CA_STD,
				shippingZoneId: P2.DE,
			});

			expect(placed["ok"]).toBe(true);
			const order = await storedOrder(placed["orderId"] as string);
			expect(order.totals.tax).toBe(218);
			expect((order.totals.shippingMethodSnapshot as { zoneId: string }).zoneId).toBe(P2.CA);
		});

		test("a physical cart in a STATE-zoned store (a US-CA zone, which also carries the CA tax rate) cannot place a US address without a region", async () => {
			// The store's rule — region required iff some zone lists one of the
			// country's subdivisions — is this zone match; the site adds none.
			expect(SHIP_TO).not.toHaveProperty("region");
			await expectRefusedAtPlace(
				await p2Cart(),
				{ shippingAddress: SHIP_TO, shippingMethodId: P2.US_STD },
				"SHIPPING_REGION_CODE_REQUIRED",
			);
		});

		test("(US, XX) is the typed SHIPPING_REGION_CODE_REQUIRED — no order, no intent", async () => {
			await expectRefusedAtPlace(
				await p2Cart(),
				{ shippingAddress: { ...SHIP_TO, region: "XX" }, shippingMethodId: P2.US_STD },
				"SHIPPING_REGION_CODE_REQUIRED",
			);
		});

		test.each(["ON", "MX-CA"])(
			"(US, %s) — another country's subdivision — is refused at place: no order, no intent",
			async (region) => {
				await expectRefusedAtPlace(
					await p2Cart(),
					{ shippingAddress: { ...SHIP_TO, region }, shippingMethodId: P2.US_STD },
					"SHIPPING_REGION_CODE_REQUIRED",
				);
			},
		);

		test("(DE, Bavaria) is INVALID_INPUT before any order or intent exists", async () => {
			const cartId = await p2Cart();
			orderOps.length = 0;
			expect(
				await placeCart(cartId, {
					shippingAddress: { ...SHIP_TO, country: "DE", region: "Bavaria" },
					shippingMethodId: P2.DE_STD,
				}),
			).toEqual({ ok: false, error: "INVALID_INPUT" });
			expect(orderOps).toEqual([]);
			expect(stripe.requests).toHaveLength(0);
		});

		test("an address no zone matches is the typed SHIPPING_ZONE_NOT_MATCHED — no order, no intent, the coupon's uses unchanged", async () => {
			await seedCoupon({ id: `${NS}-p2-unmatched`, code: "CK-P2-UNMATCHED", amount: 500 });
			await expectRefusedAtPlace(
				await p2Cart(),
				{
					shippingAddress: { ...SHIP_TO, country: "JP" },
					shippingMethodId: P2.US_STD,
					couponCode: "CK-P2-UNMATCHED",
				},
				"SHIPPING_ZONE_NOT_MATCHED",
			);
			expect(await usesOf("CK-P2-UNMATCHED")).toBe(0);
		});

		test("RESTORED #286 case: a code-SHAPED country that is not one (ZZ) is the typed INVALID_SHIPPING_ADDRESS — no order, no intent", async () => {
			await expectRefusedAtPlace(
				await p2Cart(),
				{ shippingAddress: { ...SHIP_TO, country: "ZZ" }, shippingMethodId: P2.US_STD },
				"INVALID_SHIPPING_ADDRESS",
			);
		});

		test("a zone deleted between the review and the place, with another zone still configured → SHIPPING_ZONE_NOT_MATCHED, nothing minted", async () => {
			const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
			const zoneId = `${NS}-p2-nz`;
			const methodId = `${NS}-p2-nz-std`;
			await rules.createZone({ id: zoneId, name: "NZ", regions: ["NZ"] });
			await rules.createMethod({ id: methodId, zoneId, name: "NZ Post", type: "flat_rate" });
			await rules.createRate({
				methodId,
				currency: currency("USD"),
				amountCents: cents(700),
				minSubtotalCents: null,
			});
			const cartId = await p2Cart();
			expect(await summary({ cartId, destination: { country: "NZ" } })).toMatchObject({
				selection: { shippingMethodId: methodId },
			});

			expect(gone(await rules.deleteRate(methodId, currency("USD")))).toBe(true);
			expect(gone(await rules.deleteMethod(methodId))).toBe(true);
			expect(gone(await rules.deleteZone(zoneId))).toBe(true);

			await expectRefusedAtPlace(
				cartId,
				{ shippingAddress: { ...SHIP_TO, country: "NZ" }, shippingMethodId: methodId },
				"SHIPPING_ZONE_NOT_MATCHED",
			);
		});

		test("THE LOCKED REVIEW (zoned) after a Stripe 502: matched, ready to place, the order's $38.17 — and a place with NO address and NO method replays the SAME order with Stripe's identical body", async () => {
			const cartId = await p2Cart();
			stripe.respondWith(() => ({ status: 502, body: { error: { code: "api_error" } } }));
			expect(
				await placeCart(cartId, { shippingAddress: CA_ADDRESS, shippingMethodId: P2.CA_STD }),
			).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
			const order = await orderStore.getByIdempotencyKey(idempotencyKey(`checkout:${cartId}`));
			expect(order).not.toBeNull();
			stripe.respondWith(stripeLikeResponder());

			const locked = await summary({ cartId, destination: { country: "DE" } });
			expect(locked, JSON.stringify(locked)).toMatchObject({
				ok: true,
				orderCreated: true,
				order: { id: order!.id, phase: "payable" },
				shipping: { status: "matched", options: [] },
				selection: { shippingMethodId: P2.CA_STD },
				addressRequired: false,
				readyToPlace: true,
			});
			expect((locked["totals"] as Record<string, { label: string }>)["total"]!.label).toBe(
				"$38.17",
			);

			// Exactly the body the locked page's form sends: key, email, nothing else.
			const replay = await placeCart(cartId);
			expect(replay).toMatchObject({ ok: true, orderId: order!.id });
			expect(stripe.requests).toHaveLength(2);
			expect(stripe.requests[1]!.form.toString()).toBe(stripe.requests[0]!.form.toString());
			expect(stripe.requests[1]!.form.get("amount")).toBe("3817");
		});

		test("storefront/order for an order placed in a matched zone states shipping AND tax as money", async () => {
			const placed = await placeCart(await p2Cart(), {
				shippingAddress: CA_ADDRESS,
				shippingMethodId: P2.CA_STD,
			});

			const read = resultOf(
				await sandboxHandle.invokeRoute("storefront/order", { orderId: placed["orderId"] }),
			);

			expect(read["ok"]).toBe(true);
			const totals = (read["order"] as { totals: Record<string, { label: string }> }).totals;
			expect(totals["shipping"]!.label).toBe("$5.99");
			expect(totals["tax"]!.label).toBe("$2.18");
			expect(totals["total"]!.label).toBe("$38.17");
		});
	});

	/**
	 * Issue #382: an India-based Stripe account refuses an export payment that
	 * does not carry the buyer's name and address — digital carts included. The
	 * plugin learns the account's country from `GET /v1/account` when the secret
	 * key is saved, caches it, and from then on requires the address for EVERY
	 * cart; a US account (the stub's default) changes nothing.
	 */
	describe("the Stripe account's country (issue #382)", () => {
		const IN_ADDRESS = {
			name: "Asha Rao",
			line1: "12 Park Street",
			city: "Kolkata",
			postalCode: "700016",
			country: "IN",
		};

		/** Save the secret key again — the Settings save that re-reads the country. */
		async function resaveSecretKey(): Promise<void> {
			const saved = await stripeBoot.invokeRoute("admin", {
				type: "form_submit",
				action_id: "save-stripe-secret-key",
				values: { stripeSecretKey: STRIPE_SECRET_KEY },
			});
			expect(saved).toHaveProperty("result");
		}

		async function stripeSummary(cartId: string): Promise<Record<string, unknown>> {
			return resultOf(await stripeBoot.invokeRoute("storefront/checkout/summary", { cartId }));
		}

		test("a US account: a digital cart asks for no address and places without one — no account read on the way", async () => {
			const cartId = await p2Cart("digital");
			expect(await stripeSummary(cartId)).toMatchObject({
				ok: true,
				addressRequired: false,
				paymentAccountNeedsAddress: false,
			});
			expect(await placeCart(cartId)).toMatchObject({ ok: true, state: "pending" });
			// The country was cached when the key was saved: checkout only read kv.
			expect(stripe.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
				"POST /v1/payment_intents",
			]);
			expect(stripe.requests[0]!.form.has("shipping[name]")).toBe(false);
			expect(stripe.requests[0]!.form.has("customer")).toBe(false);
		});

		test("a US account: a physical-style address on the order still makes NO Customer call", async () => {
			const placed = await placeCart(await p2Cart("digital"), {
				shippingAddress: { ...IN_ADDRESS, country: "US", postalCode: "94107" },
			});
			expect(placed).toMatchObject({ ok: true });
			expect(stripe.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
				"POST /v1/payment_intents",
			]);
			expect(stripe.requests[0]!.form.has("customer")).toBe(false);
		});

		/**
		 * Review round 2 (F1/F2): the Customer decision is the ORDER's — made on its
		 * first intent, recorded with it, and handed back on every replay — so
		 * nothing that moves afterwards (the cached country, a pruned Customer key)
		 * can change the same-key intent body Stripe already holds.
		 */
		describe("the Customer decision is recorded with the order's first intent", () => {
			/** Answer `GET /v1/account` with `account` from now on, and re-save the key
			 *  so the cache takes it — then clear the requests. */
			async function accountAnswers(
				account: { status: number; body: unknown },
				rest: StripeResponder = stripeLikeResponder(),
			): Promise<void> {
				stripe.respondWith((req) =>
					req.method === "GET" && req.path === "/v1/account" ? account : rest(req),
				);
				await resaveSecretKey();
				stripe.requests.length = 0;
			}
			const IN_ACCOUNT = { status: 200, body: { id: "acct_in", country: "IN" } };
			const US_ACCOUNT = { status: 200, body: { id: "acct_us", country: "US" } };

			afterEach(async () => {
				stripe.reset();
				await resaveSecretKey();
				stripe.reset();
			});

			test("a lost intent answer, then the country flips to IN: the retry is byte-identical, with no Customer, and accepted", async () => {
				const stripeLike = losingTheFirstIntentAnswer(stripeLikeResponder());
				await accountAnswers(US_ACCOUNT, stripeLike);
				const cartId = await p2Cart("digital");
				expect(await placeCart(cartId, { shippingAddress: IN_ADDRESS })).toEqual({
					ok: false,
					reason: "PAYMENT_INTENT_FAILED",
				});
				const first = stripe.requests[0]!;

				await accountAnswers(IN_ACCOUNT, stripeLike);
				const retried = await placeCart(cartId);
				expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true });
				expect(stripe.requests.map((r) => r.path)).toEqual(["/v1/payment_intents"]);
				expect(stripe.requests[0]!.form.toString()).toBe(first.form.toString());
			});

			test("a lost intent answer, then the country reads unknown: the retry names the same Customer, byte-identical, and is accepted", async () => {
				const stripeLike = losingTheFirstIntentAnswer(stripeLikeResponder());
				await accountAnswers(IN_ACCOUNT, stripeLike);
				const cartId = await p2Cart("digital");
				expect(await placeCart(cartId, { shippingAddress: IN_ADDRESS })).toEqual({
					ok: false,
					reason: "PAYMENT_INTENT_FAILED",
				});
				const [customer, first] = stripe.requests as [StripeRecordedRequest, StripeRecordedRequest];
				expect(first.form.get("customer")).toBe("cus_stub_1");

				await accountAnswers({ status: 503, body: {} }, stripeLike);
				const retried = await placeCart(cartId);
				expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true });
				// Nothing was recorded, so the Customer is asked for again — under the
				// same key, with the same body, and Stripe hands back the same one.
				expect(stripe.requests.map((r) => r.path)).toEqual([
					"/v1/customers",
					"/v1/payment_intents",
				]);
				expect(stripe.requests[0]!.form.toString()).toBe(customer.form.toString());
				expect(stripe.requests[1]!.form.toString()).toBe(first.form.toString());
			});

			test("the country flips to IN after the first intent: the replay sends a byte-identical body, still with no Customer", async () => {
				const stripeLike = stripeLikeResponder();
				await accountAnswers(US_ACCOUNT, stripeLike);
				const cartId = await p2Cart("digital");
				const placed = await placeCart(cartId, { shippingAddress: IN_ADDRESS });
				expect(placed).toMatchObject({ ok: true });
				const first = stripe.requests[0]!;

				await accountAnswers(IN_ACCOUNT, stripeLike); // the merchant opened Settings
				const replay = await placeCart(cartId);
				expect(replay).toMatchObject({ ok: true, orderId: placed["orderId"] });
				expect(stripe.requests.map((r) => r.path)).toEqual(["/v1/payment_intents"]);
				expect(stripe.requests[0]!.form.toString()).toBe(first.form.toString());
				expect(stripe.requests[0]!.form.has("customer")).toBe(false);
			});

			test("after an intent WITH a Customer the cache reads unknown: the replay still names the Customer", async () => {
				const stripeLike = stripeLikeResponder();
				await accountAnswers(IN_ACCOUNT, stripeLike);
				const cartId = await p2Cart("digital");
				const placed = await placeCart(cartId, { shippingAddress: IN_ADDRESS });
				expect(placed).toMatchObject({ ok: true });
				const intent = stripe.requests[1]!;
				expect(intent.form.get("customer")).toBe("cus_stub_1");

				// Stripe unreachable at the next Settings save: the country is unknown.
				await accountAnswers({ status: 503, body: {} }, stripeLike);
				const replay = await placeCart(cartId);
				expect(replay).toMatchObject({ ok: true, orderId: placed["orderId"] });
				expect(stripe.requests.map((r) => r.path)).toEqual(["/v1/payment_intents"]);
				expect(stripe.requests[0]!.form.toString()).toBe(intent.form.toString());
			});

			test("a resume after Stripe would have pruned the Customer's key: no second create — the recorded id is reused", async () => {
				// A Customer create that ignores its key hands out a NEW id each time —
				// what a create after Stripe pruned `otta-cus-<orderId>` would do.
				let creates = 0;
				const stripeLike = stripeLikeResponder();
				await accountAnswers(IN_ACCOUNT, (req) => {
					if (req.path !== "/v1/customers") return stripeLike(req);
					creates += 1;
					return { status: 200, body: { id: `cus_fresh_${String(creates)}` } };
				});
				const cartId = await p2Cart("digital");
				const placed = await placeCart(cartId, { shippingAddress: IN_ADDRESS });
				expect(placed).toMatchObject({ ok: true });
				const intent = stripe.requests[1]!;
				expect(intent.form.get("customer")).toBe("cus_fresh_1");
				stripe.requests.length = 0;

				const resumed = resultOf(
					await stripeBoot.invokeRoute("storefront/order/resume", {
						orderId: placed["orderId"],
						cartId,
					}),
				);
				expect(resumed).toMatchObject({ ok: true, orderId: placed["orderId"] });
				expect(creates).toBe(1);
				expect(stripe.requests.map((r) => r.path)).toEqual(["/v1/payment_intents"]);
				expect(stripe.requests[0]!.form.toString()).toBe(intent.form.toString());
			});
		});

		describe("an India account", () => {
			beforeEach(async () => {
				const stripeLike = stripeLikeResponder();
				stripe.respondWith((req) =>
					req.method === "GET" && req.path === "/v1/account"
						? { status: 200, body: { id: "acct_in", object: "account", country: "IN" } }
						: stripeLike(req),
				);
				await resaveSecretKey();
				expect(stripe.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/account"]);
				stripe.reset();
				// The reset restored the default responder; keep answering as Stripe.
			});

			afterEach(async () => {
				// Back to the US account the rest of this boot assumes.
				stripe.reset();
				await resaveSecretKey();
				stripe.reset();
			});

			test("the summary of a digital cart requires the name and address, and says it is the payment account", async () => {
				const cartId = await p2Cart("digital");
				expect(await stripeSummary(cartId)).toMatchObject({
					ok: true,
					requiresShipping: false,
					addressRequired: true,
					paymentAccountNeedsAddress: true,
					// Nothing to choose — the address goes on the same form as the email.
					readyToPlace: true,
				});
				expect(stripe.requests).toHaveLength(0);
			});

			test("a digital cart placed with NO address is refused MISSING_SHIPPING_ADDRESS before anything is minted", async () => {
				await expectRefusedAtPlace(await p2Cart("digital"), {}, "MISSING_SHIPPING_ADDRESS");
			});

			test("a digital cart placed with a complete address: a Customer with the name and billing address, then a PaymentIntent naming it — and a replay reuses both", async () => {
				const cartId = await p2Cart("digital");
				const placed = await placeCart(cartId, { shippingAddress: IN_ADDRESS });
				expect(placed, JSON.stringify(placed)).toMatchObject({ ok: true, state: "pending" });
				expect(stripe.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
					"POST /v1/customers",
					"POST /v1/payment_intents",
				]);
				const [customer, intent] = stripe.requests as [
					StripeRecordedRequest,
					StripeRecordedRequest,
				];
				expect(customer.headers["idempotency-key"]).toBe(`otta-cus-${String(placed["orderId"])}`);
				expect(customer.headers.authorization).toBe(`Bearer ${STRIPE_SECRET_KEY}`);
				expect([...customer.form.entries()]).toEqual([
					["name", "Asha Rao"],
					["address[line1]", "12 Park Street"],
					["address[city]", "Kolkata"],
					["address[postal_code]", "700016"],
					["address[country]", "IN"],
					["metadata[order_id]", String(placed["orderId"])],
				]);
				expect(intent.form.get("customer")).toBe("cus_stub_1");
				expect(intent.form.get("description")).toBe("2 × Bamboo Water Bottle");
				expect(intent.form.get("shipping[name]")).toBe("Asha Rao");
				expect(intent.form.get("shipping[address][line1]")).toBe("12 Park Street");
				expect(intent.form.get("shipping[address][city]")).toBe("Kolkata");
				expect(intent.form.get("shipping[address][postal_code]")).toBe("700016");
				expect(intent.form.get("shipping[address][country]")).toBe("IN");

				// The locked review's retry: same key, no address. The RECORDED Customer is
				// named again — no second Customer call — and the intent body is
				// byte-identical (Stripe would refuse a drifted one).
				const replay = await placeCart(cartId);
				expect(replay).toMatchObject({ ok: true, orderId: placed["orderId"] });
				expect(stripe.requests.map((r) => r.path)).toEqual([
					"/v1/customers",
					"/v1/payment_intents",
					"/v1/payment_intents",
				]);
				expect(stripe.requests[2]!.form.toString()).toBe(intent.form.toString());
			});

			test("the Customer create failing is a typed PAYMENT_INTENT_FAILED; the order stays payable, and a retry completes it", async () => {
				const cartId = await p2Cart("digital");
				const stripeLike = stripeLikeResponder();
				stripe.respondWith((req) =>
					req.path === "/v1/customers"
						? { status: 500, body: { error: { type: "api_error" } } }
						: stripeLike(req),
				);
				const failed = await placeCart(cartId, { shippingAddress: IN_ADDRESS });
				expect(failed).toEqual({ ok: false, reason: "PAYMENT_INTENT_FAILED" });
				expect(stripe.requests.map((r) => r.path)).toEqual(["/v1/customers"]);
				const order = await orderStore.getByIdempotencyKey(idempotencyKey(`checkout:${cartId}`));
				expect(order?.state).toBe("pending");

				stripe.respondWith(stripeLike);
				const retried = await placeCart(cartId);
				expect(retried).toMatchObject({ ok: true, orderId: order!.id, state: "pending" });
				expect(stripe.requests.map((r) => r.path)).toEqual([
					"/v1/customers",
					"/v1/customers",
					"/v1/payment_intents",
				]);
			});
		});

		test("a restricted key that cannot read the account (403): not required, cached — checkout does not ask again", async () => {
			stripe.respondWith((req) =>
				req.method === "GET" && req.path === "/v1/account"
					? {
							status: 403,
							body: {
								error: {
									type: "invalid_request_error",
									message:
										"The provided key does not have the required permissions for this endpoint.",
								},
							},
						}
					: stripeLikeResponder()(req),
			);
			try {
				await resaveSecretKey();
				expect(stripe.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/account"]);
				const cartId = await p2Cart("digital");
				expect(await stripeSummary(cartId)).toMatchObject({
					addressRequired: false,
					paymentAccountNeedsAddress: false,
				});
				expect(await stripeSummary(cartId)).toMatchObject({ addressRequired: false });
				// Two renders, no second account read.
				expect(stripe.requests).toHaveLength(1);
			} finally {
				stripe.reset();
				await resaveSecretKey();
				stripe.reset();
			}
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
				country: "GB",
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
