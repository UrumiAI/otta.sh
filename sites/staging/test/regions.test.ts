/**
 * The state/province pick list (lib/regions.ts): the chosen country's
 * subdivisions, named and sorted for the locale, with a stored or typed region
 * preselected by its CODE — and, for the view, rendered as a `<select>` for a
 * country with subdivisions and not at all for one without. Rendered with the
 * Container API (no client JS: the server output IS the page).
 */
import type { APIContext } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import type { CheckoutSummaryView } from "@otta-sh/plugin";
import { byLabel, countryOptions } from "../src/lib/countries.js";
import { regionChoice, regionOutsideCountry } from "../src/lib/regions.js";
import { GET as REGIONS_GET } from "../src/pages/checkout/regions.js";
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

describe("regionOutsideCountry — the one region rule", () => {
	test("a code that is not one of the country's subdivisions", () => {
		expect(regionOutsideCountry("US", "ON")).toBe(true);
		expect(regionOutsideCountry("US", "MX-CA")).toBe(true);
		expect(regionOutsideCountry("AQ", "CA")).toBe(true);
		expect(regionOutsideCountry("FR", "ZZ")).toBe(true);
	});
	test("is not: one of the country's own (any form), blank, an unknown country, or free text", () => {
		expect(regionOutsideCountry("US", "CA")).toBe(false);
		expect(regionOutsideCountry("us", "us-ca")).toBe(false);
		expect(regionOutsideCountry("US", "")).toBe(false);
		expect(regionOutsideCountry("US", undefined)).toBe(false);
		expect(regionOutsideCountry("ZZ", "CA")).toBe(false);
		expect(regionOutsideCountry(undefined, "CA")).toBe(false);
		expect(regionOutsideCountry("US", "California")).toBe(false);
	});
});

/** The opening tag of the field wrapping the region select `id`. */
const fieldOf = (html: string, id: string): string =>
	new RegExp(`(<div[^>]*data-region-field[^>]*>)\\s*<label[^>]*for="${id}"`).exec(html)?.[1] ?? "";

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
		// The country select names its list for the optional script (ADR-0034),
		// and the list's field is shown.
		expect(html).toMatch(
			/<select[^>]*id="address-country"[^>]*data-region-target="address-region"/,
		);
		expect(fieldOf(html, "address-region")).not.toMatch(/\bhidden\b/);
		// No free-text region anywhere.
		expect(html).not.toMatch(/<input[^>]*name="region"/);
	});

	test("an old stored form of the code (us-ca) still renders as the selected option", async () => {
		const list = regionSelect(await render(model(addressWith("US", "us-ca"))), "region");
		expect(list).toMatch(/<option value="CA" selected>California<\/option>/);
	});

	test("a country WITHOUT subdivisions: the region field is HIDDEN and empty (the script fills it on a change)", async () => {
		const html = await render(model(addressWith("AQ", "")));
		expect(fieldOf(html, "address-region")).toMatch(/\bhidden\b/);
		expect(regionSelect(html, "region").match(/<option /g)).toHaveLength(1);
	});

	test("no country yet: the region field hidden, and a no-JS Update beside the country (the script hides it)", async () => {
		const html = await render(model({}));
		expect(fieldOf(html, "address-region")).toMatch(/\bhidden\b/);
		expect(html).toMatch(
			/<button type="submit" class="u-btn u-btn-ghost" name="intent" value="update-address" formnovalidate data-region-update>/,
		);
		expect(html).toMatch(/id="country-note" data-region-update/);
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
			/<select[^>]*name="deliveryCountry"[^>]*data-region-target="delivery-region"/,
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
		expect(fieldOf(html, "delivery-region")).toMatch(/\bhidden\b/);
		expect(regionSelect(html, "deliveryRegion").match(/<option /g)).toHaveLength(1);
	});
});

describe("GET /checkout/regions — the optional script's one data source (ADR-0034)", () => {
	const get = async (q: string) => {
		const response = await REGIONS_GET({
			url: new URL(`http://x/checkout/regions${q}`),
		} as unknown as APIContext);
		return { response, body: (await response.json()) as Array<{ code: string; label: string }> };
	};

	test("a country's options, named and sorted — exactly the server-rendered list", async () => {
		const { response, body } = await get("?country=us");
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(body).toEqual(regionChoice("US", "", "en-US").options);
		expect(body).toContainEqual({ code: "CA", label: "California" });
	});

	test("no subdivisions, an unknown country, or none at all: []", async () => {
		for (const q of ["?country=AQ", "?country=ZZ", "", "?country=<script>"]) {
			expect((await get(q)).body, q).toEqual([]);
		}
	});
});
