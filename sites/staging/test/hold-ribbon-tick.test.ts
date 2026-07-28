/**
 * The hold ribbon's client tick, driven by a fake clock
 * (docs/theme/TEMPERED.md §6).
 *
 * Three behaviours here are the difference between a countdown a shopper can
 * act on and a decorative number, none of them is visible in a screenshot, and
 * all three used to be pinned only by grepping `HoldRibbon.astro` for a
 * substring — which proves the characters are present and nothing about what
 * they do. They are executable now because the tick lives in
 * `src/lib/hold-ribbon.ts` and the DOM sits behind `HoldRibbonPort`:
 *
 *  (a) every frame is recomputed from the ABSOLUTE expiry, so a clock that
 *      jumped — a throttled background tab, a bfcache restore, a closed lid —
 *      self-corrects on the next tick instead of drifting;
 *  (b) the polite region is written once per state CHANGE, never per tick;
 *  (c) the shared interval drops itself once nothing is left to count.
 *
 * No jsdom: the port is the seam, so a plain object records what the script
 * would have written.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type HoldFrame,
	type HoldRibbonPort,
	TICK_MS,
	holdFrame,
	startHoldRibbons,
	tickHoldRibbons,
} from "../src/lib/hold-ribbon.js";
import { HOLD_EXPIRING_SECONDS, HOLD_LABELS, HOLD_WINDOW_SECONDS } from "../src/lib/hold.js";

const T0 = Date.parse("2026-07-28T14:00:00.000Z");

/** One ribbon on screen, as a recorder. `shownState` starts where the SERVER
 *  rendered it, exactly as the script reads it back off `data-state`. */
function ribbon(secondsLeft: number, shownState = ""): HoldRibbonPort & { frames: HoldFrame[] } {
	const frames: HoldFrame[] = [];
	return {
		expiry: T0 + secondsLeft * 1000,
		window: HOLD_WINDOW_SECONDS,
		shownState,
		frames,
		render(frame) {
			frames.push(frame);
		},
	};
}

/** Every announcement a ribbon actually made. */
const announcements = (r: { frames: HoldFrame[] }): string[] =>
	r.frames.map((f) => f.announce).filter((a): a is string => a !== null);

describe("holdFrame — recomputed from the absolute expiry, never decremented (a)", () => {
	test("a five-minute jump in ONE step lands on the right time", () => {
		// The throttling case. A background tab is not ticked once a second; it
		// is ticked once a minute, or once, or not until it is foregrounded. A
		// countdown that subtracted TICK_MS per call would still be reading
		// 09:00 here, and it would be reading it on a hold with four minutes
		// left — wrong in the direction that costs the shopper the stock.
		const expiry = T0 + 540_000;
		expect(holdFrame(expiry, HOLD_WINDOW_SECONDS, "held", T0)?.clock).toBe("09:00");
		expect(holdFrame(expiry, HOLD_WINDOW_SECONDS, "held", T0 + 300_000)?.clock).toBe("04:00");
	});

	test("a jump straight past the expiry lands on released, not on a negative clock", () => {
		const frame = holdFrame(T0 + 60_000, HOLD_WINDOW_SECONDS, "held", T0 + 3_600_000);
		expect(frame?.state).toBe("released");
		expect(frame?.clock).toBe("00:00");
		expect(frame?.fill).toBe("0.0%");
		expect(frame?.live).toBe(false);
	});

	test("it flips at the same boundary the server does, from the same constant", () => {
		const window = HOLD_WINDOW_SECONDS;
		const at = (left: number): string | undefined =>
			holdFrame(T0 + left * 1000, window, "held", T0)?.state;
		expect(at(HOLD_EXPIRING_SECONDS + 1)).toBe("held");
		expect(at(HOLD_EXPIRING_SECONDS)).toBe("expiring");
		expect(at(1)).toBe("expiring");
		expect(at(0)).toBe("released");
		expect(at(-30)).toBe("released");
	});

	test("its labels ARE the server's — one definition, not two copies", () => {
		expect(holdFrame(T0 + 540_000, HOLD_WINDOW_SECONDS, "", T0)?.label).toBe(HOLD_LABELS.held);
		expect(holdFrame(T0 + 30_000, HOLD_WINDOW_SECONDS, "", T0)?.label).toBe(HOLD_LABELS.expiring);
		expect(holdFrame(T0 - 1000, HOLD_WINDOW_SECONDS, "", T0)?.label).toBe(HOLD_LABELS.released);
	});

	test("the fill is clamped to the track and rounded the way the markup is", () => {
		// A hold longer than the window the page assumed must not draw a fill
		// wider than its track.
		expect(holdFrame(T0 + 1_200_000, HOLD_WINDOW_SECONDS, "", T0)?.fill).toBe("100.0%");
		expect(holdFrame(T0 + 300_000, HOLD_WINDOW_SECONDS, "", T0)?.fill).toBe("50.0%");
		expect(holdFrame(T0 + 299_000, HOLD_WINDOW_SECONDS, "", T0)?.fill).toMatch(/^\d+\.\d%$/);
	});

	test("an expiry that never parsed yields no frame rather than NaN on screen", () => {
		expect(holdFrame(Number.NaN, HOLD_WINDOW_SECONDS, "", T0)).toBeNull();
	});
});

describe("the polite region is written per STATE CHANGE, never per tick (b)", () => {
	test("ninety seconds of ticking across two transitions announces exactly twice", () => {
		// Once a second for ninety seconds is ninety frames. A live region
		// written on each of them is a screen reader talking over the shopper
		// for a minute and a half; the two announcements below are the whole
		// budget for this stretch.
		const r = ribbon(70, "held");
		for (let second = 0; second <= 90; second++) tickHoldRibbons([r], T0 + second * 1000);

		expect(r.frames).toHaveLength(91);
		expect(announcements(r)).toEqual([HOLD_LABELS.expiring, HOLD_LABELS.released]);
	});

	test("held → expiring → released announces each state once, in order", () => {
		const r = ribbon(120, "held");
		for (const second of [0, 30, 61, 90, 119, 120, 200]) {
			tickHoldRibbons([r], T0 + second * 1000);
		}
		expect(announcements(r)).toEqual([HOLD_LABELS.expiring, HOLD_LABELS.released]);
	});

	test("the first frame announces nothing when it agrees with the server", () => {
		// The server already rendered "Held for you" into the label beside it;
		// announcing it on load would be a duplicate read.
		const r = ribbon(540, "held");
		tickHoldRibbons([r], T0);
		expect(announcements(r)).toEqual([]);
		expect(r.frames).toHaveLength(1);
	});

	test("the first frame DOES announce when the page was restored mid-hold", () => {
		// bfcache: the markup says "held" because that is what the server saw,
		// and the hold has since lapsed. This is precisely when a shopper needs
		// telling.
		const r = ribbon(-30, "held");
		tickHoldRibbons([r], T0);
		expect(announcements(r)).toEqual([HOLD_LABELS.released]);
	});

	test("a repeated tick in the same state stays silent", () => {
		const r = ribbon(540, "held");
		for (let second = 0; second < 20; second++) tickHoldRibbons([r], T0 + second * 1000);
		expect(announcements(r)).toEqual([]);
	});
});

describe("the shared interval stops once nothing is left to count (c)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("one interval for the whole page, however many ribbons are on it", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		startHoldRibbons([ribbon(540), ribbon(300), ribbon(45)]);
		expect(vi.getTimerCount()).toBe(1);
	});

	test("the first frame is drawn immediately, not a second from now", () => {
		// The server shipped the ABSOLUTE expiry into the clock slot
		// ("14:10:32 UTC"). Leaving that up for a second is a visible flash of
		// the wrong thing.
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const r = ribbon(540);
		startHoldRibbons([r]);
		expect(r.frames).toHaveLength(1);
		expect(r.frames[0]?.clock).toBe("09:00");
	});

	test("it keeps ticking while any ribbon still has time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const live = ribbon(540);
		const lapsed = ribbon(-30);
		startHoldRibbons([live, lapsed]);
		vi.advanceTimersByTime(TICK_MS * 5);
		expect(vi.getTimerCount()).toBe(1);
		expect(live.frames.length).toBeGreaterThan(5);
	});

	test("it drops itself the tick after the LAST hold lapses", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const r = ribbon(3);
		startHoldRibbons([r]);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(TICK_MS * 3);
		expect(vi.getTimerCount()).toBe(0);
		expect(r.frames.at(-1)?.state).toBe("released");

		// And it stays stopped — no further frames, no tab kept awake.
		const drawn = r.frames.length;
		vi.advanceTimersByTime(TICK_MS * 60);
		expect(r.frames).toHaveLength(drawn);
	});

	test("a page whose holds have ALL already lapsed leaves no timer behind", () => {
		// The first frame clears the interval it was started with, so the handle
		// has to exist before that frame runs. Getting this wrong throws on
		// exactly the page that is easiest to miss in review.
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const r = ribbon(-90, "released");
		expect(() => {
			startHoldRibbons([r]);
		}).not.toThrow();
		expect(vi.getTimerCount()).toBe(0);
		expect(r.frames).toHaveLength(1);
	});

	test("a ribbon with no parseable expiry never keeps the interval alive", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const broken: HoldRibbonPort = {
			expiry: Number.NaN,
			window: HOLD_WINDOW_SECONDS,
			shownState: "",
			render() {
				throw new Error("a ribbon with no expiry must not be rendered");
			},
		};
		startHoldRibbons([broken]);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("and it ticks once a second — the rate the fill's transition assumes", () => {
		expect(TICK_MS).toBe(1000);
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const r = ribbon(540);
		startHoldRibbons([r]);
		vi.advanceTimersByTime(TICK_MS * 10);
		expect(r.frames).toHaveLength(11); // the immediate frame, then ten ticks
	});
});
