/**
 * The `/themes` console page — the storefront theme picker (ADR-0014, amended
 * 2026-09-30; ADR-0024).
 *
 * WHAT IT IS. WordPress's Appearance → Themes, for this store: a grid of
 * screenshot cards, the active theme first under a solid accent bar, every
 * other theme with "Activate" and a "Live preview" that frames the real
 * storefront in that theme (`ThemePreviewDialog`). It is React rather than
 * Block Kit because Block Kit has no image card, no hover, no link and no
 * frame — the amendment lists them.
 *
 * ONE DATA PATH, as on every console screen: `fetchThemes` and `activateTheme`
 * (`console-api.ts`) post to the `otta` admin route. Activate is the Settings
 * "Store theme" radio's write, through the same plugin function; the radio
 * stays where it is as the Block Kit fallback.
 *
 * THE PREVIEW SESSION. The storefront remembers an admin's preview in a session
 * cookie so links inside the frame stay in the previewed theme. Closing the
 * dialog ends it by loading the plugin-supplied `exitPreviewUrl` in a hidden
 * frame — a navigation, like the preview itself, rather than a second fetch
 * path out of this package. That URL is the SILENT exit (`&silent=1`): the
 * site answers it with an empty 200 carrying the clearing cookie, not a
 * redirect to a fully rendered home page. The exit frame is unmounted once it
 * has loaded, and a preview opened meanwhile does not mount its own frame
 * until then — otherwise the exit's clearing `Set-Cookie` could land after the
 * new preview's and end it.
 */
import * as React from "react";
import {
	activateTheme,
	fetchThemes,
	isFailure,
	type Failure,
	type ThemeSummary,
	type ThemesPayload,
} from "../console-api.js";
import { ConsoleStyles, Notice } from "../ui.js";
import { ThemePreviewDialog } from "./theme-preview-dialog.js";
import { THEMES_STYLES } from "./themes-styles.js";

export const THEMES_SCREEN_TITLE = "Themes";

/** How long the next preview waits on an exit frame that never loads. On a very
 *  slow storefront (over 5s) the exit's clearing cookie can still land after the
 *  next preview's cookie and undo it; accepted (re-open the preview). */
const EXIT_TIMEOUT_MS = 5000;

type Load =
	| { readonly state: "loading" }
	| { readonly state: "failed"; readonly failure: Failure }
	| { readonly state: "ready"; readonly data: ThemesPayload };

interface Toast {
	readonly key: number;
	readonly variant: "success" | "error";
	readonly title: string;
	readonly text: string;
	/** "View store" beside the text, on a success. */
	readonly link?: { readonly href: string; readonly label: string };
}

/** Active first, then the site's own order — the order the grid renders. */
export function orderThemes(
	themes: readonly ThemeSummary[],
	activeId: string,
): readonly ThemeSummary[] {
	const active = themes.filter((theme) => theme.id === activeId);
	return [...active, ...themes.filter((theme) => theme.id !== activeId)];
}

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/** The View Transitions entry point, where the browser has it. Typed locally:
 *  the DOM lib this package compiles against may predate it. */
type StartViewTransition = (update: () => Promise<void>) => unknown;

function EyeIcon(): React.ReactElement {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M1.75 8S4 3.25 8 3.25 14.25 8 14.25 8 12 12.75 8 12.75 1.75 8 1.75 8Z"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinejoin="round"
			/>
			<circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	);
}

function ThemeCard({
	theme,
	active,
	busyId,
	onPreview,
	onActivate,
}: {
	theme: ThemeSummary;
	active: boolean;
	busyId: string | null;
	/** `opener` is where focus returns when the preview closes. */
	onPreview: (theme: ThemeSummary, opener: HTMLElement | null) => void;
	onActivate: (theme: ThemeSummary) => void;
}): React.ReactElement {
	const nameId = `otta-theme-${theme.id}-name`;
	const busy = busyId === theme.id;
	const reveal = React.useRef<HTMLButtonElement | null>(null);
	return (
		<li
			className="otta-theme"
			data-active={active ? "true" : "false"}
			data-theme={theme.id}
			data-testid="otta-theme-card"
			style={{ viewTransitionName: `otta-theme-${theme.id}` } as React.CSSProperties}
		>
			{/* The picture is a pointer convenience; the button inside it is the
			    control, so keyboard and screen-reader users get one clear stop —
			    and the one focus returns to, however the preview was opened. */}
			<div className="otta-theme-shot" onClick={() => onPreview(theme, reveal.current)}>
				{theme.preview === null ? (
					<div className="otta-theme-shot-empty">No preview image</div>
				) : (
					<img
						src={theme.preview}
						alt=""
						width={1200}
						height={900}
						loading="lazy"
						decoding="async"
						draggable={false}
					/>
				)}
				<button
					ref={reveal}
					type="button"
					className="otta-theme-reveal"
					onClick={(event) => {
						event.stopPropagation();
						onPreview(theme, event.currentTarget);
					}}
					aria-label={`Live preview of ${theme.label}`}
					data-testid="otta-theme-preview"
				>
					<EyeIcon />
					Live preview
				</button>
			</div>
			<div className="otta-theme-foot">
				<div className="otta-theme-name">
					<h2 id={nameId}>
						{active ? (
							<>
								Active: <strong>{theme.label}</strong>
							</>
						) : (
							theme.label
						)}
					</h2>
					{theme.description !== null && <p title={theme.description}>{theme.description}</p>}
				</div>
				{active ? (
					<a
						className="otta-tbtn otta-tbtn-on-brand"
						href="/"
						target="_blank"
						rel="noopener"
						data-testid="otta-theme-visit"
					>
						View store
						<span className="otta-sr-only"> (opens in a new tab)</span>
					</a>
				) : (
					<button
						type="button"
						className="otta-tbtn"
						onClick={() => onActivate(theme)}
						disabled={busyId !== null && !busy}
						aria-busy={busy ? true : undefined}
						aria-describedby={nameId}
						data-testid="otta-theme-activate"
					>
						{busy ? "Activating…" : "Activate"}
					</button>
				)}
			</div>
		</li>
	);
}

function SkeletonCard(): React.ReactElement {
	return (
		<li className="otta-theme otta-theme-skel" aria-hidden="true">
			<div className="otta-theme-shot" />
			<div className="otta-theme-foot">
				<div className="otta-theme-name" style={{ display: "grid", gap: 8 }}>
					<div className="otta-skel-line" style={{ inlineSize: "38%" }} />
					<div className="otta-skel-line" style={{ inlineSize: "72%", blockSize: 8 }} />
				</div>
			</div>
		</li>
	);
}

function ToastView({
	toast,
	onDismiss,
}: {
	toast: Toast;
	onDismiss: () => void;
}): React.ReactElement {
	React.useEffect(() => {
		if (toast.variant === "error") return;
		const timer = window.setTimeout(onDismiss, 6000);
		return () => window.clearTimeout(timer);
	}, [toast, onDismiss]);
	return (
		<div
			className="otta-toast"
			// An error interrupts (an inserted alert is announced). A success is
			// announced by the screen's always-mounted status region instead: a
			// live region inserted together with its text is often not read.
			role={toast.variant === "error" ? "alert" : undefined}
			data-variant={toast.variant}
			data-testid="otta-theme-toast"
		>
			<span className="otta-toast-icon" aria-hidden="true">
				{toast.variant === "error" ? (
					<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
						<path
							d="M8 4v5M8 11.5v.5"
							stroke="currentColor"
							strokeWidth="2.2"
							strokeLinecap="round"
						/>
					</svg>
				) : (
					<svg width="12" height="12" viewBox="0 0 16 16" fill="none">
						<path
							d="M3.5 8.5l3 3 6-7"
							stroke="currentColor"
							strokeWidth="2.2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				)}
			</span>
			<div className="otta-toast-body">
				<p className="otta-toast-title">{toast.title}</p>
				<p className="otta-toast-text">
					{toast.text}
					{toast.link !== undefined && (
						<>
							{" "}
							<a href={toast.link.href} target="_blank" rel="noopener">
								{toast.link.label}
							</a>
						</>
					)}
				</p>
			</div>
			<button
				type="button"
				className="otta-tbtn otta-tbtn-ghost otta-tbtn-icon"
				onClick={onDismiss}
				aria-label="Dismiss"
				style={{ blockSize: 24, inlineSize: 24, marginBlockStart: -2 }}
			>
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
					<path
						d="M4 4l8 8M12 4l-8 8"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
					/>
				</svg>
			</button>
		</div>
	);
}

export function ThemesScreen(): React.ReactElement {
	const [load, setLoad] = React.useState<Load>({ state: "loading" });
	const [previewing, setPreviewing] = React.useState<ThemeSummary | null>(null);
	const [busyId, setBusyId] = React.useState<string | null>(null);
	const [toast, setToast] = React.useState<Toast | null>(null);
	/** The exit frame in flight (a fresh key per preview session ended), or
	 *  `null` when none is: set when a preview closes, cleared on its load. */
	const [exitKey, setExitKey] = React.useState<number | null>(null);
	const exitSeq = React.useRef(0);
	/** The control that opened the preview; focus returns to it on close. */
	const [opener, setOpener] = React.useState<HTMLElement | null>(null);
	const toastSeq = React.useRef(0);
	/** Resolves the View Transition's update once React has committed it. */
	const committed = React.useRef<(() => void) | null>(null);
	/** After an Activate (on a card or in the preview), where focus goes: the
	 *  new active card's primary control, its "View store". A card's Activate
	 *  button is replaced by it, so without a handoff focus would drop to
	 *  <body>; from the preview, it lands where the result is. */
	const focusAfterActivate = React.useRef<string | null>(null);
	const root = React.useRef<HTMLDivElement | null>(null);

	const reload = React.useCallback(async () => {
		setLoad({ state: "loading" });
		const result = await fetchThemes();
		setLoad(
			isFailure(result) ? { state: "failed", failure: result } : { state: "ready", data: result },
		);
	}, []);

	React.useEffect(() => {
		void reload();
	}, [reload]);

	const data = load.state === "ready" ? load.data : null;
	const activeId = data?.activeId ?? null;

	React.useLayoutEffect(() => {
		committed.current?.();
		committed.current = null;
	}, [activeId]);

	// A passive effect, not a layout one: when the preview dialog closes in the
	// same commit, its own effect (a child's, so it runs first) returns focus
	// to the opener, and this handoff must win.
	React.useEffect(() => {
		const id = focusAfterActivate.current;
		if (id === null || id !== activeId) return;
		focusAfterActivate.current = null;
		root.current
			?.querySelector<HTMLElement>(`[data-theme="${id}"] [data-testid="otta-theme-visit"]`)
			?.focus();
	}, [activeId]);

	const showToast = React.useCallback((next: Omit<Toast, "key">) => {
		toastSeq.current += 1;
		setToast({ ...next, key: toastSeq.current });
	}, []);
	const dismissToast = React.useCallback(() => setToast(null), []);

	const previewingRef = React.useRef<ThemeSummary | null>(null);
	previewingRef.current = previewing;
	const openPreview = React.useCallback((theme: ThemeSummary, from: HTMLElement | null) => {
		setOpener(from);
		setPreviewing(theme);
	}, []);
	const closePreview = React.useCallback(() => {
		if (previewingRef.current !== null) {
			exitSeq.current += 1;
			setExitKey(exitSeq.current);
		}
		previewingRef.current = null;
		setPreviewing(null);
	}, []);
	const exitLanded = React.useCallback(() => setExitKey(null), []);

	// A backstop, should the exit frame never load (the storefront is down):
	// the next preview must not wait forever. Its own load would fail anyway.
	React.useEffect(() => {
		if (exitKey === null) return;
		const timer = window.setTimeout(exitLanded, EXIT_TIMEOUT_MS);
		return () => window.clearTimeout(timer);
	}, [exitKey, exitLanded]);

	const activate = React.useCallback(
		async (theme: ThemeSummary) => {
			if (busyId !== null) return;
			setBusyId(theme.id);
			const result = await activateTheme(theme.id);
			setBusyId(null);
			if (isFailure(result)) {
				showToast({ variant: "error", title: result.title, text: result.description });
				return;
			}
			closePreview();
			focusAfterActivate.current = result.activeId;
			const apply = (): void =>
				setLoad((current) =>
					current.state === "ready"
						? { state: "ready", data: { ...current.data, activeId: result.activeId } }
						: current,
				);
			// The grid re-orders so the new theme leads. Where the browser can,
			// that move is a 240ms View Transition; otherwise (or under reduced
			// motion) it simply happens.
			const start = (document as unknown as { startViewTransition?: StartViewTransition })
				.startViewTransition;
			if (typeof start === "function" && !prefersReducedMotion()) {
				start.call(
					document,
					() =>
						new Promise<void>((resolve) => {
							committed.current = resolve;
							apply();
						}),
				);
			} else {
				apply();
			}
			showToast({
				variant: "success",
				title: result.notice.title,
				text: result.notice.description,
				link: { href: "/", label: "View store" },
			});
		},
		[busyId, closePreview, showToast],
	);

	const ordered = data === null ? [] : orderThemes(data.themes, data.activeId);

	return (
		<div className="otta-themes" data-testid="otta-themes" ref={root}>
			<ConsoleStyles />
			<style>{THEMES_STYLES}</style>

			<div className="otta-themes-head">
				<h1>{THEMES_SCREEN_TITLE}</h1>
				{data !== null && (
					<span className="otta-themes-count" data-testid="otta-themes-count">
						{data.themes.length}
						<span className="otta-sr-only"> themes</span>
					</span>
				)}
			</div>
			<p className="otta-themes-lede">
				How your storefront looks. Preview any theme on your own catalogue before you switch —
				shoppers only ever see the active one.
			</p>

			{load.state === "failed" && (
				<Notice
					variant="error"
					title={load.failure.title}
					description={load.failure.description}
					action={{ label: "Retry", onClick: () => void reload() }}
					testId="otta-themes-failure"
				/>
			)}

			{load.state === "loading" && (
				<ul className="otta-themes-grid" aria-busy="true" aria-label="Loading themes">
					<SkeletonCard />
					<SkeletonCard />
					<SkeletonCard />
				</ul>
			)}

			{data !== null && (
				<ul
					className="otta-themes-grid"
					aria-label="Storefront themes"
					data-testid="otta-themes-grid"
				>
					{ordered.map((theme) => (
						<ThemeCard
							key={theme.id}
							theme={theme}
							active={theme.id === data.activeId}
							busyId={busyId}
							onPreview={openPreview}
							onActivate={(chosen) => void activate(chosen)}
						/>
					))}
				</ul>
			)}

			<ThemePreviewDialog
				theme={previewing}
				active={previewing !== null && previewing.id === activeId}
				busy={previewing !== null && busyId === previewing.id}
				frameReady={exitKey === null}
				returnFocusTo={opener}
				onActivate={(chosen) => void activate(chosen)}
				onClose={closePreview}
			/>

			{/* Ends the storefront's preview session once the dialog closes;
			    unmounted once it has loaded. */}
			{data !== null && exitKey !== null && (
				<iframe
					key={`exit-${String(exitKey)}`}
					src={data.exitPreviewUrl}
					title="Ending theme preview"
					hidden
					aria-hidden="true"
					tabIndex={-1}
					data-testid="otta-theme-exit-frame"
					onLoad={exitLanded}
				/>
			)}

			{/* Always mounted, so a screen reader is already watching it when a
			    success's text is swapped in. */}
			<div className="otta-sr-only" role="status" data-testid="otta-themes-status">
				{toast !== null && toast.variant === "success" ? `${toast.title}. ${toast.text}` : ""}
			</div>

			{toast !== null && (
				<ToastView key={`toast-${String(toast.key)}`} toast={toast} onDismiss={dismissToast} />
			)}
		</div>
	);
}
