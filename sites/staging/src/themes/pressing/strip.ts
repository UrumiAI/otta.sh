/**
 * Which hold Pressing's bag strip counts (theme-briefs.md §2, "BAG STRIP").
 *
 * The strip shows ONE countdown for the whole bag, so it must be the one that
 * matters: the live hold that runs out FIRST. That is the deadline for checking
 * out with everything still set aside; a later hold would promise time the
 * shopper does not have for the other lines. Each bag line also carries its
 * own small hold chip, so no line's time goes unsaid.
 *
 * When no hold is live but some line took one, the strip says so honestly
 * (the hold released LAST). A line with no reservation never counts: an absent
 * hold and a lapsed one are different facts (`lib/hold.ts`).
 *
 * Pure, over the lines a page already read — the same shape of choice as
 * Batch's stamp and Jumble's hop.
 */
import { holdView, wallClock } from "../../lib/hold.js";

export interface HeldLine {
	expiresAt: string | null;
}

export function stripLine<T extends HeldLine>(
	lines: readonly T[],
	now: Date = new Date(),
): T | null {
	let live: { line: T; at: number } | null = null;
	let released: { line: T; at: number } | null = null;
	for (const line of lines) {
		if (line.expiresAt === null) continue;
		const view = holdView(line.expiresAt, now);
		if (view === null) continue;
		const at = Date.parse(line.expiresAt);
		if (view.state === "released") {
			if (released === null || at > released.at) released = { line, at };
		} else if (live === null || at < live.at) {
			live = { line, at };
		}
	}
	return live?.line ?? released?.line ?? null;
}

/**
 * "4:52 pm UTC" as its two sizes: the figure the strip sets big ("4:52") and
 * the rest ("pm UTC"), which it sets small so the no-script clock fits a phone.
 * `null` for an expiry that does not parse.
 */
export function stripWallClock(expiresAt: string): { time: string; rest: string } | null {
	const clock = wallClock(expiresAt);
	if (clock === null) return null;
	const at = clock.indexOf(" ");
	return { time: clock.slice(0, at), rest: clock.slice(at + 1) };
}
