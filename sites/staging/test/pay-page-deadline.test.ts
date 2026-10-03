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

	test("the closed notice is rendered HIDDEN, says the time has run out, and links to the order", () => {
		expect(PAY).toMatch(/<div id="payment-closed" hidden>/);
		expect(PAY).toMatch(/\{PAY_CLOSED_LEAD\}/);
		expect(PAY_CLOSED_LEAD).toBe("The time to pay has run out.");
		const closed = PAY.slice(PAY.indexOf('<div id="payment-closed"'));
		expect(closed.slice(0, closed.indexOf("</div>"))).toMatch(/href=\{orderPath\}/);
	});

	test("the view's hold sentence carries the hook the script hides it by", () => {
		expect(VIEW).toMatch(/<p class="pay-hold" data-pay-hold>/);
	});
});
