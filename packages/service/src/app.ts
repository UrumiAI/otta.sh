import { Hono } from "hono";
import { type InventoryDeps, inventoryRoutes } from "./routes/inventory.js";

export type AppDeps = InventoryDeps;

/**
 * Build the Hono app without listening (§0.6) so tests can mount it and the bin
 * (`index.ts`) can serve it. The concrete `InventoryStore` is injected — the
 * app knows nothing about pg/sqlite.
 */
export function createApp(deps: AppDeps): Hono {
	const app = new Hono();
	app.get("/health", (c) => c.json({ ok: true }));
	app.route("/inventory", inventoryRoutes(deps));

	// Consistent error envelope for anything thrown past the routes (e.g. a
	// domain error on commit/release of a non-`held`/unknown reservation, or a
	// DB fault). No internal message or stack is leaked to the client; the real
	// error is logged server-side.
	app.onError((err, c) => {
		console.error("[service] unhandled error:", err);
		return c.json({ ok: false, error: "internal_error" }, 500);
	});

	return app;
}
