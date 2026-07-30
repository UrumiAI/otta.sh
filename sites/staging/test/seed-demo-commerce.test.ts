/**
 * The quickstart's front door, guarded (plan §4.7).
 *
 * em-dash's seed applier fires no content hooks, so a seeded product never
 * produces a `product_commerce` row and the demo products are listed but
 * unbuyable until `scripts/seed-demo-commerce.ts` runs. Every failure mode of
 * that script is SILENT at run time — a wrong id, a missing title, an
 * overwritten price all produce HTTP 200s and either a catalog that refuses to
 * sell or a merchant's prices quietly reverted — so each one is pinned here.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	ACTIVATE_WATERMARK,
	DEMO_PRICING,
	demoRows,
	fetchCmsProducts,
	parseExistingCommerce,
	priceBody,
	readCmsPage,
	seededProductSlugs,
	seedOneProduct,
	shouldActivate,
	shouldPrice,
	type CmsProductEntry,
	type CmsProductPage,
	type DemoRow,
} from "../scripts/seed-demo-commerce.js";

const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/seed.json");

/** The CMS's view of the seeded products. The ids are ULIDs, NOT the ids
 *  `seed.json` declares — em-dash's seed applier generates its own and keeps
 *  the declared id only as a seed-local reference. Modelled faithfully here
 *  because assuming otherwise is the bug this fixture exists to prevent. */
const CMS_ENTRIES: CmsProductEntry[] = [
	{ id: "01KYR4KC5KMBYF0EDDTZBNKDX2", slug: "urumi-tee", title: "Urumi Tee" },
	{ id: "01KYR4KC8GCRA5G8WXGK0K4MH6", slug: "urumi-mug", title: "Urumi Mug" },
	{ id: "01KYR4KCB1459ZG70HBMX6HM1F", slug: "urumi-stickers", title: "Urumi Sticker Pack" },
];

const CMS_PAGE: CmsProductPage = { entries: CMS_ENTRIES, unusable: [] };

const TEE: DemoRow = {
	id: "01KYR4KC5KMBYF0EDDTZBNKDX2",
	slug: "urumi-tee",
	title: "Urumi Tee",
	sku: "URUMI-TEE",
	price: { amount: 3200, currency: "USD" },
	initialOnHand: 25,
};

/** A recording stub for the service surface the script talks to. `existing` is
 *  what `GET …/commerce` returns — `null` for a product with no row. */
function stubService(existing: unknown) {
	const calls: Array<{ method: string; url: string; body: unknown; key?: string }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			method,
			url,
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			...(headers["Idempotency-Key"] !== undefined ? { key: headers["Idempotency-Key"] } : {}),
		});
		const payload = method === "GET" ? existing : { ok: true };
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe("seed-demo-commerce", () => {
	test("the slug list comes FROM the seed file, not from a hard-coded list", () => {
		const slugs = seededProductSlugs(seedPath);
		expect(slugs.length).toBeGreaterThan(0);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	test("ids and titles come from the CMS, never from seed.json's declared `id`", () => {
		// `seed.json` says `product:urumi-tee`; the content database says a ULID.
		// Addressing the commerce service with the seed id SUCCEEDS (the upsert
		// mints a row for any id) and creates an orphan no CMS product joins to,
		// so the storefront shows "Not currently available for purchase" with no
		// error anywhere. Hence: resolve from the CMS.
		const rows = demoRows(seededProductSlugs(seedPath), CMS_PAGE);
		for (const row of rows) {
			const entry = CMS_ENTRIES.find((e) => e.slug === row.slug)!;
			expect(row.id).toBe(entry.id);
			expect(row.title).toBe(entry.title);
			expect(row.id.startsWith("product:")).toBe(false);
		}
	});

	test("every seeded product has demo pricing — an unpriced one is a hard error, never a silent unbuyable product", () => {
		const rows = demoRows(seededProductSlugs(seedPath), CMS_PAGE);
		expect(rows).toHaveLength(seededProductSlugs(seedPath).length);
		for (const row of rows) {
			expect(row.sku.length).toBeGreaterThan(0);
			// Money is INTEGER minor units + ISO-4217 (CLAUDE.md non-negotiable).
			expect(Number.isSafeInteger(row.price.amount)).toBe(true);
			expect(row.price.amount).toBeGreaterThan(0);
			expect(row.price.currency).toMatch(/^[A-Z]{3}$/);
			expect(Number.isSafeInteger(row.initialOnHand)).toBe(true);
			expect(row.initialOnHand).toBeGreaterThan(0);
		}
	});

	test("THE UPSERT BODY CARRIES A TITLE — a title-less row is listed, priced, active and rejected at checkout", () => {
		// `product_commerce.title` is normally written by the CMS content sync; no
		// hook fires for a seeded product, so without this the row is born
		// `title = NULL` and `createOrderFromCart` rejects the line with
		// PRODUCT_NOT_PRICED. Everything looks right until a shopper reaches the
		// last step of checkout.
		for (const row of demoRows(seededProductSlugs(seedPath), CMS_PAGE)) {
			const body = priceBody(row);
			expect(body["title"]).toBe(row.title);
			expect(String(body["title"]).trim().length).toBeGreaterThan(0);
			// …and the body is exactly the four fields the upsert takes here — no
			// `active` (that is the guarded second call) and no `contentUpdatedAt`
			// (the CMS owns the sync watermark; this script must not claim it).
			expect(Object.keys(body).toSorted()).toEqual(["initialOnHand", "price", "sku", "title"]);
		}
	});

	test("the activate watermark is the EPOCH, so a later real publish/unpublish always wins", () => {
		// The publish gate is `active_updated_at IS NULL OR active_updated_at <= :t`.
		// Stamping "now" would leave the gate ahead of the content's own
		// `updatedAt`, and a subsequent unpublish would be rejected as stale — the
		// demo product would stay purchasable after being unpublished.
		expect(ACTIVATE_WATERMARK).toBe("1970-01-01T00:00:00.000Z");
		// And it is strict `Date.toISOString()` form, which the service validates
		// by regex; anything else is a 400.
		expect(ACTIVATE_WATERMARK).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	// -- THE RE-RUN GUARD ------------------------------------------------------
	// The failure this prevents: a merchant reprices `urumi-tee` to $50, someone
	// re-runs the quickstart to add a fourth demo product, and the tee silently
	// reverts to $32 with its sku and title reset. That is the F4 clobber class
	// this release exists to eliminate, re-introduced through the script. The
	// idempotency key CANNOT prevent it — `product_commerce` has one shared
	// `idempotency_key` column and the `activate` call overwrites it, so the
	// upsert's replay guard always passes on a re-run, and the body carries no
	// `contentUpdatedAt` for the ordering guard to use.

	test("shouldPrice: prices a missing row and a bare sku-less row; NEVER a row that already has a sku", () => {
		expect(shouldPrice(null)).toBe(true);
		expect(shouldPrice({ sku: null, active: false })).toBe(true);
		expect(shouldPrice({ sku: "URUMI-TEE", active: true })).toBe(false);
		expect(shouldPrice({ sku: "MERCHANT-SKU", active: false })).toBe(false);
	});

	test("shouldActivate: only when the gate is not already open", () => {
		expect(shouldActivate(null)).toBe(true);
		expect(shouldActivate({ sku: null, active: false })).toBe(true);
		expect(shouldActivate({ sku: "URUMI-TEE", active: true })).toBe(false);
	});

	test("FIRST RUN: reads, then prices, then activates — in that order", async () => {
		const { calls, fetchImpl } = stubService(null);
		const outcome = await seedOneProduct(TEE, { serviceUrl: "http://svc", fetchImpl });

		expect(outcome).toEqual({ kind: "priced", activated: true });
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET http://svc/products/01KYR4KC5KMBYF0EDDTZBNKDX2/commerce",
			"PUT http://svc/products/01KYR4KC5KMBYF0EDDTZBNKDX2/commerce",
			"POST http://svc/products/01KYR4KC5KMBYF0EDDTZBNKDX2/commerce/activate",
		]);
		expect(calls[1]?.body).toEqual(priceBody(TEE));
		expect(calls[2]?.body).toEqual({ contentUpdatedAt: ACTIVATE_WATERMARK });
		// Disjoint keys: they share one column, so a shared key would make the
		// activate look like a replay of the upsert.
		expect(calls[1]?.key).not.toBe(calls[2]?.key);
	});

	test("RE-RUN over a merchant-priced product WRITES NOTHING — the price the merchant set survives", async () => {
		const { calls, fetchImpl } = stubService({ sku: "URUMI-TEE", active: true });
		const outcome = await seedOneProduct(TEE, { serviceUrl: "http://svc", fetchImpl });

		expect(outcome).toEqual({ kind: "skipped", reason: "already priced (sku URUMI-TEE)" });
		// The whole point: ONE call, and it is a read.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls.some((c) => c.method !== "GET")).toBe(false);
	});

	test("RE-RUN over a PRICED-BUT-INACTIVE row reports it distinctly — the skip must never read as success", async () => {
		// The silent path the skip guard itself created: a first run's PUT lands,
		// its `activate` fails (service restart, transient 5xx), and the row now
		// has a SKU — so every later run takes the `!shouldPrice` early return and
		// never reaches the activate. The product is listed, priced and unbuyable,
		// and the old summary called it "left as-is". Before the guard existed a
		// re-run healed it.
		//
		// The script deliberately does NOT heal it: activating here would also flip
		// on a row a merchant priced and deliberately never published. So the
		// contract is that it SAYS so, distinctly enough that the summary cannot
		// report success.
		const { calls, fetchImpl } = stubService({ sku: "URUMI-TEE", active: false });
		const outcome = await seedOneProduct(TEE, { serviceUrl: "http://svc", fetchImpl });

		expect(outcome).toEqual({
			kind: "skipped-inactive",
			reason: "already priced (sku URUMI-TEE) but NOT ACTIVE",
		});
		// Still writes nothing — the merchant's values stay untouched.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
	});

	test("a bare CMS-sync row (row exists, no sku) IS priced — there is nothing of the merchant's to lose", async () => {
		const { calls, fetchImpl } = stubService({ sku: null, active: true });
		const outcome = await seedOneProduct(TEE, { serviceUrl: "http://svc", fetchImpl });

		// Priced, but NOT re-activated: the gate is already open, so claiming
		// "activated" in the log would be a lie.
		expect(outcome).toEqual({ kind: "priced", activated: false });
		expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
	});

	test("the write gate token rides both writes when SERVICE_API_TOKEN is set, and never on the read", async () => {
		const { fetchImpl } = stubService(null);
		const seen: Array<Record<string, string> | undefined> = [];
		const spy = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(init?.headers as Record<string, string> | undefined);
			return fetchImpl(input as never, init as never);
		}) as unknown as typeof fetch;

		await seedOneProduct(TEE, {
			serviceUrl: "http://svc",
			serviceToken: "svc-token",
			fetchImpl: spy,
		});

		expect(seen[0]?.["X-Service-Token"]).toBeUndefined(); // the GET is not gated
		expect(seen[1]?.["X-Service-Token"]).toBe("svc-token");
		expect(seen[2]?.["X-Service-Token"]).toBe("svc-token");
	});

	// -- THE GET PAYLOAD -------------------------------------------------------

	test("parseExistingCommerce accepts the shapes the endpoint actually returns", () => {
		// `routes/product-commerce.ts` returns a bare `serialize(row)`, or a bare
		// `null` for a missing row (200 null, not a 404).
		expect(parseExistingCommerce(null, "p1")).toBeNull();
		expect(parseExistingCommerce({ sku: "S", active: true, price: null }, "p1")).toEqual({
			sku: "S",
			active: true,
		});
		expect(parseExistingCommerce({ sku: null, active: false }, "p1")).toEqual({
			sku: null,
			active: false,
		});
	});

	test("an UNRECOGNISED payload throws — it must never resolve to 'skip'", () => {
		// Skipping is the harmful direction: it is the one outcome that looks like
		// success. If this endpoint ever grew the `{ ok, product }` envelope the
		// admin reads already use, an unchecked cast would leave `sku` undefined,
		// `shouldPrice` would return false, and the quickstart would price NOTHING
		// while printing "3 left as-is (already priced)".
		expect(() => parseExistingCommerce({ ok: true, product: { sku: "S" } }, "p1")).toThrow(
			/does not recognise/,
		);
		expect(() => parseExistingCommerce({ sku: 42, active: true }, "p1")).toThrow(/recognise/);
		expect(() => parseExistingCommerce({ sku: "S" }, "p1")).toThrow(/recognise/);
		expect(() => parseExistingCommerce("nope", "p1")).toThrow(/recognise/);
		// And the message names the product, so the operator knows which one.
		expect(() => parseExistingCommerce({ ok: true }, "prod-xyz")).toThrow(/prod-xyz/);
	});

	test("seedOneProduct surfaces an unrecognised GET payload instead of silently skipping", async () => {
		const { calls, fetchImpl } = stubService({ ok: true, product: { sku: "S", active: true } });
		await expect(seedOneProduct(TEE, { serviceUrl: "http://svc", fetchImpl })).rejects.toThrow(
			/does not recognise/,
		);
		expect(calls).toHaveLength(1); // failed on the read, wrote nothing.
	});

	// -- READING THE CMS -------------------------------------------------------

	test("an entry with an unusable title is reported as UNUSABLE, not dropped", () => {
		// Dropping it surfaces later as "the CMS returned no product for slug X",
		// which sends the reader to re-seed a site that is fine.
		const read = readCmsPage([
			{ id: "a", slug: "ok", data: { title: "Fine" } },
			{ id: "b", slug: "numeric-title", data: { title: 42 } },
			{ id: "c", slug: "blank-title", data: { title: "   " } },
			{ id: "d", slug: "no-title", data: {} },
		]);
		expect(read.entries.map((e) => e.slug)).toEqual(["ok"]);
		expect(read.unusable.map((u) => u.slug).toSorted()).toEqual([
			"blank-title",
			"no-title",
			"numeric-title",
		]);
		expect(read.unusable.find((u) => u.slug === "numeric-title")?.reason).toContain("number");
	});

	test("demoRows distinguishes 'returned but unusable' from 'not returned at all'", () => {
		expect(() =>
			demoRows(["urumi-tee"], {
				entries: [],
				unusable: [{ slug: "urumi-tee", reason: "no `title` field" }],
			}),
		).toThrow(/cannot use.*urumi-tee.*no `title` field/s);
		expect(() => demoRows(["urumi-tee"], { entries: [], unusable: [] })).toThrow(
			/returned no product/,
		);
	});

	test("fetchCmsProducts FOLLOWS THE CURSOR — a truncated read would look like a missing product", async () => {
		const pages = [
			{
				data: {
					items: [{ id: "a", slug: "urumi-tee", data: { title: "Urumi Tee" } }],
					nextCursor: "c1",
				},
			},
			{
				data: {
					items: [{ id: "b", slug: "urumi-mug", data: { title: "Urumi Mug" } }],
					nextCursor: null,
				},
			},
		];
		const urls: string[] = [];
		let i = 0;
		const fetchImpl = (async (input: string | URL) => {
			urls.push(String(input));
			return new Response(JSON.stringify(pages[i++]), { status: 200 });
		}) as unknown as typeof fetch;

		const page = await fetchCmsProducts("http://site", {}, fetchImpl);
		expect(page.entries.map((e) => e.slug)).toEqual(["urumi-tee", "urumi-mug"]);
		expect(urls[1]).toContain("cursor=c1");
	});

	test("fetchCmsProducts stops on a repeated cursor rather than spinning", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return new Response(JSON.stringify({ data: { items: [], nextCursor: "same" } }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		await fetchCmsProducts("http://site", {}, fetchImpl);
		// First page sets the cursor, second sees it unchanged and stops.
		expect(calls).toBe(2);
	});

	// -- DRIFT BETWEEN THE SEED AND THE PRICE TABLE ----------------------------

	test("a seeded product with no pricing entry throws, naming the slug", () => {
		expect(() => demoRows(["new-thing"], CMS_PAGE)).toThrow(/new-thing/);
	});

	test("DEMO_PRICING has no entry for a product the seed no longer declares", () => {
		// The other direction of the same drift: a price left behind after a
		// product was removed from the seed is dead config that reads as coverage.
		const slugs = new Set(seededProductSlugs(seedPath));
		expect(Object.keys(DEMO_PRICING).filter((s) => !slugs.has(s))).toEqual([]);
	});

	test("SKUs are unique — the store enforces one live product per SKU and would 409 the second", () => {
		const skus = Object.values(DEMO_PRICING).map((p) => p.sku);
		expect(new Set(skus).size).toBe(skus.length);
	});
});
