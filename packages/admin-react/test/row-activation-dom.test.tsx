/**
 * @vitest-environment happy-dom
 *
 * Row activation, through the LIVE listener rather than around it.
 *
 * `rowActivationId` is already covered as a pure function, and those tests
 * stay: they are faster, and they enumerate the five bail-outs far more
 * cheaply than a rendered table can. What they cannot see is the WIRING —
 * `Table` reading `window.getSelection()`, remembering the press origin across
 * two separate events, and narrowing `event.target` to an `Element`. A guard
 * that is correct in isolation and unplugged from its inputs passes every pure
 * test in this package and ships a table that opens an order the moment a
 * merchant finishes drag-selecting a SKU out of it.
 *
 * So: a real `<tbody>`, real bubbling `mousedown`/`click` pairs, real
 * coordinates, and a real Selection.
 */
import * as React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { Table } from "../src/ui.js";
import { clearSelection, fire, mount, selectContentsOf, type Mounted } from "./dom.js";

let mounted: Mounted | null = null;

afterEach(async () => {
	clearSelection();
	await mounted?.unmount();
	mounted = null;
});

function List({
	onOpen,
	onCopy,
}: {
	onOpen: (id: string) => void;
	onCopy: () => void;
}): React.ReactElement {
	return (
		<Table
			caption="Orders"
			headers={["Order", "Customer"]}
			testId="otta-rows"
			onActivateRow={onOpen}
		>
			<tr className="otta-row" data-row-id="ord_9f2">
				<td>
					<a href="#ord_9f2" data-testid="drill-in">
						ord_9f2
					</a>
					{/* Shaped like the real `CopyIdButton`, which sits in exactly this
					    cell on Orders: a bare `<button type="button">` next to the
					    drill-in link, inside the activatable row. */}
					<button
						type="button"
						data-testid="copy-id"
						data-full-id="ord_9f2"
						aria-label="Copy full order id ord_9f2"
						onClick={onCopy}
					>
						Copy
					</button>
				</td>
				<td data-testid="bare">Ada Lovelace</td>
			</tr>
			<tr className="otta-row">
				<td data-testid="idless">unlinked row</td>
			</tr>
		</Table>
	);
}

async function setup(): Promise<{
	onOpen: ReturnType<typeof vi.fn<(id: string) => void>>;
	onCopy: ReturnType<typeof vi.fn<() => void>>;
	cell(testId: string): HTMLElement;
}> {
	const onOpen = vi.fn<(id: string) => void>();
	const onCopy = vi.fn<() => void>();
	mounted = await mount(<List onOpen={onOpen} onCopy={onCopy} />);
	const container = mounted.container;
	return {
		onOpen,
		onCopy,
		cell: (testId) => {
			const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
			if (found === null) throw new Error(`no [data-testid="${testId}"] in the mounted table`);
			return found;
		},
	};
}

/** A press and a release in the same place, which is what a click IS. */
async function press(target: EventTarget, at: { x: number; y: number }, to = at): Promise<void> {
	await fire(target, "mousedown", { clientX: at.x, clientY: at.y });
	await fire(target, "click", { clientX: to.x, clientY: to.y });
}

test("a steady click on a bare cell activates that row, once", async () => {
	const { onOpen, cell } = await setup();

	await press(cell("bare"), { x: 100, y: 100 });

	expect(onOpen.mock.calls).toEqual([["ord_9f2"]]);
});

test("a click on the row's own drill-in link does not activate the row as well", async () => {
	const { onOpen, cell } = await setup();

	await press(cell("drill-in"), { x: 100, y: 100 });

	expect(onOpen).not.toHaveBeenCalled();
});

test("a click on a control inside the row runs the control and nothing else", async () => {
	const { onOpen, onCopy, cell } = await setup();

	// The Copy control is the case the interactive-descendant guard exists
	// for: it lives INSIDE an activatable row, so an unguarded table would
	// copy the id and drill into the order on the same click.
	await press(cell("copy-id"), { x: 100, y: 100 });

	expect(onCopy).toHaveBeenCalledTimes(1);
	expect(onOpen).not.toHaveBeenCalled();
});

test("a press that moved more than the slop is a drag, not an activation", async () => {
	const { onOpen, cell } = await setup();

	await press(cell("bare"), { x: 100, y: 100 }, { x: 100, y: 110 });

	expect(onOpen).not.toHaveBeenCalled();
});

test("finishing a text selection inside the row does not open it", async () => {
	const { onOpen, cell } = await setup();
	const bare = cell("bare");

	// The drag is IMPERCEPTIBLE in coordinates — 1px, inside the slop — so the
	// only thing that can save this click is the live Selection. That is the
	// point of asserting it here rather than against the pure function.
	await fire(bare, "mousedown", { clientX: 100, clientY: 100 });
	selectContentsOf(bare);
	expect(window.getSelection()?.isCollapsed).toBe(false);
	await fire(bare, "click", { clientX: 101, clientY: 100 });

	expect(onOpen).not.toHaveBeenCalled();
});

test("a modified click activates nothing — the row is not a link", async () => {
	const { onOpen, cell } = await setup();

	await fire(cell("bare"), "mousedown", { clientX: 100, clientY: 100 });
	await fire(cell("bare"), "click", { clientX: 100, clientY: 100, metaKey: true });

	expect(onOpen).not.toHaveBeenCalled();
});

test("a row with no id is inert, and a click on it does not carry the previous row's id", async () => {
	const { onOpen, cell } = await setup();

	await press(cell("idless"), { x: 100, y: 100 });

	expect(onOpen).not.toHaveBeenCalled();
});
