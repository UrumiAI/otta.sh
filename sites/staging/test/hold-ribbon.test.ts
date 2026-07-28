/**
 * HoldRibbon (docs/theme/TEMPERED.md §6) — the signature element.
 *
 * Two of these assertions guard properties that a screenshot cannot see and
 * that a reviewer would have to read three files to verify:
 *
 *  - the animated fill sits inside a `data-motion="essential"` wrapper, which
 *    is what exempts the COUNTDOWN from tokens.css's reduced-motion clamp
 *    while leaving the decorative indeterminate sweep subject to it;
 *  - the inline script's three state labels are byte-identical to the ones the
 *    server rendered from `src/lib/hold.ts`. The script cannot import the
 *    module, so the duplication is unavoidable — this is the thing that stops
 *    it drifting into "Reserved" on the client and "Held for you" on the
 *    server.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import HoldRibbon from "../src/components/HoldRibbon.astro";
import {
	HOLD_EXPIRING_SECONDS,
	HOLD_LABELS,
	HOLD_RELEASED_NEXT_STEP,
	HOLD_WINDOW_SECONDS,
} from "../src/lib/hold.js";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const render = (props: Record<string, unknown>): Promise<string> =>
	container.renderToString(HoldRibbon, { props });

/** An ISO expiry `seconds` from now — the shape the cart wire carries. */
const inSeconds = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

/** The rendered fill width, as a number. */
function fillPercent(html: string): number {
	return Number(/--pct: ([\d.]+)%/.exec(html)?.[1] ?? Number.NaN);
}

/**
 * The container emits the component's bundled `<script>` tag whether or not
 * the component rendered any markup, so "renders nothing" means "no ribbon",
 * not "an empty string".
 */
function markupOnly(html: string): string {
	return html.replace(/<script[^>]*><\/script>/g, "").trim();
}

describe("HoldRibbon — the three states", () => {
	test("held: violet, the default, and the fill is nearly full", async () => {
		const html = await render({ expiresAt: inSeconds(540) });
		expect(html).toContain('data-state="held"');
		expect(html).toContain(HOLD_LABELS.held);
		expect(fillPercent(html)).toBeGreaterThan(85);
		expect(fillPercent(html)).toBeLessThanOrEqual(100);
	});

	test("expiring: under the boundary it changes what it calls itself", async () => {
		const html = await render({ expiresAt: inSeconds(HOLD_EXPIRING_SECONDS - 15) });
		expect(html).toContain('data-state="expiring"');
		expect(html).toContain(HOLD_LABELS.expiring);
		expect(html).not.toContain(HOLD_LABELS.held);
	});

	test("released: dashed, muted, and it says what to do next (§6)", async () => {
		const html = await render({ expiresAt: inSeconds(-30) });
		expect(html).toContain('data-state="released"');
		expect(html).toContain(HOLD_LABELS.released);
		expect(html).toContain(HOLD_RELEASED_NEXT_STEP);
		expect(html).not.toContain("hidden");
	});

	test("the next-step line is always in the markup, hidden until it applies", async () => {
		// The state can flip while the page is open. If the line only existed
		// when the SERVER saw it released, a hold that lapsed under the
		// shopper's eyes would go grey and offer no way forward.
		const html = await render({ expiresAt: inSeconds(540) });
		expect(html).toContain(HOLD_RELEASED_NEXT_STEP);
		expect(html).toMatch(/data-hold-note[^>]*hidden/);
	});

	test("the next-step copy is the page's to override", async () => {
		expect(
			await render({ expiresAt: inSeconds(-1), nextStep: "Add it again to hold it." }),
		).toContain("Add it again to hold it.");
	});
});

describe("HoldRibbon — what it refuses to claim", () => {
	test("a line that never took a reservation gets no ribbon", async () => {
		// `expiresAt: null` is "no hold was taken", not "the hold ran out".
		expect(markupOnly(await render({ expiresAt: null }))).toBe("");
	});

	test("an unparseable expiry renders nothing rather than NaN", async () => {
		expect(markupOnly(await render({ expiresAt: "soon" }))).toBe("");
	});
});

describe("HoldRibbon — motion, and the reduced-motion contract (§6, §11)", () => {
	test("the animated fill is inside a data-motion=essential wrapper", async () => {
		const html = await render({ expiresAt: inSeconds(300) });
		const wrapper = /<div class="track[^"]*"[^>]*data-motion="essential"[^>]*>\s*<div class="fill/;
		expect(html).toMatch(wrapper);
	});

	test("the countdown carries the data the client script needs to keep ticking", async () => {
		const html = await render({ expiresAt: inSeconds(300), windowSeconds: 900 });
		expect(html).toContain("data-hold");
		expect(html).toMatch(/data-expires="[^"]+"/);
		expect(html).toContain('data-window="900"');
	});

	test("defaults the window to the service's hold TTL", async () => {
		expect(await render({ expiresAt: inSeconds(300) })).toContain(
			`data-window="${HOLD_WINDOW_SECONDS}"`,
		);
	});

	test("the fill is rounded, not a float with sixteen digits in the markup", async () => {
		const raw = /--pct: ([\d.]+)%/.exec(await render({ expiresAt: inSeconds(299) }))?.[1] ?? "";
		expect(raw).toMatch(/^\d+\.\d$/);
	});
});

describe("HoldRibbon — the no-JavaScript value (§6)", () => {
	test("the mono slot ships the ABSOLUTE expiry, not a countdown that goes stale", async () => {
		const html = await render({ expiresAt: "2026-07-28T14:10:32.000Z" });
		expect(html).toContain("14:10:32 UTC");
		// A frozen mm:ss would be a lie one second after it was printed.
		expect(html).not.toMatch(/data-hold-clock[^>]*>\s*\d\d:\d\d\s*</);
	});

	test("the zone is named, because the server cannot know the shopper's", async () => {
		expect(await render({ expiresAt: "2026-07-28T04:05:06.000Z" })).toContain("04:05:06 UTC");
	});
});

describe("HoldRibbon — what a screen reader hears", () => {
	test("the countdown is a timer, which is an aria-live=off region by definition", async () => {
		const html = await render({ expiresAt: inSeconds(300) });
		expect(html).toContain('role="timer"');
	});

	test("the CLOCK is never a live region — once a second is not an announcement", async () => {
		const html = await render({ expiresAt: inSeconds(300) });
		expect(html).not.toMatch(/data-hold-clock[^>]*aria-live/);
	});

	test("a separate polite region carries the state change, and starts empty", async () => {
		const html = await render({ expiresAt: inSeconds(300) });
		expect(html).toMatch(/aria-live="polite"/);
		expect(html).toContain("data-hold-announce");
		expect(html).toContain("u-sr-only");
		// Empty on first render: the server-rendered state is already in the
		// label beside it, so announcing it on load would be a duplicate.
		expect(html).toMatch(/data-hold-announce[^>]*aria-live="polite"[^>]*>\s*<\/span>/);
	});
});

describe("HoldRibbon — indeterminate, for a pending order (§6)", () => {
	test("renders the poll count in mono: Checking 3 of 8", async () => {
		const html = await render({ variant: "indeterminate", poll: 3, pollMax: 8 });
		expect(html).toContain("Checking");
		expect(html).toContain("3");
		expect(html).toContain("8");
		expect(html).toContain("sweep");
	});

	test("the label is overridable", async () => {
		expect(
			await render({ variant: "indeterminate", poll: 1, pollMax: 8, label: "Confirming" }),
		).toContain("Confirming");
	});

	test("it is NOT exempt from reduced motion — the sweep is decoration", async () => {
		// The count beside it is the information. Only the countdown, which a
		// shopper is timing a decision against, gets the exemption.
		const html = await render({ variant: "indeterminate", poll: 3, pollMax: 8 });
		expect(html).not.toContain('data-motion="essential"');
	});

	test("carries no countdown machinery — there is no duration to drain", async () => {
		const html = await render({ variant: "indeterminate", poll: 3, pollMax: 8 });
		expect(html).not.toContain("data-hold-clock");
		expect(html).not.toContain("data-expires");
	});
});

describe("HoldRibbon — the client script", () => {
	const source = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../src/components/HoldRibbon.astro",
		),
		"utf8",
	);
	const script = source.slice(source.indexOf("<script>"), source.indexOf("</script>"));

	test("its three labels are byte-identical to the ones the server rendered", () => {
		for (const label of Object.values(HOLD_LABELS)) {
			expect(script, `the script and src/lib/hold.ts disagree about "${label}"`).toContain(
				`"${label}"`,
			);
		}
	});

	test("it flips at the same boundary the server does", () => {
		expect(script).toContain(`left <= ${HOLD_EXPIRING_SECONDS}`);
		expect(script).toContain("left <= 0");
	});

	test("it stops once every hold on the page has lapsed", () => {
		// A once-a-second timer that outlives everything it was counting keeps
		// a tab awake for nothing.
		expect(script).toContain("clearInterval(timer)");
	});

	test("it announces the STATE, never the tick", () => {
		// A live region on the clock would announce six hundred times in a
		// ten-minute hold. The transition is what a shopper needs told.
		expect(script).toContain("state !== r.state");
		expect(script).toMatch(/announce\.textContent = LABELS\[state\]/);
	});

	test("it clamps the fill rather than overflowing the track", () => {
		expect(script).toContain("Math.min(100");
		expect(script).toContain("Math.max(0");
	});

	test("it ticks once a second, from ONE interval shared by every ribbon", () => {
		expect(script).toContain("setInterval(tick, 1000)");
		expect(script.match(/setInterval/g) ?? []).toHaveLength(1);
	});

	test("it renders the first frame immediately, before waiting a second", () => {
		// A bare top-level call, not only the one inside setInterval — otherwise
		// the server's absolute-expiry text sits there for a second before the
		// countdown appears.
		expect(script).toMatch(/^\s*tick\(\);\s*$/m);
	});

	test("the timer exists before the first tick, which may need to clear it", () => {
		// `tick()` calls `clearInterval(timer)` when everything has lapsed, so
		// running it ahead of the assignment would throw on a page whose holds
		// are all already released.
		expect(script.indexOf("const timer = setInterval")).toBeLessThan(
			script.search(/^\s*tick\(\);\s*$/m),
		);
	});

	test("it is a bundled module script, not an inline one — one copy per page", () => {
		expect(source).not.toContain("<script is:inline");
	});

	test("it reveals the next-step line when a hold lapses under the shopper's eyes", () => {
		expect(script).toContain('r.note.hidden = state !== "released"');
	});
});
