/**
 * The hold ribbon's arithmetic (docs/theme/TEMPERED.md §6).
 *
 * The ribbon is the theme's signature and the one place a shopper is asked to
 * trust a number that moves. Everything about WHEN it changes colour, what it
 * is willing to say, and the value it leaves behind for a browser that never
 * runs the script lives here, in a pure module, so it can be tested at exact
 * boundaries instead of by waiting ten minutes in a browser.
 */
import { describe, expect, test } from "vitest";
import {
	HOLD_LABELS,
	HOLD_WINDOW_SECONDS,
	absoluteExpiry,
	holdClock,
	holdView,
} from "../src/lib/hold.js";

/** A fixed "now" — the tests move `expiresAt`, never the clock. */
const NOW = new Date("2026-07-28T14:00:00.000Z");

/** `seconds` from NOW, as the ISO string the cart wire carries. */
function inSeconds(seconds: number): string {
	return new Date(NOW.getTime() + seconds * 1000).toISOString();
}

describe("holdView — the three states and their boundaries", () => {
	test("a fresh hold is `held`", () => {
		const view = holdView(inSeconds(512), NOW);
		expect(view?.state).toBe("held");
		expect(view?.label).toBe(HOLD_LABELS.held);
		expect(view?.clock).toBe("08:32");
	});

	test("61 seconds left is still `held` — the flip is AT a minute, not near it", () => {
		expect(holdView(inSeconds(61), NOW)?.state).toBe("held");
	});

	test("exactly 60 seconds left is `expiring`", () => {
		const view = holdView(inSeconds(60), NOW);
		expect(view?.state).toBe("expiring");
		expect(view?.label).toBe(HOLD_LABELS.expiring);
		expect(view?.clock).toBe("01:00");
	});

	test("one second left is `expiring`, not released", () => {
		expect(holdView(inSeconds(1), NOW)?.state).toBe("expiring");
	});

	test("zero is `released`", () => {
		const view = holdView(inSeconds(0), NOW);
		expect(view?.state).toBe("released");
		expect(view?.label).toBe(HOLD_LABELS.released);
		expect(view?.clock).toBe("00:00");
	});

	test("an expiry in the past is released, never a negative countdown", () => {
		const view = holdView(inSeconds(-4000), NOW);
		expect(view?.state).toBe("released");
		expect(view?.secondsLeft).toBe(0);
		expect(view?.clock).toBe("00:00");
	});
});

describe("holdView — the fill", () => {
	test("a full window fills the track", () => {
		expect(holdView(inSeconds(HOLD_WINDOW_SECONDS), NOW)?.percent).toBe(100);
	});

	test("half a window fills half of it", () => {
		expect(holdView(inSeconds(HOLD_WINDOW_SECONDS / 2), NOW)?.percent).toBe(50);
	});

	test("a released hold has no fill left", () => {
		expect(holdView(inSeconds(0), NOW)?.percent).toBe(0);
	});

	test("a hold LONGER than the window is clamped, never overflowing the track", () => {
		// A store configured with a longer TTL than the theme assumes must not
		// draw a 300%-wide fill.
		expect(holdView(inSeconds(HOLD_WINDOW_SECONDS * 3), NOW)?.percent).toBe(100);
	});

	test("the window is overridable, for a store whose hold TTL is not ten minutes", () => {
		expect(holdView(inSeconds(60), NOW, 120)?.percent).toBe(50);
	});
});

describe("holdView — what it refuses to claim", () => {
	test("a line with no reservation has no ribbon at all", () => {
		// `expiresAt: null` on the cart wire means no reservation was taken —
		// NOT a hold that ran out. Rendering "Hold released" over it would
		// invent a hold that never existed.
		expect(holdView(null, NOW)).toBeNull();
	});

	test("an unparseable timestamp renders nothing rather than NaN", () => {
		expect(holdView("not a date", NOW)).toBeNull();
		expect(holdView("", NOW)).toBeNull();
	});
});

describe("holdClock — mono, tabular, always four digits", () => {
	test.each([
		[0, "00:00"],
		[9, "00:09"],
		[60, "01:00"],
		[599, "09:59"],
		[600, "10:00"],
		[3600, "60:00"],
	])("%i seconds reads %s", (seconds, expected) => {
		expect(holdClock(seconds)).toBe(expected);
	});

	test("never renders a negative clock", () => {
		expect(holdClock(-30)).toBe("00:00");
	});
});

describe("absoluteExpiry — the value a browser with no JavaScript is left holding", () => {
	test("is an unambiguous wall-clock time, named with its zone", () => {
		// The countdown goes stale the moment it is printed; this does not.
		// UTC is stated explicitly because the server cannot know the shopper's
		// zone, and an unlabelled "14:10" would be read as local.
		expect(absoluteExpiry("2026-07-28T14:10:00.000Z")).toBe("14:10:00 UTC");
	});

	test("carries SECONDS — a ten-minute hold cannot afford to round up a minute", () => {
		// Truncating to the minute discards up to 59s of a 600s window, and it
		// rounds in the direction that makes a shopper think they have longer.
		expect(absoluteExpiry("2026-07-28T14:10:59.000Z")).toBe("14:10:59 UTC");
		expect(absoluteExpiry("2026-07-28T14:10:01.000Z")).toBe("14:10:01 UTC");
	});

	test("pads every field, so it sets in a stable tabular slot", () => {
		expect(absoluteExpiry("2026-07-28T04:05:06.000Z")).toBe("04:05:06 UTC");
	});

	test("an unparseable timestamp yields nothing rather than `Invalid Date`", () => {
		expect(absoluteExpiry("nope")).toBeNull();
	});
});
