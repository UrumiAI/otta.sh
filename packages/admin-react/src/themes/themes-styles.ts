/**
 * The Themes screen's stylesheet (ADR-0014 as amended 2026-09-30).
 *
 * WHY THIS SCREEN READS THE ADMIN'S TOKENS when the rest of the console is
 * strictly `currentColor` and alpha greys (`ui.tsx`, rule 1). A theme picker is
 * a gallery of pictures, and three things on it cannot be drawn in
 * `currentColor` without looking foreign in the EmDash admin: the SOLID accent
 * bar that marks the active theme, the card surface the screenshots sit on, and
 * the primary "Activate" button. So it reads EmDash's own Kumo CSS custom
 * properties — `--color-kumo-brand`, `--color-kumo-base`, `--color-kumo-line`,
 * `--text-color-kumo-subtle` … — which the admin stylesheet defines for light
 * AND dark (`[data-mode=dark]`). That is a dependency on a stylesheet the page is
 * already rendered inside, not on the `@cloudflare/kumo` component library,
 * which stays unadopted. Every read carries a theme-neutral fallback (a system
 * colour or an alpha grey), so outside the admin — a DOM test, a future admin
 * that renames a token — the screen degrades to the console's usual look rather
 * than to invisible text.
 *
 * MOTION is 150–250ms ease-out, on opacity/transform/filter only, and all of it
 * is switched off under `prefers-reduced-motion: reduce`.
 *
 * No backticks inside the sheet: it is a template literal.
 */
export const THEMES_STYLES = `
.otta-themes {
	--ot-fg: var(--text-color-kumo-default, CanvasText);
	--ot-subtle: var(--text-color-kumo-subtle, color-mix(in srgb, currentColor 62%, transparent));
	--ot-strong: var(--text-color-kumo-strong, CanvasText);
	--ot-card: var(--color-kumo-base, Canvas);
	--ot-line: var(--color-kumo-line, rgba(128, 128, 128, 0.28));
	--ot-hairline: var(--color-kumo-hairline, rgba(128, 128, 128, 0.18));
	--ot-recessed: var(--color-kumo-recessed, rgba(128, 128, 128, 0.12));
	--ot-fill: var(--color-kumo-fill, rgba(128, 128, 128, 0.16));
	--ot-fill-hover: var(--color-kumo-fill-hover, rgba(128, 128, 128, 0.22));
	--ot-brand: var(--color-kumo-brand, LinkText);
	--ot-brand-hover: var(--color-kumo-brand-hover, var(--ot-brand));
	--ot-shadow: var(--color-kumo-shadow-drop, rgba(0, 0, 0, 0.08));
	--ot-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
	container-type: inline-size;
	color: var(--ot-fg);
}

/* ── header ─────────────────────────────────────────────────────────────── */
.otta-themes-head {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-block-end: 6px;
}
.otta-themes-head h1 {
	font-size: 24px;
	font-weight: 700;
	letter-spacing: -0.01em;
	margin: 0;
}
.otta-themes-count {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-inline-size: 24px;
	block-size: 22px;
	padding: 0 8px;
	border-radius: 999px;
	background: var(--ot-fill);
	color: var(--ot-strong);
	font-size: 12px;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
}
.otta-themes-lede {
	margin: 0 0 24px;
	font-size: 14px;
	line-height: 1.5;
	color: var(--ot-subtle);
	max-inline-size: 640px;
}

/* ── grid ───────────────────────────────────────────────────────────────── */
.otta-themes-grid {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 28px 24px;
}
@container (max-width: 940px) {
	.otta-themes-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 20px; }
}
@container (max-width: 560px) {
	.otta-themes-grid { grid-template-columns: minmax(0, 1fr); gap: 20px; }
}

/* ── card ───────────────────────────────────────────────────────────────── */
.otta-theme {
	view-transition-class: otta-theme;
	position: relative;
	display: flex;
	flex-direction: column;
	border: 1px solid var(--ot-line);
	border-radius: 10px;
	background: var(--ot-card);
	overflow: hidden;
	box-shadow: 0 1px 2px var(--ot-shadow);
	transition: box-shadow 200ms var(--ot-ease), border-color 200ms var(--ot-ease);
}
.otta-theme:hover,
.otta-theme:focus-within {
	box-shadow: 0 1px 2px var(--ot-shadow), 0 12px 28px -14px rgba(0, 0, 0, 0.28);
}
.otta-theme[data-active="true"] {
	border-color: var(--ot-brand);
}

.otta-theme-shot {
	position: relative;
	aspect-ratio: 4 / 3;
	overflow: hidden;
	background: var(--ot-recessed);
	border-block-end: 1px solid var(--ot-hairline);
	cursor: pointer;
}
.otta-theme-shot img {
	display: block;
	inline-size: 100%;
	block-size: 100%;
	object-fit: cover;
	object-position: top center;
	transition: transform 250ms var(--ot-ease), filter 200ms var(--ot-ease);
}
.otta-theme-shot::after {
	content: "";
	position: absolute;
	inset: 0;
	background: rgba(12, 14, 18, 0.42);
	opacity: 0;
	transition: opacity 200ms var(--ot-ease);
	pointer-events: none;
}
.otta-theme-shot-empty {
	display: grid;
	place-items: center;
	block-size: 100%;
	font-size: 13px;
	color: var(--ot-subtle);
}
.otta-theme-reveal {
	position: absolute;
	z-index: 1;
	inset-block-start: 50%;
	inset-inline-start: 50%;
	translate: -50% -50%;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	block-size: 36px;
	padding: 0 16px;
	border: 0;
	border-radius: 8px;
	background: rgba(255, 255, 255, 0.96);
	color: #111418;
	font: inherit;
	font-size: 13px;
	font-weight: 600;
	white-space: nowrap;
	box-shadow: 0 6px 20px -6px rgba(0, 0, 0, 0.45);
	cursor: pointer;
	opacity: 0;
	transform: translateY(6px);
	transition: opacity 180ms var(--ot-ease), transform 200ms var(--ot-ease);
}
.otta-theme-reveal:focus-visible {
	outline: 2px solid #ffffff;
	outline-offset: 3px;
}
.otta-theme-shot:hover::after,
.otta-theme:focus-within .otta-theme-shot::after { opacity: 1; }
.otta-theme-shot:hover img,
.otta-theme:focus-within .otta-theme-shot img { transform: scale(1.015); filter: saturate(0.92); }
.otta-theme-shot:hover .otta-theme-reveal,
.otta-theme:focus-within .otta-theme-reveal {
	opacity: 1;
	transform: none;
}
/* Touch: there is no hover to reveal it, so it is simply there — on a
   lighter scrim, so the screenshot still reads. */
@media (hover: none) {
	.otta-theme-shot::after { opacity: 0.5; }
	.otta-theme-reveal { opacity: 1; transform: none; }
}

/* ── card footer ────────────────────────────────────────────────────────── */
.otta-theme-foot {
	flex: 1;
	display: flex;
	align-items: center;
	gap: 12px;
	min-block-size: 64px;
	padding: 12px 14px 12px 16px;
}
.otta-theme-name {
	flex: 1;
	min-inline-size: 0;
}
.otta-theme-name h2 {
	margin: 0;
	font-size: 15px;
	font-weight: 650;
	line-height: 1.3;
}
.otta-theme-name p {
	margin: 2px 0 0;
	font-size: 12.5px;
	line-height: 1.4;
	color: var(--ot-subtle);
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	overflow: hidden;
}
.otta-theme[data-active="true"] .otta-theme-foot {
	background: var(--ot-brand);
	color: #ffffff;
}
.otta-theme[data-active="true"] .otta-theme-name h2 { font-weight: 500; }
.otta-theme[data-active="true"] .otta-theme-name h2 strong { font-weight: 700; }
.otta-theme[data-active="true"] .otta-theme-name p { color: rgba(255, 255, 255, 0.78); }

/* ── buttons ────────────────────────────────────────────────────────────── */
.otta-tbtn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	flex: none;
	block-size: 32px;
	padding: 0 12px;
	border: 1px solid var(--ot-line);
	border-radius: 7px;
	background: var(--ot-card);
	color: var(--ot-fg);
	font: inherit;
	font-size: 13px;
	font-weight: 550;
	line-height: 1;
	text-decoration: none;
	white-space: nowrap;
	cursor: pointer;
	transition: background-color 150ms var(--ot-ease), border-color 150ms var(--ot-ease),
		opacity 150ms var(--ot-ease);
}
.otta-tbtn:hover { background: var(--ot-fill-hover); }
.otta-tbtn:focus-visible { outline: 2px solid var(--ot-brand); outline-offset: 2px; }
.otta-tbtn:disabled,
.otta-tbtn[aria-disabled="true"] { cursor: not-allowed; opacity: 0.55; }
.otta-tbtn[aria-busy="true"] { cursor: progress; opacity: 0.8; }
.otta-tbtn-primary {
	border-color: transparent;
	background: var(--ot-brand);
	color: #ffffff;
}
.otta-tbtn-primary:hover { background: var(--ot-brand-hover); }
.otta-tbtn-on-brand {
	border-color: rgba(255, 255, 255, 0.45);
	background: transparent;
	color: #ffffff;
}
.otta-tbtn-on-brand:hover { background: rgba(255, 255, 255, 0.14); }
.otta-tbtn-on-brand:focus-visible { outline-color: #ffffff; }
.otta-tbtn-ghost {
	border-color: transparent;
	background: transparent;
}
.otta-tbtn-icon { inline-size: 32px; padding: 0; }
.otta-tbtn svg { flex: none; }

/* ── skeleton ───────────────────────────────────────────────────────────── */
.otta-theme-skel .otta-theme-shot { cursor: default; }
.otta-skel-line {
	block-size: 10px;
	border-radius: 999px;
	background: var(--ot-fill);
}
.otta-theme-skel .otta-theme-shot,
.otta-skel-line { animation: otta-skel 1.4s ease-in-out infinite; }
@keyframes otta-skel { 50% { opacity: 0.55; } }

/* ── toast ──────────────────────────────────────────────────────────────── */
.otta-toast {
	position: fixed;
	z-index: 60;
	inset-block-end: 24px;
	inset-inline-end: 24px;
	display: flex;
	align-items: flex-start;
	gap: 12px;
	inline-size: min(380px, calc(100vw - 32px));
	padding: 14px 12px 14px 14px;
	border: 1px solid var(--ot-line);
	border-radius: 10px;
	background: var(--ot-card);
	color: var(--ot-fg);
	box-shadow: 0 16px 40px -16px rgba(0, 0, 0, 0.35), 0 1px 2px var(--ot-shadow);
	animation: otta-toast-in 220ms var(--ot-ease);
}
.otta-toast-icon {
	flex: none;
	display: grid;
	place-items: center;
	inline-size: 20px;
	block-size: 20px;
	margin-block-start: 1px;
	border-radius: 50%;
	color: #ffffff;
	background: var(--color-kumo-success, #1f8a4c);
}
.otta-toast[data-variant="error"] .otta-toast-icon { background: var(--color-kumo-danger, #c53030); }
.otta-toast-body { flex: 1; min-inline-size: 0; }
.otta-toast-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.35; }
.otta-toast-text { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--ot-subtle); }
.otta-toast-text a { color: var(--text-color-kumo-link, LinkText); font-weight: 550; }
@keyframes otta-toast-in {
	from { opacity: 0; transform: translateY(8px); }
}
@media (max-width: 599px) {
	.otta-toast { inset-inline: 16px; inset-block-end: 16px; inline-size: auto; }
}

/* ── live preview dialog ────────────────────────────────────────────────── */
.otta-live {
	position: fixed;
	inset: 0;
	inline-size: 100vw;
	block-size: 100dvh;
	max-inline-size: none;
	max-block-size: none;
	margin: 0;
	padding: 0;
	border: 0;
	background: var(--ot-recessed);
	color: var(--ot-fg);
	overflow: hidden;
}
.otta-live[open] {
	display: flex;
	flex-direction: column;
	animation: otta-live-in 220ms var(--ot-ease);
}
.otta-live::backdrop { background: rgba(0, 0, 0, 0.5); }
@keyframes otta-live-in {
	from { opacity: 0; transform: scale(0.985); }
}
.otta-live-bar {
	position: relative;
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
	align-items: center;
	gap: 12px;
	block-size: 56px;
	padding: 0 12px 0 8px;
	background: var(--ot-card);
	border-block-end: 1px solid var(--ot-line);
	flex: none;
}
.otta-live-title {
	display: flex;
	align-items: center;
	gap: 10px;
	min-inline-size: 0;
}
.otta-live-title-text { min-inline-size: 0; }
.otta-live-title h2 {
	margin: 0;
	font-size: 14px;
	font-weight: 650;
	line-height: 1.25;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.otta-live-title p {
	margin: 1px 0 0;
	font-size: 12px;
	color: var(--ot-subtle);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.otta-live-sep {
	inline-size: 1px;
	block-size: 24px;
	background: var(--ot-line);
	flex: none;
}
.otta-live-devices {
	display: inline-flex;
	padding: 3px;
	gap: 2px;
	border-radius: 9px;
	background: var(--ot-fill);
}
.otta-live-devices button {
	display: grid;
	place-items: center;
	inline-size: 34px;
	block-size: 28px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--ot-subtle);
	cursor: pointer;
	transition: background-color 150ms var(--ot-ease), color 150ms var(--ot-ease),
		box-shadow 150ms var(--ot-ease);
}
.otta-live-devices button:hover { color: var(--ot-fg); }
.otta-live-devices button[aria-pressed="true"] {
	background: var(--ot-card);
	color: var(--ot-fg);
	box-shadow: 0 1px 2px var(--ot-shadow), 0 0 0 1px var(--ot-hairline);
}
.otta-live-devices button:focus-visible { outline: 2px solid var(--ot-brand); outline-offset: 1px; }
.otta-live-actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
}
.otta-live-active-chip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	block-size: 32px;
	padding: 0 12px;
	border-radius: 7px;
	background: var(--ot-fill);
	font-size: 13px;
	font-weight: 550;
	color: var(--ot-strong);
}
.otta-live-progress {
	position: absolute;
	inset-inline: 0;
	inset-block-end: -1px;
	block-size: 2px;
	overflow: hidden;
	pointer-events: none;
}
.otta-live-progress::before {
	content: "";
	position: absolute;
	inset-block: 0;
	inline-size: 30%;
	background: var(--ot-brand);
	animation: otta-live-progress 1.1s var(--ot-ease) infinite;
}
@keyframes otta-live-progress {
	from { inset-inline-start: -30%; }
	to { inset-inline-start: 100%; }
}
.otta-live-stage {
	position: relative;
	flex: 1;
	min-block-size: 0;
	display: flex;
	justify-content: center;
	align-items: stretch;
	padding: 0;
	transition: padding 220ms var(--ot-ease);
}
.otta-live-stage[data-device="tablet"],
.otta-live-stage[data-device="phone"] { padding: 24px; }
.otta-live-frame {
	inline-size: 100%;
	block-size: 100%;
	max-inline-size: 100%;
	border: 0;
	background: #ffffff;
	transition: max-inline-size 240ms var(--ot-ease), border-radius 240ms var(--ot-ease),
		box-shadow 240ms var(--ot-ease), opacity 200ms var(--ot-ease);
}
.otta-live-stage[data-device="tablet"] .otta-live-frame,
.otta-live-stage[data-device="phone"] .otta-live-frame {
	border-radius: 14px;
	box-shadow: 0 0 0 1px var(--ot-line), 0 24px 60px -24px rgba(0, 0, 0, 0.45);
}
.otta-live-stage[data-device="tablet"] .otta-live-frame { max-inline-size: 834px; }
.otta-live-stage[data-device="phone"] .otta-live-frame { max-inline-size: 390px; }
.otta-live-frame[data-loading="true"] { opacity: 0.35; }
@media (max-width: 760px) {
	.otta-live-bar { grid-template-columns: minmax(0, 1fr) auto; }
	.otta-live-devices { display: none; }
	.otta-live-newtab-label { display: none; }
	.otta-live-title p { display: none; }
}

/* ── reduced motion: nothing moves, nothing pulses ──────────────────────── */
@media (prefers-reduced-motion: reduce) {
	.otta-themes *,
	.otta-themes *::after,
	.otta-live,
	.otta-live * {
		transition-duration: 1ms !important;
		animation-duration: 1ms !important;
		animation-iteration-count: 1 !important;
	}
	.otta-theme-shot:hover img,
	.otta-theme:focus-within .otta-theme-shot img { transform: none; }
}
::view-transition-group(*.otta-theme) {
	animation-duration: 240ms;
	animation-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1);
}
`;
