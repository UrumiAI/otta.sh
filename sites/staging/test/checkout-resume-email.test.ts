/**
 * `/checkout/resume/email?order=<id>` answers an id that names no order the way
 * the order page does — a 404 with "That order could not be found", and NO email
 * form (QA2 N7). It used to offer the form for any id at all, which invited a
 * shopper with a mistyped link to type their email into a dead end. An order that
 * can no longer be paid goes to its own page, which says why.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { OrderRouteResult } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { resumeEmailGate } from "../src/lib/checkout-resume.js";
import { splitAstro } from "./astro-source.js";
import { SRC } from "./theme-views.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");

function found(state: string, holdExpiresAt = "2026-10-03T12:10:00.000Z"): OrderRouteResult {
	return { ok: true, order: { state, holdExpiresAt } } as unknown as OrderRouteResult;
}

describe("resumeEmailGate", () => {
	test("no such order: not found — the page 404s with no form", () => {
		expect(resumeEmailGate({ ok: false, reason: "ORDER_NOT_FOUND" }, NOW)).toBe("not_found");
	});

	test("a payable pending order: the form", () => {
		expect(resumeEmailGate(found("pending"), NOW)).toBe("form");
	});

	test("an order that cannot be paid (any other state, or past its hold): its own page", () => {
		expect(resumeEmailGate(found("paid"), NOW)).toBe("order_page");
		expect(resumeEmailGate(found("expired"), NOW)).toBe("order_page");
		expect(resumeEmailGate(found("pending", "2026-10-03T11:00:00.000Z"), NOW)).toBe("order_page");
	});

	test("an unanswered read (busy, unreachable) keeps the form: the resume itself re-checks", () => {
		expect(resumeEmailGate(null, NOW)).toBe("form");
		expect(resumeEmailGate({ ok: false, error: "BUSY", retryable: true } as never, NOW)).toBe(
			"form",
		);
	});
});

describe("the page", () => {
	const source = readFileSync(path.join(SRC, "pages/checkout/resume/email.astro"), "utf8");

	test("reads the order and 404s an unknown one with the order page's sentence", () => {
		const { frontmatter } = splitAstro(source);
		expect(frontmatter).toContain("resumeEmailGate(");
		expect(frontmatter).toContain("Astro.response.status = 404");
		expect(frontmatter).toContain('cartErrorMessage("ORDER_NOT_FOUND")');
	});
});
