import type { IdempotencyKey } from "../money/ids.js";
import {
	DEFAULT_OPERATIONAL_SETTINGS,
	type OperationalSettings,
	type SettingsStore,
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
		return { ...this.#current };
	}

	async update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
	): Promise<OperationalSettings> {
		const recorded = this.#ledger.get(idempotencyKey);
		if (recorded !== undefined) return { ...recorded };

		const next: OperationalSettings = {
			holdTtlMinutes: patch.holdTtlMinutes ?? this.#current.holdTtlMinutes,
			lowStockThreshold: patch.lowStockThreshold ?? this.#current.lowStockThreshold,
		};
		this.#current = next;
		this.#ledger.set(idempotencyKey, { ...next });
		return { ...next };
	}
}
