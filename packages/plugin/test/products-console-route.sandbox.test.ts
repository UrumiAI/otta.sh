/**
 * The React console's Pricing & inventory data path, exercised INSIDE the
 * workerd sandbox (INC-21).
 *
 * WHY A SANDBOX SUITE AND NOT A UNIT TEST. ADR-0006 Decision 1 is the reason and
 * ADR-0014 reaffirms it verbatim: the workerd suites are the contract gate for
 * `@otta-sh/plugin`, and "a change that only works trusted is still broken".
 * This increment adds a branch to the plugin's single admin route, so that
 * branch is proven in the isolate the plugin is specified to run in — bundled
 * from a bare copy of `src/`, with no Node, no workspace resolution and no
 * `fetch` but the injected one.
 *
 * IT COVERS THE TWO THINGS THIS SCREEN'S CONSOLE BRANCH DOES THAT ORDERS' DOES
 * NOT:
 *
 *  1. **Minting the carrier.** Four of five writes are Block Kit FORM submits,
 *     whose context rides in a `block_id` carrier a browser cannot produce. The
 *     tests below drive a save and a restock end to end and assert the SERVICE
 *     saw the right request — which is only possible if the carrier round-tripped
 *     through `decodeCarrier` into the handler that reads it.
 *  2. **Withholding the `total` under a page-scoped narrowing.** "Low stock
 *     only" narrows the fetched page, so the service's exact count describes a
 *     different set of rows and must not reach the caption above them.
 *
 * WHAT IT DOES NOT COVER, deliberately: the React components. Those are gated by
 * Playwright (`sites/staging/e2e/products-console.spec.ts`), which is additive
 * to this tier and replaces none of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	LOW_STOCK_FILTER_DESCRIPTION,
	PRODUCTS_EMPTY,
	PRODUCTS_LIST_INTRO,
	PRODUCTS_LOW_STOCK_NO_MATCH,
	REMOVE_STOCK_BANNER,
	SPLIT_DISCARD_CONTEXT,
	STOCK_ON_HAND_CONTEXT,
	onHandCell,
	removeStockConfirm,
	statusLabel,
} from "@otta-sh/admin-presentation";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

const READ = "otta_console_read";
const ACT = "otta_console_act";

const PRODUCT_ID = "prod-1";

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		productId: PRODUCT_ID,
		sku: "APR-LIN-NAT",
		title: "Washed Linen Apron",
		priceCents: 1999,
		currency: "USD",
		productKind: "physical",
		active: true,
		deletedAt: null,
		onHand: 42,
		createdAt: "2026-07-12T00:00:00.000Z",
		...overrides,
	};
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		productId: PRODUCT_ID,
		sku: "APR-LIN-NAT",
		title: "Washed Linen Apron",
		priceCents: 1999,
		currency: "USD",
		taxClass: "standard",
		compareAtCents: null,
		compareAtCurrency: null,
		unitCostCents: 850,
		unitCostCurrency: "USD",
		inventoryPolicy: "deny",
		weightGrams: 320,
		lengthMm: null,
		widthMm: null,
		heightMm: null,
		productKind: "physical",
		active: true,
		deletedAt: null,
		onHand: 42,
		createdAt: "2026-07-12T00:00:00.000Z",
		updatedAt: "2026-07-20T09:00:00.000Z",
		...overrides,
	};
}

/** The stub keys ONE responder per HTTP method, so routing is a function of the
 *  url — the same shape the other console suite uses. Each test declares the
 *  routes it cares about and everything else 404s, which is itself part of the
 *  assertion: a surface this branch is not supposed to call shows up as a
 *  degradation rather than passing silently. */
type Routes = Record<string, () => { status: number; body: unknown }>;

function responder(routes: Routes) {
	return (request: { url: string }) => {
		const path = request.url.split("?")[0] ?? "";
		const route = routes[path];
		return route ? route() : { status: 404, body: { error: "no route" } };
	};
}

const LIST_ROUTE = "/admin/products";
const DETAIL_ROUTE = `/admin/products/${PRODUCT_ID}`;
const SETTINGS_ROUTE = "/settings";
const TAX_CLASSES_ROUTE = "/admin/tax/classes";

function settingsBody(lowStockThreshold: number): { status: number; body: unknown } {
	return { status: 200, body: { settings: { lowStockThreshold } } };
}

describe("the console's Pricing & inventory branch on the otta admin route", () => {
	let service: StubCommerceServer;
	let sandbox: SandboxHandle;

	beforeEach(async () => {
		service = await startStubCommerceServer();
		sandbox = await loadPluginInSandbox({
			allowedHosts: [service.host],
			commerceServiceBaseUrl: service.baseUrl,
		});
	});

	afterEach(async () => {
		await sandbox.close();
		await service.close();
	});

	async function invoke(input: unknown): Promise<Record<string, unknown>> {
		const outcome = await sandbox.invokeRoute("admin", input);
		expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
		return (outcome as { result: Record<string, unknown> }).result;
	}

	test("products.list returns RAW minor units and a RAW on-hand count", async () => {
		// THE WHOLE REASON THIS BRANCH EXISTS. A Block Kit row carries "$19.99"
		// (money already spent, G1) and "42" or "3 · Low" (a band already decided).
		// A React tier fed those strings could format neither and re-band nothing.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary()], nextCursor: null, total: 137 },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);

		const result = await invoke({ type: READ, resource: "products.list" });
		expect(result["ok"]).toBe(true);
		const products = result["products"] as Array<Record<string, unknown>>;
		expect(products).toHaveLength(1);
		expect(products[0]?.["priceCents"]).toBe(1999);
		expect(products[0]?.["currency"]).toBe("USD");
		expect(products[0]?.["onHand"]).toBe(42);
		expect(JSON.stringify(result)).not.toContain("$19.99");
		expect(JSON.stringify(result)).not.toContain("42 · ");
	});

	test("the low-stock THRESHOLD travels with the page, because a row cannot carry it", async () => {
		// What counts as `Low` is a SETTINGS value, not a product field — this is
		// the one screen that reads two service surfaces, and the React tier needs
		// the second one to render the same cell the Block Kit table renders.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({ status: 200, body: { products: [summary()], nextCursor: null } }),
				[SETTINGS_ROUTE]: () => settingsBody(50),
			}),
		);
		const result = await invoke({ type: READ, resource: "products.list" });
		const stock = result["stock"] as Record<string, unknown>;
		expect(stock["threshold"]).toBe(50);
		// ...and the shared cell function turns the two into the same string both
		// screens render. 42 ≤ 50, so this one is Low.
		expect(onHandCell(42, 50)).toBe("42 · Low");
	});

	test("a settings read that FAILS costs the Low band and nothing else (E-1)", async () => {
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({ status: 200, body: { products: [summary()], nextCursor: null } }),
				// no /settings route ⇒ 404
			}),
		);
		const result = await invoke({ type: READ, resource: "products.list" });
		expect(result["ok"]).toBe(true);
		expect((result["products"] as unknown[]).length).toBe(1);
		expect((result["stock"] as Record<string, unknown>)["threshold"]).toBeNull();
	});

	test("`null` on-hand is NOT zero, and a missing key is NOT null", async () => {
		// Three cases that must never be folded together: a known count, a sku with
		// no inventory record, and a response that carried no stock figure at all.
		const { onHand: _drop, ...noStockKey } = summary({ productId: "prod-3" });
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: {
						products: [
							summary({ productId: "prod-1", onHand: 0 }),
							summary({ productId: "prod-2", onHand: null }),
							noStockKey,
						],
						nextCursor: null,
					},
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const result = await invoke({ type: READ, resource: "products.list" });
		const products = result["products"] as Array<Record<string, unknown>>;
		expect(products[0]?.["onHand"]).toBe(0);
		expect(products[1]?.["onHand"]).toBeNull();
		// Not invented as 0, and not invented as null either — the key is simply
		// forwarded as it arrived, and `onHandCell` renders all three as text.
		expect(products[2]?.["onHand"]).toBeUndefined();
		expect(onHandCell(0, 5)).toBe("0 · Out of stock");
		expect(onHandCell(null, 5)).toBe("—");
		expect(onHandCell(undefined, 5)).toBe("—");
	});

	test("the exact `total` is FORWARDED when it describes the rows", async () => {
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary()], nextCursor: "cur-2", total: 137 },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const result = await invoke({ type: READ, resource: "products.list" });
		expect(result["total"]).toBe(137);
	});

	test("the `total` is WITHHELD while `Low stock only` narrows the page (INC-23's contract)", async () => {
		// THE ONE THAT MATTERS. The service counted the UNNARROWED set, so passing
		// its total would caption one row with "137 products". Both surfaces make
		// this call in `applyLowStockNarrowing`; this proves the React tier's
		// payload honours it.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: {
						products: [summary({ productId: "low", onHand: 2 }), summary({ onHand: 42 })],
						nextCursor: "cur-2",
						total: 137,
					},
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { lowStock: true },
		});
		expect(result).not.toHaveProperty("total");
		// ...and the page really is narrowed: only the row at or below 5 survives.
		expect(
			(result["products"] as Array<Record<string, unknown>>).map((p) => p["productId"]),
		).toEqual(["low"]);
		// `Load more` still has somewhere to go — the filter narrowed a PAGE.
		expect(result["nextCursor"]).toBe("cur-2");
	});

	test("a low-stock request that CANNOT be honoured leaves the page unfiltered and says so", async () => {
		// No threshold ⇒ nothing to compare against. The page is UNFILTERED and the
		// screen must say so rather than silently showing the wrong set of rows —
		// and the total is legitimate again, because nothing was narrowed.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary(), summary({ productId: "b" })], nextCursor: null, total: 2 },
				}),
			}),
		);
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { lowStock: true },
		});
		expect((result["products"] as unknown[]).length).toBe(2);
		expect((result["stock"] as Record<string, unknown>)["filterUnavailable"]).toBe(true);
		expect(result["total"]).toBe(2);
	});

	test("stock that came back unreadable on EVERY row raises the degradation, not a partial page", async () => {
		// ALL-OR-NOTHING: the service fills the column from one left join, so a
		// PARTIAL page is a catalog fact (some skus have no inventory row) and must
		// not raise the banner.
		const { onHand: _a, ...noStock1 } = summary({ productId: "a" });
		const { onHand: _b, ...noStock2 } = summary({ productId: "b" });
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [noStock1, noStock2], nextCursor: null },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const unreadable = await invoke({ type: READ, resource: "products.list" });
		expect((unreadable["stock"] as Record<string, unknown>)["unreadable"]).toBe(true);

		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: {
						products: [noStock1, summary({ productId: "c", onHand: null })],
						nextCursor: null,
					},
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const partial = await invoke({ type: READ, resource: "products.list" });
		expect((partial["stock"] as Record<string, unknown>)["unreadable"]).toBe(false);
	});

	test("the filter is translated through the SAME mapping the Block Kit form uses", async () => {
		service.respondWith("GET", () => ({ status: 200, body: { products: [], nextCursor: null } }));
		await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "archived", productKind: "digital", search: "APR" },
		});
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		// `archived` asserts `deleted=true` ALONE — never both axes, whatever a
		// hand-crafted request smuggles in.
		expect(seen).toContain("deleted=true");
		expect(seen).not.toContain("active=");
		expect(seen).toContain("productKind=digital");
		expect(seen).toContain("search=APR");
	});

	test("the filter vocabulary is the Block Kit screen's own", async () => {
		service.respondWith("GET", () => ({ status: 200, body: { products: [], nextCursor: null } }));
		const result = await invoke({ type: READ, resource: "products.list" });
		const vocabulary = result["vocabulary"] as Record<string, unknown>;
		expect((vocabulary["statuses"] as Array<{ label: string }>).map((s) => s.label)).toEqual([
			"All statuses (live)",
			"Active",
			"Inactive",
			"Archived (deleted)",
		]);
		expect((vocabulary["kinds"] as Array<{ label: string }>).map((k) => k.label)).toEqual([
			"All kinds",
			"physical",
			"digital",
		]);
		// A real word, never `""` — a sentinel has to read acceptably as a value.
		expect(vocabulary["any"]).toBe("any");
		expect(vocabulary["pageLimit"]).toBe(25);
	});

	test("products.detail carries the record, the tax registry and the threshold", async () => {
		service.respondWith(
			"GET",
			responder({
				[DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }),
				[TAX_CLASSES_ROUTE]: () => ({
					status: 200,
					body: { classes: [{ id: "standard", name: "Standard" }] },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(50),
			}),
		);
		const result = await invoke({ type: READ, resource: "products.detail", productId: PRODUCT_ID });
		expect(result["ok"]).toBe(true);
		expect((result["product"] as Record<string, unknown>)["sku"]).toBe("APR-LIN-NAT");
		// The wire carries the WATERMARK the save has to send back.
		expect((result["product"] as Record<string, unknown>)["updatedAt"]).toBe(
			"2026-07-20T09:00:00.000Z",
		);
		expect(result["taxClasses"]).toEqual([{ id: "standard", name: "Standard" }]);
		expect(result["threshold"]).toBe(50);
	});

	test("a tax-registry read that fails degrades to the static defaults, never to a failed screen", async () => {
		service.respondWith(
			"GET",
			responder({ [DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }) }),
		);
		const result = await invoke({ type: READ, resource: "products.detail", productId: PRODUCT_ID });
		expect(result["ok"]).toBe(true);
		expect((result["taxClasses"] as Array<{ id: string }>).map((c) => c.id)).toContain("standard");
	});

	test("an unknown product is a refusal with copy, at HTTP 200 (G5)", async () => {
		service.respondWith("GET", () => ({ status: 404, body: {} }));
		const result = await invoke({ type: READ, resource: "products.detail", productId: "nope" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Product not found");
		expect(String(result["description"]).length).toBeGreaterThan(0);
	});

	test("an unreachable service fails CLOSED with the screen's own copy", async () => {
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await invoke({ type: READ, resource: "products.list" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Pricing & inventory is unavailable");
		// E-7: it must not assert a cause it does not know.
		expect(String(result["description"])).toContain("a fault in the console itself");
	});

	test("an unrecognised products resource is a refusal, not a blank body", async () => {
		const result = await invoke({ type: READ, resource: "products.nope" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("That request could not be read");
	});

	// ── writes ────────────────────────────────────────────────────────────────

	test("a SAVE is forwarded as the form submit the Block Kit handler reads, carrier and all", async () => {
		// THE INCREMENT'S ONE GENUINELY NEW MECHANISM. `productId` and
		// `expectedUpdatedAt` ride in a `block_id` carrier a browser cannot mint;
		// this proves the plugin mints it and the handler decodes it, because
		// otherwise the PATCH below never happens at all.
		service.respondWith(
			"GET",
			responder({ [DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }) }),
		);
		service.respondWith("PATCH", () => ({ status: 200, body: { ok: true } }));

		const result = await invoke({
			type: ACT,
			action_id: "products:save-identity",
			value: {
				productId: PRODUCT_ID,
				expectedUpdatedAt: "2026-07-20T09:00:00.000Z",
				sku: "APR-LIN-NAT-2",
			},
		});
		expect(result["ok"]).toBe(true);

		const patch = service.requests.find((r) => r.method === "PATCH");
		expect(patch, "the save never reached the service").toBeDefined();
		expect(patch?.url).toContain(`/admin/products/${PRODUCT_ID}`);
		const body = (patch?.body ?? {}) as Record<string, unknown>;
		expect(body["sku"]).toBe("APR-LIN-NAT-2");
		// THE WATERMARK SURVIVED THE ROUND TRIP. Without the carrier it would be
		// absent, and the handler would have refused before writing.
		expect(body["expectedUpdatedAt"]).toBe("2026-07-20T09:00:00.000Z");
		// G2 / ADR-0013: `title` and `active` are CMS-owned. The wire cannot carry
		// either, so a console that sent them changes nothing.
		expect(body).not.toHaveProperty("title");
		expect(body).not.toHaveProperty("active");
	});

	test("a save with a STALE watermark is refused by the Block Kit handler, and its copy comes back", async () => {
		service.respondWith(
			"GET",
			responder({ [DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }) }),
		);
		service.respondWith("PATCH", () => ({
			status: 409,
			body: { reason: "STALE_EDIT", currentUpdatedAt: "2026-07-30T00:00:00.000Z" },
		}));

		const result = await invoke({
			type: ACT,
			action_id: "products:save-price",
			value: {
				productId: PRODUCT_ID,
				expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
				price: "24.99",
				currency: "USD",
				compareAt: "",
				unitCost: "",
			},
		});
		expect(result["ok"]).toBe(true);
		const notice = result["notice"] as Record<string, unknown>;
		expect(notice["variant"]).toBe("error");
		expect(notice["title"]).toBe("This product changed since you opened it");
	});

	test("a console save NEVER smuggles a title or an active flag into the wire (G2)", async () => {
		service.respondWith(
			"GET",
			responder({ [DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }) }),
		);
		service.respondWith("PATCH", () => ({ status: 200, body: { ok: true } }));
		await invoke({
			type: ACT,
			action_id: "products:save-identity",
			value: {
				productId: PRODUCT_ID,
				expectedUpdatedAt: "2026-07-20T09:00:00.000Z",
				sku: "S-1",
				// A hostile or buggy console sending the two CMS-owned fields.
				title: "Renamed by the admin",
				active: "false",
			},
		});
		const body = (service.requests.find((r) => r.method === "PATCH")?.body ?? {}) as Record<
			string,
			unknown
		>;
		expect(body).not.toHaveProperty("title");
		expect(body).not.toHaveProperty("active");
		expect(JSON.stringify(body)).not.toContain("Renamed by the admin");
	});

	test("a RESTOCK reaches the service with the derived idempotency key, not a nonce", async () => {
		service.respondWith(
			"GET",
			responder({ [DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }) }),
		);
		service.respondWith("POST", () => ({ status: 200, body: { ok: true, onHand: 54 } }));

		const result = await invoke({
			type: ACT,
			action_id: "products:restock",
			value: { productId: PRODUCT_ID, onHand: "42", qty: "12" },
		});
		expect(result["ok"]).toBe(true);
		const post = service.requests.find((r) => r.method === "POST");
		expect(post?.url).toContain(`/admin/products/${PRODUCT_ID}/restock`);
		// F-2a: `${productId}:${direction}:${onHandAtRender}:${qty}` — content plus
		// the watermark the operator saw. No nonce anywhere on this screen.
		expect(post?.headers["idempotency-key"]).toBe(`${PRODUCT_ID}:restock:42:12`);
	});

	test("a REMOVAL is re-checked against live stock before anything moves (DA-3a)", async () => {
		// The operator saw 42; the live product is at 40. Nothing may be removed,
		// and the refusal is the Block Kit handler's own.
		service.respondWith(
			"GET",
			responder({
				[DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail({ onHand: 40 }) } }),
			}),
		);
		service.respondWith("POST", () => ({ status: 200, body: { ok: true, onHand: 37 } }));

		const result = await invoke({
			type: ACT,
			action_id: "products:remove-stock",
			value: { productId: PRODUCT_ID, qty: "3", onHand: "42" },
		});
		expect(result["ok"]).toBe(true);
		const notice = result["notice"] as Record<string, unknown>;
		expect(notice["variant"]).toBe("error");
		expect(notice["title"]).toBe("Stock changed — nothing was removed");
		expect(service.requests.some((r) => r.method === "POST")).toBe(false);
	});

	test("a REMOVAL whose watermark still holds is applied under the derived key", async () => {
		service.respondWith(
			"GET",
			responder({ [DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }) }),
		);
		service.respondWith("POST", () => ({ status: 200, body: { ok: true, onHand: 39 } }));

		const result = await invoke({
			type: ACT,
			action_id: "products:remove-stock",
			value: { productId: PRODUCT_ID, qty: "3", onHand: "42" },
		});
		expect(result["ok"]).toBe(true);
		const post = service.requests.find((r) => r.method === "POST");
		expect(post?.url).toContain(`/admin/products/${PRODUCT_ID}/remove-stock`);
		expect(post?.headers["idempotency-key"]).toBe(`${PRODUCT_ID}:removal:42:3`);
	});

	test("an UNKNOWN action id is a refusal, not a quiet success", async () => {
		const result = await invoke({
			type: ACT,
			action_id: "products:no-such-action",
			value: { productId: PRODUCT_ID },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
		expect(String(result["description"])).toContain("Nothing was applied");
	});

	test("the STAGED review step is not offered to the console at all", async () => {
		// `products:remove-stock-review` is a registered Block Kit action, and the
		// React screen has no staged step to render into — it shows the confirm
		// dialog directly. Asking for it is asking for something that screen does
		// not offer, and must not silently stage anything.
		const result = await invoke({
			type: ACT,
			action_id: "products:remove-stock-review",
			value: { productId: PRODUCT_ID, onHand: "42", qty: "3" },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
	});

	test("a registered id that renders nothing is also a refusal", async () => {
		// Every read fails, so the Block Kit action bails to a shape with no blocks.
		// "Nothing came back" is not "nothing to say".
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		service.respondWith("PATCH", () => ({ status: 500, body: {} }));
		const result = await invoke({
			type: ACT,
			action_id: "products:save-identity",
			value: { productId: PRODUCT_ID, expectedUpdatedAt: "2026-07-20T09:00:00.000Z", sku: "X" },
		});
		const quietSuccess = result["ok"] === true && result["notice"] === null;
		expect(quietSuccess, "a failed write reported as a quiet success").toBe(false);
	});

	// ── cross-surface pins ────────────────────────────────────────────────────

	test("BOTH SCREENS SAY THE SAME WORDS — the Block Kit render reads the shared copy", async () => {
		// The React screen imports these constants; this asserts the BLOCK KIT
		// screen renders them. Change either side's wording without changing the
		// constant and this fails — the property a pair of hand-copied strings
		// could never have.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({ status: 200, body: { products: [], nextCursor: null } }),
			}),
		);
		const result = await invoke({ type: "page_load", page: "/products" });
		const text = JSON.stringify(result["blocks"]);

		expect(text).toContain(PRODUCTS_LIST_INTRO);
		expect(text).toContain(PRODUCTS_EMPTY.title);
		expect(text).toContain(PRODUCTS_EMPTY.description);
		expect(text).toContain(LOW_STOCK_FILTER_DESCRIPTION);
	});

	test("...and the same page-scoped wording when `Low stock only` narrows a page to nothing", async () => {
		// Outcome 3 on the Block Kit side: a `context` scan note rather than an
		// empty state, so `Load more` survives. The React screen renders the same
		// sentence for the same reason.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary({ onHand: 99 })], nextCursor: "cur-2" },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const result = await invoke({
			type: "form_submit",
			action_id: "products:apply-filter",
			values: { lowStock: true },
		});
		const blocks = result["blocks"] as Array<Record<string, unknown>>;
		const text = JSON.stringify(blocks);
		expect(text).toContain(PRODUCTS_LOW_STOCK_NO_MATCH.scanNote);
		expect(blocks.some((block) => block["type"] === "empty")).toBe(false);
	});

	test("...and the same detail vocabulary, including the remove-stock confirm", async () => {
		service.respondWith(
			"GET",
			responder({
				[DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }),
				[SETTINGS_ROUTE]: () => settingsBody(50),
			}),
		);
		const detailResult = await invoke({
			type: "form_submit",
			action_id: "products:open",
			values: { productId: PRODUCT_ID },
		});
		const text = JSON.stringify(detailResult["blocks"]);
		expect(text).toContain(SPLIT_DISCARD_CONTEXT);
		expect(text).toContain(STOCK_ON_HAND_CONTEXT);
		expect(text).toContain(REMOVE_STOCK_BANNER.title);
		// The status word in the identity strip is the shared function's.
		expect(text).toContain(
			statusLabel({
				active: true,
				deletedAt: null,
				sku: "APR-LIN-NAT",
				priceCents: 1999,
				currency: "USD",
			}),
		);
		// Both surfaces compose the confirm from ONE function, so the sentence an
		// operator reads before stock moves cannot differ between them.
		expect(removeStockConfirm(1).text).toContain("Remove 1 unit from stock?");
		expect(removeStockConfirm(3).text).toContain("Remove 3 units from stock?");
	});

	test("the BLOCK KIT screen is untouched by any of this", async () => {
		// ADR-0014 Decision 1: both screens render until the replacement is proven.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({ status: 200, body: { products: [summary()], nextCursor: null } }),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const result = await invoke({ type: "page_load", page: "/products" });
		const blocks = result["blocks"] as Array<Record<string, unknown>>;
		expect(blocks[0]).toMatchObject({ type: "header", text: "Pricing & inventory" });
		expect(blocks.some((block) => block["type"] === "table")).toBe(true);
		expect(result["vocabulary"]).toBeUndefined();
		expect(result["ok"]).toBeUndefined();
	});

	test("an ORDERS console request is still routed to the Orders branch", async () => {
		// The dispatcher picks a console screen by `resource` prefix and by action
		// namespace. A products branch that swallowed an orders read would be
		// invisible until an operator opened the other screen.
		service.respondWith(
			"GET",
			responder({
				"/admin/orders": () => ({ status: 200, body: { orders: [], nextCursor: null } }),
			}),
		);
		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result["ok"]).toBe(true);
		expect(result).toHaveProperty("orders");
		expect(result).not.toHaveProperty("products");
	});
});
