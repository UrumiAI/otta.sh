import {
	getLowStockReport,
	getOrdersByStatusReport,
	getRevenueReport,
	getTopProductsReport,
	type PeriodBucket,
	type ReportingStore,
	ReportRangeTooWideError,
	type SettingsStore,
} from "@urumi/domain";
import type { Context } from "hono";
import { Hono } from "hono";
import {
	lowStockQuery,
	ordersByStatusQuery,
	reportRevenueQuery,
	topProductsQuery,
} from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";

export interface ReportsDeps {
	reportingStore: ReportingStore;
	settingsStore: SettingsStore;
	/** Admin read guard — reports expose merchant financial/operational data
	 *  (revenue, order counts, inventory levels), NOT public storefront data, so
	 *  every /reports/* read requires the internal token like other admin surface
	 *  (review J5). Unset ⇒ 503 (disabled), never silently open. */
	internalToken?: string;
}

/**
 * Phase 7 read-only reporting endpoints (§6), 1:1 with `ReportingStore`. All
 * money is serialized as integer minor units + an ISO-4217 currency string — no
 * floats on the wire. The three date-ranged endpoints reject a `from`/`to` window
 * wider than 400 days with a `400` + structured error (the domain use-case throws
 * `ReportRangeTooWideError`; a plugin-side date-picker cap is only a UX nicety).
 * Every endpoint is admin-guarded by the internal token (review J5) — this is
 * merchant-sensitive data, not public catalog data.
 */
export function reportsRoutes(deps: ReportsDeps): Hono {
	const app = new Hono();

	// Admin guard on EVERY /reports/* read (merchant financial/operational data).
	app.use("/*", async (c, next) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		await next();
	});

	app.get("/revenue", async (c) => {
		const parsed = reportRevenueQuery.safeParse({
			from: c.req.query("from"),
			to: c.req.query("to"),
			interval: c.req.query("interval"),
		});
		if (!parsed.success) return invalidQuery(c, parsed.error.issues);
		try {
			const buckets = await getRevenueReport(
				deps.reportingStore,
				{ from: parsed.data.from, to: parsed.data.to },
				parsed.data.interval,
			);
			return c.json({ ok: true, buckets: buckets.map(serializeBucket) }, 200);
		} catch (err) {
			return mapRangeError(c, err);
		}
	});

	app.get("/orders-by-status", async (c) => {
		const parsed = ordersByStatusQuery.safeParse({
			from: c.req.query("from"),
			to: c.req.query("to"),
		});
		if (!parsed.success) return invalidQuery(c, parsed.error.issues);
		try {
			const counts = await getOrdersByStatusReport(deps.reportingStore, {
				from: parsed.data.from,
				to: parsed.data.to,
			});
			return c.json({ ok: true, counts }, 200);
		} catch (err) {
			return mapRangeError(c, err);
		}
	});

	app.get("/top-products", async (c) => {
		const parsed = topProductsQuery.safeParse({
			from: c.req.query("from"),
			to: c.req.query("to"),
			metric: c.req.query("metric"),
			limit: c.req.query("limit"),
		});
		if (!parsed.success) return invalidQuery(c, parsed.error.issues);
		try {
			const products = await getTopProductsReport(
				deps.reportingStore,
				{ from: parsed.data.from, to: parsed.data.to },
				parsed.data.metric,
				parsed.data.limit,
			);
			return c.json({ ok: true, products }, 200);
		} catch (err) {
			return mapRangeError(c, err);
		}
	});

	// Low-stock has no date range (an inventory snapshot); threshold defaults from
	// SettingsStore when omitted (§4.2).
	app.get("/low-stock", async (c) => {
		const parsed = lowStockQuery.safeParse({ threshold: c.req.query("threshold") });
		if (!parsed.success) return invalidQuery(c, parsed.error.issues);
		const rows = await getLowStockReport(
			{ reportingStore: deps.reportingStore, settingsStore: deps.settingsStore },
			parsed.data.threshold,
		);
		return c.json({ ok: true, rows }, 200);
	});

	return app;
}

function serializeBucket(b: PeriodBucket): Record<string, unknown> {
	return { bucketStart: b.bucketStart, currency: b.currency, revenueCents: b.revenueCents };
}

function invalidQuery(c: Context, issues: unknown): Response {
	return c.json({ ok: false, error: "invalid query", issues }, 400);
}

/** A too-wide range is a structured 400 (never a silent clamp); anything else
 *  rethrows to the app's 500 error envelope. */
function mapRangeError(c: Context, err: unknown): Response {
	if (err instanceof ReportRangeTooWideError) {
		return c.json({ ok: false, error: "range_too_wide", maxDays: 400, message: err.message }, 400);
	}
	throw err;
}
