import {
	type Clock,
	DEFAULT_OPERATIONAL_SETTINGS,
	type IdempotencyKey,
	type OperationalSettings,
	type SettingsStore,
} from "@urumi/domain";
import type { Kysely } from "kysely";
import type { Database } from "./schema.js";

/** The single settings row's fixed primary key. */
const SINGLETON_ID = "singleton";

export interface KyselySettingsStoreOptions {
	db: Kysely<Database>;
	clock: Clock;
}

/**
 * `SettingsStore` over Kysely (§5.2), dialect-agnostic across better-sqlite3 and
 * pg. `get` returns the single row or the domain defaults (never an error for "no
 * row yet"). `update` is idempotency-ledgered exactly like `coupon_redemptions`:
 * inside one transaction it reads current, computes the merged result, CLAIMS the
 * key (`INSERT … ON CONFLICT DO NOTHING`), and only the claim winner upserts the
 * settings row — a replay (or concurrent same-key peer) returns the RECORDED
 * result and never re-applies, so a stale replay cannot clobber a newer write.
 */
export class KyselySettingsStore implements SettingsStore {
	readonly #db: Kysely<Database>;
	readonly #clock: Clock;

	constructor(options: KyselySettingsStoreOptions) {
		this.#db = options.db;
		this.#clock = options.clock;
	}

	async get(): Promise<OperationalSettings> {
		const row = await this.#db
			.selectFrom("settings")
			.select(["hold_ttl_minutes", "low_stock_threshold"])
			.where("id", "=", SINGLETON_ID)
			.executeTakeFirst();
		if (row === undefined) return { ...DEFAULT_OPERATIONAL_SETTINGS };
		return {
			holdTtlMinutes: row.hold_ttl_minutes,
			lowStockThreshold: row.low_stock_threshold,
		};
	}

	async update(
		patch: Partial<OperationalSettings>,
		idempotencyKey: IdempotencyKey,
	): Promise<OperationalSettings> {
		// Fast-path replay short-circuit (outside the tx — mirrors reserve/redeem).
		const recorded = await this.#findMutation(idempotencyKey);
		if (recorded !== undefined) return recorded;

		const now = this.#clock.now().toISOString();
		return this.#db.transaction().execute(async (trx) => {
			const current = await trx
				.selectFrom("settings")
				.select(["hold_ttl_minutes", "low_stock_threshold"])
				.where("id", "=", SINGLETON_ID)
				.executeTakeFirst();
			const base: OperationalSettings =
				current === undefined
					? { ...DEFAULT_OPERATIONAL_SETTINGS }
					: {
							holdTtlMinutes: current.hold_ttl_minutes,
							lowStockThreshold: current.low_stock_threshold,
						};
			const next: OperationalSettings = {
				holdTtlMinutes: patch.holdTtlMinutes ?? base.holdTtlMinutes,
				lowStockThreshold: patch.lowStockThreshold ?? base.lowStockThreshold,
			};

			// Claim the key with the RESULTING values. A concurrent same-key peer makes
			// this a no-op conflict — re-read and return the recorded result, applying
			// nothing (idempotent, no double-apply, no clobber of a newer write).
			const claim = await trx
				.insertInto("settings_mutations")
				.values({
					idempotency_key: idempotencyKey,
					hold_ttl_minutes: next.holdTtlMinutes,
					low_stock_threshold: next.lowStockThreshold,
					created_at: now,
				})
				.onConflict((oc) => oc.column("idempotency_key").doNothing())
				.returning("idempotency_key")
				.executeTakeFirst();
			if (claim === undefined) {
				const raced = await trx
					.selectFrom("settings_mutations")
					.select(["hold_ttl_minutes", "low_stock_threshold"])
					.where("idempotency_key", "=", idempotencyKey)
					.executeTakeFirstOrThrow();
				return {
					holdTtlMinutes: raced.hold_ttl_minutes,
					lowStockThreshold: raced.low_stock_threshold,
				};
			}

			await trx
				.insertInto("settings")
				.values({
					id: SINGLETON_ID,
					hold_ttl_minutes: next.holdTtlMinutes,
					low_stock_threshold: next.lowStockThreshold,
					updated_at: now,
				})
				.onConflict((oc) =>
					oc.column("id").doUpdateSet({
						hold_ttl_minutes: next.holdTtlMinutes,
						low_stock_threshold: next.lowStockThreshold,
						updated_at: now,
					}),
				)
				.execute();
			return next;
		});
	}

	async #findMutation(key: string): Promise<OperationalSettings | undefined> {
		const row = await this.#db
			.selectFrom("settings_mutations")
			.select(["hold_ttl_minutes", "low_stock_threshold"])
			.where("idempotency_key", "=", key)
			.executeTakeFirst();
		if (row === undefined) return undefined;
		return {
			holdTtlMinutes: row.hold_ttl_minutes,
			lowStockThreshold: row.low_stock_threshold,
		};
	}
}
