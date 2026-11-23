/**
 * Otta Core — the sandboxed, registry-sized Otta kernel (EmDash 1.5 standard
 * format). Routes mount under /_emdash/api/plugins/<plugin id>/<name>.
 *
 * Settings come from the manifest's settingsSchema (EmDash renders the form);
 * the Orders and Setup & health pages are Block Kit, served by the private
 * `admin` route (admin-page.ts); the same management routes are MCP tools.
 */
import {
	pluginResponse,
	pluginRoute,
	type PluginContext,
	type SandboxedPlugin,
} from "emdash/plugin";
import { adminPage } from "./admin-page.js";
import {
	availability,
	MCP_TOOLS,
	ordersFulfil,
	ordersGet,
	ordersList,
	ordersResolve,
	stockSet,
} from "./admin.js";
import { placeOrder } from "./checkout.js";
import { orders, ORDER_ID, toPublicOrder } from "./orders.js";
import { onAfterDelete, onAfterPublish, onAfterSave, onAfterUnpublish } from "./products.js";
import { ensureIpSalt, loadSettings } from "./settings.js";
import { applyRefunds } from "./refunds.js";
import { releaseCheckout } from "./release.js";
import { resyncProducts } from "./resync.js";
import { exportData } from "./export.js";
import { applySession } from "./settle.js";
import { retrieveSession, verifyWebhook } from "./stripe.js";
import { scheduleSweep, sweep, SWEEP_CRON } from "./sweep.js";
import { asRecord, fail, safeEqual } from "./util.js";

const JSON_IN = { body: "json" as const, maxBytes: 16 * 1024 };
const QUERY_IN = { body: "none" as const };

const json = (status: number, body: unknown) =>
	pluginResponse({
		status,
		headers: { "content-type": "application/json" },
		body: { kind: "text", value: JSON.stringify(body) },
	});

/**
 * Every failure is caught here: a THROWN error reaches Stripe as HTTP 400
 * (EmDash maps it), which is wrong for a storage blip. 500 = Stripe redelivers;
 * replay is safe because every step is idempotent.
 */
async function webhook(raw: Uint8Array, headers: Record<string, string>, ctx: PluginContext) {
	try {
		return await webhookInner(raw, headers, ctx);
	} catch {
		return json(500, { received: false, error: "Temporary error. Stripe will retry this event." });
	}
}

async function webhookInner(raw: Uint8Array, headers: Record<string, string>, ctx: PluginContext) {
	const s = await loadSettings(ctx);
	// 503 until configured, so Stripe keeps retrying instead of dropping events.
	if (s.stripeWebhookSecret === null)
		return json(503, {
			error:
				"The webhook signing secret is not set in Otta Core's settings. Add it; Stripe will retry.",
		});
	const v = await verifyWebhook(
		s.stripeWebhookSecret,
		raw,
		headers["stripe-signature"],
		Math.floor(Date.now() / 1000),
	);
	if (!v.ok)
		return json(v.reason === "IGNORED" ? 200 : 400, {
			received: v.reason === "IGNORED",
			reason: v.reason,
			...(v.reason === "INVALID_SIGNATURE"
				? {
						error:
							"Signature check failed: the signing secret in Otta Core's settings does not match this Stripe endpoint.",
					}
				: {}),
		});
	if ("refundOf" in v.event) {
		// Needs the API to re-read the refunds; 503 keeps Stripe retrying until a key is set.
		if (s.stripeSecretKey === null)
			return json(503, {
				error:
					"The Stripe key is not set in Otta Core's settings, so refunds cannot be recorded yet. Add it; Stripe will retry.",
			});
		const outcome = await applyRefunds(ctx, s.stripeSecretKey, v.event.refundOf);
		if (outcome !== "unknown_order") await stampWebhook(ctx);
		// "retry": the payment's own webhook has not landed yet; Stripe redelivers.
		return json(outcome === "retry" ? 503 : 200, { received: outcome !== "retry", outcome });
	}
	const outcome = await applySession(ctx, v.event.session);
	// Only events for this store prove the endpoint works (an account can serve several).
	if (outcome !== "unknown_order") await stampWebhook(ctx);
	return json(200, { received: true, outcome });
}

export const LOOKUP_COOLDOWN_MS = 20_000;

const CHECKOUT_HEADER = "x-otta-checkout";

/** "https://shop.example" from the request URL the host gave the route, or null. */
function originOf(url: unknown): string | null {
	try {
		const o = new URL(String(url)).origin;
		return /^https?:\/\/[^/]/.test(o) ? o : null;
	} catch {
		return null;
	}
}

/**
 * Public routes never answer with an internal error: a thrown error would reach
 * the buyer as the host's 400 body (order ids, stock codes). Logged, then a
 * plain answer; every step is idempotent, so the buyer's retry or the sweep
 * finishes whatever was interrupted.
 */
async function guarded<T>(
	ctx: PluginContext,
	run: () => Promise<T>,
): Promise<T | ReturnType<typeof fail>> {
	try {
		return await run();
	} catch (e) {
		try {
			ctx.log?.error?.("otta-core public route failed", { error: String(e) });
		} catch {}
		return fail("ERROR", "Something went wrong on our side. Please try again.");
	}
}

/** For the setup page: when a verified webhook was last handled. Best effort, after the work, 1 call. */
async function stampWebhook(ctx: PluginContext) {
	try {
		await ctx.kv.set("health:lastWebhook", new Date().toISOString());
	} catch {}
}

/** The storefront sends the order key in this header, so it stays out of access logs. */
const ORDER_KEY_HEADER = "x-otta-order-key";

async function order(query: unknown, ctx: PluginContext, keyHeader?: string) {
	const q = asRecord(query);
	const id = typeof q["id"] === "string" && ORDER_ID.test(q["id"]) ? q["id"] : null;
	const key =
		typeof keyHeader === "string" && keyHeader !== ""
			? keyHeader
			: typeof q["key"] === "string"
				? q["key"]
				: null;
	if (!id || !key)
		return fail(
			"INVALID_INPUT",
			"This order link is incomplete. Please use the link from your confirmation page or your receipt email.",
		);
	const c = orders(ctx);
	const cur = await c.getVersioned(id);
	if (!cur || !safeEqual(cur.value.orderKey, key))
		return fail(
			"ORDER_NOT_FOUND",
			"We could not find this order. Check the link, or look for the receipt in your email.",
		);
	const d = cur.value;
	// Webhooks are an optimisation, not a dependency: while the order still looks
	// pending to us, ask Stripe (the buyer lands here straight after paying). Only
	// a paid or expired session decides anything, through the same applySession.
	// At most one Stripe lookup per order every LOOKUP_COOLDOWN_MS, whoever polls
	// (the key holder could otherwise spend the store's Stripe rate limit). The
	// stamp lives in kv, never on the order, so polls never race the webhook's CAS;
	// the sweep deletes stamps older than an hour.
	// Bridge calls: 1 + settings 1 + kv get 1 + kv set 1 + retrieve 1
	// + applySession (1 + 2t + 1) + re-read 1 = 2t + 8 (24 at 8 tracked lines).
	if (d.status === "pending" && d.stockPending === 0 && d.stripeSessionId !== null) {
		const s = await loadSettings(ctx);
		const stamp = `chk:${id}`;
		const last = s.stripeSecretKey === null ? null : await ctx.kv.get<number>(stamp);
		const now = Date.now();
		if (
			s.stripeSecretKey !== null &&
			!(typeof last === "number" && now - last < LOOKUP_COOLDOWN_MS)
		) {
			await ctx.kv.set(stamp, now);
			const r = await retrieveSession(ctx, s.stripeSecretKey, d.stripeSessionId);
			const decides =
				r.ok &&
				r.value.orderId === id &&
				(r.value.status === "expired" ||
					(r.value.status === "complete" &&
						(r.value.paymentStatus === "paid" ||
							(r.value.paymentStatus === "no_payment_required" && d.promoCodes))));
			if (r.ok && decides) {
				try {
					await applySession(ctx, r.value, cur);
					const fresh = await c.get(id);
					if (fresh) return { ok: true as const, order: toPublicOrder(id, fresh) };
				} catch {
					// The webhook or the sweep will finish it; answer with what we have.
				}
			}
		}
	}
	return { ok: true as const, order: toPublicOrder(id, d) };
}

const priv = <T>(handler: (input: unknown, ctx: PluginContext) => Promise<T>) =>
	pluginRoute({
		methods: ["POST"],
		permission: "plugins:manage",
		request: JSON_IN,
		handler: (r, ctx) => handler(r.input, ctx),
	});

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_e, ctx) => {
			await ensureIpSalt(ctx);
			await scheduleSweep(ctx);
		},
		"plugin:activate": async (_e, ctx) => {
			await ensureIpSalt(ctx);
			await scheduleSweep(ctx);
		},
		// The sweep gets the full 30 s sandbox wall time, not the 5 s hook default.
		cron: {
			timeout: 30_000,
			handler: async (e, ctx) => {
				if (e.name === SWEEP_CRON) await sweep(ctx);
			},
		},
		"content:afterSave": async (e, ctx) => onAfterSave(e, ctx),
		"content:afterPublish": async (e, ctx) => onAfterPublish(e, ctx),
		"content:afterUnpublish": async (e, ctx) => onAfterUnpublish(e, ctx),
		"content:afterDelete": async (e, ctx) => onAfterDelete(e, ctx),
	},
	routes: {
		checkout: pluginRoute({
			public: true,
			methods: ["POST"],
			// The custom header forces a CORS preflight on any cross-site request, which
			// the host does not grant: other sites cannot make their visitors' browsers
			// start checkouts here (a JSON body alone can be sent as a "simple" request).
			request: { ...JSON_IN, headers: [CHECKOUT_HEADER] },
			handler: (r, ctx) =>
				guarded(ctx, () =>
					r.request.headers?.[CHECKOUT_HEADER] !== "1"
						? Promise.resolve(
								fail(
									"BAD_REQUEST",
									"Something went wrong starting checkout. Please reload the page and try again.",
								),
							)
						: placeOrder(r.input, ctx, {
								ip: (r as { requestMeta?: { ip?: string | null } }).requestMeta?.ip ?? null,
							}),
				),
		}),
		order: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { ...QUERY_IN, headers: [ORDER_KEY_HEADER] },
			handler: (r, ctx) =>
				guarded(ctx, () => order(r.input, ctx, r.request.headers?.[ORDER_KEY_HEADER])),
		}),
		"checkout/release": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { ...JSON_IN, headers: [CHECKOUT_HEADER] },
			handler: (r, ctx) =>
				guarded(ctx, () =>
					r.request.headers?.[CHECKOUT_HEADER] !== "1"
						? Promise.resolve(
								fail("BAD_REQUEST", "Something went wrong. Please reload the page and try again."),
							)
						: releaseCheckout(r.input, ctx, {
								ip: (r as { requestMeta?: { ip?: string | null } }).requestMeta?.ip ?? null,
							}),
				),
		}),
		availability: pluginRoute({
			public: true,
			methods: ["GET"],
			request: QUERY_IN,
			handler: (r, ctx) => guarded(ctx, () => availability(r.input, ctx)),
		}),
		"stripe/webhook": pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "bytes", maxBytes: 256 * 1024, headers: ["stripe-signature"] },
			response: "raw",
			handler: (r, ctx) => webhook(r.input, r.request.headers, ctx),
		}),
		"orders/list": priv(ordersList),
		"orders/get": priv(ordersGet),
		"orders/fulfil": priv(ordersFulfil),
		"orders/resolve": priv(ordersResolve),
		"stock/set": priv(stockSet),
		"products/resync": priv(resyncProducts),
		"data/export": priv(exportData),
		// Block Kit pages (manifest admin.pages): EmDash POSTs every page_load,
		// block_action and form_submit here, by this literal route name.
		admin: pluginRoute({
			methods: ["POST"],
			permission: "plugins:manage",
			request: JSON_IN,
			handler: (r, ctx) => adminPage(r.input, ctx, originOf(r.request.url)),
		}),
	},
	// Build/install metadata: the plugin CLI converts these to manifest
	// `mcp.tools` (plain JSON Schema input, so no zod) and strips them from
	// backend.js. Each references a private POST JSON route with the same permission.
	mcp: {
		tools: Object.fromEntries(
			MCP_TOOLS.map((t) => [
				t.name,
				{
					description: t.description,
					route: t.route,
					input: t.inputSchema,
					destructive: t.destructive,
				},
			]),
		) as never,
	},
};

export default plugin;
