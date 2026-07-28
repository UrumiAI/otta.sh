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

	test("renders the body copy and the reference when given them", async () => {
		const html = await stamp({
			state: "paid",
			body: "We've received your payment.",
			reference: "ord_01J8XQ4M7",
		});
		expect(html).toContain("We&#39;ve received your payment.");
		expect(html).toContain("ord_01J8XQ4M7");
		expect(html).toContain("Reference");
	});

	test("omits the reference row entirely when there is none", async () => {
		expect(await stamp({ state: "pending" })).not.toContain("Reference");
	});

	test("takes a slot, so a page can put the way out under the headline", async () => {
		const html = await container.renderToString(StateStamp, {
			props: { state: "expired", headline: "This order expired." },
			slots: { default: '<a href="/products">Start a new cart</a>' },
		});
		expect(html).toContain("Start a new cart");
	});
});
