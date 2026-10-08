/**
 * The look of the `otta` plugin's Block Kit accordions — the collapsible
 * sections on Reports, Settings, Tax, Shipping and Coupons (and any other
 * `otta` Block Kit page that groups its content in them).
 *
 * WHY THIS LIVES IN THE CONSOLE. `@otta-sh/plugin` is `format: "standard"` and
 * speaks Block Kit only: it sends `{ type: "accordion", label, blocks }` and
 * EmDash 1.x draws it with Kumo's `Collapsible.DefaultTrigger` — a bare blue
 * link and a chevron, with the body hung off a grey left rule. Block Kit has no
 * style field, and EmDash's admin shell has no stylesheet hook for plugins.
 * This module is already imported into every admin page by EmDash's generated
 * registry (it is the `adminEntry` of `otta-console`), so it is the one place a
 * rule can reach those blocks without forking EmDash.
 *
 * WHY EACH SELECTOR IS SAFE (verified against emdash 1.0.1, @emdash-cms/blocks
 * 1.0.1, @cloudflare/kumo 2.6.0):
 *
 * - SCOPE — `:root:has(a[aria-current="page"][href^="/_emdash/admin/plugins/otta/"])`.
 *   The sidebar's link to the page being viewed carries `aria-current="page"`
 *   (TanStack Router's active-link contract, an accessibility attribute, not a
 *   class), and the admin router's basepath is fixed at `/_emdash/admin`. So
 *   the sheet applies only while one of the `otta` plugin's own pages is open:
 *   other plugins' Block Kit pages, dashboard widgets and content-editor panels
 *   keep EmDash's look. `otta/` with its slash does not match `otta-console/`.
 * - ROOT — `[data-testid="collapsible"]`, and only when it holds Kumo's
 *   default trigger. The test id is set by `@emdash-cms/blocks`' accordion
 *   renderer and by nothing else in the admin.
 * - TRIGGER / PANEL — Kumo's `data-kumo-part="default-trigger"` (its own
 *   styling hook) and Base UI's `aria-controls` → `id` pairing for the panel,
 *   plus Base UI's `data-panel-open`, `data-starting-style` and
 *   `data-ending-style` state attributes.
 *
 * Every rule needs the test id AND the default trigger, so if an EmDash or
 * Kumo upgrade renames either, the whole sheet stops matching at once and the
 * accordions fall back to Kumo's default: nothing breaks, it just looks plain
 * (no half-styled card around a blue-link trigger).
 *
 * THE DESIGN. Each accordion is a row on the admin's card surface (`base` on
 * the `elevated` page, `line` border, `radius-lg` — the same recipe as the
 * Reports stat cards), with a full-width trigger: the label in the default ink
 * at medium weight, the chevron on the trailing edge in the subtle ink, which
 * darkens to the default ink when the row is hovered (pointer devices only, so
 * a tap does not leave a sticky tint) or open. Neighbouring accordions join
 * into one grouped list (each block arrives in its own wrapper `div` inside a
 * `gap-4` column, hence the `:has()` selectors and the `-1rem - 1px` pull that
 * closes the gap and overlaps the shared border). An open row is divided from
 * its body by a hairline; the body loses Kumo's left rule. The panel's height
 * eases open and closed from Base UI's measured `--collapsible-panel-height`;
 * the panel itself has no padding (its single content wrapper carries it), so
 * that measurement is the full height and the ease ends without a jump. The
 * chevron's turn is Kumo's `rotate` (Tailwind v4 compiles `rotate-180` to the
 * `rotate` property, not `transform`), so that is what transitions. All
 * motion drops under `prefers-reduced-motion`. Every colour is a Kumo
 * token, so the classic light theme and the dark mode both carry over; the
 * fallbacks are system colours for a shell without them.
 *
 * Kumo's utilities live in a cascade layer, so these unlayered rules win
 * without `!important`.
 */

/** The `id` of the injected `<style>` element; mounting twice never stacks copies. */
export const BLOCK_KIT_ACCORDION_STYLE_ID = "otta-block-kit-accordion";

/** The sidebar link to the page being viewed, when that page is the `otta` plugin's. */
export const OTTA_CURRENT_PAGE_LINK =
	'a[aria-current="page"][href^="/_emdash/admin/plugins/otta/"]';

/** Matches only while one of the `otta` plugin's admin pages is open. */
export const OTTA_PAGE_SCOPE = `:root:has(${OTTA_CURRENT_PAGE_LINK})`;

/** A Block Kit accordion that still renders Kumo's default trigger. */
const ACCORDION = '[data-testid="collapsible"]:has(> [data-kumo-part="default-trigger"])';
const ROOT = `${OTTA_PAGE_SCOPE} ${ACCORDION}`;
/**
 * The wrapper `div` around one accordion. Spelled out rather than built from
 * `ACCORDION`: `:has()` may not nest inside another `:has()`, and a browser
 * drops the whole rule that tries (see the test that guards this).
 */
const WRAPPER = 'div:has(> [data-testid="collapsible"] > [data-kumo-part="default-trigger"])';
const TRIGGER = `${ROOT} > [data-kumo-part="default-trigger"]`;
const PANEL = `${TRIGGER} + [id]`;

const BASE = "var(--color-kumo-base, Canvas)";
const LINE = "var(--color-kumo-line, color-mix(in srgb, CanvasText 12%, transparent))";
const HAIRLINE = "var(--color-kumo-hairline, color-mix(in srgb, CanvasText 8%, transparent))";
const TINT = "var(--color-kumo-tint, color-mix(in srgb, CanvasText 5%, transparent))";
const INK = "var(--text-color-kumo-default, CanvasText)";
const SUBTLE = "var(--text-color-kumo-subtle, GrayText)";
const FOCUS = "var(--color-kumo-brand, Highlight)";
const RADIUS = "var(--radius-lg, 0.5rem)";
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export const BLOCK_KIT_ACCORDION_STYLES = `
${ROOT} {
	background: ${BASE};
	border: 1px solid ${LINE};
	border-radius: ${RADIUS};
	overflow: hidden;
}
${OTTA_PAGE_SCOPE} ${WRAPPER}:has(+ div > [data-testid="collapsible"] > [data-kumo-part="default-trigger"]) > ${ACCORDION} {
	border-end-start-radius: 0;
	border-end-end-radius: 0;
}
${OTTA_PAGE_SCOPE} ${WRAPPER} + ${WRAPPER} > ${ACCORDION} {
	margin-block-start: calc(-1rem - 1px);
	border-start-start-radius: 0;
	border-start-end-radius: 0;
}
${TRIGGER} {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	inline-size: 100%;
	min-block-size: 48px;
	padding: 10px 12px 10px 16px;
	font-size: 14px;
	font-weight: 500;
	line-height: 20px;
	text-align: start;
	color: ${INK};
	background: transparent;
	transition: background-color 120ms ease-out;
}
${TRIGGER}:focus-visible {
	outline: 2px solid ${FOCUS};
	outline-offset: -2px;
}
${TRIGGER} > svg {
	flex: none;
	box-sizing: content-box;
	inline-size: 16px;
	block-size: 16px;
	padding: 4px;
	color: ${SUBTLE};
	transition: rotate 240ms ${EASE}, transform 240ms ${EASE}, color 120ms ease-out;
}
${TRIGGER}[data-panel-open] {
	box-shadow: inset 0 -1px 0 ${HAIRLINE};
}
${TRIGGER}[data-panel-open] > svg {
	color: ${INK};
}
@media (hover: hover) {
	${TRIGGER}:hover {
		background: color-mix(in srgb, ${TINT} 60%, transparent);
	}
	${TRIGGER}:hover > svg {
		color: ${INK};
	}
}
${PANEL} {
	margin: 0;
	padding: 0;
	border-inline-start: 0;
	overflow: hidden;
	block-size: var(--collapsible-panel-height);
	transition: block-size 240ms ${EASE}, opacity 200ms ease-out;
}
${PANEL} > * {
	padding: 16px 16px 20px;
}
${PANEL}[data-starting-style],
${PANEL}[data-ending-style] {
	block-size: 0;
	opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
	${TRIGGER}, ${TRIGGER} > svg, ${PANEL} { transition: none; }
}
`;

/**
 * Adds the sheet to `doc.head` once. Called at import time by `./admin.tsx`;
 * a document-less environment (the Worker, SSR, node tests) is skipped. A
 * second evaluation (a hot reload) refreshes the existing sheet's text rather
 * than stacking a copy or keeping a stale one.
 */
export function mountBlockKitAccordionStyles(
	doc: Document | undefined = globalThis.document,
): void {
	if (doc === undefined) return;
	const existing = doc.getElementById(BLOCK_KIT_ACCORDION_STYLE_ID);
	if (existing !== null) {
		existing.textContent = BLOCK_KIT_ACCORDION_STYLES;
		return;
	}
	const style = doc.createElement("style");
	style.id = BLOCK_KIT_ACCORDION_STYLE_ID;
	style.textContent = BLOCK_KIT_ACCORDION_STYLES;
	doc.head.append(style);
}
