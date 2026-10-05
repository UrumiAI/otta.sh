/**
 * The e2e order seed's guards (issue #378).
 *
 * The happy path runs for real in the e2e global setup, against a dev server.
 * What is pinned here is everything that must hold WITHOUT one: the script
 * never talks to a non-loopback host, never signs a payment against a store
 * that takes real ones, never reads an unrecognised Settings page as "safe",
 * and does nothing at all on a re-run against a seeded stack.
 */
import { describe, expect, test } from "vitest";
import {
	assertLoopbackSite,
	E2E_WEBHOOK_SECRET,
	pickPurchasable,
	seedPaidOrders,
	stripeSecretKeyIsSet,
	type CatalogRow,
	type SeedOrdersDeps,
} from "../scripts/seed-e2e-orders.js";

describe("assertLoopbackSite", () => {
	test("accepts loopback, trimming a trailing slash", () => {
		expect(assertLoopbackSite("http://127.0.0.1:4610/")).toBe("http://127.0.0.1:4610");
		expect(assertLoopbackSite("http://localhost:4500")).toBe("http://localhost:4500");
		expect(assertLoopbackSite("http://[::1]:4500")).toBe("http://[::1]:4500");
	});

	test("refuses anything else before a request is made", () => {
		expect(() => assertLoopbackSite("https://staging.otta.sh")).toThrow(/loopback/);
		expect(() => assertLoopbackSite("http://10.0.0.5:4500")).toThrow(/loopback/);
		expect(() => assertLoopbackSite("not a url")).toThrow(/must be a URL/);
	});
});

describe("pickPurchasable", () => {
	const buyable: CatalogRow = {
		productId: "p-ok",
		sku: "OTTA-MUG",
		priceCents: 1800,
		currency: "USD",
		active: true,
		onHand: 40,
		deletedAt: null,
	};

	test("the first priced, active, live, stocked product", () => {
		expect(pickPurchasable([buyable])).toEqual({
			productId: "p-ok",
			sku: "OTTA-MUG",
			currency: "USD",
		});
	});

	test("skips every row a cart could not hold", () => {
		const rows: CatalogRow[] = [
			{ ...buyable, productId: "no-sku", sku: null },
			{ ...buyable, productId: "unpriced", priceCents: null },
			{ ...buyable, productId: "free", priceCents: 0 },
			{ ...buyable, productId: "inactive", active: false },
			{ ...buyable, productId: "deleted", deletedAt: "2026-10-01T00:00:00Z" },
			{ ...buyable, productId: "sold-out", onHand: 0 },
			{ ...buyable, productId: "no-stock-record", onHand: null },
			{ ...buyable, productId: "no-currency", currency: null },
		];
		expect(pickPurchasable(rows)).toBeNull();
		expect(pickPurchasable([...rows, buyable])?.productId).toBe("p-ok");
	});
});

/** The Settings page's secret field, in the shape the settings handler renders. */
function settingsPage(label: string): unknown {
	return {
		blocks: [
			{
				type: "form",
				fields: [{ type: "secret_input", action_id: "stripeSecretKey", label }],
			},
		],
	};
}

describe("stripeSecretKeyIsSet", () => {
	test("reads the field's own set / not set label", () => {
		expect(stripeSecretKeyIsSet(settingsPage("Stripe secret key — not set"))).toBe(false);
		expect(stripeSecretKeyIsSet(settingsPage("Stripe secret key — set"))).toBe(true);
	});

	test("an unrecognised page is a refusal, never a 'not set'", () => {
		expect(() => stripeSecretKeyIsSet({ blocks: [] })).toThrow(/Refusing to guess/);
		expect(() => stripeSecretKeyIsSet(settingsPage("Stripe secret key"))).toThrow(
			/Refusing to guess/,
		);
	});
});

/** A fake site that records every request and answers the admin route from
 *  `answer`. Anything else (a storefront or webhook call) is a test failure. */
function fakeSite(answer: (body: Record<string, unknown>) => unknown): {
	deps: SeedOrdersDeps;
	requests: Array<{ url: string; body: Record<string, unknown> }>;
} {
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		requests.push({ url, body });
		if (!url.endsWith("/_emdash/api/plugins/otta/admin")) {
			throw new Error(`unexpected request to ${url}`);
		}
		return new Response(JSON.stringify({ success: true, data: answer(body) }), { status: 200 });
	}) as typeof fetch;
	return {
		deps: {
			siteUrl: "http://127.0.0.1:4610",
			authHeaders: { Cookie: "session=x" },
			webhookSecret: E2E_WEBHOOK_SECRET,
			fetchImpl,
		},
		requests,
	};
}

describe("seedPaidOrders", () => {
	test("a re-run against a seeded stack reads once and writes NOTHING", async () => {
		const { deps, requests } = fakeSite(() => ({
			ok: true,
			orders: [{ id: "o1" }, { id: "o2" }],
		}));
		expect(await seedPaidOrders(deps, 2)).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.body).toMatchObject({
			resource: "orders.list",
			filter: { status: "paid" },
		});
	});

	test("a store with a real Stripe key is refused before anything is written", async () => {
		const { deps, requests } = fakeSite((body) =>
			body["resource"] === "orders.list"
				? { ok: true, orders: [] }
				: settingsPage("Stripe secret key — set"),
		);
		await expect(seedPaidOrders(deps, 2)).rejects.toThrow(/REAL payments/);
		// The list read and the settings read, and no save, cart or webhook.
		expect(requests.map((r) => r.body["type"] ?? r.body["action_id"])).toEqual([
			"otta_console_read",
			"page_load",
		]);
	});
});
