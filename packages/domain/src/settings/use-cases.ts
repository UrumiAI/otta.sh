import type { IdempotencyKey } from "../money/ids.js";
import type {
	OperationalSettings,
	SettingsStore,
	SettingsUpdateOptions,
} from "../ports/settings-store.js";
import { isCheckoutPayableCurrency, isSupportedCurrency } from "../money/currencies.js";
import { parseTaxSettings } from "../pricing/tax-settings.js";

/**
 * Thin IO-free orchestration over `SettingsStore` (Phase 7 §6). Validation lives
 * here — an invalid value is rejected BEFORE it reaches the store, never silently
 * clamped or coerced (adapter-architecture rule #2 / §5.3).
 */

/** Sane upper bound for the hold TTL — one week in minutes (§5.3). */
export const MAX_HOLD_TTL_MINUTES = 10_080;

/** Thrown when an `updateSettings` field is out of range. The service maps this
 *  to a `400` + structured error. */
export class InvalidSettingsError extends Error {
	readonly field: string;
	constructor(field: string, message: string) {
		super(message);
		this.name = "InvalidSettingsError";
		this.field = field;
	}
}

/**
 * A store currency checkout cannot take payment in (`isCheckoutPayableCurrency`
 * — the three-decimal codes). An {@link InvalidSettingsError} on `currency`, with
 * a structural `code` so an admin can word it.
 */
export class StoreCurrencyNotPayableError extends InvalidSettingsError {
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "STORE_CURRENCY_NOT_PAYABLE";
	readonly currency: string;
	constructor(currency: string) {
		super(
			"currency",
			`${currency} can't be the store currency: checkout can't take payment in it yet`,
		);
		this.name = "StoreCurrencyNotPayableError";
		this.currency = currency;
	}
}

export async function getSettings(store: SettingsStore): Promise<OperationalSettings> {
	return store.get();
}

export async function updateSettings(
	store: SettingsStore,
	patch: Partial<OperationalSettings>,
	idempotencyKey: IdempotencyKey,
	options?: SettingsUpdateOptions,
): Promise<OperationalSettings> {
	if (patch.holdTtlMinutes !== undefined) {
		const v = patch.holdTtlMinutes;
		if (!Number.isSafeInteger(v) || v <= 0) {
			throw new InvalidSettingsError(
				"holdTtlMinutes",
				`holdTtlMinutes must be a positive integer, got ${String(v)}`,
			);
		}
		if (v > MAX_HOLD_TTL_MINUTES) {
			throw new InvalidSettingsError(
				"holdTtlMinutes",
				`holdTtlMinutes must be <= ${MAX_HOLD_TTL_MINUTES}, got ${String(v)}`,
			);
		}
	}
	if (patch.lowStockThreshold !== undefined) {
		const v = patch.lowStockThreshold;
		if (!Number.isSafeInteger(v) || v < 0) {
			throw new InvalidSettingsError(
				"lowStockThreshold",
				`lowStockThreshold must be a non-negative integer, got ${String(v)}`,
			);
		}
	}
	if (patch.currency !== undefined) {
		const v: unknown = patch.currency;
		if (typeof v !== "string" || !isSupportedCurrency(v)) {
			throw new InvalidSettingsError(
				"currency",
				`currency must be a supported ISO 4217 code like USD or EUR, got ${String(v)}`,
			);
		}
		// Every new cart would be unpayable: checked HERE so every writer gets it.
		if (!isCheckoutPayableCurrency(v)) throw new StoreCurrencyNotPayableError(v);
	}
	if ("tax" in patch) {
		const tax = parseTaxSettings(patch.tax);
		if ("field" in tax) throw new InvalidSettingsError(tax.field, tax.message);
		return store.update({ ...patch, tax }, idempotencyKey, options);
	}
	return store.update(patch, idempotencyKey, options);
}
