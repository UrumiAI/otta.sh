import { describe, expect, test } from "vitest";
import { encodeCarrier, PREFILL_FIELD } from "../../src/admin/scaffold/carrier.js";
import { assertBlockContract, type BlockContractOptions } from "./block-contract.js";
import type { LooseBlock } from "./blocks.js";

/**
 * Negative-test suite for `assertBlockContract` itself (spec §15 V-3/V-3a).
 *
 * Every rule below gets a COMPLIANT fixture (must not throw) and a fixture
 * that breaks exactly that rule (must throw, and the thrown message must
 * name that rule's id). Mutation-verification — deliberately breaking each
 * `checkX*` function and confirming exactly its own test fails — was run by
 * hand while building this file; see the PR description for the record.
 */

const LIST: BlockContractOptions = { screen: "orders", level: "list" };
const DETAIL: BlockContractOptions = { screen: "orders", level: "detail" };

function throwsRule(blocks: LooseBlock[], options: BlockContractOptions, ruleId: string): void {
	expect(() => assertBlockContract(blocks, options)).toThrow(new RegExp(`\\b${ruleId}\\b`));
}

function passes(blocks: LooseBlock[], options: BlockContractOptions): void {
	expect(() => assertBlockContract(blocks, options)).not.toThrow();
}

const HEADER: LooseBlock = { type: "header", text: "Orders" };

/** A `block_id` shaped like `carriedForm`'s output — a real ":u1." carrier
 *  whose payload includes the reserved `__v` prefill-digest key. The exact
 *  digest value doesn't matter to the checker (it only asserts the key is
 *  present), so a fixed placeholder is fine here. */
function carriedFormId(namespace: string): string {
	return encodeCarrier(namespace, { [PREFILL_FIELD]: "digest" });
}

/** Wrap `panelOneExtra` inside a fully D-2-compliant Orders detail tab
 *  (Order · Fulfilment · Money · History, default_tab 0), for rules that
 *  only care about level:"detail" content and would otherwise also trip
 *  X-16 on a bare response with no tab at all. */
function ordersDetail(panelOneExtra: LooseBlock[]): LooseBlock[] {
	return [
		HEADER,
		{
			type: "tab",
			block_id: "orders:ord-1:tabs",
			default_tab: 0,
			panels: [
				{ label: "Order", blocks: panelOneExtra },
				{ label: "Fulfilment", blocks: [] },
				{ label: "Money", blocks: [] },
				{ label: "History", blocks: [] },
			],
		},
	];
}

/** Same as {@link ordersDetail}, for the Products screen (Product · Stock). */
function productsDetail(panelOneExtra: LooseBlock[]): LooseBlock[] {
	return [
		HEADER,
		{
			type: "tab",
			block_id: "products:p-1:tabs",
			default_tab: 0,
			panels: [
				{ label: "Product", blocks: panelOneExtra },
				{ label: "Stock", blocks: [] },
			],
		},
	];
}

function x4Table(badgeValues: string[]): LooseBlock {
	return {
		type: "table",
		block_id: "orders:list",
		page_action_id: "orders:page",
		columns: [
			{ key: "id", label: "Order", format: "code" },
			{ key: "state", label: "Status", format: "badge" },
		],
		rows: badgeValues.map((state, i) => ({ id: `ord-${i}`, state })),
	};
}

function x14Table(sortable: boolean): LooseBlock {
	return {
		type: "table",
		block_id: "orders:list",
		page_action_id: "orders:page",
		columns: [{ key: "createdAt", label: "Placed", sortable }],
		rows: [],
	};
}

function x16Tab(labels: string[], defaultTab?: number): LooseBlock {
	return {
		type: "tab",
		block_id: "orders:ord-1:tabs",
		default_tab: defaultTab,
		panels: labels.map((label) => ({ label, blocks: [] })),
	};
}

function x17CarriedForm(fields: unknown[]): LooseBlock {
	const material = (fields as Array<Record<string, unknown>>).map((f) => [
		f.type,
		f.action_id,
		"initial_value" in f ? String(f.initial_value ?? "") : "",
	]);
	const digest = JSON.stringify(material).length.toString(36);
	return {
		type: "form",
		block_id: encodeCarrier("orders:filter", { [PREFILL_FIELD]: digest }),
		fields,
		submit: { label: "Apply filters", action_id: "orders:apply-filter" },
	};
}

function x31Banner(i: number): LooseBlock {
	return { type: "banner", variant: "default", description: `n${i}` };
}

function x35DestructiveAccordion(label: string): LooseBlock {
	return {
		type: "accordion",
		block_id: "orders:cancel",
		label,
		blocks: [
			{
				type: "actions",
				elements: [
					{
						type: "button",
						action_id: "orders:cancel",
						label: "Cancel order",
						style: "danger",
						confirm: {
							title: "Cancel?",
							text: "This cannot be undone.",
							confirm: "Yes, cancel",
							deny: "Keep as is",
							style: "danger",
						},
					},
				],
			},
		],
	};
}

function x37DangerButton(id: string): Record<string, unknown> {
	return {
		type: "button",
		action_id: id,
		label: id,
		style: "danger",
		confirm: {
			title: "Sure?",
			text: "Cannot be undone.",
			confirm: "Yes",
			deny: "No",
			style: "danger",
		},
	};
}

describe("assertBlockContract — X-1 (F-2, F-4)", () => {
	test("compliant: a sentence-case label with no internal name", () => {
		passes(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [{ type: "text_input", action_id: "search", label: "Search" }],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
		);
	});

	test("violates: an internal identifier leaks into a label", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [{ type: "text_input", action_id: "orderId", label: "orderId" }],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-1",
		);
	});

	test("violates: a camelCase label", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [{ type: "text_input", action_id: "search", label: "expectedRateBps" }],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-1",
		);
	});
});

describe("assertBlockContract — X-2 (F-3)", () => {
	const build = (optionCount: number): LooseBlock[] => [
		HEADER,
		{
			type: "form",
			block_id: carriedFormId("orders:filter"),
			fields: [
				{
					type: "select",
					action_id: "status",
					label: "Status",
					initial_value: "any",
					options: Array.from({ length: optionCount }, (_, i) => ({
						value: i === 0 ? "any" : `v${i}`,
						label: i === 0 ? "Any" : `V${i}`,
					})),
				},
			],
			submit: { label: "Apply filters", action_id: "orders:apply-filter" },
		},
	];

	test("compliant: a select with two options", () => passes(build(2), LIST));
	test("violates: a select with exactly one option", () => throwsRule(build(1), LIST, "X-2"));
});

describe("assertBlockContract — X-4 (T-5)", () => {
	test("compliant: a badge column whose values differ", () => {
		passes([HEADER, x4Table(["paid", "shipped"])], LIST);
	});

	test("violates: a badge column constant across every row", () => {
		throwsRule([HEADER, x4Table(["paid", "paid"])], LIST, "X-4");
	});

	test("violates: more than one badge column", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "table",
					block_id: "orders:list",
					page_action_id: "orders:page",
					columns: [
						{ key: "state", label: "Status", format: "badge" },
						{ key: "kind", label: "Kind", format: "badge" },
					],
					rows: [
						{ state: "paid", kind: "physical" },
						{ state: "shipped", kind: "digital" },
					],
				},
			],
			LIST,
			"X-4",
		);
	});
});

describe("assertBlockContract — X-6 (R-4, §2)", () => {
	test("compliant: no divider", () => passes([HEADER], LIST));
	test("violates: a divider block", () => throwsRule([HEADER, { type: "divider" }], LIST, "X-6"));
});

describe("assertBlockContract — X-9 (M-1, M-3, T-4)", () => {
	test("compliant: money is a formatted string, and a count survives the exclusion", () => {
		passes(
			[
				HEADER,
				{
					type: "table",
					block_id: "orders:refunds",
					page_action_id: "orders:page",
					columns: [
						{ key: "reason", label: "Reason" },
						{ key: "amount", label: "Amount" },
					],
					rows: [{ reason: "damaged", amount: "$5.00" }],
				},
				{ type: "fields", fields: [{ label: "Refunds recorded", value: "3" }] },
			],
			LIST,
		);
	});

	test("violates: a raw-minor-units table cell on a money column", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "table",
					block_id: "orders:refunds",
					page_action_id: "orders:page",
					columns: [{ key: "amount", label: "Amount" }],
					rows: [{ amount: "500" }],
				},
			],
			LIST,
			"X-9",
		);
	});

	test('violates: format:"number" on a money column', () => {
		throwsRule(
			[
				HEADER,
				{
					type: "table",
					block_id: "orders:refunds",
					page_action_id: "orders:page",
					columns: [{ key: "amount", label: "Total", format: "number" }],
					rows: [{ amount: "$5.00" }],
				},
			],
			LIST,
			"X-9",
		);
	});

	test("violates: a number_input on a money field", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:refund",
					fields: [{ type: "number_input", action_id: "amount", label: "Refund amount" }],
					submit: { label: "Review refund", action_id: "orders:refund-review" },
				},
			],
			LIST,
			"X-9",
		);
	});

	test("violates: a raw fields value on a money label", () => {
		throwsRule(
			[HEADER, { type: "fields", fields: [{ label: "Total", value: "9900" }] }],
			LIST,
			"X-9",
		);
	});
});

describe("assertBlockContract — X-11 (§1 prose budgets)", () => {
	test("compliant: every string is inside budget", () => {
		passes(
			[
				HEADER,
				{ type: "context", text: "Filter and open an order." },
				{ type: "banner", variant: "default", description: "Refund recorded." },
				{
					type: "accordion",
					block_id: "orders:refunds",
					label: "Refunds (0)",
					blocks: [{ type: "context", text: "Nothing recorded yet." }],
				},
				{ type: "empty", title: "No orders yet", description: "Orders appear here once placed." },
			],
			LIST,
		);
	});

	test("violates: page-level context over 140 chars", () => {
		throwsRule([HEADER, { type: "context", text: "x".repeat(141) }], LIST, "X-11");
	});

	test("violates: a nested context over 200 chars", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "accordion",
					block_id: "orders:refunds",
					label: "Refunds",
					blocks: [{ type: "context", text: "x".repeat(201) }],
				},
			],
			LIST,
			"X-11",
		);
	});

	test("violates: banner.description over 240 chars", () => {
		throwsRule(
			[HEADER, { type: "banner", variant: "default", description: "x".repeat(241) }],
			LIST,
			"X-11",
		);
	});

	test("violates: accordion.label over 60 chars", () => {
		throwsRule(
			[HEADER, { type: "accordion", block_id: "orders:x", label: "x".repeat(61), blocks: [] }],
			LIST,
			"X-11",
		);
	});

	test("violates: confirm.title over 60 chars", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:cancel",
							label: "Cancel order",
							style: "danger",
							confirm: {
								title: "x".repeat(61),
								text: "ok",
								confirm: "Yes",
								deny: "No",
								style: "danger",
							},
						},
					],
				},
			],
			LIST,
			"X-11",
		);
	});

	test("violates: confirm.text over 200 chars", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:cancel",
							label: "Cancel order",
							style: "danger",
							confirm: {
								title: "Cancel?",
								text: "x".repeat(201),
								confirm: "Yes",
								deny: "No",
								style: "danger",
							},
						},
					],
				},
			],
			LIST,
			"X-11",
		);
	});

	test("violates: empty.description over 200 chars", () => {
		throwsRule(
			[HEADER, { type: "empty", title: "No orders", description: "x".repeat(201) }],
			LIST,
			"X-11",
		);
	});

	test("does NOT enforce the fields-value 40-char budget (X-11a is a human catch)", () => {
		passes([HEADER, { type: "fields", fields: [{ label: "Email", value: "x".repeat(80) }] }], LIST);
	});
});

describe("assertBlockContract — X-13 (M-6)", () => {
	test("compliant: absolute UTC trimmed to seconds", () => {
		passes(
			[
				HEADER,
				{ type: "fields", fields: [{ label: "Placed (UTC)", value: "2026-07-10T01:00:00Z" }] },
			],
			LIST,
		);
	});

	test("compliant: a relative_time table column carries the raw timestamp on purpose", () => {
		passes(
			[
				HEADER,
				{
					type: "table",
					block_id: "orders:list",
					page_action_id: "orders:page",
					columns: [{ key: "createdAt", label: "Placed", format: "relative_time" }],
					rows: [{ createdAt: "2026-07-10T01:00:00.000Z" }],
				},
			],
			LIST,
		);
	});

	test("violates: milliseconds in a fields value", () => {
		throwsRule(
			[
				HEADER,
				{ type: "fields", fields: [{ label: "Placed (UTC)", value: "2026-07-10T01:00:00.000Z" }] },
			],
			LIST,
			"X-13",
		);
	});

	test("violates: a non-UTC offset", () => {
		throwsRule(
			[
				HEADER,
				{ type: "fields", fields: [{ label: "Placed (UTC)", value: "2026-07-10T01:00:00+05:00" }] },
			],
			LIST,
			"X-13",
		);
	});
});

describe("assertBlockContract — X-14 (T-3)", () => {
	test("compliant: no sortable column", () => passes([HEADER, x14Table(false)], LIST));
	test("violates: sortable:true", () => throwsRule([HEADER, x14Table(true)], LIST, "X-14"));
});

describe("assertBlockContract — X-15 (§2)", () => {
	test("compliant: no columns/chart block", () => passes([HEADER], LIST));
	test("violates: a columns block", () => {
		throwsRule([HEADER, { type: "columns", columns: [] }], LIST, "X-15");
	});
	test("violates: a chart block", () => {
		throwsRule([HEADER, { type: "chart" }], LIST, "X-15");
	});
});

describe("assertBlockContract — X-16 (D-3, D-4)", () => {
	test("compliant: the D-2 panel set, default_tab 0", () => {
		passes([HEADER, x16Tab(["Order", "Fulfilment", "Money", "History"], 0)], DETAIL);
	});

	test("violates: a tab block on the LIST level", () => {
		throwsRule([HEADER, x16Tab(["Order", "Fulfilment", "Money", "History"])], LIST, "X-16");
	});

	test("violates: a panel set that differs from D-2's table", () => {
		throwsRule([HEADER, x16Tab(["Order", "Fulfilment", "Money"])], DETAIL, "X-16");
	});

	test("violates: default_tab other than 0", () => {
		throwsRule([HEADER, x16Tab(["Order", "Fulfilment", "Money", "History"], 1)], DETAIL, "X-16");
	});

	test("violates: level:'detail' on a screen with no D-2 entry", () => {
		throwsRule([HEADER], { screen: "tax", level: "detail" }, "X-16");
	});
});

describe("assertBlockContract — X-17 (B-1, B-3, B-3a)", () => {
	test("compliant: a prefilling form built through carriedForm-shaped block_id", () => {
		passes(
			[
				HEADER,
				x17CarriedForm([
					{
						type: "select",
						action_id: "status",
						label: "Status",
						initial_value: "any",
						options: [
							{ value: "any", label: "Any" },
							{ value: "paid", label: "Paid" },
						],
					},
				]),
			],
			LIST,
		);
	});

	test("compliant: a non-prefilling form needs no carrier at all", () => {
		passes(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:add-note",
					fields: [{ type: "text_input", action_id: "body", label: "Note" }],
					submit: { label: "Add note", action_id: "orders:add-note" },
				},
			],
			LIST,
		);
	});

	test("violates: a form with no block_id", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					fields: [{ type: "text_input", action_id: "body", label: "Note" }],
					submit: { label: "Add note", action_id: "orders:add-note" },
				},
			],
			LIST,
			"X-17",
		);
	});

	test("violates: a prefilling form whose block_id carries no carrier at all", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [
						{
							type: "select",
							action_id: "status",
							label: "Status",
							initial_value: "any",
							options: [{ value: "any", label: "Any" }],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-17",
		);
	});

	test("violates: a prefilling form whose carrier has no __v digest (hand-rolled, not carriedForm)", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: encodeCarrier("orders:filter", { status: "any" }),
					fields: [
						{
							type: "select",
							action_id: "status",
							label: "Status",
							initial_value: "any",
							options: [{ value: "any", label: "Any" }],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-17",
		);
	});

	test("violates: a button carrying a block_id", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:cancel",
							label: "Cancel",
							block_id: "orders:cancel:u1.abc",
						},
					],
				},
			],
			LIST,
			"X-17",
		);
	});
});

describe("assertBlockContract — X-18 (D-5, B-5, B-8)", () => {
	test("compliant: at most one default_open:true", () => {
		passes(
			[
				HEADER,
				{
					type: "accordion",
					block_id: "orders:fulfilment",
					label: "Fulfilment",
					default_open: true,
					blocks: [],
				},
				{
					type: "accordion",
					block_id: "orders:money",
					label: "Money",
					default_open: false,
					blocks: [],
				},
			],
			LIST,
		);
	});

	test("violates: two groups carry default_open:true in one response", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "accordion",
					block_id: "orders:fulfilment",
					label: "Fulfilment",
					default_open: true,
					blocks: [],
				},
				{
					type: "accordion",
					block_id: "orders:money",
					label: "Money",
					default_open: true,
					blocks: [],
				},
			],
			LIST,
			"X-18",
		);
	});
});

describe("assertBlockContract — X-20 (voice)", () => {
	test("compliant: no banned slogan anywhere", () => {
		passes([HEADER, { type: "context", text: "The store stops selling at zero stock." }], LIST);
	});

	test("violates: the banned slogan in a rendered string", () => {
		throwsRule([HEADER, { type: "context", text: "So it can never be oversold." }], LIST, "X-20");
	});
});

describe("assertBlockContract — X-22 (L-7, M-7, R-17a/b)", () => {
	test("compliant: a combobox picker whose label never repeats its own id value", () => {
		passes(
			[
				HEADER,
				{
					type: "form",
					block_id: carriedFormId("orders:open"),
					fields: [
						{
							type: "combobox",
							action_id: "orderId",
							label: "Open order",
							initial_value: "none",
							options: [
								{ value: "none", label: "Choose an order…" },
								{ value: "ord-1", label: "alice@example.com · $15.00 · paid" },
							],
						},
					],
					submit: { label: "Open order", action_id: "orders:open" },
				},
			],
			LIST,
		);
	});

	test("violates: the picker is a select, not a combobox", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:open",
					fields: [
						{
							type: "select",
							action_id: "orderId",
							label: "Open order",
							initial_value: "none",
							options: [
								{ value: "none", label: "Choose an order…" },
								{ value: "ord-1", label: "alice@example.com" },
							],
						},
					],
					submit: { label: "Open order", action_id: "orders:open" },
				},
			],
			LIST,
			"X-22",
		);
	});

	test("violates: an option label leaks its own opaque id value", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [
						{
							type: "combobox",
							action_id: "zoneId",
							label: "Zone",
							initial_value: "none",
							options: [{ value: "zone-domestic", label: "zone-domestic — United States" }],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-22",
		);
	});
});

describe("assertBlockContract — X-23 (F-6a)", () => {
	test("compliant: an initial_value present among options, no empty option", () => {
		passes(
			[
				HEADER,
				{
					type: "form",
					block_id: carriedFormId("orders:filter"),
					fields: [
						{
							type: "select",
							action_id: "status",
							label: "Status",
							initial_value: "any",
							options: [
								{ value: "any", label: "Any" },
								{ value: "paid", label: "Paid" },
							],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
		);
	});

	test("violates: no initial_value", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [
						{
							type: "select",
							action_id: "status",
							label: "Status",
							options: [{ value: "any", label: "Any" }],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-23",
		);
	});

	test("violates: initial_value absent from options", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [
						{
							type: "select",
							action_id: "status",
							label: "Status",
							initial_value: "bogus",
							options: [{ value: "any", label: "Any" }],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-23",
		);
	});

	test('violates: an option value of ""', () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:filter",
					fields: [
						{
							type: "select",
							action_id: "status",
							label: "Status",
							initial_value: "any",
							options: [
								{ value: "any", label: "Any" },
								{ value: "", label: "None" },
							],
						},
					],
					submit: { label: "Apply filters", action_id: "orders:apply-filter" },
				},
			],
			LIST,
			"X-23",
		);
	});
});

describe("assertBlockContract — X-24 (F-6b)", () => {
	test("compliant: a toggle with an explicit initial_value", () => {
		passes(
			[
				HEADER,
				{
					type: "form",
					block_id: carriedFormId("orders:x"),
					fields: [
						{
							type: "toggle",
							action_id: "flag",
							label: "Applies to shipping",
							initial_value: false,
						},
					],
					submit: { label: "Save", action_id: "orders:save" },
				},
			],
			LIST,
		);
	});

	test("violates: a toggle with no initial_value", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:x",
					fields: [{ type: "toggle", action_id: "flag", label: "Applies to shipping" }],
					submit: { label: "Save", action_id: "orders:save" },
				},
			],
			LIST,
			"X-24",
		);
	});
});

describe("assertBlockContract — X-25 (M-8)", () => {
	test("compliant: a money meter with custom_value", () => {
		passes(
			[
				HEADER,
				{ type: "meter", label: "Refunded", value: 0, max: 9900, custom_value: "$0.00 of $99.00" },
			],
			LIST,
		);
	});

	test("compliant: a count meter needs no custom_value", () => {
		passes([HEADER, { type: "meter", label: "Redemptions", value: 1, max: 10 }], LIST);
	});

	test("violates: a money meter with no custom_value", () => {
		throwsRule([HEADER, { type: "meter", label: "Refunded", value: 0, max: 9900 }], LIST, "X-25");
	});
});

describe("assertBlockContract — X-26 (M-9, §2)", () => {
	test("compliant: a real variant, no legacy text", () => {
		passes(
			[HEADER, { type: "banner", variant: "alert", description: "Needs reconciliation." }],
			LIST,
		);
	});

	test("violates: a phantom variant", () => {
		throwsRule(
			[HEADER, { type: "banner", variant: "success", description: "Saved." }],
			LIST,
			"X-26",
		);
	});

	test("violates: the legacy text field", () => {
		throwsRule([HEADER, { type: "banner", variant: "default", text: "Saved." }], LIST, "X-26");
	});
});

describe("assertBlockContract — X-27 (T-6, T-8)", () => {
	test("compliant: page_action_id set, no next_cursor in a leaf detail", () => {
		passes(
			ordersDetail([
				{
					type: "table",
					block_id: "orders:notes",
					page_action_id: "orders:page",
					columns: [],
					rows: [],
				},
			]),
			DETAIL,
		);
	});

	test("violates: no page_action_id", () => {
		throwsRule(
			ordersDetail([{ type: "table", block_id: "orders:notes", columns: [], rows: [] }]),
			DETAIL,
			"X-27",
		);
	});

	test("violates: next_cursor set inside a leaf detail", () => {
		throwsRule(
			ordersDetail([
				{
					type: "table",
					block_id: "orders:notes",
					page_action_id: "orders:page",
					next_cursor: "abc",
					columns: [],
					rows: [],
				},
			]),
			DETAIL,
			"X-27",
		);
	});
});

describe("assertBlockContract — X-28 (F-2a)", () => {
	test("compliant: no nonce/idempotency anywhere", () => {
		passes(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:refund",
							label: "Refund",
							value: { orderId: "ord-1" },
						},
					],
				},
			],
			LIST,
		);
	});

	test("violates: a nonce field on a form", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "form",
					block_id: "orders:refund",
					fields: [{ type: "text_input", action_id: "nonce", label: "Nonce" }],
					submit: { label: "Refund", action_id: "orders:refund" },
				},
			],
			LIST,
			"X-28",
		);
	});

	test("violates: an idempotency key in a button's value", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:refund",
							label: "Refund",
							value: { idempotencyKey: "abc" },
						},
					],
				},
			],
			LIST,
			"X-28",
		);
	});
});

describe("assertBlockContract — X-31 (§2)", () => {
	test("compliant: two top-level banners", () =>
		passes([HEADER, x31Banner(1), x31Banner(2)], LIST));
	test("violates: three top-level banners", () => {
		throwsRule([HEADER, x31Banner(1), x31Banner(2), x31Banner(3)], LIST, "X-31");
	});
});

describe("assertBlockContract — X-35 (D-6a)", () => {
	test("compliant: a destructive label with a consequence clause", () => {
		passes(
			[HEADER, x35DestructiveAccordion("Cancel order — permanent, releases held stock")],
			LIST,
		);
	});

	test("violates: a bare verb/noun label", () => {
		throwsRule([HEADER, x35DestructiveAccordion("Cancel order")], LIST, "X-35");
	});
});

describe("assertBlockContract — X-36 (D-6b)", () => {
	test("compliant: a real ratio", () => {
		passes(
			[
				HEADER,
				{
					type: "accordion",
					block_id: "orders:refunds",
					label: "Refunds — $5.00 of $15.00 refunded",
					blocks: [],
				},
			],
			LIST,
		);
	});
	test("violates: a degenerate ratio", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "accordion",
					block_id: "orders:refunds",
					label: "Refunds — $0.00 of $0.00 refunded",
					blocks: [],
				},
			],
			LIST,
			"X-36",
		);
	});
});

describe("assertBlockContract — X-37 (DA-2c, DA-5)", () => {
	test("compliant: 4 danger buttons, confirm always danger", () => {
		passes(
			[HEADER, { type: "actions", elements: [1, 2, 3, 4].map((i) => x37DangerButton(`r${i}`)) }],
			LIST,
		);
	});

	test("violates: 5 danger buttons in one actions block", () => {
		throwsRule(
			[HEADER, { type: "actions", elements: [1, 2, 3, 4, 5].map((i) => x37DangerButton(`r${i}`)) }],
			LIST,
			"X-37",
		);
	});

	test("violates: a confirm dialog that lost style:danger", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:cancel-other",
							label: "Out of stock",
							confirm: { title: "Sure?", text: "Cannot be undone.", confirm: "Yes", deny: "No" },
						},
					],
				},
			],
			LIST,
			"X-37",
		);
	});
});

describe("assertBlockContract — X-41 (DA-7a, E-4)", () => {
	test("compliant: names the alternative, not the withheld control", () => {
		passes(
			[
				HEADER,
				{ type: "context", text: "To ship this order, record tracking under Fulfilment above." },
			],
			LIST,
		);
	});
	test('violates: "deliberately"', () => {
		throwsRule(
			[HEADER, { type: "context", text: "There is deliberately no bare Mark shipped." }],
			LIST,
			"X-41",
		);
	});
});

describe("assertBlockContract — X-42 (E-7)", () => {
	test("compliant: normative fail-closed copy", () => {
		passes(
			[
				HEADER,
				{
					type: "banner",
					variant: "error",
					title: "Orders are unavailable",
					description:
						"Orders could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
				},
			],
			LIST,
		);
	});
	test("violates: names a single external cause with no console-fault disclaimer", () => {
		throwsRule(
			[
				HEADER,
				{ type: "banner", variant: "error", description: "Could not reach the commerce service." },
			],
			LIST,
			"X-42",
		);
	});
});

describe("assertBlockContract — X-52 (F-2b)", () => {
	const PRODUCTS_DETAIL: BlockContractOptions = { screen: "products", level: "detail" };
	test("compliant: Title is read-only and names its owner", () => {
		passes(
			productsDetail([
				{ type: "fields", fields: [{ label: "Title (set in the CMS)", value: "Widget" }] },
			]),
			PRODUCTS_DETAIL,
		);
	});
	test("violates: a form field writing to an owned key", () => {
		throwsRule(
			productsDetail([
				{
					type: "form",
					block_id: "products:edit",
					fields: [{ type: "text_input", action_id: "title", label: "Title" }],
					submit: { label: "Save", action_id: "products:save" },
				},
			]),
			PRODUCTS_DETAIL,
			"X-52",
		);
	});
	test("violates: an owned read-only row whose label omits the owner", () => {
		throwsRule(
			productsDetail([{ type: "fields", fields: [{ label: "Title", value: "Widget" }] }]),
			PRODUCTS_DETAIL,
			"X-52",
		);
	});
});

describe("assertBlockContract — MONEY-INTEGER (M-1, M-3, B-2)", () => {
	test("compliant: an integer minor-unit string in a carried payload", () => {
		passes(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:refund",
							label: "Refund",
							value: { amountCents: "1500" },
						},
					],
				},
			],
			LIST,
		);
	});

	test("violates: a decimal string on a Cents-suffixed key", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:refund",
							label: "Refund",
							value: { amountCents: "15.00" },
						},
					],
				},
			],
			LIST,
			"MONEY-INTEGER",
		);
	});

	test("violates: a float number on a Cents-suffixed key", () => {
		throwsRule(
			[
				HEADER,
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "orders:refund",
							label: "Refund",
							value: { amountCents: 15.5 },
						},
					],
				},
			],
			LIST,
			"MONEY-INTEGER",
		);
	});
});
