import { describe, expect, test } from "vitest";
import { orderConfirmLabel, refundConfirmText, withOrderNumberCells } from "../src/index.js";

// ADR-0033: the console's tie-breakers for rows that share an order number, and the
// refund confirm's label. The number itself always comes from the server.

const text = (cell: { number: string; extension: string }) => cell.number + cell.extension;

describe("withOrderNumberCells", () => {
	test("an unshared number prints as sent", () => {
		const [row] = withOrderNumberCells([
			{ id: "3f9a2b1c-7d4e-4a5b-9c8d-0123456789ab", orderNumber: "#3F9A2" },
		]);
		expect(row?.cell).toEqual({ number: "#3F9A2", extension: "" });
	});

	test("shared numbers extend, upper-cased, to the shortest prefix unique in their group", () => {
		const cells = withOrderNumberCells([
			{ id: "fee1d111-0000-4000-8000-000000000001", orderNumber: "#FEE1D" },
			{ id: "fee1d222-0000-4000-8000-000000000002", orderNumber: "#FEE1D" },
			{ id: "fee1e333-0000-4000-8000-000000000003", orderNumber: "#FEE1E" },
		]).map((r) => r.cell);
		expect(cells.map(text)).toEqual(["#FEE1D1", "#FEE1D2", "#FEE1E"]);
		expect(cells[0]).toEqual({ number: "#FEE1D", extension: "1" });
	});

	test("ids whose number holds a '-' still get distinct cells", () => {
		const cells = withOrderNumberCells([
			{ id: "ord-10", orderNumber: "#ORD-1" },
			{ id: "ord-11", orderNumber: "#ORD-1" },
		]).map((r) => text(r.cell));
		expect(cells).toEqual(["#ORD-10", "#ORD-11"]);
	});

	test("a tie-breaker that runs past the first hyphen is hex only", () => {
		const cells = withOrderNumberCells([
			{ id: "abcdef12-3000-4000-8000-000000000001", orderNumber: "#ABCDE" },
			{ id: "abcdef12-4000-4000-8000-000000000002", orderNumber: "#ABCDE" },
		]).map((r) => text(r.cell));
		expect(cells).toEqual(["#ABCDEF123", "#ABCDEF124"]);
	});
});

describe("the refund confirm separates what the list separates", () => {
	test("its label extends every cell the list prints for the order", () => {
		const a = "abcdef12-3000-4000-8000-000000000001";
		const b = "abcdef12-4000-4000-8000-000000000002";
		for (const { order, cell } of withOrderNumberCells([
			{ id: a, orderNumber: "#ABCDE" },
			{ id: b, orderNumber: "#ABCDE" },
		])) {
			expect(orderConfirmLabel(order.id).startsWith(text(cell))).toBe(true);
		}
		expect(orderConfirmLabel(a)).not.toBe(orderConfirmLabel(b));
		expect(refundConfirmText(a, "$5.00", "x", true)).toContain("Order #ABCDEF123000 —");
	});
});
