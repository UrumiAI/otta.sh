/**
 * @vitest-environment happy-dom
 *
 * Where a control's focus goes when its own click takes it away.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. In happy-dom — and in jsdom — disabling a
 * focused element does NOT blur it: `document.activeElement` stays on the button
 * that just went `disabled`, where a real browser has already dropped focus to
 * `<body>`. The defect is therefore not reproducible here, and any assertion
 * shaped like "focus was not lost" passes for the wrong reason and would keep
 * passing if the fix were deleted.
 *
 * So the assertion is the other way round and entirely positive: the component
 * MOVED focus to a named element, and it did so BEFORE running the work that
 * disables it. That is a real, observable claim in this environment, and it is
 * the whole mechanism. That focus is genuinely retained on a real page is a
 * browser check, and is verified there.
 */
import * as React from "react";
import { describe, expect, test } from "vitest";

import { Button, Notice } from "../src/ui.js";
import { fire, mount } from "./dom.js";

describe("a button whose own click disables it", () => {
	test("moves focus to its named target before the click's work runs", async () => {
		const handoff = document.createElement("div");
		handoff.tabIndex = -1;
		document.body.append(handoff);
		const ref: React.RefObject<HTMLElement | null> = { current: handoff };

		// Captured INSIDE the handler, which is the ordering claim: by the time the
		// work that flips `disabled` begins, focus has already left.
		let activeWhenWorkStarted: Element | null = null;

		const view = await mount(
			<Button
				label="Retry"
				testId="retry"
				handOffFocusTo={ref}
				onClick={() => {
					activeWhenWorkStarted = document.activeElement;
				}}
			/>,
		);
		const button = view.container.querySelector<HTMLButtonElement>('[data-testid="retry"]');
		if (button === null) throw new Error("no button");
		button.focus();
		expect(document.activeElement).toBe(button);

		await fire(button, "click");

		expect(activeWhenWorkStarted).toBe(handoff);
		expect(document.activeElement).toBe(handoff);

		handoff.remove();
		await view.unmount();
	});

	test("leaves focus alone when no target is named", async () => {
		// The handoff is opt-in. A button that never disables itself must not yank
		// focus off itself on every click.
		const view = await mount(<Button label="Save" testId="save" onClick={() => undefined} />);
		const button = view.container.querySelector<HTMLButtonElement>('[data-testid="save"]');
		if (button === null) throw new Error("no button");
		button.focus();

		await fire(button, "click");

		expect(document.activeElement).toBe(button);
		await view.unmount();
	});
});

describe("the notice that carries Retry", () => {
	test("catches focus itself, in the region that holds the reason", async () => {
		let clicks = 0;
		const view = await mount(
			<Notice
				variant="error"
				title="Couldn't load orders"
				description="The request failed."
				testId="load-failed"
				action={{ label: "Retry", onClick: () => (clicks += 1), autoFocus: true }}
			/>,
		);
		const region = view.container.querySelector<HTMLElement>('[data-testid="load-failed"]');
		const retry = view.container.querySelector<HTMLButtonElement>(
			'[data-testid="load-failed-action"]',
		);
		if (region === null || retry === null) throw new Error("notice did not render");

		// A programmatic focus target, never a tab stop: adding one would put a
		// stop in front of every notice on the page.
		expect(region.getAttribute("tabindex")).toBe("-1");

		retry.focus();
		await fire(retry, "click");

		expect(clicks).toBe(1);
		expect(document.activeElement).toBe(region);
		await view.unmount();
	});
});
