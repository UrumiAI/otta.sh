import type { IdempotencyKey } from "../money/ids.js";
import {
	DEFAULT_OPERATIONAL_SETTINGS,
	type OperationalSettings,
	SettingsPreconditionFailedError,
	type SettingsStore,
	type SettingsUpdateOptions,
	settingsUpdateAllowed,
} from "../ports/settings-store.js";

/**
 * IO-free `SettingsStore` fake (first adapter to pass `settingsStoreContract`).
 * Models the real upsert + idempotency-ledger choreography: `update` records the
 * resulting settings under its `idempotencyKey`; a replay returns that recorded
 * snapshot WITHOUT re-applying, so a stale replay arriving after a newer update
 * never clobbers it back (mirrors `INSERT … ON CONFLICT DO NOTHING` + re-read).
 */
export class InMemorySettingsStore implements SettingsStore {
	#current: OperationalSettings = { ...DEFAULT_OPERATIONAL_SETTINGS };
	#ledger = new Map<string, OperationalSettings>();

	async get(): Promise<OperationalSettings> {
		return structuredClone(this.#current);
	}

	async update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
		options?: SettingsUpdateOptions,
	): Promise<OperationalSettings> {
		const recorded = this.#ledger.get(idempotencyKey);
		if (recorded !== undefined) return structuredClone(recorded);
		if (!settingsUpdateAllowed(this.#current, options)) {
			throw new SettingsPreconditionFailedError(structuredClone(this.#current));
		}

		const next: OperationalSettings = {
			holdTtlMinutes: patch.holdTtlMinutes ?? this.#current.holdTtlMinutes,
			lowStockThreshold: patch.lowStockThreshold ?? this.#current.lowStockThreshold,
		};
		const tax = patch.tax ?? this.#current.tax;
		if (tax !== undefined) next.tax = structuredClone(tax);
		this.#current = next;
		this.#ledger.set(idempotencyKey, structuredClone(next));
		return structuredClone(next);
	}
}
