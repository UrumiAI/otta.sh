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
 *  2. **Resolving the threshold into a server-side predicate, and captioning
 *     it correctly.** "Low stock only" carries the store's threshold on the
 *     outgoing request now, and the service's exact count is of the SAME set
 *     the page is drawn from — so the total is forwarded whenever the
 *     predicate ran, and withheld only on the one case where it could not
 *     (`stock.filterUnavailable`).
 *
 * WHAT IT DOES NOT COVER, deliberately: the React components. Those are gated by
 * Playwright (`sites/staging/e2e/products-console.spec.ts`), which is additive
 * to this tier and replaces none of it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { onHandCell } from "@otta-sh/admin-presentation";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

const READ = "otta_console_read";
const ACT = "otta_console_act";

const PRODUCT_ID = "prod-1";
const ADMIN_TOKEN = "admin-token-xyz";

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

/** One request header, case-insensitively. */
function header(request: RecordedRequest | undefined, name: string): string | undefined {
	const value = request?.headers[name.toLowerCase()];
	return typeof value === "string" ? value : undefined;
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

	/** Put the admin token in write-only `ctx.kv`, the way the Settings screen
	 *  does. Seeded per test rather than in `beforeEach`, so the NO-token case
	 *  below is the ABSENCE of this call rather than a special setup. */
	async function seedAdminToken(): Promise<void> {
		await sandbox.invokeRoute("admin", {
			type: "form_submit",
			action_id: "save-token",
			values: { internalToken: ADMIN_TOKEN },
		});
		service.requests.length = 0;
	}

	/** The request for one EXACT path. `/admin/products` and
	 *  `/admin/products/<id>` share a prefix, so `startsWith` cannot tell a list
	 *  read from a detail read. */
	function requestTo(path: string): RecordedRequest | undefined {
		return service.requests.find((r) => (r.url.split("?")[0] ?? "") === path);
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

	test("the `total` IS SHOWN once filtering is server-side — the caption rule inverts", async () => {
		// THE CAPTION RULE INVERTS. The service applies the predicate now (the
		// stub stands in for it, already returning only the matching row) and
		// counts the SAME set the page is drawn from, so its exact `total`
		// describes the rows on screen and is forwarded — the opposite of the
		// client-side-narrowing days this replaces, which withheld it because
		// the service's count then described a different, unnarrowed set.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: {
						products: [summary({ productId: "low", onHand: 2 })],
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
		expect(result["total"]).toBe(137);
		expect(
			(result["products"] as Array<Record<string, unknown>>).map((p) => p["productId"]),
		).toEqual(["low"]);
		expect(result["nextCursor"]).toBe("cur-2");
		// ...and the predicate really did travel on the outgoing request — the
		// service could not have filtered without it.
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("lowStockThreshold=5");
	});

	test("the resolved threshold travels to the service AS THE NUMBER ITSELF — the boundary is the store's job now", async () => {
		// THE BOUNDARY (`onHand <= threshold`) MOVED. It used to be enforced
		// twice — once by this module's own client-side narrowing, once by the
		// `On hand` cell — because the page narrowing was this module's own
		// decision. Now the SERVER decides which rows match (pinned by the
		// domain's own contract suite, out of this module's scope) and this
		// module's only remaining job is to carry the resolved number through
		// UNCHANGED — never rounded, never re-derived, never off by one.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary({ productId: "at", onHand: 5 })], nextCursor: null },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		await invoke({
			type: READ,
			resource: "products.list",
			filter: { lowStock: true },
		});
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("lowStockThreshold=5");

		// ...and the `On hand` cell's OWN boundary is unaffected by where the row
		// came from — still `<=`, still exact at the threshold.
		expect(onHandCell(5, 5)).toBe("5 · Low");
		expect(onHandCell(6, 5)).toBe("6");
		// A threshold of ZERO is its own boundary: `0` is out of stock, and nothing
		// above it can be low.
		expect(onHandCell(0, 0)).toBe("0 · Out of stock");
		expect(onHandCell(1, 0)).toBe("1");
	});

	test("a low-stock request that CANNOT be honoured leaves the page unfiltered AND withholds the total", async () => {
		// No threshold ⇒ nothing to filter by, so the outgoing request never
		// carries `lowStockThreshold` at all — the page is genuinely UNFILTERED
		// and the screen must say so. THE CAPTION RULE INVERTS BACK here: the
		// service's own count is real (of the unfiltered set), but stating it
		// would caption an unfiltered page as though "Low stock only" had been
		// honoured, so it is withheld — the opposite of an ordinary
		// service-filtered page, and the one case that still hides it.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary(), summary({ productId: "b" })], nextCursor: null, total: 2 },
				}),
				// no /settings route ⇒ 404 ⇒ the threshold cannot be read
			}),
		);
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { lowStock: true },
		});
		expect((result["products"] as unknown[]).length).toBe(2);
		expect((result["stock"] as Record<string, unknown>)["filterUnavailable"]).toBe(true);
		expect(result).not.toHaveProperty("total");
		// ...and the outgoing request never carried a predicate it had no number
		// for.
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).not.toContain("lowStockThreshold");
	});

	test("a CONTINUATION whose settings read fails is still a FILTERED page — the cursor is the predicate's evidence", async () => {
		// THE FLAG IS NOT RE-DERIVED ON A CONTINUATION, and this is the direction
		// that goes wrong when it is. The predicate rode inside the opaque cursor
		// the service minted for page one; `AdminProductsClient.listProducts`
		// ignores the filter argument entirely once a cursor is present, so this
		// request's settings read never reached the query and says nothing about
		// whether the page is filtered. Deriving `filterUnavailable` from it would
		// raise "the Low stock only filter was not applied" OVER A FILTERED LIST
		// and withhold a total that really is of the filtered set — two false
		// statements bought by consulting the wrong evidence.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary({ onHand: 2 })], nextCursor: null, total: 7 },
				}),
				// no /settings route ⇒ 404 ⇒ the threshold cannot be read HERE
			}),
		);
		const result = await invoke({
			type: READ,
			resource: "products.list",
			cursor: "svc-cursor-1",
			filter: { lowStock: true },
		});
		expect((result["stock"] as Record<string, unknown>)["filterUnavailable"]).toBe(false);
		expect(result["total"]).toBe(7);
		// The Low BAND is still lost, and that is the honest independent fact:
		// `threshold` is null and the banner reports that cause on its own.
		expect((result["stock"] as Record<string, unknown>)["threshold"]).toBeNull();
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

	test("a page can be GENUINELY low-stock-filtered while its own on-hand column is unreadable — two independent causes, not one", async () => {
		// THE BUG A SHARED `canFilter` BOOLEAN PRODUCED. The threshold resolves
		// (5), so the outgoing request DOES carry the predicate and the service
		// DID filter — that has nothing to do with whether THIS page's own
		// `onHand` wire projection came back readable, a fact discovered only
		// after the fetch. `filterUnavailable` must stay false (the filter ran)
		// while `unreadable` is independently true, and the `total` — real,
		// under the same predicate — must still be forwarded.
		const { onHand: _a, ...noStock1 } = summary({ productId: "a" });
		const { onHand: _b, ...noStock2 } = summary({ productId: "b" });
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [noStock1, noStock2], nextCursor: null, total: 41 },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { lowStock: true },
		});
		const stock = result["stock"] as Record<string, unknown>;
		expect(stock["unreadable"]).toBe(true);
		expect(stock["filterUnavailable"]).toBe(false);
		expect(result["total"]).toBe(41);
		// ...and the predicate really did travel, proving the filter ran.
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("lowStockThreshold=5");
	});

	test("the combined Status select's `archived` asserts deleted=true ALONE, never both axes", async () => {
		service.respondWith("GET", () => ({ status: 200, body: { products: [], nextCursor: null } }));
		await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "archived", productKind: "digital", search: "APR" },
		});
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		// A soft-deleted row is always inactive, so the two are mutually exclusive
		// by construction — and `deleted=true` is asserted alone regardless, so a
		// hand-crafted request cannot smuggle both axes into one query.
		expect(seen).toContain("deleted=true");
		expect(seen).not.toContain("active=");
		expect(seen).toContain("productKind=digital");
		expect(seen).toContain("search=APR");
	});

	test("the OTHER two Status options reach the service as `active=true` / `active=false`", async () => {
		// RESTORED WITH INC-R3. The retired suite pinned this half of the mapping
		// and the surviving coverage pinned only `archived`, so a mapping that sent
		// the wrong boolean — or none — would have left every assertion here green
		// while the operator got the wrong set of rows. It is a claim about the
		// QUERY, not about a rendering, which is why it outlives the screen.
		service.respondWith("GET", () => ({ status: 200, body: { products: [], nextCursor: null } }));
		for (const [status, expected] of [
			["true", "active=true"],
			["false", "active=false"],
		] as const) {
			service.requests.length = 0;
			await invoke({ type: READ, resource: "products.list", filter: { status } });
			const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
			expect(seen, status).toContain(expected);
			expect(seen, status).not.toContain("deleted=");
		}
		// ...and the all-values sentinel constrains NOTHING. `any` is a real word,
		// not `""`, precisely so it can be told apart from a screen sending nothing.
		service.requests.length = 0;
		await invoke({ type: READ, resource: "products.list", filter: { status: "any" } });
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).not.toContain("active=");
		expect(seen).not.toContain("deleted=");
	});

	test("`active`, `productKind` and `search` travel TOGETHER in ONE query", async () => {
		// RESTORED WITH INC-R3. The three axes are each pinned separately above, and
		// the `archived` case pins its own trio — but nothing pinned the combination
		// the retired suite drove: status + kind + search on the ACTIVE axis, in a
		// single GET. A translation that dropped one axis whenever another was set,
		// or that let a later branch overwrite an earlier one, passes every
		// single-axis assertion here and shows the operator the wrong set of rows.
		// It is a claim about the QUERY, which is why it outlives the screen.
		service.respondWith("GET", () => ({ status: 200, body: { products: [], nextCursor: null } }));
		await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "true", productKind: "physical", search: "widget" },
		});
		const seen = requestTo(LIST_ROUTE)?.url ?? "";
		expect(seen).toContain("active=true");
		expect(seen).toContain("productKind=physical");
		expect(seen).toContain("search=widget");
		// ...and the axis the ACTIVE half must never carry.
		expect(seen).not.toContain("deleted=");
	});

	test("`Low stock only` SENDS the resolved threshold to the service — the predicate is server-side now", async () => {
		// INVERTED FROM THE CLIENT-NARROWING DAYS this replaces. The service's
		// products list HAS a stock predicate now (port doc); this module's job
		// is to resolve the threshold and carry it on the SAME query every other
		// filter already travels on, alongside `search` rather than instead of
		// it.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary({ onHand: 2 })], nextCursor: null },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "widget", lowStock: true },
		});
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("search=widget");
		expect(seen).toContain("lowStockThreshold=5");
	});

	test("a request that does NOT ask for low stock never carries the threshold, even when one resolves", async () => {
		// The threshold is read for the `Low` band's display purposes on every
		// call — the checkbox is what gates whether it ALSO becomes a query
		// predicate. Without this, an operator who never asked to filter would
		// see the catalog silently narrowed underneath them.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary({ onHand: 2 })], nextCursor: null },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		await invoke({ type: READ, resource: "products.list", filter: { search: "widget" } });
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("search=widget");
		expect(seen).not.toContain("lowStockThreshold");
	});

	test("a cursor is forwarded ALONE — the service cursor already carries the filter", async () => {
		// RESTORED WITH INC-R3. `Load more` was a Block Kit `block_action` and its
		// mechanism died with the screen, but what the SERVICE is asked for did not:
		// sending the filter alongside the cursor is how a paged request can
		// disagree with the page before it.
		service.respondWith("GET", () => ({ status: 200, body: { products: [], nextCursor: null } }));
		await invoke({
			type: READ,
			resource: "products.list",
			cursor: "svc-cursor-1",
			filter: { status: "true", search: "widget" },
		});
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("cursor=svc-cursor-1");
		expect(seen).not.toContain("active=");
		expect(seen).not.toContain("search=");
		// The page size still travels, so a "Load more" asks for the same-sized page
		// the caption above it describes.
		expect(seen).toContain("limit=25");
	});

	test("a `Load more` continuation never re-sends `lowStockThreshold` either — it already rode in the cursor", async () => {
		// The one place the threshold-first sequencing does NOT apply: a
		// continuation's filter (including whatever threshold page one
		// resolved) already rode in the opaque cursor the SERVICE minted, and
		// `AdminProductsClient.listProducts` ignores a filter argument whenever
		// a cursor is present. Re-sending it here would be redundant, not wrong
		// — but proving it is ABSENT is what proves this module is not
		// re-deriving a second, possibly-stale predicate.
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({
					status: 200,
					body: { products: [summary({ onHand: 2 })], nextCursor: null },
				}),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		await invoke({
			type: READ,
			resource: "products.list",
			cursor: "svc-cursor-1",
			filter: { lowStock: true },
		});
		const seen = service.requests.find((r) => r.url.startsWith(LIST_ROUTE))?.url ?? "";
		expect(seen).toContain("cursor=svc-cursor-1");
		expect(seen).not.toContain("lowStockThreshold");
	});

	test("the filter vocabulary is shipped as data, so the React tier holds no second copy", async () => {
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

	test("an unreachable service fails CLOSED with the screen's own copy, and leaks nothing", async () => {
		service.respondWith("GET", () => ({ status: 500, body: {} }));
		const result = await invoke({ type: READ, resource: "products.list" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Pricing & inventory is unavailable");
		// E-7: it must not assert a cause it does not know. The last clause is what
		// stops a console bug being reported as an outage.
		expect(String(result["description"])).toContain("a fault in the console itself");
		// THIS PATH SWALLOWS EVERYTHING — an unreachable service, a 401 on the admin
		// token, a malformed response, and a bug in the console's own code. So the
		// copy must carry no status code, no upstream path and no auth detail: an
		// operator screenshotting a banner must not be publishing the shape of the
		// admin API, and naming one cause is false whenever another was the real one.
		const text = `${String(result["title"])} ${String(result["description"])}`;
		expect(text).not.toMatch(/HTTP \d|\/admin\/|401/);
		// A banner is read at a glance or not at all (BANNER_BUDGET).
		expect(String(result["description"]).length).toBeLessThanOrEqual(240);
	});

	test("the list AND detail GETs carry the internal admin token (ADR-0010)", async () => {
		// RESTORED WITH INC-R3. Every surviving header assertion is on the PATCH or
		// the stock POSTs, so a read path that stopped attaching the token would
		// leave all of them green while every guarded READ answered 401 — and the
		// route swallows a 401 into the same fail-closed banner as an outage, so the
		// screen would look "unavailable" with nothing pointing at the cause. It is
		// a claim about what the SERVICE is asked for, not about a rendering.
		await seedAdminToken();
		service.respondWith(
			"GET",
			responder({
				[LIST_ROUTE]: () => ({ status: 200, body: { products: [summary()], nextCursor: null } }),
				[DETAIL_ROUTE]: () => ({ status: 200, body: { product: detail() } }),
				[TAX_CLASSES_ROUTE]: () => ({ status: 200, body: { classes: [] } }),
				[SETTINGS_ROUTE]: () => settingsBody(5),
			}),
		);
		await invoke({ type: READ, resource: "products.list" });
		await invoke({ type: READ, resource: "products.detail", productId: PRODUCT_ID });
		expect(header(requestTo(LIST_ROUTE), "X-Internal-Token")).toBe(ADMIN_TOKEN);
		expect(header(requestTo(DETAIL_ROUTE), "X-Internal-Token")).toBe(ADMIN_TOKEN);
		// The write-gate token is a NON-GET credential (ADR-0007) and has no business
		// on a read, so its absence here is part of the assertion.
		expect(header(requestTo(LIST_ROUTE), "X-Service-Token")).toBeUndefined();
	});

	test("with NO admin token the reads fail CLOSED on the service's 401, and the banner leaks nothing", async () => {
		// RESTORED WITH INC-R3. The anti-leak contract was being exercised only
		// through a 500 above; the ABSENT-token → 401 trigger had no successor, and
		// it is the one an operator actually hits — an unconfigured or rotated admin
		// token is the ordinary failure on this screen, an unreachable service is
		// not. No `seedAdminToken()` call: the token really is missing.
		service.respondWith("GET", (request) => {
			if (request.headers["x-internal-token"] === undefined) {
				return { status: 401, body: { ok: false, error: "unauthorized" } };
			}
			return { status: 200, body: { products: [], nextCursor: null } };
		});
		const result = await invoke({ type: READ, resource: "products.list" });
		// The 401 really fired — otherwise this asserts nothing.
		expect(requestTo(LIST_ROUTE)).toBeDefined();
		expect(header(requestTo(LIST_ROUTE), "X-Internal-Token")).toBeUndefined();
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Pricing & inventory is unavailable");
		expect(String(result["description"])).toContain("a fault in the console itself");
		// E-7: a banner gets screenshotted. No status code and no upstream path —
		// and no claim that auth WAS the cause, because this path swallows four and
		// naming one is false whenever another was the real one. (Naming the admin
		// token as a thing to CHECK is the remediation hint, not a diagnosis.)
		const text = `${String(result["title"])} ${String(result["description"])}`;
		expect(text).not.toMatch(/HTTP \d|\/admin\/|401|unauthorized/i);
	});

	test("an unrecognised products resource is a refusal, not a blank body", async () => {
		const result = await invoke({ type: READ, resource: "products.nope" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("That request could not be read");
	});

	// ── writes ────────────────────────────────────────────────────────────────

	test("a SAVE is DISPATCHED to the extracted action, and reaches the service", async () => {
		// The act branch, end to end. What each action DECIDES is covered by
		// `products-actions.sandbox.test.ts`; this asserts the wiring — that a flat
		// console payload lands on the right handler and produces a real request.
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
		// THE WATERMARK TRAVELLED AS A PLAIN ARGUMENT. Without it the action would
		// have refused before writing.
		expect(body["expectedUpdatedAt"]).toBe("2026-07-20T09:00:00.000Z");
		// G2 / ADR-0013: `title` and `active` are CMS-owned. The wire cannot carry
		// either, so a console that sent them changes nothing.
		expect(body).not.toHaveProperty("title");
		expect(body).not.toHaveProperty("active");
	});

	test("a save with a STALE watermark comes back as the action's own refusal copy", async () => {
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
		// The operator saw 42; the live product is at 40. Nothing may be removed.
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
		// Reachable from a stale tab after a deploy that renamed an action. An id
		// this screen does not offer must never come back as an outcome: that would
		// render a stock movement that never happened as a silent success.
		const result = await invoke({
			type: ACT,
			action_id: "products:no-such-action",
			value: { productId: PRODUCT_ID },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
		expect(String(result["description"])).toContain("Nothing was applied");
	});

	test("the RETIRED staged review step is not offered to the console at all", async () => {
		// `products:remove-stock-review` was DA-3 state 1 → state 2 on the Block Kit
		// screen. The React screen shows the confirm dialog directly, so the id has
		// never had a caller; INC-R3 left it unported rather than carrying a step
		// nothing reaches. Asking for it must refuse, not silently stage anything.
		const result = await invoke({
			type: ACT,
			action_id: "products:remove-stock-review",
			value: { productId: PRODUCT_ID, onHand: "42", qty: "3" },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
	});

	test("a REGISTERED id whose write could not complete is also a refusal", async () => {
		// Every request fails, so nothing was saved. "Nothing came back" is not
		// "nothing to say".
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
