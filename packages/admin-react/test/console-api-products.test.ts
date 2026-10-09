/**
 * The products half of the one data path (ADR-0014 Decision 3), as the
 * Pricing & inventory cards and the Download file card use it.
 *
 * The Orders half is pinned in `orders-console.test.tsx`. What is products-only
 * is the subject a refusal names, the `products.detail` read the cards make, and
 * the indeterminate flag a stock movement holds its nonce across — so those are
 * pinned here, against `console-api.ts` directly.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { PRODUCTS_ACT_SUBJECT, fetchProductDetail, isFailure, performAction, OTTA_ADMIN_ROUTE } =
	await import("../src/console-api.js");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** The envelope the plugin's route answers with. */
function envelope(data: unknown): Response {
	return jsonResponse({ data });
}

function lastBody(): Record<string, unknown> {
	const init = apiFetch.mock.calls.at(-1)?.[1];
	return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
	apiFetch.mockReset();
});

describe("the one data path (ADR-0014 Decision 3), products half", () => {
	test("every products call goes to `otta`'s admin route, and nowhere else", async () => {
		apiFetch.mockResolvedValue(envelope({ ok: true, notice: null }));
		await fetchProductDetail("prod-1");
		await performAction("products:restock", { productId: "prod-1" }, PRODUCTS_ACT_SUBJECT);
		expect(apiFetch).toHaveBeenCalledTimes(2);
		for (const call of apiFetch.mock.calls) expect(call[0]).toBe(OTTA_ADMIN_ROUTE);
	});

	test("a detail read names the resource and the product, and nothing else", async () => {
		apiFetch.mockResolvedValue(envelope({ ok: true }));
		await fetchProductDetail("prod-1");
		expect(lastBody()).toEqual({
			type: "otta_console_read",
			resource: "products.detail",
			productId: "prod-1",
		});
	});

	test("a write forwards the action id and value UNTOUCHED", async () => {
		// The plugin re-assembles the carrier from these exact keys, so anything
		// this layer normalised would be a watermark the handler never sees.
		apiFetch.mockResolvedValue(envelope({ ok: true, notice: null }));
		await performAction(
			"products:restock",
			{ productId: "prod-1", onHand: "42", qty: "12" },
			PRODUCTS_ACT_SUBJECT,
		);
		const body = lastBody();
		expect(body["type"]).toBe("otta_console_act");
		expect(body["action_id"]).toBe("products:restock");
		expect(body["value"]).toEqual({ productId: "prod-1", onHand: "42", qty: "12" });
	});

	test("a write whose outcome is UNKNOWN is marked indeterminate; a definitive no is not", async () => {
		// A stock movement's nonce is held until the plugin gives a definitive
		// answer, and a lost response must not read as "nothing happened". So the
		// transport says which failures may have let the write run: a request that
		// never came back, a 5xx, or an unreadable answer after a 2xx. A 4xx or the
		// plugin's own `{ok:false}` is a definitive no — nothing ran.
		const value = { productId: "prod-1", onHand: "42", qty: "1" };
		const cases: Array<[string, () => Promise<Response>, boolean]> = [
			["fetch threw", () => Promise.reject(new TypeError("Failed to fetch")), true],
			["502", () => Promise.resolve(jsonResponse({}, 502)), true],
			["unreadable 200", () => Promise.resolve(new Response("<html>", { status: 200 })), true],
			["wrong-shape 200", () => Promise.resolve(jsonResponse({ data: "?" })), true],
			["403", () => Promise.resolve(jsonResponse({}, 403)), false],
			[
				"plugin refusal",
				() =>
					Promise.resolve(envelope({ ok: false, title: "Nothing was changed", description: "x" })),
				false,
			],
		];
		for (const [label, respond, indeterminate] of cases) {
			apiFetch.mockImplementationOnce(respond);
			const result = await performAction("products:restock", value, PRODUCTS_ACT_SUBJECT);
			expect(result.ok, label).toBe(false);
			expect((result as { indeterminate?: boolean }).indeterminate === true, label).toBe(
				indeterminate,
			);
		}
	});

	test("a refusal NAMES Pricing & inventory, not Orders", async () => {
		// The console reads for two surfaces, and "Orders are unavailable" over a
		// product's pricing cards sends an operator to look at the wrong thing.
		apiFetch.mockResolvedValue(jsonResponse({}, 403));
		const result = await fetchProductDetail("prod-1");
		expect(isFailure(result)).toBe(true);
		if (!isFailure(result)) return;
		expect(result.title).toBe("Pricing & inventory is unavailable (HTTP 403)");
		expect(result.description).toContain("plugins:manage");
	});

	test("a session that expired says how to fix it, not merely that it failed", async () => {
		apiFetch.mockResolvedValue(jsonResponse({}, 401));
		const result = await fetchProductDetail("prod-1");
		expect(isFailure(result) && result.description).toContain("Reload this page to sign in again");
	});

	test("the plugin's own 200-with-a-refusal is passed through, copy and all", async () => {
		// G5: the plugin answers its OWN refusals at HTTP 200, and its copy is
		// better than anything this layer could invent.
		apiFetch.mockResolvedValue(
			envelope({
				ok: false,
				title: "Product not found",
				description: "No product matches that id.",
			}),
		);
		const result = await fetchProductDetail("nope");
		expect(isFailure(result) && result.title).toBe("Product not found");
	});
});
