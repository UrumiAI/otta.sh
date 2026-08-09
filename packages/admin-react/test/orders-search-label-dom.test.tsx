/**
 * @vitest-environment happy-dom
 *
 * THE SEARCH BOX SAYS WHAT IT SEARCHES — read off the rendered control, not off
 * the constant.
 *
 * WHY THIS EXISTS AT ALL. A search axis nobody is told about ships dark: the
 * store can match a purchased SKU perfectly and no operator will ever type one,
 * because the box in front of them named two other things. `presentation.test
 * .ts` pins the SENTENCE; what it cannot see is whether that sentence reaches
 * the affordance. Between the two lives the failure this file exists for — a
 * label constant updated in the shared module while the screen renders a
 * hand-copied string, which is exactly the drift `admin-presentation` was
 * extracted to make impossible and therefore the one worth a mounted check.
 *
 * WHY THE ASSERTION STARTS AT THE INPUT. Searching the container's markup for
 * the sentence would pass if the words appeared anywhere on the screen — a
 * heading, an empty state, a tooltip. The proof has to run the other way: find
 * the control an operator types into, walk to the `<label>` that names it, and
 * read THAT text. A label that names the wrong control is the same defect as no
 * label at all.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersList } = await import("../src/orders/orders-list.js");
const { ORDERS_SEARCH_LABEL } = await import("@otta-sh/admin-presentation");

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockResolvedValue(
		new Response(
			JSON.stringify({
				data: {
					ok: true,
					orders: [],
					nextCursor: null,
					vocabulary: {
						statuses: ["paid"],
						statusAny: "any",
						periods: [{ key: "any", label: "Any time" }],
						cancellationReasons: [],
						oneClickCancellationReasons: [],
					},
				},
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		),
	);
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

test("the search input an operator types into is LABELLED with all three axes", async () => {
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	// The first page resolves a microtask or two after the mount's own flush.
	await mounted.rerender(node);

	const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="filter-search"]');
	expect(input).not.toBeNull();
	// The control is a search box, so assistive tech and the browser both treat a
	// partial entry as a query — which is exactly why the label has to say that
	// one of the three axes will not accept one.
	expect(input?.type).toBe("search");

	const label = input?.closest("label");
	expect(label).not.toBeNull();
	expect(label?.textContent).toContain(ORDERS_SEARCH_LABEL);
	// And the words are the operator-facing ones, not a schema field name: the
	// label is the only place the SKU axis is announced at all.
	expect(label?.textContent).toContain("SKU");
});
