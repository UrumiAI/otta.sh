/**
 * `InProcessReportingSettingsClient` — the admin REPORTING + SETTINGS surface
 * (revenue, orders-by-status, top products, low stock, and the operational
 * settings tier) with commerce truth held on the plugin's own document store
 * (work order 02, INC-B10c-ii).
 *
 * WHAT THIS CLASS IS. The in-process twin of `ReportingSettingsClient`: the same
 * six methods, the same argument shapes, the same RETURN VALUES — every field the
 * HTTP wire carries — with the `@otta-sh/domain` reporting/settings use-cases
 * composed over the `@otta-sh/store-emdash` adapters bound to `ctx.storage`
 * instead of a commerce service. Nothing here reaches for egress; `ctx.http` is
 * never touched.
 *
 * `refundedCents` IS ALWAYS EMITTED, zero included. The wire type marks it
 * optional for exactly one reason — a service older than the field omits it — and
 * this tier is not that service. `0` is the FACT "nothing came back in this
 * bucket"; the KEY's absence would be the different fact "this transport cannot
 * report refunds at all". Dropping a zero here would collapse the two and stop a
 * renderer from ever being able to tell them apart.
 *
 * A LOW-STOCK ROW IS NEVER TITLED WITH ITS SKU. `title` is the live product's
 * title or `null`, and null is the only fallback — the port's rule, passed
 * through unchanged. Four distinct causes produce null (no sku claim, a released
 * claim, a claim held by a VARIANT rather than the product row, or a live product
 * whose own title is genuinely null), and all four mean "we do not know its
 * name", which is not the same statement as "it is called SKU-42".
 *
 * TOP PRODUCTS GROUPS BY `(productId, title)`, not by the product. A product sold
 * under two titles is legitimately two rows, because the line snapshot froze the
 * title at purchase time and the title is a fact about the SALE. Merging them
 * would rewrite history to whatever the product is called today.
 *
 * AN EMPTY PERIOD IS OMITTED, never zero-filled. Zero-filling is a renderer's job
 * and it needs the report's own silence to know which days it is filling; a
 * report that invented the zeros would leave nothing to distinguish "no orders"
 * from "no data".
 *
 * HOW A REFUSED INPUT SURFACES. The request schemas that stood in front of the
 * `/reports/*` and `/settings` routes are mirrored below through
 * `commerce-input.ts`, and a refused input SHAPE — a malformed instant, an
 * interval or metric that is not one, a limit or threshold out of bounds, an
 * empty idempotency key — REJECTS with a structural `INVALID_INPUT` naming the
 * field, exactly as the rules and products clients do. It never resolves to a
 * synthesized status, because there is no wire here to have one.
 *
 * `updateSettings` IS THE ONE METHOD THAT DOES NOT THROW for a refused VALUE, and
 * the distinction is deliberate: the wire type's whole purpose is that a bad
 * `holdTtlMinutes` comes back as `{ ok: false }` for the form to render inline
 * rather than as an exception the page has to catch. So input SHAPE rejects and a
 * refused VALUE resolves — the same split the HTTP tier has, where the 400 body
 * is a result and a transport failure is a throw.
 *
 * AND THE FAILURE ARM CARRIES `reason`, NOT A FABRICATED `status`. A
 * compare-and-set loss comes back `reason: "superseded"` with no status at all.
 * Inventing a `409` would be indistinguishable from a real one and would teach
 * the console to read a transport artefact this transport does not have — the
 * ratified INC-B10a rule: a typed failure is represented structurally in-process,
 * never mapped onto an invented HTTP status.
 *
 * NO ADMIN AUTH HERE, deliberately (ADR-0014 D3). `X-Internal-Token` /
 * `X-Service-Token` authenticate a caller TO THE SERVICE, and there is no service
 * here; EmDash's own admin auth and CSRF gate the console routes that construct
 * this. So the constructor takes no token of any kind, and there is nothing for
 * one to be forgotten in.
 *
 * SANDBOX-CLEAN. No `fetch`, no `node:` builtin, no host import.
 */

import {
	getLowStockReport,
	getOrdersByStatusReport,
	getRevenueReport,
	getSettings as getSettingsUseCase,
	getTopProductsReport,
	idempotencyKey as toIdempotencyKey,
	InvalidSettingsError,
	updateSettings as updateSettingsUseCase,
	type OperationalSettings,
	type ReportInterval,
	type TopProductsMetric,
} from "@otta-sh/domain";
import { isSettingsMutationSupersededError } from "@otta-sh/store-emdash";
import { CommerceInputError, requireIdempotencyKey } from "../commerce/commerce-input.js";
import {
	createInProcessCommerceStores,
	type InProcessCommerceStores,
	type InProcessCommerceStoresOptions,
} from "../commerce/in-process-commerce-stores.js";
import type { PluginContext } from "../types.js";
import type {
	DateRangeInput,
	LowStockWire,
	OperationalSettingsWire,
	ReportingSettingsSurface,
	RevenueBucketWire,
	StatusCountWire,
	TopProductWire,
	UpdateSettingsResult,
} from "./reporting-client.js";

/** `topProductsQuery.limit`: `z.coerce.number().int().positive().max(1000)`.
 *  Mirrored, not imported — the service package goes away. */
const MAX_TOP_PRODUCTS_LIMIT = 1000;

/** `lowStockQuery.threshold` / `settingsBody.lowStockThreshold`: bounded by
 *  `int4`'s maximum, because the threshold is compared against an `integer`
 *  on-hand column on the other dialect. Refusing MORE than the other transport
 *  refuses is a divergence too, so the bound is the wire's, to the digit. */
const MAX_LOW_STOCK_THRESHOLD = 2_147_483_647;

/** The intervals `reportRevenueQuery` enumerates. */
const REPORT_INTERVALS = ["day", "week", "month"] as const satisfies readonly ReportInterval[];

/** The metrics `topProductsQuery` enumerates. */
const TOP_PRODUCTS_METRICS = [
	"revenue",
	"quantity",
] as const satisfies readonly TopProductsMetric[];

/** `z.string().datetime()` — an ISO-8601 UTC instant, `Z`-terminated, with
 *  optional fractional seconds and NO offset. Mirrored because the route parsed
 *  the query with it before the use-case ever saw the range. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class InProcessReportingSettingsClient implements ReportingSettingsSurface {
	readonly #stores: InProcessCommerceStores;

	/**
	 * Takes the whole context and constructs the adapters once per client, the
	 * same request-scoped lifecycle the console pages already had. A context with
	 * no document store fails HERE, at construction, naming what is missing.
	 */
	constructor(ctx: PluginContext, options: InProcessCommerceStoresOptions = {}) {
		this.#stores = createInProcessCommerceStores(ctx, options);
	}

	// -- Reports ---------------------------------------------------------------

	async getRevenue(
		range: DateRangeInput,
		interval: "day" | "week" | "month",
	): Promise<RevenueBucketWire[]> {
		const window = requireRange(range);
		requireEnum("interval", interval, REPORT_INTERVALS);
		const buckets = await getRevenueReport(this.#stores.reportingStore, window, interval);
		return buckets.map((bucket) => ({
			bucketStart: bucket.bucketStart,
			currency: bucket.currency,
			revenueCents: bucket.revenueCents,
			// ALWAYS, zero included — see the class doc.
			refundedCents: bucket.refundedCents,
		}));
	}

	async getOrdersByStatus(range: DateRangeInput): Promise<StatusCountWire[]> {
		const counts = await getOrdersByStatusReport(this.#stores.reportingStore, requireRange(range));
		return counts.map((count) => ({ status: count.status, orderCount: count.orderCount }));
	}

	async getTopProducts(
		range: DateRangeInput,
		metric: "revenue" | "quantity",
		limit: number,
	): Promise<TopProductWire[]> {
		const window = requireRange(range);
		requireEnum("metric", metric, TOP_PRODUCTS_METRICS);
		requireBoundedInteger("limit", limit, 1, MAX_TOP_PRODUCTS_LIMIT);
		const products = await getTopProductsReport(this.#stores.reportingStore, window, metric, limit);
		return products.map((product) => ({
			productId: product.productId,
			titleSnapshot: product.titleSnapshot,
			qtySold: product.qtySold,
			revenueCents: product.revenueCents,
		}));
	}

	/** The threshold DEFAULTS from `SettingsStore.lowStockThreshold` when the
	 *  caller omits it — the one piece of orchestration in the report set, and the
	 *  reason this client holds the settings store as well as the reporting one. */
	async getLowStock(threshold?: number): Promise<LowStockWire[]> {
		if (threshold !== undefined) {
			requireBoundedInteger("threshold", threshold, 0, MAX_LOW_STOCK_THRESHOLD);
		}
		const rows = await getLowStockReport(
			{
				reportingStore: this.#stores.reportingStore,
				settingsStore: this.#stores.settingsStore,
			},
			threshold,
		);
		// `title` passes through EXACTLY as the port spelled it, null included.
		return rows.map((row) => ({ sku: row.sku, onHand: row.onHand, title: row.title }));
	}

	// -- Settings --------------------------------------------------------------

	async getSettings(): Promise<OperationalSettingsWire> {
		return toSettingsWire(await getSettingsUseCase(this.#stores.settingsStore));
	}

	/**
	 * A partial patch under an idempotency key. The KEY decides, not the payload: a
	 * replay under the same key answers with what that key already applied, whatever
	 * the second payload says.
	 *
	 * An unknown key on `patch` is IGNORED rather than refused, because the request
	 * schema on the other transport is non-strict and strips it — refusing more
	 * than the other tier refuses is a divergence in its own right.
	 */
	async updateSettings(
		patch: Partial<OperationalSettingsWire>,
		opts: { idempotencyKey: string; adminToken?: string },
	): Promise<UpdateSettingsResult> {
		// INPUT SHAPE REJECTS. A missing key is not a refused settings value, it is
		// a caller that did not supply one, and there is no inline field to render
		// it beside. (`adminToken` is accepted and ignored: there is no service to
		// present it to — ADR-0014 D3.)
		requireIdempotencyKey(opts.idempotencyKey);

		// The one bound the DOMAIN does not carry: the threshold's `int4` ceiling
		// lived in the request schema, so without it this tier would accept a value
		// the other refuses.
		if (
			patch.lowStockThreshold !== undefined &&
			Number.isSafeInteger(patch.lowStockThreshold) &&
			patch.lowStockThreshold > MAX_LOW_STOCK_THRESHOLD
		) {
			return {
				ok: false,
				reason: "validation",
				message: `lowStockThreshold must be <= ${String(MAX_LOW_STOCK_THRESHOLD)}`,
			};
		}

		const narrowed: Partial<OperationalSettings> = {
			...(patch.holdTtlMinutes !== undefined ? { holdTtlMinutes: patch.holdTtlMinutes } : {}),
			...(patch.lowStockThreshold !== undefined
				? { lowStockThreshold: patch.lowStockThreshold }
				: {}),
		};

		try {
			const settings = await updateSettingsUseCase(
				this.#stores.settingsStore,
				narrowed,
				toIdempotencyKey(opts.idempotencyKey),
			);
			return { ok: true, settings: toSettingsWire(settings) };
		} catch (err) {
			if (err instanceof InvalidSettingsError) {
				// THE MESSAGE IS THE POINT of this arm: it names the field and the
				// bound, and the form renders it inline beside the input.
				return { ok: false, reason: "validation", message: err.message };
			}
			if (isSettingsMutationSupersededError(err)) {
				// NO `status`. A fabricated 409 would be indistinguishable from a real
				// one; the structural reason is what a caller branches on.
				return {
					ok: false,
					reason: "superseded",
					message:
						"settings were changed by someone else while this save was in flight — reload and try again",
				};
			}
			// The store could not answer. Nothing is known about whether the patch
			// applied, so the message says to re-read rather than to retry.
			return {
				ok: false,
				reason: "unavailable",
				message: "settings update failed — reload to see the current values",
			};
		}
	}
}

// -- input bounds, mirrored from the request schemas ---------------------------

/** Both ends of a report window, each an ISO-8601 UTC instant. The WIDTH is the
 *  domain's business (`MAX_REPORT_RANGE_DAYS`) and is left to it, so the two
 *  tiers refuse an over-wide window in the same place. */
function requireRange(range: DateRangeInput): { from: string; to: string } {
	return { from: requireInstant("from", range.from), to: requireInstant("to", range.to) };
}

function requireInstant(field: string, value: string): string {
	if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
		throw new CommerceInputError(field, "must be an ISO-8601 UTC instant");
	}
	return value;
}

function requireEnum<T extends string>(field: string, value: T, allowed: readonly T[]): T {
	if (!allowed.includes(value)) {
		throw new CommerceInputError(field, `must be one of ${allowed.join(", ")}`);
	}
	return value;
}

function requireBoundedInteger(field: string, value: number, min: number, max: number): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new CommerceInputError(
			field,
			`must be an integer between ${String(min)} and ${String(max)}`,
		);
	}
	return value;
}

function toSettingsWire(settings: OperationalSettings): OperationalSettingsWire {
	return {
		holdTtlMinutes: settings.holdTtlMinutes,
		lowStockThreshold: settings.lowStockThreshold,
	};
}
