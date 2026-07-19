import {
	CountingIdGen,
	InMemoryCouponStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
} from "@urumi/domain/testing";
import { describe, expect, test } from "vitest";
import { rulesAdminRoutes } from "../src/routes/rules-admin.js";

// Regression pin for the unauthenticated-read hole. The Phase-6 rules-admin GET
// reads (shipping/tax/coupon config) must require `X-Internal-Token`, exactly like
// their POST siblings and like every `/reports/*` read — merchant config, not
// public catalog data. Before the blanket guard these GETs were reachable with NO
// token: the app-level SERVICE_API_TOKEN write gate exempts GET/HEAD (auth.ts), so
// a GET reached these routes ungated and `GET /admin/coupons/:code` leaked the full
// coupon config plus live `usesCount`. IO-free: mounts the sub-app over in-memory
// stores and drives it with `app.request()` (no server, no PG).

const READ_PATHS = [
	"/shipping/zones",
	"/shipping/zones/z1/methods",
	"/shipping/methods/m1/rates?currency=USD",
	"/tax/classes",
	"/tax/rates?zoneId=z1",
	"/coupons/SAVE5",
] as const;

function makeRoutes(internalToken?: string) {
	const idGen = new CountingIdGen("rule");
	return rulesAdminRoutes({
		shippingRules: new InMemoryShippingRulesStore(),
		taxRules: new InMemoryTaxRulesStore(),
		couponStore: new InMemoryCouponStore({ idGen }),
		...(internalToken !== undefined ? { internalToken } : {}),
	});
}

describe("rules-admin reads require the internal token", () => {
	test.each(READ_PATHS)("GET %s without X-Internal-Token is 401 (token set)", async (path) => {
		const res = await makeRoutes("int-secret").request(path);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test.each(READ_PATHS)(
		"GET %s is 503 when the internal token is unset (disabled, never silently open)",
		async (path) => {
			const res = await makeRoutes(undefined).request(path);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ ok: false, error: "internal endpoints disabled" });
		},
	);

	test("a wrong X-Internal-Token is 401", async () => {
		const res = await makeRoutes("int-secret").request("/tax/classes", {
			headers: { "X-Internal-Token": "wrong" },
		});
		expect(res.status).toBe(401);
	});

	test("the correct X-Internal-Token reaches the read (empty list, not 401)", async () => {
		const res = await makeRoutes("int-secret").request("/shipping/zones", {
			headers: { "X-Internal-Token": "int-secret" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, zones: [] });
	});
});
