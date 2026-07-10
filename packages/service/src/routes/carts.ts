import {
	addLine,
	type Cart,
	type CartDeps,
	type CartFailure,
	type CartLine,
	type CartStore,
	type Clock,
	createCart,
	currency,
	expireHolds,
	getCart,
	type InventoryStore,
	idempotencyKey,
	removeLine,
	sku,
	updateLine,
} from "@urumi/domain";
import { type Context, Hono } from "hono";
import { addLineBody, createCartBody, patchLineBody } from "../schemas.js";

export interface CartRoutesDeps {
	store: InventoryStore;
	cartStore: CartStore;
	clock: Clock;
	/** Hold TTL in ms; defaults to the domain's DEFAULT_HOLD_TTL_MS. */
	ttlMs?: number;
}

const DEFAULT_CURRENCY = "USD";

/**
 * Cart routes — each a straight serialization of a cart use-case: validate →
 * use-case → serialize. No status-code-as-logic for stock: `OUT_OF_STOCK` is a
 * 200 typed body (mirroring `reserve`). Not-found is 404; a checked-out fence is
 * 409. The `Idempotency-Key` header threads into the domain command.
 */
export function cartRoutes(deps: CartRoutesDeps): Hono {
	const app = new Hono();
	const cartDeps: CartDeps = {
		cartStore: deps.cartStore,
		inventoryStore: deps.store,
		clock: deps.clock,
		ttlMs: deps.ttlMs,
	};

	app.post("/", async (c) => {
		const parsed = createCartBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const cartId = await createCart(cartDeps, currency(parsed.data.currency ?? DEFAULT_CURRENCY));
		return c.json({ cartId }, 201);
	});

	app.get("/:cartId", async (c) => {
		const cart = await getCart(cartDeps, c.req.param("cartId"));
		if (cart === null) return c.json({ ok: false, reason: "CART_NOT_FOUND" }, 404);
		return c.json({ ok: true, cart: serializeCart(cart) }, 200);
	});

	app.post("/:cartId/lines", async (c) => {
		const key = requireKey(c);
		if (key === null) return c.json({ error: "missing Idempotency-Key header" }, 400);
		const parsed = addLineBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const res = await addLine(
			cartDeps,
			c.req.param("cartId"),
			sku(parsed.data.sku),
			null,
			parsed.data.qty,
			idempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true, line: serializeLine(res.line) }, 200);
		return failure(c, res.reason);
	});

	app.patch("/:cartId/lines/:lineId", async (c) => {
		const key = requireKey(c);
		if (key === null) return c.json({ error: "missing Idempotency-Key header" }, 400);
		const parsed = patchLineBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const res = await updateLine(
			cartDeps,
			c.req.param("cartId"),
			c.req.param("lineId"),
			parsed.data.qty,
			idempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true, line: serializeLine(res.line) }, 200);
		return failure(c, res.reason);
	});

	app.delete("/:cartId/lines/:lineId", async (c) => {
		const key = requireKey(c);
		if (key === null) return c.json({ error: "missing Idempotency-Key header" }, 400);
		const res = await removeLine(
			cartDeps,
			c.req.param("cartId"),
			c.req.param("lineId"),
			idempotencyKey(key),
		);
		if (res.ok) return c.json({ ok: true }, 200);
		return failure(c, res.reason);
	});

	return app;
}

/** Internal (non-public) sweep endpoint: reclaim globally-expired holds (§6). */
export function expireHoldsRoutes(deps: CartRoutesDeps): Hono {
	const app = new Hono();
	const cartDeps: CartDeps = {
		cartStore: deps.cartStore,
		inventoryStore: deps.store,
		clock: deps.clock,
		ttlMs: deps.ttlMs,
	};
	app.post("/expire-holds", async (c) => {
		const reclaimed = await expireHolds(cartDeps);
		return c.json({ ok: true, reclaimed }, 200);
	});
	return app;
}

function serializeCart(cart: Cart): {
	cartId: string;
	state: string;
	currency: string;
	lines: ReturnType<typeof serializeLine>[];
} {
	return {
		cartId: cart.cartId,
		state: cart.state,
		currency: cart.currency,
		lines: cart.lines.map(serializeLine),
	};
}

/** Wire shape of a cart line — no price (Phase 3), no internal reservation state. */
function serializeLine(line: CartLine): {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
} {
	return {
		lineId: line.lineId,
		sku: line.sku,
		productId: line.productId,
		qty: line.qty,
		reservationId: line.reservationId,
		expiresAt: line.expiresAt,
	};
}

function failure(c: Context, reason: CartFailure): Response {
	const body = { ok: false as const, reason };
	switch (reason) {
		case "OUT_OF_STOCK":
			return c.json(body, 200); // typed body, not status-code-as-logic
		case "CART_NOT_FOUND":
		case "LINE_NOT_FOUND":
			return c.json(body, 404);
		case "CART_CHECKED_OUT":
		case "LINE_CHECKED_OUT":
			return c.json(body, 409);
	}
}

function requireKey(c: { req: { header(name: string): string | undefined } }): string | null {
	const key = c.req.header("Idempotency-Key");
	return key === undefined || key.length === 0 ? null : key;
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
