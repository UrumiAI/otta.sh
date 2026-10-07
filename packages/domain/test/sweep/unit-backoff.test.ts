import { UnitBackoff } from "@otta-sh/domain";
import { describe, expect, test } from "vitest";

// A sweep unit that keeps failing must not hold the head of the sweep's list
// forever (review round 3, B I4): it waits, longer each time, and the sweep reads
// past it in the meantime.
describe("UnitBackoff", () => {
	const t0 = Date.parse("2026-07-10T00:00:00.000Z");

	test("a failed unit waits, doubling per failure up to the cap", () => {
		const b = new UnitBackoff({ baseMs: 1_000, maxMs: 5_000 });
		expect(b.waiting(t0).size).toBe(0);
		b.failed("a", t0);
		expect([...b.waiting(t0)]).toEqual(["a"]);
		expect(b.waiting(t0 + 999).has("a")).toBe(true);
		expect(b.waiting(t0 + 1_000).has("a")).toBe(false);
		b.failed("a", t0 + 1_000); // second failure: 2 s
		expect(b.waiting(t0 + 2_999).has("a")).toBe(true);
		expect(b.waiting(t0 + 3_000).has("a")).toBe(false);
		b.failed("a", t0 + 3_000); // third: 4 s
		b.failed("a", t0 + 7_000); // fourth: capped at 5 s
		expect(b.waiting(t0 + 11_999).has("a")).toBe(true);
		expect(b.waiting(t0 + 12_000).has("a")).toBe(false);
	});

	test("a success forgets the unit", () => {
		const b = new UnitBackoff();
		b.failed("a", t0);
		b.succeeded("a");
		expect(b.size).toBe(0);
		expect(b.waiting(t0).size).toBe(0);
	});

	test("it holds at most `maxEntries` units, dropping the one due soonest", () => {
		const b = new UnitBackoff({ baseMs: 1_000, maxEntries: 2 });
		b.failed("a", t0);
		b.failed("b", t0 + 10);
		b.failed("b", t0 + 20); // b now waits 2 s: due last
		b.failed("c", t0 + 30);
		expect(b.size).toBe(2);
		expect([...b.waiting(t0 + 30)].toSorted()).toEqual(["b", "c"]);
	});

	test("`setMaxEntries` resizes the cap, dropping the units due soonest (polish P-3)", () => {
		const b = new UnitBackoff({ baseMs: 1_000 });
		expect(b.maxEntries).toBe(UnitBackoff.DEFAULT_MAX_ENTRIES);
		b.failed("a", t0);
		b.failed("b", t0 + 10);
		b.failed("c", t0 + 20);
		b.setMaxEntries(2);
		expect(b.maxEntries).toBe(2);
		expect([...b.waiting(t0 + 20)].toSorted()).toEqual(["b", "c"]);
		b.setMaxEntries(98);
		for (let i = 0; i < 100; i++) b.failed(`u${String(i)}`, t0 + 100 + i);
		expect(b.size).toBe(98);
		expect(() => b.setMaxEntries(0)).toThrow(RangeError);
		expect(() => b.setMaxEntries(1.5)).toThrow(RangeError);
	});

	test("refuses a nonsensical configuration", () => {
		expect(() => new UnitBackoff({ baseMs: 0 })).toThrow(RangeError);
		expect(() => new UnitBackoff({ baseMs: 10, maxMs: 5 })).toThrow(RangeError);
		expect(() => new UnitBackoff({ maxEntries: 0 })).toThrow(RangeError);
	});
});
