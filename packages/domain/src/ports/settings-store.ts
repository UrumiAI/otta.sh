import { CURRENCY_PATTERN } from "../money/cents.js";
import type { IdempotencyKey } from "../money/ids.js";
import { sameTaxSettings, type TaxSettings } from "../pricing/tax-settings.js";

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
		options?: SettingsUpdateOptions,
	): Promise<OperationalSettings>;
}

/** A condition on an `update`, checked atomically with its write. */
export interface SettingsUpdateOptions {
	/**
	 * Apply only while the stored `tax` block is still this one, by value — `null`:
	 * only while none is saved. Checked against the very state the write replaces
	 * (the emdash store re-checks it on every compare-and-set attempt), so a peer's
	 * write that lands in between makes this one refuse rather than overwrite. On a
	 * mismatch nothing is written or recorded and {@link SettingsPreconditionFailedError}
	 * is thrown; a replay of a key that already landed returns its result as usual.
	 */
	ifTax?: TaxSettings | null;
}

/** A guarded `update` whose condition no longer holds. Nothing was written. */
export class SettingsPreconditionFailedError extends Error {
	override readonly name = "SettingsPreconditionFailedError";
	/** Structural discriminator — survives a sandbox bridge, unlike `instanceof`. */
	readonly code = "SETTINGS_PRECONDITION_FAILED";
	/** The settings the condition was checked against. */
	readonly current: OperationalSettings;

	constructor(current: OperationalSettings) {
		super("settings changed since they were read — the guarded update was not applied");
		this.current = current;
	}
}

/** Structural test for {@link SettingsPreconditionFailedError}. */
export function isSettingsPreconditionFailedError(
	err: unknown,
): err is SettingsPreconditionFailedError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "SETTINGS_PRECONDITION_FAILED"
	);
}

/** Whether `current` satisfies `options` (true when there is no condition). */
export function settingsUpdateAllowed(
	current: OperationalSettings,
	options: SettingsUpdateOptions | undefined,
): boolean {
	if (options?.ifTax === undefined) return true;
	if (options.ifTax === null) return current.tax === undefined;
	return current.tax !== undefined && sameTaxSettings(current.tax, options.ifTax);
}

export interface OperationalSettings {
	/** Cart-hold TTL in minutes (positive integer). */
	holdTtlMinutes: number;
	/** Default low-stock threshold (non-negative integer). */
	lowStockThreshold: number;
	/**
	 * The tax options (PR 2a, ADR-0032), replaced WHOLE by an update. ABSENT means
	 * never saved — the upgrade rule (`effectiveTaxSettings`) decides what that
	 * means — so `get()` never fills it with a default.
	 */
	tax?: TaxSettings;
	/**
	 * The store currency: the currency a NEW cart is created in when the caller
	 * names none. An ISO 4217 code from the currency table (`isSupportedCurrency`
	 * is checked on update). ABSENT means never saved — `effectiveStoreCurrency`
	 * decides what that means (USD, what every store had before the setting
	 * existed) — so `get()` never fills it with a default. Existing carts keep the
	 * currency they were created in.
	 */
	currency?: string;
}

/** Defaults returned by `get()` before anything is persisted (§5.1). */
export const DEFAULT_OPERATIONAL_SETTINGS: OperationalSettings = {
	holdTtlMinutes: 15,
	lowStockThreshold: 5,
};

/** The store currency of a store that never saved one — the currency every cart
 *  was created in before the setting existed. */
export const DEFAULT_STORE_CURRENCY = "USD";

/**
 * The upgrade rule for the store currency, the counterpart of
 * `effectiveTaxSettings`: a saved code wins; a store that never saved one keeps
 * {@link DEFAULT_STORE_CURRENCY}, exactly what it had before.
 */
export function effectiveStoreCurrency(settings: Pick<OperationalSettings, "currency">): string {
	return settings.currency ?? DEFAULT_STORE_CURRENCY;
}

/**
 * A stored store currency, read back: a shape-valid code (`CURRENCY_PATTERN`;
 * membership is the WRITE side's, in `updateSettings`), or `undefined` (never
 * saved, or not a code at all). Shape, not table membership, on purpose: a read
 * path never refuses data a write accepted (currencies.ts), and a code the table
 * later drops still names the currency the operator chose.
 */
export function readStoreCurrency(raw: unknown): string | undefined {
	return typeof raw === "string" && CURRENCY_PATTERN.test(raw) ? raw : undefined;
}
