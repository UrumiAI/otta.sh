import {
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	transitionOrder,
	type OrderStore,
} from "@urumi/domain";
import { Hono } from "hono";
import { orderPathParams, transitionBody } from "../schemas.js";
import { serializeOrder } from "./orders.js";
import { requireInternalToken } from "./internal-auth.js";

export interface AdminRoutesDeps {
	orderStore: OrderStore;
	/** Reuses the existing service privileged auth (X-Internal-Token). Phase 5
	 *  introduces no separate admin identity (Risk 7): the internal token is the
	 *  service's privileged mechanism; a real admin panel calls this with it. */
	internalToken?: string;
}

/**
 * Admin order-status transition (Phase 5 §7). The only customer-facing surface
 * that can move an order is NONE — this endpoint requires the privileged
 * (internal-token) auth. Legality is enforced in the domain (`transitionOrder`);
 * a transition that also has a template enqueues exactly one email atomically
 * with the flip (§5), drained by the dispatcher.
 */
export function adminRoutes(deps: AdminRoutesDeps): Hono {
	const app = new Hono();

	app.post("/orders/:orderId/transition", async (c) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;

		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = transitionBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);

		const header = c.req.header("Idempotency-Key");
		const key =
			header !== undefined && header.length > 0
				? header
				: `admin:transition:${params.data.orderId}:${parsed.data.toState}`;
		const res = await transitionOrder(
			{ orderStore: deps.orderStore },
			{
				orderId: toOrderId(params.data.orderId),
				toState: parsed.data.toState,
				idempotencyKey: toIdempotencyKey(key),
			},
		);
		if (res.ok) {
			return c.json(
				{ ok: true, transitioned: res.transitioned, order: serializeOrder(res.order) },
				200,
			);
		}
		if (res.reason === "ORDER_NOT_FOUND") return c.json({ ok: false, reason: res.reason }, 404);
		return c.json({ ok: false, reason: res.reason }, 409); // INVALID_TRANSITION
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
