/**
 * #305 part 1 — how the buyer's coupon rides the review page.
 *
 * The coupon travels as `GET /checkout?coupon=CODE` (decision D2): the summary
 * it drives is read-only (a quote redeems nothing), so a GET is safe, reload-safe
 * and needs no cookie. These are the pure rules the page and the place endpoint
 * share; `.astro` has no render harness (issue #40), so they live here.
 */
import { describe, expect, test } from "vitest";
import {
	checkoutPath,
	placeFailurePath,
	readCouponParam,
	readDestinationParams,
	readMethodParam,
	shapedDestination,
} from "../src/lib/checkout-selection.js";

const at = (search: string) => new URL(`http://localhost:4321/checkout${search}`);

describe("readCouponParam", () => {
	test("trims the code and KEEPS its case — the plugin folds case, the site echoes what was typed", () => {
		expect(readCouponParam(at("?coupon=%20Ck-Save5%20"))).toEqual({ couponCode: "Ck-Save5" });
	});

	test.each([[""], ["?coupon="], ["?coupon=%20%20"]])(
		"a blank or absent coupon (%p) is no coupon",
		(search) => {
			expect(readCouponParam(at(search))).toEqual({});
		},
	);

	test("a code over 200 characters is rejected HERE as COUPON_NOT_FOUND, never sent to the plugin", () => {
		const code = "X".repeat(201);
		expect(readCouponParam(at(`?coupon=${code}`))).toEqual({
			rejected: { code, reason: "COUPON_NOT_FOUND" },
		});
	});

	test("exactly 200 characters is still a code", () => {
		const code = "X".repeat(200);
		expect(readCouponParam(at(`?coupon=${code}`))).toEqual({ couponCode: code });
	});
});

describe("checkoutPath", () => {
	test("is bare /checkout with nothing to carry", () => {
		expect(checkoutPath({})).toBe("/checkout");
	});

	test("encodes the coupon and the error token", () => {
		expect(checkoutPath({ couponCode: "A&B=C D", error: "INVALID_EMAIL" })).toBe(
			"/checkout?coupon=A%26B%3DC+D&error=INVALID_EMAIL",
		);
	});

	test("carries the coarse destination and the method (ADR-0021 Decision 9)", () => {
		expect(
			checkoutPath({ country: "US", region: "CA", shippingMethodId: "m-1", couponCode: "C" }),
		).toBe("/checkout?coupon=C&country=US&region=CA&method=m-1");
	});

	// ADR-0021 Decision 9: ONLY the coarse country, a region CODE, the opaque
	// method id, the coupon and an error token ever go in a URL — never a name,
	// street, city, postcode, phone or email. Asserted over many inputs that
	// carry exactly those fields (a call site that spread a whole form in).
	test("never emits any key but coupon, country, region, method and error — whatever it is handed", () => {
		const pii = {
			name: "Ada Lovelace",
			email: "ada@example.com",
			line1: "12 Analytical Way",
			line2: "Unit 4",
			city: "London",
			postalCode: "EC1A 1BB",
			phone: "+44 20 7946 0000",
		};
		const allowed = new Set(["coupon", "country", "region", "method", "error"]);
		const values = [undefined, "", "X", "US", "a b&c=d"];
		for (const couponCode of values)
			for (const country of values)
				for (const region of values)
					for (const shippingMethodId of values) {
						const path = checkoutPath({
							...pii,
							couponCode,
							country,
							region,
							shippingMethodId,
							error: "E",
						} as Parameters<typeof checkoutPath>[0]);
						const url = new URL(path, "http://x");
						for (const key of url.searchParams.keys()) expect(allowed.has(key), key).toBe(true);
						for (const value of Object.values(pii))
							expect(path).not.toContain(encodeURIComponent(value));
					}
	});
});

describe("readDestinationParams — the delivery form's GET", () => {
	test("us + ca → US / CA, uppercased", () => {
		expect(readDestinationParams(at("?country=us&region=ca"))).toEqual({
			destination: { country: "US", region: "CA" },
			methodDropped: false,
		});
	});

	test("a blank region is omitted; a country alone is a destination", () => {
		expect(readDestinationParams(at("?country=DE&region=%20"))).toEqual({
			destination: { country: "DE" },
			methodDropped: false,
		});
	});

	test("a region that is not a code is refused HERE with the local token — never dispatched, the typing kept", () => {
		expect(readDestinationParams(at("?country=US&region=California"))).toEqual({
			rejected: { reason: "SHIPPING_REGION_CODE_REQUIRED", country: "US", region: "California" },
			methodDropped: false,
		});
	});

	test.each([["?country=USA"], ["?country=1"], [""], ["?country="]])(
		"%s is no destination (the select cannot produce it; a hand-typed URL is ignored)",
		(search) => {
			expect(readDestinationParams(at(search))).toEqual({ methodDropped: false });
		},
	);

	test.each([
		["?country=DE&fromCountry=US", true],
		["?country=US&region=TX&fromCountry=US&fromRegion=CA", true],
		["?country=US&region=CA&fromCountry=US&fromRegion=", true],
		["?country=US&region=ca&fromCountry=US&fromRegion=CA", false],
		["?country=US&region=US-CA&fromCountry=us&fromRegion=CA", false],
		["?country=US&region=CA&fromCountry=US&fromRegion=us-ca", false],
		["?country=US&region=CA", false],
	])("%s → methodDropped %s (compared NORMALISED)", (search, dropped) => {
		expect(readDestinationParams(at(search)).methodDropped).toBe(dropped);
	});
});

describe("readMethodParam", () => {
	test("an id-shaped method is read, trimmed", () => {
		expect(readMethodParam(at("?method=%20m-1%20"))).toBe("m-1");
	});

	test.each([["?method="], ["?method=a%20b"], [""], [`?method=${"m".repeat(201)}`]])(
		"%s is no method",
		(search) => {
			expect(readMethodParam(at(search))).toBeUndefined();
		},
	);
});

describe("placeFailurePath", () => {
	const SELECTION = {
		couponCode: "CK-SAVE5",
		country: "US",
		region: "CA",
		shippingMethodId: "m-1",
	};

	test.each([
		["COUPON_NOT_FOUND"],
		["COUPON_NOT_ACTIVE"],
		["COUPON_MIN_SUBTOTAL"],
		["COUPON_EXHAUSTED"],
		["COUPON_MAX_PER_CUSTOMER"],
		["COUPON_CURRENCY_MISMATCH"],
	])(
		"a %s place failure DROPS the coupon — the page re-renders without the discount, with one notice",
		(token) => {
			expect(placeFailurePath(token, { couponCode: "CK-SAVE5" })).toBe(`/checkout?error=${token}`);
			expect(placeFailurePath(token, SELECTION)).toBe(
				`/checkout?country=US&region=CA&method=m-1&error=${token}`,
			);
		},
	);

	test.each([
		["INVALID_SHIPPING_ADDRESS"],
		["SHIPPING_ZONE_NOT_MATCHED"],
		["SHIPPING_REGION_CODE_REQUIRED"],
	])(
		"a %s failure drops the DESTINATION and the method (a method means nothing outside its zone)",
		(token) => {
			expect(placeFailurePath(token, SELECTION)).toBe(`/checkout?coupon=CK-SAVE5&error=${token}`);
		},
	);

	test.each([
		["SHIPPING_METHOD_NOT_FOUND"],
		["SHIPPING_RATE_NOT_FOUND"],
		["SHIPPING_METHOD_NOT_IN_ZONE"],
		["SHIPPING_METHOD_REQUIRED"],
		["SHIPPING_METHOD_NOT_APPLICABLE"],
		["MISSING_SHIPPING_ADDRESS"],
	])("a %s failure drops only the METHOD", (token) => {
		expect(placeFailurePath(token, SELECTION)).toBe(
			`/checkout?coupon=CK-SAVE5&country=US&region=CA&error=${token}`,
		);
	});

	test.each([
		["PAYMENT_INTENT_FAILED"],
		["INVALID_EMAIL"],
		["RESERVATION_LOST"],
		["SERVICE_UNAVAILABLE"],
		["STRIPE_NOT_CONFIGURED"],
	])("a %s failure KEEPS the whole selection (none of it is personal data)", (token) => {
		expect(placeFailurePath(token, SELECTION)).toBe(
			`/checkout?coupon=CK-SAVE5&country=US&region=CA&method=m-1&error=${token}`,
		);
	});

	test("no selection, nothing to keep", () => {
		expect(placeFailurePath("INVALID_EMAIL", {})).toBe("/checkout?error=INVALID_EMAIL");
	});
});

describe("shapedDestination — a form's destination, shape-checked before it can enter a URL", () => {
	test.each([
		[["us", "ca"], { country: "US", region: "CA" }],
		[["US", "us-ca"], { country: "US", region: "US-CA" }],
		[["DE", ""], { country: "DE" }],
		[["US", "1 Private Road"], { country: "US" }],
		[["Ada Lovelace", "CA"], {}],
		[[undefined, undefined], {}],
	] as const)("%j → %j", ([country, region], expected) => {
		expect(shapedDestination(country, region)).toEqual(expected);
	});
});
