/**
 * @vitest-environment happy-dom
 *
 * ENTER IN THE SEARCH BOX SEARCHES (QA round 2). Typing an email and pressing
 * Enter did nothing; the operator had to find "Apply filters". Enter now applies
 * the filters exactly as the button does.
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

test("Enter in the search box applies the filters, as Apply does", async () => {
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await settle();
	const before = apiFetch.mock.calls.length;

	const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="filter-search"]');
	expect(input).not.toBeNull();
	await React.act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
			input,
			"qa-admin-1@example.com",
		);
		input!.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await React.act(async () => {
		input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	await settle();

	expect(apiFetch.mock.calls.length).toBeGreaterThan(before);
	const sent = apiFetch.mock.calls
		.map((call) => JSON.parse(String(call[1]?.body ?? "{}")) as { filter?: { search?: string } })
		.at(-1);
	expect(sent?.filter?.search).toBe("qa-admin-1@example.com");
});

test("another key does not search", async () => {
	const node = <OrdersList onOpen={() => undefined} />;
	mounted = await mount(node);
	await settle();
	const before = apiFetch.mock.calls.length;
	const input = mounted.container.querySelector<HTMLInputElement>('[data-testid="filter-search"]');
	await React.act(async () => {
		input!.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
	});
	await settle();
	expect(apiFetch.mock.calls.length).toBe(before);
});
