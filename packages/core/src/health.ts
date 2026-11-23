/**
 * Setup & health READS for the admin page (admin-page.ts renders them).
 * Read-only: nothing here writes storage, kv or Stripe.
 *
 * Bridge calls (sandbox limit 30): settings 1 + kv health stamps 1 + Stripe
 * probe 1 (only when a key is set) + products count 1 + products pages
 * (<= HEALTH_PAGES, 100 each) = at most 4 + HEALTH_PAGES = 9.
 */
import type { PluginContext } from "emdash/plugin";
import type { ProductDoc } from "./model.js";
import { loadSettings, type Settings } from "./settings.js";
import { coll } from "./util.js";
import { API_VERSION } from "./stripe.js";

/** The Stripe API version pinned in stripe.ts. */
const STRIPE_VERSION = API_VERSION;
/** Products pages read to count sellable ones (100 each); above this the counts say "at least". */
export const HEALTH_PAGES = 5;
/** A sweep older than this means the site's cron is not running it (it runs every 5 minutes). */
export const SWEEP_STALE_MS = 15 * 60_000;

export type KeyMode = "test" | "live" | "unknown";
/** 200 accepted, 401 rejected, 403 lacks the Checkout Sessions permission, anything else unreachable. */
export type KeyProbe = "accepted" | "rejected" | "forbidden" | "unreachable";

export const keyMode = (k: string): KeyMode =>
	/^(sk|rk)_test_/.test(k) ? "test" : /^(sk|rk)_live_/.test(k) ? "live" : "unknown";

/** One GET through ctx.http. The key is only ever sent to Stripe, never returned. */
export async function probeStripeKey(
	ctx: PluginContext,
	key: string,
): Promise<{ probe: KeyProbe; status: number | null }> {
	try {
		const r = await ctx.http!.fetch("https://api.stripe.com/v1/checkout/sessions?limit=1", {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION },
		});
		const s = r.status;
		return {
			probe:
				s === 200 ? "accepted" : s === 401 ? "rejected" : s === 403 ? "forbidden" : "unreachable",
			status: s,
		};
	} catch {
		return { probe: "unreachable", status: null };
	}
}

export interface Health {
	settings: Settings;
	keyMode: KeyMode | null;
	keyProbe: { probe: KeyProbe; status: number | null } | null;
	lastWebhook: string | null;
	lastSweep: string | null;
	/** Last time Stripe would not offer card-only payment for a checkout. */
	cardProblem: string | null;
	products: { total: number; active: number; inactive: number; checked: number; complete: boolean };
	calls: number;
}

const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

export async function readHealth(ctx: PluginContext): Promise<Health> {
	let calls = 0;
	const s = await loadSettings(ctx);
	calls++;
	// One call for both stamps (health:lastWebhook, health:lastSweep); absent = never.
	const stamps: Record<string, unknown> = {};
	for (const e of await ctx.kv.list("health:")) stamps[e.key] = e.value;
	calls++;
	let probe: Health["keyProbe"] = null;
	if (s.stripeSecretKey !== null) {
		probe = await probeStripeKey(ctx, s.stripeSecretKey);
		calls++;
	}
	const products = coll<ProductDoc>(ctx, "products");
	const total = await products.count();
	calls++;
	// No `where: { active }`: the host binds no booleans (see resync.ts), so page and count.
	let active = 0;
	let checked = 0;
	let cursor: string | undefined;
	let complete = false;
	for (let n = 0; n < HEALTH_PAGES; n++) {
		const r = await products.query({ limit: 100, ...(cursor ? { cursor } : {}) });
		calls++;
		for (const i of r.items) {
			checked++;
			if (i.data.active) active++;
		}
		if (!r.hasMore || !r.cursor) {
			complete = true;
			break;
		}
		cursor = r.cursor;
	}
	return {
		settings: s,
		keyMode: s.stripeSecretKey === null ? null : keyMode(s.stripeSecretKey),
		keyProbe: probe,
		lastWebhook: iso(stamps["health:lastWebhook"]),
		lastSweep: iso(stamps["health:lastSweep"]),
		cardProblem: iso(stamps["health:cardProblem"]),
		products: { total, active, inactive: checked - active, checked, complete },
		calls,
	};
}
