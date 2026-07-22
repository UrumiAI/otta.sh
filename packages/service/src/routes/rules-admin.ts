import {
	cents,
	currency as toCurrency,
	type CouponStore,
	type ShippingRulesStore,
	type TaxRulesStore,
} from "@urumi/domain";
import { Hono } from "hono";
import {
	couponBody,
	couponCodePathParams,
	couponIdPathParams,
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
	taxRateBody,
	taxRateUpdateBody,
	zonePathParams,
} from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";

export interface RulesAdminDeps {
	shippingRules: ShippingRulesStore;
	taxRules: TaxRulesStore;
	couponStore: CouponStore;
	internalToken?: string;
}

/**
 * Phase 6 admin CRUD for shipping / tax / coupon config (§6). Each endpoint is a
 * 1:1 serialization of a store method; writes require the privileged internal
 * token (same mechanism as the Phase-5 admin transition). Money on the wire is
 * integer minor units, branded via `cents()`/`currency()` at the boundary; rates
 * are integer basis points.
 */
export function rulesAdminRoutes(deps: RulesAdminDeps): Hono {
	const app = new Hono();

	// -- Shipping --------------------------------------------------------------
	app.post("/shipping/zones", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const parsed = taxClassBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const cls = await deps.taxRules.createClass({ id: parsed.data.id, name: parsed.data.name });
		return c.json({ ok: true, taxClass: cls }, 201);
	});

	app.get("/tax/classes", async (c) => {
		return c.json({ ok: true, classes: await deps.taxRules.listClasses() }, 200);
	});

	app.post("/tax/rates", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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

	app.get("/coupons/:code", async (c) => {
		const params = couponCodePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const coupon = await deps.couponStore.findByCode(params.data.code);
		if (coupon === null) return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: true, coupon: serializeCoupon(coupon) }, 200);
	});

	// -- Shipping UPDATE/DELETE (admin-UX Increment 3) --------------------------
	// Every mutation is a NON-GET, so the global write gate (X-Service-Token,
	// app.ts) covers it in addition to the per-route internal token below.

	app.put("/shipping/zones/:zoneId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = zonePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingZoneUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.shippingRules.updateZone(params.data.zoneId, {
			name: parsed.data.name,
			regions: parsed.data.regions ?? null,
		});
		if (res.ok) return c.json({ ok: true, zone: res.zone }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	app.delete("/shipping/zones/:zoneId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = zonePathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.shippingRules.deleteZone(params.data.zoneId);
		if (res.ok) return c.json({ ok: true }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "IN_USE_BY_METHODS" }, 409);
	});

	app.put("/shipping/methods/:methodId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = methodPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.shippingRules.deleteMethod(params.data.methodId);
		if (res.ok) return c.json({ ok: true }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "IN_USE_BY_RATES" }, 409);
	});

	app.put("/shipping/methods/:methodId/rates/:currency", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = methodCurrencyPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = shippingRateUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.shippingRules.updateRate(
			params.data.methodId,
			toCurrency(params.data.currency),
			{
				amountCents: cents(parsed.data.amountCents),
				minSubtotalCents:
					parsed.data.minSubtotalCents === null || parsed.data.minSubtotalCents === undefined
						? null
						: cents(parsed.data.minSubtotalCents),
			},
			cents(parsed.data.expectedAmountCents),
		);
		if (res.ok) return c.json({ ok: true, rate: res.rate }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "STALE", current: res.current }, 409);
	});

	app.delete("/shipping/methods/:methodId/rates/:currency", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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

	app.put("/tax/rates/:rateId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = rateIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = taxRateUpdateBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const res = await deps.taxRules.updateRate(
			params.data.rateId,
			{ rateBps: parsed.data.rateBps, appliesToShipping: parsed.data.appliesToShipping ?? false },
			parsed.data.expectedRateBps,
		);
		if (res.ok) return c.json({ ok: true, rate: res.rate }, 200);
		if (res.reason === "not_found") return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
		return c.json({ ok: false, reason: "STALE", current: res.current }, 409);
	});

	app.delete("/tax/rates/:rateId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = rateIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const res = await deps.taxRules.deleteRate(params.data.rateId);
		if (res.ok) return c.json({ ok: true }, 200);
		return c.json({ ok: false, reason: "NOT_FOUND" }, 404);
	});

	// -- Coupon UPDATE/DELETE ---------------------------------------------------

	app.put("/coupons/:couponId", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const params = couponIdPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = couponUpdateBody.safeParse(await readJson(c));
		if (!parsed.success)
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		const d = parsed.data;
		const res = await deps.couponStore.update(params.data.couponId, {
			amountCents: nn(d.amountCents),
			rateBps: d.rateBps ?? null,
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
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
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

function serializeCoupon(coupon: import("@urumi/domain").CouponRecord): Record<string, unknown> {
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
