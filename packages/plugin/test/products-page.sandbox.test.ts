import { plugin } from "@urumi/plugin";
import { afterEach, describe, expect, test } from "vitest";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	confirmOf,
	field,
	fieldIds,
	findBlock,
	findBlocks,
	formFor,
	group,
	groupBlocks,
	openGroupIds,
	panel,
	panelLabels,
	valueOf,
	type LooseBlock,
} from "./helpers/blocks.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { PRODUCTS_PAGE } from "../src/admin/products-page.js";

// The admin Pricing & inventory console under the REAL workerd-on-Node sandbox
// (design spec §12.1 — built last of the seven admin screens). Covers: the
// list (filter accordion, badge-free-of-Kind table, combobox drill-in, empty
// state), the two-panel detail (identity strip with CMS-owned rows, the
// three-way split edit form, restock as a one-shot DA-4 form, and remove-stock
// as the screen's one DA-3 stage/confirm/refuse flow), and that neither
// banned "oversell" phrasing survives anywhere in a rendered response.

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

/** The state PR 1b creates: the CMS sync mints a row for every products
 *  document, so publishing one nobody ever priced yields `active: true` on a
 *  row with no sku and no price. It is NOT sellable — the service's catalog
 *  read filters commerce-incomplete rows — so the console must not call it a
 *  plain "active". */
const SUMMARY_UNPRICED = {
	productId: "prod-unpriced",
	sku: null,
	title: "Freshly Created",
	priceCents: null,
	currency: null,
	productKind: "physical",
	active: true,
	deletedAt: null,
	createdAt: "2026-07-14T00:00:00.000Z",
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

const DETAIL_1_BASE = {
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
	createdAt: "2026-07-12T00:00:00.000Z",
	updatedAt: "2026-07-12T01:00:00.000Z",
};

const DETAIL_UNPRICED = {
	productId: "prod-unpriced",
	sku: null,
	title: "Freshly Created",
	priceCents: null,
	currency: null,
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
	onHand: 0,
	createdAt: "2026-07-14T00:00:00.000Z",
	updatedAt: "2026-07-14T00:00:00.000Z",
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

/** A product whose `updatedAt` matches `makePatchResponder`'s magic STALE_EDIT
 *  sentinel — since `expectedUpdatedAt` now rides invisibly in the Identity
 *  form's own carrier (never a visible field), the only way to drive that
 *  branch through the REAL flow is a fixture whose real watermark IS the
 *  sentinel, rather than overwriting a `values.expectedUpdatedAt` that no
 *  longer exists. */
const DETAIL_STALE = {
	productId: "prod-stale",
	sku: "SKU-STALE",
	title: "Stale Widget",
	priceCents: 1200,
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
	updatedAt: "1999-01-01T00:00:00.000Z",
};

/** Mutable read-time state the GET responder serves — lets a test simulate
 *  stock changing between two reads (a concurrent removal) without hand-
 *  crafting a carrier token. */
interface LiveState {
	onHand1: number;
}

function freshState(): LiveState {
	return { onHand1: 42 };
}

/** A GET responder for the guarded list + detail reads (200 only WITH the
 *  admin token, else 401 — mirroring the service guard). */
function makeGetResponder(state: LiveState) {
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
			if (query.includes("search=unpriced")) {
				return {
					status: 200,
					body: { ok: true, products: [SUMMARY_1, SUMMARY_UNPRICED], nextCursor: null },
				};
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
			return {
				status: 200,
				body: { ok: true, product: { ...DETAIL_1_BASE, onHand: state.onHand1 } },
			};
		}
		if (path === "/admin/products/prod-unpriced") {
			return { status: 200, body: { ok: true, product: DETAIL_UNPRICED } };
		}
		if (path === "/admin/products/prod-stale") {
			return { status: 200, body: { ok: true, product: DETAIL_STALE } };
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

async function seedBothTokens(sandbox: SandboxHandle, stub: StubCommerceServer) {
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

/** Open the detail leaf and return its rendered blocks. */
async function openProduct(sandbox: SandboxHandle, productId: string): Promise<LooseBlock[]> {
	const outcome = await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "products:open",
		values: { productId },
	});
	return blocksOf(outcome);
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

// -- the list (§12.1 list) ----------------------------------------------------

describe("admin Products console — list (workerd sandbox)", () => {
	async function boot(token = "admin-token-xyz"): Promise<LiveState> {
		const state = freshState();
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(state));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		if (token.length > 0) await seedToken(sandbox, stub, token);
		return state;
	}

	test("the plugin registers /products in its admin.pages-worthy page config", () => {
		const keys = Object.keys(plugin.routes ?? {});
		expect(keys).toContain("admin");
		expect(keys).not.toContain("admin/products");
	});

	test("the console nav label reads 'Pricing & inventory' while its route stays /products", () => {
		expect(PRODUCTS_PAGE.label).toBe("Pricing & inventory");
		expect(PRODUCTS_PAGE.path).toBe("/products");
	});

	test("page_load renders the list: header, in-budget context, collapsed filter accordion, table without a Kind column", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "products", level: "list" });

		expect(findBlocks(blocks, "header").some((b) => b.text === "Pricing & inventory")).toBe(true);
		const pageContext = blocks.find((b) => b.type === "context");
		expect(String(pageContext?.text).length).toBeLessThanOrEqual(140);

		// L-2: 3 filter fields wrap in a COLLAPSED accordion.
		const filterGroup = group(blocks, "products:filters");
		expect(filterGroup).toBeDefined();
		expect(filterGroup?.default_open).not.toBe(true);
		expect(filterGroup?.label).toBe("Filters");

		const table = findBlock(blocks, "table");
		expect(table).toBeDefined();
		expect(((table?.rows ?? []) as unknown[]).length).toBe(2);
		expect(table?.page_action_id).toBe("products:page");
		const columnKeys = ((table?.columns ?? []) as Array<{ key: string }>).map((c) => c.key);
		expect(columnKeys).toEqual(["title", "sku", "status", "price"]); // Kind DELETED (T-5, X-4)
		const rows = table?.rows as Array<Record<string, unknown>>;
		expect(rows[0]?.price).toContain("19.99");
		expect(rows.every((r) => !("onHand" in r) && !("kind" in r))).toBe(true);

		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
	});

	test("NO-TOKEN page_load fails closed with E-7's normative copy (no raw HTTP status/URL, names the console-fault possibility)", async () => {
		await boot("");
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const blocks = blocksOf(outcome);
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/products|401/);
		expect(String(banner?.description)).toMatch(/fault in the console itself/);
	});

	test("filter form_submit re-lists with active + productKind + search in the GET, and the accordion label counts active filters", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:apply-filter",
			values: { status: "true", productKind: "physical", search: "widget" },
		});
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(listReq).toBeDefined();
		expect(listReq!.url).toContain("active=true");
		expect(listReq!.url).toContain("productKind=physical");
		expect(listReq!.url).toContain("search=widget");

		const blocks = blocksOf(outcome);
		const filterGroup = group(blocks, "products:filters");
		expect(filterGroup?.label).toBe("Filters (3 active)");
		const summarySection = findBlocks(blocks, "section")[0];
		expect(String(summarySection?.text)).toBe("status: true · kind: physical · search: widget");
		expect((summarySection?.accessory as { label?: string })?.label).toBe("Clear filters");
	});

	test("no select on this screen uses '' as an option value — the sentinel is a real word (F-6a)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const blocks = blocksOf(outcome);
		const filterForm = formFor(blocks, "products:apply-filter");
		for (const f of (filterForm?.fields ?? []) as Array<Record<string, unknown>>) {
			if (f.type !== "select" && f.type !== "combobox") continue;
			const options = (f.options ?? []) as Array<{ value: string }>;
			expect(options.some((o) => o.value === "")).toBe(false);
			expect(options.some((o) => o.value === f.initial_value)).toBe(true);
		}
	});

	test("§4.4: an ACTIVE but never-priced product reads 'active (not priced)', in the table AND the picker — a priced one still reads 'active'", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:apply-filter",
			values: { search: "unpriced" },
		});
		const blocks = blocksOf(outcome);
		const rows = findBlock(blocks, "table")?.rows as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.status)).toEqual(["active", "active (not priced)"]);

		// The "Open product" picker is a COMBOBOX (L-7: >8-row-safe, and the
		// trigger renders the label, never the raw id — R-17b), sharing
		// `statusLabel` with the table so the two surfaces cannot disagree.
		const picker = formFor(blocks, "products:open");
		expect(picker).toBeDefined();
		const productIdField = field(picker, "productId");
		expect(productIdField?.type).toBe("combobox");
		const options = (productIdField!.options as Array<{ label: string }>).map((o) => o.label);
		expect(options).toEqual([
			"Choose a product…",
			"Blue Widget — active",
			"Freshly Created — active (not priced)",
		]);
	});

	test("the combined Status select's 'archived' option re-lists with deleted=true, never active=..., in the GET", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:apply-filter",
			values: { status: "archived" },
		});
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(listReq).toBeDefined();
		expect(listReq!.url).toContain("deleted=true");
		expect(listReq!.url).not.toContain("active=");
		const table = findBlock(blocksOf(outcome), "table");
		const rows = (table?.rows ?? []) as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.status)).toEqual(["deleted"]);
	});

	test("Load more block_action re-lists with the service cursor", async () => {
		await boot();
		const page1 = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/products" });
		const table = findBlock(blocksOf(page1), "table");
		const nextCursor = table?.next_cursor as string | undefined;
		expect(typeof nextCursor).toBe("string");
		stub!.requests.length = 0;

		await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:page",
			value: { cursor: nextCursor },
		});
		const pagedReq = stub!.requests.find((r) => r.url.startsWith("/admin/products"));
		expect(pagedReq).toBeDefined();
		expect(pagedReq!.url).toContain("cursor=svc-cursor-1");
	});

	test("products:page with NO cursor value defensively yields the first-page list (not a blank)", async () => {
		await boot();
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:page",
			value: {},
		});
		const blocks = blocksOf(outcome);
		expect(findBlocks(blocks, "header").some((b) => b.text === "Pricing & inventory")).toBe(true);
		expect(findBlocks(blocks, "table").length).toBeGreaterThan(0);
	});

	test("E-2: the unfiltered zero state renders the empty block, no create action (products originate in the CMS)", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) => {
			if (req.headers["x-internal-token"] === undefined) {
				return { status: 401, body: { ok: false, error: "unauthorized" } };
			}
			const [path] = req.url.split("?");
			if (path === "/admin/products") {
				return { status: 200, body: { ok: true, products: [], nextCursor: null } };
			}
			return { status: 404, body: { error: "unknown" } };
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedToken(sandbox, stub, "admin-token-xyz");
		const outcome = await sandbox.invokeRoute("admin", { type: "page_load", page: "/products" });
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "products", level: "list" });
		expect(findBlocks(blocks, "table").length).toBe(0);
		const empty = findBlock(blocks, "empty");
		expect(empty?.title).toBe("No products yet");
		expect(empty?.actions === undefined || (empty.actions as unknown[]).length === 0).toBe(true);
	});
});

// -- the detail identity strip + tab panel set (§12.1 detail) -----------------

describe("admin Products console — detail shell (workerd sandbox)", () => {
	async function boot(): Promise<LiveState> {
		const state = freshState();
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(state));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedToken(sandbox, stub, "admin-token-xyz");
		return state;
	}

	test("open product → header is the title, back button present, panel set is EXACTLY [Product, Stock] at tab 0", async () => {
		await boot();
		const blocks = await openProduct(sandbox!, "prod-1");
		assertBlockContract(blocks, { screen: "products", level: "detail" });
		expect(findBlocks(blocks, "header").some((b) => b.text === "Blue Widget")).toBe(true);
		const allButtons = findBlocks(blocks, "actions").flatMap(
			(a) => (a.elements as Array<Record<string, unknown>>) ?? [],
		);
		expect(allButtons.some((e) => e.action_id === "products:back")).toBe(true);
		expect(panelLabels(blocks)).toEqual(["Product", "Stock"]);
		const tab = findBlock(blocks, "tab");
		expect(tab?.default_tab ?? 0).toBe(0);
	});

	test("the identity strip has 6 entries, and BOTH CMS-owned rows name their owner (F-2b, X-52)", async () => {
		await boot();
		const blocks = await openProduct(sandbox!, "prod-1");
		const identityFields = findBlocks(blocks, "fields").find(
			(f) => f.block_id === "products:identity",
		);
		const byLabel = new Map(
			((identityFields?.fields ?? []) as Array<{ label: string; value: string }>).map((f) => [
				f.label,
				f.value,
			]),
		);
		expect(byLabel.size).toBe(6);
		expect(byLabel.get("Title (set in the CMS)")).toBe("Blue Widget");
		expect(byLabel.get("Status (set in the CMS)")).toBe("active");
		expect(byLabel.get("SKU")).toBe("SKU-1");
		expect(byLabel.get("Price")).toContain("19.99");
		expect(byLabel.get("Stock on hand")).toBe("42");
		expect(byLabel.get("Kind")).toBe("physical");
	});

	test("no form anywhere on the screen offers an 'active' or 'title' field (F-2b, X-52)", async () => {
		await boot();
		const blocks = await openProduct(sandbox!, "prod-1");
		const everyFormField = findBlocks(blocks, "form").flatMap(
			(b) => (b.fields as Array<Record<string, unknown>>) ?? [],
		);
		expect(everyFormField.some((f) => f.action_id === "title")).toBe(false);
		expect(everyFormField.some((f) => f.action_id === "active")).toBe(false);
	});

	test("open an unknown product → 'not found', never a hard error", async () => {
		await boot();
		const blocks = await openProduct(sandbox!, "does-not-exist");
		expect(findBlocks(blocks, "header").some((b) => b.text === "Product not found")).toBe(true);
		const banner = findBlock(blocks, "banner");
		expect(banner?.variant).toBe("error");
	});

	test("no rendered string anywhere in a detail response uses the banned 'oversell' slogan", async () => {
		await boot();
		const blocks = await openProduct(sandbox!, "prod-1");
		const json = JSON.stringify(blocks);
		expect(json).not.toMatch(/no overselling|overselling|oversold|(?<!no-)oversell\b/i);
	});
});

// -- the tombstoned (soft-deleted) product — D-3's constant panel set --------

describe("admin Products console — tombstoned product (workerd sandbox)", () => {
	async function boot(): Promise<void> {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(freshState()));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedToken(sandbox, stub, "admin-token-xyz");
	}

	test("a soft-deleted product renders BOTH panels (D-3) — each with the tombstone line, no edit or stock forms", async () => {
		await boot();
		const blocks = await openProduct(sandbox!, "prod-deleted");
		assertBlockContract(blocks, { screen: "products", level: "detail" });

		const banner = findBlock(blocks, "banner");
		expect(banner).toBeDefined();
		expect(String(banner?.title)).toMatch(/deleted in the cms/i);

		// D-3: the panel SET stays [Product, Stock] — never dropped.
		expect(panelLabels(blocks)).toEqual(["Product", "Stock"]);
		const productPanelBlocks = panel(blocks, "Product");
		const stockPanelBlocks = panel(blocks, "Stock");
		expect(findBlocks(productPanelBlocks, "fields").length).toBeGreaterThan(0);
		expect(findBlocks(stockPanelBlocks, "fields").length).toBeGreaterThan(0);
		expect(findBlocks(productPanelBlocks, "accordion").length).toBe(0);
		expect(findBlocks(stockPanelBlocks, "accordion").length).toBe(0);
		expect(
			findBlocks(productPanelBlocks, "context").some((c) =>
				/editing and stock moves are unavailable/i.test(String(c.text)),
			),
		).toBe(true);
		expect(
			findBlocks(stockPanelBlocks, "context").some((c) =>
				/editing and stock moves are unavailable/i.test(String(c.text)),
			),
		).toBe(true);

		// Never an edit or stock-movement form for a tombstoned row.
		const submitIds = findBlocks(blocks, "form").map(
			(f) => (f.submit as { action_id?: string })?.action_id,
		);
		expect(submitIds).not.toContain("products:save-identity");
		expect(submitIds).not.toContain("products:save-price");
		expect(submitIds).not.toContain("products:save-shipping");
		expect(submitIds).not.toContain("products:restock");
		expect(submitIds).not.toContain("products:remove-stock-review");
	});
});

// -- a SKU-less product (freshly synced, unpriced) — D-7's stock-panel line --

describe("admin Products console — SKU-less product (workerd sandbox)", () => {
	test("no SKU ⇒ the Stock panel omits both restock/remove groups, replaced by one context line (D-7); the Price group shows a visible Currency field", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(freshState()));
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedToken(sandbox, stub, "admin-token-xyz");
		const blocks = await openProduct(sandbox, "prod-unpriced");
		assertBlockContract(blocks, { screen: "products", level: "detail" });

		const stockPanelBlocks = panel(blocks, "Stock");
		expect(findBlocks(stockPanelBlocks, "accordion").length).toBe(0);
		expect(
			findBlocks(stockPanelBlocks, "context").some((c) => /need a sku first/i.test(String(c.text))),
		).toBe(true);

		const priceForm = formFor(blocks, "products:save-price");
		expect(priceForm).toBeDefined();
		expect(fieldIds(priceForm)).toEqual(["price", "currency", "compareAt", "unitCost"]);
	});
});

// -- the three-way split edit form (F-5a) -------------------------------------

/** A PATCH responder: requires the admin token, echoes an ok with a fresh
 *  watermark by default; a magic `expectedUpdatedAt` drives a 409 stale. */
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

describe("admin Products console — split edit form (workerd sandbox)", () => {
	async function bootEdit(): Promise<LiveState> {
		const state = freshState();
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(state));
		stub.respondWith("PATCH", makePatchResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedBothTokens(sandbox, stub);
		return state;
	}

	test("Identity is ONE field (SKU) and it is the D-5 rank-3 default-open group", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const identity = group(blocks, "products:prod-1:edit-identity");
		expect(identity).toBeDefined();
		expect(identity?.default_open).toBe(true); // D-5 rank 3: the named primary edit group
		const identityForm = formFor(
			groupBlocks(blocks, "products:prod-1:edit-identity"),
			"products:save-identity",
		);
		expect(fieldIds(identityForm)).toEqual(["sku"]);

		// Price and Shipping are NEVER a D-5 rank — always collapsed.
		expect(group(blocks, "products:prod-1:edit-price")?.default_open).not.toBe(true);
		expect(group(blocks, "products:prod-1:edit-shipping")?.default_open).not.toBe(true);
		expect(openGroupIds(blocks)).toEqual(["products:prod-1:edit-identity"]);
	});

	test("Price is a select-free ≤4-field group; the fixed currency of an ALREADY-PRICED product rides invisibly in the carrier, never as a select (F-3)", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const priceForm = formFor(blocks, "products:save-price");
		expect(fieldIds(priceForm)).toEqual(["price", "compareAt", "unitCost"]); // NO currency field
		expect(
			((priceForm?.fields ?? []) as Array<Record<string, unknown>>).every(
				(f) => f.type !== "select",
			),
		).toBe(true);
		const priceGroup = group(blocks, "products:prod-1:edit-price");
		expect(String(priceGroup?.label)).toContain("19.99");
		expect(String(priceGroup?.label).length).toBeLessThanOrEqual(60);
	});

	test("Classification & shipping is exactly 6 fields (F-5's budget), and the tax-class 'clear' sentinel is never ''", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const shippingForm = formFor(blocks, "products:save-shipping");
		expect(fieldIds(shippingForm)).toEqual([
			"productKind",
			"taxClass",
			"weightGrams",
			"lengthMm",
			"widthMm",
			"heightMm",
		]);
		const taxClass = field(shippingForm, "taxClass");
		const options = ((taxClass?.options ?? []) as Array<{ value: string }>).map((o) => o.value);
		expect(options.includes("")).toBe(false);
		expect(options[0]).toBe("none");
	});

	test("F-5a-i: ONE sibling-discard context line sits above the three groups, not repeated inside any of them", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const productPanelBlocks = panel(blocks, "Product");
		const discardLines = findBlocks(productPanelBlocks, "context").filter((c) =>
			/saves on its own/i.test(String(c.text)),
		);
		expect(discardLines).toHaveLength(1);
		// Not inside any of the three accordions.
		for (const gid of [
			"products:prod-1:edit-identity",
			"products:prod-1:edit-price",
			"products:prod-1:edit-shipping",
		]) {
			const inner = findBlocks(groupBlocks(blocks, gid), "context");
			expect(inner.some((c) => /saves on its own/i.test(String(c.text)))).toBe(false);
		}
	});

	test("saving Identity PATCHes ONLY sku + expectedUpdatedAt — every other field is OMITTED, never nulled (verified sparse PATCH)", async () => {
		await bootEdit();
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save-identity",
			values: { sku: "SKU-1-RENAMED" },
			block_id: (await identityBlockId())!,
		});
		const patch = stub!.requests.find((r) => r.method === "PATCH");
		expect(patch).toBeDefined();
		const body = patch!.body as Record<string, unknown>;
		expect(body.sku).toBe("SKU-1-RENAMED");
		expect(body.expectedUpdatedAt).toBe("2026-07-12T01:00:00.000Z");
		expect(Object.keys(body).toSorted()).toEqual(["expectedUpdatedAt", "sku"]);

		async function identityBlockId() {
			const blocks = await openProduct(sandbox!, "prod-1");
			return formFor(blocks, "products:save-identity")?.block_id as string | undefined;
		}
	});

	test("saving Price PATCHes price/compareAt/unitCost + the carrier's fixed currency — never sku/taxClass/dimensions", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const priceForm = formFor(blocks, "products:save-price");
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save-price",
			values: { price: "24.50", compareAt: "", unitCost: "9.00" },
			block_id: priceForm!.block_id as string,
		});
		const patch = stub!.requests.find((r) => r.method === "PATCH");
		expect(patch).toBeDefined();
		const body = patch!.body as Record<string, unknown>;
		// Money reached the wire as INTEGER minor units, never a float.
		expect(body.price).toEqual({ amount: 2450, currency: "USD" });
		expect(body.compareAtPrice).toBeNull(); // blank ⇒ explicit clear
		expect(body.unitCost).toEqual({ amount: 900, currency: "USD" });
		expect("sku" in body).toBe(false);
		expect("taxClass" in body).toBe(false);
		expect("weightGrams" in body).toBe(false);
	});

	test("saving Shipping PATCHes kind/taxClass/dimensions — never sku/price; the 'none' sentinel clears taxClass to null", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const shippingForm = formFor(blocks, "products:save-shipping");
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save-shipping",
			values: {
				productKind: "physical",
				taxClass: "none",
				weightGrams: "400",
				lengthMm: "11",
				widthMm: "21",
				heightMm: "31",
			},
			block_id: shippingForm!.block_id as string,
		});
		const patch = stub!.requests.find((r) => r.method === "PATCH");
		const body = patch!.body as Record<string, unknown>;
		expect(body.taxClass).toBeNull();
		expect(body.weightGrams).toBe(400);
		expect("sku" in body).toBe(false);
		expect("price" in body).toBe(false);

		// The leaf reloaded with a Saved notice.
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save-shipping",
			values: { productKind: "physical" },
			block_id: shippingForm!.block_id as string,
		});
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("Saved");
	});

	test("a concurrent-edit conflict (409 STALE_EDIT) reloads the latest detail with a re-apply warning, never a clobber", async () => {
		await bootEdit();
		// `prod-stale`'s REAL `updatedAt` is the PATCH responder's magic sentinel
		// — since `expectedUpdatedAt` now rides invisibly in the Identity form's
		// own carrier (never a visible field), this is the only way to drive the
		// 409 branch through the actual render/submit round trip.
		const blocks = await openProduct(sandbox!, "prod-stale");
		const identityForm = formFor(blocks, "products:save-identity");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save-identity",
			values: { sku: "SKU-loser" },
			block_id: identityForm!.block_id as string,
		});
		const resultBlocks = blocksOf(outcome);
		const banner = findBlocks(resultBlocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.title)).toMatch(/changed since you opened it/i);
		expect(
			stub!.requests.some((r) => r.method === "GET" && r.url === "/admin/products/prod-stale"),
		).toBe(true);
	});

	test("a malformed price is caught at the plugin boundary — no PATCH is sent", async () => {
		await bootEdit();
		const blocks = await openProduct(sandbox!, "prod-1");
		const priceForm = formFor(blocks, "products:save-price");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:save-price",
			values: { price: "19.999", compareAt: "", unitCost: "" }, // three decimals — rejected
			block_id: priceForm!.block_id as string,
		});
		expect(stub!.requests.some((r) => r.method === "PATCH")).toBe(false);
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("error");
	});
});

// -- restock (DA-4, one-shot) --------------------------------------------------

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
			if (qty === 777) {
				return { status: 409, body: { ok: false, reason: "INSUFFICIENT_STOCK", onHand: 42 } };
			}
			return { status: 200, body: { ok: true, onHand: 42 - qty } };
		}
		return { status: 404, body: { ok: false, reason: "PRODUCT_NOT_FOUND" } };
	};
}

describe("admin Products console — restock (DA-4, workerd sandbox)", () => {
	async function bootStock(): Promise<LiveState> {
		const state = freshState();
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(state));
		stub.respondWith("POST", makeStockResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedBothTokens(sandbox, stub);
		return state;
	}

	test("the Add stock group is a plain one-shot form — no danger, no confirm, no nonce, no visible productId carrier", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const restockGroup = group(blocks, "products:prod-1:restock");
		expect(restockGroup).toBeDefined();
		expect(restockGroup?.default_open).not.toBe(true);
		const restockForm = formFor(groupBlocks(blocks, "products:prod-1:restock"), "products:restock");
		expect(fieldIds(restockForm)).toEqual(["qty"]);
		expect(field(restockForm, "qty")?.type).toBe("text_input");
		expect(field(restockForm, "nonce")).toBeUndefined();
		expect(field(restockForm, "productId")).toBeUndefined();
		const buttons = findBlocks(groupBlocks(blocks, "products:prod-1:restock"), "actions");
		expect(buttons).toHaveLength(0);
	});

	test("restock POSTs {qty} with BOTH tokens + a content-derived Idempotency-Key (no nonce), then reloads with a 'Stock added' notice", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const restockForm = formFor(blocks, "products:restock");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:restock",
			values: { qty: "8" },
			block_id: restockForm!.block_id as string,
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/products/prod-1/restock");
		expect(post!.headers["x-internal-token"]).toBe("admin-token-xyz");
		expect(post!.headers["x-service-token"]).toBe("svc-token-abc");
		const key = post!.headers["idempotency-key"] as string;
		expect(key).toBe("prod-1:restock:42:8"); // F-2a: productId:direction:onHandAtRender:qty
		expect((post!.body as Record<string, unknown>).qty).toBe(8);
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("Stock added");
	});

	test("a non-numeric qty is caught at the plugin boundary — no POST is sent", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const restockForm = formFor(blocks, "products:restock");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:restock",
			values: { qty: "-4" },
			block_id: restockForm!.block_id as string,
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("error");
	});

	test("a double-submit of the SAME rendered form dedupes to ONE movement (same onHand+qty ⇒ same key); a fresh reload's different onHand applies a second, DELIBERATE restock", async () => {
		let onHand = 42;
		const seen = new Map<string, number>();
		const state = freshState();
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(state));
		stub.respondWith("POST", (req: RecordedRequest): { status: number; body: unknown } => {
			if (req.headers["x-internal-token"] === undefined) {
				return { status: 401, body: { ok: false, error: "unauthorized" } };
			}
			const key = req.headers["idempotency-key"] as string;
			const recorded = seen.get(key);
			if (recorded !== undefined) return { status: 200, body: { ok: true, onHand: recorded } };
			onHand += (req.body as { qty?: number } | undefined)?.qty ?? 0;
			state.onHand1 = onHand;
			seen.set(key, onHand);
			return { status: 200, body: { ok: true, onHand } };
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedToken(sandbox, stub, "admin-token-xyz");

		const blocks = await openProduct(sandbox, "prod-1");
		const restockForm = formFor(blocks, "products:restock");
		const submit = () =>
			sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "products:restock",
				values: { qty: "8" },
				block_id: restockForm!.block_id as string,
			});
		await submit();
		const replay = await submit(); // SAME rendered form ⇒ same onHand ⇒ same key ⇒ dedupes

		const posts = stub.requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(2);
		expect(posts[0]!.headers["idempotency-key"]).toBe(posts[1]!.headers["idempotency-key"]);
		expect(onHand).toBe(50);
		const replayBanner = findBlock(blocksOf(replay), "banner");
		expect(String(replayBanner?.description)).toContain("50");

		// A FRESH render reads the NEW on-hand (50), so its carrier differs ⇒ a
		// different key ⇒ a second DELIBERATE restock applies.
		const blocks2 = await openProduct(sandbox, "prod-1");
		const restockForm2 = formFor(blocks2, "products:restock");
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:restock",
			values: { qty: "8" },
			block_id: restockForm2!.block_id as string,
		});
		const allPosts = stub.requests.filter((r) => r.method === "POST");
		expect(allPosts[2]!.headers["idempotency-key"]).not.toBe(posts[0]!.headers["idempotency-key"]);
		expect(onHand).toBe(58);
	});
});

// -- remove stock (the screen's ONE DA-3 stage/confirm/refuse flow) ----------

describe("admin Products console — remove stock (DA-3/DA-5, workerd sandbox)", () => {
	async function bootStock(): Promise<LiveState> {
		const state = freshState();
		stub = await startStubCommerceServer();
		stub.respondWith("GET", makeGetResponder(state));
		stub.respondWith("POST", makeStockResponder());
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});
		await seedBothTokens(sandbox, stub);
		return state;
	}

	test("D-6a: the group's label carries the CONSEQUENCE, not a bare verb (X-35) — the §12.1 listing's bare 'Remove stock' is a reported defect", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const removeGroup = group(blocks, "products:prod-1:remove");
		expect(removeGroup).toBeDefined();
		expect(String(removeGroup?.label)).toMatch(/permanent|cannot be undone/i);
		expect(removeGroup?.default_open).not.toBe(true);
	});

	test("idle body: alert banner + context + the collect form (submit → -review), no danger button yet", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const body = groupBlocks(blocks, "products:prod-1:remove");
		expect(findBlocks(body, "banner")[0]?.variant).toBe("alert");
		expect(findBlocks(body, "context").length).toBeGreaterThan(0);
		const collectForm = formFor(body, "products:remove-stock-review");
		expect(collectForm).toBeDefined();
		expect(fieldIds(collectForm)).toEqual(["qty"]);
		expect(findBlocks(body, "actions")).toHaveLength(0);
	});

	test("-review with a valid qty stages state 2: accordion changes id to :review, forced open, ONE danger confirm carrying {productId, qty, onHand}", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const collectForm = formFor(blocks, "products:remove-stock-review");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "5" },
			block_id: collectForm!.block_id as string,
		});
		const staged = blocksOf(outcome);
		assertBlockContract(staged, { screen: "products", level: "detail" });

		expect(group(staged, "products:prod-1:remove")).toBeUndefined(); // idle id gone
		const reviewGroup = group(staged, "products:prod-1:remove:review");
		expect(reviewGroup).toBeDefined();
		expect(reviewGroup?.default_open).toBe(true);
		// X-18: at most one open group — and D-5 Rule 1 means Identity is FALSE.
		expect(openGroupIds(staged)).toEqual(["products:prod-1:remove:review"]);

		const body = reviewGroup!.blocks as LooseBlock[];
		const confirmButtons = findBlocks(body, "actions").flatMap(
			(a) => (a.elements as Array<Record<string, unknown>>) ?? [],
		);
		expect(confirmButtons).toHaveLength(1);
		const btn = confirmButtons[0]!;
		expect(btn.style).toBe("danger");
		expect(confirmOf(btn).style).toBe("danger");
		expect(valueOf(btn)).toEqual({ productId: "prod-1", qty: "5", onHand: "42" });

		// The "Add stock" group is UNCHANGED and unaffected.
		expect(group(staged, "products:prod-1:restock")?.default_open).not.toBe(true);
	});

	test("a refusal (bad parse) re-renders STATE 1 flattened into a :refused id, forced open, prefilled with the RAW typed string, no confirm", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const collectForm = formFor(blocks, "products:remove-stock-review");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "abc" },
			block_id: collectForm!.block_id as string,
		});
		const refused = blocksOf(outcome);
		assertBlockContract(refused, { screen: "products", level: "detail" });

		expect(group(refused, "products:prod-1:remove")).toBeUndefined();
		expect(group(refused, "products:prod-1:remove:review")).toBeUndefined();
		const refusedGroup = group(refused, "products:prod-1:remove:refused");
		expect(refusedGroup).toBeDefined();
		expect(refusedGroup?.default_open).toBe(true);
		expect(openGroupIds(refused)).toEqual(["products:prod-1:remove:refused"]);

		const body = refusedGroup!.blocks as LooseBlock[];
		expect(findBlocks(body, "accordion")).toHaveLength(0); // FLATTENED — no nested collect group
		expect(findBlocks(body, "actions")).toHaveLength(0); // NO confirm control (DA-3a-i)
		const form = formFor(body, "products:remove-stock-review");
		expect(field(form, "qty")?.initial_value).toBe("abc"); // the RAW typed string, verbatim

		// The unrelated "Add stock" group stays exactly as it is.
		expect(group(refused, "products:prod-1:restock")).toBeDefined();
	});

	test("DA-3c: qty greater than the LIVE on-hand refuses, naming the real ceiling — the bound check runs against a freshly re-read figure", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const collectForm = formFor(blocks, "products:remove-stock-review");
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "50" }, // > 42 on hand
			block_id: collectForm!.block_id as string,
		});
		const refused = blocksOf(outcome);
		const refusedGroup = group(refused, "products:prod-1:remove:refused");
		expect(refusedGroup?.default_open).toBe(true);
		const body = refusedGroup!.blocks as LooseBlock[];
		const banner = findBlocks(refused, "banner").find((b) => b.variant === "error");
		expect(String(banner?.description)).toContain("42");
		const form = formFor(body, "products:remove-stock-review");
		expect(field(form, "qty")?.initial_value).toBe("50");
	});

	test("DA-3a-iv: an ABSENT onHand watermark refuses outright — never folded into the qty-parse-failure branch", async () => {
		await bootStock();
		// A hand-crafted submit whose block_id carries no carrier at all (a
		// hostile or stale client) — the screen must not skip the compare.
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "5" },
			block_id: "products:remove-stock-review",
		});
		const blocks = blocksOf(outcome);
		// productId itself is unreadable here too (no carrier at all) — the
		// screen bounces to the list with the DA-3b UNREADABLE notice rather
		// than silently redirecting.
		const banner = findBlocks(blocks, "banner").find((b) => b.variant === "error");
		expect(banner).toBeDefined();
		expect(String(banner?.description)).toMatch(/could not be read/i);
	});

	test("DA-3a: stock changed since the group was rendered (a concurrent removal) refuses the -review step, naming the new figure", async () => {
		const state = await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1"); // onHand observed = 42
		const collectForm = formFor(blocks, "products:remove-stock-review");
		state.onHand1 = 30; // someone else removed 12 units in the meantime
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "10" }, // valid against the (stale) 42, and against 30
			block_id: collectForm!.block_id as string,
		});
		const refused = blocksOf(outcome);
		const refusedGroup = group(refused, "products:prod-1:remove:refused");
		expect(refusedGroup?.default_open).toBe(true);
		const banner = findBlocks(refused, "banner").find((b) => b.variant === "error");
		expect(String(banner?.title)).toMatch(/stock changed/i);
		expect(String(banner?.description)).toContain("30");
	});

	test("confirming the staged removal POSTs the derived key, then reloads with a 'Stock removed' notice", async () => {
		await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const collectForm = formFor(blocks, "products:remove-stock-review");
		const staged = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "5" },
			block_id: collectForm!.block_id as string,
		});
		const reviewGroup = group(blocksOf(staged), "products:prod-1:remove:review");
		const confirmBtn = findBlocks(reviewGroup!.blocks as LooseBlock[], "actions").flatMap(
			(a) => (a.elements as Array<Record<string, unknown>>) ?? [],
		)[0]!;

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:remove-stock",
			value: valueOf(confirmBtn),
		});
		const post = stub!.requests.find((r) => r.method === "POST");
		expect(post).toBeDefined();
		expect(post!.url).toBe("/admin/products/prod-1/remove-stock");
		expect(post!.headers["idempotency-key"]).toBe("prod-1:removal:42:5");
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("Stock removed");
	});

	test("DA-3a at the CONFIRM step: stock changed between staging and clicking confirm refuses — nothing is POSTed", async () => {
		const state = await bootStock();
		const blocks = await openProduct(sandbox!, "prod-1");
		const collectForm = formFor(blocks, "products:remove-stock-review");
		const staged = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "products:remove-stock-review",
			values: { qty: "5" },
			block_id: collectForm!.block_id as string,
		});
		const reviewGroup = group(blocksOf(staged), "products:prod-1:remove:review");
		const confirmBtn = findBlocks(reviewGroup!.blocks as LooseBlock[], "actions").flatMap(
			(a) => (a.elements as Array<Record<string, unknown>>) ?? [],
		)[0]!;

		state.onHand1 = 20; // moved between staging and the confirm click
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:remove-stock",
			value: valueOf(confirmBtn),
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/stock changed/i);
	});

	test("the service's own guarded decrement (a race the plugin's re-read cannot always catch) still surfaces a clean notice, never a negative", async () => {
		const state = await bootStock();
		state.onHand1 = 1000; // let the plugin's own bound check pass
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "products:remove-stock",
			value: { productId: "prod-1", qty: "777", onHand: "1000" },
		});
		// The stub's magic qty (777) triggers the SERVICE's own 409 regardless.
		const banner = findBlock(blocksOf(outcome), "banner");
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/not enough stock/i);
	});
});
