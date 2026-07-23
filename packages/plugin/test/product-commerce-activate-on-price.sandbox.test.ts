import { afterEach, describe, expect, test } from "vitest";
import {
	startStubCommerceServer,
	type RecordedRequest,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// Issue #82: pricing a product whose CMS content is ALREADY PUBLISHED must
// make the row `active=true` so the PDP is purchasable, WITHOUT a manual
// unpublish→republish. Activation must reuse the dedicated, guarded
// `/activate` action route (never a new `active` field on the blanket
// `upsert`), so a soft-deleted row is never resurrected by the pricing path
// (the store-contract invariant "activate of a SOFT-DELETED product does NOT
// resurrect it" is the authoritative guard — proven against fake + both
// Postgres dialects; this suite proves the plugin routes THROUGH it).

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

/** The row the stub service returns from the PUT upsert — deliberately
 *  `active:false`, exactly as the real service mints a freshly-priced row. */
function pricedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		productId: "prod-1",
		sku: "SKU-1",
		price: { amount: 1500, currency: "USD" },
		title: null,
		taxClass: null,
		compareAt: null,
		inventoryPolicy: "deny",
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
		...overrides,
	};
}

async function setup(): Promise<{ stubServer: StubCommerceServer; sandboxHandle: SandboxHandle }> {
	const stubServer = await startStubCommerceServer();
	cleanups.push(() => stubServer.close());
	stubServer.respondWith("PUT", () => ({ status: 200, body: pricedRow() }));
	stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));
	const sandboxHandle = await loadPluginInSandbox({
		allowedHosts: [stubServer.host],
		commerceServiceBaseUrl: stubServer.baseUrl,
	});
	cleanups.push(() => sandboxHandle.close());
	return { stubServer, sandboxHandle };
}

const WM = "2026-07-11T09:00:00.000Z";

/** A pricing panel Save for an ALREADY-PUBLISHED, non-deleted product. */
function publishedPricingInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		productId: "prod-1",
		sku: "SKU-1",
		price: 1500,
		currency: "USD",
		onHand: 5,
		productKind: "physical",
		contentPublished: true,
		contentUpdatedAt: WM,
		...overrides,
	};
}

function activateRequests(server: StubCommerceServer): RecordedRequest[] {
	return server.requests.filter(
		(r) => r.method === "POST" && r.url === "/products/prod-1/commerce/activate",
	);
}

function resultOf(outcome: { result: unknown } | { error: string }): Record<string, unknown> {
	expect("result" in outcome).toBe(true);
	return (outcome as { result: Record<string, unknown> }).result;
}

describe("issue #82 — pricing an already-published product activates it (workerd sandbox)", () => {
	test("(1) pricing an already-published, non-deleted product fires the guarded /activate with the content watermark", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const outcome = await sandboxHandle.invokeRoute("product-commerce", publishedPricingInput());

		const result = resultOf(outcome);
		expect(result["ok"]).toBe(true); // the pricing save itself still succeeds.

		// The upsert PUT landed first…
		const puts = stubServer.requests.filter((r) => r.method === "PUT");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toBe("/products/prod-1/commerce");

		// …then the row is activated via the DEDICATED action route (no republish).
		const activates = activateRequests(stubServer);
		expect(activates).toHaveLength(1);
		expect(activates[0]?.body).toEqual({ contentUpdatedAt: WM });
		expect(activates[0]?.headers["idempotency-key"]).toBeTruthy();
	});

	test("(2) the pricing path NEVER carries `active`/`deletedAt` on the upsert — activation is the guarded /activate only (soft-delete hazard closed)", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeRoute("product-commerce", publishedPricingInput());

		// The blanket upsert must never smuggle the publish gate — reactivating a
		// soft-deleted row is impossible via PUT; only the guarded /activate
		// route (which no-ops on a soft-deleted row — store contract invariant)
		// can flip `active`.
		const put = stubServer.requests.find((r) => r.method === "PUT");
		const body = (put?.body ?? {}) as Record<string, unknown>;
		expect(body).not.toHaveProperty("active");
		expect(body).not.toHaveProperty("deletedAt");
		// Activation went exclusively through the dedicated action route.
		expect(activateRequests(stubServer)).toHaveLength(1);
	});

	test("(3) pricing a product whose content is NOT published does NOT activate — the row stays inactive until publish", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeRoute(
			"product-commerce",
			publishedPricingInput({ contentPublished: false }),
		);
		// …and the same when the host threads no publish signal at all.
		await sandboxHandle.invokeRoute(
			"product-commerce",
			publishedPricingInput({ contentPublished: undefined, contentUpdatedAt: undefined }),
		);

		expect(activateRequests(stubServer)).toHaveLength(0);
	});

	test("(4) an idempotent replay of the same pricing submission derives the SAME activate Idempotency-Key (store no-ops, no double-flip)", async () => {
		const { stubServer, sandboxHandle } = await setup();

		await sandboxHandle.invokeRoute("product-commerce", publishedPricingInput());
		await sandboxHandle.invokeRoute("product-commerce", publishedPricingInput());

		const activates = activateRequests(stubServer);
		expect(activates).toHaveLength(2);
		const keys = activates.map((r) => r.headers["idempotency-key"]);
		expect(keys[0]).toBe(keys[1]); // identical → the store dedupes to one applied flip.
	});

	test("(5) a published product with an UNPARSEABLE content watermark is not activated (no ungated flip) but the pricing save still succeeds", async () => {
		const { stubServer, sandboxHandle } = await setup();

		const outcome = await sandboxHandle.invokeRoute(
			"product-commerce",
			publishedPricingInput({ contentUpdatedAt: "not-a-date" }),
		);

		expect(resultOf(outcome)["ok"]).toBe(true);
		expect(activateRequests(stubServer)).toHaveLength(0);
	});

	test("(6) a failing /activate never fails the pricing save (best-effort, mirrors the fire-and-forget hooks)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("POST", () => ({ status: 500, body: { error: "boom" } }));

		const outcome = await sandboxHandle.invokeRoute("product-commerce", publishedPricingInput());

		// The row is durably priced; a failed activation self-heals on the next
		// publish/price — the save must not throw.
		expect(resultOf(outcome)["ok"]).toBe(true);
		expect(activateRequests(stubServer)).toHaveLength(1);
	});

	test("(7) EMIT→READBACK: the panel-state route bakes the publish signal into the Save button value, and the product-commerce route reads THAT value back and activates (no re-injected boolean)", async () => {
		const { stubServer, sandboxHandle } = await setup();
		// The panel-state route reads the current row via GET (priced but inactive).
		stubServer.respondWith("GET", () => ({ status: 200, body: pricedRow({ active: false }) }));

		// (a) The host renders the panel with the current document's publish state.
		const panel = resultOf(
			await sandboxHandle.invokeRoute("product-data/panel-state", {
				productId: "prod-1",
				published: true,
				contentUpdatedAt: WM,
			}),
		);
		const elements = panel["elements"] as Array<Record<string, unknown>>;
		const saveButton = elements.find((el) => el["action_id"] === "save");
		expect(saveButton).toBeDefined();
		// The publish signal is CARRIED IN the button value — this is the exact
		// payload em-dash echoes back as `BlockAction.value` on the Save click.
		const buttonValue = saveButton?.["value"] as Record<string, unknown> | undefined;
		expect(buttonValue).toEqual({ contentPublished: true, contentUpdatedAt: WM });

		// (b) Feed the button value straight back into the route (the read-back),
		// merged with the form field values — NOT a hand-authored boolean.
		await sandboxHandle.invokeRoute("product-commerce", {
			productId: "prod-1",
			sku: "SKU-1",
			price: 1500,
			currency: "USD",
			...buttonValue,
		});

		const activates = activateRequests(stubServer);
		expect(activates).toHaveLength(1);
		expect(activates[0]?.body).toEqual({ contentUpdatedAt: WM });
	});

	test("(8) EMIT: with NO host publish signal, the panel-state Save button carries no value and a submit does not activate", async () => {
		const { stubServer, sandboxHandle } = await setup();
		stubServer.respondWith("GET", () => ({ status: 200, body: pricedRow({ active: false }) }));

		const panel = resultOf(
			await sandboxHandle.invokeRoute("product-data/panel-state", { productId: "prod-1" }),
		);
		const elements = panel["elements"] as Array<Record<string, unknown>>;
		const saveButton = elements.find((el) => el["action_id"] === "save");
		expect(saveButton?.["value"]).toBeUndefined();

		await sandboxHandle.invokeRoute("product-commerce", {
			productId: "prod-1",
			sku: "SKU-1",
			price: 1500,
			currency: "USD",
			...(saveButton?.["value"] as Record<string, unknown> | undefined),
		});
		expect(activateRequests(stubServer)).toHaveLength(0);
	});
});
