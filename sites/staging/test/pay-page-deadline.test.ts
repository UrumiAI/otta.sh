/**
 * Source pins for the pay page's client-side deadline (QA2 M1c). The deciding
 * is `lib/pay-deadline.ts` (`pay-deadline.test.ts`, fake clock); this file pins
 * the WIRING, which has no render harness (issue #40): the page hands the script
 * the server's deadline and "now", renders the closed notice hidden, refuses a
 * submit before Stripe's own handler can run, and never re-enables Pay once
 * closed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PAY_CLOSED_LEAD } from "../src/lib/pay-deadline.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PAY = readFileSync(path.join(SRC, "pages/checkout/pay.astro"), "utf8");
const VIEW = readFileSync(path.join(SRC, "themes/tempered/PayView.astro"), "utf8");

/** The page's script blocks: the inline Stripe one and the bundled module. */
const scripts = [...PAY.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => ({
	attrs: m[1] ?? "",
	body: m[2] ?? "",
}));
const inline = scripts.find((s) => /is:inline/.test(s.attrs) && /confirmPayment/.test(s.body));
const bundled = scripts.find((s) => !/is:inline/.test(s.attrs) && !/\bsrc=/.test(s.attrs));

describe("the pay page closes itself at its deadline (QA2 M1c)", () => {
	test("the mount carries the hold deadline AND the server's now — the browser clock only measures elapsed time", () => {
		expect(PAY).toMatch(/data-pay-deadline=\{/);
		expect(PAY).toMatch(/data-pay-server-now=\{/);
	});

	test("a BUNDLED module script (ADR-0012's one scripted page) drives `startPayDeadline`", () => {
		expect(bundled, "a non-inline <script> on the pay page").toBeDefined();
		expect(bundled!.body).toMatch(
			/import \{[^}]*startPayDeadline[^}]*\} from "\.\.\/\.\.\/lib\/pay-deadline\.js"/,
		);
		// Wake-ups re-check: a throttled background tab's timer is not trusted.
		expect(bundled!.body).toMatch(/visibilitychange/);
		expect(bundled!.body).toMatch(/pageshow/);
	});

	test("a submit after the deadline is stopped in the CAPTURE phase on the document — before Stripe's handler can run", () => {
		expect(bundled!.body).toMatch(
			/document\.addEventListener\(\s*"submit",[\s\S]*?,\s*true,?\s*\)/,
		);
		expect(bundled!.body).toMatch(/allowSubmit\(\)/);
		expect(bundled!.body).toMatch(/stopImmediatePropagation\(\)/);
	});

	test("the inline handler refuses on its own too, and never re-enables Pay once the page has closed", () => {
		expect(inline).toBeDefined();
		const body = inline!.body;
		const guard = body.indexOf('form.dataset.payClosed === "true"');
		expect(guard, "the inline submit checks the closed flag").toBeGreaterThan(-1);
		expect(guard).toBeLessThan(body.indexOf(".confirmPayment("));
		expect(body).not.toMatch(/submit\.disabled = false;/);
	});

	test("the closed notice sits in an ALERT region present from first render; only its body is hidden — so closing is announced (WCAG 4.1.3)", () => {
		// A live region inserted or unhidden at the moment of the change is not
		// reliably announced; one already in the DOM whose content appears is.
		expect(PAY).toMatch(/<div id="payment-closed" role="alert">/);
		expect(PAY).not.toMatch(/<div id="payment-closed"[^>]*\shidden/);
		expect(PAY).toMatch(/<div id="payment-closed-body" hidden>/);
		expect(PAY).toMatch(/\{PAY_CLOSED_LEAD\}/);
		expect(PAY_CLOSED_LEAD).toBe("The time to pay has run out.");
		const closed = PAY.slice(PAY.indexOf('<div id="payment-closed-body"'));
		expect(closed.slice(0, closed.indexOf("</div>"))).toMatch(
			/<a id="payment-closed-link" href=\{orderPath\}>View your order<\/a>/,
		);
	});

	test("closing unhides the BODY and, if focus was in the payment form, moves it to the order link", () => {
		for (const [label, body] of [
			["deadline script", bundled!.body],
			["inline script", inline!.body],
		] as const) {
			expect(body, label).toMatch(/payment-closed-body/);
			expect(body, label).toMatch(/\.contains\(document\.activeElement\)/);
			expect(body, label).toMatch(/payment-closed-link/);
			expect(body, label).toMatch(/\.focus\(\)/);
		}
		expect(bundled!.body).not.toMatch(/closedNotice\.hidden = false/);
	});

	test("a Stripe refusal is read by the INTENT's status: canceled or unknown → the closed notice; succeeded or processing → the order page", () => {
		// Review round 2: `payment_intent_unexpected_state` is also what Stripe says
		// for an intent that already SUCCEEDED (paid in another tab) — leading with
		// "The time to pay has run out." there would be false.
		const body = inline!.body;
		const fn = body.slice(body.indexOf("function refusalOf("));
		const decide = fn.slice(0, fn.indexOf("\n\t\t\t\t\t\t}\n") + 8);
		expect(decide).toMatch(/status === "succeeded" \|\| status === "processing"\) return "landed"/);
		expect(decide).toMatch(/status === "canceled"\) return "withdrawn"/);
		expect(decide).toMatch(/payment_intent_unexpected_state[\s\S]*return "withdrawn"/);
		// The landed branch goes to the order page; the withdrawn one closes the page;
		// both before any `fail(...)` with Stripe's own text.
		const landed = body.indexOf('refusal === "landed"');
		const withdrawn = body.indexOf('refusal === "withdrawn"');
		expect(landed).toBeGreaterThan(-1);
		expect(withdrawn).toBeGreaterThan(-1);
		expect(body.slice(landed, withdrawn)).toMatch(/window\.location\.assign\(returnUrl\)/);
		expect(body.slice(withdrawn, withdrawn + 120)).toMatch(/closePayment\(\)/);
		expect(Math.max(landed, withdrawn)).toBeLessThan(body.indexOf("result.error.message"));
		expect(body).not.toMatch(/isWithdrawn\(/);
	});

	test("the view's hold sentence carries the hook the script hides it by", () => {
		expect(VIEW).toMatch(/<p class="pay-hold" data-pay-hold>/);
	});
});
