/**
 * @vitest-environment happy-dom
 *
 * The product page's add-to-cart key script (ADR-0039,
 * `public/scripts/add-to-cart-key.js`), run in a DOM. Issue #37: the form used to
 * post the ONE key the server rendered into the page, so a shopper who went Back
 * from the cart to the product page (a history-cache restore hands back the same
 * document, key and all) and pressed Add to cart again had the second add
 * replayed as the first — silently, no second unit.
 *
 * The rule pinned here: a key per SUBMISSION. A new press mints a new key; the
 * same submission sent again from the same page life (a double-click, a press
 * while the first request is still in flight) keeps its key, so the store
 * replays it instead of adding twice.
 *
 * What a key buys at the store — a fresh key adds, a repeated key replays — is
 * the plugin's half, asserted over a real store in
 * `packages/plugin/test/cart-routes.sandbox.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

const SCRIPT_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../public/scripts/add-to-cart-key.js",
);

/** The key the server rendered — what the form posts with no script at all. */
const RENDERED_KEY = "rendered-key";

/** The PDP's form as the theme draws it: the shared hidden fields, a quantity, a button. */
function page(): { form: HTMLFormElement; qty: HTMLInputElement; key: () => string } {
	document.body.innerHTML = `
		<form class="pdp-buy" method="POST" action="/cart/add">
			<input type="hidden" name="sku" value="SKU-1" />
			<input type="hidden" name="productId" value="prod-1" />
			<input type="hidden" name="idempotencyKey" value="${RENDERED_KEY}" />
			<input type="hidden" name="returnTo" value="/products/one" />
			<input type="number" name="qty" value="1" min="1" />
			<button type="submit">Add to cart</button>
		</form>`;
	// The script is a classic file with no imports: run it as the page would.
	new Function(readFileSync(SCRIPT_PATH, "utf8"))();
	const form = document.querySelector("form") as HTMLFormElement;
	const field = form.querySelector('input[name="idempotencyKey"]') as HTMLInputElement;
	return {
		form,
		qty: form.querySelector('input[name="qty"]') as HTMLInputElement,
		key: () => field.value,
	};
}

/** One press of Add to cart, and the key the request it starts would carry (read
 *  after the submit listeners ran, which is when the browser builds the body). */
function press(form: HTMLFormElement, key: () => string): string {
	const event = new Event("submit", { bubbles: true, cancelable: true });
	form.dispatchEvent(event);
	return key();
}

/** Back to the page from the browser's history cache (bfcache): the same
 *  document, script state and all, handed back with `persisted: true`. */
function restoreFromHistory(): void {
	const event = new Event("pageshow");
	Object.defineProperty(event, "persisted", { value: true });
	window.dispatchEvent(event);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("add-to-cart-key.js — one key per submission (issue #37)", () => {
	test("a press posts a key minted for it, not the one baked into the render", () => {
		const { form, key } = page();
		const sent = press(form, key);
		expect(sent).not.toBe(RENDERED_KEY);
		expect(sent).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("an intentional second add — Back to the page from the history cache, press again — gets a NEW key", () => {
		// The reported bug: before this script the second press re-sent RENDERED_KEY,
		// and the store replayed it as the first add.
		const { form, key } = page();
		const first = press(form, key);
		restoreFromHistory();
		const second = press(form, key);
		expect(second).not.toBe(first);
		expect(second).not.toBe(RENDERED_KEY);
	});

	test("a double-click (the same submission twice in one page life) keeps ONE key, so the store replays it", () => {
		const { form, key } = page();
		const first = press(form, key);
		const again = press(form, key);
		expect(again).toBe(first);
	});

	test("a re-press while the first request is still in flight keeps the key too — that is a retry", () => {
		// No navigation has completed, so this is the same page life: whatever the
		// first request did, the second must not do it again.
		const { form, key } = page();
		const first = press(form, key);
		const retry = press(form, key);
		const third = press(form, key);
		expect([retry, third]).toEqual([first, first]);
	});

	test("a CHANGED submission (another quantity) is a new add, never a reuse of the old key", () => {
		// Reusing a key for a different payload is a different command under the
		// same key — the store must never be asked to decide which one was meant.
		const { form, qty, key } = page();
		const first = press(form, key);
		qty.value = "3";
		const changed = press(form, key);
		expect(changed).not.toBe(first);
		// …and THAT submission, re-sent, is again a replay of itself.
		expect(press(form, key)).toBe(changed);
	});

	test("a pageshow that is a fresh load (persisted: false) is not a history restore and changes nothing", () => {
		const { form, key } = page();
		const first = press(form, key);
		window.dispatchEvent(new Event("pageshow"));
		expect(press(form, key)).toBe(first);
	});

	test("a browser without crypto.randomUUID leaves the rendered key alone (the no-JS behaviour)", () => {
		vi.stubGlobal("crypto", {});
		const { form, key } = page();
		expect(press(form, key)).toBe(RENDERED_KEY);
	});

	test("it touches only the add-to-cart form — another form's key is never rewritten", () => {
		page();
		document.body.insertAdjacentHTML(
			"beforeend",
			`<form method="POST" action="/cart/update"><input type="hidden" name="idempotencyKey" value="update-key" /></form>`,
		);
		const other = document.querySelector('form[action="/cart/update"]') as HTMLFormElement;
		other.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect((other.elements.namedItem("idempotencyKey") as HTMLInputElement).value).toBe(
			"update-key",
		);
	});
});
