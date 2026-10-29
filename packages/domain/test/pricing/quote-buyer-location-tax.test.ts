import { RecordingLogger } from "../../src/testing/recording-logger.js";
import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency } from "../../src/money/cents.js";
import { idempotencyKey } from "../../src/money/ids.js";
import { computeQuote, type QuoteCommand, type QuoteDeps } from "../../src/pricing/quote.js";
import type { TaxCalculator, TaxRequest } from "../../src/pricing/tax-calculator.js";
import { NEW_STORE_TAX_SETTINGS, type TaxSettings } from "../../src/pricing/tax-settings.js";
import { CountingIdGen, FixedClock } from "../../src/testing/deterministic.js";
import { InMemoryCouponStore } from "../../src/testing/in-memory-coupon-store.js";
import { InMemorySettingsStore } from "../../src/testing/in-memory-settings-store.js";
import { InMemoryShippingRulesStore } from "../../src/testing/in-memory-shipping-rules-store.js";
import { InMemoryTaxRulesStore } from "../../src/testing/in-memory-tax-rules-store.js";

/**
 * Issue #426: "Calculate tax based on: customer billing address" (WooCommerce's
 * `woocommerce_tax_based_on` = `billing`). A cart that ships nothing has no
 * ship-to, so with this option it is taxed where the BUYER is — the billing
 * location the checkout collects — instead of at the shop's base address. Any
 * other option leaves digital carts exactly as before, and a cart that ships
 * is always taxed by its ship-to (Otta's only address for it).
 */
const USD = currency("USD");
let deps: QuoteDeps;
let logger: RecordingLogger;
let settings: InMemorySettingsStore;
let seq = 0;

beforeEach(async () => {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const shippingRules = new InMemoryShippingRulesStore();
	const taxRules = new InMemoryTaxRulesStore();
	settings = new InMemorySettingsStore();
	const couponStore = new InMemoryCouponStore({ idGen: new CountingIdGen("red"), clock });
	logger = new RecordingLogger();
	deps = { shippingRules, taxRules, couponStore, clock, logger, settings };
	// The shop is in the UK (20%); buyers in Germany (19%) and the US (CA 7.25%).
	await shippingRules.createZone({ id: "z-gb", name: "UK", regions: ["GB"] });
	await shippingRules.createZone({ id: "z-de", name: "Germany", regions: ["DE"] });
	await shippingRules.createZone({ id: "z-ca", name: "California", regions: ["US-CA"] });
	for (const z of ["z-gb", "z-de", "z-ca"]) {
		await shippingRules.createMethod({ id: `m-${z}`, zoneId: z, name: "Flat", type: "flat_rate" });
		await shippingRules.createRate({
			methodId: `m-${z}`,
			currency: USD,
			amountCents: cents(500),
			minSubtotalCents: null,
		});
	}
	await taxRules.createClass({ id: "standard", name: "VAT" });
	for (const [zoneId, rateBps] of [
		["z-gb", 2000],
		["z-de", 1900],
		["z-ca", 725],
	] as const) {
		await taxRules.createRate({
			id: `t-${zoneId}`,
			taxClassId: "standard",
			zoneId,
			rateBps,
			appliesToShipping: true,
		});
	}
});

async function save(tax: TaxSettings): Promise<void> {
	await settings.update({ tax }, idempotencyKey(`k-${seq++}`));
}

const SHOP_IN_GB: TaxSettings = {
	...NEW_STORE_TAX_SETTINGS,
	enabled: true,
	baseAddress: { country: "GB", region: null },
};
const BY_BUYER: TaxSettings = { ...SHOP_IN_GB, basedOn: "billing" };

const digital = (billingLocation?: QuoteCommand["billingLocation"]): QuoteCommand => ({
	currency: USD,
	lines: [{ unitPriceCents: cents(1000), qty: 1, taxClassId: "standard", requiresShipping: false }],
	requiresShipping: false,
	...(billingLocation !== undefined ? { billingLocation } : {}),
});

function spy(): TaxCalculator & { seen: TaxRequest[] } {
	const seen: TaxRequest[] = [];
	return {
		id: "acme.tax",
		seen,
		async calculate(req) {
			seen.push(req);
			return {
				ok: true,
				currency: req.currency,
				lines: req.lines.map((l) => ({
					lineId: l.lineId,
					rateBps: 0,
					label: "X",
					taxCents: cents(0),
				})),
				shipping: null,
			};
		},
	};
}

describe("setting OFF (based on shipping or base): digital carts exactly as before", () => {
	test.each<TaxSettings["basedOn"]>(["shipping", "base"])(
		"based on %s: a billing location is ignored — taxed at the base address, nothing recorded",
		async (basedOn) => {
			await save({ ...SHOP_IN_GB, basedOn });
			const without = await computeQuote(deps, digital());
			const withLocation = await computeQuote(deps, digital({ country: "DE", region: null }));
			if (!without.ok || !withLocation.ok) throw new Error("refused");
			expect(withLocation.breakdown.taxCents).toBe(200); // the UK's 20%
			expect(withLocation).toEqual(without);
			expect("taxAddress" in withLocation).toBe(false);
		},
	);

	test("a malformed billing location is still ignored, never refused", async () => {
		await save(SHOP_IN_GB);
		const q = await computeQuote(deps, digital({ country: "ZZ", region: "nope" }));
		expect(q.ok).toBe(true);
	});
});

describe("setting ON (based on the customer's billing address)", () => {
	test("a digital-only cart is taxed at the buyer's billing country, and says where", async () => {
		await save(BY_BUYER);
		const q = await computeQuote(deps, digital({ country: " de ", region: null }));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(190); // Germany's 19%, not the UK's 20%
		expect(q.taxLocated).toBe(true);
		expect(q.taxAddress).toEqual({ basis: "billing", country: "DE", region: null });
	});

	test("the buyer's region picks a region-level zone", async () => {
		await save(BY_BUYER);
		const q = await computeQuote(deps, digital({ country: "US", region: "ca" }));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(73); // 7.25% of 1000, half up
		expect(q.taxAddress).toEqual({ basis: "billing", country: "US", region: "CA" });
	});

	test("the calculator is asked for the billing location and the zone it matched", async () => {
		await save(BY_BUYER);
		const calc = spy();
		await computeQuote({ ...deps, taxCalculator: calc }, digital({ country: "DE" }));
		expect(calc.seen[0]?.destination).toEqual({
			country: "DE",
			region: null,
			postalCode: null,
			city: null,
		});
		expect(calc.seen[0]?.zoneId).toBe("z-de");
	});

	test("no billing location given ⇒ the base address, as before — and the basis says so", async () => {
		await save(BY_BUYER);
		const q = await computeQuote(deps, digital());
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(200);
		expect(q.taxAddress).toEqual({ basis: "base", country: "GB", region: null });
	});

	test("no billing location and no base address ⇒ untaxed, as before, nothing recorded", async () => {
		await save({ ...BY_BUYER, baseAddress: null });
		const q = await computeQuote(deps, digital());
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(0);
		expect("taxAddress" in q).toBe(false);
	});

	test("a billing location no zone matches ⇒ 0%, never a refusal, still recorded", async () => {
		await save(BY_BUYER);
		const q = await computeQuote(deps, digital({ country: "FR" }));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(0);
		expect(q.taxLocated).toBe(false);
		expect(q.taxAddress).toEqual({ basis: "billing", country: "FR", region: null });
	});

	test("a country that is not an ISO code is refused like a ship-to's", async () => {
		await save(BY_BUYER);
		expect(await computeQuote(deps, digital({ country: "ZZ" }))).toEqual({
			ok: false,
			reason: "INVALID_SHIPPING_ADDRESS",
		});
	});

	test("a region that is not a subdivision of the country is refused like a ship-to's", async () => {
		await save(BY_BUYER);
		expect(await computeQuote(deps, digital({ country: "US", region: "XX" }))).toEqual({
			ok: false,
			reason: "SHIPPING_REGION_CODE_REQUIRED",
		});
	});

	test("tax switched off ⇒ no tax, nothing recorded", async () => {
		await save({ ...BY_BUYER, enabled: false });
		const q = await computeQuote(deps, digital({ country: "DE" }));
		if (!q.ok) throw new Error(q.reason);
		expect(q.breakdown.taxCents).toBe(0);
		expect("taxAddress" in q).toBe(false);
	});

	test("a cart that ships is still taxed by its ship-to; the billing location is not read", async () => {
		await save(BY_BUYER);
		const shipsToGb: QuoteCommand = {
			currency: USD,
			lines: [
				{ unitPriceCents: cents(1000), qty: 1, taxClassId: "standard", requiresShipping: true },
				{ unitPriceCents: cents(1000), qty: 1, taxClassId: "standard", requiresShipping: false },
			],
			requiresShipping: true,
			destination: { country: "GB", region: null },
			methodId: "m-z-gb",
		};
		const plain = await computeQuote(deps, shipsToGb);
		const withBilling = await computeQuote(deps, {
			...shipsToGb,
			billingLocation: { country: "DE", region: null },
		});
		if (!plain.ok || !withBilling.ok) throw new Error("refused");
		expect(withBilling.breakdown.taxCents).toBe(400 + 100); // UK 20% on 2000 + shipping
		expect(withBilling).toEqual(plain);
		expect(withBilling.taxAddress).toEqual({ basis: "shipping", country: "GB", region: null });
	});
});

describe("a country whose zones go down to its regions (review round 1)", () => {
	beforeEach(async () => {
		// Spain 21%, with the Canaries (ES-CN) zoned apart and untaxed here.
		await deps.shippingRules.createZone({ id: "z-es", name: "Spain", regions: ["ES"] });
		await deps.shippingRules.createZone({ id: "z-cn", name: "Canaries", regions: ["ES-CN"] });
		await deps.taxRules.createRate({
			id: "t-es",
			taxClassId: "standard",
			zoneId: "z-es",
			rateBps: 2100,
			appliesToShipping: true,
		});
		await save(BY_BUYER);
	});

	test("no region ⇒ SHIPPING_REGION_CODE_REQUIRED (as a ship-to), never a silent 0%", async () => {
		expect(await computeQuote(deps, digital({ country: "ES", region: null }))).toEqual({
			ok: false,
			reason: "SHIPPING_REGION_CODE_REQUIRED",
		});
	});

	test("a mainland region ⇒ the country zone's 21%; the Canaries ⇒ their own zone", async () => {
		const madrid = await computeQuote(deps, digital({ country: "ES", region: "MD" }));
		if (!madrid.ok) throw new Error(madrid.reason);
		expect(madrid.breakdown.taxCents).toBe(210);
		const canaries = await computeQuote(deps, digital({ country: "ES", region: "CN" }));
		if (!canaries.ok) throw new Error(canaries.reason);
		expect(canaries.breakdown.taxCents).toBe(0);
		expect(canaries.taxLocated).toBe(true);
	});
});
