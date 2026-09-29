import { beforeEach, describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { previewCheckout, type PreviewCheckoutCommand } from "../pricing/checkout-preview.js";
import { computeQuote, type QuoteDeps } from "../pricing/quote.js";
import type { TotalsLineInput } from "../pricing/types.js";

/**
 * What a `checkoutPreviewContract` run needs: the three rules stores and a
 * clock, all bound to ONE adapter family, fresh per case (an empty store — the
 * "no zones configured" case depends on it).
 */
export interface CheckoutPreviewHarness {
	deps: QuoteDeps;
}

export interface CheckoutPreviewContractOptions {
	dialect: string;
}

const USD = currency("USD");
const EUR = currency("EUR");

/** 2 × $15.00 at the standard class — a 3000 subtotal every case reasons against. */
const PHYSICAL: ReadonlyArray<TotalsLineInput> = [
	{ unitPriceCents: cents(1500), qty: 2, taxClassId: "standard" },
];

function cmd(over: Partial<PreviewCheckoutCommand> = {}): PreviewCheckoutCommand {
	return { currency: USD, lines: PHYSICAL, requiresShipping: true, ...over };
}

/**
 * Behavioral spec for issue #305's checkout preview: the shipping zone is
 * DERIVED from the buyer's address (country, and region where a zone lists
 * one) — never chosen by the buyer — and tax is priced in that same zone. Run
 * against every rules-store adapter family (fake, SQLite, Postgres), because
 * the zone's `regions` list has to survive the store's round trip for the
 * match to work at all.
 */
export function checkoutPreviewContract(
	makeHarness: () => Promise<CheckoutPreviewHarness>,
	opts: CheckoutPreviewContractOptions,
): void {
	describe(`checkoutPreviewContract [${opts.dialect}]`, () => {
		let deps: QuoteDeps;

		beforeEach(async () => {
			({ deps } = await makeHarness());
		});

		/** A US zone (flat $5.99 + free-over-$50 with a $7.99 fallback), a US-West
		 *  zone that lists subdivisions (flat $9.99), an EU zone (flat €8 only — no
		 *  USD rate), a 10% US tax that also taxes shipping, 5% in US-West. */
		async function seedRules(): Promise<void> {
			const s = deps.shippingRules;
			await s.createZone({ id: "z-us", name: "United States", regions: ["US"] });
			await s.createZone({ id: "z-west", name: "US West", regions: ["US-CA", "US-OR"] });
			await s.createZone({ id: "z-eu", name: "Europe", regions: ["FR", "DE"] });
			await s.createMethod({
				id: "m-us-flat",
				zoneId: "z-us",
				name: "Standard",
				type: "flat_rate",
			});
			await s.createMethod({
				id: "m-us-free",
				zoneId: "z-us",
				name: "Free over $50",
				type: "free_shipping",
			});
			await s.createMethod({
				id: "m-us-unpriced",
				zoneId: "z-us",
				name: "Never priced",
				type: "flat_rate",
			});
			await s.createMethod({ id: "m-west", zoneId: "z-west", name: "West", type: "flat_rate" });
			await s.createMethod({ id: "m-eu", zoneId: "z-eu", name: "EU", type: "flat_rate" });
			await s.createRate({
				methodId: "m-us-flat",
				currency: USD,
				amountCents: cents(599),
				minSubtotalCents: null,
			});
			await s.createRate({
				methodId: "m-us-free",
				currency: USD,
				amountCents: cents(799),
				minSubtotalCents: cents(5000),
			});
			await s.createRate({
				methodId: "m-west",
				currency: USD,
				amountCents: cents(999),
				minSubtotalCents: null,
			});
			await s.createRate({
				methodId: "m-eu",
				currency: EUR,
				amountCents: cents(800),
				minSubtotalCents: null,
			});
			await deps.taxRules.createRate({
				id: "t-us",
				taxClassId: "standard",
				zoneId: "z-us",
				rateBps: 1000,
				appliesToShipping: true,
			});
			await deps.taxRules.createRate({
				id: "t-west",
				taxClassId: "standard",
				zoneId: "z-west",
				rateBps: 500,
				appliesToShipping: false,
			});
		}

		async function seedCoupon(over: {
			id: string;
			code: string;
			amount: number;
			expiresAt?: string | null;
		}): Promise<void> {
			await deps.couponStore.create({
				id: over.id,
				code: over.code,
				type: "fixed_amount",
				amountCents: cents(over.amount),
				rateBps: null,
				capCents: null,
				currency: USD,
				minSubtotalCents: null,
				startsAt: null,
				expiresAt: over.expiresAt ?? null,
				maxUses: null,
				maxUsesPerCustomer: null,
			});
		}

		test("an address in a configured zone offers that zone's priced methods, each at its price for this cart", async () => {
			await seedRules();
			const r = await previewCheckout(deps, cmd({ destination: { country: "US", region: "NY" } }));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toMatchObject({
				status: "resolved",
				zone: { id: "z-us", name: "United States" },
				selectedMethodId: null,
				selectionError: null,
			});
			if (r.shipping.status !== "resolved") return;
			// The never-priced method is not offered — it has no USD rate to charge.
			expect(r.shipping.methods.map((m) => [m.id, m.priceCents]).toSorted()).toEqual([
				["m-us-flat", 599],
				// 3000 < the 5000 threshold ⇒ the below-threshold fallback fee.
				["m-us-free", 799],
			]);
			// No method chosen yet: nothing is charged for shipping, but the line tax
			// is ALREADY priced in the derived zone.
			expect(r.breakdown).toMatchObject({ subtotalCents: 3000, shippingCents: 0, taxCents: 300 });
			expect(r.selection).toEqual({
				shippingZoneId: "z-us",
				shippingMethodId: null,
				couponCode: null,
			});
		});

		test("choosing an offered method charges its shipping, and the derived zone taxes it", async () => {
			await seedRules();
			const r = await previewCheckout(
				deps,
				cmd({ destination: { country: "us" }, shippingMethodId: "m-us-flat" }),
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toMatchObject({ status: "resolved", selectedMethodId: "m-us-flat" });
			// 3000 + 599 shipping + 10% on lines (300) + 10% on shipping (60, half-up of 59.9).
			expect(r.breakdown).toMatchObject({
				subtotalCents: 3000,
				shippingCents: 599,
				shippingTaxCents: 60,
				taxCents: 360,
				totalCents: 3959,
			});
			expect(r.selection).toEqual({
				shippingZoneId: "z-us",
				shippingMethodId: "m-us-flat",
				couponCode: null,
			});
		});

		test("the zone's regions survive the store: a subdivision entry beats the whole-country zone", async () => {
			await seedRules();
			const r = await previewCheckout(
				deps,
				cmd({ destination: { country: "US", region: "CA" }, shippingMethodId: "m-west" }),
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toMatchObject({ status: "resolved", zone: { id: "z-west" } });
			// 3000 + 999, tax 5% on lines only (the West rate does not tax shipping).
			expect(r.breakdown).toMatchObject({ shippingCents: 999, taxCents: 150, totalCents: 4149 });
		});

		test("a method from ANOTHER zone is refused as not available here — never charged, never re-zoning the tax", async () => {
			await seedRules();
			// A California address picking the cheaper whole-US method.
			const r = await previewCheckout(
				deps,
				cmd({ destination: { country: "US", region: "CA" }, shippingMethodId: "m-us-flat" }),
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toMatchObject({
				status: "resolved",
				zone: { id: "z-west" },
				selectedMethodId: null,
				selectionError: "SHIPPING_METHOD_NOT_AVAILABLE",
			});
			// Tax stays in the DERIVED zone (5%), and no shipping is charged.
			expect(r.breakdown).toMatchObject({ shippingCents: 0, taxCents: 150 });
			expect(r.selection.shippingMethodId).toBeNull();
		});

		test("computeQuote itself refuses a method that does not belong to the zone it is taxed in", async () => {
			await seedRules();
			const q = await computeQuote(deps, {
				currency: USD,
				lines: PHYSICAL,
				zoneId: "z-west",
				methodId: "m-us-flat",
			});
			expect(q).toEqual({ ok: false, reason: "SHIPPING_METHOD_NOT_IN_ZONE" });
		});

		test("an address no zone lists is a typed NO_ZONE_FOR_ADDRESS — no shipping, no tax, no silent zero", async () => {
			await seedRules();
			const r = await previewCheckout(deps, cmd({ destination: { country: "JP" } }));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toEqual({ status: "unavailable", reason: "NO_ZONE_FOR_ADDRESS" });
			expect(r.selection.shippingZoneId).toBeNull();
			expect(r.breakdown).toMatchObject({ shippingCents: 0, taxCents: 0 });
		});

		test("a zone with no method priced in the cart's currency is NO_METHOD_FOR_ZONE", async () => {
			await seedRules();
			const r = await previewCheckout(deps, cmd({ destination: { country: "FR" } }));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toEqual({ status: "unavailable", reason: "NO_METHOD_FOR_ZONE" });
		});

		test("a physical cart with no address yet is address_required", async () => {
			await seedRules();
			const r = await previewCheckout(deps, cmd());
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toEqual({ status: "address_required" });
			expect(r.breakdown).toMatchObject({ shippingCents: 0, taxCents: 0, totalCents: 3000 });
		});

		test("a digital-only cart needs no address and no zone — today's behaviour, even with an address", async () => {
			await seedRules();
			const r = await previewCheckout(
				deps,
				cmd({
					requiresShipping: false,
					destination: { country: "US" },
					shippingMethodId: "m-us-flat",
				}),
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toEqual({ status: "not_required" });
			expect(r.breakdown).toMatchObject({ shippingCents: 0, taxCents: 0, totalCents: 3000 });
			expect(r.selection).toEqual({
				shippingZoneId: null,
				shippingMethodId: null,
				couponCode: null,
			});
		});

		test("a store with NO zones configured reports not_configured rather than refusing every address", async () => {
			const r = await previewCheckout(deps, cmd({ destination: { country: "US" } }));
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.shipping).toEqual({ status: "not_configured" });
			expect(r.breakdown).toMatchObject({ shippingCents: 0, taxCents: 0, totalCents: 3000 });
		});

		test("a valid coupon is applied, and the free-shipping threshold is judged on the DISCOUNTED subtotal", async () => {
			await seedRules();
			await seedCoupon({ id: "c-ok", code: "SAVE5", amount: 500 });
			const r = await previewCheckout(
				deps,
				cmd({
					lines: [{ unitPriceCents: cents(2600), qty: 2, taxClassId: "standard" }], // 5200
					destination: { country: "US" },
					shippingMethodId: "m-us-free",
					couponCode: "SAVE5",
				}),
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.coupon).toEqual({ status: "applied", code: "SAVE5", discountCents: 500 });
			// 5200 − 500 = 4700 < 5000 ⇒ the free method falls back to 799.
			expect(r.breakdown).toMatchObject({ discountCents: 500, shippingCents: 799 });
			if (r.shipping.status !== "resolved") throw new Error("expected a resolved zone");
			expect(r.shipping.methods.find((m) => m.id === "m-us-free")?.priceCents).toBe(799);
			expect(r.selection.couponCode).toBe("SAVE5");
		});

		test.each([
			["an unknown code", "NOPE", "COUPON_NOT_FOUND"],
			["an expired code", "OLD5", "COUPON_NOT_ACTIVE"],
		] as const)(
			"%s is reported invalid with its reason, and the rest of the preview still prices",
			async (_label, code, reason) => {
				await seedRules();
				await seedCoupon({
					id: "c-old",
					code: "OLD5",
					amount: 500,
					expiresAt: "2000-01-01T00:00:00.000Z",
				});
				const r = await previewCheckout(
					deps,
					cmd({ destination: { country: "US" }, shippingMethodId: "m-us-flat", couponCode: code }),
				);
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				expect(r.coupon).toEqual({ status: "invalid", code, reason });
				expect(r.breakdown).toMatchObject({ discountCents: 0, shippingCents: 599, taxCents: 360 });
				expect(r.selection.couponCode).toBeNull();
			},
		);
	});
}
