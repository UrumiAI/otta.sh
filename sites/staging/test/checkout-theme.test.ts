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
 *     old browser and leave the pay button as a native submit that navigates
 *     with no payment and no error.
 *  3. THE CONFIRMATION PAGE'S ZERO-JS PROPERTY, from the component side.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { hasExecutableScript, splitAstro, templateOf } from "./astro-source.js";
import { viewCases, viewSources } from "./theme-views.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (relative: string): string => readFileSync(path.join(SRC, relative), "utf8");

const REVIEW = read("pages/checkout/index.astro");

/** What the buyer reads of a template slice: JS comments inside expressions
 *  removed (`templateOf` strips markup comments only) and whitespace folded, so
 *  copy wrapped across lines still matches. */
function shown(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}
const PAY = read("pages/checkout/pay.astro");
const ORDER = read("pages/orders/[orderId].astro");
const CART = read("pages/cart/index.astro");
const POLL_RIBBON = read("components/PollRibbon.astro");

/**
 * Since Phase 3 the review's and the confirmation's MARKUP is a theme view —
 * each theme's own, or Tempered's when it has not ported one (see
 * `theme-views.ts`). `REVIEW` and `ORDER` stay the PAGES, which keep every
 * decision; the markup pins below sweep every theme's view with the assertions
 * they always had.
 */
const REVIEW_VIEWS = viewCases("checkout");
const ORDER_VIEWS = viewCases("order");

describe.each(REVIEW_VIEWS)("the /checkout form contract — %s", (_label, { source: VIEW }) => {
	test("posts to the place endpoint, by POST", () => {
		expect(VIEW).toMatch(/<form[^>]*method="POST"[^>]*action="\/checkout\/place"/);
	});

	test("carries the summary's idempotency key as a hidden field", () => {
		// STABLE per cart. Without it `place.ts` 400s; invented per render, a
		// reload mints a second order that the CART_CHECKED_OUT fence then
		// rejects, stranding the buyer.
		expect(VIEW).toMatch(
			/<input[^>]*type="hidden"[^>]*name="idempotencyKey"[^>]*value=\{summary\.idempotencyKey\}/,
		);
	});

	test("the email is required, typed, and the buyerRef the service stores", () => {
		const field = /<input[\s\S]{0,400}?name="email"[\s\S]{0,400}?\/>/.exec(VIEW)?.[0] ?? "";
		expect(field).toContain('type="email"');
		expect(field).toContain("required");
		expect(field).toContain('autocomplete="email"');
	});

	test("the email's hint is DESCRIBED, not part of the field's name", () => {
		// Nested inside the <label> its ~25 words join the accessible name and
		// are read out on every focus.
		// With a refused email (QA U-1) its error is described first, then the note.
		expect(VIEW).toMatch(
			/aria-describedby=\{fieldErrors\.email !== undefined \? "email-error email-note" : "email-note"\}/,
		);
		expect(VIEW).toMatch(/id="email-note"/);
	});

	/** ADR-0009's ship-to, exactly as `place.ts` reads it off the FormData. The
	 *  country is a SELECT of ISO codes (ADR-0021), asserted below. */
	const ADDRESS: ReadonlyArray<readonly [string, string]> = [
		["name", "name"],
		["line1", "address-line1"],
		["line2", "address-line2"],
		["city", "address-level2"],
		["region", "address-level1"],
		["postalCode", "postal-code"],
		["phone", "tel"],
	];

	test.each(ADDRESS)("the ship-to field %s is present with autocomplete=%s", (name, complete) => {
		// The typed field, not a hidden echo of the priced destination.
		const field =
			[...VIEW.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))]
				.map((m) => m[0])
				.find((tag) => !tag.includes('type="hidden"')) ?? "";
		expect(field, `${name} is missing`).not.toBe("");
		expect(field).toContain(`autocomplete="${complete}"`);
	});

	/** The typed ship-to fields that carry a domain length bound, and the key of
	 *  `ORDER_ADDRESS_MAX_LENGTHS` each one reads. The region too (QA U-14): its
	 *  old code-shaped maxlength of 6 silently cut "Illinois" to "Illino"; the
	 *  code SHAPE is the pattern's job, asserted below, never a truncation's. */
	const BOUNDED: ReadonlyArray<string> = [
		"name",
		"line1",
		"line2",
		"city",
		"region",
		"postalCode",
		"phone",
	];

	test("every region input says what it wants instead of cutting the text short (QA U-14)", () => {
		// Either name: fix/checkout-resume-and-values renames the delivery form's
		// region input `deliveryRegion`; the rule holds for both inputs either way.
		const regions = [...VIEW.matchAll(/<input[^>]*name="(?:region|deliveryRegion)"[^>]*>/g)]
			.map((m) => m[0])
			.filter((tag) => !tag.includes('type="hidden"'));
		expect(regions).toHaveLength(2);
		for (const region of regions) {
			expect(region).not.toMatch(/maxlength="\d+"/);
			expect(region).toContain("maxlength={ORDER_ADDRESS_MAX_LENGTHS.region}");
			// A name ("Illinois") is refused at the field by the pattern, and the
			// browser's message quotes the title — which names the code to type. The
			// pattern IS the domain's shape rule (QA2 N6), not a copy that can drift.
			expect(region).toContain("pattern={REGION_CODE_PATTERN}");
			expect(region).toMatch(/title="[^"]*code[^"]*IL[^"]*"/);
			expect(region).toContain('autocapitalize="characters"');
			expect(region).toContain('spellcheck="false"');
		}
	});

	test.each(BOUNDED)(
		"the ship-to field %s is bounded by the domain's own limit — maxlength from ORDER_ADDRESS_MAX_LENGTHS",
		(name) => {
			// QA U-6: an over-long field used to submit, fail the plugin's bound and
			// come back as the generic INVALID_INPUT. The browser now stops it at the
			// field, with the very number the domain enforces.
			const field =
				[...VIEW.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))]
					.map((m) => m[0])
					.find((tag) => !tag.includes('type="hidden"')) ?? "";
			expect(field).toContain(`maxlength={ORDER_ADDRESS_MAX_LENGTHS.${name}}`);
		},
	);

	test("the email is bounded by the place route's own buyerRef limit (BUYER_REF_MAX)", () => {
		const field = /<input[\s\S]{0,400}?name="email"[\s\S]{0,400}?\/>/.exec(VIEW)?.[0] ?? "";
		expect(field).toContain("maxlength={BUYER_REF_MAX}");
	});

	test("the country is a SELECT of ISO codes with an empty placeholder — never free text (ADR-0021)", () => {
		expect(VIEW).not.toMatch(/<input[^>]*name="country"[^>]*autocomplete="country-name"/);
		const selects = [...VIEW.matchAll(/<select[^>]*name="country"[^>]*>[\s\S]*?<\/select>/g)].map(
			(m) => m[0],
		);
		expect(selects.length, "no country select").toBeGreaterThan(0);
		for (const select of selects) {
			expect(select).toContain('autocomplete="country"');
			expect(select).toMatch(/<option value="">/);
			expect(select).toMatch(/value=\{option\.code\}/);
		}
	});

	test("issue #382: the address block says WHY it is required when the payment account needs it", () => {
		const text = shown(VIEW);
		expect(VIEW).toMatch(/summary\.paymentAccountNeedsAddress/);
		expect(text).toContain("Stripe accounts in India need the buyer's name and address");
		// A cart that ships nothing is not "delivered": the block is the buyer's address.
		expect(text).toMatch(/summary\.requiresShipping \? "Delivery address" : "Billing address"/);
		// The country select is marked required like the typed fields.
		expect(VIEW).toMatch(
			/Country\{summary\.addressRequired && <span class="checkout-req">required<\/span>\}/,
		);
	});

	test("the address block is one answer in eight boxes, and says so", () => {
		// `place.ts` treats the five required fields as ALL-OR-NOTHING, so the
		// grouping is semantic, not decorative.
		expect(VIEW).toContain("<fieldset");
		expect(VIEW).toContain("<legend");
	});

	test("no payable-looking button when the store has no publishable key", () => {
		expect(VIEW).toMatch(/paymentConfigured \?/);
	});

	test("both totals-bearing panels are real headings, not styled spans", () => {
		// The eyebrow is a TREATMENT. Losing the <h2> costs screen-reader
		// heading navigation and shows up in no screenshot.
		expect(VIEW).toMatch(/<h2 class="u-label [\w-]*head-label">Your details<\/h2>/);
		expect(VIEW).toMatch(/<h2 class="u-label [\w-]*head-label">Your order<\/h2>/);
	});
});

describe("the /checkout page keeps the decisions the review prints", () => {
	test("no payable-looking button when the store has no publishable key", () => {
		expect(REVIEW).toContain("STRIPE_PUBLISHABLE_KEY");
		expect(REVIEW).toContain("paymentConfigured");
	});

	test("the order ledger names each line — the last summary before paying is not a list of SKUs", () => {
		// QA: "Your order" read `OTTA-STICKERS 1 $6.00`. The summary's line now
		// carries the title the order will snapshot; the row hands it to the
		// Ledger, which leads with it and keeps the SKU beneath as the reference.
		const rows = splitAstro(REVIEW).frontmatter.match(/const ledgerRows = [\s\S]*?\n\}\)\);/)?.[0];
		expect(rows).toBeDefined();
		expect(rows).toMatch(/line\.title/);
		expect(rows).toMatch(/sku: line\.sku/);
	});
});

describe.each(ORDER_VIEWS)("the confirmation's panels — %s", (_label, { source: VIEW }) => {
	test("both totals-bearing panels are real headings, not styled spans", () => {
		expect(VIEW).toMatch(/<h2 class="u-label [\w-]*head-label">Items<\/h2>/);
		expect(VIEW).toMatch(/<h2 class="u-label [\w-]*head-label">Totals<\/h2>/);
	});
});

/**
 * #305 part 1 — the coupon on the review page. The form is a zero-JS
 * `GET /checkout?coupon=` (decision D2), a SIBLING of the place form: nested, its
 * submit would post the place form's fields instead.
 */
describe.each(REVIEW_VIEWS)("/checkout — the coupon — %s", (_label, { source: VIEW }) => {
	const TEMPLATE = templateOf(VIEW);
	/* QA U-1: the coupon is no longer its own GET form — applying it that way
	   dropped everything typed below. Its field and buttons belong to the place
	   form (`form="checkout-place"`), which posts the typed details with them. */
	const COUPON =
		/<div class="checkout-coupon">[\s\S]*?<span class="checkout-note" id="coupon-note">/.exec(
			TEMPLATE,
		)?.[0] ?? "";

	test("the coupon field is name=coupon maxlength=200, owned by the place form", () => {
		expect(COUPON, "no coupon block").not.toBe("");
		const field = /<input[^>]*name="coupon"[^>]*>/.exec(COUPON)?.[0] ?? "";
		expect(field).toContain('maxlength="200"');
		expect(field).toContain('autocomplete="off"');
		expect(field).toContain('form="checkout-place"');
	});

	test("the coupon block sits before the place form and is not nested in it", () => {
		const place =
			/<form[^>]*action="\/checkout\/place"[^>]*>[\s\S]*?<\/form>/.exec(TEMPLATE)?.[0] ?? "";
		expect(place).not.toBe("");
		expect(place).not.toContain('name="coupon"');
		expect(TEMPLATE.indexOf(COUPON)).toBeLessThan(TEMPLATE.indexOf(place));
	});

	test("the place form carries a hidden couponCode bound to summary.selection.couponCode", () => {
		expect(VIEW).toMatch(
			/<input[^>]*type="hidden"[^>]*name="couponCode"[^>]*value=\{summary\.selection\.couponCode\}/,
		);
	});

	test("the coupon block is hidden once the cart has become an order", () => {
		expect(VIEW).toMatch(/!summary\.orderCreated && \(\s*<div class="checkout-coupon">/);
	});

	test("an ENDED checkout offers no pay button — only the way to a new cart", () => {
		expect(VIEW).toMatch(/!ended && \(\s*<form[^>]*action="\/checkout\/place"/);
	});

	test("the LOCKED review hides the delivery-address block — the order's ship-to is fixed", () => {
		// The same-key place replays the existing order and re-prices nothing, so an
		// address typed here would be silently dropped. The email stays: place.ts
		// requires it. A digital-only cart has no address block either.
		expect(VIEW).toMatch(/showAddress && \(\s*<fieldset\b/);
		expect(VIEW).not.toMatch(
			/locked === null && \(\s*<div class="[\w-]*field">\s*<label class="u-label" for="email">/,
		);
	});

	test("the lock notice says the email, the coupon AND the delivery address can no longer be changed", () => {
		// QA U-2 added the email: the locked review no longer offers an email field.
		expect(VIEW).toMatch(
			/Its email, coupon and delivery address can no longer be changed\.\s+To change them, start a\s+new cart/,
		);
	});

	test("QA2 X4: the lock notice says starting a new cart CANCELS this order — the button does that now", () => {
		expect(VIEW).toMatch(
			/start a\s+new cart\s+—\s+that cancels this order, and any payment for it that arrives\s+afterwards will be refunded\./,
		);
	});

	// Inverts PR 1's "the shipping-method notice is kept, though unreachable until
	// #305 part 2": the delivery form now sends a method, so the summary can refuse
	// one — and the notice lives IN that form, beside the choice it explains.
	test("the shipping-method notice is live, inside the delivery form", () => {
		expect(VIEW).not.toMatch(/unreachable until #305 part 2/);
		const delivery =
			/<div class="checkout-delivery" id="delivery">[\s\S]*?<\/fieldset>/.exec(
				templateOf(VIEW),
			)?.[0] ?? "";
		expect(delivery, "no delivery block").not.toBe("");
		expect(delivery).toContain("shippingError !== null");
	});

	/**
	 * `ended` means NO LONGER PAYABLE, not "never charged": a declined attempt
	 * flips the order to `failed` while the same PaymentIntent stays confirmable,
	 * and a payment can land just after the TTL sweep expired the order. The
	 * public order carries no reconciliation flag, so this page cannot know —
	 * and must make no claim about money either way.
	 */
	test("the ENDED notice makes NO claim about a charge, and links to the order", () => {
		const notice =
			/<Notice lead="This checkout has ended\.">[\s\S]*?<\/Notice>/.exec(templateOf(VIEW))?.[0] ??
			"";
		expect(notice, "no ended notice").not.toBe("");
		expect(notice).not.toMatch(/charged|no charge/i);
		// A charge on a failed/expired order goes to manual reconciliation, where
		// the merchant may refund it OR complete the order — so the page promises
		// neither; it tells the buyer who to contact and with what. "With what"
		// is the EMAIL they ordered with — not an order number: the shopper is
		// never shown the order id (it is a UUID that names nothing they bought),
		// so a sentence asking them to quote one would send them looking for a
		// thing no page gives them.
		const text = notice.replace(/\s+/g, " ");
		expect(text).not.toMatch(/the store will refund/i);
		expect(text).toMatch(/contact the store with the email address you ordered with/i);
		expect(text).not.toMatch(/order number|order id|reference/i);
		expect(text).toMatch(/refund it or complete your order/i);
		expect(notice).toContain("href={`/orders/${encodeURIComponent(locked.id)}`}");
	});

	/**
	 * A LOCKED review with no publishable key: an order exists and the cart is
	 * checked out, so the unlocked copy ("Nothing has been charged and your cart is
	 * unchanged") would be wrong on both counts there.
	 */
	test("locked + payment not configured renders the LOCKED variant, with no money or cart claim", () => {
		// QA U-2: the locked review is its own block (no place form, no email
		// field); its not-configured notice lives there, and the place form's
		// unlocked notice is unchanged.
		const template = templateOf(VIEW);
		const lockedStart = template.indexOf("locked !== null && !ended && (");
		const placeStart = template.search(
			/locked === null && !ended && \(\s*<form method="POST" action="\/checkout\/place"/,
		);
		expect(lockedStart, "no locked block").toBeGreaterThan(-1);
		expect(placeStart, "no unlocked place form").toBeGreaterThan(lockedStart);
		const lockedVariant = shown(template.slice(lockedStart, placeStart));
		expect(lockedVariant).toContain(
			"Card payment isn't set up on this store, so this order can't be paid right now.",
		);
		expect(lockedVariant).not.toMatch(/charged|cart is unchanged/i);
		expect(lockedVariant).not.toMatch(/name="email"/);
		const unlockedVariant = shown(template.slice(placeStart));
		expect(unlockedVariant).toContain(
			"This order can't be placed. Nothing has been charged and your cart is unchanged.",
		);
	});
});
describe("/checkout — the coupon: the page's half", () => {
	test("the page passes the coupon into the summary dispatch", () => {
		expect(REVIEW).toContain("readCouponParam(Astro.url)");
		expect(REVIEW).toMatch(
			/\{\s*cartId,\s*locale: SITE_LOCALE,\s*\.\.\.\(coupon\.couponCode !== undefined/,
		);
	});

	test("the coupon in the URL never leaks through a Referer to another host", () => {
		// `same-origin`, NOT `no-referrer`: under `no-referrer` a browser sends
		// `Origin: null` on the page's own POST to /checkout/place, the origin
		// guard 403s it, and no order can be placed (pinned in a real browser by
		// e2e/checkout-place.spec.ts). The meta stays on the PAGE, not the view.
		expect(REVIEW).toContain('<meta name="referrer" content="same-origin" slot="head" />');
		expect(REVIEW).not.toContain('content="no-referrer"');
	});

	test("the policy is also a response HEADER, not only the meta", () => {
		// The meta arrives through `<slot name="head">`, after the layout's font
		// preloads; a fetch the parser starts before it would not see the meta.
		expect(splitAstro(REVIEW).frontmatter).toContain(
			'Astro.response.headers.set("Referrer-Policy", "same-origin");',
		);
	});

	test("an ENDED checkout is decided from the locked order's phase", () => {
		expect(REVIEW).toContain('phase === "ended"');
	});

	test("the LOCKED review's address block is decided here — the order's ship-to is fixed", () => {
		expect(REVIEW).toContain(
			"const showAddress = locked === null && (summary.requiresShipping || summary.addressRequired);",
		);
	});

	test("issue #382: a cart that ships nothing still gets the address block when the address is required", () => {
		// An India-based Stripe account needs every buyer's name and address
		// (`paymentAccountNeedsAddress` ⇒ `addressRequired`), digital carts too.
		expect(REVIEW).toMatch(/summary\.requiresShipping \|\| summary\.addressRequired/);
	});

	test("issue #382: an address refused for the payment account's sake is explained as that, not as delivery", () => {
		expect(REVIEW).toContain('"BUYER_ADDRESS_REQUIRED"');
		expect(REVIEW).toMatch(/summary\.paymentAccountNeedsAddress/);
	});

	test("the retired 'unreachable' note stays retired on the page too", () => {
		expect(REVIEW).not.toMatch(/unreachable until #305 part 2/);
	});
});

/**
 * #305 part 2 (ADR-0021) — the delivery form. The zone is derived from where the
 * order goes, so the review asks for that FIRST, by a zero-JS
 * `GET /checkout?country=&region=&method=` (only coarse codes and an opaque id in
 * the URL), and offers the matched zone's options as radios.
 */
describe.each(REVIEW_VIEWS)("/checkout — delivery (ADR-0021) — %s", (_label, { source: VIEW }) => {
	const TEMPLATE = templateOf(VIEW);
	/* QA U-1: the delivery choice is no longer its own GET form — choosing it
	   that way dropped everything typed. Its fields and its Update button belong
	   to the place form (`form="checkout-place"`), under names of their own so
	   they never collide with the place form's priced echo. */
	const DELIVERY =
		/<div class="checkout-delivery" id="delivery">[\s\S]*?<\/fieldset>\s*<\/div>/.exec(
			TEMPLATE,
		)?.[0] ?? "";
	const PLACE =
		/<form[^>]*action="\/checkout\/place"[^>]*>[\s\S]*?<\/form>/.exec(TEMPLATE)?.[0] ?? "";

	test("the delivery block comes after the coupon and before the place form — never nested, never a GET form", () => {
		expect(DELIVERY, "no delivery block").not.toBe("");
		const coupon = TEMPLATE.indexOf('name="coupon"');
		expect(coupon).toBeLessThan(TEMPLATE.indexOf(DELIVERY));
		expect(TEMPLATE.indexOf(DELIVERY)).toBeLessThan(TEMPLATE.indexOf(PLACE));
		expect(PLACE).not.toContain('id="delivery"');
		expect(TEMPLATE).not.toMatch(/<form[^>]*method="GET"[^>]*id="delivery"/);
	});

	test("it is shown only for an unlocked cart that ships, in a store with zones", () => {
		expect(VIEW).toMatch(/showDelivery && \(\s*<div class="checkout-delivery" id="delivery">/);
	});

	test("it asks for a country (select) and a region CODE, echoes the priced destination as fromCountry/fromRegion — all owned by the place form", () => {
		const select = /<select[^>]*name="deliveryCountry"[^>]*>/.exec(DELIVERY)?.[0] ?? "";
		expect(select).toContain('form="checkout-place"');
		const region = /<input[^>]*name="deliveryRegion"[^>]*>/.exec(DELIVERY)?.[0] ?? "";
		expect(region).toContain("maxlength={ORDER_ADDRESS_MAX_LENGTHS.region}");
		expect(region).toContain("pattern={REGION_CODE_PATTERN}");
		expect(region).toContain('form="checkout-place"');
		expect(DELIVERY).toMatch(/State\/province code/);
		expect(DELIVERY).toMatch(
			/<input[^>]*type="hidden"[^>]*name="fromCountry"[^>]*form="checkout-place"/,
		);
		expect(DELIVERY).toMatch(
			/<input[^>]*type="hidden"[^>]*name="fromRegion"[^>]*form="checkout-place"/,
		);
		expect(DELIVERY).toMatch(
			/<button[^>]*form="checkout-place"[^>]*name="intent"[^>]*value="update-delivery"[^>]*formnovalidate/,
		);
		expect(DELIVERY).toContain("Update delivery");
	});

	test("the matched zone's options are method radios — unpriced ones disabled, the selected one checked", () => {
		const radio =
			/<input[^>]*type="radio"[^>]*name="deliveryMethod"[^>]*>/.exec(DELIVERY)?.[0] ?? "";
		expect(radio, "no method radio").not.toBe("");
		expect(radio).toContain("value={option.id}");
		expect(radio).toContain("disabled={option.disabled}");
		expect(radio).toContain("checked={option.selected}");
		expect(radio).toContain('form="checkout-place"');
	});

	test("its notices come from the destination and method refusals and from noOptions", () => {
		expect(DELIVERY).toContain("destinationError !== null");
		expect(DELIVERY).toContain("shippingError !== null");
		expect(DELIVERY).toContain("summary.shipping.noOptions");
	});

	test("applying a coupon keeps the delivery selection: Apply posts the place form, which carries it", () => {
		// QA U-1: Apply is a submit of the place form, whose hidden fields carry the
		// priced destination and method; place.ts puts them back on the URL.
		expect(TEMPLATE).toMatch(/<button[^>]*form="checkout-place"[^>]*value="apply-coupon"/);
		expect(PLACE).toMatch(/<input[^>]*type="hidden"[^>]*name="country"/);
		expect(PLACE).toMatch(/<input[^>]*type="hidden"[^>]*name="shippingMethodId"/);
	});

	test("the place form echoes the priced METHOD and DESTINATION as hidden fields — never on the locked page", () => {
		// The place form itself is unlocked-only (QA U-2), so the echo inside it is too.
		expect(VIEW).toMatch(
			/locked === null && !ended && \(\s*<form method="POST" action="\/checkout\/place"/,
		);
		expect(PLACE).toMatch(
			/summary\.selection\.shippingMethodId !== null && \(\s*<input[^>]*type="hidden"[^>]*name="shippingMethodId"[^>]*value=\{summary\.selection\.shippingMethodId\}/,
		);
		expect(PLACE).toMatch(/<input[^>]*type="hidden"[^>]*name="addressMode"[^>]*value="zoned"/);
		expect(PLACE).toMatch(
			/<input[^>]*type="hidden"[^>]*name="country"[^>]*value=\{destination\.country\}/,
		);
		expect(PLACE).toMatch(/<input[^>]*type="hidden"[^>]*name="region"/);
	});

	test("the place form states the method being charged, beside the submit", () => {
		expect(PLACE).toMatch(/Delivery: \{chosenOption\.label\} \(\{chosenOption\.price\}\)/);
	});

	test("the submit is gated on readyToPlace — the plugin's one answer, locked or not", () => {
		const gate = PLACE.indexOf("summary.readyToPlace ?");
		const button = PLACE.indexOf("Continue to payment");
		expect(gate, "no readyToPlace gate").toBeGreaterThan(-1);
		expect(gate).toBeLessThan(button);
		expect(PLACE).toContain("<Notice>{notReadyCopy}</Notice>");
	});

	test("a LOCKED review shows no delivery form, no radios, no address block — and still the pay button when readyToPlace", () => {
		// showDelivery / showAddress both require `locked === null` (above); the
		// submit's gate is readyToPlace, which the plugin sets from phase === payable.
		expect(VIEW).not.toMatch(/locked !== null && \(\s*<form[^>]*id="delivery"/);
		expect(VIEW).toMatch(/start a\s+new cart/);
		// QA U-2: the locked review's pay button is the resume LINK.
		expect(VIEW).toMatch(
			/summary\.readyToPlace && \(\s*<div>\s*<a class="u-btn" href=\{locked\.resumeHref\}>/,
		);
	});
});
describe("/checkout — delivery (ADR-0021): the page's half", () => {
	test("the delivery form is shown only for an unlocked cart that ships, in a store with zones", () => {
		expect(REVIEW).toContain(
			'const showDelivery = locked === null && summary.requiresShipping && summary.shipping.status !== "no_zones";',
		);
	});

	test("the not-ready copy is the page's", () => {
		expect(REVIEW).toContain("Choose where we're delivering above to continue.");
	});

	test("the page prices the destination and the method it read off its own URL", () => {
		expect(REVIEW).toContain("readDestinationParams(Astro.url)");
		expect(REVIEW).toContain("readMethodParam(Astro.url)");
		expect(REVIEW).toMatch(/destinationRead\.methodDropped \? undefined/);
	});
	// Country names and money must read in the SAME language: one site locale,
	// passed to the summary (which formats the money) and to the country labels.
	test("the country labels use the site locale the summary formats money in — never a hard-coded one", () => {
		expect(REVIEW).toContain("countryOptions(SITE_LOCALE)");
		expect(REVIEW).not.toMatch(/countryOptions\("[a-z]/);
		expect(REVIEW).toMatch(/cartId,\s*locale: SITE_LOCALE,/);
	});
	test("the totals footnote says WHY the total is incomplete (uncalculatedReason)", () => {
		expect(REVIEW).toMatch(/checkoutFootnote\(\s*summary\.uncalculatedReason/);
	});
});

describe("/checkout/pay — the money path is wired before the decoration", () => {
	/** The line the script draws between "this takes payment" and "this makes it
	 *  look right". Everything below it is expendable; nothing below it may run
	 *  first. */
	const DECORATION_BANNER = "── decoration only, from here down ──";

	test("EVERYTHING below the decoration banner follows the submit binding", () => {
		// Anchored to the banner rather than to two API names on purpose: the
		// hazard is not `matchMedia` specifically, it is any decorative call
		// that can throw on an old browser before the pay button has a handler — at
		// which point the button is a native submit that navigates away with no
		// payment and no error. Naming the APIs pins today's two; naming the
		// banner pins the rule.
		const banner = PAY.indexOf(DECORATION_BANNER);
		const submitBinding = PAY.indexOf('form.addEventListener("submit"');
		expect(
			banner,
			"the decoration banner is gone — restore it or restate the rule",
		).toBeGreaterThan(-1);
		expect(submitBinding).toBeGreaterThan(-1);
		expect(submitBinding).toBeLessThan(banner);
	});

	test("and the theme-change wiring really is down there", () => {
		// The banner is only worth anchoring to if the decoration is behind it.
		const banner = PAY.indexOf(DECORATION_BANNER);
		for (const call of ["window.matchMedia", "new MutationObserver", "function retheme()"]) {
			expect(PAY.indexOf(call), `${call} is above the banner`).toBeGreaterThan(banner);
		}
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

/**
 * §7's pay button, and the pieces that have to line up for it to be honest.
 *
 * The page has no render harness (issue #40), so the split is the same one
 * `checkout-place.test.ts` uses for the entry guard: the DECISION lives in a
 * pure module and is unit-tested there (`totals.test.ts` — the amount, the
 * "Pay now" fallback, the substance rule), and what is asserted here is that the
 * page actually calls it and feeds it the right thing.
 */
describe("/checkout/pay — the button states the amount (§7)", () => {
	/** The button element, comments already stripped by `templateOf`. */
	const BUTTON = /<button id="payment-submit"[\s\S]*?<\/button>/.exec(templateOf(PAY))?.[0] ?? "";

	test("the label is an expression, not a literal — and the literal is GONE", () => {
		// "Pay now" was a disclosed §7 deviation while the pay page had no amount
		// on it. It now has one, so the hardcoded label must not survive: a
		// template that still printed it would look right and quietly ignore the
		// stash.
		expect(BUTTON, "the pay button is gone or was renamed").not.toBe("");
		expect(BUTTON).toContain("{payLabel}");
		expect(BUTTON).not.toContain("Pay now");
	});

	test("the label rule is IMPORTED, never re-implemented in the template", () => {
		// A page that built `"Pay " + amount` itself would be this theme's first
		// hand-assembled money string (§7 forbids exactly that) and would lose the
		// empty/dash guard with it.
		const { frontmatter, body } = splitAstro(PAY);
		expect(frontmatter).toContain("payButtonLabel");
		expect(frontmatter).toContain("lib/totals.js");
		expect(body).not.toMatch(/["'`]Pay \$/);
	});

	test("the amount comes from the STASH, not from a commerce read on this page", () => {
		// Which is the whole reason it is captured at place-time: the cart stays
		// live and mutable, the charge does not.
		const { frontmatter } = splitAstro(PAY);
		expect(frontmatter).toContain("stash.total?.formatted");
		expect(frontmatter).toContain("payButtonLabel(stash.total?.formatted)");
	});

	test("the ONE commerce call is the order-state READ that guards the form — nothing it returns reaches the button", () => {
		// The page used to make no commerce call at all, and that is how an
		// EXPIRED order got paid: the stash outlives the hold. It now reads the
		// order's own state (the confirmation page's public route) and redirects
		// away from a form for anything not payable (ADR-0012, amended 2026-10-02).
		// The read is a guard only: exactly one dispatch, to the order route, its
		// result fed to `payPageRedirect` and nowhere else.
		const { frontmatter } = splitAstro(PAY);
		expect(frontmatter.match(/dispatchOttaRoute</g) ?? []).toHaveLength(1);
		expect(frontmatter).toMatch(
			/dispatchOttaRoute<OrderRouteResult>\(\s*[^,]+,\s*STOREFRONT_ORDER_ROUTE,/,
		);
		expect(frontmatter).toContain("payPageRedirect(orderPath, orderRead, new Date())");
		expect(frontmatter).toMatch(
			/if \(refuseTo !== null\) return Astro\.redirect\(refuseTo, 303\);/,
		);
		// QA U-14: the same read also states the hold deadline — its
		// `holdExpiresAt` and nothing else, and never on the button.
		const holdNote =
			/holdNote:\s*orderRead !== null && !isBusyResult\(orderRead\) && orderRead\.ok\s*\?\s*payHoldCopy\(orderRead\.order\.holdExpiresAt, new Date\(\)\)\s*:\s*null/.exec(
				frontmatter,
			)?.[0] ?? "";
		expect(holdNote, "the hold note reads the order's deadline only").not.toBe("");
		// QA2 M1c: the deadline script is handed the same `holdExpiresAt` — and
		// nothing else from the read.
		const deadline =
			/const payDeadline =\s*orderRead !== null && !isBusyResult\(orderRead\) && orderRead\.ok\s*\?\s*orderRead\.order\.holdExpiresAt\s*:\s*undefined;/.exec(
				frontmatter,
			)?.[0] ?? "";
		expect(deadline, "the page's deadline is the order's holdExpiresAt only").not.toBe("");
		expect(
			frontmatter
				.replace(holdNote, "")
				.replace(deadline, "")
				.match(/orderRead/g) ?? [],
		).toHaveLength(2);
	});

	test("the currency rides on the same optional chain as the amount", () => {
		// So a pre-total stash names neither. Naming a currency under a "Pay now"
		// button would be the footer claiming the page priced something it did not
		// (§7) — `footer-currency.test.ts` owns the positive half of this rule.
		expect(PAY).toMatch(/<Storefront[^>]*currency=\{stash\.total\?\.currency \?\? null\}/);
	});
});

describe("/orders/<id> — the state is the page, and it ships no JavaScript", () => {
	test("PollRibbon runs nothing in the browser", () => {
		// Asserted on the TEMPLATE, so the component is free to explain in prose
		// that it is the ribbon WITHOUT the script — which is its entire reason
		// for existing, and which used to trip this very check.
		expect(hasExecutableScript(POLL_RIBBON)).toBe(false);
		expect(POLL_RIBBON).toContain("<script");
	});

	test("the confirmation page imports no scripted countdown", () => {
		expect(ORDER).not.toContain("components/HoldRibbon.astro");
		expect(ORDER).not.toContain("components/HoldClock.astro");
	});

	test("every state with nowhere to go offers the new-cart door — decided here", () => {
		// `failed` included: its cart is `checked_out`, so /checkout answers
		// CART_CHECKED_OUT and 303s to /cart. A "Back to checkout" link there is
		// a walk into an error page.
		expect(ORDER).toMatch(
			/const deadEnd =[\s\S]{0,160}?state === "expired"[\s\S]{0,80}?state === "cancelled"[\s\S]{0,80}?state === "failed"/,
		);
		expect(ORDER).not.toContain("Back to checkout");
	});

	test("the order page stays no-referrer, so it carries no form of its own", () => {
		// ADR-0012 decision 6 — its URL can hold the client secret. Under that
		// policy browsers send `Origin: null` on the page's own POSTs and the
		// origin guard 403s them, so the dead-end door is a GET link, drawn by
		// the view (pinned per theme below).
		expect(ORDER).toMatch(/<meta name="referrer" content="no-referrer" slot="head" \/>/);
		expect(templateOf(ORDER)).not.toMatch(/<form\b/i);
		expect(ORDER).not.toContain('action="/checkout/new-cart"');
	});

	test("/cart, where the door lands, is NOT no-referrer and every cart view offers the new-cart POST", () => {
		// The terminal (checked_out) cart is exactly the dead-end order's cart,
		// and its panel carries the real door (pinned in cart-page.test.ts). The
		// page must keep sending a real Origin, or that door dies the same way.
		expect(CART).not.toMatch(/name="referrer"/);
		for (const { file, source } of viewSources("cart")) {
			expect(source, file).toContain('<form method="POST" action="/checkout/new-cart">');
		}
	});

	test("the receipt names what was bought, not only its SKU", () => {
		// CLAUDE.md: orders snapshot price AND title at purchase time. A receipt
		// reading `OTTA-TEE-01 1 $25.00` has lost the thing a buyer opens it to
		// check. (/checkout names its lines too now — pinned with the review's
		// own decisions above.)
		expect(ORDER).toMatch(/title: line\.title/);
	});

	test("the total's label is orderTotalLabel's — Paid for every captured state (order-view.test.ts)", () => {
		expect(ORDER).toContain("orderTotalLabel(order.state)");
		expect(ORDER).not.toMatch(/TOTAL_LABEL/);
	});
});

describe.each(ORDER_VIEWS)("/orders/<id> — the view %s", (_label, { source: VIEW }) => {
	test("the confirmation uses the script-free PollRibbon, and not the scripted countdown", () => {
		expect(VIEW).toContain("components/PollRibbon.astro");
		expect(VIEW).not.toContain("components/HoldRibbon.astro");
		expect(VIEW).not.toContain("components/HoldClock.astro");
	});

	test("the step track is not drawn for an order that does not exist", () => {
		// It claims Cart → Details → Payment are behind you. On a 404 or a 503
		// that is a journey the visitor never made.
		const { body } = splitAstro(VIEW);
		const notFoundBranch = body.slice(
			body.indexOf("order === null || stamp === null ?"),
			body.indexOf("Browse products"),
		);
		expect(body.indexOf("order === null || stamp === null ?"), "no not-found arm").toBeGreaterThan(
			-1,
		);
		expect(notFoundBranch).not.toContain("<StepTrack");
		expect(body).toContain("<StepTrack");
	});

	test("every state with nowhere to go offers the door — a GET link to /cart, never a form", () => {
		// The order page is `no-referrer`, so a POST from it sends `Origin: null`
		// and the origin guard 403s it: a `POST /checkout/new-cart` form here is
		// dead on arrival (pinned in a real browser by e2e/checkout-place.spec.ts).
		expect(VIEW).not.toContain("Back to checkout");
		expect(templateOf(VIEW)).toMatch(
			/\{deadEnd && \(\s*<a\b[^>]*href="\/cart"[^>]*>\s*Go to your cart\s*<\/a>/,
		);
		expect(templateOf(VIEW)).not.toMatch(/<form\b/i);
		expect(VIEW).not.toContain('action="/checkout/new-cart"');
	});
});

/**
 * The pay step's frame is a theme view since Phase 3; the money path is not.
 * The Stripe mount, the pay button, the `<noscript>` and the script stay in
 * `pages/checkout/pay.astro` (ADR-0012 decision 2) and reach the view as the
 * `payment` slot.
 */
describe.each(viewCases("pay"))(
	"/checkout/pay — the view %s frames the page's payment slot",
	(_label, { source: VIEW }) => {
		test("it renders the page's `payment` slot exactly once", () => {
			expect(templateOf(VIEW).match(/<slot name="payment" \/>/g) ?? []).toHaveLength(1);
		});

		test("nothing of the money path is in the view", () => {
			expect(hasExecutableScript(VIEW)).toBe(false);
			expect(VIEW).not.toContain("js.stripe.com");
			expect(VIEW).not.toMatch(/client_?secret|clientSecret/i);
			expect(VIEW).not.toContain("payment-element");
			expect(VIEW).not.toContain("payment-submit");
		});
	},
);

describe("/checkout/pay — the page keeps the money path and hands it to the view", () => {
	test("the mount, the button and the script are all inside the page's `payment` slot", () => {
		const { body } = splitAstro(PAY);
		const slot = /<Fragment slot="payment">([\s\S]*?)<\/Fragment>/.exec(body)?.[1] ?? "";
		expect(slot, "no payment slot on the page").not.toBe("");
		expect(slot).toContain('id="payment-element"');
		expect(slot).toContain('id="payment-submit"');
		expect(slot).toContain("<noscript>");
		expect(slot).toContain('<script is:inline src="https://js.stripe.com/v3/"></script>');
		expect(body).toMatch(/<Storefront[^>]*view="pay"/);
	});
});
