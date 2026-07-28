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

/** A saved products content record carrying a `commerce` field bag under `data`
 *  (the shape `content:afterSave` receives — `contentItemToRecord(item)`).
 *
 *  `version` is emitted top-level by em-dash's `mapRow` and passed through by
 *  `contentItemToRecord = { ...item }`, so it is part of the record every hook
 *  sees. It defaults to 1 here; tests that model successive saves must BUMP IT
 *  rather than move `updatedAt` — see `unpublishedDraft` below. */
function productContent(
	id: string,
	bag: Record<string, unknown> | undefined,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		updatedAt: WM,
		version: 1,
		...(bag !== undefined ? { data: { commerce: bag } } : {}),
		...extra,
	};
}

/**
 * A save of an UNPUBLISHED product on a revision-supporting collection — the
 * one shape whose commerce `content:afterSave` still pushes immediately
 * (publish atomicity defers everything that is already live).
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
	bag: Record<string, unknown>,
	version: number,
): Record<string, unknown> {
	return productContent(id, bag, {
		status: "draft",
		liveRevisionId: null,
		draftRevisionId: `rev-${version}`,
		version,
	});
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
		// Derived: sku, integer-minor-units price + currency, kind, initial stock,
		// and the ordering watermark. NEVER active/deletedAt.
		expect(putBody).toEqual({
			sku: "SKU-1",
			price: { amount: 1500, currency: "USD" },
			productKind: "physical",
			initialOnHand: 5,
			contentUpdatedAt: WM,
		});
	});

	test("REDELIVERY of the same save event derives the SAME idempotency key (store dedupes); a genuinely NEWER save derives a DIFFERENT key", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));

		// A redelivery is the IDENTICAL record replayed: em-dash captures one
		// `content` object per write and hands that same object to every hook
		// consumer (`runAfterSaveHooks`), with no DB re-read per delivery — so a
		// retry carries the same `updatedAt` AND the same `version`.
		const delivered = unpublishedDraft("prod-2", commerceBag(), 3);
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
		// `updated_at` (8d6b20b, #2143) — only `version` moves. The previous
		// version of this test hand-mutated `updatedAt` here, which modelled
		// 0.29.0 and hid the whole "frozen watermark" bug class.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: unpublishedDraft("prod-2", commerceBag({ price: 2000 }), 4),
			collection: "products",
			isNew: false,
		});

		const keys = putRequests(stubServer).map((r) => r.headers["idempotency-key"]);
		expect(keys).toHaveLength(3);
		expect(keys[0]).toBe(keys[1]); // same delivery → same key → store dedupes.
		expect(keys[2]).not.toBe(keys[0]); // newer version → fresh key → applies.
	});

	test("0.31.1 FROZEN updatedAt: two successive draft saves of an UNPUBLISHED product with a CHANGED price BOTH apply (emdash 8d6b20b / #2143)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		const putBodies: unknown[] = [];
		stubServer.respondWith("PUT", (req) => {
			putBodies.push(req.body);
			return { status: 200, body: PRICED_ROW };
		});

		// Save #1 — price 1500. Save #2 — price 2000. On em-dash 0.31.1 BOTH
		// carry the identical `updatedAt` (the draft save is a column no-op, so
		// `updated_at` is never stamped); only `version` advances.
		await sandboxHandle.invokeHook("content:afterSave", {
			content: unpublishedDraft("prod-frozen", commerceBag({ price: 1500 }), 2),
			collection: "products",
			isNew: false,
		});
		await sandboxHandle.invokeHook("content:afterSave", {
			content: unpublishedDraft("prod-frozen", commerceBag({ price: 2000 }), 3),
			collection: "products",
			isNew: false,
		});

		const puts = putRequests(stubServer);
		expect(puts).toHaveLength(2);
		// Both saves carried the SAME watermark — the freeze this test exists for.
		expect(putBodies).toEqual([
			{
				sku: "SKU-1",
				price: { amount: 1500, currency: "USD" },
				productKind: "physical",
				initialOnHand: 5,
				contentUpdatedAt: WM,
			},
			{
				sku: "SKU-1",
				price: { amount: 2000, currency: "USD" },
				productKind: "physical",
				initialOnHand: 5,
				contentUpdatedAt: WM,
			},
		]);
		// THE ASSERTION THAT MATTERS: distinct keys. `upsert` no-ops the second
		// write when the key repeats (`WHERE product_commerce.idempotency_key
		// != :key`), so an identical key here means the merchant's 2000 price is
		// SILENTLY DROPPED. Deriving from `updatedAt` alone does exactly that on
		// em-dash >= 0.30.0.
		const keys = puts.map((r) => r.headers["idempotency-key"]);
		expect(keys[0]).not.toBe(keys[1]);
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
