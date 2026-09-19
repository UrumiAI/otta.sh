/**
 * `ctx.storage` under REAL workerd.
 *
 * The other sandbox suites prove the plugin's routes and hooks behave inside the
 * isolate; this one proves the thing they all now carry — a document store on
 * `ctx.storage` — is real, reachable and round-trips, by driving the in-process
 * commerce client from inside the isolate: one write, one read back, one batch
 * read that has to join two collections.
 *
 * OPT-IN: this suite asks for the store (`storage: true`). A boot that does not ask
 * gets a context with none, which is what keeps the proxy suites' "the stub's
 * recorded requests are the plugin's entire egress" claim true.
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
			entry: "commerce/testing/storage-probe-entry.ts",
			storage: true,
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

	test("a conditional write is REAL across the bridge: a stale revision does not apply, and the fresh one comes back", async () => {
		const docId = `probe-doc-${crypto.randomUUID()}`;
		const outcome = await sandbox.invokeRoute("storage-probe/conditional-write", { docId });
		if ("error" in outcome) throw new Error(outcome.error);
		const result = outcome.result as {
			created: { applied: boolean; revision?: string | null };
			applied: { applied: boolean; revision?: string | null };
			rejected: { applied: boolean; revision?: string | null };
			staleRevision: string | null;
			finalRevision: string | null;
			finalValue: { round?: number } | null;
		};

		// Create-if-absent applies, and the write against the revision just read applies.
		expect(result.created.applied).toBe(true);
		expect(result.applied.applied).toBe(true);
		// The SAME revision a second time does not: this is the whole no-oversell
		// primitive, and a store whose revisions never moved would apply it happily.
		expect(result.rejected.applied).toBe(false);
		// The revision genuinely moved, so the stale one is not the current one — which
		// is what proves the revision trigger survived into this tier.
		expect(typeof result.staleRevision).toBe("string");
		expect(result.finalRevision).not.toBe(result.staleRevision);
		// And the losing write left no trace: the value is the one that won.
		expect(result.finalValue).toEqual({ round: 2 });
	}, 120_000);

	test("a typed storage failure survives the bridge as a shape the isolate can branch on", async () => {
		const outcome = await sandbox.invokeRoute("storage-probe/undeclared-index", {});
		if ("error" in outcome) throw new Error(outcome.error);
		const result = outcome.result as {
			threw: boolean;
			isError?: boolean;
			name?: string | null;
			message?: string | null;
		};
		// A filter on a field the collection never declared is refused: a declared
		// index is a read contract, and this is the error that makes that true.
		expect(result.threw).toBe(true);
		// It arrives as a real Error carrying the name the adapters test for
		// STRUCTURALLY — never as an `instanceof` of a class that cannot cross a
		// bridge, and never as a bare string.
		expect(result.isError).toBe(true);
		expect(result.name).toBe("StorageQueryError");
		expect(typeof result.message).toBe("string");
	}, 120_000);
});
