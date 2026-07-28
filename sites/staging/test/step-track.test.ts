/**
 * StepTrack (docs/theme/TEMPERED.md §4) — Cart → Details → Payment → Order.
 *
 * Checkout is the one real sequence on the site, and it is the one place the
 * theme numbers anything. An ordered list rather than the mockup's row of
 * spans: the sequence IS the meaning, and `aria-current="step"` is the only way
 * a screen reader gets the same thing the straw dot gives everyone else.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import StepTrack, { CHECKOUT_STEPS } from "../src/components/StepTrack.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const track = (current: string): Promise<string> =>
	container.renderToString(StepTrack, { props: { current } });

/** The `data-state` of each step, in order — `undefined` for a future step. */
function states(html: string): (string | undefined)[] {
	return [...html.matchAll(/<li([^>]*)>/g)].map((m) => /data-state="(\w+)"/.exec(m[1] ?? "")?.[1]);
}

describe("StepTrack — the four steps", () => {
	test("always renders all four, in order", async () => {
		const html = await track("cart");
		for (const step of CHECKOUT_STEPS) expect(html).toContain(step.label);
		expect(states(html)).toHaveLength(4);
	});

	test("everything before the current step is done, everything after is neither", async () => {
		expect(states(await track("payment"))).toEqual(["done", "done", "now", undefined]);
	});

	test.each(["cart", "details", "payment", "order"] as const)(
		"at %s, exactly one step is current",
		async (current) => {
			const html = await track(current);
			expect(states(html).filter((state) => state === "now")).toHaveLength(1);
		},
	);

	test("the first step is current at the start, and nothing is done yet", async () => {
		expect(states(await track("cart"))).toEqual(["now", undefined, undefined, undefined]);
	});

	test("the last step is current at the end, and everything else is done", async () => {
		expect(states(await track("order"))).toEqual(["done", "done", "done", "now"]);
	});
});

describe("StepTrack — the sequence is in the markup, not only in the styling", () => {
	test("is an ordered list with a name", async () => {
		const html = await track("details");
		expect(html).toMatch(/^<ol /);
		expect(html).toContain('aria-label="Checkout progress"');
	});

	test("the current step carries aria-current, and only that one", async () => {
		const html = await track("details");
		expect(html.match(/aria-current="step"/g) ?? []).toHaveLength(1);
	});

	test("the dots are decoration and are hidden from a screen reader", async () => {
		const html = await track("details");
		expect(html.match(/class="dot"[^>]*aria-hidden="true"/g) ?? []).toHaveLength(4);
	});
});
