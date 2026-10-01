/**
 * Which cart line carries the green stamp (theme-briefs.md §3, "Signature:
 * the stamp"; "Never: stamp more than one thing per view").
 *
 * The bag page stamps exactly one line: the NEWEST live hold — the line whose
 * hold runs out last, which is the one the shopper most recently set aside (an
 * add, or a quantity change that took a fresh reservation). Every other line
 * states its hold in plain printed words. The choice is a pure function of the
 * lines the page already read. Whether the stamp also LANDS (animates) is a
 * separate question — only on add, when that hold was just taken
 * (`isFreshHold`, `lib/hold.ts`); on any other render it is simply there.
 *
 * Ties (two lines reserved in the same instant) go to the later line — the one
 * drawn lower, nearer the summary. A line with no reservation, or whose hold
 * has already been released, is never stamped.
 */
import { holdView } from "../../lib/hold.js";

export interface HeldLine {
	lineId: string;
	expiresAt: string | null;
}

export function stampedLineId(lines: readonly HeldLine[], now: Date = new Date()): string | null {
	let best: { id: string; at: number } | null = null;
	for (const line of lines) {
		const view = holdView(line.expiresAt, now);
		if (view === null || view.state === "released" || line.expiresAt === null) continue;
		const at = Date.parse(line.expiresAt);
		if (best === null || at >= best.at) best = { id: line.lineId, at };
	}
	return best?.id ?? null;
}
