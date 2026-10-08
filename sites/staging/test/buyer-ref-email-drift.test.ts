/**
 * The site's checkout guard and the domain's recipient check must never DISAGREE in
 * the dangerous direction: every `buyerRef` the site accepts at checkout
 * (`isPlausibleEmail`) must also be an email recipient to the domain
 * (`isEmailAddress`), or a real buyer's order would be completed "skipped: no
 * recipient" and never emailed (ADR-0028 Decision 7). The domain's check is the
 * looser of the two by design, so the reverse need not hold.
 *
 * `@otta-sh/domain` is a devDependency of the site for this check only.
 */
import { isEmailAddress } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { isPlausibleEmail, normalizeBuyerRef } from "../src/lib/email.js";

/** Addresses a buyer can really type — plus the site's own edge cases. */
const FIXTURES: readonly string[] = [
	"buyer@example.com",
	"buyer+orders@example.com",
	"first.last@sub.example.co.uk",
	"Buyer@Example.COM",
	"  padded@example.com  ",
	"käufer@bücher.de",
	"用户@例子.广告",
	"o'brien@example.ie",
	"x@y.photography",
	"a_b-c@d-e.example",
	"1234567890@example.com",
	// Ones the site refuses — included so the property is checked on both sides.
	"wallet:0x1111111111111111111111111111111111111111",
	"jo@",
	"asdf",
	"a@b",
	"a b@example.com",
	"",
];

describe("every buyerRef the site accepts is an email recipient to the domain", () => {
	for (const raw of FIXTURES) {
		test(JSON.stringify(raw), () => {
			if (isPlausibleEmail(raw)) {
				expect(isEmailAddress(raw)).toBe(true);
				// …and so is the value the site actually sends.
				expect(isEmailAddress(normalizeBuyerRef(raw))).toBe(true);
			}
		});
	}

	test("the fixture list exercises both sides of the site's guard", () => {
		expect(FIXTURES.some((raw) => isPlausibleEmail(raw))).toBe(true);
		expect(FIXTURES.some((raw) => !isPlausibleEmail(raw))).toBe(true);
	});
});
