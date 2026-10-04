/**
 * The hold ribbon's arithmetic (docs/theme/TEMPERED.md §6).
 *
 * A cart line's `expiresAt` (already on the cart wire) → the state, the fill,
 * the label and the clock the ribbon renders. Pure, so the boundaries that
 * matter — the flip to bronze AT sixty seconds, the refusal to draw a negative
 * countdown, the refusal to claim a hold that never existed — are unit-tested
 * rather than eyeballed.
 *
 * The client script (`HoldClock.astro`, over `hold-ribbon.ts`) re-derives exactly these three
 * states from the same `expiresAt`; this module is the server's first render
 * and the no-JS answer.
 */

/** The commerce layer's DEFAULT hold TTL, in seconds — 15 minutes.
 *
 *  AUTHORITY: the admin's `holdTtlMinutes` setting, whose unsaved default
 *  (`DEFAULT_OPERATIONAL_SETTINGS` in @otta-sh/domain) is 15 minutes. Since
 *  issue #127 the setting IS the cart hold — the plugin's cart use-cases stamp
 *  every deadline with it — so a store whose operator changed it runs a
 *  different window from this one. The PDP's hold note reads the effective value
 *  off the route (see {@link holdNote}); this constant is the ribbon's only.
 *
 *  It is ONLY the fill's denominator. The ribbon needs a window to draw a
 *  fraction against because the wire carries the expiry INSTANT, not the length
 *  of the hold; the countdown, the state and the clock all come from
 *  `expiresAt` and are unaffected by this number. Getting it wrong therefore
 *  cannot mis-state the time left — it draws a bar at the wrong width (600 here
 *  clamped a 15-minute hold's bar at full for its first 300 seconds, then
 *  drained it half again too fast).
 *  A store on a longer TTL is clamped, never overflowed; `holdView` takes an
 *  explicit `windowSeconds` for that case. */
export const HOLD_WINDOW_SECONDS = 900;

/**
 * The PDP's hold note, stating the window the store ACTUALLY runs — the value the
 * product route reports as `cartHoldMinutes` (issue #127), never a hard-coded
 * default. §10 keeps the duration visible because it is the useful part.
 *
 * A value that is not a positive whole number (the route never sends one, but
 * this renders on a public page) states no figure at all rather than "for NaN
 * minutes" — a sentence a shopper can plan around, or none.
 */
export function holdNote(minutes: number | undefined): string {
	/* Quantity-agnostic on purpose. It read "Adding this holds one in stock",
	   printed beside a quantity field the shopper can set to 3 — and the hold
	   covers whatever quantity is added. So the note names the window, never a
	   count of units. */
	const lead = "We'll hold what you add";
	if (minutes === undefined || !Number.isInteger(minutes) || minutes <= 0) {
		return `${lead} while you check out.`;
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${lead} for ${String(hours)} ${hours === 1 ? "hour" : "hours"}.`;
	}
	return `${lead} for ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** Under a minute, the ribbon turns bronze and changes what it calls itself. */
export const HOLD_EXPIRING_SECONDS = 60;

export type HoldState = "held" | "expiring" | "released";

/** Shopper-side, and the same words the client script writes back on each tick
 *  (they are duplicated in that script by necessity — it is inline and cannot
 *  import; `hold-ribbon.test.ts` pins the two copies together). */
export const HOLD_LABELS: Record<HoldState, string> = {
	held: "Held for you",
	expiring: "Expiring",
	released: "Hold released",
};

/** What to do once a hold has lapsed. §6: the released state carries a line
 *  telling the shopper the next move — a dead end without a door is not a
 *  designed state. */
export const HOLD_RELEASED_NEXT_STEP =
	"Stock went back on sale. Update the quantity to hold it again.";

export interface HoldView {
	state: HoldState;
	/** Whole seconds left, floored at zero. */
	secondsLeft: number;
	/** Track fill, 0–100. Clamped: a hold longer than the assumed window must
	 *  not draw a fill wider than the track. */
	percent: number;
	label: string;
	/** `mm:ss`. */
	clock: string;
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

function pad(value: number): string {
	return value < 10 ? `0${value}` : `${value}`;
}

/** Seconds → `mm:ss`, never negative. */
export function holdClock(seconds: number): string {
	const left = Math.max(0, Math.floor(seconds));
	return `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
}

export function holdState(secondsLeft: number): HoldState {
	if (secondsLeft <= 0) return "released";
	return secondsLeft <= HOLD_EXPIRING_SECONDS ? "expiring" : "held";
}

/**
 * A cart line's `expiresAt` → everything the ribbon renders, or `null` when
 * there is no hold to report at all.
 *
 * `null` in, `null` out is load-bearing: a cart line with `expiresAt: null`
 * took no reservation (a legacy bare-add line), which is a different fact from
 * a hold that ran out. Rendering "Hold released" over it would invent a hold
 * that never existed.
 */
export function holdView(
	expiresAt: string | null | undefined,
	now: Date = new Date(),
	windowSeconds: number = HOLD_WINDOW_SECONDS,
): HoldView | null {
	if (expiresAt === null || expiresAt === undefined || expiresAt === "") return null;
	const expiry = Date.parse(expiresAt);
	if (Number.isNaN(expiry)) return null;

	const secondsLeft = Math.max(0, Math.floor((expiry - now.getTime()) / 1000));
	const state = holdState(secondsLeft);
	return {
		state,
		secondsLeft,
		percent: clamp((secondsLeft / windowSeconds) * 100, 0, 100),
		label: HOLD_LABELS[state],
		clock: holdClock(secondsLeft),
	};
}

/**
 * The value a browser that never runs the script is left holding.
 *
 * A server-rendered countdown is accurate for one second and then quietly
 * lies, so with no JavaScript the ribbon shows the EXPIRY INSTANT instead,
 * which stays true. UTC is named explicitly: the server cannot know the
 * shopper's zone, and a bare "14:10" would be read as local time.
 *
 * SECONDS ARE INCLUDED, and that is not fussiness. A hold is fifteen minutes
 * long, so truncating to the minute discards up to 59 seconds of a 900-second
 * window — for a shopper arriving with two minutes left that is a meaningful
 * slice of the time they have to decide in, and it rounds in the direction
 * that makes them think they have longer than they do.
 */
export function absoluteExpiry(expiresAt: string | null | undefined): string | null {
	if (expiresAt === null || expiresAt === undefined || expiresAt === "") return null;
	const expiry = Date.parse(expiresAt);
	if (Number.isNaN(expiry)) return null;
	return `${new Date(expiry).toISOString().slice(11, 19)} UTC`;
}

/**
 * The hold's expiry as a wall clock — "4:52 pm UTC" — for copy that must stay
 * true for as long as the page is open without a script to count (a drawer's
 * static line, a stamp's fixed text).
 *
 * The minute is FLOORED, so the copy never promises time the shopper does not
 * have, and UTC is named for `absoluteExpiry`'s reason: the server cannot know
 * the shopper's zone. `null` for an expiry that does not parse.
 */
export function wallClock(expiresAt: string): string | null {
	const expiry = Date.parse(expiresAt);
	if (Number.isNaN(expiry)) return null;
	const at = new Date(expiry);
	const hours = at.getUTCHours();
	const minutes = at.getUTCMinutes();
	const twelve = hours % 12 === 0 ? 12 : hours % 12;
	return `${twelve}:${minutes < 10 ? `0${minutes}` : minutes} ${hours < 12 ? "am" : "pm"} UTC`;
}

/** How long after a hold is taken it still counts as JUST taken. */
export const FRESH_HOLD_GRACE_SECONDS = 15;

/**
 * Was this hold taken within the last `graceSeconds` — is this render the one
 * that follows the add (or the quantity change) that took it?
 *
 * For a theme's on-add moment (e.g. a stamp landing on the new line, the line
 * hopping into the bag, a bag strip rising): it must play ONCE, on the page the add
 * lands on, not on every later render of the same live hold — a reload, a
 * revisit, a change to another line. The wire carries no "just added" flag
 * and the redirect `/cart/add` answers with carries none either, so the age
 * of the hold stands in for it: `windowSeconds − secondsLeft` is how long ago
 * the hold was taken.
 *
 * FAILS STATIC. `false` for no hold, a released one, an unparsable expiry, and
 * for a store whose hold is not `windowSeconds` long (its age cannot be read
 * off the expiry then, so the moment simply does not play).
 */
export function isFreshHold(
	expiresAt: string | null | undefined,
	now: Date = new Date(),
	windowSeconds: number = HOLD_WINDOW_SECONDS,
	graceSeconds: number = FRESH_HOLD_GRACE_SECONDS,
): boolean {
	const view = holdView(expiresAt, now, windowSeconds);
	if (view === null || view.state === "released") return false;
	const age = windowSeconds - view.secondsLeft;
	return age >= 0 && age <= graceSeconds;
}
