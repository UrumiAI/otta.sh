/**
 * The React Themes screen's branch on the `otta` admin route (ADR-0014, amended
 * 2026-09-30): one read (`themes.list`) and one write (`themes:activate`).
 *
 * The write is the Block Kit "Store theme" radio's write, through the same
 * `saveStoreTheme` — so the refusals pinned here are the refusals
 * `store-theme-setting.test.ts` pins for the radio, reached from the console.
 * Driven over a fake kv, because kv is the only store this setting touches, and
 * through `createAdminRouteHandler` for the routing cases so the dispatcher's
 * branch is exercised rather than assumed.
 */
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";
import { describe, expect, test } from "vitest";
import { createAdminRouteHandler } from "../src/admin/admin-route.js";
import { STORE_THEME_KEY } from "../src/admin/store-theme-kv.js";
import type { StoreTheme } from "../src/admin/store-themes.js";
import {
	createThemesConsoleHandler,
	NO_THEMES,
	THEME_NOT_OFFERED,
	THEME_NOT_SAVED,
	THEMES_ACTIVATE_ACTION,
	THEMES_LIST_RESOURCE,
} from "../src/admin/themes-console-route.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import type { PluginContext } from "../src/types.js";

const req = { method: "POST", url: "/route", headers: {} };

const THEMES: readonly StoreTheme[] = [
	{
		id: "tempered",
		label: "Tempered",
		description: "Warm neutrals.",
		preview: "/theme-previews/tempered.webp",
	},
	{ id: "plinth", label: "Plinth", preview: "/theme-previews/plinth.webp" },
	{ id: "pressing", label: "Pressing" },
];

function refuse(): never {
	throw new Error("this suite asserts kv settings, never commerce storage");
}

function makeCtx(
	seed: Record<string, unknown> = {},
	opts: { failRead?: boolean; failWrite?: boolean } = {},
): { ctx: PluginContext; kv: Map<string, unknown> } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const collection = new Proxy({} as StorageCollection, { get: () => refuse });
	const storage: StorageAccess = Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [name, collection]),
	);
	const ctx: PluginContext = {
		storage,
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (opts.failRead === true) throw new Error("kv unavailable");
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				if (opts.failWrite === true) throw new Error("kv unavailable");
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
	};
	return { ctx, kv };
}

async function call(
	ctx: PluginContext,
	input: Record<string, unknown>,
	// `null` = the build baked no list. (Not `undefined`: that would take the
	// default parameter and quietly test the WITH-list case.)
	storeThemes: readonly StoreTheme[] | null = THEMES,
): Promise<Record<string, unknown>> {
	const handler = createThemesConsoleHandler({ storeThemes: storeThemes ?? undefined });
	return (await handler({ input, request: req }, ctx)) as Record<string, unknown>;
}

const LIST = { type: "otta_console_read", resource: THEMES_LIST_RESOURCE };
const activate = (themeId: unknown): Record<string, unknown> => ({
	type: "otta_console_act",
	action_id: THEMES_ACTIVATE_ACTION,
	value: { themeId },
});

describe("themes.list", () => {
	test("lists every offered theme with its preview URL, and the default as active", async () => {
		const { ctx } = makeCtx();
		const out = await call(ctx, LIST);
		expect(out).toEqual({
			ok: true,
			activeId: "tempered",
			exitPreviewUrl: "/?preview_theme=off&silent=1",
			themes: [
				{
					id: "tempered",
					label: "Tempered",
					description: "Warm neutrals.",
					preview: "/theme-previews/tempered.webp",
					previewUrl: "/?preview_theme=tempered",
				},
				{
					id: "plinth",
					label: "Plinth",
					description: null,
					preview: "/theme-previews/plinth.webp",
					previewUrl: "/?preview_theme=plinth",
				},
				{
					id: "pressing",
					label: "Pressing",
					description: null,
					preview: null,
					previewUrl: "/?preview_theme=pressing",
				},
			],
		});
	});

	test("reports the stored theme as active", async () => {
		const { ctx } = makeCtx({ [STORE_THEME_KEY]: "plinth" });
		expect((await call(ctx, LIST)).activeId).toBe("plinth");
	});

	test("a stored id the site no longer offers reads as tempered, like the site", async () => {
		const { ctx } = makeCtx({ [STORE_THEME_KEY]: "retired" });
		expect((await call(ctx, LIST)).activeId).toBe("tempered");
	});

	test("a kv read failure still lists, on tempered", async () => {
		const { ctx } = makeCtx({}, { failRead: true });
		const out = await call(ctx, LIST);
		expect(out.ok).toBe(true);
		expect(out.activeId).toBe("tempered");
	});

	test("with no baked list the screen gets a refusal with copy, not an empty grid", async () => {
		const { ctx } = makeCtx();
		expect(await call(ctx, LIST, null)).toEqual(NO_THEMES);
	});

	test("an unknown themes resource is unreadable", async () => {
		const { ctx } = makeCtx();
		const out = await call(ctx, { type: "otta_console_read", resource: "themes.nope" });
		expect(out.ok).toBe(false);
	});
});

describe("themes:activate — the Settings radio's write path, reached from the console", () => {
	test("activating an offered theme stores its id and says so", async () => {
		const { ctx, kv } = makeCtx();
		const out = await call(ctx, activate("pressing"));
		expect(kv.get(STORE_THEME_KEY)).toBe("pressing");
		expect(out).toMatchObject({
			ok: true,
			activeId: "pressing",
			notice: { variant: "default", title: "Pressing is now your store's theme" },
		});
	});

	test.each([["jumble"], ["PLINTH"], [""], [42], [undefined]])(
		"an id the site does not offer (%p) is refused and nothing is written",
		async (themeId) => {
			const { ctx, kv } = makeCtx({ [STORE_THEME_KEY]: "plinth" });
			const out = await call(ctx, activate(themeId));
			expect(out).toEqual(THEME_NOT_OFFERED);
			expect(kv.get(STORE_THEME_KEY)).toBe("plinth");
		},
	);

	test("with no baked list every activate is refused", async () => {
		const { ctx, kv } = makeCtx();
		expect(await call(ctx, activate("tempered"), null)).toEqual(NO_THEMES);
		expect(kv.has(STORE_THEME_KEY)).toBe(false);
	});

	test("a kv write failure is reported, never claimed as a success", async () => {
		const { ctx } = makeCtx({}, { failWrite: true });
		expect(await call(ctx, activate("plinth"))).toEqual(THEME_NOT_SAVED);
	});

	test("an action id this screen does not offer changes nothing", async () => {
		const { ctx, kv } = makeCtx();
		const out = await call(ctx, {
			type: "otta_console_act",
			action_id: "themes:delete",
			value: { themeId: "plinth" },
		});
		expect(out.ok).toBe(false);
		expect(kv.has(STORE_THEME_KEY)).toBe(false);
	});
});

describe("the admin route dispatches themes to this branch", () => {
	test("a themes.* read reaches the themes handler (baked list absent in this run)", async () => {
		const { ctx } = makeCtx();
		const out = await createAdminRouteHandler()({ input: LIST, request: req }, ctx);
		// This vitest run bakes no `__OTTA_STORE_THEMES__`, so the default handler
		// answers with the themes branch's own refusal — proof of the routing.
		expect(out).toEqual(NO_THEMES);
	});

	test("themes:activate reaches the themes handler, not Orders", async () => {
		const { ctx, kv } = makeCtx();
		const out = await createAdminRouteHandler()({ input: activate("tempered"), request: req }, ctx);
		expect(out).toEqual(NO_THEMES);
		expect(kv.has(STORE_THEME_KEY)).toBe(false);
	});
});
