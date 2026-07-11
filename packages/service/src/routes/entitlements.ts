import {
	cents,
	currency as toCurrency,
	orderId as toOrderId,
	type SettleDeps,
	settleOrder,
	sku as toSku,
	type X402Proof,
} from "@urumi/domain";
import { Hono } from "hono";
import { entitlementCheckQuery, x402ProofBody } from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";
import { type OrderServiceDeps, serializeOrder } from "./orders.js";

/**
 * Entitlement routes (§6/§7):
 *  - `POST /entitlements/grant` — service-authenticated (`X-Internal-Token`);
 *    receives an x402 page-gate proof and runs `settleOrder(x402Gateway,
 *    {kind:"page_gate"})`, which verifies the proof server-side and grants the
 *    entitlement on success.
 *  - `GET /entitlements/check` — delivery authorization; the download route calls
 *    it and serves the file only if an active entitlement exists.
 */
export function entitlementRoutes(deps: OrderServiceDeps): Hono {
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

	// ACCEPTED RISK (review round G, deferred to Phase 5): this public check is
	// an enumeration oracle — `buyerRef` is an email/session string, so a caller
	// can probe whether a given email owns a given sku. Phase 5 replaces
	// `buyerRef` with unguessable claim tokens tied to customer accounts, which
	// closes the oracle; until then the exposure is one boolean per (ref, sku)
	// probe, with no order contents readable.
	app.get("/check", async (c) => {
		const parsed = entitlementCheckQuery.safeParse(c.req.query());
		if (!parsed.success) {
			return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
		}
		const active = await deps.entitlementStore.check({
			orderId: parsed.data.orderId === undefined ? undefined : toOrderId(parsed.data.orderId),
			buyerRef: parsed.data.buyerRef,
			sku: toSku(parsed.data.sku),
		});
		return c.json({ ok: true, active }, 200);
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
