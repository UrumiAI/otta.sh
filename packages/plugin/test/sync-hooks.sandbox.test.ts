import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

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

const PRICED_ROW = {
	productId: "prod-x",
	sku: "SKU-1",
	price: { amount: 1500, currency: "USD" },
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

/** The widget's per-`action_id` `commerce` field bag, as em-dash persists it
 *  into `content.data.commerce`. */
function commerceBag(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sku: "SKU-1",
		price: 1500,
		currency: "USD",
		onHand: 5,
		productKind: "physical",
		...overrides,
	};
}

/** The product title, which lives at `content.data.title` — NOT at the top
 *  level. em-dash's `ContentItem` (`packages/core/src/database/repositories/
 *  types.ts`) has no `title` member at all: `mapRow()` puts every column that is
 *  not in `SYSTEM_COLUMNS` into `data`, and `title` is an ordinary user-defined
 *  collection field (see `sites/staging/seed/seed.json`, which declares it on
 *  `products`). `contentItemToRecord = { ...item }` passes that item through
 *  verbatim, so a hook payload carries `data.title`, never `content.title`. */
const TITLE = "Blue Mug";

/** A saved products content record — the shape `content:afterSave` actually
 *  receives (`contentItemToRecord(item)`). BOTH the title and the widget's
 *  `commerce` bag live under `data`, side by side, exactly as em-dash stores
 *  them. Pass `title: null` for a collection entry whose title column is
 *  null/absent: `mapRow()` EXCLUDES null values from `data`, so that surfaces to
 *  the plugin as a MISSING key, never an explicit `null`. */
function productContent(
	id: string,
	bag: Record<string, unknown> | undefined,
	extra: Record<string, unknown> = {},
	title: string | null = TITLE,
): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	if (title !== null) data["title"] = title;
	if (bag !== undefined) data["commerce"] = bag;
	return {
		id,
		updatedAt: WM,
		...(Object.keys(data).length > 0 ? { data } : {}),
		...extra,
	};
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

describe("sync hooks — afterSave derives product_commerce from the widget's commerce JSON (issue #81, workerd sandbox)", () => {
	test("valid commerce JSON → upserts the derived commercial fields (integer minor units) + ordering watermark", async () => {
		const { stubServer, sandboxHandle } = await setup();
		let putBody: unknown;
		stubServer.respondWith("PUT", (req) => {
			putBody = req.body;
			return { status: 200, body: PRICED_ROW };
		});

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-1", commerceBag()),
			collection: "products",
			isNew: false,
		});

		expect(outcome).toEqual({ result: null });
		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toBe("/products/prod-1/commerce");
		expect(puts[0]?.headers["idempotency-key"]).toBeTruthy();
		// Derived: sku, integer-minor-units price + currency, the content's
		// `data.title`, kind, initial stock, and the ordering watermark. NEVER
		// active/deletedAt.
		expect(putBody).toEqual({
			sku: "SKU-1",
			price: { amount: 1500, currency: "USD" },
			title: TITLE,
			productKind: "physical",
			initialOnHand: 5,
			contentUpdatedAt: WM,
		});
	});

	test("replay with the SAME updatedAt derives the SAME idempotency key (upserts once); a newer edit derives a DIFFERENT key", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-2", commerceBag()),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-2", commerceBag()),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-2", commerceBag({ price: 2000 }), {
				updatedAt: "2026-07-10T01:00:00.000Z",
			}),
			collection: "products",
			isNew: false,
		});

		const keys = putRequests(stubServer).map((r) => r.headers["idempotency-key"]);
		expect(keys).toHaveLength(3);
		expect(keys[0]).toBe(keys[1]); // same updatedAt → same key → store dedupes.
		expect(keys[2]).not.toBe(keys[0]); // newer updatedAt → fresh key → applies.
	});

	test("MONEY INTEGRITY: a FLOAT price is rejected — the whole upsert is skipped, the CMS save still succeeds (no float reaches money)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-float", commerceBag({ price: 19.99 })),
			collection: "products",
			isNew: false,
		});

		expect(outcome).toEqual({ result: null }); // resolves — never fails the CMS save.
		expect(putRequests(stubServer)).toHaveLength(0); // nothing reached the service.
	});

	test("an invalid currency is rejected — no upsert, CMS save still succeeds", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-cur", commerceBag({ currency: "usd" })),
			collection: "products",
			isNew: false,
		});

		expect(putRequests(stubServer)).toHaveLength(0);
	});

	test("missing/empty sku → the upsert is skipped (no partial row minted)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		// sku absent entirely…
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-nosku", { price: 1500, currency: "USD" }),
			collection: "products",
			isNew: false,
		});
		// …and sku present-but-empty.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-emptysku", commerceBag({ sku: "" })),
			collection: "products",
			isNew: false,
		});

		expect(putRequests(stubServer)).toHaveLength(0);
	});

	test("no commerce field at all → nothing to derive (create-then-price): no upsert", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-bare", undefined),
			collection: "products",
			isNew: true,
		});

		expect(putRequests(stubServer)).toHaveLength(0);
	});

	test("STOCK NOT CLOBBERED: on-hand rides as create-if-absent `initialOnHand`, re-sent on every save — never an absolute overwrite", async () => {
		const { stubServer, sandboxHandle } = await setup();
		const bodies: unknown[] = [];
		stubServer.respondWith("PUT", (req) => {
			bodies.push(req.body);
			return { status: 200, body: PRICED_ROW };
		});

		// First save creates; a second, newer save re-sends the same stock figure.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-stock", commerceBag({ onHand: 7 })),
			collection: "products",
			isNew: true,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-stock", commerceBag({ onHand: 7 }), {
				updatedAt: "2026-07-10T02:00:00.000Z",
			}),
			collection: "products",
			isNew: false,
		});

		// The wire only ever carries `initialOnHand` — the create-if-absent seed
		// the service refuses to apply over an existing/decremented on_hand
		// (INSERT … ON CONFLICT (sku) DO NOTHING; proven by @urumi/domain's
		// inventory-store contract). There is NO "set on_hand" field, so a re-save
		// structurally cannot overwrite inventory-managed stock.
		for (const b of bodies) {
			expect(b).toHaveProperty("initialOnHand", 7);
			expect(b).not.toHaveProperty("onHand");
			expect(b).not.toHaveProperty("setOnHand");
		}
	});

	// -- TITLE SYNC: the order-line snapshot the plugin never sent -------------
	// Confirmed live: a product created through the CMS was born with
	// `product_commerce.title = NULL`, and `createOrderFromCart` rejects a null
	// title with PRODUCT_NOT_PRICED — the product was PERMANENTLY UNPURCHASABLE
	// and the buyer saw a checkout failure. The title is not a widget field and
	// not a top-level hook field either: it is a user-defined collection field,
	// so it arrives at `content.data.title` (see `productContent` above).
	test("TITLE SYNC REGRESSION: the upsert carries data.title (a NULL title makes checkout fail with PRODUCT_NOT_PRICED)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-title", commerceBag()),
			collection: "products",
			isNew: true,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toMatchObject({ title: TITLE });
	});

	test("data.title is the SINGLE source of truth — a hand-written commerce.title in the widget bag never overrides it (no storefront/order-line drift)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent(
				"prod-override",
				commerceBag({ title: "Sneaky Override" }),
				{},
				"  Blue Mug  ",
			),
			collection: "products",
			isNew: false,
		});

		const body = putRequests(stubServer)[0]?.body as Record<string, unknown>;
		// Trimmed, and taken from `data.title` — never the widget bag.
		expect(body["title"]).toBe("Blue Mug");
	});

	// THE LOAD-BEARING GUARD (review): an unusable title must NEVER block the
	// rest of the sync. Price/SKU/stock sync correctly today; if a title problem
	// could veto the upsert, then any collection whose title field is missing or
	// named something else would silently lose ALL commerce sync — a far worse
	// regression than the unpurchasable-product bug this change fixes. So the
	// title is BEST-EFFORT: omitted from the body and logged, never fatal. The
	// store PRESERVES a previously-stored title when the field is omitted, so
	// this can never erase a good title either.
	test("an EMPTY / whitespace-only / ABSENT data.title never blocks the sync — price, sku and stock still upsert, only `title` is omitted", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		for (const [id, title] of [
			["prod-empty-title", ""],
			["prod-blank-title", "   \t "],
			// `mapRow` drops null columns from `data`, so a null title column and a
			// collection with no `title` field at all look identical here.
			["prod-absent-title", null],
		] as const) {
			const outcome = await sandboxHandle.invokeHook("content:afterSave", {
				content: productContent(id, commerceBag(), {}, title),
				collection: "products",
				isNew: false,
			});
			expect(outcome).toEqual({ result: null }); // never fails the CMS save.
		}

		// …and a collection that declares `title` as something other than a string
		// (em-dash field types are the merchant's choice) is the same non-fatal case.
		const numeric = productContent("prod-numeric-title", commerceBag(), {}, null);
		(numeric["data"] as Record<string, unknown>)["title"] = 42;
		await sandboxHandle.invokeHook("content:afterSave", {
			content: numeric,
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(4);
		for (const put of puts) {
			const body = (put.body ?? {}) as Record<string, unknown>;
			// The commercial fields still land…
			expect(body).toMatchObject({ sku: "SKU-1", price: { amount: 1500, currency: "USD" } });
			// …and no empty/blank title is sent (the service would 400 on `""`,
			// turning a content problem into a TRANSPORT failure — which at publish
			// fails closed and skips the activate).
			expect(body).not.toHaveProperty("title");
		}
	});

	test("a title longer than the service's 500-char limit is omitted, not sent — a data problem must never become a 400/transport failure", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		// Exactly at the limit still carries the title; one over omits it.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-title-500", commerceBag(), {}, "T".repeat(500)),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-title-501", commerceBag(), {}, "T".repeat(501)),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(2); // both still sync their commercial fields.
		expect(puts[0]?.body).toMatchObject({ title: "T".repeat(500) });
		expect(puts[1]?.body).not.toHaveProperty("title");
	});

	test("PRICE-ONLY SAVE: a save that changes nothing but the price still syncs exactly as before (the title rides along, it never gates)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-reprice", commerceBag({ price: 2500 }), {
				updatedAt: "2026-07-10T04:00:00.000Z",
			}),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toEqual({
			sku: "SKU-1",
			price: { amount: 2500, currency: "USD" },
			title: TITLE,
			productKind: "physical",
			initialOnHand: 5,
			contentUpdatedAt: "2026-07-10T04:00:00.000Z",
		});
	});

	test("HEAL ON RE-SAVE: an existing NULL-title row gets its title on the merchant's next save (a fresh updatedAt ⇒ a fresh idempotency key ⇒ the upsert applies)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		// The row already exists, created before title sync (title NULL at the
		// service). em-dash bumps `updated_at` on EVERY content write, so the
		// merchant's next save carries a strictly newer watermark…
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-heal", commerceBag(), {
				updatedAt: "2026-07-10T03:00:00.000Z",
			}),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		// …carrying the title, so the store's DO UPDATE SET writes it (the upsert
		// only PRESERVES title when the field is omitted).
		expect(puts[0]?.body).toMatchObject({ title: TITLE });
		expect(puts[0]?.headers["idempotency-key"]).toBe("products:prod-heal:2026-07-10T03:00:00.000Z");

		// HONEST LIMIT: a REDELIVERY of the same save (same updatedAt) derives the
		// same key and the store dedupes it — a redelivery does not heal. Only a
		// real save/publish (which always bumps updatedAt) does.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-heal", commerceBag(), {
				updatedAt: "2026-07-10T03:00:00.000Z",
			}),
			collection: "products",
			isNew: false,
		});
		const keys = putRequests(stubServer).map((r) => r.headers["idempotency-key"]);
		expect(new Set(keys).size).toBe(1);
	});

	// -- issue #82: afterSave activates an already-published product ------------
	test("a PUBLISHED product is activated in the same save — through the guarded /activate, never an `active` field on the upsert (soft-delete hazard closed)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-pub", commerceBag(), { status: "published" }),
			collection: "products",
			isNew: false,
		});

		// Upsert first…
		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(1);
		const body = (puts[0]?.body ?? {}) as Record<string, unknown>;
		expect(body).not.toHaveProperty("active");
		expect(body).not.toHaveProperty("deletedAt");
		// …then the guarded activate carrying the ordering watermark. A soft-deleted
		// row is never resurrected — the store no-ops the flip on a tombstone.
		const acts = activatePosts(stubServer, "prod-pub");
		expect(acts).toHaveLength(1);
		expect(acts[0]?.body).toEqual({ contentUpdatedAt: WM });
		expect(acts[0]?.headers["idempotency-key"]).toBeTruthy();
	});

	test("a DRAFT (or status-less) product is NOT activated — the row stays inactive until publish", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-draft", commerceBag(), { status: "draft" }),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("prod-nostatus", commerceBag()),
			collection: "products",
			isNew: false,
		});

		expect(activatePosts(stubServer, "prod-draft")).toHaveLength(0);
		expect(activatePosts(stubServer, "prod-nostatus")).toHaveLength(0);
	});

	test("afterSave activation reuses the publish idempotency key — converges with content:afterPublish (one applied flip)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		const content = productContent("prod-conv", commerceBag(), { status: "published" });
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
			content: productContent("prod-5", commerceBag()),
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
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));
		stubServer.respondWith("DELETE", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: productContent("page-1", commerceBag()),
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
