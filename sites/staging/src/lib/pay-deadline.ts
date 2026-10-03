/**
 * The pay page's own deadline, kept in the browser (QA2 M1c).
 *
 * `/checkout/pay` refuses an order past its hold when the page is LOADED
 * (`pay-guard.ts`), but a tab left open kept a live Pay button and "reserved for
 * 14 more minutes" long after the hold had gone — and a click then charged the
 * buyer for an order that was expiring. The server now withdraws the order's
 * PaymentIntent at the deadline and refunds a payment that lands after the
 * expiry; this is the part the buyer sees: at the deadline the page closes
 * itself — Pay disabled, the hold sentence replaced by "The time to pay has run
 * out" and a link to the order — and a submit after it never reaches Stripe.
 *
 * Driven by `pay.astro`'s bundled module script; the DOM stays behind
 * {@link PayDeadlinePort}, so the three behaviours that matter are tested with a
 * fake clock (`pay-deadline.test.ts`):
 *
 *  1. THE DEADLINE IS THE SERVER'S, NOT THE BROWSER CLOCK'S. The page is given
 *     the hold deadline AND the server's "now" at render; the browser only
 *     measures the time elapsed since load. A buyer whose clock is ten minutes
 *     slow must not get ten extra minutes of Pay (nor one ten minutes fast lose
 *     them). Network latency makes it close slightly late, never early, and the
 *     server-side withdrawal covers that gap.
 *  2. A SLEEPING TAB IS CHECKED WHEN IT WAKES. Background tabs throttle timers and
 *     a closed laptop stops them, so a timer alone could fire long after the
 *     deadline — the page also re-checks on visibility, focus and pageshow, and
 *     on every submit.
 *  3. A SUBMIT AFTER THE DEADLINE IS REFUSED, and closes the page. A payment
 *     already under way when the deadline passes is left alone: it was started
 *     in time, and the order page shows how it ended.
 */

/** The notice's lead, on the page and here (the page renders it hidden). */
export const PAY_CLOSED_LEAD = "The time to pay has run out.";

/** What the page does when it closes. Called at most once. */
export interface PayDeadlinePort {
	close(): void;
}

/**
 * The browser-clock instant (ms) at which payment closes: the time the server
 * said was left at render, counted from when the browser loaded the page. `null`
 * when either instant cannot be read — then the page states no deadline and
 * closes nothing (the server still refuses and withdraws; an unreadable value
 * must never lock a buyer out of a payable order).
 */
export function payCloseAt(
	deadlineIso: string | undefined,
	serverNowIso: string | undefined,
	loadedAtMs: number,
): number | null {
	if (deadlineIso === undefined || serverNowIso === undefined) return null;
	const deadline = Date.parse(deadlineIso);
	const serverNow = Date.parse(serverNowIso);
	if (!Number.isFinite(deadline) || !Number.isFinite(serverNow) || !Number.isFinite(loadedAtMs)) {
		return null;
	}
	return loadedAtMs + (deadline - serverNow);
}

/** Has payment closed at `nowMs`? Never, for an unreadable deadline. */
export function isPayClosed(closeAt: number | null, nowMs: number): boolean {
	return closeAt !== null && nowMs >= closeAt;
}

/** The longest delay a browser timer honours (2^31 − 1 ms); longer ones fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

export interface PayDeadlineEnv {
	now: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

export interface PayDeadline {
	/** Re-check now (wake-up events call this). Returns whether payment is closed. */
	check(): boolean;
	/** The submit gate: `true` ⇒ let the payment start; `false` ⇒ refused (and the
	 *  page is closed). */
	allowSubmit(): boolean;
	/** Has the page closed? */
	readonly closed: boolean;
}

/**
 * Arm the page's deadline. With an unreadable deadline (`closeAt === null`) it
 * arms nothing and allows every submit.
 */
export function startPayDeadline(
	closeAt: number | null,
	port: PayDeadlinePort,
	env: PayDeadlineEnv,
): PayDeadline {
	let closed = false;
	let timer: unknown = null;

	const close = (): void => {
		if (closed) return;
		closed = true;
		if (timer !== null) {
			env.clearTimer(timer);
			timer = null;
		}
		port.close();
	};

	const check = (): boolean => {
		if (closed) return true;
		if (isPayClosed(closeAt, env.now())) close();
		return closed;
	};

	const arm = (): void => {
		if (closed || closeAt === null) return;
		const left = closeAt - env.now();
		if (left <= 0) {
			close();
			return;
		}
		// A deadline past the timer's range re-arms rather than firing early.
		timer = env.setTimer(
			() => {
				timer = null;
				if (!check()) arm();
			},
			Math.min(left, MAX_TIMER_MS),
		);
	};

	arm();

	return {
		check,
		allowSubmit: () => !check(),
		get closed() {
			return closed;
		},
	};
}
