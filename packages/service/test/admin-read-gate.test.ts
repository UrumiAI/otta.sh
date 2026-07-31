import {
	CountingIdGen,
	FakeEmailSender,
	FixedClock,
	InMemoryAddressStore,
	InMemoryCartStore,
	InMemoryCouponStore,
	InMemoryCredentialVerifier,
	InMemoryCustomerStore,
	InMemoryEntitlementStore,
	InMemoryInventoryStore,
	InMemoryOrderNotesStore,
	InMemoryOrderStore,
	InMemoryPaymentEventStore,
	InMemoryProductCommerceStore,
	InMemoryReportingStore,
	InMemorySessionStore,
	InMemorySettingsStore,
	InMemoryShippingRulesStore,
	InMemoryTaxRulesStore,
} from "@otta-sh/domain/testing";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";

// Regression pin for the unauthenticated admin/config READ hole (ADR-0010).
// The Phase-6 rules-admin GETs (shipping/tax/coupon config) and `GET /settings`
// must require `X-Internal-Token`, exactly like their write siblings and like
// every `/reports/*` read — merchant config, not public catalog data. Before the
// guard these GETs were reachable with NO token at all: the app-level
// SERVICE_API_TOKEN write gate exempts GET/HEAD (`auth.ts`), so a GET reached
// them ungated and `GET /admin/coupons/:code` leaked full coupon economics plus
// live `usesCount`.
//
// The thing under test is the PARENT-level guard registered in `createApp`, not
// the sub-app blanket guards. Hono merges a sub-app's middleware into the parent
// AT MOUNT TIME, so that middleware covers only what is registered AFTER it: a
// sibling sub-app mounted at the same prefix EARLIER runs ungated. `adminRoutes`
// and `rulesAdminRoutes` are both mounted at "/admin", `adminRoutes` first, so a
// blanket guard inside the latter never covers the former (pinned below by
// "WHY the guard cannot live in a sub-app"). Every test therefore drives the
// FULL app, never a bare sub-app.
// IO-free: in-memory stores + `app.request()` (no server, no PG).

function makeApp(
	options: { serviceToken?: string; internalToken?: string; probeAdminRoute?: boolean } = {},
): Hono {
	const clock = new FixedClock(new Date("2026-07-10T00:00:00.000Z"));
	const inventory = new InMemoryInventoryStore({ idGen: new CountingIdGen("res"), clock });
	const cartStore = new InMemoryCartStore({
		idGen: new CountingIdGen("cart"),
		reservationState: (id) => {
			try {
				return inventory.reservationState(id);
			} catch {
				return undefined;
			}
		},
		releaseHold: (id) => {
			void inventory.release(id);
		},
	});
	const productCommerce = new InMemoryProductCommerceStore({
		clock,
		// NOTE: `InMemoryInventoryStore.onHand` returns 0 for an unseeded sku, so
		// this wiring COLLAPSES null -> 0. Fine for the coarse `inStock` boolean
		// these suites exercise; do NOT assert the products-list `onHand`
		// projection through it (the list must distinguish "no inventory row"
		// from "out of stock" — see the divergence note in
		// `packages/domain/src/ports/inventory-store.ts`'s `getOnHand` doc).
		inventoryOnHand: (s) => inventory.onHand(s),
	});
	const idGen = new CountingIdGen("id");
	const customerStore = new InMemoryCustomerStore({ idGen, clock });
	const app = createApp({
		store: inventory,
		productCommerce,
		cartStore,
		orderStore: new InMemoryOrderStore({ idGen, clock }),
		orderNotesStore: new InMemoryOrderNotesStore({ idGen, clock }),
		entitlementStore: new InMemoryEntitlementStore({ idGen, clock }),
		paymentEventStore: new InMemoryPaymentEventStore(),
		shippingRules: new InMemoryShippingRulesStore(),
		taxRules: new InMemoryTaxRulesStore(),
		couponStore: new InMemoryCouponStore({ idGen, clock }),
		reportingStore: new InMemoryReportingStore(),
		settingsStore: new InMemorySettingsStore(),
		customerStore,
		addressStore: new InMemoryAddressStore({ idGen, clock }),
		sessionStore: new InMemorySessionStore({ idGen, clock }),
		credentialVerifier: new InMemoryCredentialVerifier({ customerStore, idGen, clock }),
		emailSender: new FakeEmailSender(),
		idGen,
		gateways: {},
		clock,
		serviceToken: options.serviceToken,
		internalToken: options.internalToken,
	});
	if (options.probeAdminRoute === true) {
		// A THIRD sub-app mounted at "/admin" with NO inline guard of its own —
		// stands in for a future route added by someone who forgot the guard. The
		// parent-level `app.use("/admin/*")` must cover it.
		//
		// HONEST SCOPE: this is a FORWARD-LOOKING default-deny pin, not a
		// discriminator against the sub-app-only design. Anything the test mounts
		// necessarily lands AFTER `rulesAdminRoutes`, so its merged "/admin/*"
		// guard would have covered this probe too — the sub-app-only design does
		// NOT fail here. What it does fail is `/settings`, which has no such
		// merged guard: the five `/settings` cases above are the discriminating
		// ones. This pin's value is the future: it goes red if BOTH the parent
		// guard and the sub-app guard are ever removed.
		const probe = new Hono();
		probe.get("/probe-unguarded", (c) => c.json({ ok: true, leaked: "secret-config" }, 200));
		app.route("/admin", probe);
	}
	return app;
}

const TOKEN = "int-secret";
const authed = { "X-Internal-Token": TOKEN };

/** The full admin/config READ surface this change closes, with the status each
 *  path answers ONCE authorized (so "reached the route" is asserted precisely,
 *  not merely "not 401"). */
const READ_PATHS: ReadonlyArray<readonly [path: string, authorizedStatus: number]> = [
	["/admin/shipping/zones", 200],
	["/admin/shipping/zones/z1/methods", 200],
	["/admin/shipping/methods/m1/rates?currency=USD", 404],
	["/admin/tax/classes", 200],
	["/admin/tax/rates?zoneId=z1", 200],
	["/admin/coupons/SAVE5", 404],
	["/settings", 200],
];

describe("admin/config reads require the internal token", () => {
	test.each(READ_PATHS)("GET %s without X-Internal-Token is 401 (token set)", async (path) => {
		const res = await makeApp({ internalToken: TOKEN }).request(path);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test.each(READ_PATHS)("GET %s with a wrong X-Internal-Token is 401", async (path) => {
		const res = await makeApp({ internalToken: TOKEN }).request(path, {
			headers: { "X-Internal-Token": "wrong" },
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test.each(READ_PATHS)(
		"GET %s is 503 when the internal token is unset (disabled, never silently open)",
		async (path) => {
			const res = await makeApp({}).request(path);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ ok: false, error: "internal endpoints disabled" });
		},
	);

	test.each(READ_PATHS)(
		"GET %s with the correct token reaches the route",
		async (path, authorizedStatus) => {
			const res = await makeApp({ internalToken: TOKEN }).request(path, { headers: authed });
			expect(res.status).toBe(authorizedStatus);
		},
	);

	test("the exact path GET /settings (no trailing slash, no wildcard) is guarded", async () => {
		// Pins the deliberate `app.use("/settings")` + `app.use("/settings/*")`
		// double registration: the exact-path form must not depend on a Hono minor
		// keeping its "the wildcard also matches the bare prefix" behavior.
		const res = await makeApp({ internalToken: TOKEN }).request("/settings");
		expect(res.status).toBe(401);
	});

	test("PUT /settings is unchanged: 503 unset, 401 wrong token, 200 authorized", async () => {
		const body = JSON.stringify({ holdTtlMinutes: 30 });
		const headers = { "content-type": "application/json", "Idempotency-Key": "k-1" };
		const unset = await makeApp({}).request("/settings", { method: "PUT", headers, body });
		expect(unset.status).toBe(503);
		const wrong = await makeApp({ internalToken: TOKEN }).request("/settings", {
			method: "PUT",
			headers: { ...headers, "X-Internal-Token": "wrong" },
			body,
		});
		expect(wrong.status).toBe(401);
		const ok = await makeApp({ internalToken: TOKEN }).request("/settings", {
			method: "PUT",
			headers: { ...headers, ...authed },
			body,
		});
		expect(ok.status).toBe(200);
	});
});

describe("the guard is PARENT-level, not per-sub-app", () => {
	// `adminRoutes` is a SIBLING sub-app of `rulesAdminRoutes` at the same "/admin"
	// mount. A blanket guard inside `rulesAdminRoutes` never runs for it, so these
	// pin that the coverage comes from `createApp`, not from a sub-app.
	test.each(["/admin/orders", "/admin/products"])(
		"GET %s is 503 when the internal token is unset",
		async (path) => {
			const res = await makeApp({}).request(path);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ ok: false, error: "internal endpoints disabled" });
		},
	);

	test("GET /admin/orders with the correct token still reaches the route", async () => {
		const res = await makeApp({ internalToken: TOKEN }).request("/admin/orders", {
			headers: authed,
		});
		expect(res.status).toBe(200);
	});

	test.each([
		["token set, no header", TOKEN, 401],
		["token unset", undefined, 503],
	] as const)(
		"an /admin route with NO inline guard of its own is still closed (%s)",
		async (_label, internalToken, expected) => {
			const app = makeApp({
				probeAdminRoute: true,
				...(internalToken !== undefined ? { internalToken } : {}),
			});
			const res = await app.request("/admin/probe-unguarded");
			expect(res.status).toBe(expected);
			expect(await res.text()).not.toContain("secret-config");
		},
	);

	test("WHY the guard cannot live in a sub-app: Hono merges sub-app middleware at mount time", async () => {
		// The hazard this design exists to remove, pinned against the installed
		// Hono rather than assumed. A blanket `app.use("/*")` inside one sub-app is
		// merged into the parent WHERE THAT SUB-APP IS MOUNTED, so it only covers
		// what is registered after it: a sibling mounted at the same prefix EARLIER
		// runs ungated. `adminRoutes` is exactly that sibling, mounted at "/admin"
		// before `rulesAdminRoutes`. If this ever starts failing, Hono changed its
		// middleware semantics and the parent guard's rationale should be re-read.
		const ranFor: string[] = [];
		const parent = new Hono();
		const earlier = new Hono();
		earlier.get("/earlier", (c) => c.json({ ok: true }));
		const guarded = new Hono();
		guarded.use("/*", async (c, next) => {
			ranFor.push(c.req.path);
			await next();
		});
		guarded.get("/own", (c) => c.json({ ok: true }));
		parent.route("/admin", earlier);
		parent.route("/admin", guarded);

		expect((await parent.request("/admin/own")).status).toBe(200);
		expect((await parent.request("/admin/earlier")).status).toBe(200);
		// The sub-app's own route was covered; the sibling mounted earlier was NOT.
		expect(ranFor).toEqual(["/admin/own"]);
	});
});

describe("HEAD is guarded too (the write gate exempts it, this guard must not)", () => {
	test("HEAD /settings with no token is 401", async () => {
		const res = await makeApp({ internalToken: TOKEN }).request("/settings", { method: "HEAD" });
		expect(res.status).toBe(401);
	});

	test("HEAD /admin/tax/classes with no token is 401", async () => {
		const res = await makeApp({ internalToken: TOKEN }).request("/admin/tax/classes", {
			method: "HEAD",
		});
		expect(res.status).toBe(401);
	});

	test("HEAD /health stays open", async () => {
		const res = await makeApp({ internalToken: TOKEN }).request("/health", { method: "HEAD" });
		expect(res.status).toBe(200);
	});
});

describe("the public read surface stays open (ADR-0010 enumeration)", () => {
	// Pin the OTHER half of the decision: gating the admin surface must not creep
	// into the storefront reads. `GET /orders/:id` and `GET /me/*` are covered by
	// their own suites (capability URL / session Bearer).
	test.each([
		["no service token", undefined],
		["service token set", "svc-secret"],
	] as const)("with %s, the storefront reads need no token", async (_label, serviceToken) => {
		const app = makeApp({
			internalToken: TOKEN,
			...(serviceToken !== undefined ? { serviceToken } : {}),
		});
		expect((await app.request("/health")).status).toBe(200);
		// An unknown cart/product is a 404 FROM THE ROUTE — never 401/503.
		for (const path of ["/carts/unknown-cart", "/products/unknown-product/commerce"]) {
			const res = await app.request(path);
			expect([200, 404]).toContain(res.status);
		}
	});
});
