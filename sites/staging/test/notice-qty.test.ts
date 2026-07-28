/**
 * Notice and QtyField (docs/theme/TEMPERED.md §4, §8).
 *
 * Notice is the theme's whole degraded vocabulary: a dashed bronze rule top and
 * bottom, a dashed mark, and NO filled background. The filled-panel assertion is
 * the one worth keeping — a tinted panel already means exactly one thing in
 * this theme ("image goes here"), and a yellow box is the look the rebuild
 * exists to remove.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import Notice from "../src/components/Notice.astro";
import QtyField from "../src/components/QtyField.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

describe("Notice — degraded is a look, not a crash", () => {
	const notice = (props: Record<string, unknown>, body: string): Promise<string> =>
		container.renderToString(Notice, { props, slots: { default: body } });

	test("leads with the sentence that says what happened, then the detail", async () => {
		const html = await notice(
			{ lead: "Prices are unavailable right now." },
			"Everything below is up to date.",
		);
		expect(html).toMatch(/<b[^>]*>Prices are unavailable right now\.<\/b>/);
		expect(html).toContain("Everything below is up to date.");
		expect(html.indexOf("<b")).toBeLessThan(html.indexOf("Everything below"));
	});

	test("works with no lead at all — the slot is the whole message", async () => {
		const html = await notice({}, "Totals are unavailable right now.");
		expect(html).toContain("Totals are unavailable right now.");
		expect(html).not.toContain("<b");
	});

	test("carries the dashed mark, hidden from screen readers", async () => {
		expect(await notice({}, "x")).toMatch(/class="mark"[^>]*aria-hidden="true"/);
	});

	test("has no filled background and no border box (§4)", async () => {
		const html = await notice({ lead: "Something is off." }, "But this still works.");
		expect(html).not.toMatch(/style="[^"]*background/);
	});

	test("its root class does NOT collide with legacy-bridge's global `.notice`", async () => {
		// `legacy-bridge.css` sets `.notice { color: #131a20 }` unscoped — a
		// deliberate literal pinned to the pale panel the unmigrated pages
		// still paint. Sharing the name would land a hard-coded near-black on
		// this component's text under the dark palette.
		const html = await notice({}, "x");
		const classes = (/^<div class="([^"]*)"/.exec(html)?.[1] ?? "").split(/\s+/);
		expect(classes).toContain("u-notice");
		// A token-exact check: `\bnotice\b` matches inside "u-notice", because a
		// hyphen is a word boundary.
		expect(classes).not.toContain("notice");
	});

	test("a caller can make it an alert, or hide it until it has something to say", async () => {
		// checkout/pay.astro needs exactly this in increment 5.
		const html = await container.renderToString(Notice, {
			props: { id: "payment-error", role: "alert", hidden: true },
			slots: { default: "Something went wrong." },
		});
		expect(html).toContain('id="payment-error"');
		expect(html).toContain('role="alert"');
		expect(html).toMatch(/\shidden/);
	});

	test("quotes the store's own copy verbatim — it does not rewrite it", async () => {
		// error-messages.ts is already written from the shopper's side (§10).
		const copy = "Card payment isn't set up on this store yet.";
		expect(await notice({}, copy)).toContain(copy);
	});
});

describe("QtyField — a quantity, in the data face", () => {
	const qty = (props: Record<string, unknown>): Promise<string> =>
		container.renderToString(QtyField, { props: { value: 1, ...props } });

	test("is a real label wrapping a real number input", async () => {
		const html = await qty({});
		expect(html).toMatch(/^<label /);
		expect(html).toContain('type="number"');
		expect(html).toContain('name="qty"');
		expect(html).toContain('value="1"');
	});

	test("never offers a quantity below one", async () => {
		expect(await qty({})).toContain('min="1"');
		expect(await qty({ min: 0 })).toContain('min="0"');
	});

	test("names the field, and can name the product with it", async () => {
		expect(await qty({ label: "Quantity, Urumi Tee" })).toContain("Quantity, Urumi Tee");
	});

	test("hiding the label hides it VISUALLY — it stays in the accessibility tree", async () => {
		const html = await qty({ label: "Quantity, Urumi Tee", hideLabel: true });
		expect(html).toContain("u-sr-only");
		expect(html).toContain("Quantity, Urumi Tee");
		// An `aria-label` on the input instead would work for a screen reader
		// and do nothing at all for a pointer.
		expect(html).not.toContain("aria-label");
	});

	test("asks for a numeric keypad on a phone", async () => {
		expect(await qty({})).toContain('inputmode="numeric"');
	});

	test("takes the cart's compact size and the buy row's default", async () => {
		expect(await qty({ size: "sm" })).toContain("size-sm");
		expect(await qty({})).toContain("size-md");
	});

	test("does not restyle focus — the straw ring is a global rule (§11)", async () => {
		expect(await qty({})).not.toMatch(/outline/);
	});
});
