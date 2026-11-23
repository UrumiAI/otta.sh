/**
 * The 5-minute sweep: keeps every promise a dead request left behind.
 *   A. Orders with stockPending = 1 (oldest first): finish their stock work.
 *      An abandoned `reserving` order (older than 2 min) is carried forward
 *      like a replay; once its session window has passed it is given up
 *      (`advance(..., final)`), so a dead first Stripe call cannot hold stock.
 *   B. Pending orders with a session, past its expiry: ask Stripe. Open ->
 *      expire it through the API, and release only on what Stripe then reports
 *      (S-b). A session Stripe no longer knows (key switched, 404) or one that
 *      completed unpaid moves the order to `review`, so it leaves this queue
 *      and can never block it. Part B only decides (status CAS, sweep flag):
 *      part A releases the stock on the next run, so B's cost does not grow
 *      with an order's size and large orders never stall it.
 *   E. Payments with no webhook: Stripe's list of recently completed sessions,
 *      matched to our pending orders; decides only, like B. Runs after B and
 *      leaves UPKEEP_MIN calls for C and the health stamp.
 *   C. Prune: unpaid orders (expired/canceled, stock fully released) whose
 *      session ended more than PRUNE_AFTER_DAYS ago are deleted, a few per run,
 *      so abandoned or scripted checkouts cannot grow storage without bound.
 *      Orders with a payment or a merchant note on them are never deleted.
 *   D. Cleanup of kv leftovers: lookup stamps (chk:) older than an hour and
 *      release counters (rel:) from past windows, a few per run.
 *
 * Bridge budget: the sandbox allows 30 calls per invocation. Each order is
 * admitted only if its typical cost still fits (an overrun under contention is
 * recoverable: every step is idempotent and the next run finishes it); one
 * failing order is skipped, never fatal for the rest of the run.
 */
import type { PluginContext } from "emdash/plugin";
import { advance } from "./checkout.js";
import type { OrderDoc } from "./model.js";
import { completeStock, orders, updateOrder } from "./orders.js";
import { ensureIpSalt, loadSettings, SCAN_AFTER_SETTING, type Settings } from "./settings.js";
import { applySession } from "./settle.js";
import { expireSession, listCompletedSessions, retrieveSession } from "./stripe.js";

export const SWEEP_CRON = "sweep";
export const SWEEP_SCHEDULE = "*/5 * * * *";
export const PRUNE_AFTER_DAYS = 90;
const PRUNE_BATCH = 20;
const STAMP_DELETES = 5;
/** The release route's per-buyer window (release.ts). */
export const RELEASE_WINDOW_MS = 10 * 60 * 1000;
/** Calls part B leaves for parts C, D and E even when many orders are due. */
const UPKEEP_RESERVE = 8;
/** Calls part E leaves for parts C and D. */
export const UPKEEP_MIN = 3; // prune 2 + the health stamp 1; the stamp cleanup runs when budget is left
/** Part E's look-back: the session lifetime plus a margin. */
const SCAN_WINDOW_MS = 50 * 60 * 1000;
export const LIMIT = 30;
const STALE_MS = 2 * 60 * 1000;

const tracked = (d: OrderDoc) => d.items.filter((i) => i.trackStock).length;
/** Worst case to move one order a step, with re-read and CAS slack. A
 *  reserving order reserves every line, calls Stripe and CASes (a cancel there
 *  only flips the order; the release is the next run's `releasing` step). */
export const costA = (d: OrderDoc) => 2 * tracked(d) + (d.stock === "reserving" ? 7 : 4);
/**
 * Part B decides only (Stripe calls, then the order's status CAS) and leaves the
 * stock work to part A, so its cost does not depend on the order's size: up to
 * 3 Stripe calls + read + CAS + the lookup-stamp delete, plus 1 of slack.
 */
const costB = (_d: OrderDoc) => 7;

type Out = { finished: number; expired: number; review: number; pruned: number; paid: number };

export async function sweep(ctx: PluginContext, now = Date.now()): Promise<Out> {
	let used = 2;
	const out: Out = { finished: 0, expired: 0, review: 0, pruned: 0, paid: 0 };
	const s = await loadSettings(ctx);
	// An install upgraded without an install/activate hook has no salt yet: create it.
	if (s.ipSalt === null) {
		await ensureIpSalt(ctx);
		used += 2;
	}
	const c = orders(ctx);
	const pending = await c.query({
		where: { stockPending: 1 },
		orderBy: { createdAt: "asc" },
		limit: 5,
	});
	for (const { id, data } of pending.items) {
		if (data.stock === "reserving" && now - Date.parse(data.createdAt) < STALE_MS) continue;
		// Every order leaves UPKEEP_MIN for prune and the health stamp. The largest
		// order still fits on its own: 2 (list calls) + costA at MAX_LINES reserving
		// (2 * 8 + 7 = 23) = 25 <= 27, asserted in test/sweep-capacity.test.ts.
		const cap = LIMIT - UPKEEP_MIN;
		if (used + costA(data) > cap) continue;
		used += costA(data);
		try {
			const cur = await c.getVersioned(id);
			if (!cur) continue;
			if (cur.value.stock === "reserving") {
				const final = now > Date.parse(cur.value.expiresAt) + STALE_MS;
				await advance(ctx, s, id, cur, { final, sweep: true });
			} else await completeStock(ctx, id, cur);
			out.finished++;
		} catch {
			// Storage or Stripe trouble on this order: leave it for the next run.
		}
	}

	const key = s.stripeSecretKey;
	if (key !== null && used + 1 <= LIMIT) used = await partB(ctx, key, now, used + 1, out);
	// E after B, leaving UPKEEP_MIN calls so prune and the health stamp always run.
	if (key !== null && used + 2 <= LIMIT - UPKEEP_MIN)
		used = await partE(ctx, key, now, used, out, s, LIMIT - UPKEEP_MIN);

	// C: two calls (query + deleteMany) when the budget allows.
	if (used + 2 <= LIMIT) {
		try {
			// Only orders that may be deleted (OrderDoc.prunable is derived on every write).
			const old = await c.query({
				where: {
					prunable: 1,
					expiresAt: { lt: new Date(now - PRUNE_AFTER_DAYS * 86_400_000).toISOString() },
				},
				orderBy: { expiresAt: "asc" },
				limit: PRUNE_BATCH,
			});
			used += 2;
			const ids = old.items.map((o) => o.id);
			if (ids.length) out.pruned = await c.deleteMany(ids);
		} catch {
			// next run
		}
	}
	// For the setup page: the sweep is running (1 call, best effort).
	if (used + 1 <= LIMIT) {
		try {
			await ctx.kv.set("health:lastSweep", new Date(now).toISOString());
			used++;
		} catch {}
	}

	// D: the order page's lookup stamps (kv chk:<id>) left behind by orders the
	// webhook settled. Any stamp older than an hour has no use; delete what the
	// budget allows.
	if (used + 2 <= LIMIT) {
		try {
			const stamps = await ctx.kv.list("chk:");
			used++;
			let deleted = 0;
			for (const e of stamps) {
				if (used + 1 > LIMIT || deleted >= STAMP_DELETES) break;
				if (typeof e.value === "number" && now - e.value < 3_600_000) continue;
				await ctx.kv.delete(e.key);
				used++;
				deleted++;
			}
		} catch {
			// next run
		}
	}
	// The release route's per-buyer counters (kv rel:<tag>:<window>): any from a past
	// window has no use. A few per run, like the stamps.
	if (used + 2 + 4 <= LIMIT) {
		try {
			const counters = await ctx.kv.list("rel:");
			used++;
			const current = Math.floor(now / RELEASE_WINDOW_MS);
			let deleted = 0;
			for (const e of counters) {
				if (used + 1 > LIMIT || deleted >= STAMP_DELETES) break;
				if (Number(e.key.split(":").pop()) >= current) continue;
				await ctx.kv.delete(e.key);
				used++;
				deleted++;
			}
		} catch {
			// next run
		}
	}

	return out;
}

/**
 * E: payments with no webhook. Stripe lists every Checkout Session completed
 * in the window, newest first; our pending orders come from one query; each
 * session that is ours is settled through applySession, admitted by its worst
 * case.
 *
 * The window is by CREATION time, so it must cover a session's whole life: a
 * session can complete up to SESSION_TTL (40 min) after it was created, so
 * every run looks back TTL + the sweep interval + a margin (50 min). Sessions
 * already settled come back each run and are skipped (they are no longer
 * pending). A busy store can have more than one page: the run pages while its
 * budget allows and, if it stops early, keeps the position in
 * settings:_scanAfter for the next run; a finished pass clears it, so the next
 * pass starts from the newest again.
 *
 * Ours means: the session's metadata order id is a pending order of ours AND
 * that order stored this session (or none yet). A Stripe account shared with
 * other products lists their sessions too; they are never touched.
 * Returns the bridge calls used so far.
 */
async function partE(
	ctx: PluginContext,
	key: string,
	now: number,
	usedIn: number,
	out: Out,
	s: Settings,
	cap = LIMIT,
): Promise<number> {
	let used = usedIn + 1;
	try {
		// Newest first: with more than 100 pending, the newest are the ones whose
		// sessions can still complete; older ones are part B's.
		const pending = await orders(ctx).query({
			where: { status: "pending" },
			orderBy: { createdAt: "desc" },
			limit: 100,
		});
		if (!pending.items.length) {
			if (s.scanAfter !== null && used + 1 <= cap) {
				await ctx.kv.set(`settings:${SCAN_AFTER_SETTING}`, "");
				used++;
			}
			return used;
		}
		const mine = new Map(pending.items.map((o) => [o.id, o.data]));
		const oldestPending = pending.items.reduce(
			(m, o) => Math.min(m, Date.parse(o.data.createdAt)),
			Infinity,
		);
		let after = s.scanAfter;
		let finished = false;
		pages: while (used + 2 <= cap) {
			used++;
			const r = await listCompletedSessions(ctx, key, (now - SCAN_WINDOW_MS) / 1000, after);
			if (!r.ok) {
				// A position Stripe does not know (the key moved to another account or
				// mode) would stop part E for good: start the next pass from the newest.
				if (r.code === "STRIPE_REFUSED" && after !== null && used + 1 <= cap) {
					await ctx.kv.set(`settings:${SCAN_AFTER_SETTING}`, "");
					used++;
				}
				return used;
			}
			for (const sv of r.value.sessions) {
				const d = sv.orderId === null ? undefined : mine.get(sv.orderId);
				if (!d || (d.stripeSessionId !== null && d.stripeSessionId !== sv.id)) continue;
				const settles =
					sv.paymentStatus === "paid" ||
					(sv.paymentStatus === "no_payment_required" && d.promoCodes);
				if (!settles) continue;
				// Decide only (read + CAS + the stamp delete, +1 slack); part A commits the
				// stock next run, so a large order costs the same as a small one.
				const cost = 4;
				// Out of budget mid-page: resume this page next run (from the previous position).
				if (used + cost + 1 > cap) break pages;
				used += cost;
				try {
					if ((await applySession(ctx, sv, null, false)) === "paid") out.paid++;
				} catch {
					// next run
				}
			}
			// Stripe lists newest first: once a page reaches sessions created before our
			// oldest pending order (minus slack), no later page can hold one of ours.
			const oldestSession = r.value.sessions.reduce(
				(m, x) => Math.min(m, x.created ?? Infinity),
				Infinity,
			);
			if (
				r.value.complete ||
				r.value.lastId === null ||
				oldestSession * 1000 < oldestPending - 5 * 60_000
			) {
				finished = true;
				break;
			}
			after = r.value.lastId;
		}
		const keep = finished ? "" : (after ?? "");
		if ((s.scanAfter ?? "") !== keep && used + 1 <= cap) {
			await ctx.kv.set(`settings:${SCAN_AFTER_SETTING}`, keep);
			used++;
		}
	} catch {
		// next run
	}
	return used;
}

/** Returns the bridge calls used so far. */
async function partB(
	ctx: PluginContext,
	key: string,
	now: number,
	usedIn: number,
	out: Out,
): Promise<number> {
	let used = usedIn;
	const due = await orders(ctx).query({
		where: {
			status: "pending",
			stockPending: 0,
			expiresAt: { lt: new Date(now - STALE_MS).toISOString() },
		},
		orderBy: { expiresAt: "asc" },
		limit: 5,
	});
	for (const { id, data } of due.items) {
		const sid = data.stripeSessionId;
		// Leave UPKEEP_RESERVE calls for prune, the stamps and the payment pass.
		if (sid === null || used + costB(data) > LIMIT - UPKEEP_RESERVE) continue;
		used += costB(data);
		try {
			const r = await closeThroughStripe(ctx, key, id, data, false);
			if (r === "stop") break;
			if (r === "review") out.review++;
			if (r === "expired") out.expired++;
		} catch {
			// leave it for the next run
		}
	}
	return used;
}

/**
 * Close a pending order with a session through Stripe, the one way stock goes
 * back while a session exists (S-b): ask Stripe; if open, expire it; if the
 * expire is refused (paid or expired meanwhile), ask again; then act ONLY on
 * what Stripe says, through applySession. Used by sweep part B and by the
 * buyer's release route. Bridge calls: up to 3 Stripe + applySession (read + CAS,
 * + 2t + 1 when it completes the stock work now; the sweep defers that to part A).
 *   "expired"  Stripe expired it; the holds are released
 *   "paid"     it completed: the payment is recorded (or already was)
 *   "review"   unreachable (404) or complete but unpaid: a person decides
 *   "stop"     Stripe refused the key or the request (auth/config): stop
 *   "retry"    Stripe unavailable: try later
 *   "noop"     nothing changed
 */
export async function closeThroughStripe(
	ctx: PluginContext,
	key: string,
	id: string,
	data: OrderDoc,
	/** false (the sweep): decide only; part A finishes the stock work next run. */
	completeNow = true,
): Promise<"expired" | "paid" | "review" | "stop" | "retry" | "noop"> {
	const sid = data.stripeSessionId;
	if (sid === null) return "noop";
	let r = await retrieveSession(ctx, key, sid);
	if (r.ok && r.value.status === "open") {
		const e = await expireSession(ctx, key, sid);
		// A refused expire means it is no longer open (paid or expired meanwhile): re-read.
		r = e.ok ? e : await retrieveSession(ctx, key, sid);
	}
	if (!r.ok) {
		// Only "no such session" makes an order unreachable. Auth/config errors
		// (401/403/400) say nothing about the order.
		if (r.code === "STRIPE_REFUSED" && r.status === 404)
			return (await toReview(ctx, id, "SESSION_UNREACHABLE:404")) ? "review" : "noop";
		return r.code === "STRIPE_REFUSED" ? "stop" : "retry";
	}
	const v = r.value;
	const settles =
		v.paymentStatus === "paid" || (v.paymentStatus === "no_payment_required" && data.promoCodes);
	if (v.status === "complete" && !settles)
		return (await toReview(ctx, id, `COMPLETE_UNPAID:${v.paymentStatus}`)) ? "review" : "noop";
	const o = await applySession(ctx, v, null, completeNow);
	return o === "expired" ? "expired" : o === "paid" ? "paid" : o === "review" ? "review" : "noop";
}

/** Pending -> review (holds kept, a person decides via orders/resolve). */
async function toReview(ctx: PluginContext, id: string, why: string): Promise<boolean> {
	const r = await updateOrder(ctx, id, (d) =>
		d.status !== "pending"
			? null
			: { ...d, status: "review", stockPending: 0, attention: d.attention ?? why },
	);
	return r?.value.status === "review";
}

export async function scheduleSweep(ctx: PluginContext): Promise<void> {
	await ctx.cron?.schedule(SWEEP_CRON, { schedule: SWEEP_SCHEDULE });
}
