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

const EMPTY_ROW = {
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

describe("sync hooks — the headline (plan §1 / §6 step 7, under the workerd sandbox)", () => {
	test("content:afterSave upserts a product_commerce row keyed by CMS id, asserted via the stub service", async () => {
		const { stubServer, sandboxHandle } = await setup();
		let putBody: unknown;
		stubServer.respondWith("PUT", (req) => {
			putBody = req.body;
			return { status: 200, body: EMPTY_ROW };
		});

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-1", updatedAt: "2026-07-10T00:00:00.000Z" },
			collection: "products",
			isNew: false,
		});

		expect(outcome).toEqual({ result: null });
		const putRequests = stubServer.requests.filter((r) => r.method === "PUT");
		expect(putRequests).toHaveLength(1);
		expect(putRequests[0]?.url).toBe("/products/prod-1/commerce");
		expect(putRequests[0]?.headers["idempotency-key"]).toBeTruthy();
		// A bare content sync carries NO commercial fields (plan §4 — the panel's
		// own save route, not afterSave, is what sets sku/price). It DOES carry
		// the ordering watermark (review S1), so the service can reject a
		// delayed/out-of-order delivery of an OLDER save as a stale no-op.
		expect(putBody).toEqual({ contentUpdatedAt: "2026-07-10T00:00:00.000Z" });
	});

	test("content:afterSave replay with the SAME content.updatedAt derives the SAME idempotency key (upserts once)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));
		const event = {
			content: { id: "prod-2", updatedAt: "2026-07-10T00:00:00.000Z" },
			collection: "products",
			isNew: false,
		};

		await sandboxHandle.invokeHook("content:afterSave", event);
		await sandboxHandle.invokeHook("content:afterSave", event);

		const keys = stubServer.requests
			.filter((r) => r.method === "PUT")
			.map((r) => r.headers["idempotency-key"]);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
		// The service-side store.upsert dedupes a same-key replay to a no-op
		// (product-commerce-store-contract.ts); this proves the PLUGIN's half of
		// that contract — it derives a stable, replayable key.
	});

	test("content:afterSave for a genuinely newer edit (different updatedAt) derives a DIFFERENT key", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));
		await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-2b", updatedAt: "2026-07-10T00:00:00.000Z" },
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-2b", updatedAt: "2026-07-10T01:00:00.000Z" },
			collection: "products",
			isNew: false,
		});
		const keys = stubServer.requests
			.filter((r) => r.method === "PUT")
			.map((r) => r.headers["idempotency-key"]);
		expect(keys[0]).not.toBe(keys[1]);
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
		const deleteRequests = stubServer.requests.filter((r) => r.method === "DELETE");
		expect(deleteRequests).toHaveLength(1);
		expect(deleteRequests[0]?.url).toBe("/products/prod-3/commerce");
	});

	test("create-then-price: a commercial write via the panel route with no CMS id is rejected before any row is minted", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));

		const outcome = await sandboxHandle.invokeRoute("product-commerce", { sku: "SKU-1" });

		expect(outcome).toEqual({ result: { ok: false, error: "MISSING_PRODUCT_ID" } });
		expect(stubServer.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
	});

	test("afterSave failure (503 from the service) does not throw into the CMS save path — the hook resolves", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 503, body: { error: "unavailable" } }));

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-5", updatedAt: "2026-07-10T00:00:00.000Z" },
			collection: "products",
			isNew: false,
		});

		// Resolves normally (fire-and-forget) — not `{ error: ... }`.
		expect(outcome).toEqual({ result: null });
	});

	test("afterSave/afterDelete for a non-products collection are no-ops", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));
		stubServer.respondWith("DELETE", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "page-1", updatedAt: "x" },
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

	// -- issue #82: afterSave activates an already-published product ------------
	// The genuinely host-wired fix: `content:afterSave` fires on every document
	// save and carries the content record's `status` (verified against
	// `~/em-dash`: `ContentItem.status` is spread verbatim into the hook record by
	// `contentItemToRecord`). When the saved product is CURRENTLY PUBLISHED, the
	// hook activates the (possibly just-created) row through the DEDICATED,
	// guarded `/activate` route — closing the "publish first, price later"
	// ordering gap where `content:afterPublish` already fired before the row
	// existed. Best-effort; a soft-deleted row is protected by the store's
	// activate no-op (store-contract invariant), not re-checked here.

	test("content:afterSave for a PUBLISHED product activates the row in the same sync (closes #82 ordering gap)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		const outcome = await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-pub", updatedAt: "2026-07-11T09:00:00.000Z", status: "published" },
			collection: "products",
			isNew: false,
		});
		expect(outcome).toEqual({ result: null });

		// Upsert first (bare, no commercial fields)…
		const puts = stubServer.requests.filter((r) => r.method === "PUT");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toBe("/products/prod-pub/commerce");
		// …then the guarded activate carrying the ordering watermark.
		const acts = activatePosts(stubServer, "prod-pub");
		expect(acts).toHaveLength(1);
		expect(acts[0]?.body).toEqual({ contentUpdatedAt: "2026-07-11T09:00:00.000Z" });
		expect(acts[0]?.headers["idempotency-key"]).toBeTruthy();
	});

	test("content:afterSave for a DRAFT (unpublished) product does NOT activate — the row stays inactive until publish", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-draft", updatedAt: "2026-07-11T09:00:00.000Z", status: "draft" },
			collection: "products",
			isNew: false,
		});
		// …and when the record carries no status at all.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: { id: "prod-nostatus", updatedAt: "2026-07-11T09:00:00.000Z" },
			collection: "products",
			isNew: false,
		});

		expect(activatePosts(stubServer, "prod-draft")).toHaveLength(0);
		expect(activatePosts(stubServer, "prod-nostatus")).toHaveLength(0);
	});

	test("content:afterSave activation reuses the publish idempotency key — it converges with content:afterPublish (one applied flip)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: EMPTY_ROW }));
		stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));

		const event = {
			content: { id: "prod-conv", updatedAt: "2026-07-11T09:00:00.000Z", status: "published" },
			collection: "products",
			isNew: false,
		};
		// afterSave twice AND the real afterPublish for the SAME updatedAt — every
		// activate must carry the identical Idempotency-Key so the store dedupes.
		await sandboxHandle.invokeHook("content:afterSave", event);
		await sandboxHandle.invokeHook("content:afterSave", event);
		await sandboxHandle.invokeHook("content:afterPublish", {
			content: event.content,
			collection: "products",
		});

		const keys = activatePosts(stubServer, "prod-conv").map((r) => r.headers["idempotency-key"]);
		expect(keys.length).toBeGreaterThanOrEqual(2);
		expect(new Set(keys).size).toBe(1); // all identical → one applied flip.
	});
});
