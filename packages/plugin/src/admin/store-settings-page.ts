import type {
	AdminPageConfig,
	Block,
	BlockResponse,
	RouteHandler,
	SandboxedRouteContext,
} from "../types.js";
import { noticeBanner } from "./scaffold/banner.js";

/**
 * Store settings — ONE admin page that hosts the Settings, Tax and Shipping
 * screens as tabs, so the sidebar's Plugins group carries one entry where it
 * used to carry three.
 *
 * Nothing about the three screens changes: each panel is the UNCHANGED output of
 * that screen's own handler. EmDash 1.0.1 gives a plugin no way to place a page
 * anywhere but the Plugins group (no `group`, no Settings-hub slot), so merging
 * pages is the only lever on the sidebar that needs no host change.
 *
 * WHY EVERY RESPONSE REBUILDS EVERY PANEL. EmDash's page renderer replaces the
 * whole block tree with each response (`setBlocks(data.blocks)`), and a `tab`
 * block switches panels client side only, with no interaction. So an action in
 * the Tax panel must answer with the full tabbed page — Tax's own response in
 * its panel, a fresh `page_load` of the other two — or the tabs vanish after the
 * first click. The tab block keeps a stable `block_id`, so React keeps it mounted
 * across responses and the operator stays on the tab they were using;
 * `default_tab` points at the acting panel for the case where it re-mounts.
 *
 * The acting handler runs FIRST and the others after it, so a panel that reads
 * what the action just wrote (Shipping showing the store currency a General save
 * changed) renders the new state, not the old.
 *
 * The old `/settings`, `/tax` and `/shipping` pages stay served by the dispatcher
 * for bookmarks; only an interaction that names THIS page is wrapped.
 */
export const STORE_SETTINGS_PAGE: AdminPageConfig = {
	path: "/store-settings",
	label: "Store settings",
	icon: "settings",
};

/** The tab block's `block_id` — stable so the renderer keeps the selected tab. */
export const STORE_SETTINGS_TABS_BLOCK_ID = "store-settings:tabs";

/** One tab: the screen it shows and the action ids that screen owns. */
export interface StoreSettingsPanel {
	label: string;
	/** The screen's own page path, sent as that screen's `page_load`. */
	page: string;
	actionIds: ReadonlySet<string>;
	handler: RouteHandler<never>;
}

export interface StoreSettingsInput {
	type?: unknown;
	page?: unknown;
	action_id?: unknown;
}

/** True when `actionId` belongs to one of the panels — the dispatcher's test for
 *  routing an interaction from this page here. */
export function storeSettingsOwnsAction(
	panels: readonly StoreSettingsPanel[],
	actionId: string,
): boolean {
	return panels.some((p) => p.actionIds.has(actionId));
}

/** A handler's result, narrowed to the envelope. Anything without a `blocks`
 *  array renders as an empty panel rather than breaking the other two. */
function asBlockResponse(result: unknown): BlockResponse {
	if (
		typeof result === "object" &&
		result !== null &&
		Array.isArray((result as BlockResponse).blocks)
	) {
		return result as BlockResponse;
	}
	return { blocks: [] };
}

/** What a panel shows when its screen threw while a DIFFERENT panel was in use.
 *  Generic on purpose: no raw error text in the admin UI (banner.ts). */
function panelFailedBlocks(label: string): Block[] {
	return [
		noticeBanner({
			variant: "error",
			title: `Couldn't load ${label}`,
			description: "Reload the page to try again.",
		}),
	];
}

export function createStoreSettingsPageHandler(
	panels: readonly StoreSettingsPanel[],
): RouteHandler<StoreSettingsInput> {
	return async (routeCtx, ctx) => {
		const actionId =
			typeof routeCtx.input.action_id === "string" ? routeCtx.input.action_id : undefined;
		const actingIndex =
			actionId === undefined ? -1 : panels.findIndex((p) => p.actionIds.has(actionId));

		const loadPanel = async (panel: StoreSettingsPanel): Promise<Block[]> => {
			const loadCtx = { ...routeCtx, input: { type: "page_load", page: panel.page } };
			try {
				return asBlockResponse(await panel.handler(loadCtx as SandboxedRouteContext<never>, ctx))
					.blocks;
			} catch {
				return panelFailedBlocks(panel.label);
			}
		};

		// The acting screen answers exactly as it would on its own page; only a
		// sibling's failure is contained, so the action's own outcome is never hidden.
		let acting: BlockResponse | undefined;
		if (actingIndex >= 0) {
			const panel = panels[actingIndex]!;
			acting = asBlockResponse(await panel.handler(routeCtx as SandboxedRouteContext<never>, ctx));
		}
		const panelBlocks = await Promise.all(
			panels.map((panel, i) =>
				i === actingIndex && acting !== undefined ? acting.blocks : loadPanel(panel),
			),
		);

		const response: BlockResponse = {
			blocks: [
				{ type: "header", text: STORE_SETTINGS_PAGE.label },
				{
					type: "tab",
					block_id: STORE_SETTINGS_TABS_BLOCK_ID,
					default_tab: Math.max(actingIndex, 0),
					panels: panels.map((panel, i) => ({ label: panel.label, blocks: panelBlocks[i]! })),
				},
			],
			...(acting?.toast !== undefined ? { toast: acting.toast } : {}),
		};
		return response;
	};
}
