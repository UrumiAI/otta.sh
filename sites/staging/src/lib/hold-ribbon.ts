/**
 * The hold ribbon's client-side tick (docs/theme/TEMPERED.md §6).
 *
 * `hold.ts` is the SERVER's answer — the first render, and what a browser with
 * no JavaScript is left holding. This module is the same arithmetic run once a
 * second in the browser, and it lives outside `HoldRibbon.astro` for one
 * reason: three of its behaviours are load-bearing, none of them is visible in
 * a screenshot, and none of them can be pinned by reading the script's source
 * text for a substring.
 *
 *  1. EVERY FRAME IS RECOMPUTED FROM THE ABSOLUTE EXPIRY. Nothing here
 *     decrements a counter. A background tab is throttled to once a minute, a
 *     bfcache restore can hand back a page that has been asleep for an hour,
 *     and a laptop lid closes — a countdown that subtracts a second per tick
 *     comes back wrong from all three, and it comes back wrong in the
 *     shopper-hostile direction, showing time on a hold that has already gone.
 *  2. THE POLITE REGION IS WRITTEN ON A STATE CHANGE, NEVER ON A TICK. Three
 *     announcements in fifteen minutes; nine hundred is an unusable page.
 *  3. THE INTERVAL DROPS ITSELF once no ribbon has anything left to count.
 *
 * The component's `<script>` is a bundled module, not `is:inline`, so it
 * imports this rather than restating it. That is what makes the client and the
 * server ONE definition of the boundary, the labels and the clock format
 * instead of two copies pinned to each other by a grep.
 *
 * The DOM stays on the other side of `HoldRibbonPort`: the script does the
 * querying and the writing, this module decides what should be written. Which
 * is what lets the three behaviours above be driven by a fake clock.
 */
import { HOLD_LABELS, type HoldState, holdClock, holdState } from "./hold.js";

/** Once a second. Matches the fill's `transition: width 1s linear`, so the bar
 *  drains continuously rather than stepping. */
export const TICK_MS = 1000;

/** Everything one ribbon should be showing at one instant. */
export interface HoldFrame {
	state: HoldState;
	label: string;
	/** `mm:ss`. */
	clock: string;
	/** The `--pct` custom property's value, rounded the way the server rounds
	 *  it so the first client frame does not rewrite the markup for nothing. */
	fill: string;
	/** What the polite live region should be set to — non-null ONLY on a state
	 *  change. `null` on an ordinary tick means "leave it alone". */
	announce: string | null;
	/** Is there still something to count on this ribbon? */
	live: boolean;
}

/**
 * One ribbon, one instant.
 *
 * `now` is a parameter and not a `Date.now()` call for the reason at the top of
 * the file: the interesting cases are a clock that jumped, and a clock that
 * jumped is not something a test can wait for.
 *
 * Returns `null` for a ribbon whose expiry never parsed — the server renders no
 * ribbon at all in that case, so this is belt-and-braces against markup that
 * was hand-written or rewritten.
 */
export function holdFrame(
	expiry: number,
	windowSeconds: number,
	shownState: string,
	now: number,
): HoldFrame | null {
	if (Number.isNaN(expiry)) return null;
	const left = Math.max(0, Math.floor((expiry - now) / 1000));
	const state = holdState(left);
	return {
		state,
		label: HOLD_LABELS[state],
		clock: holdClock(left),
		// Clamped: a hold longer than the window the page assumed must not draw
		// a fill wider than its track.
		fill: `${Math.min(100, (left / windowSeconds) * 100).toFixed(1)}%`,
		announce: state === shownState ? null : HOLD_LABELS[state],
		live: left > 0,
	};
}

/** One ribbon on the page, as the tick sees it. The script implements this over
 *  real elements; a test implements it over a plain object. */
export interface HoldRibbonPort {
	/** The absolute expiry in ms since epoch — `Date.parse` of the server's
	 *  `data-expires`. `NaN` ⇒ nothing to count. */
	readonly expiry: number;
	/** The store's hold TTL, the fill's denominator. */
	readonly window: number;
	/** The state currently ON SCREEN. The tick reads it to tell a transition
	 *  from an ordinary second, and writes it back when it announces. */
	shownState: string;
	/** Put a frame on screen. */
	render(frame: HoldFrame): void;
}

/**
 * One pass over every ribbon on the page.
 *
 * Returns false when nothing is left to count — every hold has lapsed — which
 * is the signal for the caller to drop its interval.
 */
export function tickHoldRibbons(ribbons: readonly HoldRibbonPort[], now: number): boolean {
	let live = false;
	for (const ribbon of ribbons) {
		const frame = holdFrame(ribbon.expiry, ribbon.window, ribbon.shownState, now);
		if (frame === null) continue;
		if (frame.live) live = true;
		ribbon.render(frame);
		// Only a frame that ANNOUNCED advances the shown state — which is the
		// same condition, stated once, so the two cannot disagree.
		if (frame.announce !== null) ribbon.shownState = frame.state;
	}
	return live;
}

/**
 * Start the one interval every ribbon on the page shares.
 *
 * The first frame is drawn immediately rather than a second from now: the
 * server shipped the ABSOLUTE expiry into the clock slot ("14:10:32 UTC"), and
 * leaving that on screen for a second before the countdown appears is a visible
 * flash of the wrong thing.
 *
 * The interval handle is captured before that first frame runs, because the
 * first frame is entitled to clear it — a page whose holds have all already
 * lapsed must not leave a timer behind, and must not throw reaching for one
 * that does not exist yet.
 */
export function startHoldRibbons(ribbons: readonly HoldRibbonPort[]): void {
	const timer: ReturnType<typeof setInterval> = setInterval(() => {
		if (!tickHoldRibbons(ribbons, Date.now())) clearInterval(timer);
	}, TICK_MS);
	if (!tickHoldRibbons(ribbons, Date.now())) clearInterval(timer);
}
