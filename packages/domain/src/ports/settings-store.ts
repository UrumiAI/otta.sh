import type { IdempotencyKey } from "../money/ids.js";

/**
 * `SettingsStore` (Phase 7 §5.2). The service-DB tier of the settings split:
 * non-secret OPERATIONAL config the domain logic depends on (the cart
 * hold-expiry cron's `holdTtlMinutes`, the low-stock report's default
 * `lowStockThreshold`). Reached through a port like every other piece of domain
 * state — never an env var (needs a deploy to change) and never `ctx.kv` (plugin
 * storage the service can't read). Secrets NEVER live here.
 */
export interface SettingsStore {
	/** The current operational settings, defaulting unset fields (never errors
	 *  for "no row yet"). */
	get(): Promise<OperationalSettings>;

	/**
	 * Validated partial update, returning the full resulting settings. Carries an
	 * `idempotencyKey` like every other command (CLAUDE.md non-negotiable): a
	 * replay with the same key returns the RECORDED result of that mutation and
	 * does NOT re-apply — so a stale replay arriving after a newer update never
	 * clobbers it back.
	 */
	update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
	): Promise<OperationalSettings>;
}

export interface OperationalSettings {
	/** Cart-hold TTL in minutes (positive integer). */
	holdTtlMinutes: number;
	/** Default low-stock threshold (non-negative integer). */
	lowStockThreshold: number;
}

/** Defaults returned by `get()` before anything is persisted (§5.1). */
export const DEFAULT_OPERATIONAL_SETTINGS: OperationalSettings = {
	holdTtlMinutes: 15,
	lowStockThreshold: 5,
};
