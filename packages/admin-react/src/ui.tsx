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
 *  1. **Theme-neutral.** The admin ships light and dark, and a fixed foreground
 *     or background colour is legible in exactly one of them. Everything is
 *     `currentColor`, `transparent`, or a grey stated as an alpha over whatever
 *     is behind it. The three accent colours are used for BORDERS and never as
 *     text or fill, so they never have to contrast with a background this file
 *     does not control.
 *  2. **Logical properties (G6).** `marginBlockEnd`, `borderInlineStart`,
 *     `textAlign: "start"` — the admin is RTL-capable and nothing here may pin
 *     to the left.
 *
 * WHY THERE IS A STYLESHEET AND NOT ONLY INLINE STYLES. Two things this screen
 * is required to have cannot be expressed as a style object: `:focus-visible`
 * (the DoD includes a focus-state screenshot, and every interactive element
 * needs a visible ring) and `:hover` on a table row (DESIGNER §8's full-row
 * hover tint, which is what makes a link in one cell read as "this row opens").
 * Both are pseudo-classes. The sheet is minimal and mounted once.
 */
import * as React from "react";

export const HAIRLINE = "1px solid rgba(128, 128, 128, 0.35)";
export const OK_ACCENT = "#2f855a";
export const FAIL_ACCENT = "#c53030";
export const WARN_ACCENT = "#b7791f";
export const MUTED = "rgba(128, 128, 128, 0.6)";
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
 * A whole `border` rather than a `border-color`: `buttonStyle` states the
 * shorthand, and React warns (correctly) that mixing the two on one element
 * makes removals order-dependent.
 */
export const UNAVAILABLE_BORDER = "1px solid rgba(128, 128, 128, 0.22)";
export const UNAVAILABLE_FILL = "rgba(128, 128, 128, 0.10)";
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
 * would outrank this rule exactly the way the buttons used to, so `Group` puts
 * it on `.otta-summary` instead.
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
	outline: 2px solid currentColor;
	outline-offset: 2px;
	border-radius: 4px;
}
.otta-row:hover {
	background: rgba(128, 128, 128, 0.10);
}
.otta-row:focus-within {
	background: rgba(128, 128, 128, 0.14);
}
.otta-td, .otta-th {
	padding: 8px 12px;
	text-align: start;
	vertical-align: top;
	border-block-end: ${HAIRLINE};
}
.otta-th {
	font-size: 12px;
	font-weight: 650;
	opacity: 0.72;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	white-space: nowrap;
}
.otta-num { font-variant-numeric: tabular-nums; }
.otta-btn { cursor: pointer; }
.otta-btn:disabled { cursor: not-allowed; }
/* A CONTROL DIMMED WITHOUT LEAVING THE TAB ORDER — see PagerButton. The rule
   above cannot match it: aria-disabled is a STATE, not the disabled property,
   and the whole point of using it is that the element stays focusable and
   clickable at the DOM level while refusing its own click. (No backticks in
   this sheet: it is a template literal, and one would end it.) */
.otta-btn[aria-disabled="true"] { cursor: not-allowed; }
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
.otta-summary { cursor: pointer; }
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
	outline: 2px solid currentColor;
	outline-offset: 2px;
}
.otta-table-card {
	border: ${HAIRLINE};
	border-radius: 8px;
	overflow: hidden;
}
.otta-table-card thead tr { background: rgba(128, 128, 128, 0.06); }
.otta-table-card :is(.otta-th, .otta-td):first-child { padding-inline-start: 16px; }
.otta-table-card :is(.otta-th, .otta-td):last-child { padding-inline-end: 16px; }
.otta-table-card tbody tr:last-child .otta-td { border-block-end: 0; }
@media (max-width: 599px) {
	.otta-table-card :is(.otta-th, .otta-td):first-child { padding-inline-start: 12px; }
	.otta-table-card :is(.otta-th, .otta-td):last-child { padding-inline-end: 12px; }
}
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

export const panelStyle: React.CSSProperties = {
	border: HAIRLINE,
	borderRadius: 8,
	padding: "14px 16px",
	marginBlockEnd: 16,
	textAlign: "start",
};

/**
 * NO `cursor` HERE, AND THAT IS THE POINT. It lives on `.otta-btn` in the sheet
 * instead, because an inline declaration outranks every rule a stylesheet can
 * write — so while `cursor` was inline, the row-activation reset could only beat
 * it with `!important`, which in turn flattened `not-allowed` on any disabled
 * button inside an activatable row. As a class rule it loses to the more
 * specific descendant reset on cascade alone, and the disabled case survives.
 * Anything that spreads this style must carry `otta-btn` in its `className`.
 */
export const buttonStyle: React.CSSProperties = {
	padding: "5px 12px",
	fontSize: 13,
	border: HAIRLINE,
	borderRadius: 6,
	background: "transparent",
	color: "inherit",
};

/** A control whose click cannot be undone. The weight is carried by a border and
 *  by the word on it — never by a filled background, which this file cannot
 *  colour safely in both themes. */
export const dangerButtonStyle: React.CSSProperties = {
	...buttonStyle,
	borderColor: FAIL_ACCENT,
	fontWeight: 600,
};

export function Button({
	label,
	onClick,
	danger,
	disabled,
	busy,
	autoFocus,
	handOffFocusTo,
	testId,
}: {
	label: string;
	onClick: () => void;
	danger?: boolean;
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
			className="otta-focusable otta-btn"
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
			style={{
				...(danger === true ? dangerButtonStyle : buttonStyle),
				opacity: disabled === true ? 0.5 : 1,
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
 * words from `@otta-sh/admin-presentation`). This is the markup, and it is HERE
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
				className="otta-focusable otta-btn"
				data-testid={testId}
				aria-disabled={control.unavailable || undefined}
				{...(reason !== undefined ? { "aria-describedby": describedBy, title: reason } : {})}
				style={{
					...buttonStyle,
					...(control.unavailable
						? {
								border: UNAVAILABLE_BORDER,
								background: UNAVAILABLE_FILL,
								color: UNAVAILABLE_INK,
							}
						: {}),
				}}
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

	return (
		<button
			type="button"
			className={
				revealOnRowHover === true
					? "otta-focusable otta-btn otta-copy-reveal"
					: "otta-focusable otta-btn"
			}
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
			style={{
				...buttonStyle,
				padding: "1px 6px",
				fontSize: 11,
				marginInlineStart: 6,
				// The reveal owns opacity from the sheet when it is on; an inline
				// declaration here would outrank every one of its triggers.
				...(revealOnRowHover === true ? {} : { opacity: 0.85 }),
			}}
		>
			{state === "done" ? "Copied" : state === "failed" ? "Press ⌘C" : "Copy"}
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
	const accent = variant === "error" ? FAIL_ACCENT : variant === "alert" ? WARN_ACCENT : OK_ACCENT;
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
			<h3 style={{ fontSize: 14, fontWeight: 650, margin: 0 }}>{title}</h3>
			{description.length > 0 && (
				<p style={{ fontSize: 13, opacity: 0.85, margin: "6px 0 0" }}>{description}</p>
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

/** Which of the three accents a pill wears. There is no `ok` call site by
 *  design — a green "everything is fine" badge is the noise the badge-the-
 *  exception rule exists to prevent — but the tone stays in the type because the
 *  accent constant is real and a screen that needs it should not invent one. */
export type StatusTone = "ok" | "warn" | "fail";

const PILL_ACCENT: Readonly<Record<StatusTone, string>> = {
	ok: OK_ACCENT,
	warn: WARN_ACCENT,
	fail: FAIL_ACCENT,
};

/**
 * A state phrase that has to be picked out of a dense column.
 *
 * BORDER ONLY, AND THE MEASUREMENT SAYS SO rather than taste. Every one of the
 * three accents fails the 4.5:1 text threshold against one ground or the other —
 * the greens and the red on the dark ground, the amber on white — while every
 * one of them clears the 3:1 non-text threshold on BOTH. So the accent is spent
 * on a 1px border and the text stays `currentColor`, which is the only way one
 * pill can serve light and dark with no conditional colour anywhere.
 *
 * BADGE THE EXCEPTION, LEAVE THE HAPPY PATH BARE. Whether a given state is an
 * exception is the CALL SITE's decision, not this component's: it holds the raw
 * record, and it is the only place that knows a `failed` order is worth a ring
 * while every other order status is not. Absence is never an exception — unknown
 * stock stays a bare em dash and gets no pill at all.
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
		<span
			data-testid={testId}
			data-tone={tone}
			style={{
				display: "inline-block",
				padding: "1px 8px",
				fontSize: 11,
				fontWeight: 600,
				lineHeight: 1.6,
				border: `1px solid ${PILL_ACCENT[tone]}`,
				borderRadius: 999,
				background: "transparent",
				// Never the accent. See the note above.
				color: "currentColor",
				whiteSpace: "nowrap",
			}}
		>
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
			style={{ ...panelStyle, padding: "28px 16px", textAlign: "center" }}
		>
			<h3 style={{ fontSize: 15, fontWeight: 650, margin: 0 }}>{title}</h3>
			<p style={{ fontSize: 13, opacity: 0.8, margin: "8px auto 0", maxInlineSize: 460 }}>
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

/**
 * A disclosure group — the React tier's accordion.
 *
 * A NATIVE `<details>`, deliberately. It is keyboard-operable, screen-reader
 * announced and stateful without a line of JavaScript, and — the reason that
 * matters here — its open state is owned by the DOM rather than by a `block_id`.
 * That is precisely the Block Kit hazard ADR-0014 lists as gone: on Block Kit
 * the only way to force a group shut is to change its `block_id`, which remounts
 * it and discards unsubmitted operator input. Here, nothing the screen does can
 * close a group the operator opened.
 */
export function Group({
	label,
	defaultOpen,
	children,
	testId,
}: {
	label: string;
	defaultOpen?: boolean;
	children: React.ReactNode;
	testId?: string;
}): React.ReactElement {
	return (
		<details
			data-testid={testId}
			open={defaultOpen === true}
			style={{ ...panelStyle, padding: "10px 14px" }}
		>
			<summary
				// NO `cursor` IN THE STYLE OBJECT, for the reason `buttonStyle` has
				// none: a disclosure inside an activatable row has to be able to fall
				// back to `auto`, and an inline declaration cannot be reset by any
				// rule the sheet is allowed to write.
				className="otta-focusable otta-summary"
				style={{ fontSize: 14, fontWeight: 600, listStyle: "revert" }}
			>
				{label}
			</summary>
			<div style={{ marginBlockStart: 12 }}>{children}</div>
		</details>
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
 * `@otta-sh/admin-presentation` copy helpers, so the sentence an operator reads
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
				borderRadius: 10,
				padding: "18px 20px",
				maxInlineSize: 460,
				color: "inherit",
				textAlign: "start",
			}}
		>
			<h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }} data-testid="otta-confirm-title">
				{title}
			</h2>
			<p
				style={{ fontSize: 13, margin: "10px 0 16px", lineHeight: 1.5 }}
				data-testid="otta-confirm-text"
			>
				{text}
			</p>
			<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
				<Button label={denyLabel} onClick={onDeny} testId="otta-confirm-deny" />
				<Button
					label={confirmLabel}
					onClick={onConfirm}
					danger={confirmTone === "danger"}
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
	children,
}: {
	label: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<label style={{ display: "block", fontSize: 12, opacity: 0.75, textAlign: "start" }}>
			<span style={{ display: "block", marginBlockEnd: 4 }}>{label}</span>
			{children}
		</label>
	);
}

export const inputStyle: React.CSSProperties = {
	inlineSize: "100%",
	boxSizing: "border-box",
	padding: "5px 8px",
	fontSize: 13,
	border: HAIRLINE,
	borderRadius: 6,
	background: "transparent",
	color: "inherit",
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
	 * Frame the table in the same card the rest of the console's panels already
	 * use: shared hairline, 8px radius, a header band stated as an alpha over
	 * whatever is behind it, generous first/last cell insets, and no rule under
	 * the last row so the card edge is the final line.
	 *
	 * OPT-IN, because only the two LIST tables want it. The four detail tables
	 * already sit inside a panel and a card there would double-border. The clip
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
				style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: 13 }}
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
