import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	cents,
	computeQuote,
	currency,
	type Currency,
	idempotencyKey,
	money,
	type ProductKind,
	productId as brandProductId,
	type QuoteCommand,
	sku as brandSku,
} from "@otta-sh/domain";
import { CountingIdGen, FakePaymentGateway, FixedClock } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { QuoteRequestWire } from "../src/product-commerce/commerce-client.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

/**
 * CHARACTERIZATION, NOT SPECIFICATION (ADR-0028, increment 3).
 *
 * Checkout's quote input moves into a domain helper shared with
 * `createOrderFromCart` and, later, the x402 gate. The move is a pure refactor,
 * and this file is half of the proof (the domain's
 * `quote-input-and-line-snapshot.characterization.test.ts` is the other half):
 * it was written and recorded BEFORE the extraction and must pass unchanged
 * after it.
 *
 * It drives the real in-process client over a real document store and pins,
 * byte for byte (`JSON.stringify`, key order included):
 *  - the `QuoteCommand` `quoteCheckout` hands to `computeQuote` (observed by
 *    wrapping the real function, which still runs);
 *  - `quoteCheckout`'s reply;
 *  - the order DOCUMENT the same cart's `createOrder` stores — the bytes a
 *    deployment keeps — so the client's half and the domain's half are pinned
 *    together, end to end.
 * across physical and digital goods, a declared variant, both coupon kinds,
 * matched and absent zones, and USD, INR and JPY. Ids and time are
 * deterministic, so a document is comparable whole.
 *
 * Re-record only for a deliberate behaviour change, never to make a refactor
 * pass: `OTTA_RECORD_CHARACTERIZATION=1`.
 */

vi.mock("@otta-sh/domain", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@otta-sh/domain")>();
	return { ...actual, computeQuote: vi.fn(actual.computeQuote) };
});

const GOLDEN = new URL("./checkout-quote-input.golden.json", import.meta.url);
const RECORD = process.env["OTTA_RECORD_CHARACTERIZATION"] === "1";
/**
 * A name-filtered run (`-t`) skips cases, so it cannot tell an orphaned golden
 * entry from one whose case it did not run: the orphan check stands down.
 */
const FILTERED = process.argv.some(
	(arg) => arg === "-t" || arg.startsWith("-t=") || arg.startsWith("--testNamePattern"),
);
/**
 * The recording. In record mode it is SEEDED from the existing file and merged
 * into, never replaced, so re-recording a subset (`-t`), or a run in which a case
 * throws before it pins, keeps every other entry as it was.
 */
const golden: Record<string, unknown> = existsSync(GOLDEN)
	? (JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>)
	: {};
const pinned = new Set<string>();

/** Compare against the recording, by bytes; or, when recording, merge the value in. */
function pin(name: string, value: unknown): void {
	// Round-trip once so a Date and an ISO string compare the same way on both sides.
	const actual = JSON.parse(JSON.stringify(value)) as unknown;
	pinned.add(name);
	if (RECORD) {
		golden[name] = actual;
		const sorted = Object.fromEntries(
			Object.keys(golden)
				.toSorted()
				.map((key) => [key, golden[key]]),
		);
		writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, "\t")}\n`);
		return;
	}
	expect(name in golden, `no recording for "${name}"`).toBe(true);
	expect(JSON.stringify(actual, null, "\t")).toBe(JSON.stringify(golden[name], null, "\t"));
}

/** No orphans: on a full compare run, every golden entry was pinned by some case. */
afterAll(() => {
	if (RECORD || FILTERED) return;
	expect(
		Object.keys(golden).filter((key) => !pinned.has(key)),
		"golden entries no case pinned (stale: delete them, or re-record)",
	).toEqual([]);
});

const USD = currency("USD");
const INR = currency("INR");
const JPY = currency("JPY");

let h: InProcessCommerceHarness;
let seq = 0;

beforeEach(async () => {
	vi.mocked(computeQuote).mockClear();
	h = await makeInProcessCommerce({
		clock: new FixedClock(new Date("2026-07-10T00:00:00.000Z")),
		idGen: new CountingIdGen("id"),
		gateways: { stripe: new FakePaymentGateway({ id: "stripe" }) },
	});
});

afterEach(async () => {
	await h.close();
});

function quoteCommands(): QuoteCommand[] {
	return vi.mocked(computeQuote).mock.calls.map(([, command]) => command);
}

interface ProductSpec {
	productId: string;
	sku: string;
	priceCents: number;
	currency: Currency;
	title: string | null;
	kind: ProductKind;
	taxClass?: string;
}

async function seed(spec: ProductSpec): Promise<void> {
	await h.stores.productCommerce.upsert(
		{
			productId: brandProductId(spec.productId),
			sku: brandSku(spec.sku),
			price: money(cents(spec.priceCents), spec.currency),
			title: spec.title,
			productKind: spec.kind,
			...(spec.taxClass !== undefined ? { taxClass: spec.taxClass } : {}),
		},
		idempotencyKey(`seed-${seq++}`),
	);
	await h.stores.productCommerce.activate(
		brandProductId(spec.productId),
		idempotencyKey(`publish-${seq++}`),
		"2026-01-01T00:00:00.000Z",
	);
	if (spec.kind === "physical") {
		await h.stores.inventory.seedOnHand(spec.sku, 10);
	}
}

async function cart(
	cur: Currency,
	lines: Array<{ sku: string; productId: string; qty: number }>,
): Promise<string> {
	const { cartId } = await h.client.createCart(cur);
	for (const line of lines) {
		const added = await h.client.addCartLine(
			cartId,
			line.sku,
			line.productId,
			line.qty,
			`add-${seq++}`,
		);
		if (!added.ok) throw new Error(`seed addCartLine failed: ${added.reason}`);
	}
	return cartId;
}

async function zone(input: {
	id: string;
	regions: string[];
	currency: Currency;
	shippingCents: number;
	rates: Array<{ taxClassId: string; bps: number; appliesToShipping: boolean }>;
}): Promise<void> {
	const rules = h.stores.shippingRules;
	await rules.createZone({ id: input.id, name: input.id, regions: input.regions });
	await rules.createMethod({
		id: `m-${input.id}`,
		zoneId: input.id,
		name: "Flat",
		type: "flat_rate",
	});
	await rules.createRate({
		methodId: `m-${input.id}`,
		currency: input.currency,
		amountCents: cents(input.shippingCents),
		minSubtotalCents: null,
	});
	for (const rate of input.rates) {
		await h.stores.taxRules.createRate({
			id: `t-${input.id}-${rate.taxClassId}`,
			taxClassId: rate.taxClassId,
			zoneId: input.id,
			rateBps: rate.bps,
			appliesToShipping: rate.appliesToShipping,
		});
	}
}

async function coupon(
	code: string,
	kind: { fixed: number; currency: Currency } | { percentBps: number },
): Promise<void> {
	await h.stores.couponStore.create({
		id: `cpn-${code}`,
		code,
		type: "fixed" in kind ? "fixed_amount" : "percentage",
		amountCents: "fixed" in kind ? cents(kind.fixed) : null,
		rateBps: "fixed" in kind ? null : kind.percentBps,
		capCents: null,
		currency: "fixed" in kind ? kind.currency : null,
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: 10,
		maxUsesPerCustomer: null,
	});
}

const address = (country: string, region?: string) => ({
	name: "Ada Lovelace",
	line1: "1 Main St",
	city: "Springfield",
	postalCode: "90001",
	country,
	...(region !== undefined ? { region } : {}),
});

/**
 * Quote, then place the same cart, and pin the quote's input, the quote's reply
 * and the stored order document. `quote` is the review's request; `place` adds
 * what only the order carries (the full address).
 */
async function quoteThenPlace(
	name: string,
	quote: QuoteRequestWire,
	place: { shippingAddress?: ReturnType<typeof address> } = {},
): Promise<void> {
	const reply = await h.client.quoteCheckout(quote);
	expect(reply.ok, JSON.stringify(reply)).toBe(true);
	expect(quoteCommands()).toHaveLength(1);
	pin(`${name}.quoteCommand`, quoteCommands()[0]);
	pin(`${name}.quoteReply`, reply);

	const placed = await h.client.createOrder(
		{
			cartId: quote.cartId,
			paymentMethod: "stripe",
			buyerRef: "ada@example.com",
			...(quote.shippingMethodId !== undefined ? { shippingMethodId: quote.shippingMethodId } : {}),
			...(quote.couponCode !== undefined ? { couponCode: quote.couponCode } : {}),
			...(place.shippingAddress !== undefined ? { shippingAddress: place.shippingAddress } : {}),
		},
		`place-${quote.cartId}`,
	);
	expect(placed.ok, JSON.stringify(placed)).toBe(true);
	if (!placed.ok) return;
	const orders = h.ctx.storage?.["orders"];
	if (orders === undefined) throw new Error("orders is not declared");
	pin(`${name}.orderDocument`, await orders.get(placed.order.id));
}

describe("quoteCheckout's quote input, and the order the same cart places, as recorded", () => {
	test("USD, physical + digital, a matched zone with shipping tax, a percentage coupon", async () => {
		await seed({
			productId: "p1",
			sku: "MUG",
			priceCents: 1500,
			currency: USD,
			title: "Mug",
			kind: "physical",
		});
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
			taxClass: "reduced",
		});
		await zone({
			id: "z-us-ca",
			regions: ["US-CA"],
			currency: USD,
			shippingCents: 599,
			rates: [
				{ taxClassId: "standard", bps: 725, appliesToShipping: true },
				{ taxClassId: "reduced", bps: 300, appliesToShipping: false },
			],
		});
		await coupon("TENOFF", { percentBps: 1000 });
		const cartId = await cart(USD, [
			{ sku: "MUG", productId: "p1", qty: 2 },
			{ sku: "EBOOK", productId: "d1", qty: 1 },
		]);
		await quoteThenPlace(
			"usd-mixed-zoned-percent",
			{
				cartId,
				destination: { country: "US", region: "CA" },
				shippingMethodId: "m-z-us-ca",
				couponCode: "TENOFF",
			},
			{ shippingAddress: address("US", "CA") },
		);
	});

	test("USD, physical, a review with no address yet (address_needed)", async () => {
		await seed({
			productId: "p1",
			sku: "MUG",
			priceCents: 1500,
			currency: USD,
			title: "Mug",
			kind: "physical",
		});
		await zone({
			id: "z-us",
			regions: ["US"],
			currency: USD,
			shippingCents: 499,
			rates: [{ taxClassId: "standard", bps: 800, appliesToShipping: false }],
		});
		const cartId = await cart(USD, [{ sku: "MUG", productId: "p1", qty: 1 }]);
		const reply = await h.client.quoteCheckout({ cartId });
		pin("usd-physical-address-needed.quoteCommand", quoteCommands()[0]);
		pin("usd-physical-address-needed.quoteReply", reply);
	});

	test("USD, digital only, no address, a fixed coupon (the gate's shape)", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		await zone({
			id: "z-us",
			regions: ["US"],
			currency: USD,
			shippingCents: 499,
			rates: [{ taxClassId: "standard", bps: 800, appliesToShipping: false }],
		});
		await coupon("SAVE5", { fixed: 500, currency: USD });
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 3 }]);
		await quoteThenPlace("usd-digital-fixed", { cartId, couponCode: "SAVE5" });
	});

	test("USD, one digital line, no coupon, no zones", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 2500,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1 }]);
		await quoteThenPlace("usd-digital-single", { cartId });
	});

	test("INR, physical at a non-standard tax class with taxed shipping, and a digital line", async () => {
		await h.stores.taxRules.createClass({ id: "gst18", name: "GST 18%" });
		await seed({
			productId: "p-in",
			sku: "KETTLE",
			priceCents: 49900,
			currency: INR,
			title: "Kettle",
			kind: "physical",
			taxClass: "gst18",
		});
		await seed({
			productId: "d-in",
			sku: "RECIPES",
			priceCents: 19900,
			currency: INR,
			title: "Recipes",
			kind: "digital",
		});
		await zone({
			id: "z-in",
			regions: ["IN"],
			currency: INR,
			shippingCents: 4900,
			rates: [
				{ taxClassId: "gst18", bps: 1800, appliesToShipping: true },
				{ taxClassId: "standard", bps: 500, appliesToShipping: false },
			],
		});
		const cartId = await cart(INR, [
			{ sku: "KETTLE", productId: "p-in", qty: 1 },
			{ sku: "RECIPES", productId: "d-in", qty: 2 },
		]);
		await quoteThenPlace(
			"inr-physical-gst",
			{ cartId, destination: { country: "IN", region: "IN-KA" }, shippingMethodId: "m-z-in" },
			{ shippingAddress: address("IN", "KA") },
		);
	});

	test("JPY, a zero-decimal currency, digital, with a percentage coupon", async () => {
		await seed({
			productId: "d-jp",
			sku: "FONT",
			priceCents: 1200,
			currency: JPY,
			title: "Font",
			kind: "digital",
		});
		await coupon("JP15", { percentBps: 1500 });
		const cartId = await cart(JPY, [{ sku: "FONT", productId: "d-jp", qty: 2 }]);
		await quoteThenPlace("jpy-digital-percent", { cartId, couponCode: "JP15" });
	});

	test("a product with a declared variant is priced from its own row", async () => {
		await seed({
			productId: "v1",
			sku: "SHIRT",
			priceCents: 2500,
			currency: USD,
			title: "Shirt",
			kind: "digital",
		});
		await h.stores.productCommerce.upsertVariant(
			{ productId: brandProductId("v1"), variantKey: "red", title: "Red" },
			idempotencyKey(`variant-${seq++}`),
		);
		const cartId = await cart(USD, [{ sku: "SHIRT", productId: "v1", qty: 2 }]);
		await quoteThenPlace("usd-variant-product", { cartId });
	});
});

describe("quoteCheckout's line guards, as recorded", () => {
	test("an untitled product still quotes (only the order needs the title)", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1 }]);
		await h.stores.productCommerce.upsert(
			{ productId: brandProductId("d1"), title: null },
			idempotencyKey(`untitle-${seq++}`),
		);
		pin("untitled-quotes.quoteReply", await h.client.quoteCheckout({ cartId }));
		pin("untitled-quotes.quoteCommand", quoteCommands()[0]);
		pin(
			"untitled-quotes.placeReply",
			await h.client.createOrder(
				{ cartId, paymentMethod: "stripe", buyerRef: "ada@example.com" },
				`place-${cartId}`,
			),
		);
	});

	test("a product unpublished after add-to-cart is not priced, and nothing is quoted", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1 }]);
		await h.stores.productCommerce.deactivate(
			brandProductId("d1"),
			idempotencyKey(`unpublish-${seq++}`),
			"2026-02-01T00:00:00.000Z",
		);
		pin("unpublished.quoteReply", await h.client.quoteCheckout({ cartId }));
		expect(quoteCommands()).toHaveLength(0);
	});

	test("a cart in another currency than its product is a mismatch, and nothing is quoted", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		const cartId = await cart(INR, [{ sku: "EBOOK", productId: "d1", qty: 1 }]);
		pin("currency-mismatch.quoteReply", await h.client.quoteCheckout({ cartId }));
		expect(quoteCommands()).toHaveLength(0);
	});
});
