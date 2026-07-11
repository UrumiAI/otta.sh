import { describe, expect, test } from "vitest";
import { idempotencyKey } from "../money/ids.js";
import { DEFAULT_OPERATIONAL_SETTINGS, type SettingsStore } from "../ports/settings-store.js";

export interface SettingsStoreHarness {
	store: SettingsStore;
}

export interface SettingsStoreContractOptions {
	dialect: string;
}

/** Behavioral spec for every `SettingsStore` adapter (Phase 7 §5.2/§6). */
export function settingsStoreContract(
	makeStore: () => Promise<SettingsStoreHarness>,
	opts: SettingsStoreContractOptions,
): void {
	describe(`settingsStoreContract [${opts.dialect}]`, () => {
		test("get returns defaults when nothing persisted yet", async () => {
			const { store } = await makeStore();
			expect(await store.get()).toEqual(DEFAULT_OPERATIONAL_SETTINGS);
		});

		test("update persists holdTtlMinutes and lowStockThreshold and returns the full resulting settings", async () => {
			const { store } = await makeStore();
			const result = await store.update(
				{ holdTtlMinutes: 30, lowStockThreshold: 12 },
				idempotencyKey("k1"),
			);
			expect(result).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 12 });
			expect(await store.get()).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 12 });
		});

		test("update is a partial merge — an omitted field keeps its current value", async () => {
			const { store } = await makeStore();
			await store.update({ holdTtlMinutes: 30, lowStockThreshold: 12 }, idempotencyKey("k1"));
			const merged = await store.update({ lowStockThreshold: 99 }, idempotencyKey("k2"));
			expect(merged).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 99 });
		});

		test("update replayed with the same idempotencyKey returns the recorded result and does not re-apply", async () => {
			const { store } = await makeStore();
			const first = await store.update({ holdTtlMinutes: 30 }, idempotencyKey("k1"));
			// A DIFFERENT key moves settings forward.
			await store.update({ holdTtlMinutes: 99 }, idempotencyKey("k2"));
			// Replaying k1 must return the ORIGINAL recorded result, NOT clobber current.
			const replay = await store.update({ holdTtlMinutes: 30 }, idempotencyKey("k1"));
			expect(replay).toEqual(first);
			expect((await store.get()).holdTtlMinutes).toBe(99);
		});
	});
}
