# Otta Core storefront kit

A registry plugin cannot ship pages, so Otta Core's storefront is a snippet kit you paste into
your own EmDash/Astro theme. This folder has one file to copy, `cart.js`, and the examples below.

`cart.js` is a dependency-free ES module (no build step). It keeps the cart in `localStorage`,
starts checkout with the order-key rules Core needs, reads stock and prices, and formats money.

## 1. Set it up

Paste the pages below inside your theme's layout, which should set `<meta charset="utf-8">`;
standalone fragments without it can show characters such as `·` garbled.

1. Copy `cart.js` into your theme's static folder, for example `public/otta/cart.js`. Pages then
   import it as `/otta/cart.js`.
2. Find your **plugin id**. Open the plugin's settings in the EmDash admin and read the address bar:
   `/_emdash/admin/plugins-manager/<plugin-id>/settings`. For a registry install the id is `r_`
   plus 16 characters (not `otta-core`). Every example below uses `PLUGIN_ID` as a placeholder.
3. Routes live at `/_emdash/api/plugins/PLUGIN_ID/<route>` and EmDash wraps answers as
   `{ success, data }`. `cart.js` unwraps that for you. Pages must be on the same origin as the
   site: Core refuses cross-origin POSTs.
4. In the plugin settings, set the success URL to your success page and the cancel URL to your
   cart page. The defaults are `/checkout/success?order={ORDER_ID}#key={ORDER_KEY}` and `/cart`;
   relative URLs like these are resolved against your shop's own address at checkout, so you only
   need a full `https://` URL if the pages live elsewhere. The success URL must contain both
   `{ORDER_ID}` and `{ORDER_KEY}`. Put the order key only there; never in the cancel URL or
   anywhere else.
5. **In Astro, every snippet's script must be `<script is:inline type="module">`.** Without
   `is:inline`, Astro hands the script to Vite, which refuses to import a file from `public/`
   ("Cannot import non-asset file /otta/cart.js which is inside /public") and the button never loads.
   Plain HTML pages can drop `is:inline`; it does no harm there.

`PRODUCT_CONTENT_ID` below is the product's content id: in EmDash's Astro API that is
`entry.data.id` (a ULID), not `entry.id`, which is the entry's slug. See section 8.

## 2. `cart.js` API

```js
import { createCart, formatMoney, lineStock, refusalText, buyerMessage, successParams, orderReference, clickGuard } from "/otta/cart.js";
const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });

cart.add(productId, qty = 1, title);  // adds to an existing line; title is optional, for display
cart.setQty(productId, qty);    // qty < 1 removes the line
cart.remove(productId);
cart.clear();                   // empties the cart only
cart.done();                    // purchase finished: empties the cart and forgets every order key
cart.lines();                   // [{ productId, qty }]

await cart.availability(ids);   // { [id]: { title, price, currency, active, available } }
await cart.checkout({ email, lines });  // { ok: true, orderId, url } | { ok: false, code, message, text }
                                // lines (optional): buy these instead of the cart, as a buy button does
await cart.order(id, key);      // { ok: true, order } | { ok: false, ... }
cart.refusals();                // { [productId]: { code, text } } last refusal per line, named
cart.pending({ email });        // null | { email, reserved }: these lines already have an order key
cart.hasOpenCheckout();         // true while this browser has an earlier checkout that may hold stock
lineStock(available, qty, 99);  // { label: "" | "only 3 left" | "Sold out", short, max }
refusalText(code, title, qty);  // "Sorry, Blue mug is sold out." / "Blue mug is no longer for sale."
orderReference(orderId);        // "89ABCDEF": the last 8 characters, uppercased
clickGuard(500);                // () => boolean; false for a second click within 500 ms
formatMoney(1999, "USD");       // "$19.99"; JPY has 0 decimals, KWD and BHD have 3
```

- `price` is an integer in minor units (cents). Always format with `formatMoney`, never `/ 100`.
- `availability` takes up to 8 ids. Products that are not on sale are missing from the result.
  `available` is `null` for unlimited stock, otherwise the units left **capped at 10**, so you can
  say "only 3 left" but a count of 10 means "10 or more".
- A cart holds up to 8 distinct products, each up to the maximum set in the plugin settings
  (default 99).

### The order key

Every purchase needs a **checkout id**, `ord_` plus 32 lowercase hex characters, made by the
browser; it becomes the order's id. (It is not the *order key* in the success link's `#key=`,
which Core makes and which lets the success page read the order.) Core creates one order per
checkout id. `checkout()` handles it for you:

- The key is stored per exact set of lines (and email). Clicking again for the same lines retries
  the same order and never creates a second one. Different lines get a different key.
- The key is **kept after an ok answer**. A buyer who goes to Stripe, comes back and pays again
  gets the same order and the same Checkout URL, with no second stock hold. It is also kept after
  `PAYMENT_UNAVAILABLE`, a network error (`NETWORK`), `ERROR` and `CONFLICT`, because the order
  may already exist and hold stock, and a retry should continue it. It is dropped after every
  other failure.
- Call `cart.done()` on the success page once the order is paid (section 5). It empties the cart
  and forgets every key, so the buyer's next purchase is a new order.
- If the buyer comes back after the Stripe session ended (40 minutes) or paid without reaching the
  success page, the old key answers `ORDER_CLOSED`; the key is dropped and the next click starts a
  new order.
- Reusing a key with different lines returns `KEY_REUSED`. If you build your own checkout call,
  follow the same rules, and send the `x-otta-checkout: 1` header: the route refuses checkout
  requests without it, so another website cannot start checkouts from a visitor's browser.

## 3. A buy button

This is the one buy-button snippet; the main README points here. It buys one unit straight away
(no cart page). Replace `PLUGIN_ID`, and set `data-otta-buy` to the product's `entry.data.id`.

```html
<button type="button" data-otta-buy="PRODUCT_CONTENT_ID">Buy</button>
<p data-otta-msg role="status"></p>

<script is:inline type="module">
	import { createCart, buyerMessage } from "/otta/cart.js";
	const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });

	for (const btn of document.querySelectorAll("[data-otta-buy]")) {
		if (btn.dataset.ottaReady) continue; // the snippet may be on the page more than once
		btn.dataset.ottaReady = "1";
		btn.addEventListener("click", async () => {
			const msg = btn.parentElement.querySelector("[data-otta-msg]");
			btn.disabled = true;
			if (msg) msg.textContent = "";
			// cart.js sends the x-otta-checkout header and handles the order key.
			const out = await cart.checkout({ lines: [{ productId: btn.dataset.ottaBuy, qty: 1 }] });
			if (out.ok) return location.assign(out.url); // Stripe Checkout
			if (msg) msg.textContent = buyerMessage(out.code); // never out.message
			btn.disabled = false;
		});
	}
</script>
```

### The same thing as an Astro component

`src/components/OttaBuyButton.astro`. The script stays `is:inline` (section 1, step 5), so it is
plain JavaScript, and it marks each button so that several on one page attach once each.

```astro
---
interface Props {
	productId: string; // entry.data.id
	label?: string;
}
const { productId, label = "Buy" } = Astro.props;
const API = "/_emdash/api/plugins/PLUGIN_ID";
---

<div class="otta-buy" data-api={API} data-product={productId}>
	<button type="button">{label}</button>
	<p role="status"></p>
</div>

<script is:inline type="module">
	import { createCart, buyerMessage } from "/otta/cart.js";

	for (const root of document.querySelectorAll(".otta-buy")) {
		if (root.dataset.ottaReady) continue;
		root.dataset.ottaReady = "1";
		const btn = root.querySelector("button");
		const msg = root.querySelector("p");
		const cart = createCart({ api: root.dataset.api });
		btn.addEventListener("click", async () => {
			btn.disabled = true;
			msg.textContent = "";
			const out = await cart.checkout({ lines: [{ productId: root.dataset.product, qty: 1 }] });
			if (out.ok) return location.assign(out.url);
			msg.textContent = buyerMessage(out.code);
			btn.disabled = false;
		});
	}
</script>
```

Use it in a page: `<OttaBuyButton productId={entry.data.id} label="Buy now" />` (section 8).

## 4. A "add to cart" button and the cart page

Add to cart from any page. After adding, the buyer sees "Added to your cart · View cart", a cart
link with the item count can sit anywhere on the page, a double-click adds one unit (a second
click within 500 ms is ignored), and the button is disabled when the product is sold out (the
kit's `availability()` shows 0 left):

```html
<a href="/cart">Cart (<span data-otta-count>0</span>)</a>

<button type="button" data-otta-add="PRODUCT_CONTENT_ID">Add to cart</button>
<span data-otta-added role="status" hidden>Added to your cart · <a href="/cart">View cart</a></span>

<script is:inline type="module">
	import { createCart, clickGuard } from "/otta/cart.js";
	const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });

	const showCount = () => {
		const n = cart.lines().reduce((sum, l) => sum + l.qty, 0);
		for (const el of document.querySelectorAll("[data-otta-count]")) el.textContent = String(n);
	};
	showCount();

	const buttons = [...document.querySelectorAll("[data-otta-add]")];
	let info = {};
	for (const b of buttons) {
		if (b.dataset.ottaReady) continue; // the snippet may be on the page more than once
		b.dataset.ottaReady = "1";
		const accept = clickGuard(500); // a double-click adds once
		b.addEventListener("click", () => {
			if (!accept()) return;
			cart.add(b.dataset.ottaAdd, 1, info[b.dataset.ottaAdd]?.title);
			showCount();
			const added = b.parentElement.querySelector("[data-otta-added]");
			if (added) added.hidden = false; // "Added to your cart · View cart"
		});
	}

	// Sold out: disable the buttons whose product has 0 available (null means unlimited).
	const ids = [...new Set(buttons.map((b) => b.dataset.ottaAdd))].slice(0, 8);
	if (ids.length) {
		info = await cart.availability(ids);
		for (const b of buttons) {
			const p = info[b.dataset.ottaAdd];
			if (p && p.available === 0) {
				b.disabled = true;
				b.textContent = "Sold out";
			}
		}
	}
</script>
```

The cart page (`/cart`). Set the plugin's **cancel URL to this page** (the default `/cart`): a
buyer who leaves Stripe without paying lands here. It lists several lines, lets the buyer change
quantities, shows "only N left" or "Sold out", and starts checkout. Prices come from the server,
not from the browser's copy. It also:

- marks the line a checkout was refused for ("Sorry, Blue mug is sold out." / "Blue mug is no
  longer for sale."). `cart.refusals()` keeps that reason across a reload and forgets it when the
  line changes or a checkout succeeds;
- does not block Pay on the browser's stock numbers when these exact lines already have an order
  key (`cart.pending()`): the stock the page sees excludes the buyer's own hold, and Core answers
  the retry with the same open Checkout;
- after coming back from Stripe without paying, says "Your items are reserved for about 40
  minutes. You can pay now, or change your cart." and puts back the email the checkout was
  started with (the key belongs to the lines and that email);
- retries `PAYMENT_UNAVAILABLE` once by itself (inside `cart.checkout()`) before showing it.

```html
<h1>Your cart</h1>
<p id="reserved" role="status" hidden>Your items are reserved for about 40 minutes. You can pay now, or change your cart.</p>
<ul id="lines"></ul>
<p id="total"></p>
<label>Email (optional) <input id="email" type="email" autocomplete="email" /></label>
<button id="pay" type="button">Pay with card</button>
<p id="msg" role="status"></p>

<script is:inline type="module">
	import { createCart, formatMoney, lineStock } from "/otta/cart.js";
	const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });
	const $ = (id) => document.getElementById(id);
	const MOST_PER_ORDER = 99; // your "most units of one product per order" setting
	const email = () => $("email").value.trim() || undefined;

	// Back from Stripe: put back the email the open checkout was started with, so Pay replays it.
	const back = cart.pending({ anyEmail: true });
	if (back && back.email && !$("email").value) $("email").value = back.email;

	const el = (tag, text, attrs = {}) => {
		const e = document.createElement(tag);
		if (text) e.textContent = text;
		for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
		return e;
	};

	async function render() {
		const lines = cart.lines();
		const info = lines.length ? await cart.availability(lines.map((l) => l.productId).slice(0, 8)) : {};
		const refused = cart.refusals();
		const open = cart.pending({ email: email() }); // these exact lines already have a key
		let total = 0, currency = "USD", blocked = lines.length === 0;
		$("lines").replaceChildren();
		for (const l of lines) {
			const p = info[l.productId];
			const li = el("li");
			if (!p || p.price === null) {
				// Not on sale any more: it would fail checkout, so offer to remove it.
				blocked = true;
				const why = refused[l.productId]?.text ?? `${l.title ?? "This product"} is no longer available.`;
				li.append(el("span", why + " ", { role: "alert" }));
			} else {
				currency = p.currency;
				total += p.price * l.qty;
				const s = lineStock(p.available, l.qty, MOST_PER_ORDER);
				// This browser's own open checkout may be what holds the stock; Pay releases it
				// first, so only block on stock when there is none (the server decides otherwise).
				const mine = cart.hasOpenCheckout(); // stock this browser holds counts as taken
				if (s.short && !open && !mine) blocked = true;
				const q = el("input", "", { type: "number", min: "1", value: String(l.qty), "aria-label": "Quantity" });
				if (s.max !== null) q.max = String(s.max);
				q.onchange = () => { cart.setQty(l.productId, Number(q.value)); render(); };
				li.append(el("span", `${p.title} ${formatMoney(p.price, p.currency)} `), q, " ");
				// While this browser holds stock, "Sold out" may be its own hold: say nothing
				// and let Pay (which releases it first) decide.
				if (s.label && !open && !(mine && s.short)) li.append(el("em", s.label), " ");
			}
			const rm = el("button", "Remove", { type: "button" });
			rm.onclick = () => { cart.remove(l.productId); render(); };
			li.append(rm);
			if (p && p.price !== null && refused[l.productId]) li.append(el("p", refused[l.productId].text, { role: "alert" }));
			$("lines").append(li);
		}
		$("total").textContent = lines.length ? `Subtotal ${formatMoney(total, currency)} (shipping is added at checkout)` : "Your cart is empty.";
		$("reserved").hidden = !(open && open.reserved);
		$("pay").disabled = blocked;
	}

	$("email").onchange = () => render(); // the key belongs to the lines and the email
	$("pay").onclick = async () => {
		$("pay").disabled = true;
		$("msg").textContent = "";
		const out = await cart.checkout({ email: email() });
		if (out.ok) return location.assign(out.url);
		$("msg").textContent = out.text; // buyer words, names the product when Core says which; never out.message
		await render(); // stock or prices may have changed
	};
	render();
</script>
```

Notes: the totals shown are for display only. Core prices the order on the server and Stripe
shows the final amount. If you ship worldwide with differing rates, say so near the button, as
Core charges one flat shipping amount (set in minor units: `500` = $5.00).

## 5. The success page

Set the plugin's success URL to this page. Stripe sends the buyer here straight after paying,
often before the webhook has arrived. `order` asks Stripe itself while the order is pending, so
polling is safe. Poll about 10 times, waiting longer each time. Once the order is paid, the
snippet calls `cart.done()`: that empties the cart and forgets the order keys, so the buyer's next
purchase is a new order (until then, going back and paying again reuses the same order).

The page shows an **order reference** for the buyer to quote: the last 8 characters of the order
id, uppercased (`orderReference(id)`, for example "Order reference: 89ABCDEF"). On the Orders page,
order ids are lowercase: a buyer's `89ABCDEF` is the order whose id ends in `89abcdef`. It does not promise a receipt: Stripe only emails one if you turn
receipts on (main README, Setup step 4), so the paid note says "If the shop has Stripe receipts
turned on, a receipt is on its way to your email."

```html
<h1 id="title">Checking your payment...</h1>
<p id="ref"></p>
<p id="note"></p>
<ul id="items"></ul>
<p id="total"></p>

<script is:inline type="module">
	import { createCart, formatMoney, successParams, orderReference } from "/otta/cart.js";
	const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });
	// The key arrives in the #fragment and is removed from the address bar once read;
	// keep it for this tab so a reload still works.
	const p = successParams();
	const id = p.id ?? "";
	const key = p.key ?? sessionStorage.getItem("otta-success:" + id) ?? "";
	if (p.key) sessionStorage.setItem("otta-success:" + id, p.key);
	const $ = (id) => document.getElementById(id);
	const RECEIPT = "If the shop has Stripe receipts turned on, a receipt is on its way to your email.";

	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	let delay = 1000;
	for (let i = 0; i < 10; i++) {
		const out = await cart.order(id, key);
		if (!out.ok && out.code !== "NETWORK") {
			$("title").textContent = "We could not find this order. Check the link, or contact the shop.";
			break;
		}
		const o = out.ok ? out.order : null;
		if (o && o.status !== "pending") {
			show(o);
			break;
		}
		if (i === 9) {
			$("title").textContent = "Your payment is still being confirmed. You do not need to pay again. Refresh this page in a minute.";
			if (id) $("ref").textContent = `Order reference: ${orderReference(id)}`;
			break;
		}
		await wait(delay);
		delay = Math.min(delay * 1.6, 8000); // 1s, 1.6s, 2.6s ... capped at 8s
	}

	function show(o) {
		const paid = o.status === "paid" || o.status === "fulfilled";
		const charged = o.amountPaid != null && o.amountPaid > 0; // money was taken, whatever the status now
		$("title").textContent =
			o.status === "fulfilled"
				? "Thank you, your payment was received. Your order has shipped."
				: paid
					? "Thank you, your payment was received."
					: o.status === "review"
						? "Thank you. The shop is checking your order."
						: o.status === "expired" && !charged
							? "This order was not completed and you were not charged."
							: charged
								? "This order was cancelled. The shop will refund your payment."
								: "This order was not completed and you were not charged.";
		$("ref").textContent = `Order reference: ${orderReference(id)}`; // the last 8 characters of the order id
		$("note").textContent =
			o.status === "review"
				? "If you do not hear back soon, contact the shop and quote your order reference."
				: charged && !paid
					? "Contact the shop and quote your order reference if you do not see the refund within a few days."
					: paid
						? RECEIPT
						: "";
		if (!paid) return;
		cart.done(); // the purchase is done: empty the cart and forget the order keys
		$("items").innerHTML = o.items.map((i) => `<li>${i.qty} x ${i.title.replace(/</g, "&lt;")}: ${formatMoney(i.unitPrice * i.qty, o.currency)}</li>`).join("");
		const parts = [o.shipping ? `Shipping ${formatMoney(o.shipping, o.currency)}` : null, o.discount ? `Discount −${formatMoney(o.discount, o.currency)}` : null].filter(Boolean);
		$("total").textContent = `${parts.length ? parts.join(" · ") + " · " : ""}Total ${formatMoney(o.amountPaid ?? o.total, o.currency)}`;
	}
</script>
```

Order `status` values you can see: `pending` (keep polling), `paid`, `fulfilled` (the merchant
marked it shipped; treat as paid), `review` (money taken but something did not match; the
merchant decides), `expired` and `canceled`. A canceled order normally took no payment, but
one the merchant released from review (or that was paid late) did: check `amountPaid` before
saying "you were not charged", as the snippet does. Never say a review order was "paid"
(there may be no payment) and never show `attention` or `cancelReason` to a buyer. The order is only readable with
the `key` in the URL, so do not log or share that address.

## 6. Where things can go wrong

- **404 or an HTML page instead of JSON:** wrong plugin id. Check section 1, step 2.
- **Buyer leaves Stripe without paying:** Stripe sends them to the cancel URL. Set it to the cart
  page (section 4; the default `/cart`), which says their items are reserved for about 40
  minutes and lets them pay again (the same Checkout, no new hold) or change the cart.
- **"Payments are not available for a moment":** `cart.checkout()` already retried once after
  about 1.5 s (for example two tabs pressing Pay at the same instant), so a real Stripe outage is
  what remains. The key is kept, so the next click continues the same order.
- **Cross-origin errors:** pages and API must be on the same origin; Core refuses other origins.
- **`NOT_CONFIGURED` on every try:** a setting is missing or invalid (Stripe key, currency, URLs).
- **Stripe never confirms:** the success page still works, because it asks Stripe; but add the
  webhook from the main README, which also releases stock held by abandoned checkouts.
- **Abuse:** add a Cloudflare rate-limiting rule for `/checkout` and `/order` (see the main README).

## 7. Messages for shoppers

`out.code` is stable; `out.message` is for merchants and developers and must never reach a
buyer. `cart.js` exports `buyerMessage(codeOrAnswer)`, which turns every code into short plain
words (what happened, what to do), gives unknown codes a safe generic line, and handles a
cancelled order replaying with its cancel reason as the code. Failed answers from `checkout()` and
`order()` also carry the same words in `out.text`; for `OUT_OF_STOCK` and `PRODUCT_UNAVAILABLE`
with a `productId`, `checkout()`'s `text` names the product (`refusalText`). Use one copy of this
text everywhere.

| Code | Meaning | Buyer sees | Key |
|---|---|---|---|
| `INVALID_LINES` | Empty cart, bad quantity, more than 8 items, or over the per-item maximum | "Some quantities in your cart are not valid. Please check them." | dropped |
| `INVALID_EMAIL` | Email box is not an address | "That email address does not look right. Check it, or leave it blank." | dropped |
| `PRODUCT_UNAVAILABLE` | A product is unpublished, unpriced or in another currency | "One of the items in your cart is no longer for sale. Remove it and try again." With `productId`, `out.text` names it: "Blue mug is no longer for sale." | dropped |
| `OUT_OF_STOCK` | Not enough stock | "Sorry, we do not have enough of one or more items. Lower the quantity or remove them, then try again." With `productId`, `out.text` names it: "Sorry, Blue mug is sold out." | dropped |
| `STOCK_BUSY` | Stock was too contended to reserve | "Lots of people are buying this right now. Please try again in a moment." | dropped |
| `NOT_CONFIGURED` | Store setup incomplete (the merchant sees why on Setup & health) | "This shop cannot take payments yet. Please try again later. (Shop owner: see Otta Core > Setup & health.)" | dropped |
| `BUSY` | Too many open checkouts | "The shop is busy right now. Please try again in a few minutes." | dropped |
| `BUSY_BUYER` | This buyer already has the most open checkouts allowed (plugin setting, default 5) | "You already have a checkout waiting for payment. Finish it, or try again in about 40 minutes." | dropped |
| `NOT_RELEASABLE` | (from `checkout/release`, called by the kit itself) the earlier checkout is paid, closed, unknown or still starting | not shown: the kit carries on with the new checkout | n/a |
| `FREE_ORDER` | Order total is 0 | "This order has nothing to pay, so it cannot be checked out online. Please contact the shop." | dropped |
| `KEY_REUSED` | Key used for different lines (not with `cart.js`) | "Your cart changed since you started. Please start checkout again." | dropped |
| `PAYMENT_UNAVAILABLE` | Stripe could not be reached (`cart.js` retries once after about 1.5 s first) | "Payments are not available for a moment. Please try again." | **kept** |
| `NETWORK` (from `cart.js`) | Request failed | "Could not reach the store. Please try again." | **kept** |
| `ORDER_CLOSED` | That order is already paid, expired or canceled | "This checkout has already ended. If you paid, you do not need to pay again. Otherwise start again." | dropped |
| `CANCELED`, cancel reasons | A cancelled order replayed | "We could not place this order. Please start again." | dropped |
| `STRIPE_REFUSED` | Stripe refused to start the payment | "We could not start your payment. Please try again later." | dropped |
| `CONFLICT` | Rare race | "Something went wrong on our side. Please try again." | dropped |
| `ORDER_NOT_FOUND`, `INVALID_INPUT` | Success page: bad link | "We could not find this order..." / "This order link is incomplete..." | n/a |
| anything else | `INVALID_KEY`, `ERROR`, new codes | "Something went wrong. Please try again in a moment." | dropped |

```js
import { createCart, buyerMessage } from "/otta/cart.js";
const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });
const out = await cart.checkout();
if (!out.ok) document.getElementById("msg").textContent = buyerMessage(out.code); // not out.message
```

## 8. Product pages

Products are ordinary EmDash content, so list and render them with EmDash's Astro API
(`getEmDashCollection` and `getEmDashEntry` from `"emdash"`). Two things to know:

- **The id Core uses is `entry.data.id`** (the content's ULID). `entry.id` is the slug, which
  Core does not know about; passing it gives `PRODUCT_UNAVAILABLE`.
- **EmDash collections have no built-in title.** Add a `title` field (Short Text) to the
  `products` collection yourself (main README, Setup step 2).

A list page, `src/pages/products/index.astro` (only published entries are returned by default):

```astro
---
import { getEmDashCollection } from "emdash";
const { entries } = await getEmDashCollection("products");
---

<ul>
	{entries.map((p) => (
		<li><a href={`/products/${p.id}`}>{p.data.title}</a></li>
	))}
</ul>
```

One product, `src/pages/products/[slug].astro` (this is the `/products/{slug}` URL pattern from
the main README, Setup step 2). The page shows the price and a cart link with the item count, has
a Buy button and an Add to cart button, and disables both when the product is sold out:

```astro
---
import { getEmDashEntry } from "emdash";

const { entry } = await getEmDashEntry("products", Astro.params.slug);
if (!entry) return Astro.rewrite("/404");
---

<p><a href="/cart">Cart (<span data-otta-count>0</span>)</a></p>

<h1>{entry.data.title}</h1>
<p data-otta-price data-id={entry.data.id}></p>

<div data-otta-product data-id={entry.data.id} data-title={entry.data.title}>
	<button type="button" data-otta-buy>Buy now</button>
	<button type="button" data-otta-add>Add to cart</button>
	<p data-otta-msg role="status"></p>
	<p data-otta-added role="status" hidden>Added to your cart · <a href="/cart">View cart</a></p>
</div>

<script is:inline type="module">
	import { createCart, formatMoney, clickGuard } from "/otta/cart.js";
	const cart = createCart({ api: "/_emdash/api/plugins/PLUGIN_ID" });

	const showCount = () => {
		const n = cart.lines().reduce((sum, l) => sum + l.qty, 0);
		for (const el of document.querySelectorAll("[data-otta-count]")) el.textContent = String(n);
	};
	showCount();

	const root = document.querySelector("[data-otta-product]");
	const id = root.dataset.id;
	const title = root.dataset.title;
	let soldOut = false; // set once Core's stock is known
	const buy = root.querySelector("[data-otta-buy]");
	const add = root.querySelector("[data-otta-add]");
	const msg = root.querySelector("[data-otta-msg]");
	const added = root.querySelector("[data-otta-added]");

	buy.addEventListener("click", async () => {
		buy.disabled = true;
		msg.textContent = "";
		const out = await cart.checkout({ lines: [{ productId: id, qty: 1, title }] });
		if (out.ok) return location.assign(out.url); // Stripe Checkout
		msg.textContent = out.text; // buyer words, naming the product if it sold out; never out.message
		buy.disabled = soldOut;
	});

	const accept = clickGuard(500); // a double-click adds once
	add.addEventListener("click", () => {
		if (!accept()) return;
		cart.add(id, 1, title);
		showCount();
		added.hidden = false; // "Added to your cart · View cart"
	});

	// Show the live price and stock from Core, not the CMS field (the CMS stock is a starting value).
	// Sold out (0 available) disables both buttons; null means unlimited stock.
	// Not on sale (missing from the reply) disables them too.
	const el = document.querySelector("[data-otta-price]");
	const p = (await cart.availability([id]))[id];
	el.textContent = !p || p.price === null ? "Not available"
		: p.available === 0 ? `${formatMoney(p.price, p.currency)}, sold out`
		: formatMoney(p.price, p.currency);
	if (!p || p.price === null || p.available === 0) {
		soldOut = true;
		buy.disabled = true;
		add.disabled = true;
		if (p && p.available === 0) add.textContent = buy.textContent = "Sold out";
	}
</script>
```

The page above is self-contained, so it does not use the `OttaBuyButton` component from section 3
(that component has no sold-out check). `data-otta-add` and `data-otta-buy` here carry no id
because the page script reads it from the wrapper.

On other pages (a list of products, say), use the section 4 snippet with
`data-otta-add={entry.data.id}`.

## Tests

`cart.test.ts` covers the key rules, the `PAYMENT_UNAVAILABLE` retry, per-line refusals,
`pending()`, the stock label, the order reference, the click guard and money formatting with a
fake `localStorage` and `fetch`. It is in the package's vitest `include`; run just it with
`npx vitest run storefront`.
