import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * PUBLISH ATOMICITY (plan §2): what the CMS sync pushes for content that is
 * currently LIVE is not pushed on save — it is pushed at PUBLISH, in the same
 * operation that makes the content live.
 *
 * Why the existing `sync-hooks.sandbox.test.ts` never caught the bug: every one
 * of its fixtures omits the REVISION POINTER fields (`liveRevisionId` /
 * `draftRevisionId`) EmDash emits on a revision-supporting collection, so all of
 * them are "not a pending draft" and keep the pre-change behavior. That suite's
 * continued green IS the pointers-absent / older-host regression test; the
 * fixtures below are the ones that carry pointers.
 *
 * SINCE PR 1b ("one home per field") the deferred payload is the TITLE, not a
 * commerce bag: the title is what an order line snapshots and what the admin
 * list shows, so a draft rename must not land under the still-published old
 * content. The ordering and failure rules are unchanged; the cases that
 * asserted price/stock deferral are rewritten around the title, and the two
 * that only existed for the bag (T7 stock, T10 validation failure) are gone —
 * there is no stock on this path and no validation arm left to fail.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** A draft save. EmDash 0.29.0 bumps `updated_at` unconditionally on every
 *  update (`content.ts` update(): `updated_at: now`), so a draft save DOES
 *  carry a fresh watermark — which is precisely why the pre-change hook leaked
 *  the draft data on every save, not just the first (plan §1.6). */
const T1 = "2026-07-26T10:00:00.000Z";
/** The publish, strictly newer (publish() bumps `updated_at` too, plan §1.5). */
const T2 = "2026-07-26T11:00:00.000Z";

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
	createdAt: T1,
	updatedAt: T1,
};

/** The product title, which lives at `content.data.title` — NOT at the top
 *  level. em-dash's `ContentItem` has no `title` member; `mapRow()` puts every
 *  non-`SYSTEM_COLUMNS` column into `data`, and `title` is an ordinary
 *  user-defined collection field (`sites/staging/seed/seed.json` declares it on
 *  `products`). It is the value an order line snapshots at purchase time, its
 *  absence is why a product is unpurchasable (`PRODUCT_NOT_PRICED`), and since
 *  PR 1b it is the ONLY field the CMS sync projects. */
const TITLE = "Blue Mug";
/** The live title, still on the storefront while a rename sits in a draft. */
const OLD_TITLE = "Grey Mug";

/** A save that staged a PENDING DRAFT over live content: EmDash's
 *  `published_with_changes` (status stays "published"; the two revision
 *  pointers diverge), with `content.data` already hydrated FROM THE DRAFT by
 *  `hydrateDraftData` before the hook fires. */
function pendingDraft(id: string, title: string = TITLE): Record<string, unknown> {
	return {
		id,
		updatedAt: T1,
		status: "published",
		liveRevisionId: "rev-live",
		draftRevisionId: "rev-draft",
		data: { title },
		liveData: { title: OLD_TITLE },
	};
}

/** The §2.2 clause-2 hole: `create()` accepts `status` verbatim and its INSERT
 *  never sets `live_revision_id`, so an API/CLI/import create-with-published
 *  yields a row that is live BY STATUS with no live-revision pointer. */
function importedLive(id: string, title: string = TITLE): Record<string, unknown> {
	return {
		id,
		updatedAt: T1,
		status: "published",
		liveRevisionId: null,
		draftRevisionId: "rev-draft",
		data: { title },
	};
}

/** A live product with NO pending draft — the state `publish()` leaves behind
 *  (`draft_revision_id = NULL`), so `content.data` IS the published data. */
function publishedClean(
	id: string,
	updatedAt: string,
	title: string = TITLE,
): Record<string, unknown> {
	return {
		id,
		updatedAt,
		status: "published",
		liveRevisionId: "rev-live",
		draftRevisionId: null,
		data: { title },
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
	stubServer.respondWith("PUT", () => ({ status: 200, body: BARE_ROW }));
	stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));
	return { stubServer, sandboxHandle };
}

describe("publish atomicity — live commerce changes only at publish (workerd sandbox)", () => {
	test("T1 BUG REPRO: a draft save of a PUBLISHED product pushes NOTHING", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p1", "Renamed Mug"),
			collection: "products",
			isNew: false,
		});

		// The merchant's rename does NOT reach the order pipeline while the live
		// content still shows the old name.
		expect(putRequests(stubServer)).toEqual([]);
		expect(outcome).toEqual({ result: null }); // still fire-and-forget.
	});

	test("T2 publish applies content + commerce TOGETHER — upsert BEFORE activate", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p1", "Renamed Mug"),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p1", T2, "Renamed Mug"),
			collection: "products",
		});

		const puts = putRequests(stubServer, "p1");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toEqual({ title: "Renamed Mug", contentUpdatedAt: T2 });
		const acts = activatePosts(stubServer, "p1");
		expect(acts).toHaveLength(1);
		// A row is NEVER made live before it exists — `activate` no-ops on an
		// unknown id, so the ordering is load-bearing, not cosmetic.
		expect(stubServer.requests.indexOf(puts[0]!)).toBeLessThan(
			stubServer.requests.indexOf(acts[0]!),
		);
	});

	test("T3 the publish-time upsert carries the PUBLISH watermark, not the draft save's", async () => {
		const { stubServer, sandboxHandle } = await setup();

		// A pre-change save at T1 would have keyed the upsert on T1; assert the
		// publish's key/watermark are the publish's own, strictly newer, values.
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p3", T2),
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
				data: { title: TITLE },
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
			content: publishedClean("p5", T1),
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
				data: { title: TITLE },
			},
			collection: "products",
			isNew: false,
		});

		expect(putRequests(stubServer, "p6")).toHaveLength(1);
	});

	test("T8 unpublish deactivates and pushes NO upsert", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterUnpublish", {
			content: publishedClean("p8", T2),
			collection: "products",
		});

		expect(putRequests(stubServer, "p8")).toHaveLength(0);
		expect(deactivatePosts(stubServer, "p8")).toHaveLength(1);
	});

	test("T9 after unpublish a save syncs again; republish re-applies + reactivates", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterUnpublish", {
			content: publishedClean("p9", T1),
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
				data: { title: "Reworked Mug" },
			},
			collection: "products",
			isNew: false,
		});
		expect(putRequests(stubServer, "p9")).toHaveLength(1);

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p9", T2, "Reworked Mug"),
			collection: "products",
		});
		expect(putRequests(stubServer, "p9")).toHaveLength(2);
		expect(activatePosts(stubServer, "p9")).toHaveLength(1);
	});

	test("T11 TRANSPORT failure at publish FAILS CLOSED: no activate", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 503, body: { error: "unavailable" } }));

		const outcome = await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p11", T2),
			collection: "products",
		});

		// Never make a row live whose commerce record we could not write. (The
		// handler logs a distinct "commerce upsert FAILED … activation skipped
		// (fail-closed)" line; the workerd child's console is not observable
		// across the sandbox boundary, so the behavior is what is pinned here.)
		expect(activatePosts(stubServer, "p11")).toHaveLength(0);
		expect(outcome).toEqual({ result: null }); // never throws into the CMS publish path.
	});

	test("T12 replay: the upsert key and the activate key are distinct, and both stable across deliveries", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const content = publishedClean("p12", T2);
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
		// afterPublish RE-APPLIES the upsert (no field change, but `updated_at`
		// moves — see F7). On a publish-of-pending-changes the row is already
		// active, the activate guard no-ops, the column keeps the upsert key, and
		// the redelivery dedupes correctly.
	});

	test("T13 afterPublish for a non-products collection is a no-op", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("page-1", T2),
			collection: "pages",
		});

		expect(stubServer.requests).toHaveLength(0);
	});

	test("T14 afterPublish of a product that was NEVER PRICED still upserts a bare row and still activates (§4.4)", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p14", T2),
			collection: "products",
		});

		// Before PR 1b there was no commerce field on this document, so the hook
		// upserted NOTHING and the activate hit a nonexistent row (a no-op). Now
		// the row is minted first and the flip lands: the product is active while
		// commerce-incomplete, and therefore still not purchasable (the store's
		// catalog read filters it — pinned in the store contract against a real
		// database).
		const puts = putRequests(stubServer, "p14");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toEqual({ title: TITLE, contentUpdatedAt: T2 });
		expect(activatePosts(stubServer, "p14")).toHaveLength(1);
	});

	test("T15 a pending-draft save sends NOTHING live-affecting — no upsert AND no activate", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("p15", "Renamed Mug"),
			collection: "products",
			isNew: false,
		});

		// An activate is itself a live-affecting flip: on a pending-draft save of
		// a row that was deactivated it would re-latch the product purchasable
		// with no publish.
		expect(putRequests(stubServer, "p15")).toHaveLength(0);
		expect(activatePosts(stubServer, "p15")).toHaveLength(0);
	});

	test("T16 §2.2 hole: an imported / create-with-status LIVE row defers too", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterSave", {
			content: importedLive("p16", "Renamed Mug"),
			collection: "products",
			isNew: false,
		});
		expect(putRequests(stubServer, "p16")).toHaveLength(0);
		expect(activatePosts(stubServer, "p16")).toHaveLength(0);

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p16", T2, "Renamed Mug"),
			collection: "products",
		});
		expect(putRequests(stubServer, "p16")).toHaveLength(1);
		expect(activatePosts(stubServer, "p16")).toHaveLength(1);
	});

	test("T17 JOINT QA REGRESSION: nothing changes on save; the rename applies at publish", async () => {
		const { stubServer, sandboxHandle } = await setup();

		// The merchant's reported flow: edit a PUBLISHED product and Save.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: pendingDraft("qa-1", "Renamed Mug"),
			collection: "products",
			isNew: false,
		});
		// Nothing changed live — the order pipeline keeps the old snapshot source.
		expect(putRequests(stubServer)).toEqual([]);
		expect(activatePosts(stubServer, "qa-1")).toHaveLength(0);

		// "Publish changes" — content and its order-line snapshot land together.
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("qa-1", T2, "Renamed Mug"),
			collection: "products",
		});
		const puts = putRequests(stubServer, "qa-1");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toMatchObject({ title: "Renamed Mug" });
		expect(activatePosts(stubServer, "qa-1")).toHaveLength(1);
		// AND NOTHING COMMERCIAL: the price the merchant set in Pricing &
		// inventory is untouched by this publish. That reversion is exactly what
		// PR 1b removed.
		expect(puts[0]?.body).not.toHaveProperty("price");
		expect(puts[0]?.body).not.toHaveProperty("sku");
	});

	test("T18 TITLE SYNC: the publish-time upsert carries data.title (the shared derive feeds BOTH hooks)", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeHook("content:afterPublish", {
			content: publishedClean("p18", T2),
			collection: "products",
		});

		const put = putRequests(stubServer, "p18")[0];
		// Without this the row is born `title = NULL` and `createOrderFromCart`
		// rejects every checkout with PRODUCT_NOT_PRICED.
		expect(put?.body).toMatchObject({ title: TITLE });
	});

	test("T19 an ABSENT data.title at publish still upserts the row and still activates — a title problem never blocks a publish", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const content = publishedClean("p19", T2);
		delete (content["data"] as Record<string, unknown>)["title"];
		const outcome = await sandboxHandle.invokeHook("content:afterPublish", {
			content,
			collection: "products",
		});

		// The title is best-effort: it is omitted from the body and logged, and
		// the row is still created/refreshed. Vetoing the upsert here would mean a
		// collection whose title field is missing or named something else never
		// gets a product_commerce row at all — it would vanish from Pricing &
		// inventory, a worse failure than an untitled, unpurchasable product.
		const puts = putRequests(stubServer, "p19");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.body).toEqual({ contentUpdatedAt: T2 });
		expect(puts[0]?.body).not.toHaveProperty("title");
		expect(activatePosts(stubServer, "p19")).toHaveLength(1);
		expect(outcome).toEqual({ result: null });
	});
});
