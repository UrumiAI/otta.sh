/**
 * The hold ribbon's arithmetic (docs/theme/TEMPERED.md §6).
 *
 * A cart line's `expiresAt` (already on the cart wire) → the state, the fill,
 * the label and the clock the ribbon renders. Pure, so the boundaries that
 * matter — the flip to bronze AT sixty seconds, the refusal to draw a negative
 * countdown, the refusal to claim a hold that never existed — are unit-tested
 * rather than eyeballed.
 *
 * The client script in `HoldRibbon.astro` re-derives exactly these three
 * states from the same `expiresAt`; this module is the server's first render
 * and the no-JS answer.
 */

/** The service's hold TTL. The ribbon needs a WINDOW to draw a fill against —
 *  the wire carries the expiry instant, not the length of the hold — so the
 *  theme assumes the service's ten minutes and clamps anything longer. */
export const HOLD_WINDOW_SECONDS = 600;

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
 */
export function absoluteExpiry(expiresAt: string | null | undefined): string | null {
	if (expiresAt === null || expiresAt === undefined || expiresAt === "") return null;
	const expiry = Date.parse(expiresAt);
	if (Number.isNaN(expiry)) return null;
	return `${new Date(expiry).toISOString().slice(11, 16)} UTC`;
}
