import {
	getSettings,
	idempotencyKey as toIdempotencyKey,
	InvalidSettingsError,
	type SettingsStore,
	updateSettings,
} from "@urumi/domain";
import { Hono } from "hono";
import { settingsBody } from "../schemas.js";
import { requireInternalToken } from "./internal-auth.js";

export interface SettingsRoutesDeps {
	settingsStore: SettingsStore;
	/** Admin guard for BOTH verbs — the read as much as the write (ADR-0010);
	 *  unset ⇒ 503 (disabled), never silently open. */
	internalToken?: string;
}

/**
 * Phase 7 settings endpoints (§6). `GET` reads the service-DB operational tier;
 * `PUT` is a privileged admin write carrying an `Idempotency-Key`, zod-validated,
 * invalid values → `400` + structured error (never clamped). Secrets live ONLY in
 * service env and are never part of this surface — no secret-shaped field is read
 * or returned here.
 *
 * BOTH verbs require the internal token (ADR-0010): the read half of a privileged
 * write is admin surface too, and the app-level SERVICE_API_TOKEN write gate
 * exempts GET/HEAD, so it does NOT cover the read. The authoritative guard is
 * registered at the parent (`createApp`, `app.use("/settings")`); the blanket
 * guard below is defense-in-depth for the sub-app on its own.
 */
export function settingsRoutes(deps: SettingsRoutesDeps): Hono {
	const app = new Hono();

	// "*", not "/*": the only routes here are at "/" (the sub-app's root). "/*"
	// DOES match the root on 4.12.x (measured), so this is forward-compatibility
	// caution rather than a fix — "*" is unambiguous and cannot drift on a minor.
	app.use("*", async (c, next) => {
		const denied = requireInternalToken(c, deps.internalToken);
		if (denied !== null) return denied;
		await next();
	});

	app.get("/", async (c) => {
		const settings = await getSettings(deps.settingsStore);
		return c.json({ ok: true, settings }, 200);
	});

	app.put("/", async (c) => {
		const key = c.req.header("Idempotency-Key");
		if (key === undefined || key.length === 0) {
			return c.json({ ok: false, error: "Idempotency-Key header is required" }, 400);
		}

		const parsed = settingsBody.safeParse(await readJson(c));
		if (!parsed.success) {
			return c.json({ ok: false, error: "validation_error", issues: parsed.error.issues }, 400);
		}

		try {
			const settings = await updateSettings(deps.settingsStore, parsed.data, toIdempotencyKey(key));
			return c.json({ ok: true, settings }, 200);
		} catch (err) {
			if (err instanceof InvalidSettingsError) {
				return c.json(
					{ ok: false, error: "validation_error", field: err.field, message: err.message },
					400,
				);
			}
			throw err;
		}
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
