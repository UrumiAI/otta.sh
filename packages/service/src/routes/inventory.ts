import { commit, idempotencyKey, type InventoryStore, release, reserve, sku } from "@urumi/domain";
import { Hono } from "hono";
import { commitBody, releaseBody, reserveBody } from "../schemas.js";

export interface InventoryDeps {
	store: InventoryStore;
}

/**
 * Inventory routes — each a straight serialization of the port method:
 * validate → domain use-case → serialize the result to JSON. No
 * status-code-as-logic: `OUT_OF_STOCK` is a 200 body (the port has no
 * exception for it); 400 is only for schema/validation failure.
 */
export function inventoryRoutes(deps: InventoryDeps): Hono {
	const app = new Hono();

	app.post("/reserve", async (c) => {
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ error: "missing Idempotency-Key header" }, 400);
		}
		const parsed = reserveBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		const result = await reserve(
			deps.store,
			sku(parsed.data.sku),
			parsed.data.qty,
			idempotencyKey(key),
		);
		return c.json(result, 200);
	});

	app.post("/commit", async (c) => {
		const parsed = commitBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		await commit(deps.store, parsed.data.reservationId);
		return c.json({ ok: true }, 200);
	});

	app.post("/release", async (c) => {
		const parsed = releaseBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ error: "invalid request body", issues: parsed.error.issues }, 400);
		}
		await release(deps.store, parsed.data.reservationId);
		return c.json({ ok: true }, 200);
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
