/**
 * The React admin console's shell — the whole of `otta-console`'s UI at INC-19.
 *
 * WHAT IT PROVES, which is the entire job of this increment:
 *
 *  1. A `format: "native"` descriptor renders a React page in the EmDash admin
 *     while the `otta` Block Kit descriptor keeps its seven screens and its
 *     sidebar group (ADR-0014 Decision 7 — the `adminMode` granularity trap).
 *  2. `POST /_emdash/api/plugins/otta/admin` — a route belonging to a DIFFERENT
 *     plugin id than the one this page is served under — answers 200. That is
 *     ADR-0014 Decision 3's only data path, and the one thing the 2026-07-31
 *     spike could not establish by reading code: the dispatcher authorises on
 *     the session user's `plugins:manage` permission, the token scope and the
 *     `X-EmDash-Request` CSRF header, and NOTHING in the request identifies the
 *     calling plugin.
 *
 * WHAT ALSO LIVES HERE NOW. INC-20 migrated Orders (`./orders/`), which is the
 * console's first real screen; Pricing & inventory follows in INC-21. Both Block
 * Kit originals stay in the tree and stay green until each replacement is
 * proven (ADR-0014 Decision 1, reaffirmed).
 *
 * NO COMPONENT LIBRARY. `@cloudflare/kumo` and `@phosphor-icons/react` were
 * measured UNRESOLVABLE and unnecessary on the spike; `@emdash-cms/plugin-forms`
 * uses them by choice, not by requirement. Adopting either would be a
 * deliberate new coupling to an unpinned component library (ADR-0014,
 * "what becomes harder"), and it is not taken. Inline styles only — and only
 * ones that survive the admin's dark theme, so no fixed foreground or
 * background colours.
 *
 * NO MONEY ON THIS PAGE — the SHELL, that is. G1 says money is integer minor
 * units rendered through `formatMoney`, and this package cannot import
 * `@otta-sh/plugin` (ADR-0014 Decision 3 / the depcruise quarantine). INC-20
 * answered where the React tier's `formatMoney` comes from the way that comment
 * required: by SHARING the function. It lives in `@otta-sh/admin-presentation`,
 * a dependency-free package both admin surfaces import, and the Orders screen
 * calls it. There is still no second money renderer anywhere in this repo.
 */
import { apiFetch } from "emdash/plugin-utils";
import type { PluginAdminExports } from "emdash";
import * as React from "react";
import { OrdersScreen } from "./orders/orders-screen.js";

/**
 * The Block Kit plugin's single admin dispatch route.
 *
 * `otta`, not `otta-console` — deliberately, and it is the point of the whole
 * arrangement. `ctx.kv` is namespaced per plugin id, so a purpose-built route
 * on `otta-console` would open onto an EMPTY settings namespace and would need
 * the commerce service token duplicated into a second plugin's settings, plus
 * its own `network:request` capability and its own `allowedHosts` — undoing the
 * zero-capability property this descriptor is pinned on. Cross-plugin fetch is
 * the clean path here, not the compromise.
 */
export const OTTA_ADMIN_ROUTE = "/_emdash/api/plugins/otta/admin";

/** The interaction the probe sends: a plain page load of the screen INC-20
 *  migrates, so the shell exercises the data path its successor will use. */
export const PROBE_INTERACTION = { type: "page_load", page: "/orders" } as const;

/** Outcome of the one call this page makes. Rendered verbatim, so a screenshot
 *  is evidence rather than a claim. */
export interface Probe {
	readonly ok: boolean;
	readonly status: number;
	readonly ms: number;
	readonly envelopeKeys: readonly string[];
	readonly blockTypes: readonly string[];
	/** Set when the request never produced a response at all. */
	readonly transportError?: string;
}

interface BlockWire {
	readonly type: string;
}

/**
 * Call `otta`'s admin route and describe what came back.
 *
 * It never throws. G5's reasoning transfers to the React tier for a different
 * mechanism: on Block Kit a non-2xx unmounts the whole block tree, and here an
 * uncaught rejection unmounts the component and leaves the operator a blank
 * pane. Failures are values, and they render.
 *
 * Exported so the failure paths can be driven directly. The interesting ones
 * are not exotic: a 401 (session expired in another tab) and a 403 (the
 * operator's role lost `plugins:manage`) are the two most likely things this
 * page will ever see in production, and both must produce a panel that says so
 * rather than an empty pane.
 */
export async function probeOttaAdminRoute(): Promise<Probe> {
	const started = performance.now();
	try {
		const response = await apiFetch(OTTA_ADMIN_ROUTE, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(PROBE_INTERACTION),
		});
		const ms = Math.round(performance.now() - started);
		const body: unknown = await response.json().catch(() => undefined);
		const envelope = (body ?? {}) as { data?: { blocks?: readonly BlockWire[] } };
		return {
			ok: response.ok,
			status: response.status,
			ms,
			envelopeKeys: body !== undefined && body !== null ? Object.keys(body) : [],
			blockTypes: (envelope.data?.blocks ?? []).map((block) => block.type),
		};
	} catch (error) {
		return {
			ok: false,
			status: 0,
			ms: Math.round(performance.now() - started),
			envelopeKeys: [],
			blockTypes: [],
			transportError: error instanceof Error ? error.message : String(error),
		};
	}
}

// ── presentation ─────────────────────────────────────────────────────────────

/** Theme-neutral. The admin ships light and dark; a fixed foreground or
 *  background colour is legible in exactly one of them. */
const HAIRLINE = "1px solid rgba(128, 128, 128, 0.35)";
const OK_ACCENT = "#2f855a";
const FAIL_ACCENT = "#c53030";
const PENDING_ACCENT = "rgba(128, 128, 128, 0.6)";

/** Logical properties throughout (G6): the admin is RTL-capable and these
 *  styles must not pin anything to the left. */
const panelStyle: React.CSSProperties = {
	border: HAIRLINE,
	borderRadius: 8,
	padding: "14px 16px",
	marginBlockEnd: 20,
	textAlign: "start",
};

function accentFor(probe: Probe | null): string {
	if (probe === null) return PENDING_ACCENT;
	return probe.ok ? OK_ACCENT : FAIL_ACCENT;
}

/**
 * The one line an operator actually reads.
 *
 * A 401 or a 403 must reach the screen as `HTTP 401` / `HTTP 403`, not as a
 * blank panel: those are the realistic failures here (a session that expired in
 * another tab, a role that lost `plugins:manage`), and the whole point of a
 * status panel is that it distinguishes "nothing came back" from "something
 * came back and it was a refusal".
 *
 * DEFERRED TO INC-20, deliberately: this states the status, it does not tell
 * the operator what to DO about it. Remediation copy belongs with the plugin's
 * `getErrorMessage` vocabulary so both surfaces say the same thing, and that is
 * worth doing when a real screen rides this path rather than on a shell whose
 * only job is to prove the path exists.
 */
export function describeProbe(probe: Probe | null): string {
	if (probe === null) return "checking…";
	if (probe.transportError !== undefined) return `no response — ${probe.transportError}`;
	return `HTTP ${probe.status} in ${probe.ms} ms`;
}

function DefinitionRow({ term, children }: { term: string; children: React.ReactNode }) {
	return (
		<>
			<dt style={{ opacity: 0.7 }}>{term}</dt>
			<dd style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{children}</dd>
		</>
	);
}

/**
 * The status panel, split out from the page so it can be rendered against a
 * given `Probe` without a browser, a network or an effect.
 *
 * `aria-live="polite"` is on the panel and is load-bearing: the content arrives
 * after mount, so a screen-reader user who is already on the page gets nothing
 * at all unless the region announces itself.
 */
export function ProbePanel({
	probe,
	onRetry,
}: {
	probe: Probe | null;
	onRetry?: () => void;
}): React.ReactElement {
	return (
		<section
			data-testid="otta-admin-route-probe"
			aria-live="polite"
			style={{
				...panelStyle,
				borderInlineStartWidth: 4,
				borderInlineStartColor: accentFor(probe),
			}}
		>
			<h2 style={{ fontSize: 15, fontWeight: 650, marginBlockEnd: 10 }}>Commerce data path</h2>
			<dl
				style={{
					display: "grid",
					gridTemplateColumns: "max-content 1fr",
					gap: "6px 20px",
					fontSize: 13,
					margin: 0,
				}}
			>
				<DefinitionRow term="Route">
					<code>{OTTA_ADMIN_ROUTE}</code>
				</DefinitionRow>
				<DefinitionRow term="Result">
					<span data-testid="probe-result">{describeProbe(probe)}</span>
				</DefinitionRow>
				{probe !== null && probe.envelopeKeys.length > 0 && (
					<DefinitionRow term="Envelope">
						<code>{probe.envelopeKeys.join(", ")}</code>
					</DefinitionRow>
				)}
				{probe !== null && probe.blockTypes.length > 0 && (
					<DefinitionRow term="Blocks">
						{probe.blockTypes.length} — <code>{probe.blockTypes.join(", ")}</code>
					</DefinitionRow>
				)}
			</dl>
			<p style={{ fontSize: 12, opacity: 0.7, marginBlockStart: 10, marginBlockEnd: 0 }}>
				The console holds no capabilities and no allowed hosts of its own. It reads commerce data by
				calling the <code>otta</code> plugin's admin route with your session, exactly as the Block
				Kit screens do.
			</p>
			<button
				type="button"
				data-testid="probe-retry"
				onClick={onRetry}
				disabled={probe === null}
				style={{
					marginBlockStart: 12,
					padding: "5px 12px",
					fontSize: 13,
					border: HAIRLINE,
					borderRadius: 6,
					background: "transparent",
					color: "inherit",
					cursor: probe === null ? "progress" : "pointer",
				}}
			>
				Check again
			</button>
		</section>
	);
}

/**
 * The console's landing page, registered at `CONSOLE_HOME_PAGE.path`.
 *
 * It is deliberately an operational page rather than a placeholder: it states
 * which descriptor served it, and whether the one data path the React tier has
 * is currently working. When INC-20 lands, this stays as the console's home and
 * the migrated screens sit beside it.
 */
export function ConsoleHomePage(): React.ReactElement {
	const [probe, setProbe] = React.useState<Probe | null>(null);
	const [attempt, setAttempt] = React.useState(0);

	React.useEffect(() => {
		let cancelled = false;
		setProbe(null);
		void probeOttaAdminRoute().then((result) => {
			if (!cancelled) setProbe(result);
		});
		return () => {
			cancelled = true;
		};
	}, [attempt]);

	return (
		<div style={{ padding: 24, maxInlineSize: 880, textAlign: "start" }}>
			<h1 style={{ fontSize: 24, fontWeight: 700, marginBlockEnd: 4 }}>Otta console</h1>
			<p style={{ fontSize: 14, opacity: 0.75, marginBlockEnd: 20 }}>
				The React admin surface, served by plugin <code>otta-console</code>. The commerce screens
				are next door under <strong>Otta</strong> and are unchanged.
			</p>

			<ProbePanel probe={probe} onRetry={() => setAttempt((n) => n + 1)} />

			<section style={panelStyle}>
				<h2 style={{ fontSize: 15, fontWeight: 650, marginBlockEnd: 10 }}>What lives here</h2>
				<p style={{ fontSize: 13, opacity: 0.85, margin: 0 }}>
					Nothing yet. Orders moves here first, then Pricing &amp; inventory. Tax, Shipping and
					Settings stay on the Block Kit surface permanently, so both idioms will always be present
					in this console.
				</p>
			</section>
		</div>
	);
}

/**
 * EmDash types `PluginAdminExports["pages"]` as `Record<string, JSX.Element>`
 * while the admin router calls the value as a COMPONENT
 * (`const PluginComponent = usePluginPage(...); <PluginComponent />`). The
 * shipped `@emdash-cms/plugin-forms` has the same mismatch and casts too. The
 * key MUST equal `CONSOLE_HOME_PAGE.path` from `./index.ts`, or the sidebar
 * drops the entry without an error; `test/console-plugin.test.ts` pins that.
 */
export const pages = {
	"/console": ConsoleHomePage,
	"/orders": OrdersScreen,
} as unknown as PluginAdminExports["pages"];
