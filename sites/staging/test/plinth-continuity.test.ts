/**
 * Plinth's signature carried into the bag (theme-briefs.md §1, "Signature: card
 * to product page continuity"): a bag line's picture and title wear the SAME
 * view-transition names as its product page, so "Add to bag" lands the object
 * in its line and the line opens back into its product page — CSS only.
 *
 * The one way this quietly breaks is a DUPLICATE: a `view-transition-name` two
 * elements carry on one page aborts the whole transition. A bag can hold two
 * lines of one product, so the names are handed out once per page; these tests
 * render the real views and count.
 *
 * And the hold: plain text and a small dot, driven by HoldClock's existing
 * hooks only — the words change once a minute, then count seconds.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import { HOLD_RELEASED_NEXT_STEP } from "../src/lib/hold.js";
import { productKey, productPath } from "../src/lib/products.js";
import type {
	CartLineModel,
	CartModel,
	ProductModel,
	ShopCard,
	ShopModel,
} from "../src/themes/contract.js";
import { plinthTransitionName } from "../src/themes/plinth/art.js";
import CartView from "../src/themes/plinth/CartView.astro";
import { firstOfEachKey, lineTransitionStyles } from "../src/themes/plinth/continuity.js";
import HoldRibbon from "../src/themes/plinth/HoldRibbon.astro";
import ProductView from "../src/themes/plinth/ProductView.astro";
import ShopView from "../src/themes/plinth/ShopView.astro";
import { SRC } from "./theme-views.js";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const inSeconds = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

function line(index: number, artKey: string, href: string | null): CartLineModel {
	return {
		line: { lineId: `line-${index}`, sku: `SKU-${index}`, qty: 1, expiresAt: inSeconds(600) },
		index,
		title: href === null ? null : `Object ${index}`,
		name: href === null ? `SKU-${index}` : `Object ${index}`,
		image: null,
		artKey,
		href,
		money: "£10.00",
		each: null,
		updateKey: `u-${index}`,
		removeKey: `r-${index}`,
	};
}

function cart(lineViews: CartLineModel[]): CartModel {
	return {
		summary: `${lineViews.length} items`,
		errorMessage: null,
		degraded: false,
		degradedLead: "",
		pricingNotice: false,
		empty: lineViews.length === 0,
		terminal: false,
		placedOrderId: null,
		lineViews,
		sumRows: [],
		totalAmount: { money: null, label: "Calculated at checkout" },
		partialNote: null,
	};
}

/** Every view-transition name a rendered page hands out through the inline
 *  `--pl-vt-*` properties — which is the only way a Plinth view names anything. */
const vt = (key: string): string[] => [
	plinthTransitionName(key, "media"),
	plinthTransitionName(key, "title"),
];

function namesIn(html: string): string[] {
	return [...html.matchAll(/--pl-vt-(?:media|title): ([\w-]+)/g)].map((match) => match[1] ?? "");
}

describe("lineTransitionStyles — one name per product per page", () => {
	test("each line with a product page is named after its product", () => {
		const styles = lineTransitionStyles([
			{ artKey: "desk-lamp", href: "/products/desk-lamp" },
			{ artKey: "vase", href: "/products/vase" },
		]);
		const [lampMedia, lampTitle] = vt("desk-lamp");
		const [vaseMedia, vaseTitle] = vt("vase");
		expect(styles).toEqual([
			`--pl-vt-media: ${lampMedia}; --pl-vt-title: ${lampTitle}`,
			`--pl-vt-media: ${vaseMedia}; --pl-vt-title: ${vaseTitle}`,
		]);
		expect(lampMedia).toMatch(/^pl-media-desk-lamp-[0-9a-z]+$/);
	});

	test("a second line of the same product carries no name — a duplicate aborts the transition", () => {
		const styles = lineTransitionStyles([
			{ artKey: "vase", href: "/products/vase" },
			{ artKey: "vase", href: "/products/vase" },
		]);
		expect(styles[0]).toContain(plinthTransitionName("vase", "media"));
		expect(styles[1]).toBeUndefined();
	});

	test("names are collision-resistant: keys that sanitize alike are still two products", () => {
		// Anything outside [A-Za-z0-9_-] reads as `-`, so the readable part of
		// `a.b` and `a-b` (or of two non-ASCII slugs) is the same; the hash of the
		// raw key keeps the names apart, and each line keeps its morph.
		for (const [a, b] of [
			["a.b", "a-b"],
			["café", "cafè"],
			["花瓶", "茶碗"],
		] as const) {
			expect(plinthTransitionName(a, "media")).not.toBe(plinthTransitionName(b, "media"));
		}
		const styles = lineTransitionStyles([
			{ artKey: "a.b", href: "/products/a.b" },
			{ artKey: "a-b", href: "/products/a-b" },
		]);
		expect(styles[0]).toBeDefined();
		expect(styles[1]).toBeDefined();
		expect(styles[0]).not.toBe(styles[1]);
	});

	test("firstOfEachKey marks the first occurrence of each key only", () => {
		expect(firstOfEachKey(["a", "b", "a", "c", "b"])).toEqual([true, true, false, true, false]);
	});

	test("a line with no product page to morph to is never named", () => {
		expect(lineTransitionStyles([{ artKey: "SKU-1", href: null }])).toEqual([undefined]);
	});
});

describe("the rendered bag names each object once, and as its product page does", () => {
	test("no view-transition name appears twice on the bag page", async () => {
		const html = await container.renderToString(CartView, {
			props: {
				model: cart([
					line(0, "vase", "/products/vase"),
					line(1, "desk-lamp", "/products/desk-lamp"),
					line(2, "vase", "/products/vase"),
					line(3, "SKU-3", null),
				]),
			},
		});
		const names = namesIn(html);
		expect(names.toSorted()).toEqual([...vt("desk-lamp"), ...vt("vase")].toSorted());
		expect(new Set(names).size).toBe(names.length);
	});

	test("inside a named line, exactly one picture and one title take the names", async () => {
		const html = await container.renderToString(CartView, {
			props: { model: cart([line(0, "vase", "/products/vase")]) },
		});
		const named = /<li[^>]*style="--pl-vt-media[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
		expect(named).not.toBe("");
		expect(named.match(/class="[^"]*\bpl-vt-media\b/g)).toHaveLength(1);
		expect(named.match(/class="[^"]*\bpl-vt-title\b/g)).toHaveLength(1);
		// The picture links back to the product page the name morphs into.
		expect(named).toContain('href="/products/vase"');
	});

	test("the product page wears the same two names for the same product", async () => {
		const model: ProductModel = {
			state: "ok",
			title: "Vase",
			description: null,
			art: "vase",
			image: null,
			dimmed: false,
			degradedLead: null,
			errorMessage: null,
			purchase: null,
			showNotForSale: true,
		};
		const pdp = namesIn(await container.renderToString(ProductView, { props: { model } }));
		const bag = namesIn(
			await container.renderToString(CartView, {
				props: { model: cart([line(0, "vase", "/products/vase")]) },
			}),
		);
		expect(pdp.toSorted()).toEqual(bag.toSorted());
		expect(new Set(pdp).size).toBe(pdp.length);
	});

	test("the names are applied only for a visitor who has not asked for less motion", () => {
		// page-css.test.ts holds every sheet to this; pinned here too because the
		// continuity depends on the SAME selectors the card and product page use.
		const sheet = readFileSync(path.join(SRC, "themes/plinth/views.css"), "utf8");
		const motion = sheet.slice(sheet.indexOf("@media (prefers-reduced-motion: no-preference)"));
		expect(motion).toMatch(
			/\.pl-vt-media\s*\{\s*view-transition-name: var\(--pl-vt-media, none\);/,
		);
		expect(motion).toMatch(
			/\.pl-vt-title\s*\{\s*view-transition-name: var\(--pl-vt-title, none\);/,
		);
		expect(motion).toMatch(/\.pl-head\s*\{\s*view-transition-name: pl-head;/);
		expect(readFileSync(path.join(SRC, "themes/plinth/theme.css"), "utf8")).toMatch(
			/@view-transition\s*\{\s*navigation: auto;\s*\}/,
		);
	});
});

const card = (slug: string): ShopCard => ({
	href: `/products/${slug}`,
	slug,
	title: slug,
	description: null,
	image: null,
	price: "£10.00",
	priceNote: undefined,
	availability: "in_stock",
});

describe("the shop grid names each product once", () => {
	test("no view-transition name appears twice, even for a product listed twice", async () => {
		const model: ShopModel = {
			state: "list",
			degradedNotice: null,
			countLabel: "5 items",
			cards: [card("vase"), card("a.b"), card("a-b"), card("vase"), card("花瓶")],
			adminHref: "/_emdash/admin",
		};
		const names = namesIn(await container.renderToString(ShopView, { props: { model } }));
		expect(new Set(names).size).toBe(names.length);
		// Every distinct product still carries its pair; only the repeat is bare.
		expect(names).toHaveLength(8);
	});
});

const page = (file: string): string => readFileSync(path.join(SRC, "pages", file), "utf8");

describe("one product key, so the card, the product page and the bag line agree", () => {
	test("productKey is the slug, else the id; productPath is built from it", () => {
		expect(productKey({ slug: "vase", id: "p-1" })).toBe("vase");
		expect(productKey({ slug: null, id: "p-1" })).toBe("p-1");
		expect(productKey({ id: "p-1" })).toBe("p-1");
		expect(productPath("vase", "p-1")).toBe(`/products/${productKey({ slug: "vase", id: "p-1" })}`);
		expect(productPath(null, "p-1")).toBe("/products/p-1");
	});

	test("the cart line, the product page and both card mappings all key off productKey", () => {
		const cartPage = page("cart/index.astro");
		// The line's art key and its link come from the same product.
		expect(cartPage).toMatch(
			/artKey: content === null \? \(line\.productId \?\? line\.sku\) : productKey\(content\)/,
		);
		expect(cartPage).toContain(
			"href: content === null ? null : productPath(content.slug, content.id)",
		);
		expect(page("products/[slug].astro")).toContain(
			'const art = content !== null ? productKey(content) : "";',
		);
		for (const file of ["index.astro", "products/index.astro"]) {
			expect(page(file), file).toContain("slug: productKey(product),");
		}
		expect(readFileSync(path.join(SRC, "lib/bag.ts"), "utf8")).toMatch(
			/artKey: content === null \? \(line\.productId \?\? line\.sku\) : productKey\(content\)/,
		);
	});
});

describe("Plinth's hold: text and a small dot, on HoldClock's hooks", () => {
	const render = (expiresAt: string | null): Promise<string> =>
		container.renderToString(HoldRibbon, { props: { expiresAt } });

	test("held: the wall clock in words, the minutes in a slot the script keeps current", async () => {
		const html = await render(inSeconds(14 * 60 + 30));
		expect(html).toContain("data-hold");
		expect(html).toContain('data-state="held"');
		// Opt-in minute tracking, so CSS could key off it; the first frame is the server's.
		expect(html).toContain('data-minutes="14"');
		expect(html).toMatch(/Held for you until \d{1,2}:\d{2} [ap]m UTC/);
		expect(html).toMatch(/data-hold-minutes><span class="pl-nojs">14<\/span>/);
		expect(html).toContain("min left");
		expect(html).toContain('class="pl-dot"');
		// No bar, no ring: nothing for --pct to drive.
		expect(html).not.toContain("data-hold-fill");
		expect(html).toContain('data-motion="essential"');
	});

	test("under a minute: the seconds slot, and the state CSS switches the sentence on", async () => {
		const html = await render(inSeconds(42));
		expect(html).toContain('data-state="expiring"');
		expect(html).toMatch(/data-hold-seconds><span class="pl-nojs">4[12]<\/span>/);
		expect(html).toContain("sec left");
	});

	test("released: the next step is in the markup; no reservation renders nothing", async () => {
		const html = await render(inSeconds(-5));
		expect(html).toContain('data-state="released"');
		expect(html).toContain(HOLD_RELEASED_NEXT_STEP);
		expect((await render(null)).trim()).toBe("");
	});

	test("the sheet shows one sentence per state and hides the count until the script has run", () => {
		const sheet = readFileSync(path.join(SRC, "themes/plinth/commerce.css"), "utf8");
		expect(sheet).toContain('.pl-held[data-state="expiring"] .pl-held-soon');
		expect(sheet).toContain('.pl-held[data-state="released"] .pl-held-gone');
		expect(sheet).toMatch(/\.pl-held-count:has\(\.pl-nojs\)\s*\{\s*display: none;/);
		// Nothing on the hold moves: no transition, no animation anywhere in the sheet.
		expect(sheet.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
			/transition\s*:|animation\s*:|@keyframes/,
		);
	});
});
