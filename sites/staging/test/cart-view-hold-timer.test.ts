/**
 * Tempered's cart, RENDERED — the hold countdown follows the store's
 * `showHoldTimer` setting (off by default). Display only: the line below holds
 * stock either way (it carries an `expiresAt`); the setting decides whether
 * the shopper is shown the countdown.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import type { CartModel } from "../src/themes/contract.js";
import { HOLD_RELEASED_NEXT_STEP, HOLD_RELEASED_NEXT_STEP_NO_TIMER } from "../src/lib/hold.js";
import CartView from "../src/themes/tempered/CartView.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

function cart(showHoldTimer: boolean, expiresInSeconds = 10 * 60): CartModel {
	return {
		summary: "1 item",
		errorMessage: null,
		degraded: false,
		degradedLead: "Your cart is unavailable right now.",
		pricingNotice: false,
		empty: false,
		terminal: false,
		placedOrderId: null,
		staleCurrency: null,
		showHoldTimer,
		lineViews: [
			{
				line: {
					lineId: "l1",
					sku: "OTTA-TEE",
					qty: 1,
					expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
				},
				title: "Otta Tee",
				name: "Otta Tee",
				image: null,
				artKey: "otta-tee",
				href: "/products/otta-tee",
				money: "$12.00",
				each: null,
				updateKey: "u1",
				removeKey: "r1",
			},
		],
		sumRows: [],
		totalAmount: { state: "not_calculated", money: null, label: "—" },
		partialNote: null,
	};
}

const render = (model: CartModel): Promise<string> =>
	container.renderToString(CartView, { props: { model } });

describe("the cart's hold countdown follows the hold-timer setting", () => {
	test("off (the default) ⇒ a held line shows no countdown and no hold copy", async () => {
		const html = await render(cart(false));
		expect(html).toContain("OTTA-TEE");
		expect(html).not.toContain("Held for you");
		expect(html).not.toContain("data-hold-clock");
		expect(html).not.toContain("data-hold-fill");
		expect(html).not.toContain('role="timer"');
		// The note-only root is there for the script, with its note hidden.
		expect(html).toMatch(/data-hold-note[^>]*hidden/);
	});

	test("off ⇒ a lapsed hold still tells the shopper the line leaves the cart (#547)", async () => {
		const html = await render(cart(false, -30));
		expect(html).toContain(HOLD_RELEASED_NEXT_STEP_NO_TIMER);
		expect(html).not.toContain(HOLD_RELEASED_NEXT_STEP);
		expect(html).not.toMatch(/data-hold-note[^>]*hidden/);
		expect(html).not.toContain("data-hold-clock");
		expect(html).not.toContain("Hold released");
		// A store that never showed a hold does not talk about holding.
		expect(HOLD_RELEASED_NEXT_STEP_NO_TIMER).not.toMatch(/hold/i);
		expect(HOLD_RELEASED_NEXT_STEP_NO_TIMER.endsWith("add it again.")).toBe(true);
	});

	test("off ⇒ a line that never took a reservation draws nothing", async () => {
		const model = cart(false);
		const [first] = model.lineViews;
		if (first === undefined) throw new Error("fixture");
		const html = await render({
			...model,
			lineViews: [{ ...first, line: { ...first.line, expiresAt: null } }],
		});
		expect(html).not.toMatch(/\sdata-hold(?=[\s=>])/);
	});

	test("on ⇒ a lapsed hold keeps the timer-on next step", async () => {
		const html = await render(cart(true, -30));
		expect(html).toContain(HOLD_RELEASED_NEXT_STEP);
		expect(html).not.toContain(HOLD_RELEASED_NEXT_STEP_NO_TIMER);
	});

	test("on ⇒ the held line draws its ribbon", async () => {
		const html = await render(cart(true));
		expect(html).toMatch(/\sdata-hold(?=[\s=>])/);
		expect(html).toContain("Held for you");
	});

	test.each([true, false])(
		"the ribbon carries the line's name as data-product, timer %s (#570)",
		async (timer) => {
			const html = await render(cart(timer));
			expect(html).toMatch(/\sdata-product="Otta Tee"/);
			// Carried for the announcement only; the visible copy is unchanged.
			expect(html.replace(/\sdata-product="Otta Tee"/, "")).not.toContain("data-product");
		},
	);

	test.each([true, false])(
		"a titleless line is announced by its SKU, timer %s (#570)",
		async (timer) => {
			const model = cart(timer);
			const [first] = model.lineViews;
			if (first === undefined) throw new Error("fixture");
			const html = await render({
				...model,
				lineViews: [{ ...first, title: null, name: first.line.sku }],
			});
			expect(html).toMatch(/\sdata-product="OTTA-TEE"/);
		},
	);

	test("an empty cart promises a hold only when the timer is shown", async () => {
		const off = await render({ ...cart(false), empty: true, summary: null, lineViews: [] });
		expect(off).toContain("Nothing here yet.");
		expect(off).not.toMatch(/\bhold\b/i);
		const on = await render({ ...cart(true), empty: true, summary: null, lineViews: [] });
		expect(on).toContain("Nothing held yet.");
		expect(on).toContain("we&#39;ll hold the stock");
	});
});
