import { ORDER_LABEL_TITLE_MAX_LENGTH, orderLabel } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

// The shopper-facing name of an order. A shopper never sees the order id — a
// UUID names nothing they bought — so every customer surface (the confirmation
// page, the account pages, the order emails) names the order by what is IN it.
// One pure function so the storefront and the emails cannot drift apart.

describe("orderLabel", () => {
	test("one line is just its title", () => {
		expect(orderLabel([{ title: "Otta Tee", quantity: 1 }])).toBe("Otta Tee");
	});

	test("one line bought more than once carries the quantity", () => {
		expect(orderLabel([{ title: "Otta Tee", quantity: 3 }])).toBe("Otta Tee × 3");
	});

	test("several lines name the first and count the rest", () => {
		expect(
			orderLabel([
				{ title: "Otta Tee", quantity: 2 },
				{ title: "Otta Mug", quantity: 1 },
				{ title: "Otta Cap", quantity: 1 },
			]),
		).toBe("Otta Tee and 2 more");
		expect(
			orderLabel([
				{ title: "Otta Tee", quantity: 1 },
				{ title: "Otta Mug", quantity: 1 },
			]),
		).toBe("Otta Tee and 1 more");
	});

	test("the title is trimmed", () => {
		expect(orderLabel([{ title: "  Otta Tee \n", quantity: 1 }])).toBe("Otta Tee");
	});

	test("a blank first title is skipped; the count still covers every other line", () => {
		expect(
			orderLabel([
				{ title: "   ", quantity: 1 },
				{ title: null, quantity: 1 },
				{ title: "Otta Mug", quantity: 1 },
			]),
		).toBe("Otta Mug and 2 more");
	});

	test.each([
		["no lines", []],
		["one blank line", [{ title: "", quantity: 2 }]],
		["one missing title", [{ quantity: 1 }]],
		[
			"every title blank",
			[
				{ title: " ", quantity: 1 },
				{ title: null, quantity: 1 },
			],
		],
	])("%s falls back to 'Your order' — never an id", (_name, lines) => {
		expect(orderLabel(lines)).toBe("Your order");
	});

	test("several lines count LINES, not units — a later line's quantity is not printed", () => {
		expect(
			orderLabel([
				{ title: "Otta Tee", quantity: 1 },
				{ title: "Otta Mug", quantity: 5 },
			]),
		).toBe("Otta Tee and 1 more");
	});

	test("a blank-titled line beside a titled one still counts as one more", () => {
		expect(
			orderLabel([
				{ title: "Otta Tee", quantity: 1 },
				{ title: "", quantity: 1 },
			]),
		).toBe("Otta Tee and 1 more");
	});

	// The label reaches email SUBJECTS and page <title>s. A CR/LF or other control
	// character in a subject makes a provider reject the send — and the outbox
	// would retry an email that can never go out — so the title is normalised
	// to one line before it is used anywhere.
	test.each([
		["Otta\r\nTee", "Otta Tee"],
		["Otta\tTee", "Otta Tee"],
		["Otta\u0000\u0007Tee\u007f", "Otta Tee"],
		["  Otta   \n\n  Tee  ", "Otta Tee"],
	])("control characters and whitespace runs collapse: %j", (title, expected) => {
		expect(orderLabel([{ title, quantity: 1 }])).toBe(expected);
	});

	test("a title made only of control characters is blank", () => {
		expect(orderLabel([{ title: "\r\n\u0000", quantity: 1 }])).toBe("Your order");
	});

	test("a long title is clamped to ORDER_LABEL_TITLE_MAX_LENGTH code points with an ellipsis", () => {
		const label = orderLabel([{ title: "x".repeat(500), quantity: 2 }]);
		expect(label).toBe(`${"x".repeat(ORDER_LABEL_TITLE_MAX_LENGTH - 1)}… × 2`);
		expect(Array.from(label.replace(" × 2", ""))).toHaveLength(ORDER_LABEL_TITLE_MAX_LENGTH);
	});

	test("the clamp counts code points, so an astral character is never split", () => {
		const label = orderLabel([{ title: "😀".repeat(200), quantity: 1 }]);
		expect(label).toBe(`${"😀".repeat(ORDER_LABEL_TITLE_MAX_LENGTH - 1)}…`);
		expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	test("invisible format characters are dropped: zero-width and bidi controls", () => {
		// A right-to-left override would visually reorder a subject line; a title of
		// only zero-width spaces would read as blank but not fall back.
		expect(orderLabel([{ title: "Otta \u202ETe\u200Be\u2066", quantity: 1 }])).toBe("Otta Tee");
		expect(orderLabel([{ title: "\u200B\u200B\uFEFF", quantity: 1 }])).toBe("Your order");
	});

	test("a clamp that lands after a space never leaves a space before the ellipsis", () => {
		const title = `${"x".repeat(ORDER_LABEL_TITLE_MAX_LENGTH - 2)} tail of the title`;
		expect(orderLabel([{ title, quantity: 1 }])).toBe(
			`${"x".repeat(ORDER_LABEL_TITLE_MAX_LENGTH - 2)}…`,
		);
	});

	test("a non-positive or fractional quantity never prints a quantity", () => {
		expect(orderLabel([{ title: "Otta Tee", quantity: 0 }])).toBe("Otta Tee");
		expect(orderLabel([{ title: "Otta Tee", quantity: 1.5 }])).toBe("Otta Tee");
	});
});
