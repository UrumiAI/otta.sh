import {
	cents,
	currency as toCurrency,
	type CustomerStore,
	orderId as toOrderId,
	type SessionStore,
	type SettleDeps,
	settleOrder,
	sku as toSku,
	type X402Proof,
} from "@urumi/domain";
import { Hono } from "hono";
import { entitlementCheckQuery, x402ProofBody } from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";
import { type OrderServiceDeps, serializeOrder } from "./orders.js";
import { resolveCustomer } from "./session-auth.js";

/**
 * `entitlementRoutes` needs the session + customer stores (session scope of the
 * `/check` oracle-close, ADR-0011) on top of `OrderServiceDeps`. Both are
 * REQUIRED fields on `AppDeps`, satisfied by the spread at the app.ts mount site
 * (`entitlementRoutes({ ...orderDeps, sessionStore, customerStore })`) — a future
 * reader wiring this from a narrower deps object must pass them explicitly, like
 * `productCommerceRoutes`' hand-built subset.
 */
export type EntitlementRoutesDeps = OrderServiceDeps & {
	sessionStore: SessionStore;
	customerStore: CustomerStore;
};

/**
 * Entitlement routes (§6/§7):
 *  - `POST /entitlements/grant` — service-authenticated (`X-Internal-Token`);
 *    receives an x402 page-gate proof and runs `settleOrder(x402Gateway,
 *    {kind:"page_gate"})`, which verifies the proof server-side and grants the
 *    entitlement on success.
 *  - `GET /entitlements/check` — delivery authorization with PRESENCE-BASED scope
 *    precedence (issue #33 / ADR-0011), so it is no longer an unauthenticated
 *    existence oracle over an email:
 *      1. `buyerRef` present anywhere ⇒ operator auth (`X-Internal-Token`; 503
 *         when unconfigured, never silently open) — admin/support tooling only.
 *      2. else `orderId` present ⇒ open bearer-capability check (the order id is
 *         an unguessable 122-bit UUID; a Bearer, if any, is ignored — with no
 *         email in the query there is no oracle).
 *      3. else valid `Authorization: Bearer <session>` ⇒ session scope; the
 *         email is derived SERVER-SIDE from the session, never from the query.
 *      4. else ⇒ 401.
 */
export function entitlementRoutes(deps: EntitlementRoutesDeps): Hono {
	const app = new Hono();
	const settleDeps: SettleDeps = {
		orderStore: deps.orderStore,
		entitlementStore: deps.entitlementStore,
		paymentEventStore: deps.paymentEventStore,
		inventoryStore: deps.store,
		couponStore: deps.couponStore,
		clock: deps.clock,
	};

	app.post("/grant", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		const gateway = deps.gateways.x402;
		if (gateway === undefined) return c.json({ ok: false, error: "x402 not configured" }, 503);

		const parsed = x402ProofBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const proof: X402Proof = {
			orderId: toOrderId(parsed.data.orderId),
			transaction: parsed.data.transaction,
			network: parsed.data.network,
			payer: parsed.data.payer,
			amount: cents(parsed.data.amount),
			currency: toCurrency(parsed.data.currency),
			signature: parsed.data.signature,
		};
		const res = await settleOrder(settleDeps, gateway, { kind: "page_gate", proof });
		if (res.ok) {
			return c.json(
				{ ok: true, order: res.order === null ? null : serializeOrder(res.order) },
				200,
			);
		}
		// A rejected proof (bad signature / malformed / mismatch) → 400; missing order → 404.
		const status = res.reason === "ORDER_NOT_FOUND" ? 404 : 400;
		return c.json({ ok: false, reason: res.reason }, status);
	});

	// Presence-based scope precedence closes the former email existence oracle
	// (issue #33 / ADR-0011). The precedence is keyed on what the request
	// CONTAINS, never on which scope it best "fits": the store ANDs orderId +
	// buyerRef, so a shape-based "orderId ⇒ open" rule that forwarded the whole
	// query would leave a residual "does order X belong to email Y" oracle.
	app.get("/check", async (c) => {
		const parsed = entitlementCheckQuery.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
		}
		const sku = toSku(parsed.data.sku);

		// 1. buyerRef present anywhere ⇒ operator-only (X-Internal-Token). Gating
		//    at the parameter, not the shape: an accompanying orderId is still
		//    forwarded (ANDed), but only for an authenticated operator.
		if (parsed.data.buyerRef !== undefined) {
			const denied = requireInternalToken(c, deps.internalToken);
			if (denied !== null) return denied;
			const active = await deps.entitlementStore.check({
				orderId: parsed.data.orderId === undefined ? undefined : toOrderId(parsed.data.orderId),
				buyerRef: parsed.data.buyerRef,
				sku,
			});
			return c.json({ ok: true, active }, 200);
		}

		// 2. else orderId present ⇒ open bearer capability (unguessable order id).
		if (parsed.data.orderId !== undefined) {
			const active = await deps.entitlementStore.check({
				orderId: toOrderId(parsed.data.orderId),
				sku,
			});
			return c.json({ ok: true, active }, 200);
		}

		// 3. else a valid customer session ⇒ session scope. The buyerRef is the
		//    session customer's own email (derived server-side, never the query),
		//    so a customer can only ever probe their own entitlements.
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId !== null) {
			const customer = await deps.customerStore.get(customerId);
			if (customer !== null) {
				const active = await deps.entitlementStore.check({ buyerRef: customer.email, sku });
				return c.json({ ok: true, active }, 200);
			}
		}

		// 4. else no credential for any scope ⇒ closed.
		return c.json({ ok: false, error: "unauthorized" }, 401);
	});

	return app;
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
