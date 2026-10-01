/**
 * Which cart line hops into the bag (theme-briefs.md §4, "Signature: hop to
 * the bag"; one flying element per view).
 *
 * The candidate is the NEWEST live hold — the line whose hold runs out last,
 * which is the one the shopper most recently put in the bag (an add, or a
 * quantity change that took a fresh reservation) — a pure function of the
 * lines the page already read (the same rule Batch's stamp follows). It hops
 * only ON ADD: `CartView.astro` also asks `isFreshHold` (`lib/hold.ts`), so a
 * reload, a revisit or a change to another line draws no flight.
 *
 * Ties (two lines reserved in the same instant) go to the later line — the one
 * drawn lower. A line with no reservation, or whose hold has already been
 * released, never hops: nothing was just put in the bag.
 */
import { holdView } from "../../lib/hold.js";

export interface HeldLine {
	lineId: string;
	expiresAt: string | null;
}

export function hopLineId(lines: readonly HeldLine[], now: Date = new Date()): string | null {
	let best: { id: string; at: number } | null = null;
	for (const line of lines) {
		if (line.expiresAt === null) continue;
		const view = holdView(line.expiresAt, now);
		if (view === null || view.state === "released") continue;
		const at = Date.parse(line.expiresAt);
		if (best === null || at >= best.at) best = { id: line.lineId, at };
	}
	return best?.id ?? null;
}
