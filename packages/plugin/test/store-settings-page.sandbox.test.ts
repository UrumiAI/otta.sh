import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { STORE_SETTINGS_PAGE } from "../src/admin/store-settings-page.js";
import {
	blocksOf,
	buttons,
	findBlock,
	formFor,
	panel,
	panelLabels,
	type LooseBlock,
} from "./helpers/blocks.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Store settings hosts the Settings, Tax and Shipping screens as tabs (one
// sidebar entry instead of three). Driven through the REAL `admin` dispatcher in
// the workerd-on-Node sandbox: each panel must be exactly what that screen's own
// page renders, and an action sent FROM this page must come back as the whole
// tabbed page — EmDash replaces the block tree with every response, so a bare
// screen here would drop the tabs after the first click.

let sandbox: SandboxHandle;

beforeAll(async () => {
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox.close();
});

async function invoke(input: Record<string, unknown>): Promise<LooseBlock[]> {
	return blocksOf(await sandbox.invokeRoute("admin", input));
}

function tabBlock(blocks: readonly LooseBlock[]) {
	return findBlock(blocks, "tab") as { block_id?: string; default_tab?: number } | undefined;
}

describe("Store settings page", () => {
	test("page_load renders a header and General / Tax / Shipping tabs, each the screen's own page", async () => {
		const blocks = await invoke({ type: "page_load", page: STORE_SETTINGS_PAGE.path });

		expect(blocks[0]).toMatchObject({ type: "header", text: "Store settings" });
		expect(panelLabels(blocks)).toEqual(["General", "Tax", "Shipping"]);
		expect(tabBlock(blocks)).toMatchObject({ block_id: "store-settings:tabs", default_tab: 0 });

		// General is the page minus its own "Settings" heading (this page has one).
		const [settingsHeading, ...settingsBody] = await invoke({
			type: "page_load",
			page: "/settings",
		});
		expect(settingsHeading).toMatchObject({ type: "header", text: "Settings" });
		expect(panel(blocks, "General")).toEqual(settingsBody);
		expect(panel(blocks, "Tax")).toEqual(await invoke({ type: "page_load", page: "/tax" }));
		expect(panel(blocks, "Shipping")).toEqual(
			await invoke({ type: "page_load", page: "/shipping" }),
		);
	}, 60_000);

	test("an action from the Tax tab answers with the full tabbed page, Tax selected and drilled in", async () => {
		const loaded = await invoke({ type: "page_load", page: STORE_SETTINGS_PAGE.path });
		const newClass = buttons(panel(loaded, "Tax")).find(
			(b) => b.action_id === "tax:show-new-class",
		);
		expect(newClass, "no New tax class button in the Tax tab").toBeDefined();

		const after = await invoke({
			type: "block_action",
			action_id: "tax:show-new-class",
			value: newClass!.value,
			page: STORE_SETTINGS_PAGE.path,
		});

		expect(panelLabels(after)).toEqual(["General", "Tax", "Shipping"]);
		expect(tabBlock(after)).toMatchObject({ block_id: "store-settings:tabs", default_tab: 1 });
		expect(findBlock(panel(after, "Tax"), "header")).toMatchObject({ text: "New tax class" });
		// The other tabs are re-rendered, not dropped.
		expect(formFor(panel(after, "General"), "save-display")).toBeDefined();
		expect(findBlock(panel(after, "Shipping"), "header")).toMatchObject({ text: "Shipping zones" });
	}, 60_000);

	test("a General save keeps its toast and selects the General tab", async () => {
		const loaded = await invoke({ type: "page_load", page: STORE_SETTINGS_PAGE.path });
		const form = formFor(panel(loaded, "General"), "save-display");
		expect(form, "no display-name form in the General tab").toBeDefined();

		const outcome = await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-display",
			values: { storeDisplayName: "Lune & Ochre" },
			block_id: form!.block_id,
			page: STORE_SETTINGS_PAGE.path,
		});

		const blocks = blocksOf(outcome);
		expect(tabBlock(blocks)).toMatchObject({ default_tab: 0 });
		expect((outcome as { result?: { toast?: unknown } }).result?.toast).toMatchObject({
			message: "Display name saved",
			type: "success",
		});
	}, 60_000);

	test("an action from the old standalone page is NOT wrapped", async () => {
		const loaded = await invoke({ type: "page_load", page: "/tax" });
		const newClass = buttons(loaded).find((b) => b.action_id === "tax:show-new-class");
		const after = await invoke({
			type: "block_action",
			action_id: "tax:show-new-class",
			value: newClass!.value,
			page: "/tax",
		});
		expect(findBlock(after, "tab")).toBeUndefined();
		expect(findBlock(after, "header")).toMatchObject({ text: "New tax class" });
	}, 60_000);
	test("an action this page does not own falls through to its own screen, unwrapped", async () => {
		// A Coupons id stamped with this page (impossible from the UI today) must
		// reach Coupons as-is, never be swallowed or rendered inside the tabs.
		const after = await invoke({
			type: "block_action",
			action_id: "coupons:new",
			page: STORE_SETTINGS_PAGE.path,
		});
		expect(findBlock(after, "tab")).toBeUndefined();
		expect(after.length).toBeGreaterThan(0);
		expect(findBlock(after, "header")).toMatchObject({ text: "New coupon" });
	}, 60_000);
});
