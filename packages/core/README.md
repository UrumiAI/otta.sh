# Otta Core

The registry edition of Otta: a sandboxed EmDash plugin that sells products from your
EmDash content through Stripe hosted Checkout, with per-order stock holds and no oversell.
Two small admin pages come with it: **Orders** (see, fulfil and resolve orders, set stock) and
**Setup & health** (what is configured, what is missing, and the snippet for your theme).
Settings use the form EmDash generates. The same actions are MCP tools for an AI assistant.

Full Otta (npm, `@urumi.ai/otta-*`) is the complete store: variants, coupons, tax and
shipping rules, customer accounts, digital downloads, reports and an admin. Moving from Core
to full Otta is an **import** (products, stock, settings and order history), not an in-place
switch. Registry plugins get their own storage namespace.

## Requirements

- EmDash 1.5 or later on Cloudflare **Workers Paid** (registry plugins run in Worker Loaders).
  1.5 is the floor because a checkout of 8 products typically needs 25 host calls in one
  request (2n + 9 for n products; one fewer when the host gives no buyer IP), and earlier hosts
  allowed 10.
- `EMDASH_ENCRYPTION_KEY` set on the site. EmDash needs it to store the Stripe secrets.
  Generate one with `npx emdash secrets generate` (or `--write .env` to append it to a local
  `.env`), and on Cloudflare store it as a Worker secret (`wrangler secret put EMDASH_ENCRYPTION_KEY`).
  Keep it: the saved Stripe key and webhook secret can only be read with the key they were
  saved under. A wrong, malformed or changed value means EmDash cannot read the plugin's secret
  settings, and EmDash disables the plugin; the site's log shows
  `[emdash] EMDASH_ENCRYPTION_KEY is invalid` for a malformed key. Restore the original value
  rather than generating a new one, or re-enter the Stripe secrets after changing it.
- A cron trigger on the site at 5 minutes or faster. Core's sweep runs no more often than
  the site's own trigger.
- Card payments only. Stripe Tax is not used, so the price you set is the price charged,
  plus the flat shipping amount. Note the units differ: product `price` is in major units
  (`19.99`), but the *flat shipping* setting is in minor units (`500` = $5.00).
- Discount codes: turn on *Let buyers enter Stripe promotion codes* and create the codes in
  Stripe (Products → Coupons). Core checks that Stripe charged its subtotal and shipping exactly
  and records the discount on the order. Changing the setting affects only new checkouts.
  Any active promotion code in your Stripe account is accepted, so if the account serves other
  businesses too, restrict codes in Stripe (for example by customer or expiry).
  Codes discount the products, not the flat shipping (checked against real Stripe), so a 100%
  code makes the order free only when shipping is 0; otherwise the buyer pays the shipping.
  A free order shows on the Orders page as "free order (promotion code)": no money came in,
  so there is nothing to refund. With the Stripe CLI, a code is created as
  `stripe post /v1/promotion_codes -d promotion[type]=coupon -d promotion[coupon]=<coupon id> -d code=<CODE>`.
- Payments are card only. Core asks Stripe for card payment on every checkout. Stripe's page
  may still show Link, Apple Pay and Google Pay, and Link's bank and pay-later options (shown as
  "Bank" and "Klarna (powered by Link)"). A real test run showed these are all paid through Link
  with a card credential: they arrive as card payments, are paid at once, and have no delayed
  settlement. That is why stock holds stay safe: nothing can complete after the hold ends. Core
  still refuses to send a buyer to a checkout whose payment methods include a delayed one.
  Cards must be turned on in your Stripe Dashboard (Settings → Payment methods); the Setup &
  health page tells you if Stripe would not offer them.

## Setup

1. Install **Otta Core** from the plugin registry. Approve `content:read` (product sync)
   and `network:request` to `api.stripe.com` (payments).
2. Create a content collection named `products` (or set *Products collection*). In EmDash's
   admin the form asks about Routable, URL pattern, Drafts, Revisions, Search and SEO. Set
   **Routable** on and the **URL pattern** to `/products/{slug}` (this matches the kit's product
   page). **Drafts** and **Revisions** are optional; with drafts on, edits go live when you
   publish. Search and SEO are up to you. Then add these fields:

   | Field | Type (EmDash field picker) | Meaning |
   |---|---|---|
   | `title` | Text (*Short Text*), **you add it**; mark it **Required** (recommended) | EmDash collections have no built-in title. Shown in Stripe Checkout and on the order. |
   | `price` | *Number* (decimal); mark it **Required** (recommended) | **Major units**, e.g. `19.99` for $19.99 (unlike flat shipping, which is in minor units). More decimals than the currency has (for example `1.005` USD) makes the product unsellable. |
   | `sku` | Text (*Short Text*), optional (not Required) | Your reference. |
   | `stock` | *Integer*, optional (not Required) | A **starting value** for units on hand. Leave it empty for unlimited stock. After sales or a `set_stock`, the live number is on **Orders → Stock**, not in this field. Changing the field sets stock again to the new value; re-saving with the same value does nothing, so sold units are never put back by an edit. To restock to the same number you set last time (for example back to 2 after selling out), use **Orders → Stock** or the `set_stock` tool. |

   On your site, the id Core uses for a product is `entry.data.id` (the content's ULID) in
   EmDash's Astro API; `entry.id` is the slug.

   Only **published** products can be bought. Edits staged as a draft over a live product
   take effect when you publish.
3. In the plugin's settings, enter a Stripe key. A **restricted key** is safer than the full
   secret key; it needs only: *Checkout Sessions: Write*, *PaymentIntents: Read* and
   *Refunds: Read* (the set Core was tested with). Then enter the currency, the flat shipping in
   minor units (`500` = $5.00, `0` = free), *Ship to (2-letter country codes, comma separated)*
   and the URLs. Leave *Ship to* empty and no shipping address is collected, so set it if you ship
   physical goods (for example `US, CA, GB`). The success and cancel URLs default to
   `/checkout/success?order={ORDER_ID}#key={ORDER_KEY}` and `/cart`; relative URLs are resolved
   against your shop's own address at checkout, so the defaults work if you create those pages.
   The success URL must keep `{ORDER_ID}` and `{ORDER_KEY}`: the success page needs both to find
   the order, and checkout refuses a success URL without them. A setting
   that is filled in but invalid (a currency that is not an ISO code, negative shipping, a
   ship-to entry that is not a 2-letter country code) stops checkout with a message saying
   which setting is wrong. Core does not guess a value.
4. In Stripe, add a webhook endpoint at
   `https://<your-site>/_emdash/api/plugins/<plugin-id>/stripe/webhook` and subscribe it to
   these events:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `refund.created`
   - `refund.updated`
   - `refund.failed`

   Optionally also `checkout.session.async_payment_succeeded` and
   `checkout.session.async_payment_failed`. They are harmless and Core handles them, but with card
   payments only they are rare.

   Paste its signing secret into the plugin settings. On Setup & health, the *Last verified
   webhook* check turns green after the first real test payment (or after you send any test event
   for a Core order); until then it is expected not to be green. Without the three refund events, refunds
   made in Stripe never show on the order. Refunds are recorded only: the order's stock is not
   returned, so use `set_stock` if the item came back.

   If you want buyers to get receipts, turn on Settings → Customer emails → "Successful payments"
   in Stripe; Core does not send receipts itself.

`<plugin-id>` is the id EmDash gave this install. For a registry install it is `r_` plus 16
characters, not the name `otta-core`. EmDash shows it in the address bar when you open the
plugin's settings (`/_emdash/admin/plugins-manager/<plugin-id>/settings`). A plugin listed
in your site's `sandboxed: [...]` config uses its configured id instead.

5. To manage orders from an AI assistant, turn on the plugin's MCP tools in the admin and create
   an API token with the `mcp:tools:<plugin-id>` scope. An `admin`-only token is refused.
   The tools are `list_orders`, `get_order`, `fulfil_order`, `resolve_order` and `set_stock`.

## Selling a product: the theme snippet

The full storefront kit (cart module, buy button, cart page, success page, product pages) and its
rules are in [`storefront/README.md`](./storefront/README.md). Copy `storefront/cart.js` to your
theme's `public/otta/cart.js`, then add a buy button. This is the kit's buy button:

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

- `PLUGIN_ID` is your install's id (see above). `PRODUCT_CONTENT_ID` is the product's
  `entry.data.id` in EmDash's Astro API (a ULID); `entry.id` is the slug and will not work.
- In an Astro page or component the script must be `is:inline`: otherwise Vite tries to bundle
  `/otta/cart.js` and refuses because it is inside `public/`.
- Show buyers `buyerMessage(out.code)`, never `out.message`: the server's text is for you, not
  for buyers.
- If you write your own checkout call instead of using `cart.js`, send the header
  `x-otta-checkout: 1` (the route refuses requests without it, which blocks other sites from
  starting checkouts) and follow the order-key rules in the storefront README.
- Coming back from Stripe and clicking Buy again reuses the same order and Checkout URL (no new
  stock hold). The success page calls `cart.done()` once the order is paid.

Core's routes return JSON, wrapped by EmDash as `{ "success": true, "data": … }`, and must be
called from your own pages (same origin). The cart lives in the browser; Core prices it on the
server. `GET availability?ids=a,b` returns price and sellable stock (capped at 10) for up to 8
products. The success page (`successUrl`) reads `GET order?id=…&key=…`; use the kit's success page.

## The orders page

The admin sidebar has an **Otta Core** folder with two Block Kit pages:

- **Orders**: newest first, filtered by status, 20 per page. Orders in `review` are flagged
  at the top and in the list. An order shows its items, amounts (discount, paid, refunded),
  email, shipping address, attention note and Stripe ids. A paid order can be marked
  fulfilled, with an optional tracking reference. An order in review can be released, or
  accepted as a sale when a payment is recorded on it. **Stock** shows on hand, held and
  available for each product and sets on hand. If a sale lands while you are editing, the
  change is refused and the form shows the new numbers. **Run resync** runs
  `resync_products` one step per click, with a *Continue* button until it is complete.
- **Setup & health**: checks the Stripe key (test or live, and whether Stripe accepts it),
  the webhook secret and the last verified webhook, synced products, the currency and the
  sweep. Each check shows PASS or the fix. It also lists this install's plugin id, the
  webhook URL, the five events and the buy-button snippet with your plugin id filled in.
  The *Shop address* it shows (recorded the first time you open the page, and used to resolve
  relative URLs) can be reset there if your site's address changes.
  **Open Setup & health once before your first checkout**: until the shop address is recorded
  (or your success and cancel URLs are absolute), checkout answers "This shop cannot take
  payments yet". Core never takes the address from a buyer's request, which could be forged.

If the buyer comes back from Stripe and changes their cart, the storefront kit releases
their earlier checkout at Pay (through Stripe, only once Stripe confirms it has expired), so
its reservation does not block the new one. A pending order that nobody pays for keeps its stock for up to about 47 minutes and is then
released automatically; no action is needed.

Every button calls the same routes as the MCP tools, so the page and the tools follow the
same rules.

## Repairing product data

Product data reaches Otta Core through content hooks. A hook that fails is dropped, and changing
the *Products collection* setting leaves the old products behind. The MCP tool `resync_products`
(private route `products/resync`) repairs both:
- it walks the products collection and applies each item's live state: published means on sale at
  its live data, anything else means off;
- then it takes off sale any product whose content no longer exists or is no longer published.

It uses the same code and rules as the hooks, so a resync never brings back an older price, never
re-lists an unpublished or deleted product, and never resets stock over sales. Each call stays
within the host's per-request budget and returns `nextPhase` / `nextCursor`: repeat until
`nextPhase` is `null`. It is safe to run at any time, and writes nothing when nothing needs
repair.

## Your data and privacy

**Export.** The `export_data` MCP tool (private route `data/export`) returns everything Core
stores, one kind at a time (`products`, `stock`, `orders`), as JSON pages of up to 100. Pass
`nextCursor` back until it is `null`. Orders never include the buyer's order key or the buyer
tag, and the key is masked in the stored success URL.

**What Core stores about buyers**

| Data | Kept |
|---|---|
| Email (typed at checkout, or the one Stripe collected) | with the order |
| Shipping name and address (from Stripe, if you collect one) | with the order |
| Items, amounts, discount, refunds, Stripe session and payment ids | with the order |
| The order key (the buyer's secret link to their order) | with the order |
| A salted hash of the buyer's network address, for the per-buyer limit | only while the checkout is open |

Core stores no raw IP addresses, no card data and no browsing data. Unpaid orders (expired or
canceled, nothing paid, no note) are deleted 90 days after their checkout ended. Paid orders are
kept, because they are your sales records.

**The order key** is in the link the buyer returns to after paying (in the part after `#`, which
browsers do not send to your server or to other sites). It lets whoever has the link **see** that
order's items, amounts and status, and nothing else: no email, no address, and it cannot change,
cancel, refund or re-open anything. It also appears in your own Stripe Dashboard and webhooks.

**Processors.** Payments and the payment page are Stripe's (stripe.com/privacy). Your site's host
(for example Cloudflare) processes the requests. Say both in your privacy policy, with how long
you keep orders.

**Erasure requests.** Core has no "delete buyer" action yet. Export the order for your records
and, if you must erase a buyer's details, ask the maintainers; an anonymise action is planned.

## Limits and abuse protection

Stock is held while the buyer pays, so nobody can pay for an item that has sold out. The
other side of that is that the checkout route is public and holds stock for every open
checkout, so Core bounds it with six limits: open checkouts, per buyer, recently created,
units per product, products per order and releases per buyer. The first four are plugin settings:

- *Refuse new checkouts while this many are awaiting payment* (default 100). Above it, new
  buyers get "try again in a few minutes" until checkouts are paid or expire.
- *Refuse a buyer with this many checkouts awaiting payment* (default 5), counted per buyer
  address: the full IPv4 address, or the /64 network for IPv6. Core stores a salted hash, never
  the address, and only while the checkout is open: it is cleared when the order is paid,
  expires or is canceled. Buyers who share one address (an office, a carrier's NAT) share
  this limit, so raise it if many of your buyers come from one network. When the host gives no public address (for example a server behind a proxy that
  does not pass the client's IP on), only the store-wide limit applies.
- *Refuse new checkouts once this many were started in the last 10 minutes* (default 300). This
  protects against scripted checkout floods, which start many checkouts quickly even if each is
  abandoned. Above it, buyers see "The shop is busy right now. Please try again in a few minutes."
  until the count falls back under the limit.
- *Most units of one product per order* (default 99). Lower it for scarce items.
- Up to 8 distinct products per order (fixed: 8 keeps a checkout within the host's per-request
  call budget with room to spare).
- Unpaid orders (expired or canceled) are deleted 90 days after their checkout ended. Paid
  orders and orders under review are never deleted.
- What the limits do not stop: a client with many IPv6 /64 networks (or many IPv4 addresses)
  passes the per-buyer limit and can fill the store-wide limits until its checkouts expire.
- A buyer's changed cart releases their earlier checkout (`checkout/release`), at most 3 times
  per 10 minutes per buyer address, so starting and releasing checkouts in a loop cannot fill
  the recently-created limit.
- Recommended, and strongly so before a public launch: one Cloudflare rate-limiting rule (Security → WAF → Rate limiting rules) on
  requests whose path ends in `/checkout` or `/order` under `/_emdash/api/plugins/`, for
  example 10 requests per minute per IP. (The `order` route asks Stripe while an order is
  still pending, at most once every 20 seconds per order.) Core's limits count per buyer inside
  the plugin; they do not throttle requests before they reach it.

- A held order keeps its stock while its Stripe Checkout Session is open (40 minutes). If the
  buyer doesn't pay, the hold is released once Stripe reports the session expired, which is
  at most about 47 minutes after checkout with the site's cron at 5 minutes.
- Free products (price 0) can be listed, but an order whose total is 0 is refused: Stripe
  Checkout cannot take a zero payment.
- One currency per store.

## Development

```bash
pnpm -C packages/core test        # vitest: real EmDash storage on SQLite
pnpm -C packages/core size        # emdash-plugin bundle (registry build + validation), then the size gate:
                                  # fails when backend.js is over 72 KiB or the bundle is over 128 KiB
```
