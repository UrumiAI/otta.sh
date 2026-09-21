/**
 * The reporting + settings surface (Phase-7, plan §4.4/§5.3) — the port the
 * Reports page, the Settings form and the Products console hold, plus the
 * wire-shaped types that cross it.
 *
 * These types are defined LOCALLY and deliberately: this module NEVER imports
 * `@otta-sh/domain`, which keeps the plugin sandbox-clean. Money is integer
 * minor units + ISO-4217 currency throughout. The "wire" in the names is
 * historical — it was once the JSON shape of a separate commerce service — and
 * it is still exactly the shape the admin route's JSON responses use, so the
 * name stays accurate.
 */

export interface RevenueBucketWire {
	bucketStart: string;
	currency: string;
	revenueCents: number;
	/**
	 * Money refunded on the orders in this bucket — integer minor units in the
	 * bucket's own `currency`, stated ALONGSIDE `revenueCents` and never netted
	 * into it.
	 *
	 * OPTIONAL ON THIS TYPE, AND ONLY FOR ONE REASON: a reader that predates the
	 * field omits the key. The current one emits it unconditionally, zero
	 * included — so `0` means "nothing came back", which is a FACT worth
	 * rendering as `$0.00`, and only the key's ABSENCE means "refunds are not
	 * reported here". A renderer must branch on presence, never on truthiness,
	 * and `?? 0` here would turn an unreportable period into a confident claim
	 * that nothing was refunded.
	 *
	 * Counts FINALIZED refunds (money that actually moved) against orders PLACED
	 * in the period — the same cohort `orders-by-status` counts, so the amount
	 * and the refunded-order count on one tile always describe the same set.
	 */
	refundedCents?: number;
}
export interface StatusCountWire {
	status: string;
	orderCount: number;
}
export interface TopProductWire {
	productId: string;
	titleSnapshot: string;
	qtySold: number;
	revenueCents: number;
}
export interface LowStockWire {
	sku: string;
	onHand: number;
	/** The LIVE product's title for this sku.
	 *
	 *  `null` when no live product claims the sku (never synced, soft-deleted,
	 *  or its own title is genuinely null) — and null is the ONLY fallback. The
	 *  read never substitutes the sku, which is already its own field on this
	 *  row; doing so would make "named SKU-42" and "name unknown"
	 *  indistinguishable and stop a renderer's `(untitled)` affordance from
	 *  ever firing. */
	title: string | null;
}
export interface OperationalSettingsWire {
	holdTtlMinutes: number;
	lowStockThreshold: number;
}

export interface DateRangeInput {
	from: string;
	to: string;
}

/**
 * WHY a settings save fails, STRUCTURALLY — the field a caller branches on
 * (work order 02, INC-B10c-ii).
 *
 *  - `validation` — the patch itself was refused. The `message` is the one worth
 *    showing inline beside the field.
 *  - `superseded` — the mutation lost a compare-and-set race against a
 *    concurrent save and was NOT applied. Not retryable under the same key: the
 *    key already decided, and the decision was "someone else got there first".
 *    Re-read and offer the fresh values rather than re-submitting.
 *  - `unavailable` — the store could not answer. Nothing is known about whether
 *    the patch applied; a re-read is the only honest next step.
 */
export type UpdateSettingsFailureReason = "validation" | "superseded" | "unavailable";

/**
 * A settings save returns a discriminated result rather than throwing, so the
 * form can surface a validation error INLINE instead of swallowing it into a
 * generic failure (§5.3).
 *
 * `reason` IS THE FIELD TO BRANCH ON. `status` is a VESTIGIAL fallback from the
 * era of an HTTP commerce service: the in-process implementation has no wire and
 * therefore no status, and it refuses to synthesize one, because a fabricated
 * `409` would be indistinguishable from a real one and would teach a caller to
 * read a transport artefact that does not exist here (the ratified INC-B10a rule
 * — a typed failure is represented structurally, never mapped onto an invented
 * HTTP status). So BOTH keys are optional: a caller branches on `reason` first
 * and falls back to `status` only when `reason` is absent.
 */
export type UpdateSettingsResult =
	| { ok: true; settings: OperationalSettingsWire }
	| {
			ok: false;
			/** Present on every tier that can say WHY. Branch on this first. */
			reason?: UpdateSettingsFailureReason;
			/** The HTTP status, on the HTTP tier only. Never synthesized elsewhere. */
			status?: number;
			message: string;
	  };

/**
 * THE REPORTING + SETTINGS SURFACE, structurally — what the Reports page, the
 * Settings form and the Products console may ask for, with no claim about how it
 * gets done (work order 02, INC-B10c-ii).
 *
 * ONE implementation answers to this now (work order 02, INC-D3b):
 * `InProcessReportingSettingsClient`, which composes this behaviour over the
 * plugin's own document store. The `ctx.http` client that used to be the second
 * implementation is gone with the commerce service it talked to, and with it the
 * reason this was a `Pick` over a nominal class rather than an interface — so it
 * is written out as an interface now, which is what it always described.
 *
 * EVERY METHOD IS LISTED, and writing them out is still the point: a method
 * added to the in-process client without being declared here is not part of the
 * surface, and a method declared here that the client does not implement is a
 * compile error — not a runtime gap on whichever screen reached for it first.
 */
export interface ReportingSettingsSurface {
	/** Revenue bucketed over a half-open range, in the requested interval.
	 *  Refunds are reported ALONGSIDE revenue, never netted into it. */
	getRevenue(
		range: DateRangeInput,
		interval: "day" | "week" | "month",
	): Promise<RevenueBucketWire[]>;

	/** Order counts by status over a half-open range. */
	getOrdersByStatus(range: DateRangeInput): Promise<StatusCountWire[]>;

	/** The top `limit` products over a half-open range, ranked by `metric`. */
	getTopProducts(
		range: DateRangeInput,
		metric: "revenue" | "quantity",
		limit: number,
	): Promise<TopProductWire[]>;

	/** Skus at or below the low-stock threshold — the store's configured one when
	 *  `threshold` is omitted. */
	getLowStock(threshold?: number): Promise<LowStockWire[]>;

	/** The operational settings (hold TTL, low-stock threshold). */
	getSettings(): Promise<OperationalSettingsWire>;

	/** Apply a settings patch under `opts.idempotencyKey`. Returns a
	 *  discriminated result rather than throwing so a validation failure can be
	 *  shown INLINE beside the field; branch on `reason` (see
	 *  {@link UpdateSettingsResult}). */
	updateSettings(
		patch: Partial<OperationalSettingsWire>,
		opts: { idempotencyKey: string; adminToken?: string },
	): Promise<UpdateSettingsResult>;
}
