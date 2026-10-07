/**
 * @vitest-environment happy-dom
 *
 * The pasted-link discriminator for the products screen's in-app Back (F22's
 * companion): when the record on screen was not reached by a click from the
 * list — a pasted link, a reload, a bookmark, with no entry THIS screen itself
 * pushed — the in-app Back control must REPLACE the current history entry
 * rather than pop it.
 *
 * SCOPE: this covers the pasted-link pop-versus-replace decision only. The
 * broader depth-neutral leave-confirm mechanism around a real browser Back is
 * more re-entrant and timing-sensitive, is not covered here, and stays
 * verified in a browser.
 *
 * WHY A REAL DOCUMENT CAN SETTLE THIS ONE, even though `url-state.test.ts`
 * says elsewhere that history traversal cannot be modelled outside a browser:
 * `happy-dom` does track a real, ordered session history for same-document
 * navigations, and `back`/`forward`/`popstate` observably agree with it here.
 *
 * WHY THE FORWARD STEP IS THE WHOLE POINT. A pop and a correct replace can
 * land on an IDENTICAL address whenever a prior entry exists — the URL, the
 * screen it renders and even `history.length` right after Back agree between
 * the two — so none of those, alone, can tell a correct replace from a
 * `history.back()` standing in for it. Only what Back leaves BEHIND it
 * differs: a pop leaves the popped `?product=` entry sitting ahead as a
 * forward entry, and a replace leaves nothing there. Forward is what reads
 * that difference back out.
 */
import * as React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { ProductsScreen } = await import("../src/products/products-screen.js");

const PRODUCT = {
	productId: "p1",
	sku: "SKU-1",
	title: "A pasted-link product",
	priceCents: 900,
	currency: "USD",
	taxClass: null,
	compareAtCents: null,
	compareAtCurrency: null,
	unitCostCents: null,
	unitCostCurrency: null,
	inventoryPolicy: "deny",
	weightGrams: null,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "physical",
	active: true,
	deletedAt: null,
	onHand: 5,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
} as const;

function envelope(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Answers whichever resource the console asked for, so a record reopened by
 *  a Forward step gets the same detail read a first visit would. */
apiFetch.mockImplementation((_input, init) => {
	const body = JSON.parse(String(init?.body ?? "{}")) as { resource?: string };
	if (body.resource === "products.detail") {
		return Promise.resolve(
			envelope({
				ok: true,
				product: PRODUCT,
				taxClasses: [],
				threshold: 3,
				vocabulary: {
					statuses: [{ value: "any", label: "Any status" }],
					kinds: [{ value: "physical", label: "Physical" }],
					any: "any",
					pageLimit: 25,
				},
			}),
		);
	}
	return Promise.resolve(
		envelope({
			ok: true,
			products: [],
			nextCursor: null,
			stock: { threshold: 3, unreadable: false, filterUnavailable: false },
			vocabulary: {
				statuses: [{ value: "any", label: "Any status" }],
				kinds: [{ value: "physical", label: "Physical" }],
				any: "any",
				pageLimit: 25,
			},
		}),
	);
});

let mounted: Mounted | null = null;

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
	// A clean address for the next test — a leftover entry from one test must
	// not seed the next one's Back/Forward.
	window.history.replaceState(null, "", "/");
});

test("a pasted link's in-app Back replaces, so Forward stays on the list — not the record", async () => {
	// THE PASTED LINK: an entry this screen never pushed, with the list itself
	// sitting behind it. `pushed.current` inside the screen starts false
	// precisely because nothing here called `pushState` for the top entry —
	// only the test's own setup did, standing in for the browser navigation
	// that puts a pasted link in the address bar.
	window.history.pushState(null, "", "/products");
	window.history.pushState(null, "", "/products?product=p1");
	const depthOnArrival = window.history.length;

	const node = <ProductsScreen />;
	mounted = await mount(node);
	// The detail read arrives through a promise chain the mount's own `act`
	// does not outlive; a second flush is what puts the record on screen.
	await mounted.rerender(node);

	expect(mounted.container.querySelector('[data-testid="detail-heading"]')).not.toBeNull();

	const backButton = mounted.container.querySelector<HTMLElement>('[data-testid="products-back"]');
	if (backButton === null) throw new Error("no in-app Back control rendered");

	await fire(backButton, "click");

	// THE PART A POP ALSO PASSES. A replace and a `history.back()` standing in
	// for it land on the same address whenever a prior entry exists, so this
	// much cannot be what tells them apart.
	expect(window.location.pathname).toBe("/products");
	expect(window.location.search).toBe("");
	expect(window.history.length).toBe(depthOnArrival);
	expect(mounted.container.querySelector('[data-testid="detail-heading"]')).toBeNull();

	// THE DISCRIMINATOR. A REPLACE leaves nothing beyond the current entry, so
	// Forward has nowhere to go: no navigation, no `popstate`, the list stays
	// exactly as Back left it. A POP would instead have left the popped
	// `?product=p1` entry sitting ahead as a forward entry, and Forward would
	// walk back into it, resurrecting the record.
	await React.act(async () => {
		window.history.forward();
	});

	expect(window.location.pathname).toBe("/products");
	expect(window.location.search).toBe("");
	expect(mounted.container.querySelector('[data-testid="detail-heading"]')).toBeNull();
});
