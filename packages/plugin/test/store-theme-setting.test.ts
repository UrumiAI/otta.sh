/**
 * The admin "Store theme" setting (theme architecture, "Admin side").
 *
 * The plugin hard-codes no theme list: the SITE bakes the list it offers into
 * the bundle as the Vite define `__OTTA_STORE_THEMES__` (the `__OTTA_EMAIL_API_URL__`
 * pattern, `manifest.ts`). This suite pins both halves:
 *  - the define's resolution — a `typeof` guard plus a shape check, so anything
 *    malformed is treated exactly like absent;
 *  - the Settings handler's behaviour with a list (radio rendered, a listed id
 *    saved to `settings:storeTheme`, an unlisted one refused) and without one
 *    (no radio, every `save-theme` refused) — the latter being what the sandbox
 *    bundle, other hosts and this vitest run actually get.
 *
 * The handler is driven over a fake kv (the same shape `payment-secrets.test.ts`
 * uses), because kv is the only store this setting touches.
 */
import type { StorageAccess, StorageCollection } from "@otta-sh/store-emdash";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	createSettingsFormHandler,
	SETTINGS_ACTION_IDS,
	STORE_THEME_KEY,
} from "../src/admin/settings-form.js";
import { resolveStoreThemes, STORE_THEMES, type StoreTheme } from "../src/admin/store-themes.js";
import { COMMERCE_STORAGE_COLLECTIONS } from "../src/commerce/commerce-storage.js";
import type { PluginContext } from "../src/types.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import { field, findBlocks, formFor, type LooseBlock } from "./helpers/blocks.js";

const req = { method: "POST", url: "/route", headers: {} };

const THEMES: readonly StoreTheme[] = [
	{ id: "tempered", label: "Tempered" },
	{ id: "plinth", label: "Plinth" },
	{ id: "pressing", label: "Pressing" },
];

function refuseStorageCall(): never {
	throw new Error("this suite asserts kv settings, never commerce storage");
}

function makeUnusedStorage(): StorageAccess {
	const collection = new Proxy({} as StorageCollection, { get: () => refuseStorageCall });
	return Object.fromEntries(
		Object.keys(COMMERCE_STORAGE_COLLECTIONS).map((name) => [name, collection]),
	);
}

function makeCtx(
	seed: Record<string, unknown> = {},
	failingKeys: ReadonlySet<string> = new Set(),
): { ctx: PluginContext; kv: Map<string, unknown> } {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const ctx: PluginContext = {
		storage: makeUnusedStorage(),
		http: { fetch: () => Promise.reject(new Error("no egress in this suite")) },
		kv: {
			async get<T>(k: string): Promise<T | null> {
				if (failingKeys.has(k)) throw new Error(`kv unavailable: ${k}`);
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
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

interface Outcome {
	blocks: LooseBlock[];
	toast?: { message?: string; type?: string };
}

async function invoke(
	ctx: PluginContext,
	input: Record<string, unknown>,
	storeThemes: readonly StoreTheme[] | undefined,
): Promise<Outcome> {
	const handler = createSettingsFormHandler({ storeThemes });
	return (await handler({ input, request: req }, ctx)) as unknown as Outcome;
}

function themeRadio(blocks: readonly LooseBlock[]): Record<string, unknown> | undefined {
	return field(formFor(blocks, "save-theme"), "storeTheme");
}

function storeLabel(blocks: readonly LooseBlock[]): string {
	const store = findBlocks(blocks, "accordion").find((a) => a.block_id === "settings:store");
	return String(store?.label);
}

function errorBanner(blocks: readonly LooseBlock[]): LooseBlock | undefined {
	return findBlocks(blocks, "banner").find((b) => b.variant === "error");
}

describe("the __OTTA_STORE_THEMES__ define", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	test("is absent in this vitest run, so the baked list is undefined", () => {
		expect(STORE_THEMES).toBeUndefined();
	});

	test("a well-formed baked list is read through the typeof guard", async () => {
		vi.stubGlobal("__OTTA_STORE_THEMES__", [{ id: "tempered", label: "Tempered" }]);
		vi.resetModules();
		const fresh = await import("../src/admin/store-themes.js");
		expect(fresh.STORE_THEMES).toEqual([{ id: "tempered", label: "Tempered" }]);
	});

	test("a malformed baked list is treated as absent", async () => {
		vi.stubGlobal("__OTTA_STORE_THEMES__", [{ id: "Bad Id", label: "Bad" }]);
		vi.resetModules();
		const fresh = await import("../src/admin/store-themes.js");
		expect(fresh.STORE_THEMES).toBeUndefined();
	});

	test("resolveStoreThemes accepts a non-empty list of {id, label}", () => {
		expect(resolveStoreThemes(THEMES)).toEqual(THEMES);
	});

	test.each([
		["undefined", undefined],
		["null", null],
		["a string", "tempered"],
		["an empty array", []],
		["an entry that is not an object", ["tempered"]],
		["an uppercase id", [{ id: "Tempered", label: "Tempered" }]],
		["an id starting with a digit", [{ id: "1st", label: "First" }]],
		["an id over 32 chars", [{ id: `a${"b".repeat(32)}`, label: "Long" }]],
		["an empty label", [{ id: "tempered", label: "" }]],
		["a label over 40 chars", [{ id: "tempered", label: "x".repeat(41) }]],
		["a non-string label", [{ id: "tempered", label: 7 }]],
		["one bad entry among good ones", [...THEMES, { id: "", label: "Blank" }]],
		["the reserved preview-exit id", [{ id: "off", label: "Off" }]],
		["an empty description", [{ id: "tempered", label: "Tempered", description: "" }]],
		[
			"a description over 160 chars",
			[{ id: "tempered", label: "Tempered", description: "x".repeat(161) }],
		],
		["an absolute-URL preview", [{ id: "tempered", label: "T", preview: "https://x.test/a.webp" }]],
		["a protocol-relative preview", [{ id: "tempered", label: "T", preview: "//x.test/a.webp" }]],
		["a relative preview", [{ id: "tempered", label: "T", preview: "theme-previews/a.webp" }]],
		["a traversing preview", [{ id: "tempered", label: "T", preview: "/a/../b.webp" }]],
		["a preview with a query", [{ id: "tempered", label: "T", preview: "/a.webp?x=1" }]],
		["a javascript: preview", [{ id: "tempered", label: "T", preview: "javascript:alert(1)" }]],
		["a non-image preview", [{ id: "tempered", label: "T", preview: "/theme-previews/a.svg" }]],
	])("resolveStoreThemes treats %s as absent", (_name, raw) => {
		expect(resolveStoreThemes(raw)).toBeUndefined();
	});

	test("resolveStoreThemes keeps a description and a same-origin preview path", () => {
		const entry = {
			id: "plinth",
			label: "Plinth",
			description: "Gallery-quiet, one product at a time.",
			preview: "/theme-previews/plinth.webp",
		};
		expect(resolveStoreThemes([entry])).toEqual([entry]);
	});

	test("resolveStoreThemes drops unknown keys", () => {
		expect(resolveStoreThemes([{ id: "batch", label: "Batch", css: "evil" }])).toEqual([
			{ id: "batch", label: "Batch" },
		]);
	});
});

describe("Settings: the Store theme picker (define present)", () => {
	test("save-theme is a routable Settings action", () => {
		expect(SETTINGS_ACTION_IDS.has("save-theme")).toBe(true);
	});

	test("the Store group renders a radio of the baked list, defaulting to tempered", async () => {
		const { ctx } = makeCtx();
		const { blocks } = await invoke(ctx, { type: "page_load" }, THEMES);
		assertBlockContract(blocks, { screen: "settings", level: "list" });
		const radio = themeRadio(blocks);
		// A radio, never a select: EmDash's select trigger renders the raw id
		// ("tempered") instead of the label when closed (R-17a); a radio row is
		// captioned by its label.
		expect(radio?.type).toBe("radio");
		expect(radio?.options).toEqual([
			{ value: "tempered", label: "Tempered" },
			{ value: "plinth", label: "Plinth" },
			{ value: "pressing", label: "Pressing" },
		]);
		expect(radio?.initial_value).toBe("tempered");
		const form = formFor(blocks, "save-theme");
		expect((form?.submit as { label?: string } | undefined)?.label).toBe("Save store theme");
		// Beside the display name, in the SAME group.
		const store = findBlocks(blocks, "accordion").find((a) => a.block_id === "settings:store");
		expect(formFor((store?.blocks as LooseBlock[]) ?? [], "save-theme")).toBeDefined();
		expect(formFor((store?.blocks as LooseBlock[]) ?? [], "save-display")).toBeDefined();
		expect(storeLabel(blocks)).toBe("Store — no display name · Tempered");
	});

	test("the radio and label reflect the stored theme", async () => {
		const { ctx } = makeCtx({ [STORE_THEME_KEY]: "plinth", "settings:storeDisplayName": "Acme" });
		const { blocks } = await invoke(ctx, { type: "page_load" }, THEMES);
		expect(themeRadio(blocks)?.initial_value).toBe("plinth");
		expect(storeLabel(blocks)).toBe("Store — Acme · Plinth");
	});

	test("saving a listed id writes kv, re-renders the full page and toasts", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await invoke(
			ctx,
			{ type: "form_submit", action_id: "save-theme", values: { storeTheme: "pressing" } },
			THEMES,
		);
		expect(kv.get(STORE_THEME_KEY)).toBe("pressing");
		assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
		expect(outcome.toast).toEqual({
			message: "Theme saved — live on the next page load",
			type: "success",
		});
		expect(themeRadio(outcome.blocks)?.initial_value).toBe("pressing");
		expect(storeLabel(outcome.blocks)).toBe("Store — no display name · Pressing");
		// Full screen, not a fragment.
		expect(formFor(outcome.blocks, "save-display")).toBeDefined();
		expect(formFor(outcome.blocks, "save-payment-settings")).toBeDefined();
		expect(errorBanner(outcome.blocks)).toBeUndefined();
	});

	test.each([["jumble"], ["TEMPERED"], [""], [42], [undefined]])(
		"an unlisted id (%p) is refused with an error notice and nothing is saved",
		async (submitted) => {
			const { ctx, kv } = makeCtx({ [STORE_THEME_KEY]: "plinth" });
			const outcome = await invoke(
				ctx,
				{ type: "form_submit", action_id: "save-theme", values: { storeTheme: submitted } },
				THEMES,
			);
			expect(kv.get(STORE_THEME_KEY)).toBe("plinth");
			assertBlockContract(outcome.blocks, { screen: "settings", level: "list" });
			expect(errorBanner(outcome.blocks)).toBeDefined();
			expect(outcome.toast?.type).not.toBe("success");
			// The radio is still there to correct, on the stored value.
			expect(themeRadio(outcome.blocks)?.initial_value).toBe("plinth");
		},
	);

	test("a kv read failure still renders the page, with the radio on tempered", async () => {
		const { ctx } = makeCtx({}, new Set([STORE_THEME_KEY]));
		const { blocks } = await invoke(ctx, { type: "page_load" }, THEMES);
		expect(themeRadio(blocks)?.initial_value).toBe("tempered");
		expect(formFor(blocks, "save-display")).toBeDefined();
		expect(storeLabel(blocks)).toBe("Store — no display name · Tempered");
	});

	test("a stored id the site no longer offers renders the radio on tempered", async () => {
		const { ctx } = makeCtx({ [STORE_THEME_KEY]: "retired" });
		const { blocks } = await invoke(ctx, { type: "page_load" }, THEMES);
		expect(themeRadio(blocks)?.initial_value).toBe("tempered");
	});

	test("tempered is only the preferred fallback: a list without it falls back to its first theme", async () => {
		// The plugin hard-codes no list. A site that does not offer tempered still
		// gets a radio whose initial value is one of ITS options, and a label that
		// names a theme rather than a raw id.
		const noTempered: readonly StoreTheme[] = [
			{ id: "plinth", label: "Plinth" },
			{ id: "pressing", label: "Pressing" },
		];
		for (const seed of [{}, { [STORE_THEME_KEY]: "tempered" }, { [STORE_THEME_KEY]: "retired" }]) {
			const { ctx } = makeCtx(seed);
			const { blocks } = await invoke(ctx, { type: "page_load" }, noTempered);
			expect(themeRadio(blocks)?.initial_value).toBe("plinth");
			expect(storeLabel(blocks)).toBe("Store — no display name · Plinth");
		}
		const { ctx } = makeCtx({ [STORE_THEME_KEY]: "pressing" });
		const { blocks } = await invoke(ctx, { type: "page_load" }, noTempered);
		expect(themeRadio(blocks)?.initial_value).toBe("pressing");
	});

	test("saving the theme leaves the display name alone, and vice versa", async () => {
		const { ctx, kv } = makeCtx({ "settings:storeDisplayName": "Acme" });
		await invoke(
			ctx,
			{ type: "form_submit", action_id: "save-theme", values: { storeTheme: "plinth" } },
			THEMES,
		);
		expect(kv.get("settings:storeDisplayName")).toBe("Acme");
		await invoke(
			ctx,
			{ type: "form_submit", action_id: "save-display", values: { storeDisplayName: "Beta" } },
			THEMES,
		);
		expect(kv.get(STORE_THEME_KEY)).toBe("plinth");
	});
});

describe("Settings: no theme list (define absent — sandbox, other hosts)", () => {
	test("the Store group renders no theme radio and its label is unchanged", async () => {
		const { ctx } = makeCtx({ [STORE_THEME_KEY]: "plinth" });
		const { blocks } = await invoke(ctx, { type: "page_load" }, undefined);
		expect(formFor(blocks, "save-theme")).toBeUndefined();
		expect(storeLabel(blocks)).toBe("Store — no display name");
	});

	test("save-theme is refused and nothing is written", async () => {
		const { ctx, kv } = makeCtx();
		const outcome = await invoke(
			ctx,
			{ type: "form_submit", action_id: "save-theme", values: { storeTheme: "tempered" } },
			undefined,
		);
		expect(kv.has(STORE_THEME_KEY)).toBe(false);
		expect(errorBanner(outcome.blocks)).toBeDefined();
		expect(formFor(outcome.blocks, "save-display")).toBeDefined();
	});

	test("the default handler uses the baked list, which is absent here", async () => {
		const { ctx, kv } = makeCtx();
		const res = (await createSettingsFormHandler()(
			{
				input: { type: "form_submit", action_id: "save-theme", values: { storeTheme: "tempered" } },
				request: req,
			},
			ctx,
		)) as unknown as Outcome;
		expect(kv.has(STORE_THEME_KEY)).toBe(false);
		expect(formFor(res.blocks, "save-theme")).toBeUndefined();
	});
});
