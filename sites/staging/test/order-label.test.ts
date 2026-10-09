/**
 * A shopper never sees the order id.
 *
 * An order id is a UUID: to the buyer it names nothing they bought. So every
 * customer surface names the order by its products instead — `orderLabel` from
 * `@otta-sh/plugin` (the domain's one function, the same the order emails use):
 * "Otta Tee", "Otta Tee × 3", "Otta Tee and 2 more", or "Your order".
 *
 * The id still does its machine jobs — it is in every URL (`/orders/<id>`,
 * `/account/orders/<id>`), the checkout stash, Stripe's metadata — and the
 * admin console, which is the merchant's, keeps showing it. What is pinned here
 * is narrower and exact: no shopper-facing TEMPLATE prints it as text, and no
 * page puts it in the `<title>`.
 *
 * The split follows the theme contract (`src/themes/contract.ts`): the PAGE
 * builds the label and hands it over in the model; the VIEW only prints it. So
 * the page pins look for the `orderLabel(` call, and the view pins look for the
 * model field — and for the absence of any id expression in the markup.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { splitAstro, templateOf } from "./astro-source.js";
import { COMMERCE_VIEW_FILES, type CommerceView, viewCases } from "./theme-views.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (relative: string): string => readFileSync(path.join(SRC, relative), "utf8");

/** Every expression that holds an order id on a shopper surface: the public
 *  order's and the account row's `id`, the locked checkout's `id`, the cart's
 *  `placedOrderId`, and a stash's or wire's `orderId`. */
const ID_TOKEN = String.raw`(?:(?:order|row|locked)\.id|placedOrderId|(?:order|stash)\.orderId)`;

/** An id RENDERED: `{order.id}` as text, `attr={order.id}` as a prop (the
 *  stamp's old `reference={order.id}`), or `${order.id}` inside a string (a
 *  `<title>`). Matched only after `href`s are removed — an
 *  `encodeURIComponent(order.id)` inside an href is a URL, which is exactly
 *  where the id belongs. A condition such as `{placedOrderId !== null && …}`
 *  is not a rendering and is not matched. */
const RENDERED_ID = new RegExp(String.raw`(?:\{|\$\{)\s*${ID_TOKEN}\s*\}|\breference=\{`);

/** The template with every `href={…}` removed — a template-literal href first,
 *  since its `${…}` holds a `}` a plain `[^}]*` would stop at. */
function withoutHrefs(template: string): string {
	return template.replace(/href=\{`[^`]*`\}/g, "").replace(/href=\{[^}]*\}/g, "");
}

describe("the id guard itself", () => {
	test.each([
		"<span>{order.id}</span>",
		"<StateStamp reference={order.id} />",
		"<p>{row.id}</p>",
		"<p>{locked.id}</p>",
		"<p>{placedOrderId}</p>",
		"<p>{stash.orderId}</p>",
		"<p>{order.orderId}</p>",
		"<Storefront title={`Order ${order.id}`} />",
	])("catches %s", (snippet) => {
		expect(withoutHrefs(snippet)).toMatch(RENDERED_ID);
	});

	test.each([
		"<a href={`/orders/${encodeURIComponent(locked.id)}`}>your order page</a>",
		"<a href={row.href}>{row.label}</a>",
		"{placedOrderId !== null && (<a href={`/orders/${encodeURIComponent(placedOrderId)}`}>View</a>)}",
	])("lets a URL or a condition through: %s", (snippet) => {
		expect(withoutHrefs(snippet)).not.toMatch(RENDERED_ID);
	});
});

/** EVERY commerce view the registry resolves, for every theme — the cart, the
 *  review and the pay step hold an order id too (in links), and a restyle must
 *  not let one slip into the text. */
describe.each(
	(Object.keys(COMMERCE_VIEW_FILES) as CommerceView[]).flatMap((view) => viewCases(view)),
)("the shopper view %s", (_label, { source }) => {
	test("prints no order id", () => {
		expect(withoutHrefs(templateOf(source))).not.toMatch(RENDERED_ID);
	});
});

describe.each(viewCases("order"))("the confirmation view %s", (_label, { source }) => {
	test("hands the stamp the page's product label", () => {
		expect(templateOf(source)).toMatch(/<StateStamp[^>]*orderLabel=\{orderLabel\}/);
	});
});

describe.each(viewCases("accountOrders"))("the account order list %s", (_label, { source }) => {
	test("each row's link is named by its products, and still goes to the order", () => {
		const template = templateOf(source);
		expect(template).toMatch(/<a\b[^>]*href=\{row\.href\}[^>]*>\s*\{row\.label\}\s*<\/a>/);
	});
});

describe.each(viewCases("accountOrder"))("the account order view %s", (_label, { source }) => {
	test("the heading is the product label", () => {
		expect(templateOf(source)).toMatch(/<h1[^>]*>\s*\{order\.label\}\s*<\/h1>/);
	});
});

describe.each([
	["orders/[orderId].astro", /orderLabel\(\s*order\.lines\.map/],
	["account/orders/index.astro", /orderLabel\(\s*order\.lines/],
	["account/orders/[id].astro", /orderLabel\(\s*order\.lines/],
])("the page %s", (page, builds) => {
	const source = read(`pages/${page}`);

	test("builds the label with the shared orderLabel — never its own spelling", () => {
		expect(splitAstro(source).frontmatter).toMatch(
			/import \{[^}]*\borderLabel\b[^}]*\} from "@otta-sh\/plugin"/,
		);
		expect(splitAstro(source).frontmatter).toMatch(builds);
	});

	test("never names the order by its id in the <title>", () => {
		expect(templateOf(source)).not.toMatch(/title=\{[^}]*\.id\b/);
		expect(withoutHrefs(templateOf(source))).not.toMatch(RENDERED_ID);
	});
});

describe("the account models carry no id for a view to print", () => {
	const contract = read("themes/contract.ts");
	const block = (name: string): string =>
		new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(contract)?.[0] ?? "";

	test("AccountOrderRow: a label and an href, no id", () => {
		expect(block("AccountOrderRow")).toMatch(/\blabel: string;/);
		expect(block("AccountOrderRow")).not.toMatch(/\bid: string;/);
	});

	test("AccountOrderModel: a label, no id", () => {
		expect(block("AccountOrderModel")).toMatch(/\blabel: string;/);
		expect(block("AccountOrderModel")).not.toMatch(/\bid: string;/);
	});

	test("OrderModel carries the label the confirmation prints", () => {
		expect(block("OrderModel")).toMatch(/\borderLabel: string \| null;/);
	});
});

/**
 * The order NUMBER (ADR-0033): "#" + the id's first five characters, upper-cased —
 * the plugin's `orderNumber`, the same function the order emails and the admin
 * console use. Every customer surface prints it beside the product label, so a
 * shopper can quote it to the merchant. The PAGE builds it from the id; the VIEW
 * prints only the model field — so the id guard above still holds for every view.
 */
describe("the order number", () => {
	describe.each([
		["orders/[orderId].astro", /orderNumber\(\s*order\.id\s*\)/],
		["account/orders/index.astro", /number: orderNumber\(\s*order\.id\s*\)/],
		["account/orders/[id].astro", /number: orderNumber\(\s*order\.id\s*\)/],
	])("the page %s", (page, builds) => {
		const source = read(`pages/${page}`);

		test("builds it with the shared orderNumber — never its own slice of the id", () => {
			const { frontmatter } = splitAstro(source);
			expect(frontmatter).toMatch(/import \{[^}]*\borderNumber\b[^}]*\} from "@otta-sh\/plugin"/);
			expect(frontmatter).toMatch(builds);
			expect(frontmatter).not.toMatch(/\.id\.slice\(/);
		});
	});

	describe.each(viewCases("order"))("the confirmation view %s", (_label, { source }) => {
		test("hands the stamp the page's number", () => {
			expect(templateOf(source)).toMatch(/<StateStamp[^>]*orderNumber=\{orderNumber\}/);
		});
	});

	describe.each(viewCases("accountOrders"))("the account order list %s", (_label, { source }) => {
		test("each row prints its number", () => {
			expect(templateOf(source)).toMatch(/\{row\.number\}/);
		});
	});

	describe.each(viewCases("accountOrder"))("the account order view %s", (_label, { source }) => {
		test("the order prints its number", () => {
			expect(templateOf(source)).toMatch(/\{order\.number\}/);
		});
	});

	test("the models carry it as a string, beside the label", () => {
		const contract = read("themes/contract.ts");
		const block = (name: string): string =>
			new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(contract)?.[0] ?? "";
		expect(block("OrderModel")).toMatch(/\borderNumber: string \| null;/);
		expect(block("AccountOrderRow")).toMatch(/\bnumber: string;/);
		expect(block("AccountOrderModel")).toMatch(/\bnumber: string;/);
	});
});
