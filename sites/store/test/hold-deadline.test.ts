/**
 * QA U-14 (checkout part) — say how long the order is held, honestly.
 *
 *  - The pay page never said when the reservation ends. It now does, as a
 *    RELATIVE figure ("12 more minutes", true in every time zone) beside an
 *    absolute time WITH its zone ("until 2:32 pm UTC"), because the page does
 *    not tick: the relative part is true when the page loads and the absolute
 *    part stays true after. Minutes are rounded DOWN — never more time than
 *    there is.
 *  - The cart's released-hold line said "Update the quantity to hold it again"
 *    over a line that a reload then showed was GONE (the cart read drops a
 *    lapsed line). It now says what the reload will show.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { splitAstro, templateOf } from "./astro-source.js";
import { viewSources } from "./theme-views.js";
import { HOLD_RELEASED_NEXT_STEP, payHoldCopy } from "../src/lib/hold.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

const DEADLINE = "2026-10-02T14:32:00.000Z";
const at = (iso: string): Date => new Date(iso);

describe("payHoldCopy", () => {
	test("minutes left, rounded down, and the deadline with its zone", () => {
		expect(payHoldCopy(DEADLINE, at("2026-10-02T14:19:30.000Z"))).toEqual({
			lead: "Your order is reserved for 12 more minutes",
			until: "2:32 pm UTC",
			iso: DEADLINE,
		});
	});

	test("one minute is singular", () => {
		expect(payHoldCopy(DEADLINE, at("2026-10-02T14:30:30.000Z"))?.lead).toBe(
			"Your order is reserved for 1 more minute",
		);
	});

	test("under a minute says so rather than '0 minutes'", () => {
		expect(payHoldCopy(DEADLINE, at("2026-10-02T14:31:30.000Z"))?.lead).toBe(
			"Your order is reserved for less than a minute more",
		);
	});

	test("at or past the deadline, or with no readable deadline, there is nothing to say", () => {
		expect(payHoldCopy(DEADLINE, at(DEADLINE))).toBeNull();
		expect(payHoldCopy(DEADLINE, at("2026-10-02T15:00:00.000Z"))).toBeNull();
		expect(payHoldCopy("not-a-date", at(DEADLINE))).toBeNull();
	});
});

describe("the pay page shows the hold deadline", () => {
	const page = read("pages/checkout/pay.astro");
	const front = splitAstro(page).frontmatter;

	test("the page takes it from the order read its guard already makes — no second read", () => {
		expect(front).toMatch(
			/holdNote:\s*orderRead !== null && !isBusyResult\(orderRead\) && orderRead\.ok\s*\?\s*payHoldCopy\(orderRead\.order\.holdExpiresAt, new Date\(\)\)\s*:\s*null/,
		);
		expect(front.match(/await dispatchOttaRoute/g)).toHaveLength(1);
	});

	test("the no-JS note no longer claims a fixed 15 minutes", () => {
		expect(templateOf(page)).not.toMatch(/reserved\s+for 15 minutes/);
	});

	test.each(viewSources("pay").map((v) => [v.file, v] as const))(
		"%s prints the lead and a machine-readable <time> for the deadline",
		(_file, view) => {
			const body = templateOf(view.source);
			expect(body).toMatch(/\{holdNote\.lead\}/);
			expect(body).toMatch(/<time datetime=\{holdNote\.iso\}>\{holdNote\.until\}<\/time>/);
		},
	);
});

describe("a released cart hold says what a reload will show", () => {
	test("it does not promise the line can be updated — the reload drops it", () => {
		expect(HOLD_RELEASED_NEXT_STEP).not.toMatch(/Update the quantity/);
		expect(HOLD_RELEASED_NEXT_STEP).toBe(
			"Stock went back on sale. This item leaves your cart when the page reloads — add it again to hold it.",
		);
	});
});
