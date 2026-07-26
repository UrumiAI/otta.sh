import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SENTINEL_PREFIX } from "../src/product-commerce/commerce-rejection-message.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * The `content:beforeSave` event shape (plan §3.3) — NOT afterSave's. `content`
 * is `body.data`, the field bag keyed by field slug: no `id`, no `updatedAt`,
 * no `status`, and NO `data` wrapper. Verified against em-dash
 * `emdash-runtime.ts:2710/2715` (create) and `:2807/2816` (update).
 */
function beforeSaveEvent(
	content: Record<string, unknown>,
	overrides: { collection?: string; isNew?: boolean } = {},
): { content: Record<string, unknown>; collection: string; isNew: boolean } {
	return {
		content,
		collection: overrides.collection ?? "products",
		isNew: overrides.isNew ?? false,
	};
}

/** The widget's per-`action_id` commerce bag, valid unless overridden. */
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

/** A products entry's data bag as the editor submits it. */
function productData(
	bag: Record<string, unknown> | undefined,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		title: "A mug",
		description: "Holds coffee",
		images: ["/img/mug.png"],
		...(bag !== undefined ? { commerce: bag } : {}),
		...extra,
	};
}

function resultOf(outcome: unknown): Record<string, unknown> {
	const result = (outcome as { result?: unknown }).result;
	expect(typeof result).toBe("object");
	expect(result).not.toBeNull();
	return result as Record<string, unknown>;
}

function sentinelKeys(result: Record<string, unknown>): string[] {
	return Object.keys(result).filter((k) => k.startsWith(SENTINEL_PREFIX));
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

let stubServer: StubCommerceServer;
let sandboxHandle: SandboxHandle;

beforeAll(async () => {
	stubServer = await startStubCommerceServer();
	stubServer.respondWith("PUT", () => ({ status: 200, body: PRICED_ROW }));
	stubServer.respondWith("POST", () => ({ status: 200, body: { ok: true } }));
	sandboxHandle = await loadPluginInSandbox({
		allowedHosts: [stubServer.host],
		commerceServiceBaseUrl: stubServer.baseUrl,
	});
}, 60_000);

afterAll(async () => {
	await sandboxHandle?.close();
	await stubServer?.close();
});

describe("content:beforeSave — invalid commerce input is REJECTED before the CMS write (P1 repro, workerd sandbox)", () => {
	test("REPRO price 24.99: the returned payload has NO commerce key — the load-bearing invariant", async () => {
		const outcome = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag({ price: 24.99 }))),
		);

		const result = resultOf(outcome);
		// THE invariant: a blocked bag never reaches storage, so the CMS can never
		// hold a money value the service would reject, and (because a key absent
		// from the payload leaves the column/draft base untouched — plan §3.7) the
		// LAST-GOOD bag survives.
		expect("commerce" in result).toBe(false);
		// Everything else the editor submitted rides through verbatim.
		expect(result["title"]).toBe("A mug");
		expect(result["description"]).toBe("Holds coffee");
		expect(result["images"]).toEqual(["/img/mug.png"]);
	});

	test("REPRO price 24.99: exactly one sentinel key, naming the value and the fix", async () => {
		const outcome = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag({ price: 24.99 }))),
		);

		const result = resultOf(outcome);
		const keys = sentinelKeys(result);
		expect(keys).toHaveLength(1);
		expect(keys[0]).toContain("24.99");
		expect(keys[0]).toContain("minor units");
		expect(result[keys[0] ?? ""]).toBe(true);
		// Nothing else was added: original keys minus `commerce`, plus the sentinel.
		expect(new Set(Object.keys(result))).toEqual(
			new Set(["title", "description", "images", keys[0]]),
		);
	});

	test("REPRO price 24.99: the service price is unchanged — afterSave re-derives the LAST-GOOD bag", async () => {
		// The host discards the rejected save, so the STORED bag is untouched and
		// the next afterSave derives from it. Nothing carrying 24.99 ever reaches
		// the service.
		const before = stubServer.requests.length;
		await sandboxHandle.invokeHook("content:afterSave", {
			content: {
				id: "prod-lastgood",
				updatedAt: "2026-07-10T00:00:00.000Z",
				data: { commerce: commerceBag() },
			},
			collection: "products",
			isNew: false,
		});

		const fresh = stubServer.requests.slice(before);
		const puts = fresh.filter((r) => r.method === "PUT");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.url).toBe("/products/prod-lastgood/commerce");
		const putBody = puts[0]?.body as { price?: unknown } | undefined;
		expect(putBody?.price).toEqual({ amount: 1500, currency: "USD" });
		for (const req of stubServer.requests) {
			expect(JSON.stringify(req.body ?? null)).not.toContain("24.99");
		}
	});

	test("REPRO -5 is rejected identically", async () => {
		const outcome = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag({ price: -5 }))),
		);

		const result = resultOf(outcome);
		expect("commerce" in result).toBe(false);
		expect(sentinelKeys(result)).toHaveLength(1);
		expect(sentinelKeys(result)[0]).toContain("-5");
	});

	test("HAPPY PATH 2499: returns undefined — the save proceeds untouched", async () => {
		const outcome = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag({ price: 2499 }))),
		);

		// The harness renders a handler's `undefined` as `result: null`.
		expect(outcome).toEqual({ result: null });
	});

	test("non-blocking gestures never reject — an unpriced product stays saveable", async () => {
		const gestures: Array<Record<string, unknown> | undefined> = [
			{ currency: "USD" }, // priced later ("create-then-price")
			{ currency: "" }, // placeholder / cleared select
			{ price: 2499 }, // no currency yet
			{ sku: "SKU-ONLY" },
			{},
			undefined, // no commerce field at all
		];
		for (const bag of gestures) {
			const outcome = await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData(bag)),
			);
			expect(outcome).toEqual({ result: null });
		}
	});

	test("a stale sentinel in the incoming bag is ALWAYS scrubbed — happy path (an entry can never be bricked)", async () => {
		const stale = `${SENTINEL_PREFIX}Not saved. Price "9.99" must be whole minor units`;
		const outcome = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag(), { [stale]: true })),
		);

		// NOT `undefined`: the scrub changed the payload, so the cleaned bag is
		// returned. `validateContentData` therefore runs on a payload with no
		// unknown key — a stale sentinel can never BLOCK a save.
		const result = resultOf(outcome);
		expect(sentinelKeys(result)).toHaveLength(0);
		expect(result["commerce"]).toEqual(commerceBag());
		expect(result["title"]).toBe("A mug");
	});

	test("a stale sentinel is scrubbed on the blocked path too — only ONE sentinel is ever present", async () => {
		const stale = `${SENTINEL_PREFIX}Not saved. Stock "-1" must be a whole number`;
		const outcome = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag({ price: 24.99 }), { [stale]: true })),
		);

		const result = resultOf(outcome);
		const keys = sentinelKeys(result);
		expect(keys).toHaveLength(1);
		expect(keys[0]).not.toBe(stale);
		expect(keys[0]).toContain("24.99");
	});

	test("MULTIPLE stale sentinel keys are all scrubbed (clean path: zero left; blocked path: exactly one)", async () => {
		const stale = {
			[`${SENTINEL_PREFIX}one`]: true,
			[`${SENTINEL_PREFIX}two`]: true,
			[`${SENTINEL_PREFIX}three`]: true,
		};

		const clean = resultOf(
			await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData(commerceBag(), stale)),
			),
		);
		expect(sentinelKeys(clean)).toHaveLength(0);

		const blocked = resultOf(
			await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData(commerceBag({ price: 24.99 }), stale)),
			),
		);
		expect(sentinelKeys(blocked)).toHaveLength(1);
		expect(sentinelKeys(blocked)[0]).toContain("24.99");
	});

	test("no sentinel key can ever persist into stored/revision data", async () => {
		// Clean save → the payload the host stores carries no sentinel at all…
		const clean = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent(productData(commerceBag())),
		);
		expect(clean).toEqual({ result: null });

		// …and on a blocked save the sentinel is the ONLY added key, on a payload
		// the host discards entirely before any write (validation precedes both the
		// revision write and the column write — plan §3.4).
		const blocked = resultOf(
			await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData(commerceBag({ price: 24.99 }))),
			),
		);
		const added = Object.keys(blocked).filter(
			(k) => !["title", "description", "images"].includes(k),
		);
		expect(added).toHaveLength(1);
		expect(added[0]?.startsWith(SENTINEL_PREFIX)).toBe(true);
	});

	test("corrupted-product recovery: a STORED 24.99 bag blocks, and the same bag with the price cleared saves clean", async () => {
		const corrupted = { sku: "SKU-9", price: 24.99, currency: "USD" };
		const blocked = resultOf(
			await sandboxHandle.invokeHook("content:beforeSave", beforeSaveEvent(productData(corrupted))),
		);
		expect("commerce" in blocked).toBe(false);
		expect(sentinelKeys(blocked)).toHaveLength(1);

		// One gesture recovers: clear the price input (the number input emits
		// `undefined`, which JSON drops).
		const recovered = { sku: "SKU-9", currency: "USD" };
		expect(
			await sandboxHandle.invokeHook("content:beforeSave", beforeSaveEvent(productData(recovered))),
		).toEqual({ result: null });
	});

	test("reads content['commerce'], NEVER content.data.commerce (the obvious implementer trap)", async () => {
		// A nested `data` overlay is inert on this event — only the top-level bag counts.
		const inert = await sandboxHandle.invokeHook(
			"content:beforeSave",
			beforeSaveEvent({
				title: "x",
				data: { commerce: { price: 24.99 } },
				commerce: { price: 2499, currency: "USD" },
			}),
		);
		expect(inert).toEqual({ result: null });

		const mirrored = resultOf(
			await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent({
					title: "x",
					data: { commerce: { price: 2499 } },
					commerce: { price: 24.99, currency: "USD" },
				}),
			),
		);
		expect("commerce" in mirrored).toBe(false);
		expect(mirrored["data"]).toEqual({ commerce: { price: 2499 } });

		// Static backstop: the handler must not reach for afterSave's shape.
		const source = readFileSync(path.join(SRC_DIR, "sync/before-save.ts"), "utf8");
		expect(source).not.toMatch(/readCommerceField/);
		expect(source).not.toMatch(/content\s*\.\s*data/);
		expect(source).not.toMatch(/\[\s*["']data["']\s*\]/);
	});

	test("a non-products collection is never touched (security control, plan §4.5)", async () => {
		for (const collection of ["pages", "posts", "settings"]) {
			const outcome = await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData({ price: 24.99, sku: " ", currency: "nope" }), { collection }),
			);
			expect(outcome).toEqual({ result: null });
		}
	});

	test("the create path (isNew:true) rejects identically, and still ignores non-products", async () => {
		const created = resultOf(
			await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData(commerceBag({ price: 24.99 })), { isNew: true }),
			),
		);
		expect("commerce" in created).toBe(false);
		expect(sentinelKeys(created)).toHaveLength(1);

		expect(
			await sandboxHandle.invokeHook(
				"content:beforeSave",
				beforeSaveEvent(productData(commerceBag({ price: 24.99 })), {
					isNew: true,
					collection: "pages",
				}),
			),
		).toEqual({ result: null });
	});
});

describe("content:write bound — defense-in-depth only", () => {
	test("OUR SANDBOX HARNESS hands a hook a ctx of exactly {http, kv} — NOT a claim about production", async () => {
		// This pins `src/sandbox-entry.ts`'s bridge, nothing else. In TRUSTED mode
		// the host genuinely supplies a write-capable `ctx.content`
		// (`createContentAccessWithWrite`, em-dash `context.ts:1090-1101`) once
		// `content:write` is declared. The REAL guardrail is compile-time: the
		// plugin's own `PluginContext` (src/types.ts) declares only `{http, kv}`,
		// so any `ctx.content…` reference is a `pnpm typecheck` error.
		const ctxProbe = await loadPluginInSandbox({
			allowedHosts: [stubServer.host],
			commerceServiceBaseUrl: stubServer.baseUrl,
			entry: "sync/testing/ctx-shape-entry.ts",
		});
		try {
			const outcome = await ctxProbe.invokeHook("content:beforeSave", beforeSaveEvent({}));
			expect(outcome).toEqual({ result: ["http", "kv"] });
		} finally {
			await ctxProbe.close();
		}
	}, 60_000);
});
