/**
 * StateStamp (docs/theme/TEMPERED.md §4) — the order's own state, first thing
 * on the page.
 *
 * The assertion that matters most is the LAST one: a state this theme has never
 * heard of must get the neutral rule, not the paid one. The service can grow a
 * state at any time, and a stamp that quietly colours an unknown state as
 * settled would be the theme claiming something nobody told it.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import StateStamp from "../src/components/StateStamp.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const stamp = (props: Record<string, unknown>): Promise<string> =>
	container.renderToString(StateStamp, { props: { headline: "Order confirmed.", ...props } });

describe("StateStamp — the four states the tempering scale carries", () => {
	test.each([
		["paid", "paid"],
		["pending", "pending"],
		["failed", "failed"],
		["expired", "expired"],
	])("%s draws the %s rule", async (state, rule) => {
		expect(await stamp({ state })).toContain(`data-state="${rule}"`);
	});

	test("cancelled reads as lapsed — nothing was charged, the items went back", async () => {
		expect(await stamp({ state: "cancelled" })).toContain('data-state="expired"');
	});

	test("a state the theme has never heard of gets NO state colour at all", async () => {
		// It must not inherit "paid" by accident. The headline carries the
		// meaning; the rule stays neutral.
		const html = await stamp({ state: "refunded" });
		expect(html).not.toContain("data-state=");
	});
});

describe("StateStamp — what it renders", () => {
	test("the rule is decoration and is hidden from a screen reader", async () => {
		expect(await stamp({ state: "paid" })).toMatch(/class="rule"[^>]*aria-hidden="true"/);
	});

	test("the headline is an h1 by default — it is the page's subject", async () => {
		expect(await stamp({ state: "paid" })).toMatch(/<h1[^>]*>Order confirmed\.<\/h1>/);
	});

	test("but drops to h2 where it is not", async () => {
		expect(await stamp({ state: "paid", level: "h2" })).toMatch(/<h2[^>]*>/);
	});

	test("renders the body copy and the order's product label when given them", async () => {
		const html = await stamp({
			state: "paid",
			body: "We've received your payment.",
			orderLabel: "Otta Tee and 2 more",
		});
		expect(html).toContain("We&#39;ve received your payment.");
		expect(html).toContain("Otta Tee and 2 more");
		expect(html).toMatch(/class="u-label"[^>]*>Order<\/span>/);
	});

	test("the label is a product name, not a code: it is NOT set in mono", async () => {
		// TEMPERED.md §1 rule 2 — mono is for figures and codes. The order used to
		// be named by its id, which is a code; it is now named by what was bought.
		const html = await stamp({ state: "paid", orderLabel: "Otta Tee" });
		expect(html).not.toContain("u-mono");
	});

	test("no longer has a Reference row: the order id is not a thing it prints", async () => {
		// A shopper never sees the order UUID. The `reference` prop is gone (a
		// caller still passing one fails the typecheck).
		const html = await stamp({ state: "paid", reference: "ord_01J8XQ4M7" });
		// The RAW html, attributes included: a legacy `reference` is swallowed,
		// not spread onto the root, so an id cannot reach the DOM at all.
		expect(html).not.toContain("ord_01J8XQ4M7");
		expect(html).not.toContain("Reference");
	});

	test("omits the order row entirely when there is no label", async () => {
		expect(await stamp({ state: "pending" })).not.toMatch(/>Order<\/span>/);
	});

	test("takes a slot, so a page can put the way out under the headline", async () => {
		const html = await container.renderToString(StateStamp, {
			props: { state: "expired", headline: "This order expired." },
			slots: { default: '<a href="/products">Start a new cart</a>' },
		});
		expect(html).toContain("Start a new cart");
	});
});
