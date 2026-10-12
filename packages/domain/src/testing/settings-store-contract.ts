import { describe, expect, test } from "vitest";
import { idempotencyKey } from "../money/ids.js";
import {
	DEFAULT_OPERATIONAL_SETTINGS,
	isSettingsPreconditionFailedError,
	type SettingsStore,
} from "../ports/settings-store.js";
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

		// The store currency rides in the same singleton, with the same rule as the
		// tax block: absent means "never saved" (`effectiveStoreCurrency` decides),
		// so `get()` never fills it, and no other update ever writes one.
		test("currency is absent until saved, and an update without it never writes one", async () => {
			const { store } = await makeStore();
			expect((await store.get()).currency).toBeUndefined();
			await store.update({ holdTtlMinutes: 30 }, idempotencyKey("k1"));
			await store.update({ tax: SAMPLE_TAX }, idempotencyKey("k2"));
			const after = await store.get();
			expect(after.currency).toBeUndefined();
			expect("currency" in after).toBe(false);
		});

		test("currency round-trips, a later update replaces it, and a partial update keeps it", async () => {
			const { store } = await makeStore();
			const result = await store.update({ currency: "EUR" }, idempotencyKey("k1"));
			expect(result).toEqual({ holdTtlMinutes: 15, lowStockThreshold: 5, currency: "EUR" });
			expect(await store.get()).toEqual({
				holdTtlMinutes: 15,
				lowStockThreshold: 5,
				currency: "EUR",
			});
			await store.update({ lowStockThreshold: 3 }, idempotencyKey("k2"));
			expect((await store.get()).currency).toBe("EUR");
			await store.update({ currency: "JPY" }, idempotencyKey("k3"));
			expect((await store.get()).currency).toBe("JPY");
			// A same-key replay returns its recorded result and does not clobber.
			expect((await store.update({ currency: "EUR" }, idempotencyKey("k1"))).currency).toBe("EUR");
			expect((await store.get()).currency).toBe("JPY");
		});

		test("saving the currency keeps the tax block, and saving the tax block keeps the currency", async () => {
			const { store } = await makeStore();
			await store.update({ tax: SAMPLE_TAX }, idempotencyKey("k1"));
			await store.update({ currency: "GBP" }, idempotencyKey("k2"));
			expect(await store.get()).toEqual({
				holdTtlMinutes: 15,
				lowStockThreshold: 5,
				tax: SAMPLE_TAX,
				currency: "GBP",
			});
			const changed = { ...SAMPLE_TAX, enabled: false };
			await store.update({ tax: changed }, idempotencyKey("k3"), { ifTax: SAMPLE_TAX });
			expect(await store.get()).toEqual({
				holdTtlMinutes: 15,
				lowStockThreshold: 5,
				tax: changed,
				currency: "GBP",
			});
		});

		test("ifTax guards a currency update too: refused while the tax block differs, nothing written", async () => {
			const { store } = await makeStore();
			await store.update({ tax: SAMPLE_TAX }, idempotencyKey("k1"));
			await expect(
				store.update({ currency: "EUR" }, idempotencyKey("k2"), { ifTax: null }),
			).rejects.toSatisfy(isSettingsPreconditionFailedError);
			expect((await store.get()).currency).toBeUndefined();
		});

		// Review 2a B2: a write conditional on the tax block, checked atomically with
		// the write — the first-rate pin ("only if never saved") and the admin save
		// ("only if still what the form loaded") ride on it.
		test("ifTax: null applies only while no tax block is saved", async () => {
			const { store } = await makeStore();
			const pinned = await store.update({ tax: SAMPLE_TAX }, idempotencyKey("pin"), {
				ifTax: null,
			});
			expect(pinned.tax).toEqual(SAMPLE_TAX);
			const changed = { ...SAMPLE_TAX, enabled: false };
			const refused = await store
				.update({ tax: changed }, idempotencyKey("pin-2"), { ifTax: null })
				.then(
					() => undefined,
					(err: unknown) => err,
				);
			expect(isSettingsPreconditionFailedError(refused), String(refused)).toBe(true);
			if (isSettingsPreconditionFailedError(refused)) {
				expect(refused.current.tax).toEqual(SAMPLE_TAX);
			}
			expect((await store.get()).tax).toEqual(SAMPLE_TAX);
		});

		test("ifTax: a block applies only while that block is the one saved", async () => {
			const { store } = await makeStore();
			await store.update({ tax: SAMPLE_TAX }, idempotencyKey("k1"));
			const next = { ...SAMPLE_TAX, roundAtSubtotal: false };
			const stale = { ...SAMPLE_TAX, displayCart: "excl" as const };
			await expect(
				store.update({ tax: next }, idempotencyKey("k2"), { ifTax: stale }),
			).rejects.toSatisfy(isSettingsPreconditionFailedError);
			expect((await store.get()).tax).toEqual(SAMPLE_TAX);
			// Nothing was recorded for the refused key: the same key, now guarded on
			// the block that IS saved, applies.
			const applied = await store.update({ tax: next }, idempotencyKey("k2"), {
				ifTax: SAMPLE_TAX,
			});
			expect(applied.tax).toEqual(next);
			expect((await store.get()).tax).toEqual(next);
		});
	});
}
