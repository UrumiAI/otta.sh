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
	testId,
}: {
	label: string;
	onClick: () => void;
	danger?: boolean;
	disabled?: boolean;
	testId?: string;
}): React.ReactElement {
	return (
		<button
			type="button"
			className="otta-focusable"
			data-testid={testId}
			disabled={disabled === true}
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
 */
export function Notice({
	variant,
	title,
	description,
	testId,
}: {
	variant: "default" | "error" | "alert";
	title: string;
	description: string;
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

/** A plain data table. `caption` is visually hidden but present: a table with a
 *  name is navigable, and a screen with two tables in one panel is otherwise two
 *  anonymous grids to a screen-reader user. */
export function Table({
	caption,
	headers,
	children,
	testId,
}: {
	caption: string;
	headers: readonly React.ReactNode[];
	children: React.ReactNode;
	testId?: string;
}): React.ReactElement {
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
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}
