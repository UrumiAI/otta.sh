import { plugin } from "@urumi/plugin";
import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Products console under the REAL workerd-on-Node sandbox (admin-UX
// Increment 2, "product enumerate + product list"): page_load renders the
// list (forwarding the kv-sourced admin token), the filter form re-lists,
// keyset "Load more" re-lists with the service cursor, opening a product
// renders the read-only detail (incl. stock — a field the list projection
// never carries), a 404 renders "not found", and every failure fails CLOSED
// to a generic banner (no raw status/URL leak). Mirrors
// orders-page.sandbox.test.ts's shape.

const SUMMARY_1 = {
	productId: "prod-1",
	sku: "SKU-1",
	title: "Blue Widget",
	priceCents: 1999,
	currency: "USD",
	productKind: "physical",
	active: true,
	createdAt: "2026-07-12T00:00:00.000Z",
};

const SUMMARY_2 = {
	productId: "prod-2",
	sku: "SKU-2",
	title: "Red Gadget",
	priceCents: 2500,
	currency: "USD",
	productKind: "digital",
	active: false,
	createdAt: "2026-07-11T00:00:00.000Z",
};

const DETAIL_1 = {
	productId: "prod-1",
	sku: "SKU-1",
	title: "Blue Widget",
	priceCents: 1999,
	currency: "USD",
	taxClass: "standard",
	weightGrams: 300,
	lengthMm: 10,
	widthMm: 20,
	heightMm: 30,
	productKind: "physical",
	active: true,
	onHand: 42,
	createdAt: "2026-07-12T00:00:00.000Z",
	updatedAt: "2026-07-12T01:00:00.000Z",
};

/** A GET responder for the guarded list + detail reads (200 only WITH the
 *  admin token, else 401 — mirroring the service guard). Distinguishes list
 *  vs detail by path, and page1 vs page2 by the `cursor=` query param. */
function makeGetResponder() {
	return (req: {
		url: string;
		headers: Record<string, string | string[] | undefined>;
	}): { status: number; body: unknown } => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const [path, query = ""] = req.url.split("?");
		if (path === "/admin/products") {
			if (query.includes("cursor=")) {
				return { status: 200, body: { ok: true, products: [SUMMARY_2], nextCursor: null } };
			}
			return {
				status: 200,
				body: { ok: true, products: [SUMMARY_1, SUMMARY_2], nextCursor: "svc-cursor-1" },
			};
		}
		if (path === "/admin/products/prod-1") {
			return { status: 200, body: { ok: true, product: DETAIL_1 } };
		}
		if (path === "/admin/products/does-not-exist") {
			return { status: 404, body: { ok: false, reason: "PRODUCT_NOT_FOUND" } };
		}
		return { status: 404, body: { error: "unknown" } };
	};
}

async function seedToken(sandbox: SandboxHandle, stub: StubCommerceServer, token: string) {
	await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-token",
		values: { internalToken: token },
	});
	stub.requests.length = 0;
}

interface Blk extends Record<string, unknown> {
	type: string;
}
function blocksOf(outcome: unknown): Blk[] {
	if (!(typeof outcome === "object" && outcome !== null && "result" in outcome)) return [];
	const result = (outcome as { result: { blocks?: Blk[] } }).result;
	return result.blocks ?? [];
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

describe("admin Products console (workerd sandbox)", () => {
	async function boot(token = "admin-token-xyz"): Promise<void> {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		if (token.length > 0) await seedToken(sandbox, stub, token);
	}

	test("the plugin registers /products in its admin.pages-worthy page config", () => {
		// PRODUCTS_ACTION_IDS/PRODUCTS_PAGE registration is exercised end-to-end
		// below; this pins that the single `admin` route (not a per-page key)
		// is still what's registered (mirrors admin-route-dispatch's own pin).
		const keys = Object.keys(plugin.routes ?? {});
		expect(keys).toContain("admin");
		expect(keys).not.toContain("admin/products");
	});

	test("page_load /products renders the list and forwards the kv-sourced admin token", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Products")).toBe(true);
		const table = blocks.find((b) => b.type === "table");
		expect(table).toBeDefined();
		expect(((table?.rows ?? []) as unknown[]).length).toBe(2);
		expect(table?.page_action_id).toBe("products:page");
		// Money is formatted, not raw cents; stock is NEVER a list column.
		const rows = table?.rows as Array<Record<string, unknown>>;
		expect(rows[0]?.price).toContain("19.99");
		expect(rows.every((r) => !("onHand" in r) && !("stock" in r))).toBe(true);
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("NO-TOKEN page_load /products fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		await boot(""); // do not seed a token
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/products|401/);
	});

	test("filter form_submit re-lists with active + productKind + search in the GET", async () => {
		await boot();
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:apply-filter",
			values: { active: "true", productKind: "physical", search: "widget" },
		});
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(listReq).toBeDefined();
		expect(listReq!.url).toContain("active=true");
		expect(listReq!.url).toContain("productKind=physical");
		expect(listReq!.url).toContain("search=widget");
	});

	test("Load more block_action re-lists with the service cursor", async () => {
		await boot();
		const page1 = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const table = blocksOf(page1).find((b) => b.type === "table");
		const nextCursor = table?.next_cursor as string | undefined;
		expect(typeof nextCursor).toBe("string"); // console-wrapped token
		stub!.requests.length = 0;

		await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:page",
			value: { cursor: nextCursor },
		});
		const pagedReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(pagedReq).toBeDefined();
		// The console unwrapped its token back to the SERVICE cursor for the GET.
		expect(pagedReq!.url).toContain("cursor=svc-cursor-1");
		expect(pagedReq!.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("open product → detail shows the FULL fields incl. stock (never present on the list)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:open",
			values: { productId: "prod-1" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Blue Widget")).toBe(true);
		// A back button exists (no dead-end).
		const actions = blocks.filter((b) => b.type === "actions");
		const allButtons = actions.flatMap((a) => (a.elements as Array<Record<string, unknown>>) ?? []);
		expect(allButtons.some((e) => e.action_id === "products:back")).toBe(true);
		const fieldsBlocks = blocks.filter((b) => b.type === "fields");
		const allFields = fieldsBlocks.flatMap(
			(b) => (b.fields as Array<{ label: string; value: string }>) ?? [],
		);
		const byLabel = new Map(allFields.map((f) => [f.label, f.value]));
		expect(byLabel.get("Stock on hand")).toBe("42");
		expect(byLabel.get("SKU")).toBe("SKU-1");
		expect(byLabel.get("Price")).toContain("19.99");
		expect(byLabel.get("Status")).toBe("active");
	});

	test("open an unknown product → 'not found', never a hard error", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:open",
			values: { productId: "does-not-exist" },
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Product not found")).toBe(true);
		const banner = blocks.find((b) => b.type === "banner");
		expect(banner?.variant).toBe("error");
	});

	test("products:page with NO cursor value defensively yields the first-page list (not a blank)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:page",
			value: {},
		});
		const blocks = blocksOf(outcome);
		expect(blocks.some((b) => b.type === "header" && b.text === "Products")).toBe(true);
		expect(blocks.some((b) => b.type === "table")).toBe(true);
	});
});
