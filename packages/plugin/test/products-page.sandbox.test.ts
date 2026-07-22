import { plugin } from "@urumi/plugin";
import { afterEach, describe, expect, test } from "vitest";
import {
	type RecordedRequest,
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

	test("the product detail carries an edit form (products:save) with price prefilled as a decimal", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:open",
			values: { productId: "prod-1" },
		});
		const blocks = blocksOf(outcome);
		const form = blocks.find(
			(b) =>
				b.type === "form" && (b.submit as { action_id?: string })?.action_id === "products:save",
		);
		expect(form).toBeDefined();
		const fields = (form?.fields ?? []) as Array<Record<string, unknown>>;
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		// Price is a TEXT input (never number_input — money is not a float), prefilled
		// from minor units as a hundredths decimal.
		expect(byId.get("price")?.type).toBe("text_input");
		expect(byId.get("price")?.initial_value).toBe("19.99");
		// Currency is FIXED for a priced product (a single-option carrier), so a price
		// edit can never silently switch it.
		expect(byId.get("currency")?.type).toBe("select");
		// The optimistic-concurrency watermark rides along as a hidden carrier.
		expect(byId.get("expectedUpdatedAt")?.initial_value).toBe("2026-07-12T01:00:00.000Z");
		// The publish gate (active) is NOT an editable field on this page.
		expect(byId.has("active")).toBe(false);
	});
});

// -- the guarded commerce edit (save) under the sandbox -----------------------

/** A PATCH responder: requires BOTH tokens, echoes an ok with a fresh watermark
 *  by default; a magic expectedUpdatedAt drives a 409 stale. */
function makePatchResponder() {
	return (req: RecordedRequest): { status: number; body: unknown } => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const body = req.body as { expectedUpdatedAt?: string } | undefined;
		if (body?.expectedUpdatedAt === "1999-01-01T00:00:00.000Z") {
			return {
				status: 409,
				body: { ok: false, reason: "STALE_EDIT", currentUpdatedAt: "2026-07-12T02:00:00.000Z" },
			};
		}
		return { status: 200, body: { ok: true, updatedAt: "2026-07-12T02:00:00.000Z" } };
	};
}

describe("admin Products edit / save (workerd sandbox)", () => {
	async function bootEdit(): Promise<void> {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		stub.respondWith("PATCH", makePatchResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		// Seed BOTH tokens (admin read + service write gate).
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "admin-token-xyz" },
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-service-token",
			values: { serviceToken: "svc-token-abc" },
		});
		stub.requests.length = 0;
	}

	test("save PATCHes the commerce fields with BOTH tokens + Idempotency-Key, then reloads with a Saved notice", async () => {
		await bootEdit();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save",
			values: {
				productId: "prod-1",
				expectedUpdatedAt: "2026-07-12T01:00:00.000Z",
				title: "Blue Widget XL",
				sku: "SKU-1",
				price: "24.50",
				currency: "USD",
				productKind: "physical",
				taxClass: "standard",
			},
		});

		const patch = stub!.requests.find((r) => r.method === "PATCH");
		expect(patch).toBeDefined();
		expect(patch!.url).toBe("/admin/products/prod-1");
		expect(patch!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(patch!.headers["x-service-token"]).toBe("svc-token-abc");
		expect(typeof patch!.headers["idempotency-key"]).toBe("string");
		const body = patch!.body as Record<string, unknown>;
		// Money reached the wire as INTEGER minor units (24.50 → 2450), never a float.
		expect(body.price).toEqual({ amount: 2450, currency: "USD" });
		expect(body.expectedUpdatedAt).toBe("2026-07-12T01:00:00.000Z");
		expect(body.title).toBe("Blue Widget XL");
		expect("active" in body).toBe(false);

		// The leaf reloaded (a fresh GET) and shows a success notice.
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner");
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("Saved");
		expect(
			stub!.requests.some((r) => r.method === "GET" && r.url === "/admin/products/prod-1"),
		).toBe(true);
	});

	test("a concurrent-edit conflict (409 STALE_EDIT) reloads the latest detail with a re-apply warning, never a clobber", async () => {
		await bootEdit();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save",
			values: {
				productId: "prod-1",
				expectedUpdatedAt: "1999-01-01T00:00:00.000Z", // an admin who loaded a stale revision
				title: "loser edit",
			},
		});
		const blocks = blocksOf(outcome);
		const banner = blocks.find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.title)).toMatch(/changed since you opened it/i);
		// It re-rendered the FRESH detail (a reload GET happened).
		expect(
			stub!.requests.some((r) => r.method === "GET" && r.url === "/admin/products/prod-1"),
		).toBe(true);
	});

	test("a malformed price is caught at the plugin boundary — no PATCH is sent", async () => {
		await bootEdit();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save",
			values: {
				productId: "prod-1",
				expectedUpdatedAt: "2026-07-12T01:00:00.000Z",
				price: "19.999", // three decimals — rejected before egress
				currency: "USD",
			},
		});
		expect(stub!.requests.some((r) => r.method === "PATCH")).toBe(false);
		const banner = blocksOf(outcome).find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
	});
});
