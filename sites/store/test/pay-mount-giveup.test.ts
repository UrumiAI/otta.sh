/**
 * @vitest-environment happy-dom
 *
 * Issue #146: when the pay page GIVES UP — Stripe.js never loaded, `Stripe()`
 * threw on the key, or the Payment Element could not be mounted at all — the
 * bordered box the fields sit in (`.mount`) must go with them. Clearing
 * `#payment-element` alone leaves an empty bordered, filled box above the
 * error. A RECOVERABLE failure (a declined card, a confirm that rejected) is
 * the opposite: the fields stay, so the buyer can try again.
 *
 * The page's inline Stripe script is run as the browser would, against a DOM
 * shaped like the page's payment slot and a stubbed `Stripe`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

const PAY = readFileSync(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages/checkout/pay.astro"),
	"utf8",
);
const INLINE = [...PAY.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script[^>]*>/gi)]
	.map((m) => ({ attrs: m[1] ?? "", body: m[2] ?? "" }))
	.find((s) => /is:inline/.test(s.attrs) && /confirmPayment/.test(s.body))?.body;

type ConfirmResult = { error?: { message?: string; code?: string } };

interface StripeStub {
	/** `Stripe(key)` throws. */
	constructorThrows?: boolean;
	/** `mount()` throws on every attempt, themed or not. */
	mountThrows?: boolean;
	/** What `confirmPayment` does. */
	confirm?: () => Promise<ConfirmResult>;
}

function stubStripe(stub: StripeStub): void {
	vi.stubGlobal("Stripe", function Stripe() {
		if (stub.constructorThrows === true) throw new Error("Invalid API Key provided");
		return {
			elements() {
				return {
					create() {
						return {
							mount(selector: string) {
								if (stub.mountThrows === true) throw new Error("Invalid client secret");
								const frame = document.createElement("iframe");
								document.querySelector(selector)?.appendChild(frame);
							},
							destroy() {},
						};
					},
					update() {},
				};
			},
			confirmPayment: stub.confirm ?? (() => new Promise<ConfirmResult>(() => {})),
		};
	});
}

/** The payment slot as `pay.astro` renders it — the parts the script reads. */
function render(): void {
	document.body.innerHTML = `
		<form id="payment-form">
			<div class="mount">
				<div id="payment-element" data-client-secret="pi_1_secret_2" data-publishable-key="pk_test_x" data-return-url="/orders/o1"></div>
			</div>
			<div id="payment-error" class="pay-error-region" role="alert" tabindex="-1">
				<p id="payment-error-text" class="pay-error" hidden></p>
			</div>
			<button id="payment-submit" type="submit">Pay</button>
		</form>`;
	new Function(INLINE ?? "")();
}

const wrapper = (): HTMLElement => document.querySelector<HTMLElement>(".mount")!;
/** The refusal's text, inside the always-present alert region (#604). */
const errorBox = (): HTMLElement => document.getElementById("payment-error-text")!;
const submit = (): HTMLButtonElement =>
	document.getElementById("payment-submit") as HTMLButtonElement;

const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

test("the page's inline Stripe script is found", () => {
	expect(INLINE).toBeDefined();
	// The fixture's wrapper is the page's: `#payment-element` sits directly in `.mount`.
	expect(PAY).toMatch(/<div class="mount">\s*<div\s+id="payment-element"/);
	// `hidden` holds against any `display` the box's own rule may gain later.
	expect(PAY).toMatch(/\.mount\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test("with scripting off, the form is not drawn above the notice (#556)", () => {
	// No script, no Stripe: the form would be an empty bordered box and a dead
	// Pay button over the `<noscript>` notice. The browser says scripting is off;
	// the form goes. Source order is what lets it beat the form's `display: flex`.
	const base = PAY.search(/#payment-form\s*\{\s*display:\s*flex;/);
	const off = PAY.search(
		/@media \(scripting: none\)\s*\{\s*#payment-form\s*\{\s*display:\s*none;\s*\}\s*\}/,
	);
	expect(base).toBeGreaterThan(-1);
	expect(off).toBeGreaterThan(base);
});

describe("a give-up hides the bordered mount box (#146)", () => {
	test("Stripe.js did not load", async () => {
		render();
		await settle();
		expect(errorBox().hidden).toBe(false);
		expect(errorBox().textContent).toMatch(/couldn't load our payment provider/);
		expect(submit().disabled).toBe(true);
		expect(wrapper().hidden).toBe(true);
	});

	test("Stripe() threw on the key", async () => {
		stubStripe({ constructorThrows: true });
		render();
		await settle();
		expect(errorBox().textContent).toMatch(/couldn't reach our payment provider/);
		expect(submit().disabled).toBe(true);
		expect(wrapper().hidden).toBe(true);
	});

	test("the Payment Element could not be mounted, themed or untuned", async () => {
		stubStripe({ mountThrows: true });
		render();
		await settle();
		expect(errorBox().textContent).toMatch(/offline test mode/);
		expect(submit().disabled).toBe(true);
		expect(document.getElementById("payment-element")!.textContent).toBe("");
		expect(wrapper().hidden).toBe(true);
	});
});

describe("a recoverable failure keeps the fields (#146)", () => {
	test("a mounted element shows its box", () => {
		stubStripe({});
		render();
		expect(errorBox().hidden).toBe(true);
		expect(wrapper().hidden).toBe(false);
	});

	test("a declined card: Stripe's words, Pay back, the box stays", async () => {
		stubStripe({
			confirm: async () => ({
				error: { code: "card_declined", message: "Your card was declined." },
			}),
		});
		render();
		submit().click();
		await settle();
		expect(errorBox().hidden).toBe(false);
		expect(errorBox().textContent).toBe("Your card was declined.");
		expect(submit().disabled).toBe(false);
		expect(wrapper().hidden).toBe(false);
	});

	test("a confirm that rejected: Pay back, the box stays", async () => {
		stubStripe({ confirm: () => Promise.reject(new Error("network")) });
		render();
		submit().click();
		await settle();
		expect(errorBox().textContent).toMatch(/could not be completed/);
		expect(submit().disabled).toBe(false);
		expect(wrapper().hidden).toBe(false);
	});
});
