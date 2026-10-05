/**
 * The pay page closes itself at its own deadline (QA2 M1c), driven by a fake
 * clock. QA round 2 left a pay tab open past the hold: it still said "reserved
 * for 14 more minutes", Pay stayed enabled, and a click charged the buyer for an
 * order that was expiring. The page's script is `pay.astro`'s; what it DECIDES
 * is `lib/pay-deadline.ts`, and that is what is pinned here.
 */
import { describe, expect, test } from "vitest";
import {
	isPayClosed,
	PAY_CANCELLED_LEAD,
	payCloseAt,
	WITHDRAWN_EARLY_MARGIN_MS,
	withdrawnBecause,
	startPayDeadline,
	type PayDeadlineEnv,
} from "../src/lib/pay-deadline.js";

const DEADLINE = "2026-10-03T10:13:57.000Z";
const SERVER_NOW = "2026-10-03T09:59:00.000Z"; // 14 min 57 s left at render
const LEFT_MS = Date.parse(DEADLINE) - Date.parse(SERVER_NOW);

/** A clock and a timer queue the test advances by hand. */
function fakeEnv(start: number): PayDeadlineEnv & {
	advance(ms: number): void;
	jump(ms: number): void;
	pending(): number;
} {
	let now = start;
	let seq = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		setTimer(fn, ms) {
			const id = ++seq;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimer(handle) {
			timers.delete(handle as number);
		},
		/** Time passes and timers fire on schedule. */
		advance(ms) {
			now += ms;
			for (const [id, t] of timers) {
				if (t.at <= now) {
					timers.delete(id);
					t.fn();
				}
			}
		},
		/** Time passes with NO timer firing — a throttled or sleeping tab. */
		jump(ms) {
			now += ms;
		},
		pending: () => timers.size,
	};
}

function recorder() {
	const port = { closes: 0, close: () => void port.closes++ };
	return port;
}

describe("payCloseAt — the server's deadline, measured on the browser's clock", () => {
	test("is the time the server said was left, counted from the page load", () => {
		expect(payCloseAt(DEADLINE, SERVER_NOW, 1_000)).toBe(1_000 + LEFT_MS);
	});

	test("a browser clock that is wrong by hours changes nothing about WHEN it closes", () => {
		const slow = Date.parse(SERVER_NOW) - 10 * 60_000;
		const fast = Date.parse(SERVER_NOW) + 3 * 3_600_000;
		expect(payCloseAt(DEADLINE, SERVER_NOW, slow)! - slow).toBe(LEFT_MS);
		expect(payCloseAt(DEADLINE, SERVER_NOW, fast)! - fast).toBe(LEFT_MS);
	});

	test("an unreadable instant states no deadline (never locks out a payable order)", () => {
		expect(payCloseAt(undefined, SERVER_NOW, 0)).toBeNull();
		expect(payCloseAt(DEADLINE, undefined, 0)).toBeNull();
		expect(payCloseAt("soon", SERVER_NOW, 0)).toBeNull();
		expect(payCloseAt(DEADLINE, "", 0)).toBeNull();
		expect(isPayClosed(null, Number.MAX_SAFE_INTEGER)).toBe(false);
	});
});

describe("startPayDeadline", () => {
	test("closes the page AT the deadline, once — not a moment before", () => {
		const env = fakeEnv(0);
		const port = recorder();
		const deadline = startPayDeadline(payCloseAt(DEADLINE, SERVER_NOW, 0), port, env);

		env.advance(LEFT_MS - 1);
		expect(port.closes).toBe(0);
		expect(deadline.allowSubmit()).toBe(true);

		env.advance(1);
		expect(port.closes).toBe(1);
		expect(deadline.closed).toBe(true);

		env.advance(60_000);
		deadline.check();
		expect(port.closes, "closes once").toBe(1);
		expect(env.pending(), "nothing left armed").toBe(0);
	});

	test("a SLEEPING tab whose timer never fired closes the moment it is checked on waking", () => {
		const env = fakeEnv(0);
		const port = recorder();
		const deadline = startPayDeadline(payCloseAt(DEADLINE, SERVER_NOW, 0), port, env);

		env.jump(LEFT_MS + 5 * 60_000);
		expect(port.closes).toBe(0);
		expect(deadline.check()).toBe(true);
		expect(port.closes).toBe(1);
	});

	test("a submit after the deadline is REFUSED and closes the page — even if no timer fired", () => {
		const env = fakeEnv(0);
		const port = recorder();
		const deadline = startPayDeadline(payCloseAt(DEADLINE, SERVER_NOW, 0), port, env);

		env.jump(LEFT_MS + 3_000); // QA2: the stale tab clicked Pay 3 s late
		expect(deadline.allowSubmit()).toBe(false);
		expect(port.closes).toBe(1);
		expect(deadline.allowSubmit(), "and every one after").toBe(false);
	});

	test("a page loaded already past its deadline closes at once", () => {
		const env = fakeEnv(0);
		const port = recorder();
		startPayDeadline(payCloseAt(SERVER_NOW, DEADLINE, 0), port, env);
		expect(port.closes).toBe(1);
	});

	test("no readable deadline: nothing armed, every submit allowed", () => {
		const env = fakeEnv(0);
		const port = recorder();
		const deadline = startPayDeadline(null, port, env);
		env.jump(365 * 24 * 3_600_000);
		expect(deadline.allowSubmit()).toBe(true);
		expect(port.closes).toBe(0);
		expect(env.pending()).toBe(0);
	});

	test("a deadline beyond a browser timer's range re-arms instead of firing early", () => {
		const env = fakeEnv(0);
		const port = recorder();
		const far = 30 * 24 * 3_600_000; // 30 days: > 2^31 − 1 ms
		startPayDeadline(far, port, env);
		env.advance(2_147_483_647);
		expect(port.closes).toBe(0);
		env.advance(far - 2_147_483_647);
		expect(port.closes).toBe(1);
	});
});

describe("an intent withdrawn BEFORE the deadline means the order was cancelled (QA3 N4)", () => {
	// After "Start a new cart" the old pay tab said "The time to pay has run out" —
	// but nothing ran out: the order was cancelled, and its intent withdrawn with it.
	const closeAt = 1_000_000;

	test("well before the page's own deadline, a withdrawn intent reads as a cancelled order", () => {
		expect(withdrawnBecause(closeAt, closeAt - 10 * 60_000)).toBe("cancelled");
		expect(PAY_CANCELLED_LEAD).toBe("This order was cancelled.");
	});

	test("at or near the deadline it is the time running out — the server withdraws at the deadline, and the page closes a little late", () => {
		expect(withdrawnBecause(closeAt, closeAt)).toBe("closed");
		expect(withdrawnBecause(closeAt, closeAt - WITHDRAWN_EARLY_MARGIN_MS + 1)).toBe("closed");
		expect(withdrawnBecause(closeAt, closeAt + 5_000)).toBe("closed");
	});

	test("with no readable deadline it says nothing it cannot know: the closed notice", () => {
		expect(withdrawnBecause(null, 0)).toBe("closed");
	});
});
