import { describe, expect, test } from "vitest";
import { idempotencyKey } from "../money/ids.js";
import { DEFAULT_OPERATIONAL_SETTINGS, type SettingsStore } from "../ports/settings-store.js";
import type { TaxSettings } from "../pricing/tax-settings.js";

const SAMPLE_TAX: TaxSettings = {
	enabled: true,
	pricesIncludeTax: true,
	basedOn: "base",
	baseAddress: { country: "GB", region: null },
	shippingTaxClass: { kind: "fixed", taxClassId: "reduced" },
	roundAtSubtotal: true,
	displayCart: "incl",
	totalsDisplay: "single",
};

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

		// PR 2a: the `tax` block rides in the same singleton. Absent means "never saved",
		// which is what the upgrade rule keys on — never a default block.
		test("tax is absent until saved, and an update without it never writes one", async () => {
			const { store } = await makeStore();
			expect((await store.get()).tax).toBeUndefined();
			await store.update({ holdTtlMinutes: 30 }, idempotencyKey("k1"));
			expect((await store.get()).tax).toBeUndefined();
		});

		test("the tax block round-trips whole, and a later partial update keeps it", async () => {
			const { store } = await makeStore();
			const result = await store.update({ tax: SAMPLE_TAX }, idempotencyKey("k1"));
			expect(result.tax).toEqual(SAMPLE_TAX);
			expect((await store.get()).tax).toEqual(SAMPLE_TAX);
			await store.update({ lowStockThreshold: 3 }, idempotencyKey("k2"));
			expect((await store.get()).tax).toEqual(SAMPLE_TAX);
			const changed = { ...SAMPLE_TAX, enabled: false };
			await store.update({ tax: changed }, idempotencyKey("k3"));
			expect((await store.get()).tax).toEqual(changed);
			// A same-key replay returns its recorded result and does not clobber.
			expect((await store.update({ tax: SAMPLE_TAX }, idempotencyKey("k1"))).tax).toEqual(
				SAMPLE_TAX,
			);
			expect((await store.get()).tax).toEqual(changed);
		});
	});
}
