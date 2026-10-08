import { ORDER_NUMBER_LENGTH, orderNumber } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

// The order NUMBER: the id's first five characters, upper-cased, behind a `#`.
// A display label, never a key (ADR-0033) — so these pins are about its spelling
// and about the admin search reading it back, nothing else.

describe("orderNumber", () => {
	test("is # + the first five characters of the id, upper-cased", () => {
		expect(orderNumber("3f9a2b1c-7d4e-4a5b-9c8d-0123456789ab")).toBe("#3F9A2");
		expect(ORDER_NUMBER_LENGTH).toBe(5);
	});

	test("is a prefix of the id, so it can be searched for as one", () => {
		const id = "7e4ce728-0000-4000-8000-000000000000";
		expect(id.startsWith(orderNumber(id).slice(1).toLowerCase())).toBe(true);
	});

	test("is total: a short or non-uuid id still renders, never throws", () => {
		expect(orderNumber("ord-1")).toBe("#ORD-1");
		expect(orderNumber("ab")).toBe("#AB");
		expect(orderNumber("")).toBe("#");
	});

	test("depends only on the id — the same order is the same number on every surface", () => {
		const id = crypto.randomUUID();
		expect(orderNumber(id)).toBe(orderNumber(id));
		expect(orderNumber(id)).toMatch(/^#[0-9A-F]{5}$/);
	});

	test("random v4 ids give spread-out numbers, not a shared prefix", () => {
		// A time-ordered id (UUIDv7) would put the same leading characters on every
		// order of the hour; the ids Otta mints are random, so 200 of them give
		// (almost) 200 numbers. A generous floor keeps this from ever flaking.
		const numbers = new Set(Array.from({ length: 200 }, () => orderNumber(crypto.randomUUID())));
		expect(numbers.size).toBeGreaterThan(190);
	});
});
