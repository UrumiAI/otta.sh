import { describe, expect, test } from "vitest";
import { cents, currency } from "../../src/index.js";
import {
	buildOrderTaxSnapshot,
	readOrderTaxSnapshot,
} from "../../src/orders/order-tax-snapshot.js";

/**
 * Orders written before PR 1 hold an untyped `taxBreakdown` — `null` (the
 * Phase-4 stub) or `{lines:[{taxClassId,discountedCents,taxCents}],
 * shippingTaxCents}`. They are never rewritten; this reader maps them to v0.
 */
const v1 = {
	v: 1,
	calculatorId: "otta.rate-table",
	pricesIncludeTax: false,
	lines: [
		{
			lineIndex: 0,
			taxClassId: "gst18",
			taxableCents: 49_900,
			rateBps: 1800,
			label: "GST 18%",
			taxCents: 8982,
		},
	],
	shipping: { taxableCents: 4900, rateBps: 1800, label: "GST 18%", taxCents: 882 },
};

describe("readOrderTaxSnapshot", () => {
	test("v1 round-trips as written (through JSON, as a stored document does)", () => {
		expect(readOrderTaxSnapshot(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
		expect(readOrderTaxSnapshot({ ...v1, shipping: null })).toEqual({ ...v1, shipping: null });
	});

	test("`located` (ADR-0032) round-trips; a v1 snapshot written before it reads without it", () => {
		const located = { ...v1, located: true };
		expect(readOrderTaxSnapshot(JSON.parse(JSON.stringify(located)))).toEqual(located);
		expect(readOrderTaxSnapshot({ ...v1, located: false })).toEqual({ ...v1, located: false });
		const old = readOrderTaxSnapshot(v1);
		expect(old).toEqual(v1);
		expect(old !== null && old.v === 1 && "located" in old).toBe(false);
		expect(readOrderTaxSnapshot({ ...v1, located: "yes" })).toBeNull();
	});

	test("a line's `taxStatus` (#427) round-trips; a v1 line written before it reads WITHOUT one, never as taxable", () => {
		for (const taxStatus of ["taxable", "shipping_only", "none"] as const) {
			const withStatus = { ...v1, lines: [{ ...v1.lines[0], taxStatus }] };
			expect(readOrderTaxSnapshot(JSON.parse(JSON.stringify(withStatus)))).toEqual(withStatus);
		}
		const old = readOrderTaxSnapshot(v1);
		if (old?.v !== 1) throw new Error("expected v1");
		// Unknown on an older order: the key is absent, not defaulted to "taxable".
		expect("taxStatus" in (old.lines[0] ?? {})).toBe(false);
	});

	test("an unknown or invalid `taxStatus` drops only that key: the line reads as unknown, the snapshot intact", () => {
		// Display-only: the storefront, account pages and emails read this same
		// snapshot for its tax layout, so a status this code does not know (a
		// future fourth one, read after a rollback) must never null the whole thing.
		const known = { ...v1.lines[0], lineIndex: 1, taxStatus: "none" };
		for (const bad of ["exempt", null, 1, ""]) {
			const raw = { ...v1, lines: [{ ...v1.lines[0], taxStatus: bad }, known] };
			expect(readOrderTaxSnapshot(JSON.parse(JSON.stringify(raw)))).toEqual({
				...v1,
				lines: [v1.lines[0], known],
			});
		}
	});

	test("buildOrderTaxSnapshot records each line's tax status, in line order", () => {
		const breakdown = {
			currency: currency("USD"),
			subtotalCents: cents(3000),
			discountCents: cents(0),
			shippingCents: cents(0),
			taxCents: cents(100),
			totalCents: cents(3100),
			lineBreakdown: [
				{ taxClassId: "standard", discountedCents: cents(1000), taxCents: cents(100) },
				{ taxClassId: "standard", discountedCents: cents(1000), taxCents: cents(0) },
				{ taxClassId: "standard", discountedCents: cents(1000), taxCents: cents(0) },
			],
			shippingTaxCents: cents(0),
		};
		const result = {
			ok: true as const,
			currency: currency("USD"),
			lines: ["0", "1", "2"].map((lineId, i) => ({
				lineId,
				rateBps: i === 0 ? 1000 : 0,
				label: "Tax",
				taxCents: cents(i === 0 ? 100 : 0),
			})),
			shipping: null,
		};
		const snapshot = buildOrderTaxSnapshot(
			breakdown,
			{ calculatorId: "otta.rate-table", result },
			false,
			["taxable", "shipping_only", "none"],
		);
		expect(snapshot.lines.map((l) => l.taxStatus)).toEqual(["taxable", "shipping_only", "none"]);
		// What is written reads back unchanged.
		expect(readOrderTaxSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
		expect(() =>
			buildOrderTaxSnapshot(breakdown, { calculatorId: "x", result }, false, ["taxable"]),
		).toThrow(RangeError);
	});

	test("the legacy shape (the golden INR order on main) reads as v0, rate and label null", () => {
		const legacy = {
			lines: [
				{ taxClassId: "gst18", discountedCents: 49_900, taxCents: 8982 },
				{ taxClassId: "standard", discountedCents: 39_800, taxCents: 1990 },
			],
			shippingTaxCents: 882,
		};
		expect(readOrderTaxSnapshot(legacy)).toEqual({
			v: 0,
			calculatorId: "legacy",
			lines: [
				{
					lineIndex: 0,
					taxClassId: "gst18",
					taxableCents: 49_900,
					taxCents: 8982,
					rateBps: null,
					label: null,
				},
				{
					lineIndex: 1,
					taxClassId: "standard",
					taxableCents: 39_800,
					taxCents: 1990,
					rateBps: null,
					label: null,
				},
			],
			shippingTaxCents: 882,
		});
	});

	test.each<[string, unknown]>([
		["null", null],
		["undefined", undefined],
		["a string", "tax"],
		["an array", []],
		["an empty object", {}],
		["v: 2", { ...v1, v: 2 }],
		["v1 with a float tax", { ...v1, lines: [{ ...v1.lines[0], taxCents: 1.5 }] }],
		["v1 with no calculatorId", { ...v1, calculatorId: undefined }],
		["v1 with a non-array lines", { ...v1, lines: "x" }],
		["v1 with a bad shipping", { ...v1, shipping: { taxCents: "882" } }],
		[
			"legacy with a string tax",
			{ lines: [{ taxClassId: "s", discountedCents: 1, taxCents: "1" }], shippingTaxCents: 0 },
		],
		["legacy without shippingTaxCents", { lines: [] }],
	])("%s ⇒ null", (_name, raw) => {
		expect(readOrderTaxSnapshot(raw)).toBeNull();
	});
});
