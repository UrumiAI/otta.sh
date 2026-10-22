/**
 * Tempered's cart, RENDERED — the hold countdown follows the store's
 * `showHoldTimer` setting (off by default). Display only: the line below holds
 * stock either way (it carries an `expiresAt`); the setting decides whether
 * the shopper is shown the countdown.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import type { CartModel } from "../src/themes/contract.js";
import CartView from "../src/themes/tempered/CartView.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

function cart(showHoldTimer: boolean): CartModel {
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
					expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
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
	test("off (the default) ⇒ a held line draws no ribbon", async () => {
		const html = await render(cart(false));
		expect(html).toContain("OTTA-TEE");
		expect(html).not.toMatch(/\sdata-hold(?=[\s=>])/);
		expect(html).not.toContain("Held for you");
	});

	test("on ⇒ the held line draws its ribbon", async () => {
		const html = await render(cart(true));
		expect(html).toMatch(/\sdata-hold(?=[\s=>])/);
		expect(html).toContain("Held for you");
	});

	test("an empty cart promises a hold only when the timer is shown", async () => {
		const off = await render({ ...cart(false), empty: true, summary: null, lineViews: [] });
		expect(off).toContain("Nothing here yet.");
		expect(off).not.toMatch(/\bhold\b/i);
		const on = await render({ ...cart(true), empty: true, summary: null, lineViews: [] });
		expect(on).toContain("Nothing held yet.");
		expect(on).toContain("we&#39;ll hold the stock");
	});
});
