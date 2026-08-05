/**
 * @vitest-environment happy-dom
 *
 * The confirm dialog as a native overlay.
 *
 * `ConfirmDialog` renders a `<dialog>` and then OPENS IT FROM AN EFFECT. Both
 * halves are invisible to a static-markup assertion: the markup of a closed
 * dialog and the markup of an open one are the same element, and
 * `renderToStaticMarkup` never runs an effect at all. Every previous test of
 * this component could therefore only check the sentence it holds, never
 * whether an operator would ever see it.
 *
 * A dialog that never opens is a destructive action performed with no
 * confirmation, so this is the seam most worth a live document.
 */
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ConfirmDialog } from "../src/ui.js";
import { mount, fire, type Mounted } from "./dom.js";

let mounted: Mounted | null = null;

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

const COPY = {
	title: "Cancel this order?",
	text: "Order ord_9f2 will be cancelled. This cannot be undone.",
	confirmLabel: "Cancel order",
	denyLabel: "Keep order",
};

function dialogOf(mountedTree: Mounted): HTMLDialogElement {
	const found = mountedTree.container.querySelector<HTMLDialogElement>(
		'[data-testid="otta-confirm"]',
	);
	if (found === null) throw new Error("the confirm dialog did not render");
	return found;
}

function button(mountedTree: Mounted, testId: string): HTMLElement {
	const found = mountedTree.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (found === null) throw new Error(`no [data-testid="${testId}"] inside the dialog`);
	return found;
}

test("the dialog stays shut until asked, then opens on the transition", async () => {
	const onConfirm = vi.fn();
	const onDeny = vi.fn();

	mounted = await mount(
		<ConfirmDialog open={false} {...COPY} onConfirm={onConfirm} onDeny={onDeny} />,
	);
	expect(dialogOf(mounted).open).toBe(false);

	await mounted.rerender(
		<ConfirmDialog open={true} {...COPY} onConfirm={onConfirm} onDeny={onDeny} />,
	);

	expect(dialogOf(mounted).open).toBe(true);
	expect(dialogOf(mounted).textContent).toContain(COPY.text);
});

test("closing it is also driven by the prop — the element does not stay open behind the screen", async () => {
	const onConfirm = vi.fn();
	const onDeny = vi.fn();
	const dialog = (open: boolean): ReactElement => (
		<ConfirmDialog open={open} {...COPY} onConfirm={onConfirm} onDeny={onDeny} />
	);

	mounted = await mount(dialog(true));
	expect(dialogOf(mounted).open).toBe(true);

	await mounted.rerender(dialog(false));

	expect(dialogOf(mounted).open).toBe(false);
});

test("the two buttons inside the open dialog report the operator's answer", async () => {
	const onConfirm = vi.fn();
	const onDeny = vi.fn();

	mounted = await mount(
		<ConfirmDialog open={true} {...COPY} onConfirm={onConfirm} onDeny={onDeny} />,
	);

	await fire(button(mounted, "otta-confirm-deny"), "click");
	expect(onDeny).toHaveBeenCalledTimes(1);
	expect(onConfirm).not.toHaveBeenCalled();

	await fire(button(mounted, "otta-confirm-yes"), "click");
	expect(onConfirm).toHaveBeenCalledTimes(1);
	expect(onDeny).toHaveBeenCalledTimes(1);
});
