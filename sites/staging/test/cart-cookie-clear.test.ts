/**
 * #447 — a tampered or stale cart cookie is dropped on every refusal that says
 * the CART is bad (not just CART_NOT_FOUND), and kept on refusals that are
 * transient or about the request (out of stock, a bad quantity, busy, …).
 */
import { describe, expect, test } from "vitest";
import type { APIContext, APIRoute } from "astro";
import {
	STOREFRONT_CART_LINE_ADD_ROUTE,
	STOREFRONT_CART_LINE_REMOVE_ROUTE,
	STOREFRONT_CART_LINE_UPDATE_ROUTE,
} from "@otta-sh/plugin";
import { POST as add } from "../src/pages/cart/add.js";
import { POST as remove } from "../src/pages/cart/remove.js";
import { POST as update } from "../src/pages/cart/update.js";

const SITE = "http://localhost:4321";

const DROPS = ["CART_NOT_FOUND", "INVALID_CART_ID", "INVALID_INPUT"] as const;
const KEEPS = [
	"OUT_OF_STOCK",
	"QTY_TOO_LARGE",
	"HOLD_EXPIRED",
	"LINE_NOT_FOUND",
	"LINE_CHECKED_OUT",
	"SKU_MISMATCH",
	"CART_CHECKED_OUT",
	"RENDER_FAILED",
] as const;

const ROUTES: readonly {
	name: string;
	post: APIRoute;
	route: string;
	form: Record<string, string>;
}[] = [
	{
		name: "add",
		post: add,
		route: STOREFRONT_CART_LINE_ADD_ROUTE,
		form: { sku: "SKU-1", idempotencyKey: "k-1" },
	},
	{
		name: "update",
		post: update,
		route: STOREFRONT_CART_LINE_UPDATE_ROUTE,
		form: { lineId: "line-1", qty: "2", idempotencyKey: "k-1" },
	},
	{
		name: "remove",
		post: remove,
		route: STOREFRONT_CART_LINE_REMOVE_ROUTE,
		form: { lineId: "line-1", idempotencyKey: "k-1" },
	},
];

/** Runs one shim against a plugin that refuses with `token`; returns whether the
 *  cart cookie survived. */
async function cookieSurvives(
	shim: (typeof ROUTES)[number],
	token: string,
): Promise<{ survives: boolean; location: string | null }> {
	const url = new URL(`/cart/${shim.name}`, SITE);
	const request = new Request(url, {
		method: "POST",
		headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(shim.form).toString(),
	});
	const cookies = new Map<string, string>([["otta_cart", "cart-existing"]]);
	const handler = async (_pluginId: string, _method: string, path: string) => {
		if (path.replace(/^\//, "") === shim.route) {
			return { success: true, data: { ok: false, reason: token } };
		}
		return { success: false };
	};
	const context = {
		request,
		url,
		cookies: {
			get: (name: string) => {
				const value = cookies.get(name);
				return value === undefined ? undefined : { value };
			},
			set: (name: string, value: string) => cookies.set(name, value),
			delete: (name: string) => cookies.delete(name),
		},
		locals: { emdash: { handlePublicPluginApiRoute: handler } },
		redirect: (path: string, status = 302) =>
			new Response(null, { status, headers: { location: path } }),
	} as unknown as APIContext;
	const response = await shim.post(context);
	return { survives: cookies.has("otta_cart"), location: response.headers.get("location") };
}

describe.each(ROUTES)("POST /cart/$name — cart cookie on refusal", (shim) => {
	test.each(DROPS)("%s drops the cookie", async (token) => {
		const { survives, location } = await cookieSurvives(shim, token);
		expect(survives).toBe(false);
		expect(location).toContain(`error=${token}`);
	});

	test.each(KEEPS)("%s keeps the cookie", async (token) => {
		const { survives } = await cookieSurvives(shim, token);
		expect(survives).toBe(true);
	});
});
