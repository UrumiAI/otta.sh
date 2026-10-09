/**
 * The state/province pick list (lib/regions.ts): the chosen country's
 * subdivisions, named and sorted for the locale, with a stored or typed region
 * preselected by its CODE — and, for the view, rendered as a `<select>` for a
 * country with subdivisions and not at all for one without. Rendered with the
 * Container API (no client JS: the server output IS the page).
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import type { CheckoutSummaryView } from "@otta-sh/plugin";
import { byLabel, countryOptions } from "../src/lib/countries.js";
import { regionChoice, regionListIsStale } from "../src/lib/regions.js";
import type { CheckoutModel } from "../src/themes/contract.js";
import CheckoutView from "../src/themes/tempered/CheckoutView.astro";

describe("regionChoice", () => {
	test("a country with subdivisions: every one, by NAME, the code as the value", () => {
		const us = regionChoice("US", "", "en-US");
		expect(us.country).toBe("US");
		expect(us.options).toContainEqual({ code: "CA", label: "California" });
		expect(us.options).toContainEqual({ code: "NY", label: "New York" });
		const labels = us.options.map((o) => o.label);
		expect(labels).toEqual([...labels].toSorted((a, b) => a.localeCompare(b, "en-US")));
		expect(us.selected).toBe("");
	});

	test.each([
		["CA", "CA"],
		["ca", "CA"],
		["US-CA", "CA"],
		["us-ca", "CA"],
		[" CA ", "CA"],
	])("a stored/typed %j preselects %s", (value, selected) => {
		expect(regionChoice("us", value, "en-US").selected).toBe(selected);
	});

	test.each(["MX-CA", "ON", "ZZ", "California"])(
		"%j is not one of the country's codes: nothing is preselected, no option is invented",
		(value) => {
			const choice = regionChoice("US", value, "en-US");
			expect(choice.selected).toBe("");
			expect(choice.options.some((o) => o.code === value)).toBe(false);
		},
	);

	test("a country without subdivisions, no country, or a non-country: no list at all", () => {
		expect(regionChoice("AQ", "", "en-US")).toEqual({ country: "AQ", options: [], selected: "" });
		expect(regionChoice("", "CA", "en-US")).toEqual({ country: "", options: [], selected: "" });
		expect(regionChoice("ZZ", "CA", "en-US").options).toEqual([]);
	});

	test("an unknown locale still sorts (and never throws)", () => {
		expect(regionChoice("IN", "KA", "not a locale!").selected).toBe("KA");
	});
});

describe("the sorted list is cached per country and locale", () => {
	test("the same list object comes back, and equal labels compare 0", () => {
		expect(regionChoice("GB", "", "en-US").options).toBe(regionChoice("gb", "x", "en-US").options);
		expect(byLabel("en-US")({ label: "A" }, { label: "A" })).toBe(0);
		expect(byLabel("not a locale!")({ label: "A" }, { label: "A" })).toBe(0);
		expect(byLabel("not a locale!")({ label: "A" }, { label: "B" })).toBe(-1);
	});
});

describe("regionListIsStale", () => {
	test("only when the form carries the list's country and the posted country differs", () => {
		expect(regionListIsStale(undefined, "US")).toBe(false);
		expect(regionListIsStale("US", "us")).toBe(false);
		expect(regionListIsStale("US", "IN")).toBe(true);
		expect(regionListIsStale("", "US")).toBe(true);
		expect(regionListIsStale("US", undefined)).toBe(true);
	});
});

/** One rendered `<select name=…>`, options and all, or "". */
const regionSelect = (html: string, name: string): string =>
	new RegExp(`<select[^>]*name="${name}"[^>]*>[\\s\\S]*?</select>`).exec(html)?.[0] ?? "";

describe("the Tempered review, rendered", () => {
	let container: AstroContainer;
	beforeAll(async () => {
		container = await AstroContainer.create();
	});

	const amount = { money: null, label: "—" };
	const countries = countryOptions("en-US");

	function model(
		overrides: Partial<CheckoutModel>,
		summary: Record<string, unknown> = {},
	): CheckoutModel {
		return {
			summary: {
				orderCreated: false,
				idempotencyKey: "checkout:c1",
				readyToPlace: true,
				requiresShipping: false,
				addressRequired: true,
				paymentAccountNeedsAddress: true,
				hasUnpricedLines: false,
				selection: { couponCode: null, shippingMethodId: null, destination: null },
				shipping: { status: "not_required", options: [], noOptions: false },
				totals: {
					subtotal: amount,
					discount: amount,
					shipping: amount,
					tax: amount,
					total: amount,
					appliedCouponCode: null,
					totalExcludesUncalculated: false,
				},
				...summary,
			} as unknown as CheckoutSummaryView,
			errorMessage: null,
			checkedOut: false,
			locked: null,
			ended: false,
			couponValue: "",
			refusedCouponCode: null,
			couponError: null,
			destinationError: null,
			shippingError: null,
			noOptionsCopy: "",
			destination: null,
			destinationName: null,
			destinationRegionName: null,
			regionRefused: false,
			countryRefused: false,
			countryValue: "",
			regionValue: "",
			countries,
			deliveryRegions: regionChoice("", "", "en-US"),
			addressRegions: regionChoice("", "", "en-US"),
			showDelivery: false,
			showAddress: true,
			chosenOption: null,
			notReadyCopy: "",
			paymentConfigured: true,
			notConfiguredLead: "",
			emailValue: "",
			emailNote: "",
			addressValues: {
				name: "Ada",
				line1: "1 Road",
				line2: "",
				city: "Bengaluru",
				postalCode: "560001",
				country: "",
				region: "",
				phone: "",
			},
			fieldErrors: {},
			ledgerRows: [],
			sumRows: [],
			footnote: null,
			...overrides,
		};
	}

	const render = (m: CheckoutModel): Promise<string> =>
		container.renderToString(CheckoutView, { props: { model: m } });

	function addressWith(country: string, region: string): Partial<CheckoutModel> {
		const base = model({}).addressValues;
		return {
			addressValues: { ...base, country, region },
			addressRegions: regionChoice(country, region, "en-US"),
		};
	}

	test("a country WITH subdivisions: a labelled select of its names, the stored code selected", async () => {
		const html = await render(model(addressWith("IN", "KA")));
		const list = regionSelect(html, "region");
		expect(list).not.toBe("");
		expect(html).toMatch(/<label[^>]*for="address-region"[^>]*>\s*State \/ province/);
		expect(list).toMatch(/<option value="">Choose a state \/ province…<\/option>/);
		expect(list).toMatch(/<option value="KA" selected>Karnataka<\/option>/);
		expect(list).toMatch(/<option value="MH">Maharashtra<\/option>/);
		expect(list.match(/ selected/g)).toHaveLength(1);
		expect(html).toMatch(/<input type="hidden" name="regionCountry" value="IN">/);
		// No free-text region anywhere.
		expect(html).not.toMatch(/<input[^>]*name="region"/);
	});

	test("an old stored form of the code (us-ca) still renders as the selected option", async () => {
		const list = regionSelect(await render(model(addressWith("US", "us-ca"))), "region");
		expect(list).toMatch(/<option value="CA" selected>California<\/option>/);
	});

	test("a country WITHOUT subdivisions: no region field at all, the country still echoed", async () => {
		const html = await render(model(addressWith("AQ", "")));
		expect(regionSelect(html, "region")).toBe("");
		expect(html).not.toContain('for="address-region"');
		expect(html).toMatch(/<input type="hidden" name="regionCountry" value="AQ">/);
	});

	test("no country yet: no region field, an Update button beside the country, regionCountry empty", async () => {
		const html = await render(model({}));
		expect(regionSelect(html, "region")).toBe("");
		// Astro prints an empty value as a bare `value`, which posts "" — present, unlike
		// a form without the field (a theme that predates the pick list).
		expect(html).toMatch(/<input type="hidden" name="regionCountry" value(="")?>/);
		expect(html).toMatch(
			/<button type="submit" class="u-btn u-btn-ghost" name="intent" value="update-address" formnovalidate>/,
		);
		expect(html).toMatch(/<select[^>]*aria-describedby="country-note"/);
	});

	test("a refused region is announced: aria-invalid and described by its error", async () => {
		const html = await render(
			model({
				...addressWith("US", ""),
				fieldErrors: { region: "Choose a state/province from the list — or leave it blank." },
			}),
		);
		const open = /<select[^>]*name="region"[^>]*>/.exec(html)?.[0] ?? "";
		expect(open).toContain('aria-invalid="true"');
		expect(open).toContain('aria-describedby="region-error"');
		expect(html).toMatch(/id="region-error"[^>]*>\s*Choose a state\/province from the list/);
	});

	test("the delivery block: the priced country's list, its region selected, the list's country echoed", async () => {
		const html = await render(
			model(
				{
					showDelivery: true,
					countryValue: "US",
					regionValue: "NY",
					deliveryRegions: regionChoice("US", "NY", "en-US"),
					destination: { country: "US", region: "NY" },
					destinationName: "United States",
					destinationRegionName: "New York",
				},
				{ requiresShipping: true, shipping: { status: "matched", options: [], noOptions: false } },
			),
		);
		const list = regionSelect(html, "deliveryRegion");
		expect(list).toContain('form="checkout-place"');
		expect(list).toMatch(/<option value="NY" selected>New York<\/option>/);
		expect(html).toMatch(
			/<input type="hidden" name="deliveryRegionCountry" form="checkout-place" value="US">/,
		);
		// The address block's line names the region, not just its code.
		expect(html).toMatch(/Delivering to United States\s*, New York/);
	});

	test("the delivery block after the PLUGIN refused plain US (a US-CA zone): US kept, its list shown and marked", async () => {
		const html = await render(
			model(
				{
					showDelivery: true,
					countryValue: "US",
					regionValue: "",
					deliveryRegions: regionChoice("US", "", "en-US"),
					destinationError:
						"Choose your state/province from the list, or leave it blank if your country doesn't use one.",
					regionRefused: true,
				},
				{
					requiresShipping: true,
					shipping: { status: "address_needed", options: [], noOptions: false },
				},
			),
		);
		expect(html).toMatch(/<option value="US" selected>United States<\/option>/);
		const open = /<select[^>]*name="deliveryRegion"[^>]*>/.exec(html)?.[0] ?? "";
		expect(open).toContain('aria-invalid="true"');
		expect(open).toContain('aria-describedby="delivery-error region-note"');
		expect(html).toContain('id="delivery-error"');
		expect(regionSelect(html, "deliveryRegion")).toMatch(/<option value="CA">California<\/option>/);
	});

	test("REGION_LIST_UPDATED: the marked state list is described by the page-level notice that IS on the page", async () => {
		const html = await render(
			model(
				{
					showDelivery: true,
					countryValue: "US",
					deliveryRegions: regionChoice("US", "", "en-US"),
					errorMessage: "We've updated the state/province list for the country you chose.",
					regionRefused: true,
				},
				{
					requiresShipping: true,
					shipping: { status: "address_needed", options: [], noOptions: false },
				},
			),
		);
		const open = /<select[^>]*name="deliveryRegion"[^>]*>/.exec(html)?.[0] ?? "";
		expect(open).toContain('aria-invalid="true"');
		expect(open).toContain('aria-describedby="checkout-error region-note"');
		expect(html).toMatch(/id="checkout-error"[^>]*>[\s\S]*updated the state\/province list/);
		expect(html).toMatch(
			/<input type="hidden" name="deliveryRegionSelected" form="checkout-place" value(="")?>/,
		);
	});

	test("a COUNTRY-level refusal (we don't ship there) does not mark the state list invalid", async () => {
		const html = await render(
			model(
				{
					showDelivery: true,
					countryValue: "US",
					deliveryRegions: regionChoice("US", "NY", "en-US"),
					destinationError: "We don't ship to this address.",
					regionRefused: false,
					countryRefused: true,
				},
				{
					requiresShipping: true,
					shipping: { status: "address_needed", options: [], noOptions: false },
				},
			),
		);
		const open = /<select[^>]*name="deliveryRegion"[^>]*>/.exec(html)?.[0] ?? "";
		expect(open).not.toContain('aria-invalid="true"');
		expect(open).toContain('aria-describedby="region-note"');
		// …the COUNTRY is what was refused, so the country select is marked.
		const country = /<select[^>]*name="deliveryCountry"[^>]*>/.exec(html)?.[0] ?? "";
		expect(country).toContain('aria-invalid="true"');
		expect(country).toContain('aria-describedby="delivery-error"');
	});

	test("the delivery block for a country without subdivisions shows no region field", async () => {
		const html = await render(
			model(
				{
					showDelivery: true,
					countryValue: "AQ",
					deliveryRegions: regionChoice("AQ", "", "en-US"),
				},
				{
					requiresShipping: true,
					shipping: { status: "address_needed", options: [], noOptions: false },
				},
			),
		);
		expect(regionSelect(html, "deliveryRegion")).toBe("");
		expect(html).not.toContain('name="deliveryRegionCountry"');
	});
});
