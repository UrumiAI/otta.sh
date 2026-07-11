import type { IdempotencyKey } from "../money/ids.js";
import type { OperationalSettings, SettingsStore } from "../ports/settings-store.js";

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

export async function getSettings(store: SettingsStore): Promise<OperationalSettings> {
	return store.get();
}

export async function updateSettings(
	store: SettingsStore,
	patch: Partial<OperationalSettings>,
	idempotencyKey: IdempotencyKey,
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
	return store.update(patch, idempotencyKey);
}
