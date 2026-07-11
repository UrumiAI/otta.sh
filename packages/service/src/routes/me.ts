import {
	orderId as toOrderId,
	type Address,
	type AddressStore,
	type Customer,
	type CustomerStore,
	type OrderStore,
	type SessionStore,
} from "@urumi/domain";
import { type Context, Hono } from "hono";
import {
	addressPathParams,
	createAddressBody,
	orderPathParams,
	updateAddressBody,
} from "../schemas.js";
import { serializeOrder } from "./orders.js";
import { resolveCustomer } from "./session-auth.js";

export interface MeRoutesDeps {
	sessionStore: SessionStore;
	customerStore: CustomerStore;
	orderStore: OrderStore;
	addressStore: AddressStore;
}

/**
 * Authenticated storefront-customer surface (Phase 5 §7). Every handler derives
 * the customer id from the bearer session — never a request param — so the
 * isolation is structural, not a filter a client can bypass (§4). A foreign
 * order id returns **404, not 403** (headline case 1: don't leak existence).
 */
export function meRoutes(deps: MeRoutesDeps): Hono {
	const app = new Hono();

	app.get("/", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const customer = await deps.customerStore.get(customerId);
		if (customer === null) return unauthorized(c);
		return c.json({ ok: true, customer: serializeCustomer(customer) }, 200);
	});

	app.get("/orders", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const orders = await deps.orderStore.listForCustomer(customerId);
		return c.json({ ok: true, orders: orders.map(serializeOrder) }, 200);
	});

	app.get("/orders/:orderId", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const params = orderPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const order = await deps.orderStore.getById(toOrderId(params.data.orderId));
		// NOT_FOUND (not FORBIDDEN) for a foreign or unknown order — no existence leak.
		if (order === null || order.customerId !== customerId) {
			return c.json({ ok: false, reason: "ORDER_NOT_FOUND" }, 404);
		}
		return c.json({ ok: true, order: serializeOrder(order) }, 200);
	});

	app.get("/addresses", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const addresses = await deps.addressStore.list(customerId);
		return c.json({ ok: true, addresses: addresses.map(serializeAddress) }, 200);
	});

	app.post("/addresses", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const parsed = createAddressBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const created = await deps.addressStore.create(customerId, {
			kind: parsed.data.kind,
			name: parsed.data.name,
			line1: parsed.data.line1,
			line2: parsed.data.line2 ?? null,
			city: parsed.data.city,
			region: parsed.data.region ?? null,
			postalCode: parsed.data.postalCode,
			country: parsed.data.country,
			isDefault: parsed.data.isDefault ?? false,
		});
		return c.json({ ok: true, address: serializeAddress(created) }, 201);
	});

	app.put("/addresses/:addressId", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const params = addressPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const parsed = updateAddressBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const updated = await deps.addressStore.update(customerId, params.data.addressId, parsed.data);
		if (updated === null) return c.json({ ok: false, reason: "ADDRESS_NOT_FOUND" }, 404);
		return c.json({ ok: true, address: serializeAddress(updated) }, 200);
	});

	app.delete("/addresses/:addressId", async (c) => {
		const customerId = await resolveCustomer(c, deps.sessionStore);
		if (customerId === null) return unauthorized(c);
		const params = addressPathParams.safeParse(c.req.param());
		if (!params.success) return c.json({ error: "invalid path parameter" }, 400);
		const deleted = await deps.addressStore.delete(customerId, params.data.addressId);
		if (!deleted) return c.json({ ok: false, reason: "ADDRESS_NOT_FOUND" }, 404);
		return c.json({ ok: true }, 200);
	});

	return app;
}

function unauthorized(c: Context): Response {
	return c.json({ ok: false, error: "unauthorized" }, 401);
}

function serializeCustomer(customer: Customer): Record<string, unknown> {
	return {
		id: customer.id,
		email: customer.email,
		displayName: customer.displayName,
		emailVerifiedAt: customer.emailVerifiedAt,
		createdAt: customer.createdAt,
	};
}

function serializeAddress(a: Address): Record<string, unknown> {
	return {
		id: a.id,
		kind: a.kind,
		name: a.name,
		line1: a.line1,
		line2: a.line2,
		city: a.city,
		region: a.region,
		postalCode: a.postalCode,
		country: a.country,
		isDefault: a.isDefault,
	};
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
