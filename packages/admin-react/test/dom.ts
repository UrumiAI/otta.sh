/**
 * Mounting helpers for the console's DOM tests.
 *
 * MOST OF THIS PACKAGE'S TESTS NEED NO DOCUMENT and must stay that way: they
 * call an exported pure function, or they assert on `renderToStaticMarkup`.
 * Both run in the default `node` environment.
 *
 * WHY THE ENVIRONMENT IS DECLARED PER FILE, in a `@vitest-environment` docblock,
 * and not in this package's `vitest.config.ts`: `test.environment` is a single
 * value for the whole project, so setting it there would move every existing
 * test in the package into a browser-shaped global scope it was never written
 * for. Vitest 4 removed `environmentMatchGlobs`, which used to be the way to map
 * a path pattern to an environment inside one config, so the two remaining ways
 * to run two environments in one package are a per-file docblock or splitting
 * the package into two vitest projects. The docblock is the smaller of the two,
 * it keeps the environment visible at the top of the file that needs it, and it
 * cannot drift out of sync with a glob.
 *
 * What a document buys, and nothing else can: an effect that touches a real
 * element, a native `<dialog>`, a delegated listener reading live state off
 * `window`. Those are exactly the seams that were previously covered only by
 * Playwright.
 *
 * There is no testing-library here on purpose. `createRoot` plus React's own
 * `act` is the whole requirement, and the console's `no new dependency` rule
 * is relaxed only as far as an environment actually forces it.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

// React refuses to run `act` without this and warns on every update without it.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
	/** The element the tree was rendered into, attached to `document.body` so
	 *  focus, selection and modal dialogs behave as they do on the page. */
	readonly container: HTMLElement;
	/** Render again with new props, flushing effects. */
	rerender(node: React.ReactElement): Promise<void>;
	unmount(): Promise<void>;
}

export async function mount(node: React.ReactElement): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);

	const rerender = async (next: React.ReactElement): Promise<void> => {
		await React.act(async () => {
			root.render(next);
		});
	};

	await rerender(node);

	return {
		container,
		rerender,
		unmount: async () => {
			await React.act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

/**
 * Dispatch a real, bubbling mouse event.
 *
 * Coordinates are passed through because the row guard measures them: a press
 * and a release more than a few pixels apart is a drag, and only an event
 * carrying `clientX`/`clientY` can express the difference.
 */
export async function fire(
	target: EventTarget,
	type: "click" | "mousedown" | "mouseup",
	init: MouseEventInit = {},
): Promise<void> {
	await React.act(async () => {
		target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
	});
}

/** Select the contents of `node`, as a merchant dragging across a cell would. */
export function selectContentsOf(node: Node): void {
	const selection = window.getSelection();
	if (selection === null) throw new Error("no Selection in this environment");
	const range = document.createRange();
	range.selectNodeContents(node);
	selection.removeAllRanges();
	selection.addRange(range);
}

export function clearSelection(): void {
	window.getSelection()?.removeAllRanges();
}
