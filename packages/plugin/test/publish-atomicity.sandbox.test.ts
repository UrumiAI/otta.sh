import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * PUBLISH ATOMICITY (plan §2): commerce data for content that is currently LIVE
 * is not pushed on save — it is derived and pushed at PUBLISH, in the same
 * operation that makes the content live.
 *
 * Why the existing `sync-hooks.sandbox.test.ts` never caught the bug: every one
 * of its fixtures omits the REVISION POINTER fields (`liveRevisionId` /
 * `draftRevisionId`) EmDash emits on a revision-supporting collection, so all of
 * them are "not a pending draft" and keep the pre-change behavior. That suite's
 * continued green IS the pointers-absent / older-host regression test; the
 * fixtures below are the ones that carry pointers.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** A draft save. EmDash 0.29.0 bumps `updated_at` unconditionally on every
 *  update (`content.ts` update(): `updated_at: now`), so a draft save DOES
 *  carry a fresh watermark — which is precisely why the pre-change hook leaked
 *  the draft price on every save, not just the first (plan §1.6). */
const T1 = "2026-07-26T10:00:00.000Z";
/** The publish, strictly newer (publish() bumps `updated_at` too, plan §1.5). */
const T2 = "2026-07-26T11:00:00.000Z";

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
	createdAt: T1,
	updatedAt: T1,
};

/** The widget's per-`action_id` commerce bag under `content.data.commerce`. */
function bag(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sku: "SKU-1",
		price: 1500,
		currency: "USD",
		onHand: 5,
		productKind: "physical",
		...overrides,
	};
}

const OLD_BAG = bag({ price: 1000 });

/** The product title, which lives at `content.data.title` alongside `commerce`
 *  — NOT at the top level. em-dash's `ContentItem` has no `title` member;
 *  `mapRow()` puts every non-`SYSTEM_COLUMNS` column into `data`, and `title` is
 *  an ordinary user-defined collection field (`sites/staging/seed/seed.json`
 *  declares it on `products`). It is the value an order line snapshots at
 *  purchase time, and its absence is why a product is unpurchasable
 *  (`PRODUCT_NOT_PRICED`). */
const TITLE = "Blue Mug";

/** A save that staged a PENDING DRAFT over live content: EmDash's
 *  `published_with_changes` (status stays "published"; the two revision
 *  pointers diverge), with `content.data` already hydrated FROM THE DRAFT by
 *  `hydrateDraftData` before the hook fires. */
function pendingDraft(id: string, commerce: Record<string, unknown>): Record<string, unknown> {
	return {
		id,
		updatedAt: T1,
		status: "published",
		liveRevisionId: "rev-live",
		draftRevisionId: "rev-draft",
		data: { title: TITLE, commerce },
		liveData: { title: TITLE, commerce: OLD_BAG },
	};
}

/** The §2.2 clause-2 hole: `create()` accepts `status` verbatim and its INSERT
 *  never sets `live_revision_id`, so an API/CLI/import create-with-published
 *  yields a row that is live BY STATUS with no live-revision pointer. */
function importedLive(id: string, commerce: Record<string, unknown>): Record<string, unknown> {
	return {
		id,
		updatedAt: T1,
		status: "published",
		liveRevisionId: null,
		draftRevisionId: "rev-draft",
		data: { title: TITLE, commerce },
	};
}

/** A live product with NO pending draft — the state `publish()` leaves behind
 *  (`draft_revision_id = NULL`), so `content.data` IS the published data. */
function publishedClean(
	id: string,
	commerce: Record<string, unknown> | undefined,
	updatedAt: string,
): Record<string, unknown> {
	return {
		id,
		updatedAt,
		status: "published",
		liveRevisionId: "rev-live",
		draftRevisionId: null,
		data: { title: TITLE, ...(commerce !== undefined ? { commerce } : {}) },
	};
}

function putRequests(stubServer: StubCommerceServer, id?: string) {
	return stubServer.requests.filter(
		(r) => r.method === "PUT" && (id === undefined || r.url === `/products/${id}/commerce`),
	);
}

function activatePosts(stubServer: StubCommerceServer, id: string) {
	return stubServer.requests.filter(
		(r) => r.method === "POST" && r.url === `/products/${id}/commerce/activate`,
	);
}

function deactivatePosts(stubServer: StubCommerceServer, id: string) {
	return stubServer.requests.filter(
		(r) => r.method === "POST" && r.url === `/products/${id}/commerce/deactivate`,
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
	stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));
	stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));
	return { stubServer, sandboxHandle };
}

describe("publish atomicity — live commerce changes only at publish (workerd sandbox)", () => {
	test("T1 BUG REPRO: a draft save of a PUBLISHED product pushes NO commerce", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p1", bag({ price: 9900 })),
			collection: "products",
			isNew: false,
		});

		// The merchant's new price does NOT reach the storefront while the live
		// content still reads the old title.
		expect(putRequests(stubServer)).toEqual([]);
		expect(outcome).toEqual({ result: null }); // still fire-and-forget.
	});

	test("T2 publish applies content + commerce TOGETHER — upsert BEFORE activate", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p1", bag({ price: 9900 })),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p1", bag({ price: 9900 }), T2),
			collection: "products",
		});

		const puts = putRequests(stubServer, "p1");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toEqual({
			sku: "SKU-1",
			price: { amount: 9900, currency: "USD" },
			title: TITLE,
			productKind: "physical",
			initialOnHand: 5,
			contentUpdatedAt: T2,
		});
		const acts = activatePosts(stubServer, "p1");
		expect(acts).toHaveLength(1);
		// A row is NEVER made live ahead of its price.
		expect(stubServer.requests.indexOf(puts[0]!)).toBeLessThan(
			stubServer.requests.indexOf(acts[0]!),
		);
	});

	test("T3 the publish-time upsert carries the PUBLISH watermark, not the draft save's", async () => {
		const { stubServer, sandboxHandle } = await setup();

		// A pre-change save at T1 would have keyed the upsert on T1; assert the
		// publish's key/watermark are the publish's own, strictly newer, values.
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p3", bag({ price: 9900 }), T2),
			collection: "products",
		});

		const put = putRequests(stubServer, "p3")[0];
		expect(put?.body).toMatchObject({ contentUpdatedAt: T2 });
		expect(T2 > T1).toBe(true);
		expect(put?.headers["idempotency-key"]).toBe(`products:p3:${T2}`);
		expect(put?.headers["idempotency-key"]).not.toBe(`products:p3:${T1}`);
	});

	test("T4 a NEVER-PUBLISHED draft save still syncs immediately (the row must exist for the console)", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: {
				id: "p4",
				updatedAt: T1,
				status: "draft",
				liveRevisionId: null,
				draftRevisionId: "rev-1",
				data: { title: TITLE, commerce: bag() },
			},
			collection: "products",
			isNew: true,
		});

		expect(putRequests(stubServer, "p4")).toHaveLength(1);
		expect(activatePosts(stubServer, "p4")).toHaveLength(0); // nothing live yet.
	});

	test("T5 a collection WITHOUT draft revisions syncs on save even when published", async () => {
		const { stubServer, sandboxHandle } = await setup();

		// No `"revisions"` in `supports` ⇒ the save writes the live columns
		// directly and `draftRevisionId` is always null. There a save IS the live
		// change, so upsert + activate must still fire on save.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: publishedClean("p5", bag(), T1),
			collection: "products",
			isNew: false,
		});

		expect(putRequests(stubServer, "p5")).toHaveLength(1);
		expect(activatePosts(stubServer, "p5")).toHaveLength(1);
	});

	test("T6 draftRevisionId === liveRevisionId is NOT a pending draft", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: {
				id: "p6",
				updatedAt: T1,
				status: "published",
				liveRevisionId: "rev-same",
				draftRevisionId: "rev-same",
				data: { title: TITLE, commerce: bag() },
			},
			collection: "products",
			isNew: false,
		});

		expect(putRequests(stubServer, "p6")).toHaveLength(1);
	});

	test("T7 STOCK defers with the rest and applies at publish as the create-if-absent seed", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p7", bag({ onHand: 50 })),
			collection: "products",
			isNew: false,
		});
		expect(putRequests(stubServer, "p7")).toHaveLength(0);

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p7", bag({ onHand: 50 }), T2),
			collection: "products",
		});

		const body = putRequests(stubServer, "p7")[0]?.body as Record<string, unknown>;
		// Still the create-if-absent SEED, never an absolute stock write — real
		// restocking has its own content-free path (the Pricing & inventory
		// console's restock action), untouched by this change.
		expect(body).toHaveProperty("initialOnHand", 50);
		expect(body).not.toHaveProperty("onHand");
		expect(body).not.toHaveProperty("setOnHand");
	});

	test("T8 unpublish deactivates and pushes NO commerce", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterUnpublish", {
			content: publishedClean("p8", bag(), T2),
			collection: "products",
		});

		expect(putRequests(stubServer, "p8")).toHaveLength(0);
		expect(deactivatePosts(stubServer, "p8")).toHaveLength(1);
	});

	test("T9 after unpublish a save syncs again; republish re-applies + reactivates", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterUnpublish", {
			content: publishedClean("p9", bag(), T1),
			collection: "products",
		});
		// unpublish() clears BOTH the live pointer and the status, so the
		// predicate is false — nothing is live to protect.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: {
				id: "p9",
				updatedAt: T1,
				status: "draft",
				liveRevisionId: null,
				draftRevisionId: "rev-2",
				data: { title: TITLE, commerce: bag({ price: 2500 }) },
			},
			collection: "products",
			isNew: false,
		});
		expect(putRequests(stubServer, "p9")).toHaveLength(1);

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p9", bag({ price: 2500 }), T2),
			collection: "products",
		});
		expect(putRequests(stubServer, "p9")).toHaveLength(2);
		expect(activatePosts(stubServer, "p9")).toHaveLength(1);
	});

	test("T10 VALIDATION failure at publish: commerce unchanged, content STILL activates", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const outcome = await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p10", bag({ price: 19.99 }), T2),
			collection: "products",
		});

		// The content is valid and the merchant asked for it to be live; refusing
		// to activate would let a pricing typo silently unpublish a live product.
		// With no valid price the row simply is not purchasable (joinProduct's
		// `purchasable ⟺ present && active`).
		expect(putRequests(stubServer, "p10")).toHaveLength(0);
		expect(activatePosts(stubServer, "p10")).toHaveLength(1);
		expect(outcome).toEqual({ result: null });
	});

	test("T11 TRANSPORT failure at publish FAILS CLOSED: no activate", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 503, body: { error: "unavailable" } }));

		const outcome = await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p11", bag({ price: 9900 }), T2),
			collection: "products",
		});

		// Never make a row live whose commerce we could not write. (The handler
		// logs a distinct "commerce upsert FAILED … activation skipped
		// (fail-closed)" line; the workerd child's console is not observable
		// across the sandbox boundary, so the behavior is what is pinned here.)
		expect(activatePosts(stubServer, "p11")).toHaveLength(0);
		expect(outcome).toEqual({ result: null }); // never throws into the CMS publish path.
	});

	test("T12 replay: the upsert key and the activate key are distinct, and both stable across deliveries", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const content = publishedClean("p12", bag({ price: 9900 }), T2);
		await sandboxHandle.invokeHook("content:afterPublish", { content, collection: "products" });
		await sandboxHandle.invokeHook("content:afterPublish", { content, collection: "products" });

		const putKeys = putRequests(stubServer, "p12").map((r) => r.headers["idempotency-key"]);
		const actKeys = activatePosts(stubServer, "p12").map((r) => r.headers["idempotency-key"]);
		expect(putKeys).toHaveLength(2);
		expect(actKeys).toHaveLength(2);
		expect(new Set(putKeys).size).toBe(1); // stable across deliveries.
		expect(new Set(actKeys).size).toBe(1);
		expect(putKeys[0]).not.toBe(actKeys[0]); // disjoint key-spaces.
		// §2.9 nuance — `product_commerce` carries ONE idempotency_key column and
		// `activate` OVERWRITES it. On a FIRST publish the activate applies, so
		// the column ends up holding the activate key and a redelivered
		// afterPublish RE-APPLIES the upsert (no commerce-field change, but
		// `updated_at` moves — see F7). On a publish-of-pending-changes the row
		// is already active, the activate guard no-ops, the column keeps the
		// upsert key, and the redelivery dedupes correctly.
	});

	test("T13 afterPublish for a non-products collection is a no-op", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("page-1", bag(), T2),
			collection: "pages",
		});

		expect(stubServer.requests).toHaveLength(0);
	});

	test("T14 afterPublish with NO commerce field still activates and upserts nothing", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p14", undefined, T2),
			collection: "products",
		});

		expect(putRequests(stubServer, "p14")).toHaveLength(0);
		expect(activatePosts(stubServer, "p14")).toHaveLength(1);
	});

	test("T15 a pending-draft save sends NOTHING live-affecting — no upsert AND no activate", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p15", bag({ price: 9900 })),
			collection: "products",
			isNew: false,
		});

		// An activate is itself a live-affecting flip: on a pending-draft save of
		// a row that was deactivated it would re-latch the product purchasable at
		// the stale price with no publish.
		expect(putRequests(stubServer, "p15")).toHaveLength(0);
		expect(activatePosts(stubServer, "p15")).toHaveLength(0);
	});

	test("T16 §2.2 hole: an imported / create-with-status LIVE row defers too", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: importedLive("p16", bag({ price: 9900 })),
			collection: "products",
			isNew: false,
		});
		expect(putRequests(stubServer, "p16")).toHaveLength(0);
		expect(activatePosts(stubServer, "p16")).toHaveLength(0);

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p16", bag({ price: 9900 }), T2),
			collection: "products",
		});
		expect(putRequests(stubServer, "p16")).toHaveLength(1);
		expect(activatePosts(stubServer, "p16")).toHaveLength(1);
	});

	test("T17 JOINT QA REGRESSION (price dimension): nothing changes on save; price applies at publish", async () => {
		const { stubServer, sandboxHandle } = await setup();

		// The merchant's reported flow: reprice a PUBLISHED product and Save.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("qa-1", bag({ price: 9900 })),
			collection: "products",
			isNew: false,
		});
		// Nothing changed live — the PDP keeps the old price under the old title.
		expect(putRequests(stubServer)).toEqual([]);
		expect(activatePosts(stubServer, "qa-1")).toHaveLength(0);

		// "Publish changes" — content and commerce land together.
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("qa-1", bag({ price: 9900 }), T2),
			collection: "products",
		});
		const puts = putRequests(stubServer, "qa-1");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toMatchObject({ price: { amount: 9900, currency: "USD" } });
		expect(activatePosts(stubServer, "qa-1")).toHaveLength(1);

		// TITLE DIMENSION (the deferred half of this regression, now landed): no
		// save-time request carried the title either — it rides the SAME deferred
		// publish-time upsert, so the content and its order-line snapshot go live
		// together.
		expect(puts[0]?.body).toMatchObject({ title: TITLE });
	});

	test("T18 TITLE SYNC: the publish-time upsert carries data.title (the shared derive feeds BOTH hooks)", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p18", bag(), T2),
			collection: "products",
		});

		const put = putRequests(stubServer, "p18")[0];
		// Without this the row is born `title = NULL` and `createOrderFromCart`
		// rejects every checkout with PRODUCT_NOT_PRICED.
		expect(put?.body).toMatchObject({ title: TITLE });
	});

	test("T19 an ABSENT data.title at publish still upserts the price and still activates — a title problem never blocks a publish", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const content = publishedClean("p19", bag(), T2);
		delete (content["data"] as Record<string, unknown>)["title"];
		const outcome = await sandboxHandle.invokeHook("content:afterPublish", {
			content,
			collection: "products",
		});

		// The title is best-effort: it is omitted from the body and logged, and
		// everything else lands exactly as it does today. Vetoing the upsert here
		// would mean a collection whose title field is missing or named something
		// else loses its price sync entirely — a worse failure than an untitled,
		// unpurchasable product.
		const puts = putRequests(stubServer, "p19");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toMatchObject({ sku: "SKU-1", price: { amount: 1500, currency: "USD" } });
		expect(puts[0]?.body).not.toHaveProperty("title");
		expect(activatePosts(stubServer, "p19")).toHaveLength(1);
		expect(outcome).toEqual({ result: null });
	});
});
