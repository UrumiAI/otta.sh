/**
 * The LIVE PREVIEW overlay — the storefront, in one theme, framed full-screen
 * inside the admin (the WordPress customizer's preview, without the customizer).
 *
 * A NATIVE MODAL `<dialog>`, like the console's `ConfirmDialog`, and for the same
 * reasons, more of them here: `showModal()` puts it in the top layer above the
 * admin's own chrome whatever that chrome's stacking is, makes the rest of the
 * page inert (the focus trap, for free and without a keydown handler), and
 * turns Esc into a `cancel` event. Focus is handed back on close to the
 * control the screen names as the opener (`returnFocusTo`: the card's "Live
 * preview" button, also when the preview was opened by clicking the card's
 * picture, which takes no focus of its own).
 *
 * ESC INSIDE THE FRAME. Once the merchant clicks into the storefront, key
 * events go to the frame's document, not to the dialog, so Esc would stop
 * working exactly when it is most wanted. The frame is same-origin (the
 * storefront and the admin are one site), so on every load the dialog listens
 * for Esc on the frame's window too.
 *
 * THE FRAME'S URL comes from the plugin (`previewUrl`), which builds it from the
 * one constant the site's middleware reads. The site honours it for an admin
 * only and keeps it across in-frame navigation with a session cookie; closing
 * this dialog ends that session (see `ThemesScreen`).
 *
 * WAITING FOR THE LAST EXIT. The screen passes `frameReady: false` while the
 * previous preview's exit is still in flight, and the frame is not mounted
 * until it lands: the exit's clearing `Set-Cookie` must not arrive after this
 * preview's own cookie (see `ThemesScreen`).
 *
 * FRAMING. The admin's production policy is `default-src 'self'`, which covers
 * a same-origin frame. The storefront sends EmDash's baseline
 * `X-Frame-Options: SAMEORIGIN` (its `finalizeResponse`) and no
 * `frame-ancestors`, which permits exactly this same-origin frame. A deployment
 * that tightens framing must keep same-origin allowed or the frame is refused;
 * "Open in new tab" is always offered as the way through.
 */
import * as React from "react";
import type { ThemeSummary } from "../console-api.js";

type Device = "desktop" | "tablet" | "phone";

const DEVICES: readonly { id: Device; label: string; icon: React.ReactElement }[] = [
	{
		id: "desktop",
		label: "Desktop",
		icon: (
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<rect
					x="1.75"
					y="2.25"
					width="12.5"
					height="8.5"
					rx="1.25"
					stroke="currentColor"
					strokeWidth="1.5"
				/>
				<path
					d="M5.5 13.75h5M8 10.75v3"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
			</svg>
		),
	},
	{
		id: "tablet",
		label: "Tablet",
		icon: (
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<rect
					x="3"
					y="1.75"
					width="10"
					height="12.5"
					rx="1.5"
					stroke="currentColor"
					strokeWidth="1.5"
				/>
				<path d="M7 11.75h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			</svg>
		),
	},
	{
		id: "phone",
		label: "Phone",
		icon: (
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<rect
					x="4.5"
					y="1.75"
					width="7"
					height="12.5"
					rx="1.5"
					stroke="currentColor"
					strokeWidth="1.5"
				/>
				<path d="M7.25 11.75h1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			</svg>
		),
	},
];

function CloseIcon(): React.ReactElement {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	);
}

function ExternalIcon(): React.ReactElement {
	return (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<path
				d="M9.5 2.5h4v4M13.25 2.75 7.5 8.5M12 9.5v3.25c0 .41-.34.75-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5c0-.41.34-.75.75-.75H7"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function ThemePreviewDialog({
	theme,
	active,
	busy,
	frameReady,
	returnFocusTo,
	onActivate,
	onClose,
}: {
	/** The theme being previewed; `null` when the dialog is closed. */
	theme: ThemeSummary | null;
	/** Is `theme` the store's active theme? Then there is nothing to activate. */
	active: boolean;
	/** An activation is in flight. */
	busy: boolean;
	/** May the storefront frame mount yet? False while a previous preview's
	 *  exit is still loading. */
	frameReady: boolean;
	/** Where focus goes when the dialog closes: the control that opened it. */
	returnFocusTo: HTMLElement | null;
	onActivate: (theme: ThemeSummary) => void;
	onClose: () => void;
}): React.ReactElement {
	const ref = React.useRef<HTMLDialogElement | null>(null);
	const frame = React.useRef<HTMLIFrameElement | null>(null);
	const [device, setDevice] = React.useState<Device>("desktop");
	const [loading, setLoading] = React.useState(true);
	const open = theme !== null;

	// Keep the latest close handler reachable from listeners attached to the
	// frame's window, which outlive any one render.
	const closeRef = React.useRef(onClose);
	closeRef.current = onClose;
	const returnFocusRef = React.useRef(returnFocusTo);
	returnFocusRef.current = returnFocusTo;

	React.useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (open && !dialog.open) {
			setDevice("desktop");
			setLoading(true);
			dialog.showModal();
		}
		if (!open && dialog.open) {
			dialog.close();
			// Hand focus back to the "Live preview" button that opened us.
			returnFocusRef.current?.focus();
		}
	}, [open]);

	/** On each frame load: stop the progress bar, and listen for Esc and for the
	 *  next navigation inside the frame. */
	const onFrameLoad = React.useCallback(() => {
		setLoading(false);
		const win = frame.current?.contentWindow ?? null;
		if (win === null) return;
		try {
			win.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Escape") closeRef.current();
			});
			win.addEventListener("pagehide", () => setLoading(true));
		} catch {
			// A frame that is not same-origin (a deployment that redirected the
			// storefront elsewhere) cannot be listened to. Esc still works once
			// focus is back on the bar, and nothing else depends on this.
		}
	}, []);

	const title = theme === null ? "" : theme.label;

	return (
		<dialog
			ref={ref}
			className="otta-live"
			aria-labelledby="otta-live-title"
			data-testid="otta-theme-live"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			{theme !== null && (
				<>
					<header className="otta-live-bar">
						<div className="otta-live-title">
							<button
								type="button"
								className="otta-tbtn otta-tbtn-ghost otta-tbtn-icon"
								onClick={onClose}
								aria-label="Close preview"
								title="Close preview (Esc)"
								data-testid="otta-theme-live-close"
							>
								<CloseIcon />
							</button>
							<span className="otta-live-sep" aria-hidden="true" />
							<div className="otta-live-title-text">
								<h2 id="otta-live-title">
									{active ? `${title} — your active theme` : `Previewing ${title}`}
								</h2>
								<p>
									{theme.description ??
										"Your store, rendered in this theme. Shoppers don’t see it."}
								</p>
							</div>
						</div>

						<div className="otta-live-devices" role="group" aria-label="Preview width">
							{DEVICES.map((entry) => (
								<button
									key={entry.id}
									type="button"
									aria-pressed={device === entry.id}
									aria-label={entry.label}
									title={entry.label}
									onClick={() => setDevice(entry.id)}
								>
									{entry.icon}
								</button>
							))}
						</div>

						<div className="otta-live-actions">
							<a
								className="otta-tbtn otta-tbtn-ghost"
								href={theme.previewUrl}
								target="_blank"
								rel="noopener"
								data-testid="otta-theme-live-newtab"
							>
								<ExternalIcon />
								<span className="otta-live-newtab-label">Open in new tab</span>
								<span className="otta-sr-only"> (opens in a new tab)</span>
							</a>
							{active ? (
								<span className="otta-live-active-chip">
									<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
										<path
											d="M3.5 8.5l3 3 6-7"
											stroke="currentColor"
											strokeWidth="1.8"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
									Active
								</span>
							) : (
								<button
									type="button"
									className="otta-tbtn otta-tbtn-primary"
									onClick={() => onActivate(theme)}
									disabled={busy}
									aria-busy={busy ? true : undefined}
									data-testid="otta-theme-live-activate"
								>
									{busy ? "Activating…" : `Activate ${title}`}
								</button>
							)}
						</div>
						{loading && <div className="otta-live-progress" aria-hidden="true" />}
					</header>

					<div className="otta-live-stage" data-device={device}>
						{frameReady && (
							<iframe
								ref={frame}
								key={theme.id}
								className="otta-live-frame"
								src={theme.previewUrl}
								title={`${title} storefront preview`}
								data-loading={loading ? "true" : "false"}
								data-testid="otta-theme-live-frame"
								onLoad={onFrameLoad}
							/>
						)}
					</div>
				</>
			)}
		</dialog>
	);
}
