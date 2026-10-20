/**
 * The console's shared presentation primitives.
 *
 * NO COMPONENT LIBRARY, still. INC-19 measured `@cloudflare/kumo` and
 * `@phosphor-icons/react` as unresolvable and unnecessary, and ADR-0014 records
 * adopting either as "a deliberate new coupling to an unpinned component
 * library, not a requirement". Nothing here changes that: `react` and `emdash`
 * remain this package's only peers.
 *
 * TWO RULES GOVERN EVERY STYLE IN THIS FILE.
 *
 *  1. **EmDash's tokens, not our own colours.** The console renders inside the
 *     EmDash admin, which defines Kumo's design tokens as CSS custom properties
 *     on the document (`--color-kumo-base`, `--color-kumo-line`,
 *     `--color-kumo-brand`, `--text-color-kumo-subtle`, …) and re-points them in
 *     dark mode. Every colour here is a `var(--token, fallback)` read through
 *     {@link KUMO}, so a button, a card or a badge is drawn in exactly the ink the
 *     admin's own screens use, in light and in dark, with no conditional colour
 *     of ours. The fallback is the old theme-neutral value (`currentColor`, an
 *     alpha grey), so outside the admin — a unit test, a bare page — the screen
 *     degrades to legible rather than to invisible. This supersedes the earlier
 *     "theme-neutral only" rule: that rule existed because this file could not
 *     know the background, and the tokens are how it now does.
 *  2. **Logical properties (G6).** `marginBlockEnd`, `borderInlineStart`,
 *     `textAlign: "start"` — the admin is RTL-capable and nothing here may pin
 *     to the left.
 *
 * WHY THERE IS A STYLESHEET AND NOT ONLY INLINE STYLES. Several things this
 * screen is required to have cannot be expressed as a style object: `:focus-visible`
 * (every interactive element needs a visible ring), `:hover` on a table row
 * (the full-row hover tint that makes a link in one cell read as "this row
 * opens") and on a button. All are pseudo-classes. The sheet is minimal and
 * mounted once.
 */
import * as React from "react";

/**
 * EmDash's design tokens, as the admin defines them at runtime (Kumo, the
 * design system `@emdash-cms/admin` is built on — read from its compiled
 * `styles.css`, never imported). Each is a `var()` with a theme-neutral
 * fallback; see rule 1 in the header.
 */
export const KUMO = {
	/** Body ink. */
	text: "var(--text-color-kumo-default, currentColor)",
	/** Secondary ink: dates, hints, captions. */
	subtle: "var(--text-color-kumo-subtle, color-mix(in srgb, currentColor 62%, transparent))",
	/** The card / button surface. */
	surface: "var(--color-kumo-base, transparent)",
	/** An input's fill. */
	control: "var(--color-kumo-control, transparent)",
	/** The border on cards, buttons and inputs. */
	line: "var(--color-kumo-line, rgba(128, 128, 128, 0.35))",
	/** A quieter divider. */
	hairline: "var(--color-kumo-hairline, rgba(128, 128, 128, 0.2))",
	/** Row dividers inside a table, a neutral badge's fill. */
	fill: "var(--color-kumo-fill, rgba(128, 128, 128, 0.2))",
	/** Hover wash. */
	tint: "var(--color-kumo-tint, rgba(128, 128, 128, 0.12))",
	brand: "var(--color-kumo-brand, #2563eb)",
	brandHover: "var(--color-kumo-brand-hover, #1d4ed8)",
	danger: "var(--color-kumo-danger, #dc2626)",
	dangerText: "var(--text-color-kumo-danger, #b91c1c)",
	focus: "var(--color-kumo-focus, currentColor)",
} as const;

const HAIRLINE = `1px solid ${KUMO.line}`;
/** The failure ink — EmDash's own status token, safe as text in both themes. */
export const FAIL_ACCENT = KUMO.dangerText;
/**
 * THE LOOK OF A CONTROL THAT IS PRESENT BUT CANNOT BE USED.
 *
 * TWO OVERCORRECTIONS, AND THIS IS THE MIDDLE. The first cut dropped the whole
 * button to `opacity: 0.45`, which took the 13px LABEL down with the border and
 * left a word a low-vision operator had to work to read. The second went the
 * other way — a near-invisible border and a token opacity — and made unavailable
 * and live nearly indistinguishable, which is worse: a control that looks
 * pressable and does nothing.
 *
 * SO THE STATE IS CARRIED BY THREE DECLARATIONS, and the point is WHICH of them
 * loses strength. A flat fill (the surface reads as inert rather than raised), a
 * border visibly lighter than {@link HAIRLINE} but still THERE, and a label
 * mixed down to 62% of the theme's own foreground.
 *
 * THE MIX IS AN ALPHA — that is exactly what `color-mix(…, transparent)` is, and
 * claiming otherwise would be dressing up the same technique in better words.
 * What makes it different from the `opacity` it replaces is WHERE it lands:
 * `opacity` fades the whole element, so the border and the fill that carry the
 * state fade at precisely the rate the label does, and the only way to keep the
 * state visible is to keep the label legible or vice versa. Here the fill and the
 * border stay at full strength and only the word is muted, so the two jobs stop
 * competing. 62% clears the contrast floor at this size while reading
 * unmistakably as "off"; it is stated against `currentColor` so it follows the
 * theme rather than pinning a grey that is legible in one of them.
 *
 * A whole `border` rather than a `border-color`: `.otta-btn` states the
 * shorthand, and mixing the two makes removals order-dependent. They are the
 * sheet's `[aria-disabled="true"]` rule now, not inline.
 */
const UNAVAILABLE_BORDER = `1px solid ${KUMO.hairline}`;
const UNAVAILABLE_FILL = KUMO.tint;
export const UNAVAILABLE_INK = "color-mix(in srgb, currentColor 62%, transparent)";

/**
 * The attribute a row carries its record id in.
 *
 * The id lives on the ROW rather than in a closure per row because activation is
 * ONE delegated listener on the table body — forty rows must not mean forty
 * listeners — and a delegated handler has nothing but the DOM to read the
 * record out of.
 */
export const ROW_ID_ATTRIBUTE = "data-row-id";

/**
 * Anything inside a row that already does something of its own. A click that
 * starts inside one of these is that control's click and never the row's.
 *
 * `code` IS DELIBERATELY ABSENT. The SKU cell is a `<code>`, and exempting it
 * would make the one cell an operator most needs to select the one cell that
 * does nothing — the selection guard below is what keeps it selectable, not an
 * exemption that would also make it dead.
 */
export const INTERACTIVE_DESCENDANT_SELECTOR = "a, button, input, select, textarea, summary, label";

/**
 * The subset of {@link INTERACTIVE_DESCENDANT_SELECTOR} whose cursor is reset
 * to `auto`. The link is deliberately absent here even though it stays in the
 * guard above: it goes to the same destination the row now does, so a pointer
 * over it is not the false promise the reset exists to prevent — only the
 * controls that do something else (Copy, form controls) fall back to `auto`.
 *
 * EVERY ENTRY HERE HAS TO TAKE ITS OWN POINTER FROM THE SHEET for the reset to
 * be worth anything. `summary` is the one that reads like an exception and is
 * not: it is listed here, and a disclosure whose pointer were declared inline
 * would outrank this rule exactly the way the buttons used to. (The console
 * itself renders no `<summary>` any more — EmDash shows no dropdowns — but the
 * entry stays so a host control inside a row keeps the same guarantee.)
 */
export const CURSOR_RESET_DESCENDANT_SELECTOR = "button, input, select, textarea, summary, label";

/**
 * How far the pointer may travel between `mousedown` and `click` and still count
 * as a click rather than a drag. Measured from the press to the CLICK — not to a
 * `mouseup` on some other element — or a careful click on a trackpad is
 * swallowed as a selection.
 */
export const ROW_ACTIVATION_SLOP_PX = 4;

/**
 * The stylesheet, mounted once by the screen.
 *
 * `:focus-visible` rather than `:focus` is deliberate: a mouse click on a button
 * should not leave a ring behind it, but every keyboard arrival must be visible.
 * The ring uses `outline` (not `border`) so it never reflows the control it is
 * on, and `outline-offset` keeps it clear of the element's own hairline.
 *
 * `.otta-link` IS WHY A DRILL-IN LOOKS LIKE ONE, and its whole reason for being
 * in the sheet rather than in a style object is that its states are pseudo-class
 * states: the rule under the word goes SOLID on `:hover` and on
 * `:focus-visible`. An inline `text-decoration-color` outranks both of those
 * triggers — the same trap `.otta-copy-reveal` documents for `opacity` — so the
 * colour is the sheet's, not the call site's. Both lists reach that solid state
 * through this one rule.
 *
 * ROW HOVER IS A THIRD TRIGGER AND IT BELONGS TO ONE LIST. F18 asks for it on
 * the Pricing title only — "the title link stays undecorated at rest and
 * underlines on row hover" — so it hangs off `.otta-link-row`, a modifier that
 * only that call site carries. Widening the selector back to `.otta-link` would
 * put a rule under the Orders prefix whenever a pointer crossed its row, which
 * is a state that item does not ask for.
 *
 * The REST state is the other thing the two lists differ on, and that too is the
 * item's wording rather than a house preference: the Orders prefix takes a muted
 * rule at 2px offset (its call site adds `text-decoration-line`), while the
 * Pricing title stays undecorated and takes this class's own `none`.
 */
export const CONSOLE_STYLES = `
.otta-focusable:focus-visible {
	outline: 2px solid ${KUMO.focus};
	outline-offset: 2px;
	border-radius: 4px;
}
.otta-row:hover {
	background: color-mix(in srgb, ${KUMO.tint} 50%, transparent);
}
.otta-row:focus-within {
	background: color-mix(in srgb, ${KUMO.tint} 70%, transparent);
}
.otta-td, .otta-th {
	padding: 12px 16px;
	text-align: start;
	vertical-align: middle;
	border-block-end: 1px solid ${KUMO.fill};
}
.otta-td { font-size: 14px; color: ${KUMO.text}; }
.otta-td.otta-td-subtle { font-size: 13px; color: ${KUMO.subtle}; }
.otta-th {
	font-size: 13px;
	font-weight: 500;
	color: ${KUMO.text};
	white-space: nowrap;
}
.otta-num { font-variant-numeric: tabular-nums; }
/* EmDash's Kumo button: the secondary look is the default, 36px tall, the lg
   radius, a 1px line ring and medium weight. (No backticks in this sheet: it is
   a template literal, and one would end it.) */
.otta-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	box-sizing: border-box;
	block-size: 36px;
	padding: 0 12px;
	font: inherit;
	font-size: 14px;
	font-weight: 500;
	line-height: 1;
	white-space: nowrap;
	border: 1px solid ${KUMO.line};
	border-radius: 8px;
	background: ${KUMO.surface};
	color: ${KUMO.text};
	cursor: pointer;
	transition: background-color 120ms ease-out, border-color 120ms ease-out;
}
.otta-btn:hover:not(:disabled):not([aria-disabled="true"]) { background: ${KUMO.tint}; }
.otta-btn:disabled { cursor: not-allowed; }
.otta-btn[disabled] { opacity: 0.55; }
.otta-btn[data-size="sm"] {
	block-size: 26px;
	padding: 0 8px;
	font-size: 12px;
	border-radius: 6px;
	gap: 4px;
}
.otta-btn[data-variant="primary"] {
	background: ${KUMO.brand};
	border-color: color-mix(in oklch, ${KUMO.brand}, black 10%);
	color: #fff;
}
.otta-btn[data-variant="primary"]:hover:not(:disabled) { background: ${KUMO.brandHover}; }
.otta-btn[data-variant="destructive"] {
	background: ${KUMO.danger};
	border-color: color-mix(in oklch, ${KUMO.danger}, black 10%);
	color: #fff;
}
.otta-btn[data-variant="destructive"]:hover:not(:disabled) {
	background: color-mix(in oklch, ${KUMO.danger}, black 8%);
}
.otta-btn[data-variant="danger"] {
	color: ${KUMO.dangerText};
}
.otta-btn[data-variant="danger"]:hover:not(:disabled) {
	border-color: color-mix(in srgb, ${KUMO.danger} 30%, transparent);
}
/* A CONTROL DIMMED WITHOUT LEAVING THE TAB ORDER — see PagerButton. The
   disabled rule above cannot match it: aria-disabled is a STATE, not the
   disabled property, and the whole point of using it is that the element stays
   focusable and clickable at the DOM level while refusing its own click. */
.otta-btn[aria-disabled="true"] {
	cursor: not-allowed;
	border: ${UNAVAILABLE_BORDER};
	background: ${UNAVAILABLE_FILL};
	color: ${UNAVAILABLE_INK};
}
/* EmDash's underline tabs (Kumo Tabs, variant underline): a hairline under
   the strip, subtle ink at rest, the brand rule under the selected tab. */
.otta-tabs {
	display: flex;
	gap: 16px;
	border-block-end: 1px solid ${KUMO.hairline};
	margin-block-end: 16px;
	overflow-x: auto;
}
.otta-btn.otta-tab {
	block-size: auto;
	padding: 10px 6px;
	border: 0;
	border-radius: 0;
	background: transparent;
	color: ${KUMO.subtle};
	box-shadow: inset 0 -2px 0 transparent;
}
.otta-btn.otta-tab:hover:not(:disabled) { background: transparent; color: ${KUMO.text}; }
.otta-btn.otta-tab[aria-selected="true"] {
	color: ${KUMO.text};
	box-shadow: inset 0 -2px 0 ${KUMO.brand};
}
.otta-btn.otta-tab:focus-visible { outline-offset: -2px; }
/* Forced colours (Windows High Contrast) drop box-shadow and flatten ink, so
   the selected tab keeps a real border there. */
@media (forced-colors: active) {
	.otta-btn.otta-tab[aria-selected="true"] { border-block-end: 2px solid Highlight; }
}
/* Present to assistive technology, absent from the page. The same recipe the
   table caption uses inline; it is a class here because it is applied to
   elements that are not tables and would otherwise be a fourth copy. */
.otta-sr-only {
	position: absolute;
	inline-size: 1px;
	block-size: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}
.otta-row[${ROW_ID_ATTRIBUTE}] {
	cursor: pointer;
}
.otta-row[${ROW_ID_ATTRIBUTE}] :is(${CURSOR_RESET_DESCENDANT_SELECTOR}) {
	cursor: auto;
}
.otta-row[${ROW_ID_ATTRIBUTE}] :is(${CURSOR_RESET_DESCENDANT_SELECTOR}):disabled {
	cursor: not-allowed;
}
.otta-notice:focus-visible {
	outline: 2px solid ${KUMO.focus};
	outline-offset: 2px;
}
.otta-table-card {
	border: 1px solid ${KUMO.line};
	border-radius: 8px;
	background: ${KUMO.surface};
	overflow: hidden;
}
.otta-table-card thead tr { background: color-mix(in srgb, ${KUMO.tint} 50%, transparent); }
.otta-table-card :is(.otta-th, .otta-td):first-child { padding-inline-start: 16px; }
.otta-table-card :is(.otta-th, .otta-td):last-child { padding-inline-end: 16px; }
.otta-table-card tbody tr:last-child .otta-td { border-block-end: 0; }
@media (max-width: 599px) {
	.otta-table-card :is(.otta-th, .otta-td):first-child { padding-inline-start: 12px; }
	.otta-table-card :is(.otta-th, .otta-td):last-child { padding-inline-end: 12px; }
}
/* EmDash's Kumo Badge: a full pill, 12px medium, the status tint behind the
   status ink. Both come from the admin, so each pair is legible on its theme. */
.otta-pill {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 8px;
	font-size: 12px;
	font-weight: 500;
	line-height: 16px;
	border-radius: 999px;
	white-space: nowrap;
}
.otta-pill[data-tone="ok"] {
	background: color-mix(in srgb, var(--color-kumo-success-tint, rgba(47, 133, 90, 0.18)) 70%, transparent);
	color: var(--text-color-kumo-success, currentColor);
}
.otta-pill[data-tone="info"] {
	background: color-mix(in srgb, var(--color-kumo-info-tint, rgba(37, 99, 235, 0.16)) 70%, transparent);
	color: var(--text-color-kumo-info, currentColor);
}
.otta-pill[data-tone="warn"] {
	background: color-mix(in srgb, var(--color-kumo-warning-tint, rgba(183, 121, 31, 0.18)) 70%, transparent);
	color: var(--text-color-kumo-warning, currentColor);
}
.otta-pill[data-tone="fail"] {
	background: color-mix(in srgb, var(--color-kumo-danger-tint, rgba(197, 48, 48, 0.16)) 60%, transparent);
	color: var(--text-color-kumo-danger, currentColor);
}
.otta-pill[data-tone="neutral"] {
	background: var(--color-kumo-fill, rgba(128, 128, 128, 0.16));
	color: var(--text-color-kumo-badge-neutral-subtle, currentColor);
}
/* A section: EmDash's heading-over-a-card. A group inside a group drops the
   card and keeps the heading, divided from what is above it by a hairline. */
.otta-group {
	border: 1px solid ${KUMO.line};
	border-radius: 8px;
	background: ${KUMO.surface};
	padding: 16px;
	margin-block-end: 16px;
	text-align: start;
}
.otta-group[data-nested="true"] {
	border: 0;
	border-block-start: 1px solid ${KUMO.hairline};
	border-radius: 0;
	background: transparent;
	padding: 16px 0 0;
	margin: 16px 0 0;
}
.otta-group-title {
	margin: 0 0 12px;
	font-size: 16px;
	font-weight: 600;
	line-height: 1.25;
	color: ${KUMO.text};
	overflow-wrap: anywhere;
}
.otta-group[data-nested="true"] > .otta-group-title { font-size: 14px; }
.otta-group > :last-child { margin-block-end: 0; }
.otta-link {
	text-decoration-line: none;
	text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
	text-underline-offset: 2px;
}
.otta-row:hover .otta-link-row,
.otta-link:hover,
.otta-link:focus-visible {
	text-decoration-line: underline;
	text-decoration-color: currentColor;
}
.otta-copy-reveal { opacity: 0; }
.otta-row:hover .otta-copy-reveal,
.otta-row:focus-within .otta-copy-reveal,
.otta-copy-reveal:focus-visible {
	opacity: 0.85;
}
@media (hover: none) {
	.otta-copy-reveal { opacity: 0.85; }
}
.otta-dialog { margin: auto; }
.otta-dialog::backdrop {
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(2px);
}
`;

export function ConsoleStyles(): React.ReactElement {
	return <style>{CONSOLE_STYLES}</style>;
}

/** EmDash's card: `rounded-lg border bg-kumo-base`. */
export const panelStyle: React.CSSProperties = {
	border: HAIRLINE,
	borderRadius: 8,
	background: KUMO.surface,
	padding: 16,
	marginBlockEnd: 16,
	textAlign: "start",
};

/**
 * Which of EmDash's button looks a control wears. `default` is Kumo's
 * secondary (surface, line ring); `primary` is the brand blue, for the ONE main
 * action on a screen; `danger` is red ink on the ordinary surface, for an
 * in-page control whose click cannot be undone (it still goes through a
 * confirm); `destructive` is the filled red, for the confirm itself. The white-on-brand
 * and white-on-danger fills mirror Kumo's own buttons on purpose: contrast
 * parity with the host.
 *
 * THE LOOK IS THE SHEET'S, carried by `data-variant` / `data-size` on an
 * `otta-btn`: hover is a pseudo-class, and an inline background would outrank
 * it — the same reason `cursor` is a class rule (an inline cursor could only be
 * beaten by `!important`, which flattened `not-allowed` on disabled buttons
 * inside an activatable row).
 */
export type ButtonVariant = "default" | "primary" | "danger" | "destructive";

/** The attributes that put a control in one of {@link ButtonVariant}'s looks. */
export function buttonLook(
	variant: ButtonVariant = "default",
	size: "base" | "sm" = "base",
): { className: string; "data-variant"?: string; "data-size"?: string } {
	return {
		className: "otta-focusable otta-btn",
		...(variant === "default" ? {} : { "data-variant": variant }),
		...(size === "sm" ? { "data-size": "sm" } : {}),
	};
}

export function Button({
	label,
	onClick,
	danger,
	variant,
	size,
	disabled,
	busy,
	autoFocus,
	handOffFocusTo,
	testId,
}: {
	label: string;
	onClick: () => void;
	/** Shorthand for `variant="danger"`. */
	danger?: boolean;
	variant?: ButtonVariant;
	size?: "base" | "sm";
	disabled?: boolean;
	/** A click whose work is still in flight. `aria-busy` is what tells a screen
	 *  reader the control is mid-flight rather than simply unavailable, which
	 *  `disabled` alone says and says wrongly. */
	busy?: boolean;
	/** Focus this control on mount. Used where the element the operator's focus
	 *  was on has just been unmounted, so the alternative is focus falling back
	 *  to the document. */
	autoFocus?: boolean;
	/**
	 * Where focus goes the moment this button is clicked.
	 *
	 * FOR THE CONTROL WHOSE OWN CLICK DISABLES IT — Retry being the one that
	 * shipped broken. A disabled element cannot hold focus, so the browser drops
	 * it to `<body>` and a keyboard operator is stranded at the top of the
	 * document with nothing focused and no ring to find. The handoff is done
	 * HERE, in the click, BEFORE `onClick` runs the work that flips `disabled` —
	 * ordering it after would be a race against React's commit, and reacting to
	 * the disable in an effect would be reacting to a blur that has already
	 * happened.
	 *
	 * Note that this is invisible to jsdom/happy-dom, where disabling a focused
	 * element does NOT blur it: the only thing worth asserting without a real
	 * browser is that focus reached this target, not that it was not lost.
	 */
	handOffFocusTo?: React.RefObject<HTMLElement | null>;
	testId?: string;
}): React.ReactElement {
	return (
		<button
			type="button"
			{...buttonLook(variant ?? (danger === true ? "danger" : "default"), size)}
			data-testid={testId}
			disabled={disabled === true}
			aria-busy={busy === true ? true : undefined}
			// eslint-disable-next-line jsx-a11y/no-autofocus -- see the prop's note
			autoFocus={autoFocus === true}
			onClick={() => {
				const handoff = handOffFocusTo === undefined ? null : handOffFocusTo.current;
				if (handoff !== null) handoff.focus();
				onClick();
			}}
		>
			{label}
		</button>
	);
}

/**
 * ONE PAGER CONTROL — `Previous` or `Next`, on either list.
 *
 * IT DECIDES NOTHING. Which of the two states it is in, and what it says about
 * being unavailable, are `pagerView`'s answer (`accumulate.ts`, which reads its
 * words from `@urumi.ai/otta-admin-presentation`). This is the markup, and it is HERE
 * rather than in a list because both lists rendered it verbatim: two copies of a
 * control whose accessibility is the interesting part is two copies that drift.
 *
 * `aria-disabled` RATHER THAN `disabled`, which is the whole reason this is not
 * `Button`. A `disabled` element leaves the tab order, and that is exactly what
 * must not happen at the moment `Next` is pressed onto the LAST page: the
 * control the operator's focus is sitting on would stop being focusable under
 * their hands and the browser would drop focus to `<body>`, halfway down a long
 * list, with no ring to find. So it keeps its tab stop and its focus ring,
 * announces itself as unavailable, and refuses its own click.
 *
 * THE REASON IS A VISUALLY-HIDDEN SENTENCE, referenced by `aria-describedby`,
 * and `title` is a bonus rather than the mechanism. The earlier version had this
 * exactly backwards — it claimed `title` was what a keyboard user could reach,
 * which is the one thing `title` is NOT: a tooltip is a POINTER affordance,
 * shown on hover, and keyboard exposure of it is inconsistent across browsers
 * and screen readers. A described-by node is read out with the control's name
 * every time, by every screen reader, whether the operator arrived by pointer,
 * by tab, or by a rotor listing of the page's buttons.
 *
 * DIMMED WITHOUT GOING ILLEGIBLE, AND WITHOUT GOING INVISIBLE. See
 * {@link UNAVAILABLE_BORDER} for what the state is drawn with and why it is
 * three declarations rather than an opacity.
 */
export function PagerButton({
	control,
	testId,
	onClick,
}: {
	control: { readonly label: string; readonly unavailable: boolean; readonly title?: string };
	testId: string;
	onClick: () => void;
}): React.ReactElement {
	// `useId` rather than a name derived from `testId`: two lists could mount at
	// once under a host that renders both, and a duplicated id would point every
	// description at whichever one the document found first.
	const describedBy = `${React.useId()}-why`;
	const reason = control.title;
	return (
		<span style={{ display: "inline-flex", alignItems: "center" }}>
			<button
				type="button"
				{...buttonLook()}
				data-testid={testId}
				// The unavailable look is the sheet's `[aria-disabled="true"]` rule.
				aria-disabled={control.unavailable || undefined}
				{...(reason !== undefined ? { "aria-describedby": describedBy, title: reason } : {})}
				onClick={() => {
					if (control.unavailable) return;
					onClick();
				}}
			>
				{control.label}
			</button>
			{reason !== undefined && (
				<span className="otta-sr-only" id={describedBy}>
					{reason}
				</span>
			)}
		</span>
	);
}

/**
 * §1.3's React tier, and the affordance Block Kit could not have at all: the row
 * shows a short prefix, this copies the WHOLE id.
 *
 * IT REPORTS WHAT IT DID. A copy button that looks identical before and after
 * the click leaves the operator to paste somewhere and find out, which on this
 * screen means pasting an order id into a refund. The label flips to `Copied` on
 * success and to `Press ⌘C` on failure — the clipboard API is
 * permission-gated and origin-gated and can simply say no, and a silent failure
 * there is the worst of the three outcomes.
 *
 * THE FALLBACK HAS TO BE REACHABLE, and in the first cut it was not. On a
 * non-secure origin `navigator.clipboard` is UNDEFINED, so `.writeText(...)`
 * throws a synchronous `TypeError` before a promise exists — `.catch()` never
 * runs, the failure escapes as an unhandled error, and the label stays `Copy`.
 * That is precisely the plain-HTTP staging box an operator is most likely to be
 * on. The API's presence is therefore checked before it is called, and the
 * whole call sits in a `try` so a synchronous throw from any other cause lands
 * in the same visible state.
 *
 * `aria-label` names the id rather than saying "copy", because a screen reader
 * moving through a column of these otherwise hears "copy, copy, copy".
 *
 * `what` NAMES WHAT IS BEING COPIED, and it defaults to the Orders wording that
 * shipped in INC-20. Pricing & inventory copies a SKU rather than an opaque id
 * (§1.3 exempts a natural key, and that screen renders SKUs in full), so a
 * screen-reader user there must hear "Copy SKU APR-LIN-NAT" and not "Copy full
 * order id APR-LIN-NAT" — which would be wrong twice in five words.
 */
export function CopyIdButton({
	id,
	testId,
	what = "full order id",
	revealOnRowHover,
}: {
	id: string;
	testId?: string;
	what?: string;
	/**
	 * Fade the control out until the row is hovered or holds focus — a list-row
	 * opt-in, never a default, because the two detail call sites sit in an
	 * identity strip that has no row to hover.
	 *
	 * `opacity: 0` AND NOT `visibility`/`display`. Hidden content leaves the tab
	 * order, so a keyboard operator could never reach a control revealed only by
	 * a pointer — that would be a new accessibility defect wearing a fix's
	 * clothes. Opacity keeps the button focusable, keeps it in the accessibility
	 * tree, and keeps its box, so revealing it reflows nothing. Its own
	 * `:focus-visible` is one of the reveal triggers, and `@media (hover: none)`
	 * pins it visible where there is no hover at all.
	 */
	revealOnRowHover?: boolean;
}): React.ReactElement {
	const [state, setState] = React.useState<"idle" | "done" | "failed">("idle");

	React.useEffect(() => {
		if (state === "idle") return;
		const timer = setTimeout(() => setState("idle"), 1600);
		return () => clearTimeout(timer);
	}, [state]);

	const look = buttonLook("default", "sm");
	return (
		<button
			type="button"
			{...look}
			className={revealOnRowHover === true ? `${look.className} otta-copy-reveal` : look.className}
			data-testid={testId}
			data-full-id={id}
			aria-label={`Copy ${what} ${id}`}
			title={id}
			onClick={() => {
				try {
					const clipboard: Clipboard | undefined = navigator.clipboard;
					if (clipboard === undefined) {
						setState("failed");
						return;
					}
					void clipboard
						.writeText(id)
						.then(() => setState("done"))
						.catch(() => setState("failed"));
				} catch {
					setState("failed");
				}
			}}
			// The reveal owns opacity from the sheet when it is on; an inline
			// declaration here would outrank every one of its triggers.
			style={{ marginInlineStart: 8, verticalAlign: "middle" }}
		>
			{state === "done" ? "Copied" : state === "failed" ? "Press ⌘C" : "Copy"}
		</button>
	);
}

/**
 * The Show/Hide control beside a masked buyer email (issue #377).
 *
 * A DISCLOSURE, SO `aria-expanded` AND `aria-controls`. The button discloses the
 * element whose id it is handed, and the visible word changes with the state:
 * `aria-pressed` would make a screen reader say "Hide, pressed", which states
 * the same thing twice and backwards. The accessible name CONTAINS the visible
 * word (`Show buyer email for order #7E4CE`), so a voice-control user can say
 * what they see and a screen-reader user moving down a column hears which row
 * each one belongs to, not "Show, Show, Show" — the reason `CopyIdButton`'s
 * label names its id.
 *
 * ONE ELEMENT ACROSS BOTH STATES. The caller flips `revealed`; this button is
 * never swapped for another, so a keyboard operator who pressed it still has
 * focus on it. A native `<button>` is what makes Enter and Space work, with no
 * key handler of our own to get wrong.
 *
 * IN A CELL, THE SAME COMPACT INK AS `CopyIdButton` (`compact`, the default),
 * and visible at rest rather than on row hover: the masked text says something
 * is hidden, and the way to see it must not itself be hidden. `fontWeight: 400`
 * because the list's Customer cell is bold and a Show beside it should not look
 * as though it were part of the value. Beside an ordinary `Button` — the
 * detail's Back row — it takes that button's size instead.
 */
export function RevealToggle({
	revealed,
	onToggle,
	controls,
	what,
	showLabel = "Show",
	hideLabel = "Hide",
	compact = true,
	testId,
}: {
	revealed: boolean;
	onToggle: () => void;
	/** The id of the element this discloses. */
	controls: string;
	/** What is revealed, and whose — read after the verb: `buyer email for order #7E4CE`. */
	what: string;
	showLabel?: string;
	hideLabel?: string;
	/** The Copy-sized control a table cell wants; `false` is the ordinary
	 *  `Button` size, for a toolbar row beside one. */
	compact?: boolean;
	testId?: string;
}): React.ReactElement {
	const verb = revealed ? "Hide" : "Show";
	return (
		<button
			type="button"
			{...buttonLook("default", compact ? "sm" : "base")}
			data-testid={testId}
			aria-expanded={revealed}
			aria-controls={controls}
			aria-label={`${verb} ${what}`}
			onClick={onToggle}
			style={
				compact
					? { fontWeight: 400, marginInlineStart: 8, verticalAlign: "middle" }
					: { marginInlineStart: 8 }
			}
		>
			{revealed ? hideLabel : showLabel}
		</button>
	);
}

/**
 * An outcome the operator must read: a refusal, a success, or a warning about
 * the record itself.
 *
 * `aria-live="polite"` is load-bearing and is the same reason INC-19 put it on
 * the probe panel — the content arrives after an interaction, so a screen-reader
 * user already on the page is told nothing without it. `role="status"` rather
 * than `alert` even for errors: these are outcomes of something the operator
 * just did, not interruptions.
 *
 * NOT EVERY NOTICE ANSWERS AN INTERACTION, THOUGH, and that is the one case
 * `role="status"` does not cover on its own: a live region INSERTED with its text
 * already in place is not required to be announced, and the lists' stale-link
 * notice appears on arrival, unbidden, with nothing to click. So a caller raising
 * a notice the operator did not just ask for hands focus to this section — which
 * is what `tabIndex={-1}` is for, and where `handOffFocusTo` already sends it —
 * while a caller whose notice answers an interaction must NOT: there the live
 * region is doing its job, and taking focus off what the operator was doing is
 * the more disruptive fix.
 *
 * `action` IS `EmptyState`'s, deliberately — same prop shape, same markup,
 * same `Button`. A notice that reports a failed load has a way out for exactly
 * the reason a zero state has a way back to every row, and the two should not
 * be two different affordances.
 */
export function Notice({
	variant,
	title,
	description,
	action,
	testId,
}: {
	variant: "default" | "error" | "alert";
	title: string;
	description: string;
	action?: {
		label: string;
		onClick: () => void;
		disabled?: boolean;
		busy?: boolean;
		autoFocus?: boolean;
	};
	testId?: string;
}): React.ReactElement {
	// EmDash's own callout: `border-s-4 border-s-kumo-{tone}` on an ordinary card.
	const accent =
		variant === "error"
			? KUMO.danger
			: variant === "alert"
				? "var(--color-kumo-warning, #b7791f)"
				: "var(--color-kumo-success, #2f855a)";
	// WHERE FOCUS LANDS WHEN THE ACTION DISABLES ITSELF. Retry is focused on
	// arrival, and its own click is what disables it — so without somewhere to go,
	// focus falls to `<body>`. This region is the button's own container and it
	// carries the sentence explaining why the operator is here, which makes it the
	// correct destination whether or not the button survives the click.
	const region = React.useRef<HTMLElement | null>(null);
	return (
		<section
			ref={region}
			role="status"
			aria-live="polite"
			className="otta-notice"
			tabIndex={-1}
			data-testid={testId}
			data-variant={variant}
			style={{
				...panelStyle,
				borderInlineStartWidth: 4,
				borderInlineStartColor: accent,
			}}
		>
			<h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: KUMO.text }}>{title}</h3>
			{description.length > 0 && (
				<p style={{ fontSize: 13, color: KUMO.subtle, margin: "4px 0 0" }}>{description}</p>
			)}
			{action !== undefined && (
				<div style={{ marginBlockStart: 12 }}>
					<Button
						label={action.label}
						onClick={action.onClick}
						{...(action.disabled !== undefined ? { disabled: action.disabled } : {})}
						{...(action.busy !== undefined ? { busy: action.busy } : {})}
						{...(action.autoFocus !== undefined ? { autoFocus: action.autoFocus } : {})}
						handOffFocusTo={region}
						testId={testId === undefined ? undefined : `${testId}-action`}
					/>
				</div>
			)}
		</section>
	);
}

/**
 * A header over a figure column, end-aligned to meet the tabular numerals under
 * it.
 *
 * A SPAN INSIDE THE EXISTING HEADER SLOT rather than a new prop on the shared
 * table: alignment is a property of the column's CONTENT, and six money columns
 * across three tables are not a reason for every table in the console to learn
 * it. `display: block` is what makes `text-align` reach the whole cell width —
 * an inline span would end-align nothing but itself.
 *
 * IT LIVES HERE BECAUSE IT WAS SPELLED TWICE. The lists wrote the span inline
 * and the order detail wrote a local component with the same body; a third
 * screen would have made three, and three spellings of one decision drift the
 * moment one of them is adjusted. The cell under it takes {@link endCellStyle}.
 */
export function EndHeader({ label }: { label: string }): React.ReactElement {
	return <span style={{ display: "block", textAlign: "end" }}>{label}</span>;
}

/** The cell under an {@link EndHeader}. */
export const endCellStyle: React.CSSProperties = { textAlign: "end" };

/** Which of EmDash's badge tones a pill wears — Kumo's `success`, `info`,
 *  `warning`, `error` and neutral (`secondary`) badge variants. */
export type StatusTone = "ok" | "info" | "warn" | "fail" | "neutral";

/**
 * A state phrase, drawn as EmDash's own badge (the "Published" pill on its
 * content lists): a full pill in the status tint with the status ink on it.
 *
 * BOTH COLOURS ARE THE ADMIN'S. The tint and the ink come from Kumo tokens that
 * the admin re-points per theme, which is what makes a filled pill safe here at
 * all — the earlier border-only pill existed because this file had no ink it
 * could trust on both grounds. The look lives in the sheet (`.otta-pill`), keyed
 * by `data-tone`, so nothing inline can pin a colour that ignores the theme.
 *
 * WHICH TONE A STATE GETS IS THE CALL SITE'S DECISION, not this component's: it
 * holds the raw record. Absence is never a tone — unknown stock stays a bare em
 * dash and gets no pill at all.
 *
 * IT WRAPS A PHRASE, IT NEVER MAKES ONE. The words arrive as children from the
 * shared copy module, which stays the single source of wording.
 */
export function StatusPill({
	tone,
	children,
	testId,
}: {
	tone: StatusTone;
	children: React.ReactNode;
	testId?: string;
}): React.ReactElement {
	return (
		<span className="otta-pill" data-testid={testId} data-tone={tone}>
			{children}
		</span>
	);
}

/** An empty state: the two-line shape the Block Kit `empty` block renders, with
 *  its optional way out. Same copy on both surfaces — the strings come from the
 *  screen, not from here. */
export function EmptyState({
	title,
	description,
	action,
	testId,
}: {
	title: string;
	description: string;
	action?: { label: string; onClick: () => void };
	testId?: string;
}): React.ReactElement {
	return (
		<section
			data-testid={testId}
			style={{ ...panelStyle, padding: "48px 16px", textAlign: "center" }}
		>
			<h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: KUMO.text }}>{title}</h3>
			<p style={{ fontSize: 14, color: KUMO.subtle, margin: "8px auto 0", maxInlineSize: 460 }}>
				{description}
			</p>
			{action !== undefined && (
				<div style={{ marginBlockStart: 14 }}>
					<Button label={action.label} onClick={action.onClick} />
				</div>
			)}
		</section>
	);
}

/** A label/value grid — the React tier's `fields` block. Row-major pairs, same
 *  as Block Kit's `grid-cols-2`, so entries read left→right then down. */
export function Fields({
	entries,
	testId,
}: {
	entries: ReadonlyArray<readonly [string, React.ReactNode]>;
	testId?: string;
}): React.ReactElement {
	return (
		<dl
			data-testid={testId}
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
				gap: "10px 24px",
				fontSize: 13,
				margin: 0,
			}}
		>
			{entries.map(([label, value]) => (
				<div key={label} style={{ minInlineSize: 0 }}>
					<dt style={{ opacity: 0.65, fontSize: 12, marginBlockEnd: 2 }}>{label}</dt>
					<dd className="otta-num" style={{ margin: 0, wordBreak: "break-word" }}>
						{value}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** Whether a {@link Group} sits inside another one. */
const GroupDepth = React.createContext(0);

/**
 * A titled section — EmDash's heading over a card.
 *
 * NO DISCLOSURE. This used to be a native `<details>`; EmDash's own screens
 * fold nothing behind a dropdown, so every section is open, always, and the
 * label is an `<h3>` (an `<h4>` when nested) over its content. That also retires the Block Kit hazard
 * ADR-0014 lists (a group forced shut by a changed `block_id`, discarding
 * unsubmitted input): with nothing to shut, nothing can be shut on the operator.
 *
 * A GROUP INSIDE A GROUP is a sub-section rather than a card in a card — the
 * heading stays, the frame becomes a hairline above it (`data-nested`).
 */
export function Group({
	label,
	children,
	testId,
}: {
	/** Usually a string; a node when part of the title must be addressable —
	 *  the detail's Customer title carries a masked email a toggle controls. */
	label: React.ReactNode;
	children: React.ReactNode;
	testId?: string;
}): React.ReactElement {
	const depth = React.useContext(GroupDepth);
	const Heading = depth > 0 ? "h4" : "h3";
	return (
		<section className="otta-group" data-nested={depth > 0 ? true : undefined} data-testid={testId}>
			<Heading className="otta-group-title">{label}</Heading>
			<GroupDepth.Provider value={depth + 1}>{children}</GroupDepth.Provider>
		</section>
	);
}

/**
 * The confirm dialog for a click that moves money or cannot be undone.
 *
 * IT IS A NATIVE `<dialog>` opened MODALLY, which buys three behaviours this
 * screen would otherwise have to build and get wrong: keyboard focus stays among
 * this dialog's own controls and reaches nothing behind it, the rest of the page
 * is inert to assistive technology, and Escape closes it. The confirm button is
 * NOT autofocused — the whole point of the dialog is that the operator reads the
 * sentence, and a focused confirm invites a second Return keypress to land on
 * it.
 *
 * `text` is composed by the caller from the SHARED
 * `@urumi.ai/otta-admin-presentation` copy helpers, so the sentence an operator reads
 * here is the same sentence the Block Kit confirm renders — id first, in the
 * same 8 characters.
 */
export function ConfirmDialog({
	open,
	title,
	text,
	confirmLabel,
	denyLabel,
	confirmTone = "danger",
	confirmDisabled,
	status,
	onConfirm,
	onDeny,
}: {
	open: boolean;
	title: string;
	text: string;
	confirmLabel: string;
	denyLabel: string;
	/**
	 * How the confirm button is weighted. `danger` is the default because it is
	 * what every call site already got when the tone was hard-coded, and two of
	 * the three — removing stock, and leaving with unsaved work — are correctly
	 * destructive. Flipping the default would quietly de-weight both of them to
	 * fix the one that is wrong. The additive confirm passes `neutral`: adding
	 * stock is undoable and reversible, and dressing it as destruction teaches an
	 * operator to read past the styling on the confirms that are not.
	 */
	confirmTone?: "danger" | "neutral";
	/** Hold the confirm while the caller cannot act on it yet (its text should
	 *  say why); Deny stays available. */
	confirmDisabled?: boolean;
	/** A passing state the dialog should announce (why the confirm is held,
	 *  say). Rendered in a polite live region that is always present, so a
	 *  change is read out. */
	status?: string;
	onConfirm: () => void;
	onDeny: () => void;
}): React.ReactElement | null {
	const ref = React.useRef<HTMLDialogElement | null>(null);

	React.useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);

	return (
		<dialog
			ref={ref}
			className="otta-dialog"
			data-testid="otta-confirm"
			onCancel={(event) => {
				event.preventDefault();
				onDeny();
			}}
			style={{
				border: HAIRLINE,
				borderRadius: 12,
				padding: 24,
				maxInlineSize: 460,
				background: "var(--color-kumo-base, Canvas)",
				color: "var(--text-color-kumo-default, CanvasText)",
				textAlign: "start",
				boxShadow: "0 10px 30px var(--color-kumo-shadow-drop, rgba(0, 0, 0, 0.18))",
			}}
		>
			<h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }} data-testid="otta-confirm-title">
				{title}
			</h2>
			<p
				style={{ fontSize: 14, margin: "10px 0 20px", lineHeight: 1.5, color: KUMO.subtle }}
				data-testid="otta-confirm-text"
			>
				{text}
			</p>
			{status !== undefined && (
				<p
					style={{ fontSize: 13, margin: status === "" ? 0 : "0 0 16px", lineHeight: 1.5 }}
					aria-live="polite"
					data-testid="otta-confirm-status"
				>
					{status}
				</p>
			)}
			<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
				<Button label={denyLabel} onClick={onDeny} testId="otta-confirm-deny" />
				<Button
					label={confirmLabel}
					onClick={onConfirm}
					variant={confirmTone === "danger" ? "destructive" : "primary"}
					disabled={confirmDisabled}
					testId="otta-confirm-yes"
				/>
			</div>
		</dialog>
	);
}

/** A labelled control. The `<label>` wraps its input, so the association needs
 *  no id and cannot break by duplication when two screens mount at once. */
export function Field({
	label,
	hideLabel,
	children,
}: {
	label: string;
	/** Keep the label for assistive technology but off the page — an inline
	 *  filter row whose control already says what it is. */
	hideLabel?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<label style={{ display: "block", fontSize: 14, textAlign: "start", color: KUMO.text }}>
			<span
				className={hideLabel === true ? "otta-sr-only" : undefined}
				style={
					hideLabel === true ? undefined : { display: "block", marginBlockEnd: 6, fontWeight: 500 }
				}
			>
				{label}
			</span>
			{children}
		</label>
	);
}

/** EmDash's Kumo input: 36px, the lg radius, a line ring on the control fill. */
export const inputStyle: React.CSSProperties = {
	inlineSize: "100%",
	boxSizing: "border-box",
	minBlockSize: 36,
	padding: "6px 12px",
	font: "inherit",
	fontSize: 14,
	border: HAIRLINE,
	borderRadius: 8,
	background: KUMO.control,
	color: KUMO.text,
};

/** The compact control of an inline filter row — EmDash's Products list
 *  search and selects. */
export const compactInputStyle: React.CSSProperties = {
	...inputStyle,
	minBlockSize: 28,
	padding: "2px 10px",
	fontSize: 13,
	borderRadius: 6,
};

/**
 * The part of an element the row guard reads. A real `Element` satisfies it,
 * which is the point: the decision below stays a pure function of its inputs and
 * can be exercised without a DOM.
 */
export interface RowActivationNode {
	closest(selectors: string): RowActivationNode | null;
	getAttribute(name: string): string | null;
	contains(other: unknown): boolean;
}

/** Where the pointer was, in client coordinates. */
export interface RowActivationPoint {
	x: number;
	y: number;
}

/** What the document had selected when the click landed. */
export interface RowActivationSelection {
	collapsed: boolean;
	anchor: unknown;
}

/**
 * Which record a click just activated, or `null` for a click that activates
 * nothing.
 *
 * FIVE WAYS TO BAIL, and each of them is a real click an operator makes:
 *
 *  - A MODIFIED CLICK. The row is not a link — it has no `href` for a new tab to
 *    be opened at — so ctrl/cmd/shift-click on a bare cell must do nothing at
 *    all rather than something approximate.
 *  - AN INTERACTIVE DESCENDANT. Without this the drill-in link navigates and the
 *    row navigates again, or Copy copies AND navigates. Double-firing is the
 *    failure this guard exists for.
 *  - NO ROW. Clicks land on padding and on the table body itself.
 *  - A LIVE SELECTION INSIDE THE ROW. A merchant drag-selecting a SKU is
 *    finishing a selection, not opening an order.
 *  - A PRESS THAT MOVED. Same intent, caught earlier: a drag that started on the
 *    row is a drag even before the selection settles. An absent origin is also a
 *    bail — a click with no press behind it is not one this row saw begin. The
 *    handler clears the origin at the end of every click it sees, so a click
 *    that reuses a stale press is not merely unreachable today, it is
 *    impossible: there is never a leftover origin to reuse.
 */
export function rowActivationId(
	target: RowActivationNode | null,
	context: {
		modified: boolean;
		origin: RowActivationPoint | null;
		point: RowActivationPoint;
		selection: RowActivationSelection | null;
	},
): string | null {
	if (target === null || context.modified) return null;
	if (target.closest(INTERACTIVE_DESCENDANT_SELECTOR) !== null) return null;

	const row = target.closest(`[${ROW_ID_ATTRIBUTE}]`);
	if (row === null) return null;

	const selection = context.selection;
	if (
		selection !== null &&
		!selection.collapsed &&
		selection.anchor !== null &&
		selection.anchor !== undefined &&
		row.contains(selection.anchor)
	) {
		return null;
	}

	const origin = context.origin;
	if (origin === null) return null;
	if (Math.hypot(context.point.x - origin.x, context.point.y - origin.y) > ROW_ACTIVATION_SLOP_PX) {
		return null;
	}

	const id = row.getAttribute(ROW_ID_ATTRIBUTE);
	return id === null || id.length === 0 ? null : id;
}

/** A plain data table. `caption` is visually hidden but present: a table with a
 *  name is navigable, and a screen with two tables in one panel is otherwise two
 *  anonymous grids to a screen-reader user.
 *
 *  `onActivateRow` MAKES THE WHOLE ROW THE TARGET the hover tint has always
 *  promised. It is one listener on the body, not one per row, and it adds NO tab
 *  stop: the row takes no `tabindex`, no `role` and no keydown handler, because
 *  the primary cell's link is already a tab stop that Enter already opens, and a
 *  second one per row would double keyboard traversal on a forty-row list. */
export function Table({
	caption,
	headers,
	children,
	testId,
	card,
	onActivateRow,
}: {
	caption: string;
	headers: readonly React.ReactNode[];
	children: React.ReactNode;
	testId?: string;
	/**
	 * Frame the table in EmDash's list-table card: `rounded-lg border
	 * bg-kumo-base`, a `bg-kumo-tint/50` header band, generous first/last cell
	 * insets, and no rule under the last row so the card edge is the final line.
	 *
	 * OPT-IN, because a table already inside a section card would double-border. The clip
	 * is `overflow: hidden` from the sheet on the same element that scrolls
	 * horizontally, so a narrow viewport still scrolls the columns and the band
	 * still stops at the corner.
	 */
	card?: boolean;
	/** Called with the `data-row-id` of the row a click activated. Rows without
	 *  that attribute are inert. */
	onActivateRow?: (id: string) => void;
}): React.ReactElement {
	const origin = React.useRef<RowActivationPoint | null>(null);

	const bodyHandlers =
		onActivateRow === undefined
			? {}
			: {
					onMouseDown: (event: React.MouseEvent<HTMLTableSectionElement>) => {
						origin.current = { x: event.clientX, y: event.clientY };
					},
					onClick: (event: React.MouseEvent<HTMLTableSectionElement>) => {
						const target = event.target;
						const selection = typeof window === "undefined" ? null : window.getSelection();
						const id = rowActivationId(target instanceof Element ? target : null, {
							modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
							origin: origin.current,
							point: { x: event.clientX, y: event.clientY },
							selection:
								selection === null
									? null
									: { collapsed: selection.isCollapsed, anchor: selection.anchorNode },
						});
						if (id !== null) onActivateRow(id);
						origin.current = null;
					},
				};

	return (
		<div className={card === true ? "otta-table-card" : undefined} style={{ overflowX: "auto" }}>
			<table
				data-testid={testId}
				style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: 14 }}
			>
				<caption
					style={{
						position: "absolute",
						inlineSize: 1,
						blockSize: 1,
						overflow: "hidden",
						clipPath: "inset(50%)",
					}}
				>
					{caption}
				</caption>
				<thead>
					<tr>
						{headers.map((header, index) => (
							// eslint-disable-next-line react/no-array-index-key -- headers are a fixed authored list
							<th key={index} className="otta-th" scope="col">
								{header}
							</th>
						))}
					</tr>
				</thead>
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the
				    handler is delegation for the rows' own links, which remain the tab stops */}
				<tbody {...bodyHandlers}>{children}</tbody>
			</table>
		</div>
	);
}
