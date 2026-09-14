/**
 * `ctx.storage` under REAL workerd.
 *
 * The other sandbox suites prove the plugin's routes and hooks behave inside the
 * isolate; this one proves the thing they all now carry — a document store on
 * `ctx.storage` — is real, reachable and round-trips, by driving the in-process
 * commerce client from inside the isolate: one write, one read back, one batch
 * read that has to join two collections.
 *
 * WHAT IT DOES AND DOES NOT PROVE. It proves the PLUGIN's storage code paths work
 * under workerd against a real `PluginStorageRepository` — the composition, the
 * branding, the serialization, all of it inside the isolate. It proves nothing
 * about the HOST's own storage bridge, which these suites do not use: the store
 * lives in the test process and the worker reaches it over the harness's own
 * bridge (see `sandbox/storage-bridge.ts`). That distinction is deliberate and
 * must not be blurred in a later reading.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

describe("ctx.storage under workerd", () => {
	let sandbox: SandboxHandle;

	beforeAll(async () => {
		sandbox = await loadPluginInSandbox({
			allowedHosts: ["commerce.otta.internal"],
			commerceServiceBaseUrl: "https://commerce.otta.internal",
			entry: "commerce/testing/storage-probe-entry.ts",
		});
	}, 120_000);

	afterAll(async () => {
		await sandbox?.close();
	});

	test("a commerce write and read travel through ctx.storage to a real document store", async () => {
		const productId = `probe-${crypto.randomUUID()}`;
		const outcome = await sandbox.invokeRoute("storage-probe/round-trip", {
			productId,
			sku: `PROBE-${productId}`,
		});
		expect("error" in outcome ? outcome.error : "").toBe("");
		if ("error" in outcome) throw new Error(outcome.error);
		const result = outcome.result as {
			written: { productId: string; sku: string; price: { amount: number; currency: string } };
			read: { productId: string; sku: string } | null;
			batch: Array<{ productId: string; inStock: boolean }>;
		};

		// Money crosses the isolate as an integer minor amount plus its currency,
		// never a float and never a formatted string.
		expect(result.written).toMatchObject({
			productId,
			sku: `PROBE-${productId}`,
			price: { amount: 2500, currency: "USD" },
		});
		// Durable: a SECOND call into the store, not the write's own return value.
		expect(result.read).toMatchObject({ productId, sku: `PROBE-${productId}` });
		// The join read: the seeded units make it in stock, and the id nobody wrote
		// is OMITTED rather than reported as an error entry.
		expect(result.batch).toHaveLength(1);
		expect(result.batch[0]).toMatchObject({ productId, inStock: true });
	}, 120_000);
});
