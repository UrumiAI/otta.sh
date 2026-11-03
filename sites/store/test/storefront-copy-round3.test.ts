/**
 * Storefront copy that said something untrue or unhelpful (QA round 2, minor):
 * each pin here is the sentence the shopper now reads, or the rule behind it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { templateOf } from "./astro-source.js";
import { SRC, viewCases } from "./theme-views.js";

describe("the coupon note tells the truth about case (ADR-0025)", () => {
	test.each(viewCases("checkout"))("%s never says codes are case-sensitive", (_l, { source }) => {
		const template = templateOf(source);
		expect(template).not.toMatch(/Codes are case-sensitive/);
		expect(template).toContain("Codes aren't case-sensitive.");
	});
});

describe("the home page never states a catalog size it does not know (QA2 A9)", () => {
	test("the seeded tagline carries no count — the shop grows, the tagline would not", () => {
		const seed = JSON.parse(readFileSync(path.join(SRC, "../seed/seed.json"), "utf8")) as {
			settings: { tagline: string };
		};
		expect(seed.settings.tagline).not.toMatch(
			/\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|whole shop)\b/i,
		);
	});
});

describe("the header's cart count reaches /checkout and /orders/<id> (QA2 U-14)", () => {
	test("only the pay page is left out of the shopper-state read", () => {
		const shell = readFileSync(path.join(SRC, "layouts/Storefront.astro"), "utf8");
		expect(shell).toMatch(/const SHOPPERLESS_VIEWS: ReadonlySet<string> = new Set\(\["pay"\]\);/);
	});

	test("both pages are private already, before the shell reads anything", () => {
		for (const file of ["pages/checkout/index.astro", "pages/orders/[orderId].astro"]) {
			expect(readFileSync(path.join(SRC, file), "utf8")).toContain("keepPrivate(Astro);");
		}
	});
});

describe("signing out says so (QA2 A5)", () => {
	const home = readFileSync(path.join(SRC, "pages/index.astro"), "utf8");

	test("the home page shows the notice only for ?signed-out=1 with no session left, and keeps that render private", () => {
		expect(home).toMatch(/searchParams\.get\("signed-out"\) === "1"/);
		expect(home).toContain("currentSessionToken(Astro.cookies) === undefined");
		expect(home).toMatch(
			/if \(Astro\.url\.searchParams\.has\("signed-out"\)\) keepPrivate\(Astro\);/,
		);
		expect(home).toContain(`"You're signed out."`);
	});

	test("Tempered's home prints the page's notice", () => {
		const view = readFileSync(path.join(SRC, "themes/tempered/HomeView.astro"), "utf8");
		expect(templateOf(view)).toMatch(/model\.notice !== null &&/);
	});
});

describe("a signed-in shopper's sign-in page (QA2 A6)", () => {
	const page = readFileSync(path.join(SRC, "pages/account/login/index.astro"), "utf8");

	test("the form is hidden while signed in, unless the shopper asked to use a different email", () => {
		expect(page).toMatch(/showForm: email === null \|\| switching/);
		expect(page).toMatch(/searchParams\.get\("switch"\) === "1"/);
	});

	test.each(viewCases("accountLogin"))(
		"%s offers 'Use a different email' instead of the form",
		(_l, { source }) => {
			const template = templateOf(source);
			expect(template).toMatch(/showForm && \(/);
			expect(template).toContain("Use a different email");
			expect(template).toContain("href={signedIn.switchHref}");
		},
	);
});
