/**
 * HoldRibbon (docs/theme/TEMPERED.md §6) — the signature element.
 *
 * Two of these assertions guard properties that a screenshot cannot see and
 * that a reviewer would have to read three files to verify:
 *
 *  - the animated fill sits inside a `data-motion="essential"` wrapper, which
 *    is what exempts the COUNTDOWN from tokens.css's reduced-motion clamp.
 *    The decorative indeterminate sweep is a different component entirely
 *    (`PollRibbon`, which ships no script) and is covered by its own suite;
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
import { hasExecutableScript, templateOf } from "./astro-source.js";

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
	// Peel EMPTY script elements off the front, one at a time, by scanning rather
	// than a tag regex. A script with a body, or anything else, stops the peel and
	// stays in the result, so the "renders nothing" assertions can't be fooled.
	let rest = html.trim();
	for (;;) {
		const lower = rest.toLowerCase();
		if (!lower.startsWith("<script")) return rest;
		const openEnd = rest.indexOf(">");
		if (openEnd < 0 || !lower.startsWith("</script", openEnd + 1)) return rest;
		const closeEnd = rest.indexOf(">", openEnd + 1);
		if (closeEnd < 0) return rest;
		rest = rest.slice(closeEnd + 1).trim();
	}
}

describe("HoldRibbon — the three states", () => {
	test("held: violet, the default, and the fill is nearly full", async () => {
		// Nine tenths of the window left, derived — a fill "nearly full" is a
		// fraction of the TTL, not a fixed number of seconds.
		const html = await render({ expiresAt: inSeconds(HOLD_WINDOW_SECONDS * 0.9) });
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
		// A window that is NOT the default, so this pins the prop being emitted
		// rather than agreeing with `HOLD_WINDOW_SECONDS` by coincidence.
		const html = await render({ expiresAt: inSeconds(300), windowSeconds: 1200 });
		expect(html).toContain("data-hold");
		expect(html).toMatch(/data-expires="[^"]+"/);
		expect(html).toContain('data-window="1200"');
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

/**
 * The countdown's script lives in `HoldClock.astro` since the storefront-themes
 * Phase 3 split: theme views draw ribbons (this one, or their own from the same
 * `data-hold*` hooks) and the cart PAGE renders the one script. These are the
 * assertions the script always carried, aimed at where it now lives — and the
 * ribbon itself is pinned below to carry none.
 */
describe("HoldRibbon — the ribbon is markup, and ships no script", () => {
	const ribbon = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../src/components/HoldRibbon.astro",
		),
		"utf8",
	);

	test("no <script> in the ribbon — a view may import it without shipping JavaScript", () => {
		expect(hasExecutableScript(ribbon)).toBe(false);
	});

	test("it still ships every hook the countdown writes", () => {
		for (const hook of [
			"data-hold",
			"data-state=",
			"data-expires=",
			"data-window=",
			"data-hold-fill",
			"data-hold-label",
			"data-hold-clock",
			"data-hold-note",
			"data-hold-announce",
		]) {
			expect(ribbon, `the ribbon no longer renders ${hook}`).toContain(hook);
		}
	});
});

describe("HoldClock — the client script", () => {
	const source = readFileSync(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/components/HoldClock.astro"),
		"utf8",
	);

	// Found by the same tag shape the strip below uses, so an attribute on the
	// tag cannot leave the checks that read `script` reading an empty string.
	const script = source.slice(source.search(/<script\b/i), source.search(/<\/script\b/i));

	test("it is the script and ONLY the script — no markup of its own", () => {
		expect(hasExecutableScript(source)).toBe(true);
		expect(script, "the script body was not found").not.toBe("");
		// A space, not "", so the strip cannot splice a new `<script` together.
		const template = templateOf(source)
			.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
			.trim();
		expect(template).toBe("");
	});
	test("it is a bundled module script, not an inline one — one copy per page", () => {
		// This is what lets it IMPORT the tick instead of restating it, which is
		// the whole reason the assertions below can be about structure rather
		// than about substrings.
		expect(source).not.toContain("<script is:inline");
	});

	test("it takes the tick from the shared module rather than owning one", () => {
		expect(script).toContain('from "../lib/hold-ribbon.js"');
		expect(script).toContain("startHoldRibbons(");
		// `hold-ribbon-tick.test.ts` drives that module against a fake clock:
		// the five-minute jump, the once-per-transition announcement, and the
		// interval dropping itself.
	});

	test("it restates none of the labels the server rendered", () => {
		// The old script carried its own copy of the three, pinned to
		// `src/lib/hold.ts` by this suite reading both. One definition is
		// better than two that agree today, so the duplication is gone and this
		// is the assertion that it stays gone.
		for (const label of Object.values(HOLD_LABELS)) {
			expect(script, `the script has re-declared "${label}"`).not.toContain(`"${label}"`);
		}
	});

	test("it restates none of the arithmetic either — no boundary, no clock format", () => {
		expect(script, "a duplicated expiring boundary").not.toContain(`${HOLD_EXPIRING_SECONDS}`);
		expect(script, "a duplicated window default").not.toContain(`${HOLD_WINDOW_SECONDS}`);
		expect(script, "a duplicated tick rate").not.toMatch(/setInterval/);
		expect(script, "a duplicated mm:ss").not.toContain("padStart");
	});

	test("what is left is the DOM, and every slot the markup ships is written", () => {
		// The script's remaining job is to find the elements and put a frame in
		// them. Each of these selectors has a matching assertion above that the
		// server actually renders it.
		for (const hook of [
			"[data-hold]",
			"[data-hold-fill]",
			"[data-hold-label]",
			"[data-hold-clock]",
			"[data-hold-note]",
			"[data-hold-announce]",
			// The time in words ("14 min left", "42 sec"): opt-in slots a theme
			// ships only when it draws them.
			"[data-hold-minutes]",
			"[data-hold-seconds]",
		]) {
			expect(script, `the script never looks for ${hook}`).toContain(hook);
		}
		// `data-minutes` is kept current ONLY on a root that shipped it, so no
		// other theme's ribbon gains an attribute it never drew.
		expect(script).toContain("const tracksMinutes = el.dataset.minutes !== undefined;");
		expect(script).toContain("if (tracksMinutes) el.dataset.minutes = String(frame.minutesLeft);");
		// `data-expires` / `data-window`, as the DOM spells them.
		expect(script).toContain("dataset.expires");
		expect(script).toContain("dataset.window");
	});

	test("it reveals the next-step line when a hold lapses under the shopper's eyes", () => {
		expect(script).toContain('note.hidden = frame.state !== "released"');
	});

	test("it writes the polite region only on a frame that announced", () => {
		// The decision is the module's; the script must not second-guess it by
		// writing the label on every frame.
		expect(script).toContain("frame.announce !== null");
		expect(script.match(/announce\.textContent/g) ?? []).toHaveLength(1);
	});
});
