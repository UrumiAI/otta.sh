/**
 * The buyer's "release my earlier checkout" route: when a browser changes its
 * cart after visiting Stripe, its earlier open checkout would hold stock for
 * up to 40 minutes and lock the same buyer out of low-stock items. This makes
 * sweep part B's path happen early, and nothing else: stock goes back ONLY when
 * Stripe says the session expired (closeThroughStripe, S-b).
 *
 * Authorization is knowing the order id (the browser's 128-bit key): while an
 * order is unpaid it lives only in that browser and in the merchant's Stripe
 * (settings refuse {ORDER_ID} in the cancel URL so it never reaches logs).
 * Paid, closed, unknown and still-being-created orders all answer the same
 * NOT_RELEASABLE. An order still "reserving" (no session yet, possibly another
 * tab's checkout in flight) is never released here: its session could be
 * created after a release and then paid without a hold.
 *
 * Bridge calls: 1 for an unknown or refused id; otherwise read 1 + settings 1 +
 * rate counter 2 + Stripe up to 3 + applySession (2t + 4 with the lookup-stamp
 * delete) = 2t + 11 (27 at 8 lines).
 */
import type { PluginContext } from "emdash/plugin";
import type { Fail } from "./model.js";
import { ORDER_ID, orders } from "./orders.js";
import { loadSettings } from "./settings.js";
import { closeThroughStripe, RELEASE_WINDOW_MS } from "./sweep.js";
import { asRecord, buyerAddress, fail, ipTag } from "./util.js";

const NOT = (): Fail => fail("NOT_RELEASABLE", "That earlier checkout cannot be released now.");
/** At most one release attempt per order per this many ms (shares the order page's stamp). */
const COOLDOWN_MS = 20_000;

/** Releases one buyer (network address) may make per window. */
const RELEASES_PER_WINDOW = 3;

export async function releaseCheckout(
	input: unknown,
	ctx: PluginContext,
	meta: { ip?: string | null } = {},
): Promise<{ ok: true; released: true } | Fail> {
	const k = asRecord(input)["key"];
	const id = typeof k === "string" && ORDER_ID.test(k) ? k : null;
	if (id === null) return NOT();
	const cur = await orders(ctx).getVersioned(id);
	const d = cur?.value;
	if (
		!d ||
		d.status !== "pending" ||
		d.stock !== "held" ||
		d.stockPending !== 0 ||
		d.stripeSessionId === null
	)
		return NOT();
	const s = await loadSettings(ctx);
	if (s.stripeSecretKey === null) return NOT();
	const now = Date.now();
	// Per buyer when the host gives a public address (a loop of checkout and release
	// would otherwise fill the store-wide created-checkouts cap), else per order.
	const who = buyerAddress(meta.ip);
	if (who !== null && s.ipSalt !== null) {
		const counter = `rel:${await ipTag(who, s.ipSalt)}:${Math.floor(now / RELEASE_WINDOW_MS)}`;
		const n = await ctx.kv.get<number>(counter);
		if (typeof n === "number" && n >= RELEASES_PER_WINDOW) return NOT();
		// A soft bound: get-then-set, not compare-and-set, and fixed windows, so a
		// burst at a window edge or in parallel can reach about twice the limit.
		await ctx.kv.set(counter, (typeof n === "number" ? n : 0) + 1);
	} else {
		const stamp = `chk:${id}`;
		const last = await ctx.kv.get<number>(stamp);
		if (typeof last === "number" && now - last < COOLDOWN_MS) return NOT();
		await ctx.kv.set(stamp, now);
	}
	return (await closeThroughStripe(ctx, s.stripeSecretKey, id, d)) === "expired"
		? { ok: true, released: true }
		: NOT();
}
