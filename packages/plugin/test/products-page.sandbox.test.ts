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
	deletedAt: null,
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
	deletedAt: null,
	createdAt: "2026-07-11T00:00:00.000Z",
};

const SUMMARY_DELETED = {
	productId: "prod-deleted",
	sku: "SKU-DEL",
	title: "Deleted Widget",
	priceCents: 500,
	currency: "USD",
	productKind: "physical",
	active: false,
	deletedAt: "2026-07-13T01:00:00.000Z",
	createdAt: "2026-07-13T00:00:00.000Z",
};

const DETAIL_1 = {
	productId: "prod-1",
	sku: "SKU-1",
	title: "Blue Widget",
	priceCents: 1999,
	currency: "USD",
	taxClass: "standard",
	compareAtCents: 3000,
	compareAtCurrency: "USD",
	unitCostCents: 850,
	unitCostCurrency: "USD",
	inventoryPolicy: "deny",
	weightGrams: 300,
	lengthMm: 10,
	widthMm: 20,
	heightMm: 30,
	productKind: "physical",
	active: true,
	deletedAt: null,
	onHand: 42,
	createdAt: "2026-07-12T00:00:00.000Z",
	updatedAt: "2026-07-12T01:00:00.000Z",
};

const DETAIL_DELETED = {
	productId: "prod-deleted",
	sku: "SKU-DEL",
	title: "Deleted Widget",
	priceCents: 500,
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
	active: false,
	deletedAt: "2026-07-13T01:00:00.000Z",
	onHand: 7,
	createdAt: "2026-07-13T00:00:00.000Z",
	updatedAt: "2026-07-13T01:00:00.000Z",
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
			if (query.includes("deleted=true")) {
				return { status: 200, body: { ok: true, products: [SUMMARY_DELETED], nextCursor: null } };
			}
			if (query.includes("cursor=")) {
				return { status: 200, body: { ok: true, products: [SUMMARY_2], nextCursor: null } };
			}
			return {
				status: 200,
				body: { ok: true, products: [SUMMARY_1, SUMMARY_2], nextCursor: "svc-cursor-1" },
			};
		}
		if (path === "/admin/tax/classes") {
			return {
				status: 200,
				body: {
					ok: true,
					classes: [
						{ id: "standard", name: "Standard" },
						{ id: "reduced", name: "Reduced" },
					],
				},
			};
		}
		if (path === "/admin/products/prod-1") {
			return { status: 200, body: { ok: true, product: DETAIL_1 } };
		}
		if (path === "/admin/products/prod-deleted") {
			return { status: 200, body: { ok: true, product: DETAIL_DELETED } };
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

	// -- product lifecycle surfacing (admin-UX Increment 2) -----------------------

	test("the combined Status select's 'archived' option re-lists with deleted=true, never active=..., in the GET", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:apply-filter",
			values: { active: "archived" },
		});
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(listReq).toBeDefined();
		expect(listReq!.url).toContain("deleted=true");
		expect(listReq!.url).not.toContain("active=");
		// The archived response's row shows the honest "deleted" status, never
		// "inactive" (deletedAt outranks active in the status label).
		const table = blocksOf(outcome).find((b) => b.type === "table");
		const rows = (table?.rows ?? []) as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.status)).toEqual(["deleted"]);
	});

	test("open a soft-deleted product → the read-only tombstone view: status 'deleted', NO edit form, NO stock forms", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:open",
			values: { productId: "prod-deleted" },
		});
		const blocks = blocksOf(outcome);
		// A tombstone banner explains the state.
		const banner = blocks.find((b) => b.type === "banner");
		expect(banner).toBeDefined();
		expect(String(banner?.title)).toMatch(/deleted/i);
		const fieldsBlocks = blocks.filter((b) => b.type === "fields");
		const allFields = fieldsBlocks.flatMap(
			(b) => (b.fields as Array<{ label: string; value: string }>) ?? [],
		);
		const byLabel = new Map(allFields.map((f) => [f.label, f.value]));
		expect(byLabel.get("Status")).toBe("deleted");
		// Never an edit or stock-movement form for a tombstoned row.
		const forms = blocks.filter((b) => b.type === "form");
		const submitIds = forms.map((f) => (f.submit as { action_id?: string })?.action_id);
		expect(submitIds).not.toContain("products:save");
		expect(submitIds).not.toContain("products:restock");
		expect(submitIds).not.toContain("products:remove-stock");
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

	test("the edit form surfaces the data-model adds: compare-at, unit cost, tax-class registry select, deny-only policy", async () => {
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
		const fields = (form?.fields ?? []) as Array<Record<string, unknown>>;
		const byId = new Map(fields.map((f) => [f.action_id, f]));

		// compare-at + unit cost are TEXT inputs (money is not a float), prefilled as
		// hundredths decimals from the detail's minor units.
		expect(byId.get("compareAt")?.type).toBe("text_input");
		expect(byId.get("compareAt")?.initial_value).toBe("30.00");
		expect(byId.get("unitCost")?.type).toBe("text_input");
		expect(byId.get("unitCost")?.initial_value).toBe("8.50");

		// Tax class is a SELECT sourced from the live registry (GET /admin/tax/classes),
		// with a clear option and the product's current value preselected.
		const taxClass = byId.get("taxClass") as {
			type?: string;
			options?: Array<{ value: string }>;
			initial_value?: string;
		};
		expect(taxClass.type).toBe("select");
		expect(taxClass.initial_value).toBe("standard");
		expect(taxClass.options?.map((o) => o.value)).toEqual(["", "standard", "reduced"]);

		// Inventory policy is a DENY-ONLY select — the no-oversell invariant means no
		// allow_backorder option is offered this slice.
		const policy = byId.get("inventoryPolicy") as {
			type?: string;
			options?: Array<{ value: string }>;
		};
		expect(policy.type).toBe("select");
		expect(policy.options?.map((o) => o.value)).toEqual(["deny"]);
	});

	test("the tax-class select falls back to the static defaults when the registry read fails — the detail still renders", async () => {
		await boot();
		// Replace the GET responder with one whose /admin/tax/classes read FAILS
		// (500) while the product detail still serves — the registry read is a
		// SECONDARY, best-effort fetch that must degrade, never break the leaf.
		const base = makeGetResponder();
		stub!.respondWith("GET", (req) => {
			const [path] = req.url.split("?");
			if (path === "/admin/tax/classes") {
				return { status: 500, body: { ok: false, error: "boom" } };
			}
			return base(req);
		});

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
		expect(form).toBeDefined(); // the leaf rendered despite the registry failure.
		const fields = (form?.fields ?? []) as Array<Record<string, unknown>>;
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		const taxClass = byId.get("taxClass") as {
			options?: Array<{ value: string }>;
			initial_value?: string;
		};
		// DEFAULT_TAX_CLASSES backstop: clear option + the four static defaults.
		expect(taxClass.options?.map((o) => o.value)).toEqual([
			"",
			"standard",
			"reduced",
			"zero",
			"digital",
		]);
		// The product's current value ("standard") is in the defaults, so it is
		// still preselected — no extra verbatim option appended.
		expect(taxClass.initial_value).toBe("standard");
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

// -- merchant restock / stock removal (slice 3) under the sandbox -------------

/** A POST responder for the stock-movement endpoints. Requires the admin token;
 *  restock echoes the new on-hand; remove-stock echoes it or a magic qty=999
 *  drives a 409 INSUFFICIENT_STOCK. */
function makeStockResponder() {
	return (req: RecordedRequest): { status: number; body: unknown } => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const qty = (req.body as { qty?: number } | undefined)?.qty ?? 0;
		if (req.url === "/admin/products/prod-1/restock") {
			return { status: 200, body: { ok: true, onHand: 42 + qty } };
		}
		if (req.url === "/admin/products/prod-1/remove-stock") {
			if (qty === 999) {
				return { status: 409, body: { ok: false, reason: "INSUFFICIENT_STOCK", onHand: 42 } };
			}
			return { status: 200, body: { ok: true, onHand: 42 - qty } };
		}
		return { status: 404, body: { ok: false, reason: "PRODUCT_NOT_FOUND" } };
	};
}

describe("admin Products restock / remove-stock (workerd sandbox)", () => {
	async function bootStock(): Promise<void> {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		stub.respondWith("POST", makeStockResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
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

	test("the product detail carries a restock form and a remove-stock form, each a qty TEXT input", async () => {
		await bootStock();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:open",
			values: { productId: "prod-1" },
		});
		const forms = blocksOf(outcome).filter((b) => b.type === "form");
		const restock = forms.find(
			(f) => (f.submit as { action_id?: string })?.action_id === "products:restock",
		);
		const remove = forms.find(
			(f) => (f.submit as { action_id?: string })?.action_id === "products:remove-stock",
		);
		expect(restock).toBeDefined();
		expect(remove).toBeDefined();
		const restockQty = ((restock?.fields ?? []) as Array<Record<string, unknown>>).find(
			(f) => f.action_id === "qty",
		);
		expect(restockQty?.type).toBe("text_input"); // never number_input (integer discipline)
		// A per-submission nonce carrier threads the idempotency seed.
		expect(
			((restock?.fields ?? []) as Array<Record<string, unknown>>).some(
				(f) => f.action_id === "nonce",
			),
		).toBe(true);
	});

	test("restock POSTs {qty} with BOTH tokens + Idempotency-Key, then reloads with a 'Stock added' notice", async () => {
		await bootStock();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:restock",
			values: { productId: "prod-1", nonce: "nonce-1", qty: "8" },
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/products/prod-1/restock");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(post!.headers["x-service-token"]).toBe("svc-token-abc");
		expect(typeof post!.headers["idempotency-key"]).toBe("string");
		expect((post!.body as Record<string, unknown>).qty).toBe(8);
		const banner = blocksOf(outcome).find((b) => b.type === "banner");
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("Stock added");
		// The leaf reloaded (a fresh GET) to show the new count.
		expect(
			stub!.requests.some((r) => r.method === "GET" && r.url === "/admin/products/prod-1"),
		).toBe(true);
	});

	test("removing more than on hand is a clean INSUFFICIENT_STOCK notice, never a negative", async () => {
		await bootStock();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock",
			values: { productId: "prod-1", nonce: "nonce-2", qty: "999" },
		});
		const banner = blocksOf(outcome).find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.title)).toMatch(/not enough stock/i);
	});

	test("a non-numeric qty is caught at the plugin boundary — no POST is sent", async () => {
		await bootStock();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:restock",
			values: { productId: "prod-1", nonce: "nonce-3", qty: "-4" },
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = blocksOf(outcome).find((b) => b.type === "banner" && b.variant === "error");
		expect(banner).toBeDefined();
	});

	test("a double-submit of the SAME rendered form (same nonce) dedupes to ONE movement; a fresh nonce applies again", async () => {
		// A ledger-emulating stub: dedupes by Idempotency-Key exactly like the
		// service's stock-movements ledger, tracking the on-hand it would produce.
		let onHand = 42;
		const seen = new Map<string, number>(); // key → recorded resulting onHand
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder());
		stub.respondWith("POST", (req: RecordedRequest): { status: number; body: unknown } => {
			if (req.headers["x-internal-token"] === undefined) {
				return { status: 401, body: { ok: false, error: "unauthorized" } };
			}
			const key = req.headers["idempotency-key"] as string;
			const recorded = seen.get(key);
			if (recorded !== undefined) {
				return { status: 200, body: { ok: true, onHand: recorded } }; // replay: no movement
			}
			onHand += (req.body as { qty?: number } | undefined)?.qty ?? 0;
			seen.set(key, onHand);
			return { status: 200, body: { ok: true, onHand } };
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: "admin-token-xyz" },
		});
		stub.requests.length = 0;

		// The same RENDERED form submitted twice: em-dash resends the SAME captured
		// values, nonce included — so both POSTs derive the SAME Idempotency-Key.
		const submit = () =>
			sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "products:restock",
				values: { productId: "prod-1", nonce: "nonce-dupe", qty: "8" },
			});
		await submit();
		const replay = await submit();

		const posts = stub.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(2);
		expect(posts[0]!.headers["idempotency-key"]).toBe(posts[1]!.headers["idempotency-key"]);
		// The ledger applied the +8 ONCE (42 → 50), and the replay echoed it.
		expect(onHand).toBe(50);
		const banner = blocksOf(replay).find((b) => b.type === "banner");
		expect(String(banner?.description)).toContain("50");

		// A FRESH render mints a new nonce ⇒ a different key ⇒ a second DELIBERATE
		// restock applies (never collapsed into the first).
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:restock",
			values: { productId: "prod-1", nonce: "nonce-fresh", qty: "8" },
		});
		const allPosts = stub.requests.filter((r) => r.method === "POST");
		expect(allPosts[2]!.headers["idempotency-key"]).not.toBe(posts[0]!.headers["idempotency-key"]);
		expect(onHand).toBe(58);
	});
});
