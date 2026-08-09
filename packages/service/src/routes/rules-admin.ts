import {
	cents,
	currency as toCurrency,
	deleteTaxClass,
	type CouponListCursor,
	type CouponListFilter,
	type CouponStore,
	type CouponSummary,
	type ProductCommerceStore,
	type ShippingRulesStore,
	type TaxRulesStore,
} from "@otta-sh/domain";
import { Hono } from "hono";
import { z } from "zod";
import {
	couponBody,
	couponCodePathParams,
	couponIdPathParams,
	couponListFilterSchema,
	couponsListQuery,
	couponUpdateBody,
	methodCurrencyPathParams,
	methodPathParams,
	rateIdPathParams,
	shippingMethodBody,
	shippingMethodUpdateBody,
	shippingRateBody,
	shippingRateUpdateBody,
	shippingZoneBody,
	shippingZoneUpdateBody,
	taxClassBody,
	taxClassPathParams,
	taxClassUpdateBody,
	taxRateBody,
	taxRateUpdateBody,
	zonePathParams,
} from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";

export interface RulesAdminDeps {
	shippingRules: ShippingRulesStore;
	taxRules: TaxRulesStore;
	couponStore: CouponStore;
	// Increment 3 closeout: the tax-class DELETE route composes the
	// `deleteTaxClass` use-case, whose in-use guard spans BOTH the tax-config
	// aggregate (`taxRules`) and the product aggregate (`productCommerce`).
	productCommerce: ProductCommerceStore;
	internalToken?: string;
}

/**
 * Phase 6 admin CRUD for shipping / tax / coupon config (§6). Each endpoint is a
 * 1:1 serialization of a store method; EVERY endpoint — reads and writes alike —
 * requires the privileged internal token (same mechanism as the Phase-5 admin
 * transition and the `/reports/*` reads), because this is merchant config, not
 * public catalog data. The GET reads in particular expose coupon amounts, caps,
 * usage limits and live `usesCount`, so they must not be reachable ungated: the
 * app-level SERVICE_API_TOKEN write gate exempts GET/HEAD, so it does NOT cover
 * them. There are therefore NO inline `requireInternalToken` calls in this file —
 * the parent-level guard in `createApp` is authoritative (ADR-0010) and the
 * blanket guard below is its sub-app-local backstop; one guard, no drift. Money
 * on the wire is integer minor units, branded via `cents()`/`currency()` at the
 * boundary; rates are integer basis points.
 */
export function rulesAdminRoutes(deps: RulesAdminDeps): Hono {
	const app = new Hono();

	// Defense-in-depth guard on EVERY route in this sub-app — reads included
	// (merchant shipping/tax/coupon config). The AUTHORITATIVE guard is the
	// parent-level `app.use("/admin/*")` in `createApp` (ADR-0010); this one keeps
	// the sub-app closed if it is ever mounted somewhere that lacks it. It is NOT
	// a substitute: Hono merges sub-app middleware into the parent at mount time,
	// so this never covers `adminRoutes`, the sibling sub-app mounted at "/admin"
	// before it.
	app.use("/*", async (c, next) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		await next();
	});

	// -- Shipping --------------------------------------------------------------
	app.post("/shipping/zones", async (c) => {
		const parsed = shippingZoneBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const zone = await deps.shippingRules.createZone({
			id: parsed.data.id,
			name: parsed.data.name,
			regions: parsed.data.regions ?? null,
		});
		return c.json({ ok: true, zone }, 201);
	});

	app.get("/shipping/zones", async (c) => {
		return c.json({ ok: true, zones: await deps.shippingRules.listZones() }, 200);
	});

	app.post("/shipping/zones/:zoneId/methods", async (c) => {
		const params = zonePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingMethodBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const method = await deps.shippingRules.createMethod({
			id: parsed.data.id,
			zoneId: params.data.zoneId,
			name: parsed.data.name,
			type: parsed.data.type,
		});
		return c.json({ ok: true, method }, 201);
	});

	app.get("/shipping/zones/:zoneId/methods", async (c) => {
		const params = zonePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		return c.json(
			{ ok: true, methods: await deps.shippingRules.listMethods(params.data.zoneId) },
			200,
		);
	});

	app.post("/shipping/methods/:methodId/rates", async (c) => {
		const params = methodPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingRateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const rate = await deps.shippingRules.createRate({
			methodId: params.data.methodId,
			currency: toCurrency(parsed.data.currency),
			amountCents: cents(parsed.data.amountCents),
			minSubtotalCents:
				parsed.data.minSubtotalCents === null || parsed.data.minSubtotalCents === undefined
					? null
					: cents(parsed.data.minSubtotalCents),
		});
		return c.json({ ok: true, rate }, 201);
	});

	app.get("/shipping/methods/:methodId/rates", async (c) => {
		const params = methodPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const cur = c.req.query("currency");
		if (cur === undefined) return c.json({ error: "currency query is required" }, 400);
		const rate = await deps.shippingRules.getRate(params.data.methodId, toCurrency(cur));
		if (rate === null) return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: true, rate }, 200);
	});

	// -- Tax -------------------------------------------------------------------
	app.post("/tax/classes", async (c) => {
		const parsed = taxClassBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const cls = await deps.taxRules.createClass({ id: parsed.data.id, name: parsed.data.name });
		return c.json({ ok: true, taxClass: cls }, 201);
	});

	app.get("/tax/classes", async (c) => {
		return c.json({ ok: true, classes: await deps.taxRules.listClasses() }, 200);
	});

	app.post("/tax/rates", async (c) => {
		const parsed = taxRateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const rate = await deps.taxRules.createRate({
			id: parsed.data.id,
			taxClassId: parsed.data.taxClassId,
			zoneId: parsed.data.zoneId,
			rateBps: parsed.data.rateBps,
			appliesToShipping: parsed.data.appliesToShipping ?? false,
		});
		return c.json({ ok: true, rate }, 201);
	});

	app.get("/tax/rates", async (c) => {
		const zoneId = c.req.query("zoneId");
		if (zoneId === undefined) return c.json({ error: "zoneId query is required" }, 400);
		return c.json({ ok: true, rates: await deps.taxRules.listRatesForZone(zoneId) }, 200);
	});

	// -- Coupons ---------------------------------------------------------------
	app.post("/coupons", async (c) => {
		const parsed = couponBody.safeParse(await readJson(c));
		if (!parsed.success)
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		const d = parsed.data;
		const coupon = await deps.couponStore.create({
			id: d.id,
			code: d.code,
			type: d.type,
			amountCents: nn(d.amountCents),
			rateBps: d.rateBps ?? null,
			capCents: nn(d.capCents),
			currency: d.currency === null || d.currency === undefined ? null : toCurrency(d.currency),
			minSubtotalCents: nn(d.minSubtotalCents),
			startsAt: d.startsAt ?? null,
			expiresAt: d.expiresAt ?? null,
			maxUses: d.maxUses ?? null,
			maxUsesPerCustomer: d.maxUsesPerCustomer ?? null,
		});
		return c.json({ ok: true, coupon: serializeCoupon(coupon) }, 201);
	});

	// Admin Coupons console: view-only list (admin-UX Increment 3, "coupon
	// enumerate + coupon list"). Mirrors the Products console list's shape 1:1
	// (internal-token guarded, the same opaque-cursor-carries-filter-and-limit
	// encoding, MOD-1 fail-closed decode) — see admin.ts's `GET /products`.
	// Mounted at "/admin/coupons" (this router mounts at "/admin"); no path
	// collision with `GET /coupons/:code` below (a different shape) or with
	// `POST /coupons/:couponId/*` writes.
	app.get("/coupons", async (c) => {
		const parsed = couponsListQuery.safeParse(c.req.query());
		if (!parsed.success)
			return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
		const q = parsed.data;

		let filter: CouponListFilter;
		let limit: number;
		let cursorPos: CouponListCursor | null;

		if (q.cursor !== undefined) {
			// Paged request: the opaque cursor carries the keyset POSITION plus the
			// active filter (so filters survive paging) plus the page limit. Decoding
			// MUST fail CLOSED to a 400 — a malformed/tampered/garbage token never
			// 500s (MOD-1, mirrors the Products list). The decoded filter is
			// RE-VALIDATED through zod and the decoded limit RE-CLAMPED server-side
			// (never trusted past max=100).
			//
			// NOT yet at parity with the Orders/Products lists: those now fail CLOSED
			// when a request carries a cursor AND query filter/limit params that
			// disagree with the token's, while this arm still takes the predicate
			// SOLELY from the token and ignores the query's `search`/`limit`. Closing
			// it means lifting `canonicalFilter` / `has*FilterParams` out of
			// `admin.ts` and reusing them here — not copying them, which would let
			// the two canonicalizations drift apart.
			const decoded = decodeCouponCursor(q.cursor);
			if (decoded === null) return c.json({ error: "invalid cursor" }, 400);
			const filterParsed = couponListFilterSchema.safeParse(decoded.filter);
			const posParsed = couponCursorPosOf(decoded.pos);
			if (!filterParsed.success || posParsed === null) {
				return c.json({ error: "invalid cursor" }, 400);
			}
			filter = toCouponFilter(filterParsed.data);
			cursorPos = posParsed;
			limit = clampLimit(decoded.limit, q.limit);
		} else {
			filter = toCouponFilter({ search: q.search });
			cursorPos = null;
			limit = q.limit;
		}

		// The page and its EXACT count, under one filter, in parallel (INC-23) —
		// the same shape as the Orders/Products lists in `admin.ts`; `total` counts
		// the whole filtered set, never this page.
		const [result, total] = await Promise.all([
			deps.couponStore.listCoupons(filter, { cursor: cursorPos, limit }),
			deps.couponStore.countCoupons(filter),
		]);
		const nextCursor =
			result.nextCursor === null ? null : encodeCouponCursor(result.nextCursor, filter, limit);
		return c.json(
			{ ok: true, coupons: result.coupons.map(serializeCouponSummary), nextCursor, total },
			200,
		);
	});

	app.get("/coupons/:code", async (c) => {
		const params = couponCodePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const coupon = await deps.couponStore.findByCode(params.data.code);
		if (coupon === null) return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: true, coupon: serializeCoupon(coupon) }, 200);
	});

	// -- Shipping UPDATE/DELETE (admin-UX Increment 3) --------------------------
	// Every mutation is a NON-GET, so the global write gate (X-Service-Token,
	// app.ts) covers it in addition to the internal-token guard above.

	app.put("/shipping/zones/:zoneId", async (c) => {
		const params = zonePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingZoneUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.shippingRules.updateZone(params.data.zoneId, {
			name: parsed.data.name,
			// Presence is enforced by the schema's refine (omission ⇒ 400); the `??
			// null` only appeases `z.unknown()`'s optional-looking inferred type —
			// JSON cannot carry `undefined`, so it never fires at runtime.
			regions: parsed.data.regions ?? null,
		});
		if (res.ok) return c.json({ ok: true, zone: res.zone }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	app.delete("/shipping/zones/:zoneId", async (c) => {
		const params = zonePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.shippingRules.deleteZone(params.data.zoneId);
		if (res.ok) return c.json({ ok: true }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "IN_USE_BY_METHODS" }, 409);
	});

	app.put("/shipping/methods/:methodId", async (c) => {
		const params = methodPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingMethodUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.shippingRules.updateMethod(params.data.methodId, {
			name: parsed.data.name,
			type: parsed.data.type,
		});
		if (res.ok) return c.json({ ok: true, method: res.method }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	app.delete("/shipping/methods/:methodId", async (c) => {
		const params = methodPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.shippingRules.deleteMethod(params.data.methodId);
		if (res.ok) return c.json({ ok: true }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "IN_USE_BY_RATES" }, 409);
	});

	app.put("/shipping/methods/:methodId/rates/:currency", async (c) => {
		const params = methodCurrencyPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingRateUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.shippingRules.updateRate(
			params.data.methodId,
			toCurrency(params.data.currency),
			{
				amountCents: cents(parsed.data.amountCents),
				// Required-nullable on the wire (schema doc): null clears, a number sets
				// — omission was already a 400 at the boundary.
				minSubtotalCents:
					parsed.data.minSubtotalCents === null ? null : cents(parsed.data.minSubtotalCents),
			},
			cents(parsed.data.expectedAmountCents),
		);
		if (res.ok) return c.json({ ok: true, rate: res.rate }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "STALE", current: res.current }, 409);
	});

	app.delete("/shipping/methods/:methodId/rates/:currency", async (c) => {
		const params = methodCurrencyPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.shippingRules.deleteRate(
			params.data.methodId,
			toCurrency(params.data.currency),
		);
		if (res.ok) return c.json({ ok: true }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	// -- Tax UPDATE/DELETE ------------------------------------------------------

	// Increment 3 closeout (#72 gap-audit finding): `TaxRulesStore` had no
	// rename at all, and `deleteTaxClass` (contract-tested since Increment 2
	// slice 5) had no route. Both land together here.

	app.put("/tax/classes/:classId", async (c) => {
		const params = taxClassPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = taxClassUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.taxRules.updateClass(params.data.classId, { name: parsed.data.name });
		if (res.ok) return c.json({ ok: true, taxClass: res.class }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	app.delete("/tax/classes/:classId", async (c) => {
		const params = taxClassPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deleteTaxClass(
			{ taxRules: deps.taxRules, productCommerce: deps.productCommerce },
			params.data.classId,
		);
		if (res.ok) return c.json({ ok: true }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		if (res.reason === "in_use_by_products") {
			return c.json({ ok: false, reason: "IN_USE_BY_PRODUCTS", count: res.count }, 409);
		}
		return c.json({ ok: false, reason: "IN_USE_BY_RATES", count: res.count }, 409);
	});

	app.put("/tax/rates/:rateId", async (c) => {
		const params = rateIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = taxRateUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.taxRules.updateRate(
			params.data.rateId,
			// `appliesToShipping` is REQUIRED on the wire (schema doc) — no silent
			// default here; omission was already a 400 at the boundary.
			{ rateBps: parsed.data.rateBps, appliesToShipping: parsed.data.appliesToShipping },
			parsed.data.expectedRateBps,
		);
		if (res.ok) return c.json({ ok: true, rate: res.rate }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "STALE", current: res.current }, 409);
	});

	app.delete("/tax/rates/:rateId", async (c) => {
		const params = rateIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.taxRules.deleteRate(params.data.rateId);
		if (res.ok) return c.json({ ok: true }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	// -- Coupon UPDATE/DELETE ---------------------------------------------------

	app.put("/coupons/:couponId", async (c) => {
		const params = couponIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = couponUpdateBody.safeParse(await readJson(c));
		if (!parsed.success)
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		// Increment 3 closeout (#75 review finding): `couponUpdateBody` accepts
		// null `amountCents`/`rateBps` unconditionally on the wire — the
		// "can't blank the coupon's economic value" rule lived ONLY in the
		// plugin (`coupons-page.ts`'s `parseEconomics`), so a direct API caller
		// could blank a live coupon's discount. `type` (which axis is required)
		// is NOT on the edit body — it is the coupon's immutable kind, stored on
		// the record — so this is necessarily fetch-then-validate: read the
		// coupon to learn its `type`, THEN validate the parsed body against it,
		// 400ing before any write. A coupon deleted between this read and the
		// `update()` call below still surfaces as the pre-existing 404 (`update`
		// is itself not_found-safe), so the extra read adds no new race.
		const existing = await deps.couponStore.findById(params.data.couponId);
		if (existing === null) return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		const d = parsed.data;
		const amountCents = nn(d.amountCents);
		const rateBps = d.rateBps ?? null;
		if (existing.type === "fixed_amount" && amountCents === null) {
			return c.json(
				{ error: "amountCents is required and cannot be null for a fixed_amount coupon" },
				400,
			);
		}
		if (existing.type === "percentage" && rateBps === null) {
			return c.json(
				{ error: "rateBps is required and cannot be null for a percentage coupon" },
				400,
			);
		}
		const res = await deps.couponStore.update(params.data.couponId, {
			amountCents,
			rateBps,
			capCents: nn(d.capCents),
			minSubtotalCents: nn(d.minSubtotalCents),
			startsAt: d.startsAt ?? null,
			expiresAt: d.expiresAt ?? null,
			maxUses: d.maxUses ?? null,
			maxUsesPerCustomer: d.maxUsesPerCustomer ?? null,
		});
		if (res.ok) return c.json({ ok: true, coupon: serializeCoupon(res.coupon) }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	app.delete("/coupons/:couponId", async (c) => {
		const params = couponIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.couponStore.delete(params.data.couponId);
		if (res.ok) return c.json({ ok: true }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "IN_USE_BY_REDEMPTIONS" }, 409);
	});

	return app;
}

/** Brand an optional non-null minor-unit number as `Cents`, else null. */
function nn(v: number | null | undefined): ReturnType<typeof cents> | null {
	return v === null || v === undefined ? null : cents(v);
}

function serializeCoupon(coupon: import("@otta-sh/domain").CouponRecord): Record<string, unknown> {
	return {
		id: coupon.id,
		code: coupon.code,
		type: coupon.type,
		amountCents: coupon.amountCents,
		rateBps: coupon.rateBps,
		capCents: coupon.capCents,
		currency: coupon.currency,
		minSubtotalCents: coupon.minSubtotalCents,
		maxUses: coupon.maxUses,
		maxUsesPerCustomer: coupon.maxUsesPerCustomer,
		usesCount: coupon.usesCount,
	};
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

/** Wire shape of an admin Coupons-list row (view-only projection; admin-UX
 *  Increment 3). Serializes the FULL `CouponSummary` — every `CouponRecord`
 *  field plus `createdAt` — a small, header-only table has nothing expensive
 *  to trim off the list projection (unlike `serializeProductSummary`, which
 *  deliberately narrows `ProductCommerce`). `startsAt`/`expiresAt` are
 *  DELIBERATELY carried here even though the sibling `serializeCoupon` omits
 *  them (PR #74 review): the console list renders the validity window, so
 *  dropping them would force the UI into a per-row detail fetch — the exact
 *  N+1 this projection exists to prevent. `usesCount` doubles as the redeemed
 *  indicator — already a plain column, no correlated-EXISTS join. */
function serializeCouponSummary(summary: CouponSummary): Record<string, unknown> {
	return {
		id: summary.id,
		code: summary.code,
		type: summary.type,
		amountCents: summary.amountCents,
		rateBps: summary.rateBps,
		capCents: summary.capCents,
		currency: summary.currency,
		minSubtotalCents: summary.minSubtotalCents,
		startsAt: summary.startsAt,
		expiresAt: summary.expiresAt,
		maxUses: summary.maxUses,
		maxUsesPerCustomer: summary.maxUsesPerCustomer,
		usesCount: summary.usesCount,
		createdAt: summary.createdAt,
	};
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

/** Clamp a page limit into [1, 100] (MOD-1: a decoded cursor's limit is
 *  RE-CLAMPED, never honored past the max) — mirrors `admin.ts`'s `clampLimit`.
 *  Falls back to the query limit, then the default, for a missing/garbage
 *  value. */
function clampLimit(decoded: unknown, queryLimit: number): number {
	const raw =
		typeof decoded === "number" && Number.isFinite(decoded)
			? decoded
			: Number.isFinite(queryLimit)
				? queryLimit
				: DEFAULT_LIMIT;
	return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

/** Narrow a validated coupon-filter zod result back into the domain
 *  `CouponListFilter` (drops `undefined` keys so the shape is exact) —
 *  mirrors `toProductFilter`. */
function toCouponFilter(parsed: { search?: string }): CouponListFilter {
	const filter: CouponListFilter = {};
	if (parsed.search !== undefined) filter.search = parsed.search;
	return filter;
}

/** The decoded cursor's `createdAt` must be a valid ISO-8601 datetime — mirrors
 *  `cursorCreatedAt` in admin.ts. */
const couponCursorCreatedAt = z.string().datetime();

/** Validate a decoded coupon-cursor position shape — `{ createdAt: <ISO
 *  datetime>, couponId: <opaque, bounded string> }` — or null if malformed
 *  (→ 400). Mirrors `productCursorPosOf`. */
function couponCursorPosOf(pos: unknown): CouponListCursor | null {
	if (pos === null || typeof pos !== "object") return null;
	const p = pos as { createdAt?: unknown; couponId?: unknown };
	if (typeof p.createdAt !== "string" || !couponCursorCreatedAt.safeParse(p.createdAt).success) {
		return null;
	}
	if (typeof p.couponId !== "string" || p.couponId.length === 0 || p.couponId.length > 200) {
		return null;
	}
	return { createdAt: p.createdAt, couponId: p.couponId };
}

interface DecodedCouponCursor {
	pos: unknown;
	filter: unknown;
	limit: unknown;
}

/** Encode the coupon-list keyset position + active filter + limit into an
 *  opaque base64url token — mirrors `encodeProductCursor`. */
function encodeCouponCursor(
	pos: CouponListCursor,
	filter: CouponListFilter,
	limit: number,
): string {
	const payload = { pos: { createdAt: pos.createdAt, couponId: pos.couponId }, filter, limit };
	return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Decode an opaque coupon-list cursor token; returns null on ANY malformed/
 *  garbage input so the route answers 400 rather than 500 (MOD-1). Mirrors
 *  `decodeProductCursor`. */
function decodeCouponCursor(token: string): DecodedCouponCursor | null {
	try {
		const json = new TextDecoder().decode(fromBase64Url(token));
		const parsed = JSON.parse(json) as unknown;
		if (parsed === null || typeof parsed !== "object") return null;
		const p = parsed as DecodedCouponCursor;
		return { pos: p.pos, filter: p.filter, limit: p.limit };
	} catch {
		return null;
	}
}

// Portable base64url (Node + workerd both provide btoa/atob + TextEncoder) —
// mirrors admin.ts's `toBase64Url`/`fromBase64Url`.
function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): Uint8Array {
	const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64); // throws on invalid base64 ⇒ caught by decodeCouponCursor ⇒ 400
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
