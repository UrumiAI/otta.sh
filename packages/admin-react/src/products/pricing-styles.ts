/**
 * The Pricing & stock cards' and the Products list columns' stylesheet
 * (ADR-0014, amendment 2026-10-01).
 *
 * Both surfaces render INSIDE EmDash's own screens — the product editor's
 * settings column and the collection list — so they read the admin's Kumo CSS
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
	--op-recessed: var(--color-kumo-recessed, rgba(128, 128, 128, 0.10));
	--op-fill: var(--color-kumo-fill, rgba(128, 128, 128, 0.14));
	--op-brand: var(--color-kumo-brand, LinkText);
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
}
.otta-pricing p { margin: 0; }
/* ── cards: the main-column layout ─────────────────────────────────────── */
.otta-pricing { container-type: inline-size; }
.otta-pricing-cardset {
	display: flex;
	flex-direction: column;
	gap: 16px;
	border: 0;
	margin: 0;
	padding: 0;
	min-inline-size: 0;
}
.otta-pricing-cardset:disabled { opacity: 0.7; }
.otta-pricing-card {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 18px 20px;
	border: 1px solid var(--op-line);
	border-radius: 12px;
	background: var(--op-card);
	box-shadow: 0 1px 2px var(--color-kumo-shadow-drop, rgba(0, 0, 0, 0.05));
}
.otta-pricing-card-title { margin: 0; font-size: 15px; line-height: 20px; font-weight: 650; }
.otta-pricing-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px 16px; }
@container (min-width: 520px) {
	.otta-pricing-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
details.otta-pricing-card > summary .otta-pricing-card-title { font-size: 15px; }
.otta-pricing-section { display: flex; flex-direction: column; gap: 12px; }
.otta-pricing-rule { block-size: 1px; background: var(--op-hairline); border: 0; margin: 0; }
.otta-pricing-field { display: flex; flex-direction: column; gap: 6px; }
.otta-pricing-label { font-weight: 600; }
.otta-pricing-optional { font-weight: 400; color: var(--op-subtle); }
.otta-pricing-hint { font-size: 13px; color: var(--op-subtle); }
.otta-pricing-error { font-size: 13px; color: var(--op-fail); }
.otta-pricing-input {
	display: flex;
	align-items: center;
	gap: 6px;
	block-size: 40px;
	box-sizing: border-box;
	padding: 0 12px;
	border: 1px solid var(--op-line);
	border-radius: 8px;
	background: var(--op-card);
}
.otta-pricing-input:focus-within {
	outline: 2px solid var(--op-brand);
	outline-offset: 1px;
}
.otta-pricing-input[data-invalid="true"] { border-color: var(--op-fail); }
.otta-pricing-input input, .otta-pricing-input select {
	flex: 1;
	min-inline-size: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: inherit;
	font: inherit;
}
.otta-pricing-affix { color: var(--op-subtle); }
.otta-pricing-num { font-variant-numeric: tabular-nums; }
.otta-pricing-sale s { color: var(--op-subtle); }
.otta-pricing-sale strong { color: var(--op-strong); }
.otta-pricing-margin { display: flex; gap: 16px; font-size: 13px; color: var(--op-subtle); }
.otta-pricing-margin strong { color: var(--op-strong); font-variant-numeric: tabular-nums; }
.otta-pricing-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.otta-pricing-count { display: flex; align-items: baseline; gap: 8px; }
.otta-pricing-count strong { font-size: 28px; line-height: 32px; font-variant-numeric: tabular-nums; }
.otta-pricing-count span { color: var(--op-subtle); }
.otta-pricing-badge {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 10px;
	border-radius: 999px;
	font-size: 12px;
	font-weight: 600;
	white-space: nowrap;
}
.otta-pricing-dot { inline-size: 7px; block-size: 7px; border-radius: 999px; flex: none; }
[data-tone="ok"] .otta-pricing-dot, .otta-pricing-dot[data-tone="ok"] { background: var(--op-ok); }
[data-tone="warn"] .otta-pricing-dot, .otta-pricing-dot[data-tone="warn"] { background: var(--op-warn); }
[data-tone="fail"] .otta-pricing-dot, .otta-pricing-dot[data-tone="fail"] { background: var(--op-fail); }
[data-tone="none"] .otta-pricing-dot, .otta-pricing-dot[data-tone="none"] { background: var(--op-subtle); }
.otta-pricing-badge[data-tone="ok"] { background: color-mix(in srgb, var(--op-ok) 16%, transparent); }
.otta-pricing-badge[data-tone="warn"] { background: color-mix(in srgb, var(--op-warn) 18%, transparent); }
.otta-pricing-badge[data-tone="fail"] { background: color-mix(in srgb, var(--op-fail) 16%, transparent); }
.otta-pricing-badge[data-tone="none"] { background: var(--op-fill); }
.otta-pricing-stockrow { display: flex; gap: 8px; }
.otta-pricing-qty {
	inline-size: 72px;
	block-size: 40px;
	box-sizing: border-box;
	padding: 0 8px;
	border: 1px solid var(--op-line);
	border-radius: 8px;
	background: var(--op-card);
	color: inherit;
	font: inherit;
	text-align: center;
	font-variant-numeric: tabular-nums;
}
.otta-pricing-btn {
	block-size: 40px;
	padding: 0 16px;
	border-radius: 8px;
	border: 1px solid var(--op-line);
	background: var(--op-card);
	color: inherit;
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}
.otta-pricing-btn:hover:not(:disabled) { background: var(--op-recessed); }
.otta-pricing-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.otta-pricing-btn[data-grow="true"] { flex: 1; padding: 0 8px; }
.otta-pricing-btn[data-primary="true"] {
	border-color: transparent;
	background: var(--op-strong);
	color: var(--op-card);
}
.otta-pricing-btn[data-primary="true"]:hover:not(:disabled) { background: var(--op-strong); opacity: 0.88; }
.otta-pricing :is(button, input, select, summary):focus-visible {
	outline: 2px solid var(--op-brand);
	outline-offset: 2px;
}
.otta-pricing-qty:focus-visible { outline-offset: 1px; }
.otta-pricing-status { font-size: 13px; min-block-size: 20px; }
.otta-pricing-status[data-tone="ok"] { color: var(--op-ok); }
.otta-pricing-status[data-tone="fail"] { color: var(--op-fail); }
.otta-pricing-status[data-tone="muted"] { color: var(--op-subtle); }
.otta-pricing-callout {
	padding: 12px 14px;
	border-radius: 10px;
	background: var(--op-recessed);
	display: flex;
	flex-direction: column;
	gap: 4px;
}
.otta-pricing-callout[data-tone="warn"] { background: color-mix(in srgb, var(--op-warn) 14%, transparent); }
.otta-pricing-callout strong { font-weight: 600; }
.otta-pricing-callout span { color: var(--op-subtle); }
.otta-pricing details > summary {
	list-style: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	cursor: pointer;
}
.otta-pricing details > summary::-webkit-details-marker { display: none; }
.otta-pricing details > summary svg { transition: transform 160ms ease-out; flex: none; }
.otta-pricing details[open] > summary svg { transform: rotate(180deg); }
.otta-pricing-summary { display: flex; flex-direction: column; gap: 2px; }
.otta-pricing-summary span { font-size: 13px; color: var(--op-subtle); }
.otta-pricing-summary .otta-pricing-card-title { font-size: 15px; color: var(--op-fg); }
.otta-pricing-details { display: flex; flex-direction: column; gap: 14px; padding-block-start: 4px; }
.otta-pricing-segment {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 4px;
	padding: 4px;
	border-radius: 10px;
	background: var(--op-fill);
}
.otta-pricing-segment label {
	display: flex;
	align-items: center;
	justify-content: center;
	block-size: 34px;
	border-radius: 7px;
	font-weight: 600;
	cursor: pointer;
}
.otta-pricing-segment label[data-checked="true"] {
	background: var(--op-card);
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.14);
}
.otta-pricing-segment label:has(input:focus-visible) {
	outline: 2px solid var(--op-brand);
	outline-offset: 2px;
}
.otta-pricing-sizes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.otta-pricing-footer { display: flex; align-items: center; justify-content: flex-start; gap: 12px; flex-direction: row-reverse; }
@media (prefers-reduced-motion: reduce) {
	.otta-pricing details > summary svg { transition: none; }
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
