/**
 * @vitest-environment happy-dom
 *
 * The accordion sheet (`../src/block-kit-accordion.ts`) is written against the
 * DOM that EmDash's own Block Kit renderer produces, which this package does
 * not own. This test renders the REAL accordion — `BlockRenderer` from the
 * `@emdash-cms/blocks` that the pinned `emdash` installs, drawing Kumo's
 * `Collapsible` — and checks every hook the sheet's selectors lean on. An
 * EmDash or Kumo upgrade that renames one fails here instead of silently
 * turning the accordions plain again.
 *
 * `@emdash-cms/blocks` is not a dependency of this package (the console's
 * no-new-dependency rule), so it is resolved through the chain the admin
 * itself uses: `emdash` → `@emdash-cms/admin` → `@emdash-cms/blocks`.
 *
 * happy-dom cannot evaluate `:has()`, so the selectors are checked piecewise.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import * as React from "react";
import { act } from "react";
import { expect, test } from "vitest";

import { mount } from "./dom.js";

type BlockRendererProps = {
	blocks: unknown[];
	onAction: (interaction: unknown) => void;
};

async function loadBlockRenderer(): Promise<React.ComponentType<BlockRendererProps>> {
	let req = createRequire(import.meta.url);
	let entry = "";
	for (const name of ["emdash", "@emdash-cms/admin", "@emdash-cms/blocks"]) {
		entry = req.resolve(name);
		req = createRequire(entry);
	}
	const mod = (await import(pathToFileURL(entry).href)) as {
		BlockRenderer: React.ComponentType<BlockRendererProps>;
	};
	return mod.BlockRenderer;
}

test("EmDash's Block Kit accordion still exposes the hooks the sheet targets", async () => {
	const BlockRenderer = await loadBlockRenderer();
	const blocks = [
		{
			type: "accordion",
			block_id: "first",
			label: "Store — no display name",
			default_open: true,
			blocks: [{ type: "context", text: "Inside the first section" }],
		},
		{
			type: "accordion",
			block_id: "second",
			label: "Checkout & holds",
			blocks: [{ type: "context", text: "Inside the second section" }],
		},
	];
	const view = await mount(React.createElement(BlockRenderer, { blocks, onAction: () => {} }));
	try {
		const roots = view.container.querySelectorAll('[data-testid="collapsible"]');
		expect(roots).toHaveLength(2);
		const [open, closed] = [...roots] as HTMLElement[];

		// Neighbouring accordions sit in sibling wrapper divs (the grouping rules).
		expect(open?.parentElement?.nextElementSibling).toBe(closed?.parentElement);

		const trigger = open?.querySelector(':scope > [data-kumo-part="default-trigger"]');
		expect(trigger?.tagName).toBe("BUTTON");
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(trigger?.hasAttribute("data-panel-open")).toBe(true);

		// The panel is the trigger's next sibling, carries an id, and has a
		// single content wrapper (which takes the padding).
		const panel = trigger?.nextElementSibling;
		expect(panel?.id).toBeTruthy();
		expect(trigger?.getAttribute("aria-controls")).toBe(panel?.id);
		expect(panel?.children).toHaveLength(1);

		// The chevron is a direct svg child of the trigger.
		expect(trigger?.querySelector(":scope > svg")).not.toBeNull();

		const closedTrigger = closed?.querySelector<HTMLElement>(
			':scope > [data-kumo-part="default-trigger"]',
		);
		expect(closedTrigger?.getAttribute("aria-expanded")).toBe("false");
		expect(closedTrigger?.hasAttribute("data-panel-open")).toBe(false);
		await act(async () => closedTrigger?.click());
		expect(closedTrigger?.getAttribute("aria-expanded")).toBe("true");
		expect(closedTrigger?.hasAttribute("data-panel-open")).toBe(true);
	} finally {
		await view.unmount();
	}
});
