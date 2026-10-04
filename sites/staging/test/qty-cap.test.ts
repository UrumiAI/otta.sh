/**
 * A quantity over the shopper-facing cap (10,000 — the plugin's
 * `CART_LINE_MAX_QTY`) is refused by the SITE with its own specific message,
 * before any dispatch (QA U-6).
 *
 * The plugin refuses it too, but only as the route's generic INVALID_INPUT —
 * and before that fix, as RENDER_FAILED — both of which read "Something went
 * wrong" to a shopper who simply typed a big number. The site knows exactly what
 * was wrong, so it says so: `?error=QTY_TOO_LARGE`. The field itself carries the
 * same `max`, so a browser stops most of these before they are ever sent.
 */
import { CART_LINE_MAX_QTY } from "@otta-sh/plugin";
import type { APIContext, APIRoute } from "astro";
import { describe, expect, test, vi } from "vitest";

const { getEmDashEntry } = vi.hoisted(() => ({ getEmDashEntry: vi.fn() }));
vi.mock("emdash", () => ({ getEmDashEntry }));

import { cartErrorMessage } from "../src/lib/error-messages.js";
import { POST as CART_ADD_POST } from "../src/pages/cart/add.js";
import { POST as CART_UPDATE_POST } from "../src/pages/cart/update.js";

const SITE = "http://localhost:4321";

function makeContext(
	pathname: string,
	form: Record<string, string>,
): { context: APIContext; dispatched: string[] } {
	const url = new URL(pathname, SITE);
	const dispatched: string[] = [];
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
	});
	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => (name === "otta_cart" ? { value: "cart-1" } : undefined),
			set: () => {},
			delete: () => {},
		},
		locals: {
			emdash: {
				handlePublicPluginApiRoute: async (_id: string, _method: string, route: string) => {
					dispatched.push(route);
					return { success: true, data: { ok: true, line: {} } };
				},
			},
		},
		redirect: (target: string, status = 302) =>
			new Response(null, { status, headers: { location: target } }),
	} as unknown as APIContext;
	return { context, dispatched };
}

const OVER = String(CART_LINE_MAX_QTY + 1);

describe.each<[string, APIRoute, Record<string, string>, string]>([
	[
		"/cart/add",
		CART_ADD_POST,
		{ sku: "OTTA-TEE", idempotencyKey: "k-1", returnTo: "/products/otta-tee" },
		"/products/otta-tee",
	],
	["/cart/update", CART_UPDATE_POST, { lineId: "line-1", idempotencyKey: "k-1" }, "/cart"],
])("POST %s", (_pathname, post, base, backTo) => {
	test(`qty ${OVER} is refused as QTY_TOO_LARGE back to ${backTo}, with no dispatch`, async () => {
		const { context, dispatched } = makeContext(_pathname, { ...base, qty: OVER });

		const response = await post(context);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(`${backTo}?error=QTY_TOO_LARGE`);
		expect(dispatched).toEqual([]);
	});

	test(`qty ${String(CART_LINE_MAX_QTY)} — the cap itself — is still allowed through`, async () => {
		const { context, dispatched } = makeContext(_pathname, {
			...base,
			qty: String(CART_LINE_MAX_QTY),
		});

		await post(context);

		expect(dispatched.length).toBeGreaterThan(0);
	});
});

describe("the copy", () => {
	test("QTY_TOO_LARGE names the plugin's OWN limit, per request — not the generic fallback", () => {
		const message = cartErrorMessage("QTY_TOO_LARGE");
		// Built from the constant, so the copy cannot drift from the cap.
		expect(message).toContain(CART_LINE_MAX_QTY.toLocaleString("en-US"));
		// The cap is per request — an add can still take a line past it — so the
		// copy must not claim a cart-wide maximum.
		expect(message).toMatch(/at a time/i);
		expect(message).not.toBe(cartErrorMessage("SOME_UNMAPPED_TOKEN"));
	});

	test("the plugin's own QTY_TOO_LARGE (an over-cap qty that reached it) lands on the same copy", async () => {
		const { context } = makeContext("/cart/update", {
			lineId: "line-1",
			idempotencyKey: "k-1",
			qty: "5",
		});
		(
			context.locals as unknown as {
				emdash: { handlePublicPluginApiRoute: unknown };
			}
		).emdash.handlePublicPluginApiRoute = async () => ({
			success: true,
			data: { ok: false, error: "QTY_TOO_LARGE" },
		});

		const response = await CART_UPDATE_POST(context);

		expect(response.headers.get("location")).toBe("/cart?error=QTY_TOO_LARGE");
	});

	test("OUT_OF_STOCK is about the QUANTITY, so it stays true beside an 'In stock' badge", () => {
		// The add that outruns stock is refused OUT_OF_STOCK while the page still
		// (truthfully) says In stock: there is stock, just not that much. The copy
		// must hold for both that case and a sold-out item.
		const message = cartErrorMessage("OUT_OF_STOCK");
		expect(message).toMatch(/enough/i);
		expect(message).not.toMatch(/that item is out of stock/i);
	});
});
