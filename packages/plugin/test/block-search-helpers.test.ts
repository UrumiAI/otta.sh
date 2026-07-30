import { describe, expect, test } from "vitest";
import {
	accessories,
	allBlocks,
	blocksOf,
	buttons,
	columnKeys,
	contextTexts,
	emptyActions,
	field,
	fieldEntries,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	type LooseBlock,
	openGroupIds,
	panel,
	panelLabels,
	tableRows,
	tableWithId,
} from "./helpers/blocks.js";

/**
 * The recursive block-search helpers the admin suites assert through (design
 * spec §15, V-1). These exist because a FLAT `blocks.filter(b => b.type === …)`
 * stops seeing a block the moment it moves inside `tab`/`accordion`/`columns`
 * (R-25) — the suite then passes while asserting nothing. So the helpers' own
 * traversal is pinned here against a tree that nests one block of every kind at
 * every depth em-dash renders: a top-level block, a `columns` column, a `tab`
 * panel, an `accordion`, and an accordion nested inside an accordion (the
 * `tab > accordion > accordion` maximum of D-8).
 */

/** One block of interest at each of the five depths the renderer reaches. */
const TREE: LooseBlock[] = [
	{ type: "header", text: "Orders" },
	{ type: "context", text: "top-level context" },
	{
		type: "columns",
		columns: [
			[{ type: "context", text: "in a column" }],
			[{ type: "table", block_id: "t:column", columns: [{ key: "a", label: "A" }], rows: [] }],
		],
	},
	{
		type: "tab",
		block_id: "orders:tabs",
		default_tab: 0,
		panels: [
			{
				label: "Order",
				blocks: [
					{ type: "context", text: "in panel Order" },
					{
						type: "table",
						block_id: "orders:lines",
						columns: [
							{ key: "sku", label: "SKU" },
							{ key: "title", label: "Title" },
						],
						rows: [{ sku: "SKU-1", title: "Widget" }],
					},
					{
						type: "accordion",
						block_id: "orders:customer",
						label: "Customer — a@b.test",
						default_open: false,
						blocks: [
							{ type: "fields", fields: [{ label: "Email", value: "a@b.test" }] },
							{
								type: "accordion",
								block_id: "orders:addresses",
								label: "Saved addresses (1)",
								blocks: [
									{
										type: "table",
										block_id: "orders:addresses:table",
										columns: [{ key: "line1", label: "Address" }],
										rows: [{ line1: "1 Main St" }],
									},
								],
							},
						],
					},
				],
			},
			{
				label: "Money",
				blocks: [
					{
						type: "accordion",
						block_id: "orders:refunds",
						label: "Refunds — $0.00 of $99.00 refunded",
						default_open: true,
						blocks: [
							{
								type: "form",
								block_id: "orders:refund-partial:u1.abc",
								fields: [
									{ type: "text_input", action_id: "amount", label: "Refund amount (USD)" },
									{ type: "text_input", action_id: "refundedBy", label: "Refunded by" },
								],
								submit: { label: "Review refund", action_id: "orders:refund-review" },
							},
							{
								type: "actions",
								elements: [
									{ type: "button", action_id: "orders:refund", label: "Yes, refund $10.00" },
								],
							},
						],
					},
				],
			},
		],
	},
	{
		type: "section",
		text: "status: paid",
		accessory: { type: "button", action_id: "orders:apply-filter", label: "Clear filters" },
	},
	{
		type: "empty",
		title: "No orders yet",
		actions: [{ type: "button", action_id: "orders:new", label: "New order" }],
	},
];

describe("recursive block-search helpers (spec §15 V-1)", () => {
	test("findBlocks reaches columns, tab panels, accordions and nested accordions — a flat filter does not", () => {
		// The regression this file exists for: the flat search sees ONE context
		// line (the top-level one) while the renderer renders three.
		expect(TREE.filter((b) => b.type === "context")).toHaveLength(1);
		expect(contextTexts(TREE)).toEqual(["top-level context", "in a column", "in panel Order"]);
		// Tables: one in a column, one in a panel, one two accordions deep.
		expect(TREE.filter((b) => b.type === "table")).toHaveLength(0);
		expect(findBlocks(TREE, "table").map((t) => t.block_id)).toEqual([
			"t:column",
			"orders:lines",
			"orders:addresses:table",
		]);
		// Accordions include the NESTED one (the renderer renders it too).
		expect(findBlocks(TREE, "accordion").map((a) => a.block_id)).toEqual([
			"orders:customer",
			"orders:addresses",
			"orders:refunds",
		]);
	});

	test("traversal order is the renderer's: a container before the blocks it contains", () => {
		const types = allBlocks(TREE).map((b) => b.type);
		expect(types.indexOf("columns")).toBeLessThan(types.indexOf("table"));
		expect(types.indexOf("tab")).toBeLessThan(types.lastIndexOf("accordion"));
		// `findBlock` is `find`, i.e. the first in that order.
		expect(findBlock(TREE, "table")?.block_id).toBe("t:column");
	});

	test("panel resolves a tab panel by its (static) label; panelLabels pins the whole set", () => {
		expect(panelLabels(TREE)).toEqual(["Order", "Money"]);
		expect(contextTexts(panel(TREE, "Order"))).toEqual(["in panel Order"]);
		// Scoping to a panel is what keeps a Money assertion from passing on an
		// Order-panel block of the same type.
		expect(findBlocks(panel(TREE, "Money"), "table")).toEqual([]);
		expect(panel(TREE, "No Such Panel")).toEqual([]);
	});

	test("group resolves an accordion by block_id at any depth — never by its dynamic label", () => {
		expect(group(TREE, "orders:addresses")?.label).toBe("Saved addresses (1)");
		expect(group(TREE, "orders:missing")).toBeUndefined();
		expect(tableRows(groupBlocks(TREE, "orders:addresses"))).toEqual([{ line1: "1 Main St" }]);
		// The label carries live money (D-6), which is exactly why a test must not
		// key on it — but it is still readable for a copy assertion.
		expect(group(TREE, "orders:refunds")?.label).toContain("$99.00");
	});

	test("openGroupIds reports every default_open group — X-18 allows at most one per response", () => {
		expect(openGroupIds(TREE)).toEqual(["orders:refunds"]);
	});

	test("formFor keys on the submit action id, not on the carrier block_id", () => {
		const form = formFor(TREE, "orders:refund-review");
		expect(form?.block_id).toBe("orders:refund-partial:u1.abc");
		expect(fieldIds(form)).toEqual(["amount", "refundedBy"]);
		expect(field(form, "amount")?.label).toBe("Refund amount (USD)");
		expect(formFor(TREE, "orders:nope")).toBeUndefined();
	});

	test("element accessors keep the three button channels apart", () => {
		// `actions` elements, an `empty`'s actions and a `section`'s accessory are
		// separate channels; conflating them would hide a control rendered in the
		// wrong place.
		expect(buttons(TREE).map((e) => e.action_id)).toEqual(["orders:refund"]);
		expect(emptyActions(TREE).map((e) => e.action_id)).toEqual(["orders:new"]);
		expect(accessories(TREE).map((e) => e.label)).toEqual(["Clear filters"]);
	});

	test("fields/table accessors read through containers", () => {
		expect(fieldEntries(TREE)).toEqual(["Email=a@b.test"]);
		expect(columnKeys(tableWithId(TREE, "orders:lines"))).toEqual(["sku", "title"]);
		expect(tableRows(TREE)).toHaveLength(2);
	});

	test("blocksOf tolerates an errored invocation rather than throwing", () => {
		expect(blocksOf({ result: { blocks: TREE } })).toBe(TREE);
		expect(blocksOf({ error: "boom" })).toEqual([]);
		expect(blocksOf(undefined)).toEqual([]);
		expect(blocksOf({ result: {} })).toEqual([]);
	});
});
