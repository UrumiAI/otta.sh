/**
 * The properties increment 5 (the "Tempered" checkout pages) must not lose to
 * the next restyle.
 *
 * A theme increment is exactly the kind of change that looks harmless and
 * quietly breaks something nobody screenshots. Three classes of that are pinned
 * here, in the source-text style `checkout-client-js.test.ts` established,
 * because this package has no render harness for `.astro` pages (issue #40):
 *
 *  1. THE FORM CONTRACT. `/checkout` posts to an endpoint that reads specific
 *     field NAMES, and `place.ts` rejects a partially-filled ship-to. A restyle
 *     that renames a field, drops an `autocomplete`, or loses the hidden
 *     idempotency key produces a page that still looks right and no longer
 *     works — the last one silently mints a second order on every reload.
 *  2. THE ORDER OF THE PAY PAGE'S SCRIPT. Everything after the submit binding
 *     is decoration; anything decorative that runs BEFORE it can throw on an
 *     old browser and leave "Pay now" as a native submit that navigates with no
 *     payment and no error.
 *  3. THE CONFIRMATION PAGE'S ZERO-JS PROPERTY, from the component side.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (relative: string): string => readFileSync(path.join(SRC, relative), "utf8");

const REVIEW = read("pages/checkout/index.astro");
const PAY = read("pages/checkout/pay.astro");
const ORDER = read("pages/orders/[orderId].astro");
const POLL_RIBBON = read("components/PollRibbon.astro");

describe("the /checkout form contract", () => {
	test("posts to the place endpoint, by POST", () => {
		expect(REVIEW).toMatch(/<form[^>]*method="POST"[^>]*action="\/checkout\/place"/);
	});

	test("carries the summary's idempotency key as a hidden field", () => {
		// STABLE per cart. Without it `place.ts` 400s; invented per render, a
		// reload mints a second order that the CART_CHECKED_OUT fence then
		// rejects, stranding the buyer.
		expect(REVIEW).toMatch(
			/<input[^>]*type="hidden"[^>]*name="idempotencyKey"[^>]*value=\{summary\.idempotencyKey\}/,
		);
	});

	test("the email is required, typed, and the buyerRef the service stores", () => {
		const field = /<input[\s\S]{0,220}?name="email"[\s\S]{0,220}?\/>/.exec(REVIEW)?.[0] ?? "";
		expect(field).toContain('type="email"');
		expect(field).toContain("required");
		expect(field).toContain('autocomplete="email"');
	});

	test("the email's hint is DESCRIBED, not part of the field's name", () => {
		// Nested inside the <label> its ~25 words join the accessible name and
		// are read out on every focus.
		expect(REVIEW).toMatch(/aria-describedby="email-note"/);
		expect(REVIEW).toMatch(/id="email-note"/);
	});

	/** ADR-0009's ship-to, exactly as `place.ts` reads it off the FormData. */
	const ADDRESS: ReadonlyArray<readonly [string, string]> = [
		["name", "name"],
		["line1", "address-line1"],
		["line2", "address-line2"],
		["city", "address-level2"],
		["region", "address-level1"],
		["postalCode", "postal-code"],
		["country", "country-name"],
		["phone", "tel"],
	];

	test.each(ADDRESS)("the ship-to field %s is present with autocomplete=%s", (name, complete) => {
		const field = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(REVIEW)?.[0] ?? "";
		expect(field, `${name} is missing`).not.toBe("");
		expect(field).toContain(`autocomplete="${complete}"`);
	});

	test("the address block is one answer in eight boxes, and says so", () => {
		// `place.ts` treats the five required fields as ALL-OR-NOTHING, so the
		// grouping is semantic, not decorative.
		expect(REVIEW).toContain("<fieldset");
		expect(REVIEW).toContain("<legend");
	});

	test("no payable-looking button when the store has no publishable key", () => {
		expect(REVIEW).toContain("STRIPE_PUBLISHABLE_KEY");
		expect(REVIEW).toMatch(/paymentConfigured \?/);
	});

	test("both totals-bearing panels are real headings, not styled spans", () => {
		// The eyebrow is a TREATMENT. Losing the <h2> costs screen-reader
		// heading navigation and shows up in no screenshot.
		expect(REVIEW).toMatch(/<h2 class="u-label head-label">Your details<\/h2>/);
		expect(REVIEW).toMatch(/<h2 class="u-label head-label">Your order<\/h2>/);
		expect(ORDER).toMatch(/<h2 class="u-label head-label">Items<\/h2>/);
		expect(ORDER).toMatch(/<h2 class="u-label head-label">Totals<\/h2>/);
	});
});

describe("/checkout/pay — the money path is wired before the decoration", () => {
	test("the submit binding precedes ALL theme-change wiring", () => {
		const submitBinding = PAY.indexOf('form.addEventListener("submit"');
		const media = PAY.indexOf("window.matchMedia");
		const observer = PAY.indexOf("new MutationObserver");
		expect(submitBinding).toBeGreaterThan(-1);
		expect(media).toBeGreaterThan(-1);
		expect(observer).toBeGreaterThan(-1);
		// A throw in the retheme wiring must not be able to abort the IIFE
		// before "Pay now" has a handler — that leaves a native submit that
		// navigates away with no payment and no error.
		expect(submitBinding).toBeLessThan(media);
		expect(submitBinding).toBeLessThan(observer);
	});

	test("the retheme listeners are feature-detected AND wrapped", () => {
		// Safari < 14 / iOS ≤ 13 hand back a MediaQueryList with no
		// addEventListener at all.
		expect(PAY).toContain('typeof media.addEventListener === "function"');
		expect(PAY).toContain("if (window.MutationObserver)");
	});

	test("a theming failure never declares the order unpayable", () => {
		// The appearance is built defensively and OUTSIDE the mount's try, and a
		// themed mount that throws is retried untuned before the buyer is told
		// anything at all.
		expect(PAY).toContain("function safeAppearance()");
		const safe = PAY.indexOf("var themed = safeAppearance();");
		const mount = PAY.indexOf("elements = mountElements(options);");
		expect(safe).toBeGreaterThan(-1);
		expect(safe).toBeLessThan(mount);
		expect(PAY).toContain("elements = mountElements({ clientSecret: clientSecret });");
		// …and the appearance refuses to half-build itself off an unloaded
		// token layer, which is what would make Stripe throw in the first place.
		expect(PAY).toMatch(
			/if \(!ink \|\| !surface \|\| !edge \|\| !straw \|\| !mute \|\| !bronze\) return undefined;/,
		);
	});

	test("retheme stands down mid-confirm", () => {
		const retheme = PAY.slice(PAY.indexOf("function retheme()"));
		expect(retheme.slice(0, 400)).toContain("if (submit.disabled) return;");
	});

	test("straw never becomes a fill behind text (§2)", () => {
		// Stripe paints `colorPrimary` as a ground. Straw is a fitting — it is
		// the 2px underline and the focus ring here, and nothing else.
		expect(PAY).toContain("colorPrimary: ink,");
		expect(PAY).not.toContain("colorPrimary: straw");
	});

	test("focus never erases state in the Payment Element", () => {
		expect(PAY).toContain('".Input--invalid:focus"');
		expect(PAY).toContain('".Tab--selected:focus"');
	});

	test("the appearance names faces but hands over no font FILES", () => {
		// Stripe fetches `fonts[].src` from its own origin: cross-origin, so it
		// needs CORS on /_astro/fonts/* and an HTTPS origin. Measured, the file
		// never loaded and the rendering was identical off the generic tail. If
		// this comes back, it comes back with a network trace.
		expect(PAY).not.toContain("CSSFontFaceRule");
		expect(PAY).not.toContain("options.fonts");
		expect(PAY).not.toContain("face-probe");
	});
});

describe("/orders/<id> — the state is the page, and it ships no JavaScript", () => {
	test("PollRibbon carries no script at all", () => {
		expect(POLL_RIBBON).not.toContain("<script");
	});

	test("the confirmation page uses it, and not the scripted countdown", () => {
		expect(ORDER).toContain("components/PollRibbon.astro");
		expect(ORDER).not.toContain("components/HoldRibbon.astro");
	});

	test("the step track is not drawn for an order that does not exist", () => {
		// It claims Cart → Details → Payment are behind you. On a 404 or a 503
		// that is a journey the visitor never made.
		const body = ORDER.slice(ORDER.indexOf("\n---", 3) + 4);
		const notFoundBranch = body.slice(
			body.indexOf("order === null || stamp === null ?"),
			body.indexOf("Browse products"),
		);
		expect(notFoundBranch).not.toContain("<StepTrack");
		expect(body).toContain("<StepTrack");
	});

	test("every state with nowhere to go offers the new-cart door", () => {
		// `failed` included: its cart is `checked_out`, so /checkout answers
		// CART_CHECKED_OUT and 303s to /cart. A "Back to checkout" link there is
		// a walk into an error page.
		expect(ORDER).toMatch(
			/const deadEnd =[\s\S]{0,160}?state === "expired"[\s\S]{0,80}?state === "cancelled"[\s\S]{0,80}?state === "failed"/,
		);
		expect(ORDER).not.toContain("Back to checkout");
		expect(ORDER).toContain('action="/checkout/new-cart"');
	});

	test("the receipt names what was bought, not only its SKU", () => {
		// CLAUDE.md: orders snapshot price AND title at purchase time. A receipt
		// reading `URUMI-TEE-01 1 $25.00` has lost the thing a buyer opens it to
		// check. /checkout stays SKU-only — a cart line has no title to show.
		expect(ORDER).toMatch(/title: line\.title/);
		expect(REVIEW).not.toMatch(/title: line\.title/);
	});

	test("the total reads Paid once the order settled, by MAP not comparison", () => {
		expect(ORDER).toContain('const TOTAL_LABEL: Record<string, string> = { paid: "Paid" };');
	});
});
