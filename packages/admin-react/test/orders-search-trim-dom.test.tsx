/**
 * @vitest-environment happy-dom
 *
 * THE SEARCH QUERIES WHAT THE SUMMARY SAYS IT QUERIES.
 *
 * QA typed `  qa-admin-1@example.com  ` and got "No orders match these filters"
 * under a summary reading `search: qa-admin-1@example.com` — the browser
 * collapses the spaces on screen, the request carried them, and the store's
 * prefix match found nothing that starts with a space. The filter is trimmed
 * once, where it is normalised, so the request and the summary are the same
 * string.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { OrdersList } = await import("../src/orders/orders-list.js");

let mounted: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
	apiFetch.mockImplementation(() =>
		Promise.resolve(
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
		),
	);
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
});

async function settle(): Promise<void> {
	for (let i = 0; i < 2; i++) {
		await React.act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

test("a search with leading and trailing spaces is sent — and summarised — trimmed", async () => {
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await settle();

	const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="filter-search"]');
	expect(input).not.toBeNull();
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
			input,
			"  qa-admin-1@example.com  ",
		);
		input!.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const apply = mounted.container.querySelector('[data-testid="apply-filters"]');
	await fire(apply!, "click");
	await settle();

	const sent = apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as { filter?: { search?: string } })
		.at(-1);
	expect(sent?.filter?.search).toBe("qa-admin-1@example.com");
	const summary = mounted.container.querySelector('[data-testid="orders-filter-summary"]');
	expect(summary?.textContent).toContain("search: qa-admin-1@example.com");
});

test("a search of only spaces is no search at all", async () => {
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await settle();
	const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="filter-search"]');
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "   ");
		input!.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await fire(mounted.container.querySelector('[data-testid="apply-filters"]')!, "click");
	await settle();
	const sent = apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as { filter?: { search?: string } })
		.at(-1);
	expect(sent?.filter?.search).toBeUndefined();
	expect(mounted.container.querySelector('[data-testid="orders-filter-summary"]')).toBeNull();
});
