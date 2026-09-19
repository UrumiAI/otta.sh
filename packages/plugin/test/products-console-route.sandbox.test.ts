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
 * THERE IS NO SERVICE BEHIND THIS SCREEN ANY MORE (INC-D3a). `makeAdminClients`
 * builds `InProcessAdminProductsClient` and `InProcessReportingSettingsClient`
 * over `ctx.storage`, so the page, its count, its cursor and its threshold all
 * come off the plugin's own document store. Every assertion that used to read a
 * recorded request's QUERY STRING is therefore gone, and what replaces it is
 * strictly stronger: the fixtures are real rows, and a predicate is proven by
 * WHICH ROWS COME BACK rather than by the characters that were sent asking for
 * them. A query string can carry `lowStockThreshold=5` and still be applied to
 * the wrong column; a page that returns the `5` row and not the `6` row cannot.
 *
 * WHAT IT STILL COVERS, unchanged in substance:
 *
 *  1. **Raw values, never rendered ones.** A Block Kit row carries "$19.99"
 *     (money already spent, G1) and "42 · Low" (a band already decided). The
 *     React tier is fed minor units and a raw count, and formats both itself.
 *  2. **Resolving the threshold into a server-side predicate, and captioning it
 *     correctly.** "Low stock only" travels as a real filter axis, the count is
 *     taken under the SAME predicate, and the page's `total` therefore describes
 *     the rows above it.
 *  3. **The cursor as a predicate.** A continuation states its filters beside the
 *     token; a token that disagrees is refused and answered with page one,
 *     flagged.
 *
 * THE DEGRADED-SECONDARY ARMS ARE GONE WITH THE TRANSPORT THAT COULD PRODUCE
 * THEM, and each deletion is recorded where it used to stand. A settings read
 * that FAILS (`stock.threshold === null`, and with it every `filterUnavailable`
 * case), a tax-registry read that FAILS, and a page whose on-hand column came
 * back with no key at all (`stock.unreadable === true`) were all injected by
 * making a stub HTTP surface answer 404 or omit a field. In-process the settings
 * store answers from its own defaults rather than failing, `toProductSummaryWire`
 * always emits `onHand` as `number | null`, and `getTaxClasses` is a store scan.
 * A test that hand-built those states would be asserting against its own fixture,
 * not against this route — so the reachable half of each pair is kept and the
 * unreachable half is deleted with its reason.
 *
 * WHAT IT DOES NOT COVER, deliberately: the React components. Those are gated by
 * Playwright (`sites/staging/e2e/products-console.spec.ts`), which is additive
 * to this tier and replaces none of it.
 *
 * ONE STORE PER PROCESS (`storageBridge`), so every case addresses disjoint ids
 * and every list assertion narrows by a `search` term unique to its own case —
 * the catalogue is shared, the fixtures are not.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey,
	money,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	EmdashSettingsStore,
	EmdashTaxRulesStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { onHandCell } from "@otta-sh/admin-presentation";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

const READ = "otta_console_read";
const ACT = "otta_console_act";

/** The id/sku namespace this file owns in the shared per-process store. */
const NS = "pcr";
/** `PAGE_LIMIT` in `products-read.ts`, restated so the cursor block can seed one
 *  row past it. */
const PAGE_LIMIT = 25;
/** The store's low-stock threshold for this whole file, written once into the
 *  real settings document. It is a SETTINGS value, not a product field, which is
 *  the entire reason this screen reads two surfaces. */
const THRESHOLD = 5;

let sandbox: SandboxHandle;
let storage: StorageAccess;
let products: EmdashProductCommerceStore;
let inventory: EmdashInventoryStore;
let taxRules: EmdashTaxRulesStore;
let seq = 0;

interface Seeded {
	readonly productId: string;
	readonly sku: string;
	readonly title: string;
	readonly updatedAt: string;
}

interface SeedOptions {
	/** Substring the list `search` axis will narrow on — every case uses its own. */
	readonly term: string;
	/** `null` seeds NO inventory document, which is "unknown stock", not zero. */
	readonly onHand?: number | null;
	readonly kind?: "physical" | "digital";
	readonly active?: boolean;
	readonly archived?: boolean;
	readonly priceCents?: number;
}

/** One real product-commerce row (plus, unless suppressed, its inventory
 *  document) written straight to the store the isolate reads through. */
async function seedProduct(options: SeedOptions): Promise<Seeded> {
	const n = ++seq;
	const productId = `${NS}-prod-${String(n)}`;
	const sku = `${NS}-SKU-${String(n)}`;
	const title = `${options.term} widget ${String(n)}`;
	const product = await products.upsert(
		{
			productId: toProductId(productId),
			sku: toSku(sku),
			title,
			price: money(cents(options.priceCents ?? 1999), toCurrency("USD")),
			taxClass: "standard",
			weightGrams: 320,
			productKind: options.kind ?? "physical",
		},
		idempotencyKey(`${NS}-seed-${String(n)}`),
	);
	const onHand = options.onHand === undefined ? 42 : options.onHand;
	if (onHand !== null) await inventory.seedOnHand(toSku(sku), onHand);
	// The publish gate is CMS-owned and a freshly upserted row has never been
	// published, so `active` starts false — a case that wants a live row has to
	// flip the gate through the store's own lifecycle method.
	if (options.active === true) {
		await products.activate(
			toProductId(productId),
			idempotencyKey(`${NS}-activate-${String(n)}`),
			new Date().toISOString(),
		);
	}
	if (options.archived === true) {
		await products.softDelete(toProductId(productId), idempotencyKey(`${NS}-del-${String(n)}`));
	}
	const row = await products.getByProductId(toProductId(productId));
	return { productId, sku, title, updatedAt: (row ?? product).updatedAt.toISOString() };
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	products = new EmdashProductCommerceStore({ storage, clock: systemClock });
	inventory = new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock });
	taxRules = new EmdashTaxRulesStore({ storage, clock: systemClock });
	const settings = new EmdashSettingsStore({ storage, clock: systemClock });
	await settings.update({ lowStockThreshold: THRESHOLD }, idempotencyKey(`${NS}-settings`));
	sandbox = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 300_000);

afterAll(async () => {
	await sandbox.close();
});

async function invoke(input: unknown): Promise<Record<string, unknown>> {
	const outcome = await sandbox.invokeRoute("admin", input);
	expect(outcome, JSON.stringify(outcome)).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

/** The rows of a list payload, as the console receives them. */
function rows(result: Record<string, unknown>): Array<Record<string, unknown>> {
	expect(result["ok"], JSON.stringify(result)).toBe(true);
	return result["products"] as Array<Record<string, unknown>>;
}

function ids(result: Record<string, unknown>): unknown[] {
	return rows(result).map((p) => p["productId"]);
}

function stockOf(result: Record<string, unknown>): Record<string, unknown> {
	return result["stock"] as Record<string, unknown>;
}

describe("the console's Pricing & inventory branch on the otta admin route", () => {
	test("products.list returns RAW minor units and a RAW on-hand count", async () => {
		// THE WHOLE REASON THIS BRANCH EXISTS. A Block Kit row carries "$19.99"
		// (money already spent, G1) and "42" or "3 · Low" (a band already decided).
		// A React tier fed those strings could format neither and re-band nothing.
		const seeded = await seedProduct({ term: "rawvalues", onHand: 42, priceCents: 1999 });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "rawvalues" },
		});
		const page = rows(result);
		expect(page).toHaveLength(1);
		expect(page[0]?.["productId"]).toBe(seeded.productId);
		expect(page[0]?.["priceCents"]).toBe(1999);
		expect(page[0]?.["currency"]).toBe("USD");
		expect(page[0]?.["onHand"]).toBe(42);
		expect(JSON.stringify(result)).not.toContain("$19.99");
		expect(JSON.stringify(result)).not.toContain("42 · ");
	});

	test("the low-stock THRESHOLD travels with the page, because a row cannot carry it", async () => {
		// What counts as `Low` is a SETTINGS value, not a product field — this is
		// the one screen that reads two surfaces, and the React tier needs the
		// second one to render the same cell the Block Kit table renders. The
		// settings surface is the plugin's own store now, so this reads back the
		// number written into the real settings document in `beforeAll`.
		await seedProduct({ term: "bandcarry", onHand: 4 });
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "bandcarry" },
		});
		expect(stockOf(result)["threshold"]).toBe(THRESHOLD);
		// ...and the shared cell function turns the two into the same string both
		// screens render. 4 ≤ 5, so this one is Low.
		expect(onHandCell(4, THRESHOLD)).toBe("4 · Low");
	});

	// DELETED: "a settings read that FAILS costs the Low band and nothing else
	// (E-1)". It was driven by withholding the stub's `/settings` route so the read
	// 404ed. `InProcessReportingSettingsClient.getSettings` reads the settings
	// document and an ABSENT document is the domain defaults rather than an error,
	// so there is no reachable input on this tier that makes `threshold` null. Its
	// consequence — `readLowStockThreshold` swallowing a failure into `null` — is a
	// two-line try/catch in `products-read.ts` with no remaining producer here; a
	// test that faked one would be asserting on its own fixture. E-1 itself is not
	// unproven: the detail's tax-registry fallback below still exercises a real
	// secondary degradation.

	test("`null` on-hand is NOT zero — a sku with no inventory document is UNKNOWN stock", async () => {
		// Two cases that must never be folded together: a known count of zero ("out
		// of stock" is a FACT) and a sku carrying no inventory document at all.
		//
		// THE THIRD CASE IS NO LONGER REPRESENTABLE, and that is a fact about this
		// tier rather than a gap. `undefined` meant "the response carried no stock
		// figure at all" — a service older than the on-hand projection. In-process
		// `toProductSummaryWire` always emits the key as `number | null`, so the
		// only way to produce it would be to hand-write a wire object. `readOnHand`
		// still reads it as `unknown` and still keeps all three apart, which is why
		// `onHandCell` is asserted on all three below: the RENDER contract is
		// unchanged even though this transport can only ever produce two of them.
		const zero = await seedProduct({ term: "stockcases", onHand: 0 });
		const unknown = await seedProduct({ term: "stockcases", onHand: null });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "stockcases" },
		});
		const byId = new Map(rows(result).map((p) => [p["productId"], p]));
		expect(byId.get(zero.productId)?.["onHand"]).toBe(0);
		expect(byId.get(unknown.productId)?.["onHand"]).toBeNull();
		expect(onHandCell(0, THRESHOLD)).toBe("0 · Out of stock");
		expect(onHandCell(null, THRESHOLD)).toBe("—");
		expect(onHandCell(undefined, THRESHOLD)).toBe("—");
	});

	test("the exact `total` is FORWARDED, and it COUNTS the filtered set rather than the page", async () => {
		// The count is taken under the SAME predicate as the page, by construction
		// (`#page` runs `listProducts` and `countProducts` on one filter object), so
		// it describes the rows the caption sits above.
		for (let i = 0; i < 3; i++) await seedProduct({ term: "totalset" });
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "totalset" },
		});
		expect(rows(result)).toHaveLength(3);
		expect(result["total"]).toBe(3);
	});

	test("the `total` IS SHOWN once filtering is server-side — the caption rule inverts", async () => {
		// THE CAPTION RULE INVERTS. The store applies the predicate now and counts
		// the SAME set the page is drawn from, so its exact `total` describes the
		// rows on screen and is forwarded — the opposite of the client-side-narrowing
		// days this replaces, which withheld it because the count then described a
		// different, unnarrowed set.
		const low = await seedProduct({ term: "lowtotal", onHand: 2 });
		await seedProduct({ term: "lowtotal", onHand: 90 });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "lowtotal", lowStock: true },
		});
		// THE PREDICATE REALLY RAN — proven by the rows, which is the claim the old
		// `expect(url).toContain("lowStockThreshold=5")` was a proxy for.
		expect(ids(result)).toEqual([low.productId]);
		expect(result["total"]).toBe(1);
		expect(stockOf(result)["filterUnavailable"]).toBe(false);
	});

	test("the resolved threshold reaches the predicate AS THE NUMBER ITSELF — inclusive, never off by one", async () => {
		// THE BOUNDARY (`onHand <= threshold`) MOVED. It used to be enforced twice —
		// once by this module's own client-side narrowing, once by the `On hand`
		// cell. The STORE decides which rows match now, and this module's only
		// remaining job is to carry the resolved number through UNCHANGED — never
		// rounded, never re-derived, never off by one. A row sitting exactly ON the
		// threshold is the assertion that proves the number arrived intact.
		const at = await seedProduct({ term: "boundary", onHand: THRESHOLD });
		await seedProduct({ term: "boundary", onHand: THRESHOLD + 1 });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "boundary", lowStock: true },
		});
		expect(ids(result)).toEqual([at.productId]);

		// ...and the `On hand` cell's OWN boundary is unaffected by where the row
		// came from — still `<=`, still exact at the threshold.
		expect(onHandCell(5, 5)).toBe("5 · Low");
		expect(onHandCell(6, 5)).toBe("6");
		// A threshold of ZERO is its own boundary: `0` is out of stock, and nothing
		// above it can be low.
		expect(onHandCell(0, 0)).toBe("0 · Out of stock");
		expect(onHandCell(1, 0)).toBe("1");
	});

	test("a sku with NO inventory document is never `Low` — unknown stock is not zero stock", async () => {
		// The other half of the predicate's contract, and the direction that would
		// be invisible in a query-string assertion: absent is not zero, so a product
		// nobody has ever stocked must not be swept into a low-stock page as though
		// it were about to run out.
		const low = await seedProduct({ term: "unknownlow", onHand: 1 });
		await seedProduct({ term: "unknownlow", onHand: null });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "unknownlow", lowStock: true },
		});
		expect(ids(result)).toEqual([low.productId]);
	});

	// DELETED: "a low-stock request that CANNOT be honoured leaves the page
	// unfiltered AND withholds the total", and with it "a CONTINUATION whose
	// settings read fails is still a FILTERED page". Both existed to pin
	// `stock.filterUnavailable`, whose SOLE cause is `threshold === null` — the
	// settings read failing. That input is unreachable in-process (see the deletion
	// note above), so `filterUnavailable` is structurally false here and is
	// asserted as such on the low-stock pages that remain. `resolveStockContext`'s
	// own decision table, including the continuation rule, is a pure function of
	// its arguments; what this tier can still prove is that a real low-stock page
	// reports the flag false while carrying its real total, which it does.

	test("stock that is unreadable on EVERY row is not something this transport can produce — a PARTIAL page stays a catalog fact", async () => {
		// ALL-OR-NOTHING was the rule: the service filled the column from one left
		// join, so a PARTIAL page is a catalog fact (some skus have no inventory
		// row) and must not raise the banner, while a page with no figure ANYWHERE
		// is a degraded read and must.
		//
		// ONLY THE FIRST HALF SURVIVES. `stock.unreadable` is true when every row's
		// `onHand` reads `undefined`, and the in-process projection emits the key on
		// every row as `number | null`. So the degraded case has no producer and the
		// case that DOES occur in a real catalogue — some rows stocked, some never
		// seeded — is the one pinned here: it must leave the banner silent.
		await seedProduct({ term: "partialstock", onHand: null });
		await seedProduct({ term: "partialstock", onHand: 7 });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "partialstock" },
		});
		expect(rows(result)).toHaveLength(2);
		expect(stockOf(result)["unreadable"]).toBe(false);
	});

	test("the combined Status select's `archived` asserts deleted=true ALONE, never both axes", async () => {
		// A soft-deleted row is always inactive, so the two are mutually exclusive
		// by construction — and `deleted: true` is asserted alone regardless, so a
		// hand-crafted request cannot smuggle both axes into one query. The proof is
		// the rows: the archive view shows the tombstone and nothing else, even
		// though the request also named a kind and a search term.
		const archived = await seedProduct({
			term: "archiveview",
			archived: true,
			kind: "digital",
		});
		await seedProduct({ term: "archiveview", kind: "digital" });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "archived", productKind: "digital", search: "archiveview" },
		});
		expect(ids(result)).toEqual([archived.productId]);
		expect(rows(result)[0]?.["deletedAt"]).not.toBeNull();
	});

	test("the OTHER two Status options select active / inactive rows", async () => {
		// RESTORED WITH INC-R3, and it outlives the wire it was written against: the
		// surviving coverage pinned only `archived`, so a mapping that sent the wrong
		// boolean — or none — would leave every assertion here green while the
		// operator got the wrong set of rows.
		const live = await seedProduct({ term: "statusaxis", active: true });
		const dark = await seedProduct({ term: "statusaxis" });

		const activeOnly = await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "true", search: "statusaxis" },
		});
		expect(ids(activeOnly)).toEqual([live.productId]);

		const inactiveOnly = await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "false", search: "statusaxis" },
		});
		expect(ids(inactiveOnly)).toEqual([dark.productId]);

		// ...and the all-values sentinel constrains NOTHING. `any` is a real word,
		// not `""`, precisely so it can be told apart from a screen sending nothing.
		const unconstrained = await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "any", search: "statusaxis" },
		});
		expect(new Set(ids(unconstrained))).toEqual(new Set([live.productId, dark.productId]));
	});

	test("`active`, `productKind` and `search` narrow TOGETHER, never one at a time", async () => {
		// RESTORED WITH INC-R3. The three axes are each pinned separately above, and
		// the `archived` case pins its own trio — but nothing pinned the combination:
		// status + kind + search on the ACTIVE axis, in one request. A translation
		// that dropped one axis whenever another was set, or that let a later branch
		// overwrite an earlier one, passes every single-axis assertion here and shows
		// the operator the wrong set of rows. Three decoys, one hit.
		const wanted = await seedProduct({ term: "threeaxes", active: true, kind: "physical" });
		await seedProduct({ term: "threeaxes", active: true, kind: "digital" });
		await seedProduct({ term: "threeaxes", kind: "physical" });
		await seedProduct({ term: "otheraxes", active: true, kind: "physical" });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { status: "true", productKind: "physical", search: "threeaxes" },
		});
		expect(ids(result)).toEqual([wanted.productId]);
	});

	test("`Low stock only` narrows ALONGSIDE `search`, not instead of it", async () => {
		// INVERTED FROM THE CLIENT-NARROWING DAYS this replaces. The products list
		// HAS a stock predicate now (port doc); this module's job is to resolve the
		// threshold and carry it on the SAME query every other filter travels on.
		// The decoys prove both axes survived the trip: one matches the term but not
		// the stock, one matches the stock but not the term.
		const hit = await seedProduct({ term: "bothaxes", onHand: 2 });
		await seedProduct({ term: "bothaxes", onHand: 80 });
		await seedProduct({ term: "decoyaxis", onHand: 2 });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "bothaxes", lowStock: true },
		});
		expect(ids(result)).toEqual([hit.productId]);
	});

	test("a request that does NOT ask for low stock is never narrowed by the threshold", async () => {
		// The threshold is read for the `Low` band's display purposes on every call
		// — the checkbox is what gates whether it ALSO becomes a query predicate.
		// Without this, an operator who never asked to filter would see the catalog
		// silently narrowed underneath them.
		await seedProduct({ term: "nofilter", onHand: 2 });
		await seedProduct({ term: "nofilter", onHand: 80 });

		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "nofilter" },
		});
		expect(rows(result)).toHaveLength(2);
		// The band is still reported, because the CELL needs it even when the LIST
		// was not narrowed by it.
		expect(stockOf(result)["threshold"]).toBe(THRESHOLD);
	});

	test("the filter vocabulary is shipped as data, so the React tier holds no second copy", async () => {
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
		expect(vocabulary["pageLimit"]).toBe(PAGE_LIMIT);
	});

	test("an EMPTY tax registry degrades to the static defaults, not to an empty select", async () => {
		// A registry that answered, and answered with nothing — a store whose
		// merchant has never declared a class. An empty select is a form the
		// operator cannot complete, so the defaults stand in.
		//
		// IT RUNS BEFORE THE DETAIL CASE BELOW ON PURPOSE: the registry is one
		// shared store per process, and the case after this one declares a class
		// into it. Emptiness is a state this file can only observe once.
		//
		// (The sibling case, "a tax-registry read that FAILS degrades to the
		// defaults too", is DELETED: it was the stub's `/admin/tax/classes` route
		// 404ing, and `getTaxClasses` is now `taxRules.listClasses()` over the
		// document store. The fallback in `readTaxClasses` still catches, but
		// nothing on this tier can make the scan throw without breaking storage
		// itself, and the EMPTY arm exercises the same fallback with a reachable
		// input.)
		const seeded = await seedProduct({ term: "emptyregistry" });
		const result = await invoke({
			type: READ,
			resource: "products.detail",
			productId: seeded.productId,
		});
		expect(result["ok"]).toBe(true);
		const classes = result["taxClasses"] as Array<{ id: string }>;
		expect(classes.length).toBeGreaterThan(0);
		expect(classes.map((c) => c.id)).toContain("standard");
	});

	test("products.detail carries the record, the tax registry and the threshold", async () => {
		await taxRules.createClass({ id: "standard", name: "Standard" });
		const seeded = await seedProduct({ term: "detailrow", onHand: 42 });

		const result = await invoke({
			type: READ,
			resource: "products.detail",
			productId: seeded.productId,
		});
		expect(result["ok"]).toBe(true);
		const product = result["product"] as Record<string, unknown>;
		expect(product["sku"]).toBe(seeded.sku);
		expect(product["priceCents"]).toBe(1999);
		expect(product["onHand"]).toBe(42);
		// The wire carries the WATERMARK the save has to send back.
		expect(product["updatedAt"]).toBe(seeded.updatedAt);
		// The LIVE registry now, rather than the static backstop.
		expect(result["taxClasses"]).toEqual([{ id: "standard", name: "Standard" }]);
		expect(result["threshold"]).toBe(THRESHOLD);
	});

	test("an unknown product is a refusal with copy, at HTTP 200 (G5)", async () => {
		const result = await invoke({
			type: READ,
			resource: "products.detail",
			productId: `${NS}-never-existed`,
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Product not found");
		expect(String(result["description"]).length).toBeGreaterThan(0);
	});

	test("a read this route cannot complete fails CLOSED with the screen's own copy, and leaks nothing", async () => {
		// THE TRIGGER CHANGED, THE CONTRACT DID NOT. It used to be an unreachable
		// service answering 500; there is no service, so the reachable way into the
		// handler's catch-all is an input the client refuses at its own boundary — a
		// `search` past the 200-character bound `toDomainFilter` enforces, which
		// throws a `CommerceInputError` rather than resolving to a typed result.
		const result = await invoke({
			type: READ,
			resource: "products.list",
			filter: { search: "x".repeat(201) },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Pricing & inventory is unavailable");
		// E-7: it must not assert a cause it does not know. The last clause is what
		// stops a console bug being reported as an outage.
		expect(String(result["description"])).toContain("a fault in the console itself");
		// THIS PATH SWALLOWS EVERYTHING — a refused input, a malformed document, a
		// storage failure and a bug in the console's own code. So the copy must
		// carry no status code, no upstream path and no auth detail: an operator
		// screenshotting a banner must not be publishing the shape of an internal
		// surface, and naming one cause is false whenever another was the real one.
		const text = `${String(result["title"])} ${String(result["description"])}`;
		expect(text).not.toMatch(/HTTP \d|\/admin\/|401/);
		// A banner is read at a glance or not at all (BANNER_BUDGET).
		expect(String(result["description"]).length).toBeLessThanOrEqual(240);
	});

	// DELETED: "the list AND detail GETs carry the internal admin token (ADR-0010)"
	// and "with NO admin token the reads fail CLOSED on the service's 401". Both
	// asserted on `X-Internal-Token` / `X-Service-Token`, which INC-D3a deleted
	// outright: they authenticated a caller TO THE SERVICE, and there is no service
	// to authenticate to. `makeAdminClients` constructs both clients over
	// `ctx.storage` with no credential of any kind, so there is no header to carry
	// and no 401 to fail closed on — the console routes are gated by EmDash's own
	// admin auth and CSRF (ADR-0014 D3). The anti-leak half of the second test is
	// not lost: the fail-closed case above makes the same E-7 assertions against a
	// trigger that still exists.

	test("an unrecognised products resource is a refusal, not a blank body", async () => {
		const result = await invoke({ type: READ, resource: "products.nope" });
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("That request could not be read");
	});

	// ── cursors ───────────────────────────────────────────────────────────────

	describe("cursors", () => {
		// ONE PAGE PLUS ONE ROW, under a term nothing else in this file uses, so the
		// page boundary is a property of these fixtures rather than of whatever else
		// the shared store happens to hold.
		const TERM = "pagedset";
		let all: string[];

		beforeAll(async () => {
			const seeded: string[] = [];
			for (let i = 0; i < PAGE_LIMIT + 1; i++) {
				seeded.push((await seedProduct({ term: TERM })).productId);
			}
			all = seeded;
		}, 120_000);

		test("a page one hands back a cursor, and the continuation carries the filters it was minted under", async () => {
			// THE INVERSION OF WHAT THIS ONCE PINNED, and the reason is the service's,
			// inherited by the client that replaced it. Sending only the cursor did not
			// stop a paged request disagreeing with the page before it — it hid the
			// disagreement. The token's filter and the caller's are compared as
			// PREDICATES now and a difference fails closed, which is only useful if the
			// request states both. So the console re-states the filter on every page,
			// and the proof is that the continuation is honoured: it returns the
			// remaining row rather than a flagged page one.
			const first = await invoke({
				type: READ,
				resource: "products.list",
				filter: { search: TERM },
			});
			expect(rows(first)).toHaveLength(PAGE_LIMIT);
			expect(first["total"]).toBe(PAGE_LIMIT + 1);
			const cursor = first["nextCursor"];
			expect(typeof cursor).toBe("string");

			const second = await invoke({
				type: READ,
				resource: "products.list",
				cursor,
				filter: { search: TERM },
			});
			expect(second["cursorRejected"]).toBeUndefined();
			expect(rows(second)).toHaveLength(1);
			// Every seeded row appears exactly once across the two pages — the page
			// size travelled with the token, so "Load more" asked for the same-sized
			// page the caption above it describes.
			const seen = [...ids(first), ...ids(second)];
			expect(new Set(seen).size).toBe(PAGE_LIMIT + 1);
			expect(new Set(seen)).toEqual(new Set(all));
		});

		test("a cursor beside a DIFFERENT filter comes back as page one, flagged, not as an error", async () => {
			// THE PRESCRIBED REMEDY, performed at the client: a token whose predicate
			// disagrees with the parameters beside it means "drop the token and
			// re-issue page one with these parameters", so the console gets rows plus
			// the fact that it did not get the page it asked for. It cannot loop,
			// because the retry keeps the parameters and drops the token.
			const first = await invoke({
				type: READ,
				resource: "products.list",
				filter: { search: TERM },
			});
			const cursor = first["nextCursor"];

			const refused = await invoke({
				type: READ,
				resource: "products.list",
				cursor,
				// A different predicate entirely — the token was minted without it.
				filter: { search: TERM, status: "true" },
			});
			expect(refused["ok"]).toBe(true);
			expect(refused["cursorRejected"]).toBe(true);
			// Page one of what was ACTUALLY asked for: the active-only set, which
			// none of these fixtures is in.
			expect(rows(refused)).toHaveLength(0);
		});

		test("a token that does not decode is refused the same way, never honoured as a position", async () => {
			const result = await invoke({
				type: READ,
				resource: "products.list",
				cursor: "this-is-not-a-cursor",
				filter: { search: TERM },
			});
			expect(result["ok"]).toBe(true);
			expect(result["cursorRejected"]).toBe(true);
			expect(rows(result)).toHaveLength(PAGE_LIMIT);
		});

		test("a refusal that is NOT about the cursor stays a failure", async () => {
			// The distinction the console cannot make for itself. A refused INPUT is
			// not answerable by asking again without the cursor, and must never be
			// reported as a page the operator did not get — the address they are on
			// still names a real page.
			const result = await invoke({
				type: READ,
				resource: "products.list",
				cursor: "irrelevant",
				filter: { search: "y".repeat(201) },
			});
			expect(result["ok"]).toBe(false);
			expect(result["cursorRejected"]).toBeUndefined();
		});
	});

	// ── writes ────────────────────────────────────────────────────────────────

	test("a SAVE is DISPATCHED to the extracted action, and the row really changes", async () => {
		// The act branch, end to end. What each action DECIDES is covered by
		// `products-actions.sandbox.test.ts`; this asserts the wiring — that a flat
		// console payload lands on the right handler and that a write happened. The
		// old proof was a recorded PATCH; the proof now is the row itself.
		const seeded = await seedProduct({ term: "savewire" });
		const result = await invoke({
			type: ACT,
			action_id: "products:save-identity",
			value: {
				productId: seeded.productId,
				expectedUpdatedAt: seeded.updatedAt,
				sku: `${seeded.sku}-2`,
			},
		});
		expect(result["ok"]).toBe(true);

		const row = await products.getByProductId(toProductId(seeded.productId));
		expect(row?.sku).toBe(`${seeded.sku}-2`);
		// THE WATERMARK TRAVELLED AS A PLAIN ARGUMENT. Without it the action would
		// have refused before writing, which the next case pins from the other side.
		expect(row?.updatedAt.toISOString()).not.toBe(seeded.updatedAt);
	});

	test("a save with a STALE watermark comes back as the action's own refusal copy", async () => {
		const seeded = await seedProduct({ term: "stalesave" });
		const result = await invoke({
			type: ACT,
			action_id: "products:save-price",
			value: {
				productId: seeded.productId,
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
		// ...and nothing moved: the refusal is a refusal, not a warning after a
		// write.
		const row = await products.getByProductId(toProductId(seeded.productId));
		expect(row?.price?.amount).toBe(1999);
	});

	test("a console save NEVER smuggles a title or an active flag into the write (G2)", async () => {
		// G2 / ADR-0013: `title` and `active` are CMS-owned. `ProductEditWire` has no
		// member for either and the in-process client's key check refuses an unknown
		// one outright, so a hostile or buggy console that sends them changes
		// nothing — which is now read off the row rather than off a request body.
		const seeded = await seedProduct({ term: "cmsowned" });
		const before = await products.getByProductId(toProductId(seeded.productId));
		await invoke({
			type: ACT,
			action_id: "products:save-identity",
			value: {
				productId: seeded.productId,
				expectedUpdatedAt: seeded.updatedAt,
				sku: `${seeded.sku}-S`,
				title: "Renamed by the admin",
				active: "true",
			},
		});
		const row = await products.getByProductId(toProductId(seeded.productId));
		expect(row?.sku).toBe(`${seeded.sku}-S`);
		expect(row?.title).toBe(seeded.title);
		expect(row?.active).toBe(before?.active);
	});

	test("a RESTOCK dispatched from the console really adds the units", async () => {
		// F-2a lives in the action (`${productId}:restock:${onHand}:${qty}`), and
		// in-process the key is an ARGUMENT rather than a header — it is proven by
		// what it buys, in `products-actions.sandbox.test.ts`. What this tier still
		// owns is that the console's flat payload reaches the movement at all.
		const seeded = await seedProduct({ term: "restockwire", onHand: 42 });
		const result = await invoke({
			type: ACT,
			action_id: "products:restock",
			value: { productId: seeded.productId, onHand: "42", qty: "12" },
		});
		expect(result["ok"]).toBe(true);
		expect(await inventory.findOnHand(toSku(seeded.sku))).toBe(54);
	});

	test("a REMOVAL is re-checked against live stock before anything moves (DA-3a)", async () => {
		// The operator saw 42; the live product is at 40. Nothing may be removed.
		const seeded = await seedProduct({ term: "da3a", onHand: 40 });
		const result = await invoke({
			type: ACT,
			action_id: "products:remove-stock",
			value: { productId: seeded.productId, qty: "3", onHand: "42" },
		});
		expect(result["ok"]).toBe(true);
		const notice = result["notice"] as Record<string, unknown>;
		expect(notice["variant"]).toBe("error");
		expect(notice["title"]).toBe("Stock changed — nothing was removed");
		expect(await inventory.findOnHand(toSku(seeded.sku))).toBe(40);
	});

	test("a REMOVAL whose watermark still holds is applied", async () => {
		const seeded = await seedProduct({ term: "removal", onHand: 42 });
		const result = await invoke({
			type: ACT,
			action_id: "products:remove-stock",
			value: { productId: seeded.productId, qty: "3", onHand: "42" },
		});
		expect(result["ok"]).toBe(true);
		expect(await inventory.findOnHand(toSku(seeded.sku))).toBe(39);
	});

	test("an UNKNOWN action id is a refusal, not a quiet success", async () => {
		// Reachable from a stale tab after a deploy that renamed an action. An id
		// this screen does not offer must never come back as an outcome: that would
		// render a stock movement that never happened as a silent success.
		const result = await invoke({
			type: ACT,
			action_id: "products:no-such-action",
			value: { productId: `${NS}-whatever` },
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
			value: { productId: `${NS}-whatever`, onHand: "42", qty: "3" },
		});
		expect(result["ok"]).toBe(false);
		expect(result["title"]).toBe("Nothing was changed");
	});

	test("a REGISTERED id whose write could not complete is also a refusal", async () => {
		// Nothing was saved, because there is nothing to save against. "Nothing came
		// back" is not "nothing to say".
		const result = await invoke({
			type: ACT,
			action_id: "products:save-identity",
			value: {
				productId: `${NS}-never-existed`,
				expectedUpdatedAt: "2026-07-20T09:00:00.000Z",
				sku: `${NS}-X`,
			},
		});
		const quietSuccess = result["ok"] === true && result["notice"] === null;
		expect(quietSuccess, "a failed write reported as a quiet success").toBe(false);
	});

	test("an ORDERS console request is still routed to the Orders branch", async () => {
		// The dispatcher picks a console screen by `resource` prefix and by action
		// namespace. A products branch that swallowed an orders read would be
		// invisible until an operator opened the other screen.
		const result = await invoke({ type: READ, resource: "orders.list" });
		expect(result["ok"]).toBe(true);
		expect(result).toHaveProperty("orders");
		expect(result).not.toHaveProperty("products");
	});
});
