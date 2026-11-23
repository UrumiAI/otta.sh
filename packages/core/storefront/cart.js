// Otta Core storefront cart. Dependency-free ES module, no build step.
//
//   import { createCart, formatMoney } from "/otta/cart.js";
//   const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });
//
// Money is always integer minor units. Core prices everything on the server; the
// browser only says which products and how many.

const CART_SLOT = "otta-cart";
const KEY_SLOT = "otta-key:";
const KEY_INDEX = "otta-keys"; // the key slots in use, so done() can clear them all
const OPEN_SLOT = "otta-open"; // { [key slot]: ms } when Core first answered ok (a Checkout is open)
const REFUSAL_SLOT = "otta-refusals"; // { [productId]: { code, qty, title? } } last per-line refusal
const HOLD_MS = 40 * 60 * 1000; // a Stripe Checkout Session (and Core's stock hold) lasts 40 minutes
const RETRY_MS = 1500; // PAYMENT_UNAVAILABLE is retried once after this
const MAX_LINES = 8; // distinct products per order

/**
 * Where the browser's currency data (CLDR) and Core's money table (ISO 4217) disagree on
 * the minor unit. Core stores these in hundredths, CLDR displays them with no decimals;
 * without this a HUF 1500.00 price would show as 150,000.
 */
const ISO_DIGITS = { COP: 2, HUF: 2, IDR: 2, PKR: 2 };

/** Format integer minor units using Core's fraction digits for the currency (JPY 0, KWD 3, HUF 2). */
export function formatMoney(minor, currency, locale) {
	const digits =
		ISO_DIGITS[currency] ??
		new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
			.maximumFractionDigits;
	const fmt = new Intl.NumberFormat(locale, {
		style: "currency",
		currency,
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
	return fmt.format(minor / 10 ** digits);
}

const GENERIC = "Something went wrong. Please try again in a moment.";
const ENDED =
	"This checkout has already ended. If you paid, you do not need to pay again. Otherwise start again.";
const NOT_PLACED = "We could not place this order. Please start again.";
const TEXT = {
	INVALID_KEY: GENERIC,
	ERROR: GENERIC,
	INVALID_EMAIL: "That email address does not look right. Check it, or leave it blank.",
	INVALID_LINES: "Some quantities in your cart are not valid. Please check them.",
	PRODUCT_UNAVAILABLE:
		"One of the items in your cart is no longer for sale. Remove it and try again.",
	OUT_OF_STOCK:
		"Sorry, we do not have enough of one or more items. Lower the quantity or remove them, then try again.",
	STOCK_BUSY: "Lots of people are buying this right now. Please try again in a moment.",
	NOT_CONFIGURED:
		"This shop cannot take payments yet. Please try again later. (Shop owner: see Otta Core > Setup & health.)",
	BUSY: "The shop is busy right now. Please try again in a few minutes.",
	BUSY_BUYER:
		"You already have a checkout waiting for payment. Finish it, or try again in about 40 minutes.",
	FREE_ORDER:
		"This order has nothing to pay, so it cannot be checked out online. Please contact the shop.",
	KEY_REUSED: "Your cart changed since you started. Please start checkout again.",
	PAYMENT_UNAVAILABLE: "Payments are not available for a moment. Please try again.",
	ORDER_CLOSED: ENDED,
	CANCELED: NOT_PLACED,
	STRIPE_REFUSED: "We could not start your payment. Please try again later.",
	CONFLICT: "Something went wrong on our side. Please try again.",
	NETWORK: "Could not reach the store. Please try again.",
	ORDER_NOT_FOUND: "We could not find this order. Check the link, or contact the shop.",
	INVALID_INPUT: "This order link is incomplete. Please use the link from your confirmation page.",
};

/**
 * Plain words for a buyer, for any code a route can return. Never shows the server's own
 * `message` (that is for merchants and developers) and never shows the code. An order that was
 * cancelled replays with its cancel reason as the code (for example AMOUNT_MISMATCH:1999 USD or
 * RELEASED_FROM_REVIEW); anything shaped like that gets a calm "could not place" line.
 * Accepts a code or a whole failed answer.
 */
/**
 * The success page's order id and key. The key comes in the URL fragment
 * (#key=…), which browsers never send to the shop's server or in a Referer;
 * older links carried it in the query. Once read, it is removed from the
 * address bar so it does not stay in history. Keep the returned key in a
 * variable for polling; reloading the page will not need it again if the
 * caller stores it (sessionStorage) as the kit's success page does.
 */
export function successParams(loc = globalThis.location, hist = globalThis.history) {
	const q = new URLSearchParams(loc.search);
	const h = new URLSearchParams(String(loc.hash || "").replace(/^#/, ""));
	const id = q.get("order");
	const key = h.get("key") ?? q.get("key");
	if (key && hist && typeof hist.replaceState === "function") {
		q.delete("key");
		h.delete("key");
		const search = q.toString();
		const hash = h.toString();
		hist.replaceState(
			hist.state,
			"",
			`${loc.pathname}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`,
		);
	}
	return { id, key };
}

export function buyerMessage(code) {
	const c = typeof code === "string" ? code : code?.code;
	if (typeof c !== "string") return GENERIC;
	if (Object.hasOwn(TEXT, c)) return TEXT[c];
	return /[:\s]|^(RELEASED_|PAID_|AMOUNT_|FOREIGN_|SESSION_|COMPLETE_|REFUND)/.test(c)
		? NOT_PLACED
		: GENERIC;
}

/**
 * A refusal that names the product: "Sorry, Blue mug is sold out." for OUT_OF_STOCK (or "not enough
 * left" when the line asks for more than one), "Blue mug is no longer for sale." for
 * PRODUCT_UNAVAILABLE. Any other code gets buyerMessage(code). Returns plain text (set it with
 * textContent, not innerHTML).
 */
export function refusalText(code, title, qty = 1) {
	const name = typeof title === "string" && title.trim() ? title.trim() : "this item";
	if (code === "OUT_OF_STOCK")
		return qty > 1
			? `Sorry, there are not enough of ${name} left. Lower the quantity or remove it.`
			: `Sorry, ${name} is sold out.`;
	if (code === "PRODUCT_UNAVAILABLE")
		return `${name[0].toUpperCase()}${name.slice(1)} is no longer for sale.`;
	return buyerMessage(code);
}

/**
 * What the cart page shows for one line, from availability's `available` (null = unlimited,
 * otherwise units left capped at 10, so 10 means "10 or more"). `max` is the quantity input's
 * max, or null when no max should be set (sold out). `short` means checkout would be refused.
 */
export function lineStock(available, qty, cap = 99) {
	if (available === null || available === undefined) return { label: "", short: false, max: cap };
	if (available <= 0) return { label: "Sold out", short: true, max: null };
	if (available >= 10) return { label: "", short: false, max: cap }; // 10 or more: the server decides
	const short = qty > available;
	return { label: short || available <= 5 ? `only ${available} left` : "", short, max: available };
}

/** The order reference a buyer can quote: the order id's last 8 characters, uppercased. */
export function orderReference(id) {
	return typeof id === "string" && id ? id.slice(-8).toUpperCase() : "";
}

/**
 * A click guard: returns a function that answers true for the first call and false for any call
 * within `ms` of the last accepted one, so a double-click adds to the cart once.
 */
export function clickGuard(ms = 500, now = () => Date.now()) {
	let last = -Infinity;
	return () => {
		const t = now();
		if (t - last < ms) return false;
		last = t;
		return true;
	};
}

/** "ord_" + 32 lowercase hex, the format Core requires. */
function newKey(cryptoImpl) {
	const b = cryptoImpl.getRandomValues(new Uint8Array(16));
	return "ord_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A failed answer made by the kit itself; `text` is what to show the buyer. */
const fail = (code, text = buyerMessage(code)) => ({ ok: false, code, message: text, text });

/** Only productId and qty go to the server; a line may also carry a display title. */
const wire = (lines) => lines.map((l) => ({ productId: l.productId, qty: l.qty }));

// The server merges duplicate products and ignores order, and a replay must match the
// first call's lines AND email, so the key slot is derived from exactly those.
const canonOf = (lines) => {
	const merged = new Map();
	for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.qty);
	// Not toSorted(): this file runs in buyers' browsers and older Safari lacks it; the array is a fresh copy.
	// oxlint-disable-next-line unicorn/no-array-sort
	return [...merged].sort(([a], [b]) => (a < b ? -1 : 1));
};

export function createCart({
	api,
	storage = globalThis.localStorage,
	fetch: doFetch = (...a) => globalThis.fetch(...a),
	crypto: cryptoImpl = globalThis.crypto,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	now = () => Date.now(),
} = {}) {
	const readJson = (slot) => {
		try {
			const v = JSON.parse(storage.getItem(slot) ?? "{}");
			return v && typeof v === "object" && !Array.isArray(v) ? v : {};
		} catch {
			return {};
		}
	};
	const writeJson = (slot, v) =>
		Object.keys(v).length ? storage.setItem(slot, JSON.stringify(v)) : storage.removeItem(slot);
	const forgetRefusal = (productId) => {
		const r = readJson(REFUSAL_SLOT);
		if (Object.hasOwn(r, productId)) {
			delete r[productId];
			writeJson(REFUSAL_SLOT, r);
		}
	};

	const read = () => {
		try {
			const v = JSON.parse(storage.getItem(CART_SLOT) ?? "[]");
			return Array.isArray(v)
				? v.filter(
						(l) => l && typeof l.productId === "string" && Number.isInteger(l.qty) && l.qty > 0,
					)
				: [];
		} catch {
			return [];
		}
	};
	const write = (lines) => storage.setItem(CART_SLOT, JSON.stringify(lines));

	const index = () => {
		try {
			const v = JSON.parse(storage.getItem(KEY_INDEX) ?? "[]");
			return Array.isArray(v)
				? v.filter((k) => typeof k === "string" && k.startsWith(KEY_SLOT))
				: [];
		} catch {
			return [];
		}
	};
	const keepKey = (slot, key) => {
		storage.setItem(slot, key);
		const all = index();
		if (!all.includes(slot)) storage.setItem(KEY_INDEX, JSON.stringify([...all, slot]));
	};
	const dropKey = (slot) => {
		storage.removeItem(slot);
		storage.setItem(KEY_INDEX, JSON.stringify(index().filter((k) => k !== slot)));
		const open = readJson(OPEN_SLOT);
		delete open[slot];
		writeJson(OPEN_SLOT, open);
	};

	/** Unwrap EmDash's { success, data } envelope. */
	const call = async (path, init) => {
		const res = await doFetch(`${api}/${path}`, init);
		const body = await res.json();
		return body && body.data !== undefined ? body.data : body;
	};

	const slotFor = (lines, email) => KEY_SLOT + JSON.stringify([canonOf(lines), email ?? ""]);

	return {
		lines: () => read(),
		/** `title` is optional, kept only for display (a refusal can name a product that is off sale). */
		add(productId, qty = 1, title) {
			const lines = read();
			const hit = lines.find((l) => l.productId === productId);
			if (hit) hit.qty += qty;
			else lines.push({ productId, qty });
			const line = hit ?? lines[lines.length - 1];
			if (typeof title === "string" && title) line.title = title;
			write(lines);
			forgetRefusal(productId);
		},
		setQty(productId, qty) {
			if (!Number.isInteger(qty) || qty < 1) return this.remove(productId);
			write(read().map((l) => (l.productId === productId ? { ...l, qty } : l)));
			forgetRefusal(productId);
		},
		remove(productId) {
			write(read().filter((l) => l.productId !== productId));
			forgetRefusal(productId);
		},
		clear() {
			storage.removeItem(CART_SLOT);
			storage.removeItem(REFUSAL_SLOT);
		},

		/**
		 * The last checkout refusal per cart line, kept across reloads: { [productId]: { code, text } }
		 * with `text` naming the product. A refusal is forgotten when its line changes (add, setQty,
		 * remove, or the line no longer matches) or when a checkout succeeds.
		 */
		refusals() {
			const stored = readJson(REFUSAL_SLOT);
			const lines = read();
			const out = {};
			let changed = false;
			for (const [id, r] of Object.entries(stored)) {
				const l = lines.find((x) => x.productId === id);
				if (!l || !r || l.qty !== r.qty || typeof r.code !== "string") {
					delete stored[id];
					changed = true;
					continue;
				}
				out[id] = { code: r.code, text: refusalText(r.code, l.title ?? r.title, l.qty) };
			}
			if (changed) writeJson(REFUSAL_SLOT, stored);
			return out;
		},

		/**
		 * Whether these lines (the cart by default) and email already have an order key. Returns null,
		 * or { email, reserved }: `reserved` is true while the Stripe Checkout Core opened for them is
		 * still within its 40 minutes (the stock is held for this buyer). Pass `anyEmail: true` to
		 * find the key whatever email it was started with (to put that email back in the form).
		 * With a key, do not block Pay on the browser's stock numbers: those count this buyer's own
		 * hold, and the server answers a retry with the same open Checkout.
		 */
		/**
		 * True while this browser has any checkout it started in the last 40 minutes.
		 * Its holds may be what makes stock look short, and Pay releases them first,
		 * so a cart page must not block Pay on its own stock numbers then.
		 */
		hasOpenCheckout() {
			const open = readJson(OPEN_SLOT);
			return Object.entries(open).some(
				([slot, at]) =>
					typeof at === "number" && now() - at < HOLD_MS && storage.getItem(slot) !== null,
			);
		},
		pending({ email, lines = read(), anyEmail = false } = {}) {
			if (lines.length === 0) return null;
			const open = readJson(OPEN_SLOT);
			const found = (slot, mail) => {
				if (storage.getItem(slot) === null) return null;
				const at = open[slot];
				return { email: mail, reserved: typeof at === "number" && now() - at < HOLD_MS };
			};
			if (!anyEmail) return found(slotFor(lines, email), email ?? "");
			const canon = JSON.stringify(canonOf(lines));
			let best = null;
			for (const slot of index()) {
				let parsed;
				try {
					parsed = JSON.parse(slot.slice(KEY_SLOT.length));
				} catch {
					continue;
				}
				if (!Array.isArray(parsed) || JSON.stringify(parsed[0]) !== canon) continue;
				const hit = found(slot, typeof parsed[1] === "string" ? parsed[1] : "");
				if (hit && (!best || (hit.reserved && !best.reserved))) best = hit;
			}
			return best;
		},

		/**
		 * The purchase is finished: empty the cart and forget every order key. Call it on the
		 * success page once the order is paid, so the next purchase of the same lines is a new order.
		 */
		done() {
			const slots = new Set(index());
			// Also sweep slots written before the index existed (a real localStorage can list its keys).
			if (typeof storage.key === "function" && Number.isInteger(storage.length))
				for (let i = 0; i < storage.length; i++) {
					const k = storage.key(i);
					if (typeof k === "string" && k.startsWith(KEY_SLOT)) slots.add(k);
				}
			for (const k of slots) storage.removeItem(k);
			storage.removeItem(KEY_INDEX);
			storage.removeItem(OPEN_SLOT);
			storage.removeItem(REFUSAL_SLOT);
			storage.removeItem(CART_SLOT);
		},

		/**
		 * Prices and stock for up to 8 product ids. Products not on sale are missing from the result.
		 * Titles it returns are remembered on the cart's lines, so a later refusal can still name a
		 * product after it goes off sale.
		 */
		async availability(ids) {
			const out = await call(
				`availability?ids=${encodeURIComponent(ids.slice(0, MAX_LINES).join(","))}`,
			);
			const products = out && out.ok ? out.products : {};
			const lines = read();
			let changed = false;
			for (const l of lines) {
				const t = products[l.productId]?.title;
				if (typeof t === "string" && t && l.title !== t) {
					l.title = t;
					changed = true;
				}
			}
			if (changed) write(lines);
			return products;
		},

		/**
		 * Start Stripe Checkout for the cart (or for `opts.lines`). Returns Core's answer:
		 * { ok: true, orderId, url } (send the buyer to url) or { ok: false, code, message, text }.
		 * Show `text` (or buyerMessage(code)) to the buyer, never `message`.
		 * Key rules: one key per exact set of lines (and email); a retry of the same lines reuses it.
		 * It is kept after an ok answer (a buyer who comes back from Stripe and pays again gets the
		 * SAME Checkout URL and no new hold), after PAYMENT_UNAVAILABLE and after NETWORK. It is
		 * dropped after every other failure. done() forgets all keys once the order is paid.
		 * PAYMENT_UNAVAILABLE is retried once, after about 1.5 s, with the same key (safe: a replay
		 * takes no new hold). A refusal that names a product (OUT_OF_STOCK, PRODUCT_UNAVAILABLE with
		 * `productId`) gets `text` naming it, and for the cart it is kept for refusals().
		 */
		async checkout({ email, lines } = {}) {
			const fromCart = lines === undefined;
			if (fromCart) lines = read();
			if (lines.length === 0) return fail("INVALID_LINES", "Your cart is empty.");
			if (new Set(lines.map((l) => l.productId)).size > MAX_LINES)
				return fail(
					"INVALID_LINES",
					`Your cart holds more than ${MAX_LINES} different items. Please keep it to ${MAX_LINES} or fewer.`,
				);
			const slot = slotFor(lines, email);
			// A changed cart: release this browser's earlier open checkouts first, so their
			// holds don't lock the buyer out of the same items. Only at Pay time, and only
			// for checkouts this browser started. Core releases only what Stripe confirms.
			const started = readJson(OPEN_SLOT);
			if (typeof started[slot] !== "number") {
				for (const [other, at] of Object.entries(started)) {
					if (other === slot || typeof at !== "number" || now() - at > HOLD_MS) continue;
					const earlier = storage.getItem(other);
					if (!earlier) continue;
					try {
						const r = await call("checkout/release", {
							method: "POST",
							headers: { "content-type": "application/json", "x-otta-checkout": "1" },
							body: JSON.stringify({ key: earlier }),
						});
						if (r && r.ok) dropKey(other);
					} catch {
						// Best effort: the earlier checkout still ends on its own.
					}
				}
			}
			const key = storage.getItem(slot) ?? newKey(cryptoImpl);
			keepKey(slot, key);
			const attempt = async () => {
				try {
					const a = await call("checkout", {
						method: "POST",
						headers: { "content-type": "application/json", "x-otta-checkout": "1" },
						body: JSON.stringify({ key, lines: wire(lines), ...(email ? { email } : {}) }),
					});
					return a && typeof a.ok === "boolean" ? a : fail("ERROR");
				} catch {
					return fail("NETWORK");
				}
			};
			let out = await attempt();
			if (!out.ok && out.code === "PAYMENT_UNAVAILABLE") {
				await sleep(RETRY_MS);
				out = await attempt();
			}
			if (out.ok) {
				const open = readJson(OPEN_SLOT);
				if (typeof open[slot] !== "number") writeJson(OPEN_SLOT, { ...open, [slot]: now() });
				storage.removeItem(REFUSAL_SLOT);
				return out;
			}
			const line =
				typeof out.productId === "string"
					? lines.find((l) => l.productId === out.productId)
					: undefined;
			const named = line && (out.code === "OUT_OF_STOCK" || out.code === "PRODUCT_UNAVAILABLE");
			out = {
				...out,
				text: named ? refusalText(out.code, line.title, line.qty) : buyerMessage(out.code),
			};
			if (named && fromCart) {
				const r = readJson(REFUSAL_SLOT);
				writeJson(REFUSAL_SLOT, {
					...r,
					[line.productId]: {
						code: out.code,
						qty: line.qty,
						...(line.title ? { title: line.title } : {}),
					},
				});
			}
			if (out.code !== "PAYMENT_UNAVAILABLE" && out.code !== "NETWORK") dropKey(slot);
			return out;
		},

		/** One poll of the order for the success page. Returns Core's { ok, order } or { ok: false, ... }. */
		async order(id, key) {
			try {
				// The key goes in a header, not the URL, so it stays out of access logs.
				const out = await call(`order?id=${encodeURIComponent(id)}`, {
					headers: { "x-otta-order-key": key },
				});
				return out && out.ok === false ? { ...out, text: buyerMessage(out.code) } : out;
			} catch {
				return fail("NETWORK");
			}
		},
	};
}
