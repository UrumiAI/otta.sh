/**
 * The Pricing & stock cards' and the Products list columns' stylesheet
 * (ADR-0014, amendment 2026-10-01).
 *
 * Both surfaces render INSIDE EmDash's own screens — the product editor's
 * main column and the collection list — so they read the admin's Kumo CSS
 * custom properties, as the Themes screen does (`../themes/themes-styles.ts`),
 * and look native in light and dark mode. Every read has a theme-neutral
 * fallback (a system colour or an alpha grey), so outside the admin the panel
 * degrades to the console's usual look rather than to invisible text.
 *
 * STOCK TONES are a fixed accent mixed into transparency, so the same rule works
 * on a light and a dark surface; the label beside each dot carries the meaning,
 * never the colour alone.
 *
 * No backticks inside the sheet: it is a template literal.
 */
import * as React from "react";

export const PRICING_STYLES = `
.otta-pricing, .otta-pricing-cell {
	--op-fg: var(--text-color-kumo-default, CanvasText);
	--op-subtle: var(--text-color-kumo-subtle, color-mix(in srgb, currentColor 62%, transparent));
	--op-strong: var(--text-color-kumo-strong, CanvasText);
	--op-card: var(--color-kumo-base, Canvas);
	--op-line: var(--color-kumo-line, rgba(128, 128, 128, 0.32));
	--op-hairline: var(--color-kumo-hairline, rgba(128, 128, 128, 0.18));
	--op-tint: var(--color-kumo-tint, rgba(128, 128, 128, 0.08));
	--op-fill: var(--color-kumo-fill, rgba(128, 128, 128, 0.14));
	--op-brand: var(--color-kumo-brand, LinkText);
	--op-ring: color-mix(in srgb, var(--op-brand) 24%, transparent);
	--op-shadow: var(--color-kumo-shadow-drop, rgba(0, 0, 0, 0.05));
	/* Readable on both surfaces: the admin sets color-scheme by mode, so
	   light-dark() picks the darker ink on light and the lighter on dark. */
	--op-ok: light-dark(#1a7a43, #5fd18f);
	--op-warn: light-dark(#9a5b00, #f0b45a);
	--op-fail: light-dark(#b42d08, #ff8f70);
}
.otta-pricing {
	display: flex;
	flex-direction: column;
	gap: 16px;
	color: var(--op-fg);
	font-size: 14px;
	line-height: 20px;
	text-align: start;
	container-type: inline-size;
}
.otta-pricing p { margin: 0; }
.otta-pricing ::selection { background: var(--op-ring); }

/* ── cards ─────────────────────────────────────────────────────────────────
   Same border, surface and 8px control radius as the editor's own Images
   field above them; the card itself is one step rounder because it holds
   controls. */
.otta-pricing-cardset {
	display: flex;
	flex-direction: column;
	gap: 16px;
	border: 0;
	margin: 0;
	padding: 0;
	min-inline-size: 0;
}
.otta-pricing-cardset:disabled { opacity: 0.6; }
.otta-pricing-card {
	display: flex;
	flex-direction: column;
	gap: 20px;
	padding: 20px;
	border: 1px solid var(--op-line);
	border-radius: 12px;
	background: var(--op-card);
	box-shadow: 0 1px 2px var(--op-shadow);
}
.otta-pricing-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-block-size: 24px; }
.otta-pricing-card-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--op-fg); }
.otta-pricing-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px 16px; }
.otta-pricing-rule { block-size: 1px; background: var(--op-hairline); border: 0; margin: 0; }
@container (min-width: 520px) {
	.otta-pricing-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ── fields: EmDash's own metrics (14px medium label, 8px gap, 36px control) */
.otta-pricing-field { display: flex; flex-direction: column; gap: 8px; min-inline-size: 0; }
.otta-pricing-labelrow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.otta-pricing-label { font-weight: 500; color: var(--op-fg); }
.otta-pricing-optional { font-size: 12px; color: var(--op-subtle); }
.otta-pricing-hint { font-size: 13px; line-height: 18px; color: var(--op-subtle); }
.otta-pricing-error { font-size: 13px; line-height: 18px; color: var(--op-fail); }
.otta-pricing-input {
	display: flex;
	align-items: center;
	gap: 8px;
	block-size: 36px;
	box-sizing: border-box;
	padding: 0 12px;
	border: 1px solid var(--op-line);
	border-radius: 8px;
	background: var(--op-card);
	transition: border-color 120ms ease-out, box-shadow 120ms ease-out;
}
.otta-pricing-input:focus-within {
	border-color: var(--op-brand);
	box-shadow: 0 0 0 3px var(--op-ring);
}
.otta-pricing-input[data-invalid="true"] { border-color: var(--op-fail); }
.otta-pricing-input[data-invalid="true"]:focus-within {
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--op-fail) 22%, transparent);
}
.otta-pricing-input input, .otta-pricing-input select {
	flex: 1;
	min-inline-size: 0;
	block-size: 100%;
	padding: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	caret-color: var(--op-brand);
}
.otta-pricing-input input::placeholder { color: var(--op-subtle); opacity: 0.7; }
.otta-pricing-input select { cursor: pointer; }
.otta-pricing-affix { flex: none; font-size: 13px; color: var(--op-subtle); }
.otta-pricing-num { font-variant-numeric: tabular-nums; }
.otta-pricing-sale s { color: var(--op-subtle); }
.otta-pricing-sale strong { font-weight: 600; color: var(--op-ok); }

/* Size: one control, three numbers. */
.otta-pricing-dims input { text-align: center; }
.otta-pricing-dims .otta-pricing-times { flex: none; color: var(--op-subtle); opacity: 0.7; }

/* ── profit readout, beside Cost per item ───────────────────────────────── */
.otta-pricing-readout {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	align-items: center;
	gap: 16px;
	min-block-size: 64px;
	box-sizing: border-box;
	padding: 10px 16px;
	border-radius: 8px;
	background: var(--op-tint);
}
.otta-pricing-readout[data-empty="true"] {
	grid-template-columns: minmax(0, 1fr);
	background: transparent;
	border: 1px dashed var(--op-line);
}
.otta-pricing-stat { display: flex; flex-direction: column; gap: 2px; }
.otta-pricing-stat > span { font-size: 12px; line-height: 16px; color: var(--op-subtle); }
.otta-pricing-stat > strong { font-size: 18px; line-height: 24px; font-weight: 600; color: var(--op-fg); font-variant-numeric: tabular-nums; }

/* ── inventory ──────────────────────────────────────────────────────────── */
.otta-pricing-stock {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 12px 16px;
	padding: 14px 16px;
	border-radius: 8px;
	background: var(--op-tint);
}
.otta-pricing-count { display: flex; align-items: baseline; gap: 8px; }
.otta-pricing-count strong { font-size: 28px; line-height: 32px; font-weight: 600; letter-spacing: -0.01em; color: var(--op-fg); font-variant-numeric: tabular-nums; }
.otta-pricing-count span { color: var(--op-subtle); }
.otta-pricing-adjust { display: flex; flex-direction: column; gap: 6px; }
.otta-pricing-adjust > label { font-size: 12px; line-height: 16px; color: var(--op-subtle); }
.otta-pricing-stepper {
	display: inline-flex;
	align-items: stretch;
	block-size: 36px;
	box-sizing: border-box;
	border: 1px solid var(--op-line);
	border-radius: 8px;
	background: var(--op-card);
	overflow: hidden;
}
.otta-pricing-stepper:focus-within { border-color: var(--op-brand); box-shadow: 0 0 0 3px var(--op-ring); }
.otta-pricing-stepper button {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 0 12px;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	font-weight: 500;
	cursor: pointer;
	transition: background-color 120ms ease-out;
}
.otta-pricing-stepper button:hover:not(:disabled) { background: var(--op-tint); }
.otta-pricing-stepper button:disabled { color: var(--op-subtle); cursor: not-allowed; }
.otta-pricing-stepper button:focus-visible { outline: 2px solid var(--op-brand); outline-offset: -2px; }
.otta-pricing-stepper svg { flex: none; color: var(--op-subtle); }
.otta-pricing-qty {
	inline-size: 56px;
	padding: 0 4px;
	border: 0;
	border-inline: 1px solid var(--op-line);
	outline: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	font-weight: 600;
	text-align: center;
	font-variant-numeric: tabular-nums;
	caret-color: var(--op-brand);
}

.otta-pricing-badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 10px;
	border-radius: 999px;
	font-size: 12px;
	line-height: 18px;
	font-weight: 500;
	white-space: nowrap;
}
.otta-pricing-dot { inline-size: 6px; block-size: 6px; border-radius: 999px; flex: none; }
[data-tone="ok"] .otta-pricing-dot, .otta-pricing-dot[data-tone="ok"] { background: var(--op-ok); }
[data-tone="warn"] .otta-pricing-dot, .otta-pricing-dot[data-tone="warn"] { background: var(--op-warn); }
[data-tone="fail"] .otta-pricing-dot, .otta-pricing-dot[data-tone="fail"] { background: var(--op-fail); }
[data-tone="none"] .otta-pricing-dot, .otta-pricing-dot[data-tone="none"] { background: var(--op-subtle); }
.otta-pricing-badge[data-tone="ok"] { color: var(--op-ok); background: color-mix(in srgb, var(--op-ok) 12%, transparent); }
.otta-pricing-badge[data-tone="warn"] { color: var(--op-warn); background: color-mix(in srgb, var(--op-warn) 14%, transparent); }
.otta-pricing-badge[data-tone="fail"] { color: var(--op-fail); background: color-mix(in srgb, var(--op-fail) 12%, transparent); }
.otta-pricing-badge[data-tone="none"] { color: var(--op-subtle); background: var(--op-tint); }

/* ── buttons ────────────────────────────────────────────────────────────── */
.otta-pricing-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	block-size: 36px;
	padding: 0 14px;
	border-radius: 8px;
	border: 1px solid var(--op-line);
	background: var(--op-card);
	color: inherit;
	font: inherit;
	font-weight: 500;
	white-space: nowrap;
	cursor: pointer;
	transition: background-color 120ms ease-out, opacity 120ms ease-out;
}
.otta-pricing-btn:hover:not(:disabled) { background: var(--op-tint); }
.otta-pricing-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.otta-pricing-btn[data-primary="true"] {
	border-color: transparent;
	background: var(--op-fg);
	color: var(--op-card);
}
.otta-pricing-btn[data-primary="true"]:hover:not(:disabled) { background: var(--op-fg); opacity: 0.86; }
.otta-pricing :is(button, select, summary):focus-visible {
	outline: 2px solid var(--op-brand);
	outline-offset: 2px;
}

.otta-pricing-status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 18px; min-block-size: 18px; }
.otta-pricing-status:empty { min-block-size: 0; }
.otta-pricing-status[data-tone="ok"] { color: var(--op-ok); }
.otta-pricing-status[data-tone="fail"] { color: var(--op-fail); }
.otta-pricing-status[data-tone="muted"] { color: var(--op-subtle); }
.otta-pricing-callout {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 10px 14px;
	border-radius: 8px;
	background: var(--op-tint);
	font-size: 13px;
	line-height: 18px;
}
.otta-pricing-callout[data-tone="warn"] { color: var(--op-warn); background: color-mix(in srgb, var(--op-warn) 10%, transparent); }
.otta-pricing-callout strong { font-size: 14px; font-weight: 600; color: var(--op-fg); }
.otta-pricing-callout span { color: var(--op-subtle); }
.otta-pricing-callout[data-tone="warn"] span { color: inherit; }

/* ── Download file ──────────────────────────────────────────────────────── */
.otta-pricing-file {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 14px;
	border: 1px solid var(--op-hairline);
	border-radius: 8px;
	background: var(--op-tint);
	min-inline-size: 0;
}
.otta-pricing-file-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: none;
	inline-size: 36px;
	block-size: 36px;
	border-radius: 8px;
	background: var(--op-card);
	border: 1px solid var(--op-hairline);
	color: var(--op-subtle);
}
.otta-pricing-file-text { display: flex; flex-direction: column; gap: 2px; min-inline-size: 0; }
.otta-pricing-file-text > strong { font-weight: 600; overflow-wrap: anywhere; }
.otta-pricing-file-text > .otta-pricing-hint { overflow-wrap: anywhere; }
.otta-pricing-file-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.otta-pricing-file-actions > .otta-pricing-status { flex: 1 1 220px; }
.otta-pricing-progress {
	appearance: none;
	inline-size: 100%;
	block-size: 6px;
	border: 0;
	border-radius: 999px;
	background: var(--op-fill);
	overflow: hidden;
}
.otta-pricing-progress::-webkit-progress-bar { background: var(--op-fill); border-radius: 999px; }
.otta-pricing-progress::-webkit-progress-value { background: var(--op-brand); border-radius: 999px; transition: inline-size 120ms ease-out; }
.otta-pricing-progress::-moz-progress-bar { background: var(--op-brand); border-radius: 999px; }

/* ── Shipping & tax disclosure ──────────────────────────────────────────── */
.otta-pricing details > summary {
	list-style: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin: -20px;
	padding: 20px;
	border-radius: 12px;
	cursor: pointer;
}
.otta-pricing details > summary::-webkit-details-marker { display: none; }
.otta-pricing details > summary:focus-visible { outline-offset: -2px; }
.otta-pricing-chevron {
	display: grid;
	place-items: center;
	inline-size: 28px;
	block-size: 28px;
	flex: none;
	border-radius: 8px;
	color: var(--op-subtle);
	transition: background-color 120ms ease-out;
}
.otta-pricing details > summary:hover .otta-pricing-chevron { background: var(--op-tint); color: var(--op-fg); }
.otta-pricing-chevron svg { transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.otta-pricing details[open] .otta-pricing-chevron svg { transform: rotate(180deg); }
.otta-pricing-summary { display: flex; flex-direction: column; gap: 2px; min-inline-size: 0; }
.otta-pricing-summary > span:last-child { font-size: 13px; line-height: 18px; color: var(--op-subtle); }
.otta-pricing-details { padding-block-start: 4px; }
.otta-pricing-fieldset { border: 0; margin: 0; padding: 0; min-inline-size: 0; display: flex; flex-direction: column; gap: 8px; }
.otta-pricing-fieldset > legend { padding: 0; margin-block-end: 8px; float: left; inline-size: 100%; }
.otta-pricing-segment {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 2px;
	block-size: 36px;
	box-sizing: border-box;
	padding: 3px;
	border-radius: 8px;
	background: var(--op-tint);
	clear: both;
}
.otta-pricing-segment label {
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 6px;
	font-weight: 500;
	color: var(--op-subtle);
	cursor: pointer;
	transition: background-color 120ms ease-out, color 120ms ease-out;
}
.otta-pricing-segment label:hover { color: var(--op-fg); }
.otta-pricing-segment label[data-checked="true"] {
	background: var(--op-card);
	color: var(--op-fg);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), 0 0 0 1px var(--op-line);
}
.otta-pricing-segment label:has(input:focus-visible) {
	outline: 2px solid var(--op-brand);
	outline-offset: 1px;
}

/* ── the save bar ───────────────────────────────────────────────────────────
   At rest it is a quiet row. With unsaved edits it lifts into a bar that
   stays on screen while the merchant scrolls the editor, because the CMS's
   own Save (top right) does not save these cards. */
.otta-pricing-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 0 0 0 4px;
}
.otta-pricing-footer[data-dirty="true"] {
	position: sticky;
	inset-block-end: 16px;
	z-index: 2;
	padding: 10px 10px 10px 16px;
	border: 1px solid var(--op-line);
	border-radius: 12px;
	background: var(--op-card);
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
}
.otta-pricing-footer > .otta-pricing-btn { margin-inline-start: auto; }
.otta-pricing-footer > .otta-pricing-status { flex: 1 1 240px; }
@container (max-width: 519px) {
	.otta-pricing-footer { flex-wrap: wrap; }
	.otta-pricing-footer > .otta-pricing-btn { flex: 1 1 100%; }
}
.otta-pricing-pending { inline-size: 7px; block-size: 7px; border-radius: 999px; background: var(--op-warn); flex: none; }
@media (prefers-reduced-motion: reduce) {
	.otta-pricing *, .otta-pricing-chevron svg { transition: none !important; }
}

/* ── list columns ───────────────────────────────────────────────────────── */
.otta-pricing-cell { display: inline-flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
.otta-pricing-cell s { font-size: 12px; color: var(--op-subtle); }
.otta-pricing-cell[data-align="start"] { align-items: flex-start; }
.otta-pricing-cell-stock { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.otta-pricing-cell-muted { color: var(--op-subtle); }
.otta-pricing .otta-sr-only, .otta-pricing-cell .otta-sr-only {
	position: absolute;
	inline-size: 1px;
	block-size: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}
`;

const STYLE_ID = "otta-pricing-styles";

/** Put the sheet in the document ONCE, however many cells and panels mount — a
 *  list page renders two cells per row, and a `<style>` per cell would repeat
 *  the sheet a hundred times. */
export function usePricingStyles(): void {
	React.useInsertionEffect(() => {
		if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
		const style = document.createElement("style");
		style.id = STYLE_ID;
		style.textContent = PRICING_STYLES;
		document.head.append(style);
	}, []);
}
