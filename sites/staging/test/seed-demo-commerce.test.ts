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
	DEMO_PRICING,
	demoRows,
	fetchCmsProducts,
	parseExistingCommerce,
	priceBody,
	readCmsPage,
	restockBody,
	seededProductSlugs,
	seedOneProduct,
	shouldPrice,
	type CmsProductEntry,
	type CmsProductPage,
	type DemoRow,
	type ExistingCommerce,
} from "../scripts/seed-demo-commerce.js";

const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/seed.json");

/** The CMS's view of the seeded products. The ids are ULIDs, NOT the ids
 *  `seed.json` declares — em-dash's seed applier generates its own and keeps
 *  the declared id only as a seed-local reference. Modelled faithfully here
 *  because assuming otherwise is the bug this fixture exists to prevent. */
const CMS_ENTRIES: CmsProductEntry[] = [
	{ id: "01KYR4KC5KMBYF0EDDTZBNKDX2", slug: "otta-tee", title: "Otta Tee" },
	{ id: "01KYR4KC8GCRA5G8WXGK0K4MH6", slug: "otta-mug", title: "Otta Mug" },
	{ id: "01KYR4KCB1459ZG70HBMX6HM1F", slug: "otta-stickers", title: "Otta Sticker Pack" },
];

const CMS_PAGE: CmsProductPage = { entries: CMS_ENTRIES, unusable: [] };

const TEE: DemoRow = {
	id: "01KYR4KC5KMBYF0EDDTZBNKDX2",
	slug: "otta-tee",
	title: "Otta Tee",
	sku: "OTTA-TEE",
	price: { amount: 3200, currency: "USD" },
	initialOnHand: 25,
};

const AUTH = { Authorization: "Bearer test-token" };
const SITE = "http://site";
const ADMIN = `${SITE}/_emdash/api/plugins/otta/admin`;
const PUBLISH = `${SITE}/_emdash/api/content/products/${TEE.id}/publish`;

/** One recorded request, labelled by what it MEANS rather than by method — every
 *  in-process write is a POST, so "POST" alone no longer distinguishes a read
 *  from a price change. */
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
	/** "publish" | "read" | an action id — the step this request performs. */
	step: string;
}

/**
 * A recording stub for the SITE surface the script now talks to: the CMS publish
 * route and the plugin admin route.
 *
 * `reads` is the queue of `products.detail` answers, consumed in order — the
 * script reads THREE times on a first run (the re-run guard BEFORE any write,
 * then the row the publish created, then the stock watermark that only exists
 * after the sku does), and a single fixed answer would hide the difference
 * between them.
 */
function stubSite(reads: Array<ExistingCommerce | null>) {
	const calls: Recorded[] = [];
	const queue = [...reads];
	const detailEnvelope = (detail: ExistingCommerce | null): unknown =>
		detail === null
			? { ok: false, title: "Not found", description: "no commerce row" }
			: {
					ok: true,
					product: {
						productId: TEE.id,
						sku: detail.sku,
						active: detail.active,
						updatedAt: detail.updatedAt,
						onHand: detail.onHand,
					},
				};

	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
		const envelope = body as { type?: string; action_id?: string } | undefined;
		const step = url.endsWith("/publish")
			? "publish"
			: envelope?.type === "otta_console_read"
				? "read"
				: (envelope?.action_id ?? "(unknown)");
		calls.push({
			url,
			method: init?.method ?? "GET",
			headers: (init?.headers ?? {}) as Record<string, string>,
			body,
			step,
		});
		const data =
			step === "publish"
				? {}
				: step === "read"
					? detailEnvelope(queue.shift() ?? null)
					: { ok: true, notice: null };
		return new Response(JSON.stringify({ success: true, data }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { calls, fetchImpl, deps: { siteUrl: SITE, authHeaders: AUTH, fetchImpl } };
}

/** A row as the console detail reports it, with the fields the script reads. */
function detailRow(over: Partial<ExistingCommerce>): ExistingCommerce {
	return { sku: null, active: true, updatedAt: "2026-09-17T00:00:00.000Z", onHand: null, ...over };
}

/** THE THREE READS OF A FIRST RUN, as the real site answers them.
 *
 *  The FIRST read happens BEFORE any write at all (the re-run guard) and sees
 *  `null` — em-dash's seed applier fires no content hooks, so a seeded product
 *  has no `product_commerce` row yet. `BARE` is the SECOND read, after the
 *  publish fired the sync hook: a row with its title and `active`, and no sku,
 *  so no inventory record either (`onHand: null` is "no record", not zero).
 *  `PRICED` is the THIRD, after the sku exists: the stock record now does too,
 *  at a known zero, which is the watermark restock must carry. */
const BARE = detailRow({ sku: null, active: true, onHand: null });
const PRICED = detailRow({ sku: "OTTA-TEE", active: true, onHand: 0 });

describe("seed-demo-commerce", () => {
	test("the slug list comes FROM the seed file, not from a hard-coded list", () => {
		const slugs = seededProductSlugs(seedPath);
		expect(slugs.length).toBeGreaterThan(0);
		expect(new Set(slugs).size).toBe(slugs.length);
	});

	test("ids and titles come from the CMS, never from seed.json's declared `id`", () => {
		// `seed.json` says `product:otta-tee`; the content database says a ULID.
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

	test("EVERY console payload value is a STRING — a number is DROPPED, not coerced, and the product saves with no price", () => {
		// `readConsolePayload` keeps only string-valued keys. A numeric `price`
		// would not fail validation; the field would simply be absent, read as
		// "not in the form ⇒ preserve", and the product saved with a sku and no
		// price — listed, unbuyable, no error anywhere.
		for (const r of demoRows(seededProductSlugs(seedPath), CMS_PAGE)) {
			for (const body of [priceBody(r, "2026-01-01T00:00:00.000Z"), restockBody(r, 0)]) {
				for (const [key, value] of Object.entries(body)) {
					expect(typeof value, `${key} must cross as a string`).toBe("string");
				}
			}
		}
	});

	test("the price crosses as the decimal string the form would submit, round-tripping the minor units exactly", () => {
		expect(priceBody(TEE, "t")["price"]).toBe("32.00");
		expect(priceBody({ ...TEE, price: { amount: 600, currency: "USD" } }, "t")["price"]).toBe(
			"6.00",
		);
		expect(priceBody({ ...TEE, price: { amount: 1805, currency: "USD" } }, "t")["price"]).toBe(
			"18.05",
		);
	});

	test("NO `title` AND NO `active` on the write — both are CMS-owned and arrive via the publish", () => {
		// ADR-0013 / "one home per field": `ProductEditWire` has no member for
		// either, so putting them here would be a silently ignored payload key
		// AND a second writer of a field that has one home.
		const body = priceBody(TEE, "2026-01-01T00:00:00.000Z");
		expect(Object.keys(body).toSorted()).toEqual([
			"currency",
			"expectedUpdatedAt",
			"price",
			"productId",
			"sku",
		]);
	});

	test("expectedUpdatedAt is the read's own value — the write's concurrency precondition, never invented", () => {
		expect(priceBody(TEE, "2026-09-17T12:00:00.000Z")["expectedUpdatedAt"]).toBe(
			"2026-09-17T12:00:00.000Z",
		);
	});

	test("restock sends the OBSERVED count as the watermark and the demo quantity as qty", () => {
		// `onHand` is not the target. The route re-reads live and refuses if the
		// count moved, so sending `initialOnHand` here would either refuse or —
		// worse — pass and double the stock.
		expect(restockBody(TEE, 0)).toEqual({ productId: TEE.id, onHand: "0", qty: "25" });
	});

	// -- THE RE-RUN GUARD ------------------------------------------------------
	// The failure this prevents: a merchant reprices `otta-tee` to $50, someone
	// re-runs the quickstart to add a fourth demo product, and the tee silently
	// reverts to $32 with its sku reset. The route's derived idempotency key
	// CANNOT prevent it — the key is derived from the submitted payload, so a
	// re-run after a merchant's edit hashes differently and applies. `shouldPrice`
	// is the actual guard.

	test("shouldPrice: prices a missing row and a bare sku-less row; NEVER a row that already has a sku", () => {
		expect(shouldPrice(null)).toBe(true);
		expect(shouldPrice(detailRow({ sku: null, active: false }))).toBe(true);
		expect(shouldPrice(detailRow({ sku: "OTTA-TEE", active: true }))).toBe(false);
		expect(shouldPrice(detailRow({ sku: "MERCHANT-SKU", active: false }))).toBe(false);
	});

	test("FIRST RUN: read, publish, read, price, re-read, restock — in that order, on the SITE", async () => {
		// The order is the contract, not an implementation detail. The READ comes
		// first because the publish is a WRITE that opens the publish gate, and
		// doing it before the skip decision would re-activate a product a merchant
		// deliberately unpublished. The publish must precede pricing because
		// `updateProduct` answers `not_found` with no commerce row. The re-read must
		// come after pricing because giving the product a sku is what creates its
		// inventory record, so the `onHand` watermark restock needs does not exist
		// before it.
		const { calls, deps } = stubSite([null, BARE, PRICED]);
		const outcome = await seedOneProduct(TEE, deps);

		expect(outcome).toEqual({ kind: "priced", activated: true, stocked: 25 });
		expect(calls.map((c) => c.step)).toEqual([
			"read",
			"publish",
			"read",
			"products:save-identity",
			"read",
			"products:restock",
		]);
		expect(calls[1]?.url).toBe(PUBLISH);
		expect(calls.filter((_, i) => i !== 1).every((c) => c.url === ADMIN)).toBe(true);
		// NOTHING is addressed to a commerce service any more.
		expect(calls.some((c) => !c.url.startsWith(SITE))).toBe(false);
		expect(calls.every((c) => c.method === "POST")).toBe(true);
	});

	test("the publish carries NO BODY — a `publishedAt` would be a backdate this script has no business choosing", async () => {
		const { calls, deps } = stubSite([null, BARE, PRICED]);
		await seedOneProduct(TEE, deps);
		expect(calls[1]?.step).toBe("publish");
		expect(calls[1]?.body).toBeUndefined();
	});

	test("every write carries the CSRF header and the credential — a cookie run is 403 without it", async () => {
		// em-dash enforces `X-EmDash-Request: 1` on every non-GET /_emdash/api/*
		// request that authenticated with a session cookie. Bearer auth is exempt,
		// so sending it unconditionally is right for both and the script never has
		// to know which credential `cmsAuthHeaders` returned.
		const { calls, deps } = stubSite([null, BARE, PRICED]);
		await seedOneProduct(TEE, deps);
		for (const call of calls) {
			expect(call.headers["X-EmDash-Request"]).toBe("1");
			expect(call.headers["Authorization"]).toBe(AUTH.Authorization);
		}
	});

	test("RE-RUN over a merchant-priced product WRITES NOTHING — the price the merchant set survives", async () => {
		const { calls, deps } = stubSite([detailRow({ sku: "OTTA-TEE", active: true, onHand: 7 })]);
		const outcome = await seedOneProduct(TEE, deps);

		expect(outcome).toEqual({ kind: "skipped", reason: "already priced (sku OTTA-TEE)" });
		// NOTHING is written — not even the publish. One read, and out.
		expect(calls.map((c) => c.step)).toEqual(["read"]);
	});

	test("RE-RUN over a PRICED-BUT-INACTIVE row reports it distinctly — the skip must never read as success", async () => {
		// Priced and off sale is most likely a merchant who unpublished it on
		// purpose. The script does NOT heal it — re-flipping `active` would put
		// back on sale exactly what they took off it — so the contract is that it
		// SAYS so, distinctly enough that the summary cannot report success.
		const { calls, deps } = stubSite([detailRow({ sku: "OTTA-TEE", active: false, onHand: 3 })]);
		const outcome = await seedOneProduct(TEE, deps);

		expect(outcome).toEqual({
			kind: "skipped-inactive",
			reason: "already priced (sku OTTA-TEE) but NOT ACTIVE",
		});
		expect(calls.map((c) => c.step)).toEqual(["read"]);
	});

	test("RE-RUN over a PRICED-BUT-UNSTOCKED row reports it distinctly — priced, active and unbuyable is not success", async () => {
		// THE CRASH-BETWEEN-STEPS CASE (review round 4). A run that dies between
		// `products:save-identity` and `products:restock` leaves the product priced,
		// active, listed — and at zero stock, so every add-to-cart fails. On the
		// retry the sku makes `shouldPrice` false and the generic skip would report
		// it as "left as-is", which is the same "looks fine" lie the inactive branch
		// already exists to prevent. Structurally identical guard, on the stock axis:
		// SAY so, and write nothing (the stock is the merchant's to set).
		const { calls, deps } = stubSite([detailRow({ sku: "OTTA-TEE", active: true, onHand: 0 })]);
		const outcome = await seedOneProduct(TEE, deps);

		expect(outcome).toEqual({
			kind: "skipped-unstocked",
			reason: "already priced (sku OTTA-TEE) but ZERO STOCK",
		});
		expect(calls.map((c) => c.step)).toEqual(["read"]);
	});

	test("a priced row whose stock is UNKNOWN (`onHand: null`) is a plain skip, not a stranding report", async () => {
		// `null` is "no inventory record read", NOT zero — claiming a stranding on an
		// unreadable count would cry wolf on every run. Only a KNOWN zero strands.
		const { deps } = stubSite([detailRow({ sku: "OTTA-TEE", active: true, onHand: null })]);
		const outcome = await seedOneProduct(TEE, deps);
		expect(outcome).toEqual({ kind: "skipped", reason: "already priced (sku OTTA-TEE)" });
	});

	test("THE UNPUBLISH IS NOT UNDONE: no publish is sent for ANY product this script skips", async () => {
		// THE REGRESSION THIS PINS (review round 3, A1). A publish is not a probe:
		// `content:afterPublish` upserts the commerce row and opens the publish
		// gate, so publishing before the skip decision silently puts a merchant's
		// deliberately-unpublished product back on sale — the one thing the
		// operator-facing warning promises never happens. Asserted for BOTH skip
		// shapes, since only one of them is the dangerous one and a future edit
		// could reintroduce the publish on either path.
		for (const row of [
			detailRow({ sku: "OTTA-TEE", active: false, onHand: 3 }),
			detailRow({ sku: "OTTA-TEE", active: true, onHand: 7 }),
		]) {
			const { calls, deps } = stubSite([row]);
			await seedOneProduct(TEE, deps);
			expect(calls.some((c) => c.step === "publish")).toBe(false);
			expect(calls.some((c) => c.url === PUBLISH)).toBe(false);
		}
	});

	test("a product that ALREADY has stock is not restocked — the count would double", async () => {
		const { calls, deps } = stubSite([null, BARE, detailRow({ sku: "OTTA-TEE", onHand: 12 })]);
		const outcome = await seedOneProduct(TEE, deps);
		expect(outcome).toEqual({ kind: "priced", activated: true, stocked: 0 });
		expect(calls.map((c) => c.step)).not.toContain("products:restock");
	});

	test("a REFUSED action throws instead of being counted as priced", async () => {
		const { deps, fetchImpl: _f } = stubSite([null, BARE, PRICED]);
		void _f;
		const refusing = (async (input: string | URL | Request, init?: RequestInit) => {
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			if ((body as { action_id?: string } | undefined)?.action_id === "products:save-identity") {
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							ok: false,
							notice: { variant: "error", title: "Nope", description: "sku taken" },
						},
					}),
					{ status: 200 },
				);
			}
			return deps.fetchImpl(input as never, init as never);
		}) as unknown as typeof fetch;

		await expect(seedOneProduct(TEE, { ...deps, fetchImpl: refusing })).rejects.toThrow(
			/was refused: Nope — sku taken/,
		);
	});

	test("an action that answers ok:true with an ERROR NOTICE is still a refusal, not a success", async () => {
		// The console renders an error notice instead of a blank pane, so `ok:true`
		// only means the action ran. Counting that as priced is exactly the
		// "looks like it worked" outcome this script exists to prevent.
		const { deps } = stubSite([null, BARE, PRICED]);
		const noticing = (async (input: string | URL | Request, init?: RequestInit) => {
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			if ((body as { action_id?: string } | undefined)?.action_id === "products:save-identity") {
				return new Response(
					JSON.stringify({
						success: true,
						data: {
							ok: true,
							notice: { variant: "error", title: "Price", description: "must be positive" },
						},
					}),
					{ status: 200 },
				);
			}
			return deps.fetchImpl(input as never, init as never);
		}) as unknown as typeof fetch;

		await expect(seedOneProduct(TEE, { ...deps, fetchImpl: noticing })).rejects.toThrow(
			/reported an error: Price — must be positive/,
		);
	});

	test("a product with STILL no commerce row after the publish is an error, not a silent skip", async () => {
		// The publish is what creates the row, via the plugin's content sync hook.
		// If the row is still missing the hook did not run — which is what a build
		// left on `__OTTA_COMMERCE_MODE__ = "http"` looks like from here.
		const { deps } = stubSite([null, null, null]);
		await expect(seedOneProduct(TEE, deps)).rejects.toThrow(/still has no commerce row/);
	});

	test("a priced product with NO inventory record is an error — it would be listed and unbuyable", async () => {
		const { deps } = stubSite([null, BARE, detailRow({ sku: "OTTA-TEE", onHand: null })]);
		await expect(seedOneProduct(TEE, deps)).rejects.toThrow(/no inventory record to stock/);
	});

	// -- THE DETAIL PAYLOAD ----------------------------------------------------

	test("parseExistingCommerce reads the console's `{ok, product}` envelope", () => {
		expect(
			parseExistingCommerce(
				{
					ok: true,
					product: { sku: "S", active: true, updatedAt: "2026-01-01T00:00:00.000Z", onHand: 4 },
				},
				"p1",
			),
		).toEqual({ sku: "S", active: true, updatedAt: "2026-01-01T00:00:00.000Z", onHand: 4 });
		// `onHand: null` is "no inventory record", which is NOT zero.
		expect(
			parseExistingCommerce(
				{
					ok: true,
					product: {
						sku: null,
						active: false,
						updatedAt: "2026-01-01T00:00:00.000Z",
						onHand: null,
					},
				},
				"p1",
			),
		).toEqual({ sku: null, active: false, updatedAt: "2026-01-01T00:00:00.000Z", onHand: null });
	});

	test("a REFUSAL (`ok:false`, HTTP 200) means 'no row yet' — never 'already priced'", () => {
		// A refusal rides a 200, so the status code cannot be the discriminator.
		expect(parseExistingCommerce({ ok: false, title: "x", description: "y" }, "p1")).toBeNull();
		expect(parseExistingCommerce({ ok: true, product: null }, "p1")).toBeNull();
	});

	test("an UNRECOGNISED payload throws — it must never resolve to 'skip'", () => {
		// Skipping is the harmful direction: it is the one outcome that looks like
		// success. An unchecked cast would leave `sku` undefined, `shouldPrice`
		// would return false, and the quickstart would price NOTHING while
		// printing "3 left as-is (already priced)".
		expect(() => parseExistingCommerce({ ok: true, product: { sku: "S" } }, "p1")).toThrow(
			/no readable/,
		);
		expect(() =>
			parseExistingCommerce({ ok: true, product: { sku: 42, active: true, updatedAt: "t" } }, "p1"),
		).toThrow(/no readable/);
		expect(() =>
			parseExistingCommerce(
				{ ok: true, product: { sku: "S", active: true, updatedAt: "t", onHand: "lots" } },
				"p1",
			),
		).toThrow(/non-numeric/);
		expect(() => parseExistingCommerce({ product: { sku: "S" } }, "p1")).toThrow(
			/no `ok` discriminator/,
		);
		expect(() => parseExistingCommerce("nope", "p1")).toThrow(/not an object/);
		expect(() => parseExistingCommerce(null, "p1")).toThrow(/not an object/);
		// And the message names the product, so the operator knows which one.
		expect(() => parseExistingCommerce({ ok: true, product: 7 }, "prod-xyz")).toThrow(/prod-xyz/);
	});

	test("seedOneProduct surfaces an unrecognised detail payload instead of silently skipping", async () => {
		const { calls, deps } = stubSite([]);
		const garbage = (async (input: string | URL | Request, init?: RequestInit) => {
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			if ((body as { type?: string } | undefined)?.type === "otta_console_read") {
				return new Response(
					JSON.stringify({ success: true, data: { ok: true, product: { sku: "S" } } }),
					{
						status: 200,
					},
				);
			}
			return deps.fetchImpl(input as never, init as never);
		}) as unknown as typeof fetch;

		await expect(seedOneProduct(TEE, { ...deps, fetchImpl: garbage })).rejects.toThrow(
			/no readable/,
		);
		// The garbage stub answers the READ itself and delegates everything else to
		// the recording stub, so an EMPTY record is the proof: the run failed on the
		// first read — which is now the first call of all — and nothing was written,
		// publish included.
		expect(calls).toEqual([]);
	});

	test("a non-2xx from the site is an error naming the step — never a skip", async () => {
		const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
		await expect(
			seedOneProduct(TEE, { siteUrl: SITE, authHeaders: AUTH, fetchImpl: failing }),
		).rejects.toThrow(/reading otta-tee.*HTTP 500/s);
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
			demoRows(["otta-tee"], {
				entries: [],
				unusable: [{ slug: "otta-tee", reason: "no `title` field" }],
			}),
		).toThrow(/cannot use.*otta-tee.*no `title` field/s);
		expect(() => demoRows(["otta-tee"], { entries: [], unusable: [] })).toThrow(
			/returned no product/,
		);
	});

	test("fetchCmsProducts FOLLOWS THE CURSOR — a truncated read would look like a missing product", async () => {
		const pages = [
			{
				data: {
					items: [{ id: "a", slug: "otta-tee", data: { title: "Otta Tee" } }],
					nextCursor: "c1",
				},
			},
			{
				data: {
					items: [{ id: "b", slug: "otta-mug", data: { title: "Otta Mug" } }],
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
		expect(page.entries.map((e) => e.slug)).toEqual(["otta-tee", "otta-mug"]);
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
