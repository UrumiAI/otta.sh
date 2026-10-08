import {
	effectiveStoreCurrency,
	getSettings,
	idempotencyKey,
	InvalidSettingsError,
	readStoreCurrency,
	updateSettings,
} from "@otta-sh/domain";
import { InMemorySettingsStore, settingsStoreContract } from "@otta-sh/domain/testing";
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

	test("updateSettings saves a supported store currency", async () => {
		const store = new InMemorySettingsStore();
		const result = await updateSettings(store, { currency: "INR" }, idempotencyKey("k1"));
		expect(result.currency).toBe("INR");
		expect((await getSettings(store)).currency).toBe("INR");
	});

	test.each(["usd", "XXX", "ISK", "", " EUR", "EURO"])(
		"updateSettings refuses the store currency %j before it reaches the store",
		async (code) => {
			const store = new InMemorySettingsStore();
			const refused = await updateSettings(store, { currency: code }, idempotencyKey("k1")).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(refused).toBeInstanceOf(InvalidSettingsError);
			expect((refused as InvalidSettingsError).field).toBe("currency");
			expect((await getSettings(store)).currency).toBeUndefined();
		},
	);

	test("updateSettings refuses a non-string store currency", async () => {
		const store = new InMemorySettingsStore();
		await expect(
			updateSettings(store, { currency: 840 as unknown as string }, idempotencyKey("k1")),
		).rejects.toBeInstanceOf(InvalidSettingsError);
	});
});

describe("effectiveStoreCurrency — the never-saved upgrade rule", () => {
	test("a store that never saved one is USD, exactly as before the setting existed", async () => {
		expect(effectiveStoreCurrency(await getSettings(new InMemorySettingsStore()))).toBe("USD");
		expect(effectiveStoreCurrency({})).toBe("USD");
	});

	test("a saved code wins", () => {
		expect(effectiveStoreCurrency({ currency: "JPY" })).toBe("JPY");
	});

	test("readStoreCurrency keeps a shape-valid code and drops anything else", () => {
		expect(readStoreCurrency("EUR")).toBe("EUR");
		// Shape, not membership: a read never refuses what a write once accepted.
		expect(readStoreCurrency("XYZ")).toBe("XYZ");
		for (const raw of [undefined, null, "", "eur", "EURO", 978, {}]) {
			expect(readStoreCurrency(raw)).toBeUndefined();
		}
	});
});
