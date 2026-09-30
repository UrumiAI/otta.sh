/**
 * The React console's read/write surface for the Themes screen (ADR-0014,
 * amended 2026-09-30).
 *
 * THE SAME SHAPE AS ORDERS AND PRICING, and the same single data path: the
 * `otta-console` page calls this plugin's authenticated `admin` route with the
 * operator's own session and the `otta_console_read` / `otta_console_act`
 * interaction types (`console-transport.ts`). It holds no capability and no
 * route of its own.
 *
 * WHAT IT READS. The themes the SITE offers (`__OTTA_STORE_THEMES__`, resolved
 * by `store-themes.ts`) and the stored choice, plus the preview URLs the site
 * honours — sent as data so the console never spells the site's query
 * parameter itself.
 *
 * WHAT IT WRITES. Exactly what the Block Kit "Store theme" radio writes, through
 * the same function (`saveStoreTheme` in `store-theme-kv.ts`): an id the site
 * offers, into `settings:storeTheme`, or nothing. The Settings radio stays as
 * the Block Kit fallback for this screen.
 *
 * G5 APPLIES UNCHANGED: every response is HTTP 200 with an outcome in the body.
 */
import type { PluginContext, RouteHandler } from "../types.js";
import {
	CONSOLE_ACT_INTERACTION,
	UNKNOWN_ACTION,
	UNREADABLE_REQUEST,
	readConsolePayload,
	type ConsoleFailure,
} from "./console-transport.js";
import { readString } from "./scaffold/index.js";
import { readStoreThemeId, saveStoreTheme } from "./store-theme-kv.js";
import {
	STORE_THEMES,
	THEME_PREVIEW_EXIT_URL,
	themePreviewUrl,
	type StoreTheme,
} from "./store-themes.js";

/** The `resource` prefix `admin-route.ts` dispatches on. */
export const THEMES_CONSOLE_RESOURCE_PREFIX = "themes.";

/** The one read this screen makes. */
export const THEMES_LIST_RESOURCE = "themes.list";

/** The one write this screen makes. */
export const THEMES_ACTIVATE_ACTION = "themes:activate";

/** Every action id this screen answers — the dispatcher's routing set. */
export const THEMES_ACTION_IDS: ReadonlySet<string> = new Set([THEMES_ACTIVATE_ACTION]);

/** One card. `description` and `preview` are `null`, never absent, so the
 *  console has one spelling of "none". */
export interface ThemeWire {
	readonly id: string;
	readonly label: string;
	readonly description: string | null;
	readonly preview: string | null;
	/** The storefront, rendered in this theme, for a signed-in admin only. */
	readonly previewUrl: string;
}

export interface ThemesListPayload {
	readonly ok: true;
	readonly themes: readonly ThemeWire[];
	readonly activeId: string;
	/** Loading this ends the admin's preview session (clears the cookie). */
	readonly exitPreviewUrl: string;
}

export interface ThemesActivatePayload {
	readonly ok: true;
	readonly activeId: string;
	readonly notice: {
		readonly variant: "default";
		readonly title: string;
		readonly description: string;
	};
}

export interface ThemesConsoleInput {
	type?: unknown;
	resource?: unknown;
	action_id?: unknown;
	value?: unknown;
}

/** The build baked no theme list — this host offers no themes to pick from. */
export const NO_THEMES: ConsoleFailure = {
	ok: false,
	title: "This site offers no storefront themes",
	description:
		"Storefront themes come from the site build. Offer them there and they will appear here. Nothing was changed.",
};

export const THEME_NOT_OFFERED: ConsoleFailure = {
	ok: false,
	title: "Theme not activated",
	description:
		"That is not one of the themes this site offers — it may have been removed by a newer deploy. Reload to see the current list. Nothing was changed.",
};

export const THEME_NOT_SAVED: ConsoleFailure = {
	ok: false,
	title: "Theme not activated",
	description:
		"The setting could not be saved. Your store is still on its previous theme. Try again in a moment.",
};

function toWire(theme: StoreTheme): ThemeWire {
	return {
		id: theme.id,
		label: theme.label,
		description: theme.description ?? null,
		preview: theme.preview ?? null,
		previewUrl: themePreviewUrl(theme.id),
	};
}

export interface ThemesConsoleOptions {
	/** The themes the site offers. Defaults to the baked list; a seam for tests. */
	storeThemes?: readonly StoreTheme[] | undefined;
}

async function consoleList(
	ctx: PluginContext,
	storeThemes: readonly StoreTheme[],
): Promise<ThemesListPayload> {
	return {
		ok: true,
		themes: storeThemes.map(toWire),
		activeId: await readStoreThemeId(ctx, storeThemes),
		exitPreviewUrl: THEME_PREVIEW_EXIT_URL,
	};
}

async function consoleActivate(
	input: ThemesConsoleInput,
	ctx: PluginContext,
	storeThemes: readonly StoreTheme[],
): Promise<ThemesActivatePayload | ConsoleFailure> {
	const actionId = readString(input.action_id);
	if (actionId === undefined) return UNREADABLE_REQUEST;
	if (!THEMES_ACTION_IDS.has(actionId)) return UNKNOWN_ACTION;
	let saved: Awaited<ReturnType<typeof saveStoreTheme>>;
	try {
		saved = await saveStoreTheme(ctx, storeThemes, readConsolePayload(input.value).themeId);
	} catch {
		return THEME_NOT_SAVED;
	}
	if (!saved.ok) return saved.reason === "no-themes" ? NO_THEMES : THEME_NOT_OFFERED;
	return {
		ok: true,
		activeId: saved.theme.id,
		notice: {
			variant: "default",
			title: `${saved.theme.label} is now your store's theme`,
			description: "Shoppers see it on their next page load.",
		},
	};
}

/** The console's half of the `otta` admin route, for Themes. */
export function createThemesConsoleHandler(
	options: ThemesConsoleOptions = {},
): RouteHandler<ThemesConsoleInput> {
	const storeThemes = "storeThemes" in options ? options.storeThemes : STORE_THEMES;
	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		if (storeThemes === undefined) return NO_THEMES;
		if (readString(input.type) === CONSOLE_ACT_INTERACTION) {
			return consoleActivate(input, ctx, storeThemes);
		}
		if (readString(input.resource) === THEMES_LIST_RESOURCE) {
			return consoleList(ctx, storeThemes);
		}
		return UNREADABLE_REQUEST;
	};
}
