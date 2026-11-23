/**
 * Place order: price the browser's lines server-side (L5), create the order
 * under the client's key (L2: idempotency is the document id), hold stock,
 * open a Stripe Checkout Session, return its URL.
 *
 * Bridge calls, n = distinct tracked lines: settings 1 + open-order count 1 +
 * recently-created count 1 +
 * per-buyer count 1 (when the host gives an IP) + products 1 + stock
 * pre-check 1 (when any line is tracked) + order create 1 + stock 2n + Stripe 1
 * + order update 1 = 2n + 9 (25 at MAX_LINES; measured in test/flows.test.ts
 * without a public buyer address, so 2n + 8 there).
 *
 * A replay with the same key reads the existing order and carries it forward
 * from wherever it stopped (`advance`), so a crash at any await is finished by
 * the buyer's retry or by the sweep. A replay must ask for the same lines and
 * email as the first call; anything else is refused as KEY_REUSED.
 */
import type { PluginContext } from "emdash/plugin";
import {
	MAX_LINES,
	MAX_QTY,
	SCHEMA_VERSION,
	type Fail,
	type OrderDoc,
	type OrderItem,
	type ProductDoc,
	type StockDoc,
	stockId,
} from "./model.js";
import { completeStock, orders, ORDER_ID, updateOrder, type Versioned } from "./orders.js";
import { ensureIpSalt, loadSettings, type Settings } from "./settings.js";
import { applySession } from "./settle.js";
import { applyStock, available } from "./stock.js";
import { createCheckoutSession, expireSession, retrieveSession } from "./stripe.js";
import {
	asRecord,
	asString,
	buyerAddress,
	coll,
	fail,
	ipTag,
	randomHex,
	storeTag,
} from "./util.js";

/**
 * Stripe requires expires_at 30 min .. 24 h after the session is CREATED, and
 * expires_at is fixed on the order so every retry sends identical parameters.
 * 40 min leaves a 10-minute window in which a retry can still create the
 * session; after that Stripe refuses (and a refusal proves no session exists).
 */
export const SESSION_TTL_S = 40 * 60;

/**
 * A cancel releases its holds inline only when that still fits the 30-call
 * budget (about 4t + 7 for t tracked lines); otherwise the order is left
 * canceled/releasing with its sweep flag set and the sweep finishes it.
 */
const INLINE_RELEASE_MAX_LINES = 4;

/** Practical, Stripe-compatible: one @, no spaces, a dotted domain. */
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** The window for the recently-created cap. */
const NEW_WINDOW_MS = 10 * 60 * 1000;

/** Cancel reason when Stripe would not offer card payment. */
export const CARD_NOT_OFFERED = "CARD_NOT_OFFERED";
const cardOnly = (t: string[] | null | undefined) =>
	Array.isArray(t) && t.length === 1 && t[0] === "card";

/** For the setup page (best effort, 1 call). */
async function noteCardProblem(ctx: PluginContext) {
	try {
		await ctx.kv.set("health:cardProblem", new Date().toISOString());
	} catch {}
}

const OUT_OF_STOCK_TEXT =
	"Sorry, we do not have enough of one or more items. Lower the quantity or remove them, then try again.";
const CLOSED_TEXT =
	"This checkout has already ended. If you paid, your receipt is in your email. Otherwise start again.";
/** Cancel reasons that are also meaningful codes for a buyer's storefront. */
const BUYER_REASONS = new Set([
	"OUT_OF_STOCK",
	"STOCK_BUSY",
	"STRIPE_REFUSED",
	"CARD_NOT_OFFERED",
	"NOT_CONFIGURED",
]);

export type CheckoutOk = { ok: true; orderId: string; url: string };

export async function placeOrder(
	input: unknown,
	ctx: PluginContext,
	meta: { ip?: string | null } = {},
): Promise<CheckoutOk | Fail> {
	const q = asRecord(input);
	const id = typeof q["key"] === "string" && ORDER_ID.test(q["key"]) ? q["key"] : null;
	if (id === null)
		return fail(
			"INVALID_KEY",
			"Something went wrong starting checkout. Please reload the page and try again.",
		);
	const email = q["email"] == null ? null : asString(q["email"], 254);
	// Strict, so Stripe never refuses it: a refused create would cost a Stripe
	// call and a stored order without counting toward any cap.
	if (q["email"] != null && (email === null || !EMAIL.test(email)))
		return fail(
			"INVALID_EMAIL",
			"That email address does not look right. Check it, or leave it blank.",
		);
	const lines = new Map<string, number>();
	for (const raw of Array.isArray(q["lines"]) ? q["lines"] : []) {
		const l = asRecord(raw);
		const pid =
			typeof l["productId"] === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(l["productId"])
				? l["productId"]
				: null;
		const qty = l["qty"];
		if (pid === null || typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
			return fail(
				"INVALID_LINES",
				"Some quantities in your cart are not valid. Please check them.",
			);
		}
		lines.set(pid, (lines.get(pid) ?? 0) + qty);
	}
	if (lines.size === 0 || lines.size > MAX_LINES)
		return fail(
			"INVALID_LINES",
			`Your cart is empty or holds more than ${MAX_LINES} different items. Please keep it to ${MAX_LINES} or fewer.`,
		);
	for (const n of lines.values())
		if (n > MAX_QTY)
			return fail(
				"INVALID_LINES",
				`You can buy at most ${MAX_QTY} of one item per order. Lower the quantity and try again.`,
			);

	const request =
		[...lines.entries()]
			.toSorted(([a], [b]) => (a < b ? -1 : 1))
			.map(([p, n]) => `${p}:${n}`)
			.join(",") + `|${email ?? ""}`;
	const replay = (cur: Versioned | null) =>
		!cur
			? fail("CONFLICT", "Something went wrong on our side. Please try again.")
			: cur.value.request !== request
				? fail("KEY_REUSED", "Your cart changed since you started. Please start checkout again.")
				: advance(ctx, s, id, cur);

	const s = await loadSettings(ctx);
	const c = orders(ctx);
	// A new-order check that fails may be a RETRY of an order that exists (the
	// merchant changed a setting or a product meanwhile): the order has its own
	// snapshot, so carry it forward instead of refusing. Costs a read only on
	// refusal paths, never on a successful checkout.
	const refuse = async (f: Fail): Promise<CheckoutOk | Fail> => {
		const cur = await c.getVersioned(id);
		return cur ? replay(cur) : f;
	};
	if (s.stripeSecretKey === null)
		return refuse(
			fail("NOT_CONFIGURED", "This shop cannot take payments yet. Please try again later."),
		);
	if (s.problem !== null)
		return refuse(
			fail("NOT_CONFIGURED", "This shop cannot take payments yet. Please try again later."),
		);
	for (const n of lines.values())
		if (n > s.maxQtyPerLine)
			return refuse(
				fail(
					"INVALID_LINES",
					`You can buy at most ${s.maxQtyPerLine} of one item per order. Lower the quantity and try again.`,
				),
			);
	// The public route has no rate limit of its own: bound what open orders can
	// hold (stock, Stripe sessions, storage). `open` counts every order that is
	// pending OR still releasing, so a canceled order that has not given its
	// holds back yet still counts. A replay of an existing key passes.
	if ((await c.count({ open: 1 })) >= s.maxOpenCheckouts)
		return refuse(fail("BUSY", "The shop is busy right now. Please try again in a few minutes."));
	// Per buyer, so one client cannot fill the store-wide cap on its own.
	// Skipped (global cap only) when the host gives no public address or the
	// install has no salt yet: never hash an address without the salt.
	// The install secret exists from the install hook; created here once if not.
	const salt = s.ipSalt ?? (await ensureIpSalt(ctx));
	if (salt === null)
		return refuse(
			fail("NOT_CONFIGURED", "This shop cannot take payments yet. Please try again later."),
		);
	const store = await storeTag(salt);
	const who = buyerAddress(meta.ip);
	const tag = who === null ? null : await ipTag(who, salt);
	// Orders CREATED recently, whatever became of them: bounds Stripe calls and
	// stored documents even when checkouts close at once (refused, out of stock).
	if (
		(await c.count({ createdAt: { gt: new Date(Date.now() - NEW_WINDOW_MS).toISOString() } })) >=
		s.maxNewCheckouts
	)
		return refuse(fail("BUSY", "The shop is busy right now. Please try again in a few minutes."));
	if (tag !== null && (await c.count({ open: 1, ipTag: tag })) >= s.maxOpenPerBuyer)
		return refuse(
			fail(
				"BUSY_BUYER",
				"You already have checkouts waiting for payment. Finish one, or try again in about 40 minutes.",
			),
		);

	const found = await coll<ProductDoc>(ctx, "products").query({
		where: { productId: { in: [...lines.keys()] } },
		limit: MAX_LINES,
	});
	const byId = new Map(found.items.map((p) => [p.data.productId, p.data]));
	const items: OrderItem[] = [];
	for (const [pid, qty] of lines) {
		const p = byId.get(pid);
		if (!p || !p.active || p.price === null || p.currency !== s.currency) {
			return refuse({
				...fail(
					"PRODUCT_UNAVAILABLE",
					"One of the items in your cart is no longer for sale. Remove it and try again.",
				),
				productId: pid,
			});
		}
		items.push({
			productId: pid,
			variantId: null,
			sku: p.sku,
			title: p.title,
			unitPrice: p.price,
			qty,
			trackStock: p.trackStock,
		});
	}
	const subtotal = items.reduce((a, i) => a + i.unitPrice * i.qty, 0);
	// Stripe Checkout cannot take a zero payment in payment mode: such an order
	// could never settle. Refuse it rather than hold stock for it.
	if (subtotal + s.flatShipping === 0)
		return refuse(
			fail(
				"FREE_ORDER",
				"This order has nothing to pay, so it cannot be checked out online. Please contact the shop.",
			),
		);
	// Fail fast, before any order or hold exists: a cart that cannot be filled
	// right now is refused for one call instead of reserving its first lines and
	// leaving a canceled order to release (which the sweep does slowly for big
	// orders). Not a guarantee: the reserves below still decide under a race.
	const want = items.filter((i) => i.trackStock);
	if (want.length) {
		const got = await coll<StockDoc>(ctx, "stock").getMany(want.map(stockId));
		const one = (pid: string): StockDoc | null =>
			(got instanceof Map
				? got.get(pid)
				: (got as unknown as Record<string, StockDoc> | null)?.[pid]) ?? null;
		for (const i of want)
			if (available(one(stockId(i))) < i.qty)
				return refuse({ ...fail("OUT_OF_STOCK", OUT_OF_STOCK_TEXT), productId: i.productId });
	}
	const now = Date.now();
	const orderKey = randomHex(16);
	const fill = (u: string) =>
		absolute(u.replaceAll("{ORDER_ID}", id).replaceAll("{ORDER_KEY}", orderKey), ctx, s.shopOrigin);
	const successUrl = fill(s.successUrl);
	const cancelUrl = fill(s.cancelUrl);
	// Stripe needs absolute URLs; without the site's URL a relative setting cannot be made one.
	// The shop's address is not known yet. Buyers see the plain line; the shop owner,
	// who is usually the first to hit this while testing, sees what to do.
	if (successUrl === null || cancelUrl === null)
		return refuse(
			fail(
				"NOT_CONFIGURED",
				"This shop cannot take payments yet. (Shop owner: open Otta Core > Setup & health once to record your shop address.)",
			),
		);
	const doc: OrderDoc = {
		v: SCHEMA_VERSION,
		orderKey,
		status: "pending",
		stock: "reserving",
		stockPending: 1,
		items,
		currency: s.currency,
		subtotal,
		shipping: s.flatShipping,
		total: subtotal + s.flatShipping,
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		expiresAt: new Date(now + SESSION_TTL_S * 1000).toISOString(),
		stripeSessionId: null,
		checkoutUrl: null,
		paymentIntentId: null,
		paidAt: null,
		amountPaid: null,
		email,
		shippingAddress: null,
		attention: null,
		fulfilledAt: null,
		tracking: null,
		cancelReason: null,
		unheldSale: false,
		successUrl,
		cancelUrl,
		shippingCountries: s.shippingCountries,
		request,
		open: 1,
		prunable: 0,
		ipTag: tag,
		store,
		discount: null,
		refundedAmount: null,
		refunds: null,
		promoCodes: s.allowPromotionCodes,
	};
	const w = await c.compareAndSet(id, null, doc);
	// Lost the create: this key already has an order (a replay). Read it and
	// carry it forward; never decide from applied:false alone (L4).
	if (w.applied) return advance(ctx, s, id, { value: doc, revision: w.revision });
	return replay(await c.getVersioned(id));
}

/** Carries an order forward from wherever it stopped. Used by checkout and the sweep. */
export async function advance(
	ctx: PluginContext,
	s: Settings,
	id: string,
	cur: Versioned,
	opts: {
		/** Past the order's session window: give up instead of waiting (sweep). */
		final?: boolean;
		/** Called by the sweep: never release inline; the next run does it. */
		sweep?: boolean;
	} = {},
): Promise<CheckoutOk | Fail> {
	const d = cur.value;
	const final = opts.final === true;
	const inline = !opts.sweep && tracked(d) <= INLINE_RELEASE_MAX_LINES;
	if (d.status === "pending" && d.stock === "held" && d.checkoutUrl)
		return { ok: true, orderId: id, url: d.checkoutUrl };
	if (d.status === "canceled") {
		if (inline) await completeStock(ctx, id, cur);
		return fail("CANCELED", "We could not place this order. Please start again.");
	}
	if (d.status !== "pending" || d.stock !== "reserving") return fail("ORDER_CLOSED", CLOSED_TEXT);

	for (const it of d.items) {
		if (!it.trackStock) continue;
		const r = await applyStock(ctx, stockId(it), { kind: "reserve", orderId: id, qty: it.qty });
		if (!r.ok)
			return cancel(
				ctx,
				id,
				cur,
				r.code === "OUT_OF_STOCK" ? "OUT_OF_STOCK" : "STOCK_BUSY",
				inline,
			);
	}

	if (s.stripeSecretKey === null) {
		// Past the session window nothing can be paid any more: give the holds
		// back even with no key, so a removed key cannot pin stock forever.
		if (final) return cancel(ctx, id, cur, "NOT_CONFIGURED", inline);
		return fail("NOT_CONFIGURED", "This shop cannot take payments yet. Please try again later.");
	}
	const r = await createCheckoutSession(ctx, s.stripeSecretKey, {
		orderId: id,
		currency: d.currency,
		lines: d.items.map((i) => ({ name: i.title, unitAmount: i.unitPrice, qty: i.qty })),
		shipping: d.shipping,
		successUrl: d.successUrl,
		cancelUrl: d.cancelUrl,
		expiresAt: Math.floor(Date.parse(d.expiresAt) / 1000),
		email: d.email,
		shippingCountries: d.shippingCountries,
		allowPromotionCodes: d.promoCodes,
		storeTag: d.store,
	});
	if (!r.ok) {
		// UNAVAILABLE (timeouts, 5xx, 429, 409 key-in-use): Stripe may or may not
		// have created the session. Keep the holds and the sweep flag; a retry with
		// the same idempotency key and identical parameters settles it.
		// REFUSED (other 4xx): Stripe validated and refused, so no session exists.
		// FINAL (sweep, past the session window): any session has expired, so give
		// the holds back. A late payment still lands as an unheld sale, flagged.
		if (r.code === "STRIPE_UNAVAILABLE" && !final)
			return fail(
				"PAYMENT_UNAVAILABLE",
				"Payments are not available for a moment. Please try again.",
			);
		// Stripe found no eligible payment method (cards turned off in the Dashboard).
		// Decided from Stripe's error param, not the text (which can echo buyer input).
		if (
			r.code === "STRIPE_REFUSED" &&
			(r.param === "allowed_payment_method_types" ||
				(r.param === undefined && /no valid payment method/i.test(r.message)))
		) {
			await noteCardProblem(ctx);
			return cancel(ctx, id, cur, CARD_NOT_OFFERED, inline);
		}
		return cancel(ctx, id, cur, r.code, inline);
	}
	const sess = r.value;
	// allowed_payment_method_types filters silently: never hand the buyer a session
	// that offers anything but card (async methods would break S-b). Expire it and
	// release through the normal path; the setup page tells the merchant.
	if (sess.status === "open" && !cardOnly(sess.paymentMethodTypes)) {
		await noteCardProblem(ctx);
		let e = await expireSession(ctx, s.stripeSecretKey, sess.id);
		// A refused or lost expire: ask Stripe what the session is now.
		if (!e.ok) e = await retrieveSession(ctx, s.stripeSecretKey, sess.id);
		if (e.ok && e.value.status === "expired") return cancel(ctx, id, cur, CARD_NOT_OFFERED, inline);
		// Still open (or unknown): keep the holds (S-b) but record the session WITHOUT
		// a checkout URL, so no buyer is ever sent to it, replays stop here, and sweep
		// part B expires it through Stripe and releases the stock.
		await updateOrder(
			ctx,
			id,
			(x) =>
				x.status !== "pending" || x.stock !== "reserving"
					? null
					: {
							...x,
							stock: "held",
							stockPending: 0,
							stripeSessionId: sess.id,
							checkoutUrl: null,
							attention: x.attention ?? CARD_NOT_OFFERED,
						},
			cur,
		);
		return fail(CARD_NOT_OFFERED, "We could not start your payment. Please try again later.");
	}
	if (sess.status !== "open") {
		// An idempotent replay returned a session that already finished.
		await applySession(ctx, sess, cur);
		return fail("ORDER_CLOSED", CLOSED_TEXT);
	}
	const next = await updateOrder(
		ctx,
		id,
		(x) =>
			x.status !== "pending" || x.stock !== "reserving"
				? null
				: { ...x, stock: "held", stockPending: 0, stripeSessionId: sess.id, checkoutUrl: sess.url },
		cur,
	);
	const v = next?.value;
	if (v && v.status === "pending" && v.checkoutUrl)
		return { ok: true, orderId: id, url: v.checkoutUrl };
	return fail("ORDER_CLOSED", CLOSED_TEXT);
}

async function cancel(
	ctx: PluginContext,
	id: string,
	cur: Versioned,
	reason: string,
	inline: boolean,
): Promise<Fail> {
	const next = await updateOrder(
		ctx,
		id,
		(x) =>
			x.status !== "pending" || x.stock !== "reserving"
				? null
				: { ...x, status: "canceled", stock: "releasing", stockPending: 1, cancelReason: reason },
		cur,
	);
	if (next && inline) {
		// Best effort: under contention the release can lose its CAS rounds. The
		// order is already canceled/releasing with its sweep flag set, so the sweep
		// finishes it; the buyer still gets the real reason, not an error.
		try {
			await completeStock(ctx, id, next);
		} catch {}
	}
	return fail(
		BUYER_REASONS.has(reason) ? reason : "CANCELED",
		reason === "OUT_OF_STOCK"
			? OUT_OF_STOCK_TEXT
			: reason === "STOCK_BUSY"
				? "Lots of people are buying this right now. Please try again in a moment."
				: "We could not start your payment. Please try again later.",
	);
}

const tracked = (d: OrderDoc) => d.items.filter((i) => i.trackStock).length;

/** An http(s) URL with a host: usable as the base for a relative return URL. */
const isAbsoluteBase = (x: string | null): x is string =>
	typeof x === "string" && /^https?:\/\/[^/]/.test(x);

/**
 * Stripe needs absolute return URLs. A relative setting (the defaults) resolves
 * against the site URL EmDash knows, else the shop address recorded by an admin's
 * own visit to the Setup page. Never the buyer's request: its Host can be forged
 * on some hosts (it would send a buyer, after paying, to a page of the forger's
 * choosing). With neither, relative URLs cannot be resolved: NOT_CONFIGURED.
 */
function absolute(u: string, ctx: PluginContext, shop: string | null): string | null {
	if (/^https?:\/\//.test(u)) return u;
	const site = (ctx as { site?: { url?: string } }).site?.url ?? "";
	const base = isAbsoluteBase(site) ? site : isAbsoluteBase(shop) ? shop : "";
	if (!/^https?:\/\/[^/]/.test(base)) return null;
	return base.replace(/\/$/, "") + (u.startsWith("/") ? u : `/${u}`);
}
