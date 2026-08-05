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
.otta-row[${ROW_ID_ATTRIBUTE}] {
	cursor: pointer;
}
.otta-row[${ROW_ID_ATTRIBUTE}] :is(${INTERACTIVE_DESCENDANT_SELECTOR}) {
	cursor: auto !important;
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

export const buttonStyle: React.CSSProperties = {
	padding: "5px 12px",
	fontSize: 13,
	border: HAIRLINE,
	borderRadius: 6,
	background: "transparent",
	color: "inherit",
	cursor: "pointer",
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
	testId?: string;
}): React.ReactElement {
	return (
		<button
			type="button"
			className="otta-focusable"
			data-testid={testId}
			disabled={disabled === true}
			aria-busy={busy === true ? true : undefined}
			// eslint-disable-next-line jsx-a11y/no-autofocus -- see the prop's note
			autoFocus={autoFocus === true}
			onClick={onClick}
			style={{
				...(danger === true ? dangerButtonStyle : buttonStyle),
				opacity: disabled === true ? 0.5 : 1,
				cursor: disabled === true ? "not-allowed" : "pointer",
			}}
		>
			{label}
		</button>
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
}: {
	id: string;
	testId?: string;
	what?: string;
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
			className="otta-focusable"
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
				opacity: 0.85,
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
	return (
		<section
			role="status"
			aria-live="polite"
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
						testId={testId === undefined ? undefined : `${testId}-action`}
					/>
				</div>
			)}
		</section>
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
				className="otta-focusable"
				style={{ cursor: "pointer", fontSize: 14, fontWeight: 600, listStyle: "revert" }}
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
 * screen would otherwise have to build and get wrong: focus is trapped inside
 * it, the rest of the page is inert to assistive technology, and Escape closes
 * it. The confirm button is NOT autofocused — the whole point of the dialog is
 * that the operator reads the sentence, and a focused confirm invites a second
 * Return keypress to land on it.
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
	onConfirm,
	onDeny,
}: {
	open: boolean;
	title: string;
	text: string;
	confirmLabel: string;
	denyLabel: string;
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
				<Button label={confirmLabel} onClick={onConfirm} danger testId="otta-confirm-yes" />
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
 *    bail — a click with no press behind it is not one this row saw begin.
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
	onActivateRow,
}: {
	caption: string;
	headers: readonly React.ReactNode[];
	children: React.ReactNode;
	testId?: string;
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
					},
				};

	return (
		<div style={{ overflowX: "auto" }}>
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
