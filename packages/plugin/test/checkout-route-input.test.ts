/**
 * A3 (storefront-checkout plan §3) — boundary validation for the PUBLIC
 * checkout routes' input. These routes are reachable by anything that can POST
 * to `/_emdash/api/plugins/otta/...`, so the shape is hand-validated here
 * (route-input.ts style, no schema library in the plugin) and a malformed
 * request is rejected BEFORE any `ctx.http` egress — a garbage body must never
 * become an upstream round trip, let alone an order.
 */
import { describe, expect, test } from "vitest";
import { ORDER_ADDRESS_MAX_LENGTHS } from "@otta-sh/domain";
import {
	exceedsAddressBounds,
	parseCheckoutPlaceInput,
	parseCheckoutSummaryInput,
	parseOrderRouteInput,
} from "../src/storefront/checkout-route-input.js";

const ADDRESS = {
	name: "A Buyer",
	line1: "1 Test St",
	city: "Testville",
	postalCode: "12345",
	country: "GB",
};

describe("parseCheckoutSummaryInput", () => {
	test("accepts a non-empty cartId and canonicalizes the locale", () => {
		expect(parseCheckoutSummaryInput({ cartId: "cart-1", locale: "en-GB" })).toEqual({
			cartId: "cart-1",
			locale: "en-GB",
			selection: {},
		});
	});

	test("a garbage locale degrades to the default rather than failing the render", () => {
		expect(parseCheckoutSummaryInput({ cartId: "cart-1", locale: "!!!" })?.locale).toBe("en");
		expect(parseCheckoutSummaryInput({ cartId: "cart-1" })?.locale).toBe("en");
	});

	test.each([[undefined], [""], [null], [42], [{}], [["cart-1"]]])(
		"rejects a cartId of %p",
		(cartId) => {
			expect(parseCheckoutSummaryInput({ cartId })).toBeNull();
		},
	);
});

describe("parseCheckoutPlaceInput", () => {
	// The signed-in shopper's session rides along so the order can be theirs from
	// birth. It is a bearer the client resolves, never trusted here — and a bad one
	// must never cost the buyer their order, so it is DROPPED, not refused.
	test("carries a session token through; drops a blank, non-string or oversized one without refusing the order", () => {
		const base = { cartId: "cart-1", buyerRef: "b@example.com", idempotencyKey: "checkout:cart-1" };
		expect(parseCheckoutPlaceInput({ ...base, sessionToken: "sess-1" })?.sessionToken).toBe(
			"sess-1",
		);
		for (const sessionToken of [undefined, "", 42, null, {}, "x".repeat(513)]) {
			const parsed = parseCheckoutPlaceInput({ ...base, sessionToken });
			expect(parsed, `sessionToken ${String(sessionToken).slice(0, 20)}`).not.toBeNull();
			expect(parsed !== null && "sessionToken" in parsed).toBe(false);
		}
	});

	test("accepts the minimum viable checkout — cartId, buyerRef, idempotencyKey", () => {
		expect(
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: "Buyer@Example.com",
				idempotencyKey: "checkout:cart-1",
			}),
		).toEqual({
			cartId: "cart-1",
			buyerRef: "Buyer@Example.com",
			idempotencyKey: "checkout:cart-1",
			locale: "en",
			selection: {},
		});
	});

	test("the locale is display-only — canonicalized when given, defaulted when not", () => {
		// It formats the order total this route hands back (the pay button's
		// amount) and reaches no upstream call.
		const base = { cartId: "cart-1", buyerRef: "a@b.co", idempotencyKey: "k" };
		expect(parseCheckoutPlaceInput({ ...base, locale: "en-GB" })?.locale).toBe("en-GB");
		expect(parseCheckoutPlaceInput(base)?.locale).toBe("en");
	});

	test("a garbage locale degrades rather than failing the ORDER", () => {
		// The asymmetry that matters: a bad cartId is a reject, a bad locale is a
		// fallback. Nobody loses a purchase over a malformed language tag.
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
			locale: "!!!",
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.locale).toBe("en");
	});

	test("passes buyerRef through VERBATIM — never lowercased, never rewritten", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "A.B+tag@Example.co.UK",
			idempotencyKey: "k",
		});
		expect(parsed?.buyerRef).toBe("A.B+tag@Example.co.UK");
	});

	test.each([[undefined], [""], ["   "], [null], [42]])("rejects a buyerRef of %p", (buyerRef) => {
		expect(parseCheckoutPlaceInput({ cartId: "cart-1", buyerRef, idempotencyKey: "k" })).toBeNull();
	});

	test("rejects a buyerRef past the service's own 320-character bound", () => {
		expect(
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: `${"a".repeat(315)}@b.com`, // 321 chars
				idempotencyKey: "k",
			}),
		).toBeNull();
	});

	test.each([[undefined], [""], [null], [42]])("rejects a cartId of %p", (cartId) => {
		expect(parseCheckoutPlaceInput({ cartId, buyerRef: "a@b.co", idempotencyKey: "k" })).toBeNull();
	});

	test.each([[undefined], [""], [null], [42]])(
		"rejects an idempotencyKey of %p — the route never invents one",
		(idempotencyKey) => {
			expect(
				parseCheckoutPlaceInput({ cartId: "cart-1", buyerRef: "a@b.co", idempotencyKey }),
			).toBeNull();
		},
	);

	test("an ABSENT shippingAddress is fine (capture is optional this slice, ADR-0009)", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
		});
		expect(parsed).not.toBeNull();
		expect(parsed).not.toHaveProperty("shippingAddress");
	});

	test("a complete shippingAddress is kept, trimmed, with optionals omitted when blank", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
			shippingAddress: { ...ADDRESS, name: "  A Buyer  ", line2: "", region: " LND " },
		});
		expect(parsed?.shippingAddress).toEqual({ ...ADDRESS, region: "LND" });
	});

	// ADR-0021: codes everywhere — but the ROUTE checks only their SHAPE. Whether a
	// code-shaped value is a REAL country/subdivision is the domain's call, and it
	// answers with a typed reason the buyer can act on, never INVALID_INPUT.
	test.each([["Testland"], ["United States"], ["U"], ["USA"], ["U1"]])(
		"rejects a shippingAddress whose country %j is not two letters",
		(country) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress: { ...ADDRESS, country },
				}),
			).toBeNull();
		},
	);

	test.each([["California"], ["US_CA"], ["Greater London"], ["ABCD"]])(
		"rejects a shippingAddress whose region %j is not code-shaped",
		(region) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress: { ...ADDRESS, region },
				}),
			).toBeNull();
		},
	);

	test("a code-SHAPED fake (country ZZ, region XX) passes: the domain refuses it with a typed reason", () => {
		const parsed = parseCheckoutPlaceInput({
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
			shippingAddress: { ...ADDRESS, country: "zz", region: "xx" },
		});
		expect(parsed?.shippingAddress).toMatchObject({ country: "zz", region: "xx" });
	});

	test("a destination key on the place body is read for nothing — the address is the destination", () => {
		const body: Record<string, unknown> = {
			cartId: "cart-1",
			buyerRef: "a@b.co",
			idempotencyKey: "k",
			destination: { country: "DE" },
		};
		const parsed = parseCheckoutPlaceInput(body);
		expect(parsed?.selection).toEqual({});
	});

	test.each([["name"], ["line1"], ["city"], ["postalCode"], ["country"]])(
		"rejects a shippingAddress whose required field %s is blank",
		(field) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress: { ...ADDRESS, [field]: "   " },
				}),
			).toBeNull();
		},
	);

	test.each([[42], [null], [{}], [["x"]], [true]])(
		"rejects a NON-STRING shippingAddress field (%p)",
		(bogus) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress: { ...ADDRESS, city: bogus },
				}),
			).toBeNull();
		},
	);

	// The parser's bounds ARE the domain's (no literal copies to drift): a field
	// exactly at ORDER_ADDRESS_MAX_LENGTHS passes the length check, one over is
	// flagged by exceedsAddressBounds — which the place route answers as
	// INVALID_SHIPPING_ADDRESS rather than INVALID_INPUT (QA U-6).
	test.each(["name", "line1", "line2", "city", "postalCode", "phone", "email"] as const)(
		"exceedsAddressBounds flags %s one over the domain's bound, and only then",
		(field) => {
			const max = ORDER_ADDRESS_MAX_LENGTHS[field];
			expect(exceedsAddressBounds({ ...ADDRESS, [field]: "x".repeat(max) })).toBe(false);
			expect(exceedsAddressBounds({ ...ADDRESS, [field]: "x".repeat(max + 1) })).toBe(true);
			// Measured after trimming, as the domain measures it.
			expect(exceedsAddressBounds({ ...ADDRESS, [field]: ` ${"x".repeat(max)} ` })).toBe(false);
		},
	);

	test.each([null, "a string", 42, [], { city: 7 }])(
		"exceedsAddressBounds is false for anything that is not an over-long address (%p)",
		(value) => {
			expect(exceedsAddressBounds(value)).toBe(false);
		},
	);

	test.each([
		["name", 201],
		["line1", 201],
		["city", 121],
		["postalCode", 33],
		["country", 101],
	])("rejects a shippingAddress whose %s exceeds its bound", (field, length) => {
		expect(
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: "a@b.co",
				idempotencyKey: "k",
				shippingAddress: { ...ADDRESS, [field]: "x".repeat(length) },
			}),
		).toBeNull();
	});

	test.each([[42], ["not an object"], [["x"]], [null]])(
		"rejects a shippingAddress that is not an object (%p)",
		(shippingAddress) => {
			expect(
				parseCheckoutPlaceInput({
					cartId: "cart-1",
					buyerRef: "a@b.co",
					idempotencyKey: "k",
					shippingAddress,
				}),
			).toBeNull();
		},
	);
});

/**
 * #305 part 1 — the buyer's SELECTION (coupon, shipping method), carried by both
 * the summary and the place route so the two cannot price a cart differently.
 *
 * The zone is deliberately NOT part of it: the plugin must never accept a
 * client-chosen tax zone (PR 2 derives it from the address).
 */
describe.each([
	[
		"parseCheckoutSummaryInput",
		(extra: Record<string, unknown>) => parseCheckoutSummaryInput({ cartId: "cart-1", ...extra }),
	],
	[
		"parseCheckoutPlaceInput",
		(extra: Record<string, unknown>) =>
			parseCheckoutPlaceInput({
				cartId: "cart-1",
				buyerRef: "a@b.co",
				idempotencyKey: "k",
				...extra,
			}),
	],
] as const)("%s — the checkout selection", (_name, parse) => {
	test("carries couponCode trimmed and case-preserved (coupon lookup is case-sensitive)", () => {
		expect(parse({ couponCode: "  Ck-Save5 " })?.selection).toEqual({ couponCode: "Ck-Save5" });
	});

	test.each([[undefined], [null], [""], ["   "]])(
		'a blank couponCode (%p) is "no coupon", not a rejection',
		(couponCode) => {
			const parsed = parse({ couponCode });
			expect(parsed).not.toBeNull();
			expect(parsed?.selection).toEqual({});
		},
	);

	test.each([[42], [{}], [[]], [true], ["X".repeat(201)]])(
		"rejects a couponCode of %p",
		(couponCode) => {
			expect(parse({ couponCode })).toBeNull();
		},
	);

	test("a couponCode of exactly 200 characters is accepted", () => {
		expect(parse({ couponCode: "X".repeat(200) })?.selection.couponCode).toHaveLength(200);
	});

	test("shippingMethodId is accepted when printable ASCII of at most 200 characters; blank is absent", () => {
		expect(parse({ shippingMethodId: " ck-method-1 " })?.selection).toEqual({
			shippingMethodId: "ck-method-1",
		});
		expect(parse({ shippingMethodId: "m".repeat(200) })?.selection.shippingMethodId).toHaveLength(
			200,
		);
		expect(parse({ shippingMethodId: "  " })?.selection).toEqual({});
		expect(parse({ shippingMethodId: null })?.selection).toEqual({});
	});

	test.each([["a b"], ["é"], ["m".repeat(201)], [42], [{}]])(
		"rejects a shippingMethodId of %p",
		(shippingMethodId) => {
			expect(parse({ shippingMethodId })).toBeNull();
		},
	);

	test("a supplied shippingZoneId never appears in the parsed input", () => {
		const parsed = parse({ shippingZoneId: "zone-1", couponCode: "C", shippingMethodId: "m" });
		expect(parsed).not.toBeNull();
		expect(JSON.stringify(parsed)).not.toContain("zone-1");
		expect(parsed?.selection).toEqual({ couponCode: "C", shippingMethodId: "m" });
	});
});

/** ADR-0021: the summary's `destination` — the coarse ship-to that prices the
 *  review (country + region code), never the street address. */
const parseDestination = (destination: unknown) =>
	parseCheckoutSummaryInput({ cartId: "cart-1", destination });

describe("parseCheckoutSummaryInput — the destination", () => {
	const parse = parseDestination;

	test("country and region are uppercased and trimmed", () => {
		expect(parse({ country: " us ", region: "us-ca" })?.selection).toEqual({
			destination: { country: "US", region: "US-CA" },
		});
	});

	test("a blank region is omitted; an absent or null destination is no destination", () => {
		expect(parse({ country: "DE", region: "  " })?.selection).toEqual({
			destination: { country: "DE" },
		});
		expect(parse(undefined)?.selection).toEqual({});
		expect(parse(null)?.selection).toEqual({});
	});

	test("a code-shaped fake passes (XX) — the domain answers it SHIPPING_REGION_CODE_REQUIRED", () => {
		expect(parse({ country: "US", region: "XX" })?.selection).toEqual({
			destination: { country: "US", region: "XX" },
		});
	});

	test.each([
		[{ country: "United States" }],
		[{ country: "" }],
		[{ region: "CA" }],
		[{ country: "US", region: "California" }],
		[{ country: "DE", region: "Bavaria" }],
		[{ country: "US", region: "US_CA" }],
		[{ country: 42 }],
		[{ country: "US", region: 7 }],
		["US"],
		[["US"]],
	])("rejects %j as INVALID_INPUT", (destination) => {
		expect(parse(destination)).toBeNull();
	});
});

describe("parseOrderRouteInput", () => {
	test("accepts a non-empty orderId and canonicalizes the locale", () => {
		expect(parseOrderRouteInput({ orderId: "order-1", locale: "en-GB" })).toEqual({
			orderId: "order-1",
			locale: "en-GB",
		});
	});

	test.each([[undefined], [""], [null], [42]])("rejects an orderId of %p", (orderId) => {
		expect(parseOrderRouteInput({ orderId })).toBeNull();
	});
});
