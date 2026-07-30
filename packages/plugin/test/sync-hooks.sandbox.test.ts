import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * ONE HOME PER FIELD (PR 1b). These hooks used to derive a whole commerce bag
 * (sku, price, currency, stock, kind, tax class, dimensions) out of a
 * `commerce` JSON field on the content document, written by an on-screen
 * "Product data" Block Kit widget. That made the CMS a SECOND writer of
 * `product_commerce` and every publish reverted the admin console's edits.
 *
 * The bag is gone. What remains is LIFECYCLE + TITLE:
 *  - every save/publish of a products document upserts, so the row always
 *    exists and the product is visible in Pricing & inventory;
 *  - the upsert body carries the content's `data.title` and the ordering
 *    watermark, AND NOTHING ELSE — asserted here as a strict key set, which is
 *    the real regression guard for this merge;
 *  - activate / deactivate / soft-delete are unchanged.
 *
 * The deleted cases (float price, bad currency, missing sku, no commerce field,
 * stock-not-clobbered) all described the bag. The money-integrity guards they
 * carried survive at RUNTIME on the paths that still carry money: the service's
 * zod `int()` bounds on `upsertProductCommerceBody.price.amount`,
 * `editProductCommerceBody.price.amount`, `compareAtPrice` and `unitCost` reject
 * a float with a 400 before any domain code runs; the admin form parses minor
 * units by exact integer string math (`product-edit-money.test.ts`); and `Cents`
 * is branded.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** POST /activate requests recorded by the stub, for a given product id (#82). */
function activatePosts(stubServer: StubCommerceServer, id: string) {
	return stubServer.requests.filter(
		(r) => r.method === "POST" && r.url === `/products/${id}/commerce/activate`,
	);
}

function putRequests(stubServer: StubCommerceServer) {
	return stubServer.requests.filter((r) => r.method === "PUT");
}

/** Every commercial key the CMS path must NEVER put on the wire again. The
 *  first three are the headline (`sku`/`price`/`initialOnHand`); the rest are
 *  the remainder of the deleted widget bag. */
const COMMERCIAL_KEYS = [
	"sku",
	"price",
	"initialOnHand",
	"currency",
	"onHand",
	"productKind",
	"taxClass",
	"weightGrams",
	"lengthMm",
	"widthMm",
	"heightMm",
	"compareAtPrice",
	"unitCost",
	"inventoryPolicy",
] as const;

/** THE REGRESSION GUARD FOR PR 1b: the sync's wire body is title + watermark,
 *  as a STRICT key set. A subset check ("no sku key") would pass against a body
 *  that reintroduced some other commercial field, so assert the whole shape. */
function expectTitleOnlyBody(body: unknown, expected: Record<string, unknown>): void {
	expect(body).toEqual(expected);
	const keys = Object.keys((body ?? {}) as Record<string, unknown>);
	for (const banned of COMMERCIAL_KEYS) expect(keys).not.toContain(banned);
	// `active`/`deletedAt` are the lifecycle flags the upsert must never carry —
	// they are the guarded activate/deactivate/softDelete calls' business.
	expect(keys).not.toContain("active");
	expect(keys).not.toContain("deletedAt");
}

const BARE_ROW = {
	productId: "prod-x",
	sku: null,
	price: null,
	taxClass: null,
	weightGrams: null,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "physical",
	active: false,
	deletedAt: null,
	contentUpdatedAt: null,
	createdAt: "2026-07-10T00:00:00.000Z",
	updatedAt: "2026-07-10T00:00:00.000Z",
};

const WM = "2026-07-10T00:00:00.000Z";

/** The product title, which lives at `content.data.title` — NOT at the top
 *  level. em-dash's `ContentItem` (`packages/core/src/database/repositories/
 *  types.ts`) has no `title` member at all: `mapRow()` puts every column that is
 *  not in `SYSTEM_COLUMNS` into `data`, and `title` is an ordinary user-defined
 *  collection field (see `sites/staging/seed/seed.json`, which declares it on
 *  `products`). `contentItemToRecord = { ...item }` passes that item through
 *  verbatim, so a hook payload carries `data.title`, never `content.title`. */
const TITLE = "Blue Mug";

/** A saved products content record — the shape `content:afterSave` actually
 *  receives (`contentItemToRecord(item)`). Pass `title: null` for a collection
 *  entry whose title column is null/absent: `mapRow()` EXCLUDES null values from
 *  `data`, so that surfaces to the plugin as a MISSING key, never an explicit
 *  `null`.
 *
 *  `version` is emitted top-level by em-dash's `mapRow` and passed through by
 *  `contentItemToRecord = { ...item }`, so every hook sees it. It defaults to 1;
 *  tests modelling successive saves must BUMP IT rather than move `updatedAt`
 *  (0.31.1 freezes `updatedAt` on draft-only saves) — see `unpublishedDraft`. */
function productContent(
	id: string,
	extra: Record<string, unknown> = {},
	title: string | null = TITLE,
	extraData: Record<string, unknown> = {},
): Record<string, unknown> {
	const data: Record<string, unknown> = { ...extraData };
	if (title !== null) data["title"] = title;
	return {
		id,
		updatedAt: WM,
		version: 1,
		...(Object.keys(data).length > 0 ? { data } : {}),
		...extra,
	};
}

/**
 * A save of an UNPUBLISHED product on a revision-supporting collection — the
 * one shape whose sync `content:afterSave` still pushes immediately (publish
 * atomicity defers everything that is already live).
 *
 * `hasPendingDraft` is false here by clause 2: `draftRevisionId` is set but
 * `liveRevisionId` is null and `status` is not `"published"`.
 *
 * CRITICAL — this models em-dash **0.31.1**, not 0.29.0: since `8d6b20b`
 * ("draft-only saves no longer bump updated_at on published entries", #2143,
 * shipped 0.30.0) a save that resolves to a column no-op leaves `updated_at`
 * UNTOUCHED and bumps `version` only. So successive saves share one
 * `updatedAt` and are distinguished ONLY by `version`.
 */
function unpublishedDraft(
	id: string,
	version: number,
	title: string = TITLE,
): Record<string, unknown> {
	return productContent(
		id,
		{ status: "draft", liveRevisionId: null, draftRevisionId: `rev-${version}`, version },
		title,
	);
}

async function setup(): Promise<{ stubServer: StubCommerceServer; sandboxHandle: SandboxHandle }> {
	const stubServer = await startStubCommerceServer();
	cleanups.push(() => stubServer.close());
	const sandboxHandle = await loadPluginInSandbox({
		allowedHosts: [stubServer.host],
		commerceServiceBaseUrl: stubServer.baseUrl,
	});
	cleanups.push(() => sandboxHandle.close());
	return { stubServer, sandboxHandle };
}

describe("sync hooks — afterSave keeps product_commerce alive and its title current (PR 1b, workerd sandbox)", () => {
	test("a products save upserts the TITLE and the ordering watermark, and NOTHING commercial", async () => {
		const { stubServer, sandboxHandle } = await setup();
		let putBody: unknown;
		stubServer.respondWith("PUT", (req) => {
			putBody = req.body;
			return { status: 200, body: BARE_ROW };
		});

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-1"),
			collection: "products",
			isNew: false,
		});

		expect(outcome).toEqual({ result: null });
		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toBe("/products/prod-1/commerce");
		expect(puts[0]?.headers["idempotency-key"]).toBeTruthy();
		expectTitleOnlyBody(putBody, { title: TITLE, contentUpdatedAt: WM });
	});

	test("THE INVISIBLE-PRODUCT FIX: a save carrying nothing but a title still upserts — every CMS product gets a row", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		// Before 1b this returned early ("no commerce field" / "no sku"), so the
		// product had NO product_commerce row and was invisible in Pricing &
		// inventory — there was no way to price it from the console at all.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-bare"),
			collection: "products",
			isNew: true,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toBe("/products/prod-bare/commerce");
		expectTitleOnlyBody(puts[0]?.body, { title: TITLE, contentUpdatedAt: WM });
	});

	test("a stale `commerce` bag left on an OLD content document is IGNORED — a pre-upgrade site never re-clobbers the console", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		// em-dash's seed applier never deletes a field the seed stopped
		// declaring, so a site seeded before this release keeps an unbound
		// `commerce` json field holding the old bag (see the upgrade note). It
		// must not reach the wire.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-legacy", {}, TITLE, {
				commerce: { sku: "SKU-OLD", price: 9900, currency: "USD", onHand: 5 },
			}),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expectTitleOnlyBody(puts[0]?.body, { title: TITLE, contentUpdatedAt: WM });
	});

	test("REDELIVERY of the same save event derives the SAME idempotency key (store dedupes); a genuinely NEWER save derives a DIFFERENT key", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		// A redelivery is the IDENTICAL record replayed: em-dash captures one
		// `content` object per write and hands that same object to every hook
		// consumer (`runAfterSaveHooks`), with no DB re-read per delivery — so a
		// retry carries the same `updatedAt` AND the same `version`.
		const delivered = unpublishedDraft("prod-2", 3);
		await sandboxHandle.invokeHook("content:afterSave", {
			content: delivered,
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: delivered,
			collection: "products",
			isNew: false,
		});
		// A genuinely newer save. `updatedAt` is deliberately held CONSTANT: on
		// em-dash 0.31.1 a draft-only save is a column no-op and does not stamp
		// `updated_at` (8d6b20b, #2143) — only `version` moves.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: unpublishedDraft("prod-2", 4, "Blue Mug, Large"),
			collection: "products",
			isNew: false,
		});

		const keys = putRequests(stubServer).map((r) => r.headers["idempotency-key"]);
		expect(keys).toHaveLength(3);
		expect(keys[0]).toBe(keys[1]); // same delivery → same key → store dedupes.
		expect(keys[2]).not.toBe(keys[0]); // newer version → fresh key → applies.
	});

	test("0.31.1 FROZEN updatedAt: two successive draft saves with a CHANGED title BOTH apply (emdash 8d6b20b / #2143)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		const putBodies: unknown[] = [];
		stubServer.respondWith("PUT", (req) => {
			putBodies.push(req.body);
			return { status: 200, body: BARE_ROW };
		});

		// On em-dash 0.31.1 BOTH saves carry the identical `updatedAt` (the draft
		// save is a column no-op, so `updated_at` is never stamped); only
		// `version` advances.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: unpublishedDraft("prod-frozen", 2, "Blue Mug"),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: unpublishedDraft("prod-frozen", 3, "Cobalt Mug"),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(2);
		// Both saves carried the SAME watermark — the freeze this test exists for.
		expect(putBodies).toEqual([
			{ title: "Blue Mug", contentUpdatedAt: WM },
			{ title: "Cobalt Mug", contentUpdatedAt: WM },
		]);
		// THE ASSERTION THAT MATTERS: distinct keys. `upsert` no-ops the second
		// write when the key repeats (`WHERE product_commerce.idempotency_key
		// != :key`), so an identical key here means the merchant's rename is
		// SILENTLY DROPPED. Deriving from `updatedAt` alone does exactly that on
		// em-dash >= 0.30.0. It is also why the key must NOT become
		// payload-derived: a same-key no-op suppresses the whole DO UPDATE SET,
		// including `content_updated_at`, freezing the ordering watermark.
		const keys = puts.map((r) => r.headers["idempotency-key"]);
		expect(keys[0]).not.toBe(keys[1]);
	});

	// -- TITLE SYNC: the order-line snapshot, and now the ONLY synced field ----
	// SINCE PR 1c THIS BLOCK IS LOAD-BEARING FOR ADR-0013. It is the positive
	// statement of the decision: the content sync is the SOLE writer of
	// `product_commerce.title`, so if these cases stop asserting that the PUT
	// carries `data.title`, nothing writes the column at all and every order line
	// is born untitled. (The stored-value half — the PUT actually landing a title
	// in the row — is asserted against a live server + Postgres in
	// `packages/service/test/admin-product-edit-http.test.ts`, alongside the
	// negative case that the admin PATCH cannot.)
	//
	// Confirmed live: a product created through the CMS was born with
	// `product_commerce.title = NULL`, and `createOrderFromCart` rejects a null
	// title with PRODUCT_NOT_PRICED — the product was PERMANENTLY UNPURCHASABLE
	// and the buyer saw a checkout failure. The title is a user-defined
	// collection field, so it arrives at `content.data.title`.
	test("TITLE SYNC REGRESSION: the upsert carries data.title (a NULL title makes checkout fail with PRODUCT_NOT_PRICED)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-title"),
			collection: "products",
			isNew: true,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toMatchObject({ title: TITLE });
	});

	test("data.title is the SINGLE source of truth, and it is TRIMMED", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-trim", {}, "  Blue Mug  "),
			collection: "products",
			isNew: false,
		});

		const body = putRequests(stubServer)[0]?.body as Record<string, unknown>;
		expect(body["title"]).toBe("Blue Mug");
	});

	// THE LOAD-BEARING GUARD (review): an unusable title must NEVER block the
	// sync. If a title problem could veto the upsert, then any collection whose
	// title field is missing or named something else would silently lose its
	// product_commerce row entirely — the product would vanish from Pricing &
	// inventory, which is a worse regression than an untitled product.
	test("an EMPTY / whitespace-only / ABSENT data.title never blocks the sync — the row is still upserted, only `title` is omitted", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		for (const [id, title] of [
			["prod-empty-title", ""],
			["prod-blank-title", "   \t "],
			// `mapRow` drops null columns from `data`, so a null title column and a
			// collection with no `title` field at all look identical here.
			["prod-absent-title", null],
		] as const) {
			const outcome = await sandboxHandle.invokeHook("content:afterSave", {
				content: productContent(id, {}, title),
				collection: "products",
				isNew: false,
			});
			expect(outcome).toEqual({ result: null }); // never fails the CMS save.
		}

		// …and a collection that declares `title` as something other than a string
		// (em-dash field types are the merchant's choice) is the same non-fatal case.
		const numeric = productContent("prod-numeric-title", {}, null);
		numeric["data"] = { title: 42 };
		await sandboxHandle.invokeHook("content:afterSave", {
			content: numeric,
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(4);
		for (const put of puts) {
			// The row is still created — the watermark rides alone — and no
			// empty/blank title is sent (the service would 400 on `""`, turning a
			// content problem into a TRANSPORT failure, which at publish fails
			// closed and skips the activate).
			expectTitleOnlyBody(put.body, { contentUpdatedAt: WM });
		}
	});

	test("a title longer than the service's 500-char limit is omitted, not sent — a data problem must never become a 400/transport failure", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		// Exactly at the limit still carries the title; one over omits it.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-title-500", {}, "T".repeat(500)),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-title-501", {}, "T".repeat(501)),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(2); // both still keep the row alive.
		expect(puts[0]?.body).toMatchObject({ title: "T".repeat(500) });
		expect(puts[1]?.body).not.toHaveProperty("title");
	});

	test("HEAL ON RE-SAVE: an existing NULL-title row gets its title on the merchant's next save (a fresh updatedAt ⇒ a fresh idempotency key ⇒ the upsert applies)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));

		// The row already exists, created before title sync (title NULL at the
		// service). em-dash bumps `updated_at` on EVERY content write, so the
		// merchant's next save carries a strictly newer watermark…
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-heal", { updatedAt: "2026-07-10T03:00:00.000Z" }),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		// …carrying the title, so the store's DO UPDATE SET writes it (the upsert
		// only PRESERVES title when the field is omitted).
		expect(puts[0]?.body).toMatchObject({ title: TITLE });
		expect(puts[0]?.headers["idempotency-key"]).toBe(
			"products:prod-heal:2026-07-10T03:00:00.000Z:1",
		);

		// HONEST LIMIT: a REDELIVERY of the same save (same updatedAt) derives the
		// same key and the store dedupes it — a redelivery does not heal. Only a
		// real save/publish (which always bumps updatedAt) does.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-heal", { updatedAt: "2026-07-10T03:00:00.000Z" }),
			collection: "products",
			isNew: false,
		});
		const keys = putRequests(stubServer).map((r) => r.headers["idempotency-key"]);
		expect(new Set(keys).size).toBe(1);
	});

	// -- issue #82: afterSave activates an already-published product ------------
	test("a PUBLISHED product is activated in the same save — through the guarded /activate, never an `active` field on the upsert (soft-delete hazard closed)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-pub", { status: "published" }),
			collection: "products",
			isNew: false,
		});

		// Upsert first…
		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expectTitleOnlyBody(puts[0]?.body, { title: TITLE, contentUpdatedAt: WM });
		// …then the guarded activate carrying the ordering watermark. A soft-deleted
		// row is never resurrected — the store no-ops the flip on a tombstone.
		const acts = activatePosts(stubServer, "prod-pub");
		expect(acts).toHaveLength(1);
		expect(acts[0]?.body).toEqual({ contentUpdatedAt: WM });
		expect(acts[0]?.headers["idempotency-key"]).toBeTruthy();
	});

	// §4.4 — THE STATE 1b CREATES. Before this merge a published, unpriced,
	// sku-less product got no row at all, so the activate had nothing to flip.
	// Now the row is minted first and the activate always lands: the product is
	// `active: true` while being unsellable. That is benign for purchasability
	// (the store's catalog read filters commerce-incomplete rows — pinned in
	// `product-commerce-store-contract.ts` against a real database, since a stub
	// recorder has no store to query) but it IS a new state, and the admin's
	// status column says "active (not priced)" because of it.
	test("§4.4 ACTIVATION CHANGE: publishing a product that was never priced now upserts a bare row AND activates it", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: productContent("prod-unpriced", { status: "published" }),
			collection: "products",
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		// The row carries NO sku and NO price — it is commerce-incomplete.
		expectTitleOnlyBody(puts[0]?.body, { title: TITLE, contentUpdatedAt: WM });
		expect(activatePosts(stubServer, "prod-unpriced")).toHaveLength(1);
		// Ordering is still load-bearing: `activate` no-ops on an unknown id, so
		// the upsert has to land first for the flip to mean anything.
		expect(stubServer.requests.indexOf(puts[0]!)).toBeLessThan(
			stubServer.requests.indexOf(activatePosts(stubServer, "prod-unpriced")[0]!),
		);
	});

	test("a DRAFT (or status-less) product is NOT activated — the row stays inactive until publish", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-draft", { status: "draft" }),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-nostatus"),
			collection: "products",
			isNew: false,
		});

		expect(activatePosts(stubServer, "prod-draft")).toHaveLength(0);
		expect(activatePosts(stubServer, "prod-nostatus")).toHaveLength(0);
	});

	test("afterSave activation reuses the publish idempotency key — converges with content:afterPublish (one applied flip)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		const content = productContent("prod-conv", { status: "published" });
		await sandboxHandle.invokeHook("content:afterSave", {
			content,
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content,
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterPublish", { content, collection: "products" });

		const keys = activatePosts(stubServer, "prod-conv").map((r) => r.headers["idempotency-key"]);
		expect(keys.length).toBeGreaterThanOrEqual(2);
		expect(new Set(keys).size).toBe(1); // all identical → one applied flip.
	});

	test("afterSave failure (503 from the service) does not throw into the CMS save path — the hook resolves", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 503, body: { error: "unavailable" } }));

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-5"),
			collection: "products",
			isNew: false,
		});

		expect(outcome).toEqual({ result: null }); // fire-and-forget.
	});

	test("content:afterDelete soft-deletes the product_commerce row via the stub service", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("DELETE", () => ({ status: 200, body: { ok: true } }));

		const outcome = await sandboxHandle.invokeHook("content:afterDelete", {
			id: "prod-3",
			collection: "products",
			permanent: false,
		});

		expect(outcome).toEqual({ result: null });
		const deletes = stubServer.requests.filter((r) => r.method === "DELETE");
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.url).toBe("/products/prod-3/commerce");
	});

	test("afterSave/afterDelete for a non-products collection are no-ops", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));
		stubServer.respondWith("DELETE", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("page-1"),
			collection: "pages",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterDelete", {
			id: "page-1",
			collection: "pages",
			permanent: false,
		});

		expect(stubServer.requests).toHaveLength(0);
	});
});
