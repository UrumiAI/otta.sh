import { describe, expect, test } from "vitest";
import {
	createStoreSettingsPageHandler,
	type StoreSettingsPanel,
} from "../src/admin/store-settings-page.js";
import type { PluginContext, SandboxedRouteContext } from "../src/types.js";
import { panel, type LooseBlock } from "./helpers/blocks.js";

// The wrapper's own rules, with stub screens: run order, failure containment and
// toast pass-through. The real screens are covered through the sandbox in
// `store-settings-page.sandbox.test.ts`.

const ctx = {} as PluginContext;

function routeCtx(input: Record<string, unknown>): SandboxedRouteContext<Record<string, unknown>> {
	return { input, request: {} as SandboxedRouteContext["request"] };
}

function stubPanel(
	label: string,
	render: (input: Record<string, unknown>) => unknown,
	log: string[],
): StoreSettingsPanel {
	return {
		label,
		page: `/${label.toLowerCase()}`,
		actionIds: new Set([`${label.toLowerCase()}:act`]),
		handler: (async (rc: SandboxedRouteContext<Record<string, unknown>>) => {
			log.push(`${label}:${String(rc.input.type)}`);
			return render(rc.input);
		}) as StoreSettingsPanel["handler"],
	};
}

const text = (t: string) => ({ blocks: [{ type: "header", text: t }] });

describe("createStoreSettingsPageHandler", () => {
	test("the acting screen runs before its siblings re-load", async () => {
		const log: string[] = [];
		const handler = createStoreSettingsPageHandler([
			stubPanel("A", () => text("a"), log),
			stubPanel("B", () => text("b"), log),
		]);
		await handler(routeCtx({ type: "block_action", action_id: "b:act" }) as never, ctx);
		expect(log[0]).toBe("B:block_action");
		expect(log.slice(1)).toEqual(["A:page_load"]);
	});

	test("a sibling that throws becomes a banner in its own tab; the others still render", async () => {
		const log: string[] = [];
		const handler = createStoreSettingsPageHandler([
			stubPanel("A", () => text("a"), log),
			stubPanel(
				"B",
				() => {
					throw new Error("secret detail");
				},
				log,
			),
		]);
		const out = (await handler(routeCtx({ type: "page_load" }) as never, ctx)) as {
			blocks: LooseBlock[];
		};
		expect(panel(out.blocks, "A")).toEqual(text("a").blocks);
		const failed = panel(out.blocks, "B");
		expect(failed).toEqual([
			expect.objectContaining({ type: "banner", variant: "error", title: "Couldn't load B" }),
		]);
		expect(JSON.stringify(failed)).not.toContain("secret detail");
	});

	test("the acting screen's own failure is not swallowed", async () => {
		const handler = createStoreSettingsPageHandler([
			stubPanel(
				"A",
				() => {
					throw new Error("boom");
				},
				[],
			),
		]);
		await expect(
			handler(routeCtx({ type: "block_action", action_id: "a:act" }) as never, ctx),
		).rejects.toThrow("boom");
	});

	test("the acting screen's toast is passed through; a sibling's never is", async () => {
		const handler = createStoreSettingsPageHandler([
			stubPanel("A", () => ({ ...text("a"), toast: { message: "sibling", type: "info" } }), []),
			stubPanel("B", () => ({ ...text("b"), toast: { message: "Saved", type: "success" } }), []),
		]);
		const acted = (await handler(
			routeCtx({ type: "form_submit", action_id: "b:act" }) as never,
			ctx,
		)) as { toast?: unknown };
		expect(acted.toast).toEqual({ message: "Saved", type: "success" });

		const loaded = (await handler(routeCtx({ type: "page_load" }) as never, ctx)) as {
			toast?: unknown;
		};
		expect(loaded).not.toHaveProperty("toast");
	});
});
