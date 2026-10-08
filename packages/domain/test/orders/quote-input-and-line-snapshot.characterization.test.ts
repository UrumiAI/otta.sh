import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cents, currency, money, type Currency } from "../../src/money/cents.js";
import {
	idempotencyKey,
	productId as brandProductId,
	sku as brandSku,
} from "../../src/money/ids.js";
import { addLine, createCart } from "../../src/cart/use-cases.js";
import {
	createOrderFromCart,
	type CreateOrderCommand,
} from "../../src/orders/create-order-from-cart.js";
import type { CreateOrderInput } from "../../src/ports/order-store.js";
import type { ProductKind } from "../../src/ports/product-commerce-store.js";
import { computeQuote, type QuoteCommand } from "../../src/pricing/quote.js";
import { makeOrderHarness, type OrderHarness } from "./fake-harness.js";

/**
 * CHARACTERIZATION, NOT SPECIFICATION (ADR-0028, increment 3).
 *
 * The increment extracts the quote-input and line-snapshot helpers out of
 * `createOrderFromCart` so any other caller can build the same quote and the same
 * order lines. It is a pure refactor, and this file is the proof: it was written
 * and its golden file recorded BEFORE the extraction, against the code as it then
 * stood, and it must pass unchanged after.
 *
 * What it pins, byte for byte (`JSON.stringify`, so key ORDER counts as well as
 * values — a stored document is bytes, not a set of fields):
 *  - the `QuoteCommand` handed to `computeQuote` (observed by wrapping the real
 *    function, which still runs);
 *  - the whole `CreateOrderInput` handed to `orderStore.createFromCart` — the line
 *    snapshots, the totals, the ship-to;
 *  - the `Order` the store then holds.
 * across physical and digital goods, a declared variant, both coupon kinds,
 * matched / unmatched / absent shipping zones, and USD, INR and JPY. The refusals
 * pin the guard ORDER as well, since a helper that reordered two checks would
 * change which reason a buyer is told.
 *
 * The golden file is the recording. To re-record (only ever for a deliberate
 * behaviour change, never to make a refactor pass) run with
 * `OTTA_RECORD_CHARACTERIZATION=1`.
 */

vi.mock("../../src/pricing/quote.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/pricing/quote.js")>();
	return { ...actual, computeQuote: vi.fn(actual.computeQuote) };
});

const GOLDEN = new URL("./quote-input-and-line-snapshot.golden.json", import.meta.url);
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

let h: OrderHarness;
let seq = 0;
let created: CreateOrderInput[];

beforeEach(() => {
	h = makeOrderHarness();
	vi.mocked(computeQuote).mockClear();
	created = [];
	const original = h.orderStore.createFromCart.bind(h.orderStore);
	h.orderStore.createFromCart = async (input) => {
		created.push(input);
		return original(input);
	};
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
	onHand?: number;
}

async function seed(spec: ProductSpec): Promise<void> {
	await h.productCommerce.upsert(
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
	await h.productCommerce.activate(
		brandProductId(spec.productId),
		idempotencyKey(`publish-${seq++}`),
		"2026-01-01T00:00:00.000Z",
	);
	if (spec.kind === "physical") h.inventory.seed(spec.sku, spec.onHand ?? 10);
}

interface LineSpec {
	sku: string;
	productId: string | null;
	qty: number;
	kind: "physical" | "digital";
}

async function cart(cur: Currency, specs: LineSpec[]): Promise<string> {
	const cartId = await createCart(h.cartDeps, cur);
	for (const spec of specs) {
		const res = await addLine(
			h.cartDeps,
			cartId,
			brandSku(spec.sku),
			spec.productId,
			spec.qty,
			idempotencyKey(`add-${seq++}`),
			spec.kind,
		);
		if (!res.ok) throw new Error(`seed addLine failed: ${res.reason}`);
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
	await h.shippingRules.createZone({ id: input.id, name: input.id, regions: input.regions });
	await h.shippingRules.createMethod({
		id: `m-${input.id}`,
		zoneId: input.id,
		name: "Flat",
		type: "flat_rate",
	});
	await h.shippingRules.createRate({
		methodId: `m-${input.id}`,
		currency: input.currency,
		amountCents: cents(input.shippingCents),
		minSubtotalCents: null,
	});
	for (const rate of input.rates) {
		await h.taxRules.createRate({
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
	await h.couponStore.create({
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

function cmd(cartId: string, over: Partial<CreateOrderCommand> = {}): CreateOrderCommand {
	return {
		cartId,
		idempotencyKey: idempotencyKey(`k-${cartId}`),
		buyerRef: "ada@example.com",
		paymentMethod: "stripe",
		...over,
	};
}

const address = (country: string, region?: string) => ({
	name: "Ada Lovelace",
	line1: "1 Main St",
	city: "Springfield",
	postalCode: "90001",
	country,
	...(region !== undefined ? { region } : {}),
});

/** Run the checkout and pin all three observations under `name`. */
async function placeAndPin(name: string, command: CreateOrderCommand): Promise<void> {
	const result = await createOrderFromCart(h.createDeps, command);
	expect(result.ok, JSON.stringify(result)).toBe(true);
	expect(quoteCommands()).toHaveLength(1);
	expect(created).toHaveLength(1);
	pin(`${name}.quoteCommand`, quoteCommands()[0]);
	pin(`${name}.createOrderInput`, created[0]);
	pin(`${name}.order`, await h.orderStore.getByIdempotencyKey(command.idempotencyKey));
}

describe("createOrderFromCart: the quote input and the line snapshot, as recorded", () => {
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
			{ sku: "MUG", productId: "p1", qty: 2, kind: "physical" },
			{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" },
		]);
		await placeAndPin(
			"usd-mixed-zoned-percent",
			cmd(cartId, {
				shippingAddress: address("US", "CA"),
				shippingMethodId: "m-z-us-ca",
				couponCode: "TENOFF",
			}),
		);
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
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 3, kind: "digital" }]);
		await placeAndPin("usd-digital-fixed", cmd(cartId, { couponCode: "SAVE5" }));
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
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);
		await placeAndPin("usd-digital-single", cmd(cartId));
	});

	test("USD, physical with no zones configured and no address", async () => {
		await seed({
			productId: "p1",
			sku: "MUG",
			priceCents: 1500,
			currency: USD,
			title: "Mug",
			kind: "physical",
		});
		const cartId = await cart(USD, [{ sku: "MUG", productId: "p1", qty: 4, kind: "physical" }]);
		await placeAndPin("usd-physical-no-zones", cmd(cartId));
	});

	test("INR, physical at a non-standard tax class with taxed shipping, and a digital line", async () => {
		await h.taxRules.createClass({ id: "gst18", name: "GST 18%" });
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
			{ sku: "KETTLE", productId: "p-in", qty: 1, kind: "physical" },
			{ sku: "RECIPES", productId: "d-in", qty: 2, kind: "digital" },
		]);
		await placeAndPin(
			"inr-physical-gst",
			cmd(cartId, { shippingAddress: address("IN", "KA"), shippingMethodId: "m-z-in" }),
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
		const cartId = await cart(JPY, [{ sku: "FONT", productId: "d-jp", qty: 2, kind: "digital" }]);
		await placeAndPin("jpy-digital-percent", cmd(cartId, { couponCode: "JP15" }));
	});

	test("a product with a declared variant: the line keeps the cart's sku, the price is the product row's", async () => {
		await seed({
			productId: "v1",
			sku: "SHIRT",
			priceCents: 2500,
			currency: USD,
			title: "Shirt",
			kind: "physical",
		});
		await h.productCommerce.upsertVariant(
			{ productId: brandProductId("v1"), variantKey: "red", title: "Red" },
			idempotencyKey(`variant-${seq++}`),
		);
		h.inventory.seed("SHIRT-RED", 5);
		const cartId = await cart(USD, [
			{ sku: "SHIRT", productId: "v1", qty: 1, kind: "physical" },
			{ sku: "SHIRT-RED", productId: "v1", qty: 2, kind: "physical" },
		]);
		await placeAndPin("usd-variant-sku", cmd(cartId));
	});
});

describe("createOrderFromCart: the line guards, in their recorded order", () => {
	async function refuse(name: string, cartId: string): Promise<void> {
		const result = await createOrderFromCart(h.createDeps, cmd(cartId));
		pin(`${name}.result`, result);
		expect(quoteCommands()).toHaveLength(0);
		expect(created).toHaveLength(0);
	}

	test("a line with no product id is refused before a later line's currency mismatch", async () => {
		await seed({
			productId: "p-in",
			sku: "KETTLE",
			priceCents: 49900,
			currency: INR,
			title: "Kettle",
			kind: "digital",
		});
		const cartId = await cart(USD, [
			{ sku: "LOOSE", productId: null, qty: 1, kind: "digital" },
			{ sku: "KETTLE", productId: "p-in", qty: 1, kind: "digital" },
		]);
		await refuse("refuse-null-product-first", cartId);
	});

	test("a currency mismatch is refused before a later line's missing product", async () => {
		await seed({
			productId: "p-in",
			sku: "KETTLE",
			priceCents: 49900,
			currency: INR,
			title: "Kettle",
			kind: "digital",
		});
		const cartId = await cart(USD, [
			{ sku: "KETTLE", productId: "p-in", qty: 1, kind: "digital" },
			{ sku: "LOOSE", productId: null, qty: 1, kind: "digital" },
		]);
		await refuse("refuse-currency-first", cartId);
	});

	test("an untitled product is not priced for an order", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: null,
			kind: "digital",
		});
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);
		await refuse("refuse-untitled", cartId);
	});

	test("a product unpublished after add-to-cart is not priced", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);
		await h.productCommerce.deactivate(
			brandProductId("d1"),
			idempotencyKey(`unpublish-${seq++}`),
			"2026-02-01T00:00:00.000Z",
		);
		await refuse("refuse-unpublished", cartId);
	});

	test("a line that turned physical after add-to-cart, holding no reservation, is RESERVATION_LOST", async () => {
		await seed({
			productId: "d1",
			sku: "EBOOK",
			priceCents: 999,
			currency: USD,
			title: "Ebook",
			kind: "digital",
		});
		const cartId = await cart(USD, [{ sku: "EBOOK", productId: "d1", qty: 1, kind: "digital" }]);
		await h.productCommerce.upsert(
			{ productId: brandProductId("d1"), productKind: "physical" },
			idempotencyKey(`flip-${seq++}`),
		);
		await refuse("refuse-flipped-physical", cartId);
	});
});
