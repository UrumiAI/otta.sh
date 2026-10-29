/**
 * @vitest-environment happy-dom
 *
 * Issue #604: a refused payment on /checkout/pay has to be ANNOUNCED and
 * FOCUSED. `#payment-error` used to be a `<p role="alert" hidden>` that `fail()`
 * filled and unhid in one step — the pattern this page's own `#payment-closed`
 * comment calls unreliable (WCAG 4.1.3): a live region that appears with its
 * content is not reliably read. A second, identical decline wrote the same
 * string into the same node, so nothing changed and nothing was said, and
 * focus never left the Pay button.
 *
 * Now the alert region is in the DOM from first render (never `hidden`), only
 * its text is hidden; `fail()` clears the text and sets it on the next tick, so
 * every refusal is a change, and focuses the region.
 *
 * The page's inline Stripe script is run as the browser would, against the
 * page's own payment-error markup and a stubbed `Stripe` (as
 * `pay-mount-giveup.test.ts` does).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PAY_ERROR_ID } from "../src/lib/error-notice.js";

const PAY = readFileSync(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages/checkout/pay.astro"),
	"utf8",
);
const INLINE = [...PAY.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script[^>]*>/gi)]
	.map((m) => ({ attrs: m[1] ?? "", body: m[2] ?? "" }))
	.find((s) => /is:inline/.test(s.attrs) && /confirmPayment/.test(s.body))?.body;

/** The page's own error markup, from its `id={PAY_ERROR_ID}` opening tag to the
 *  region's close — Astro attribute syntax turned into the HTML it renders. */
const ERROR_MARKUP = (() => {
	const start = PAY.indexOf("<div id={PAY_ERROR_ID}");
	const end = PAY.indexOf("</div>", start) + "</div>".length;
	return PAY.slice(start, end)
		.replace("{PAY_ERROR_ID}", `"${PAY_ERROR_ID}"`)
		.replace(/\/>/g, "></p>");
})();

type ConfirmResult = {
	error?: { message?: string; code?: string; payment_intent?: { status: string } };
};

function stubStripe(confirm: () => Promise<ConfirmResult>): void {
	vi.stubGlobal("Stripe", function Stripe() {
		return {
			elements() {
				return {
					create() {
						return {
							mount(selector: string) {
								document.querySelector(selector)?.appendChild(document.createElement("iframe"));
							},
							destroy() {},
						};
					},
					update() {},
				};
			},
			confirmPayment: confirm,
		};
	});
}

function render(): void {
	document.body.innerHTML = `
		<form id="payment-form">
			<div class="mount">
				<div id="payment-element" data-client-secret="pi_1_secret_2" data-publishable-key="pk_test_x" data-return-url="/orders/o1"></div>
			</div>
			${ERROR_MARKUP}
			<div id="payment-closed" role="alert">
				<div id="payment-closed-body" hidden><a id="payment-closed-link" href="/orders/o1">View your order</a></div>
				<div id="payment-cancelled-body" hidden><a id="payment-cancelled-link" href="/orders/o1">View your order</a></div>
			</div>
			<button id="payment-submit" type="submit">Pay</button>
		</form>
		<button id="outside" type="button">Elsewhere</button>`;
	new Function(INLINE ?? "")();
}

const region = (): HTMLElement => document.getElementById(PAY_ERROR_ID)!;
const text = (): HTMLElement => document.getElementById("payment-error-text")!;
const submit = (): HTMLButtonElement =>
	document.getElementById("payment-submit") as HTMLButtonElement;
const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("the payment error is a permanent alert region (#604)", () => {
	test("the region is rendered with role=alert and tabindex=-1, never hidden; only its text is", () => {
		const open = /<div id=\{PAY_ERROR_ID\}[^>]*>/.exec(PAY)?.[0] ?? "";
		expect(open).toContain('role="alert"');
		expect(open).toContain('tabindex="-1"');
		expect(open).not.toMatch(/\shidden/);
		expect(ERROR_MARKUP).toMatch(/<p id="payment-error-text"[^>]*\shidden/);
		// The script reads the region by the same id the markup renders.
		expect(INLINE).toContain(`getElementById("${PAY_ERROR_ID}")`);
	});
});

const declined = async (): Promise<ConfirmResult> => ({
	error: { code: "card_declined", message: "Your card was declined." },
});

describe("a declined card is announced, every time, and focused (#604)", () => {
	test("fail() clears the text, then sets it on the next tick, and moves focus to the region", async () => {
		stubStripe(declined);
		render();
		submit().focus();
		const seen: string[] = [];
		new MutationObserver(() => seen.push(text().textContent ?? "")).observe(text(), {
			childList: true,
			characterData: true,
			subtree: true,
		});

		submit().click();
		await settle();

		expect(region().hidden).toBe(false);
		expect(text().hidden).toBe(false);
		expect(text().textContent).toBe("Your card was declined.");
		expect(document.activeElement).toBe(region());
		expect(submit().disabled).toBe(false);

		// The SAME decline again: the text goes away and comes back — a change
		// the alert region announces — instead of being written over itself.
		seen.length = 0;
		submit().click();
		await settle();
		expect(seen).toContain("");
		expect(seen.at(-1)).toBe("Your card was declined.");
		expect(seen.indexOf("")).toBeLessThan(seen.lastIndexOf("Your card was declined."));
		expect(document.activeElement).toBe(region());
	});

	test("a give-up at load is said in the region, but takes no focus (it is announced, not jumped to)", async () => {
		// No Stripe at all: Stripe.js did not load.
		render();
		await settle();
		expect(text().hidden).toBe(false);
		expect(text().textContent).toMatch(/couldn't load our payment provider/);
		expect(region().hidden).toBe(false);
		expect(document.activeElement).not.toBe(region());
	});
});

/** Let promise callbacks run, but NOT timers: still inside the decline's macrotask. */
const microtasks = async (): Promise<void> => {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A `confirmPayment` answering each call from `answers` in turn; the rest never settle. */
function answering(...answers: Array<() => ConfirmResult>): () => Promise<ConfirmResult> {
	let call = 0;
	return () => {
		const answer = answers[call];
		call += 1;
		return answer === undefined ? new Promise<ConfirmResult>(() => {}) : Promise.resolve(answer());
	};
}

const DECLINE: ConfirmResult = {
	error: { code: "card_declined", message: "Your card was declined." },
};

const form = (): HTMLFormElement => document.getElementById("payment-form") as HTMLFormElement;
const outside = (): HTMLElement => document.getElementById("outside")!;

describe("a pending refusal never outlives what came after it (#604)", () => {
	test("a new attempt before the text appears: the stale text stays hidden, focus does not move", async () => {
		stubStripe(answering(() => DECLINE));
		render();
		submit().click();
		await microtasks();
		// Pay again, in the same macrotask, before the decline's text is shown.
		form().requestSubmit();
		await settle();
		expect(text().hidden).toBe(true);
		expect(document.activeElement).not.toBe(region());
	});

	test("the page closed by its deadline before the text appears: hidden, and focus stays on the closed notice", async () => {
		stubStripe(answering(() => DECLINE));
		render();
		submit().focus();
		submit().click();
		await microtasks();
		// What the deadline module's close() does (pay.astro's bundled script):
		// mark the form closed, show the closed notice, focus its link.
		form().dataset.payClosed = "true";
		document.getElementById("payment-closed-body")!.hidden = false;
		const link = document.getElementById("payment-closed-link")!;
		link.focus();
		await settle();
		expect(text().hidden).toBe(true);
		expect(document.activeElement).toBe(link);
	});

	test("an intent withdrawn on the next attempt (the inline close): hidden, focus on its link", async () => {
		stubStripe(
			answering(
				() => DECLINE,
				() => ({
					error: {
						code: "payment_intent_unexpected_state",
						payment_intent: { status: "canceled" },
					} as ConfirmResult["error"],
				}),
			),
		);
		render();
		submit().click();
		await microtasks();
		submit().focus();
		form().requestSubmit();
		await settle();
		expect(text().hidden).toBe(true);
		expect(document.activeElement).not.toBe(region());
		expect(document.getElementById("payment-closed-body")!.hidden).toBe(false);
	});

	test("focus the buyer moved outside the form stays there", async () => {
		stubStripe(async () => {
			outside().focus();
			return DECLINE;
		});
		render();
		submit().click();
		await settle();
		expect(text().textContent).toBe("Your card was declined.");
		expect(document.activeElement).toBe(outside());
	});
});
