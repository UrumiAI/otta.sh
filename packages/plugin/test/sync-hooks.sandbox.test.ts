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
		// own save route, not afterSave, is what sets sku/price).
		expect(putBody).toEqual({});
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
});
