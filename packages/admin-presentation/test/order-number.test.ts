import { describe, expect, test } from "vitest";
import {
	orderConfirmLabel,
	orderNumberSearchText,
	refundConfirmText,
	typedOrderNumberDigits,
	withOrderNumberCells,
} from "../src/index.js";

// ADR-0033: the admin side of the order number — one matcher, the page's
// tie-breakers, and the refund confirm's label.

const text = (cell: { number: string; extension: string }) => cell.number + cell.extension;

describe("typedOrderNumberDigits — the one matcher", () => {
	test("# + at least five hex digits is a number", () => {
		expect(typedOrderNumberDigits("#3F9A2")).toBe("3f9a2");
		expect(typedOrderNumberDigits(" #abcdef123 ")).toBe("abcdef123");
	});

	test("anything else is not", () => {
		for (const s of ["#3F9A", "3F9A2", "#", "#TEE-BLK", "jo@example.com", undefined]) {
			expect(typedOrderNumberDigits(s)).toBeNull();
		}
	});
});

describe("orderNumberSearchText", () => {
	test("takes the # off a number and leaves other searches as typed", () => {
		expect(orderNumberSearchText("#3F9A2")).toBe("3f9a2");
		expect(orderNumberSearchText("#3F9")).toBe("#3F9");
		expect(orderNumberSearchText("jo@example.com")).toBe("jo@example.com");
	});

	test("a number that crosses a UUID hyphen gets it back, so it prefixes the stored id", () => {
		const id = "abcdef12-3000-4000-8000-000000000001";
		expect(orderNumberSearchText("#ABCDEF123")).toBe("abcdef12-3");
		expect(id.startsWith(orderNumberSearchText(`#${id.replaceAll("-", "")}`))).toBe(true);
	});
});

describe("withOrderNumberCells", () => {
	test("an unshared number prints as sent", () => {
		const [row] = withOrderNumberCells([{ id: "3f9a2b1c-0", orderNumber: "#3F9A2" }]);
		expect(row?.cell).toEqual({ number: "#3F9A2", extension: "" });
	});

	test("shared numbers extend, upper-cased and hex only", () => {
		const cells = withOrderNumberCells([
			{ id: "abcdef12-3000-4000-8000-000000000001", orderNumber: "#ABCDE" },
			{ id: "abcdef12-4000-4000-8000-000000000002", orderNumber: "#ABCDE" },
		]).map((r) => r.cell);
		expect(cells.map(text)).toEqual(["#ABCDEF123", "#ABCDEF124"]);
		expect(cells[0]).toEqual({ number: "#ABCDE", extension: "F123" });
	});

	test("ids containing '-' still get distinct cells", () => {
		const cells = withOrderNumberCells([
			{ id: "ord-10", orderNumber: "#ORD-1" },
			{ id: "ord-11", orderNumber: "#ORD-1" },
		]).map((r) => text(r.cell));
		expect(new Set(cells).size).toBe(2);
	});

	test("ids that read the same once '-' is dropped keep their '-' and stay distinct", () => {
		const cells = withOrderNumberCells([{ id: "ab-cde1" }, { id: "abc-de1" }]).map((r) =>
			text(r.cell),
		);
		expect(cells).toEqual(["#AB-CD", "#ABC-D"]);
	});

	test("a row without a number prints # + its upper-cased prefix", () => {
		const [row] = withOrderNumberCells([{ id: "7e4ce728-0000-4000-8000-000000000000" }]);
		expect(text(row?.cell ?? { number: "", extension: "" })).toBe("#7E4CE");
	});
});

describe("the refund confirm separates what the list separates", () => {
	test("its label extends every cell the list can print for the order", () => {
		const a = "abcdef12-3000-4000-8000-000000000001";
		const b = "abcdef12-4000-4000-8000-000000000002";
		const cells = withOrderNumberCells([
			{ id: a, orderNumber: "#ABCDE" },
			{ id: b, orderNumber: "#ABCDE" },
		]);
		for (const { order, cell } of cells) {
			expect(orderConfirmLabel(order.id).startsWith(text(cell))).toBe(true);
		}
		expect(orderConfirmLabel(a)).not.toBe(orderConfirmLabel(b));
		expect(refundConfirmText(a, "$5.00", "x", true)).toContain("Order #ABCDEF123000 —");
	});
});
