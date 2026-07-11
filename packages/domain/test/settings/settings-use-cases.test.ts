import { getSettings, idempotencyKey, InvalidSettingsError, updateSettings } from "@urumi/domain";
import { InMemorySettingsStore, settingsStoreContract } from "@urumi/domain/testing";
import { describe, expect, test } from "vitest";

// Contract suite against the fake (Step 2, fake-first).
settingsStoreContract(async () => ({ store: new InMemorySettingsStore() }), {
	dialect: "in-memory-fake",
});

describe("settings use-cases (over the in-memory fake)", () => {
	test("getSettings returns defaults when nothing persisted yet", async () => {
		expect(await getSettings(new InMemorySettingsStore())).toEqual({
			holdTtlMinutes: 15,
			lowStockThreshold: 5,
		});
	});

	test("updateSettings persists holdTtlMinutes and lowStockThreshold", async () => {
		const store = new InMemorySettingsStore();
		const result = await updateSettings(
			store,
			{ holdTtlMinutes: 45, lowStockThreshold: 20 },
			idempotencyKey("k1"),
		);
		expect(result).toEqual({ holdTtlMinutes: 45, lowStockThreshold: 20 });
		expect(await getSettings(store)).toEqual({ holdTtlMinutes: 45, lowStockThreshold: 20 });
	});

	test("updateSettings rejects holdTtlMinutes <= 0 before it reaches the store", async () => {
		const store = new InMemorySettingsStore();
		await expect(
			updateSettings(store, { holdTtlMinutes: 0 }, idempotencyKey("k1")),
		).rejects.toBeInstanceOf(InvalidSettingsError);
		// Nothing persisted — the guard ran before the store.
		expect(await getSettings(store)).toEqual({ holdTtlMinutes: 15, lowStockThreshold: 5 });
	});

	test("updateSettings rejects a non-integer lowStockThreshold", async () => {
		const store = new InMemorySettingsStore();
		await expect(
			updateSettings(store, { lowStockThreshold: 2.5 }, idempotencyKey("k1")),
		).rejects.toBeInstanceOf(InvalidSettingsError);
	});

	test("updateSettings replayed with the same idempotencyKey does not double-apply", async () => {
		const store = new InMemorySettingsStore();
		const first = await updateSettings(store, { holdTtlMinutes: 30 }, idempotencyKey("k1"));
		await updateSettings(store, { holdTtlMinutes: 99 }, idempotencyKey("k2"));
		const replay = await updateSettings(store, { holdTtlMinutes: 30 }, idempotencyKey("k1"));
		expect(replay).toEqual(first);
		// The stale replay did not clobber the newer k2 write.
		expect((await getSettings(store)).holdTtlMinutes).toBe(99);
	});
});
