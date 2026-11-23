# Otta Core: registry listing (draft)

**Name:** Otta Core

**Summary (one line):** Sell products from your EmDash content through Stripe Checkout, holding stock while each buyer pays.

<!-- 129 characters -->

## What it does

Otta Core turns published entries in a content collection (`products` by default) into things you
can sell. A visitor's cart lives in their browser; at checkout Core prices it on the server, holds
the stock, and sends the buyer to Stripe's hosted Checkout page. When Stripe confirms payment,
the order is marked paid.

- Prices and stock come from your content fields (`title`, `price`, optional `sku` and `stock`).
- **Stock is held while the buyer pays**, so two buyers cannot both pay for the last item.
  Holds are released if the buyer abandons the checkout. In the rare case that Stripe takes a
  payment after its checkout expired, the sale is recorded and flagged for you, and it can take
  stock below zero.
- Orders are idempotent: a retried checkout never creates a second order or a second hold.
- Flat shipping amount and a list of ship-to countries, set in the plugin settings. Shipping is
  entered in minor units (`500` = $5.00), while product prices are in major units (`19.99`).
- A storefront kit (cart module, buy button, cart page, success page) to paste into your theme.
- Built-in limits: open checkouts, open checkouts per buyer, checkouts started recently, units of
  one product per order, and up to 8 products per order.

## Requirements

- **EmDash 1.5 or later.**
- **Cloudflare Workers Paid.** Registry plugins run in Worker Loaders, which need the paid plan.
- `EMDASH_ENCRYPTION_KEY` set on the site, so EmDash can store your Stripe keys. Generate it with
  `npx emdash secrets generate` and keep it: with a wrong or changed value EmDash cannot read the
  saved keys and disables the plugin.
- A Stripe account, and a cron trigger on the site running every 5 minutes or faster.
- Permissions you approve at install: read content, and network access to `api.stripe.com`.

## What it doesn't do

- **Card payments through Stripe Checkout only.** No other payment providers or methods you add
  yourself. Buyers may see Link, Apple Pay and Google Pay, and Link's bank and pay-later options
  ("Bank", "Klarna (powered by Link)"); all of them settle immediately as card payments, which
  is why stock holds stay safe. Core refuses to send a buyer to a checkout that offers a delayed
  payment method.
- **Two admin pages, not a whole admin.** *Orders* (list, detail, fulfil, resolve, set stock) and
  *Setup & health*. Settings use the form EmDash generates. Every action is also an MCP tool
  for an AI assistant.
- Discount codes only through Stripe promotion codes (an opt-in setting); no coupon rules of its own.
- No variants, tax calculation (the price you set is the price charged), shipping rules
  (one flat amount), customer accounts, digital downloads or reports.
- One currency per store, up to 8 distinct products per order.
- A registry plugin cannot ship pages, so you add the storefront snippets to your own theme.

## Full Otta

Full Otta, the npm edition, has variants, coupons, tax and shipping rules, customer accounts, digital
downloads, reports and an admin. If you outgrow Core, the plan is for upgrading to be an import of
your products, stock, settings and orders. **That importer does not exist yet**, so do not choose Core
today on the assumption that you can move across later.

## Setup in 6 steps

1. Install Otta Core from the registry and approve its permissions.
2. Create a `products` collection (in the admin form turn **Routable** on with URL pattern
   `/products/{slug}`; Drafts and Revisions are optional, and with drafts on, edits go live when you
   publish) and add the fields: `title` (Short Text; collections have no
   built-in title) and `price` (Number, in major units, such as 19.99), both marked Required
   (recommended), and optionally `sku` (Short Text) and `stock` (Integer; leave empty for unlimited). `stock` is a starting value: after
   sales the live count is on Orders → Stock. Publish your products.
3. Open the plugin's settings and enter your Stripe secret key, currency, flat shipping (in minor
   units: `500` = $5.00, unlike the price), *Ship to (2-letter country codes, comma separated)*
   (empty means no shipping address is collected, so set it if you ship physical goods) and the
   success and cancel page URLs. The defaults are
   relative and work once you create those pages; the success URL must keep `{ORDER_ID}` and
   `{ORDER_KEY}` (checkout refuses one without them).
4. Optional but recommended: in Stripe, add a webhook. The *Setup & health* page shows the exact
   URL and the five events to subscribe (`checkout.session.completed`, `checkout.session.expired`,
   `refund.created`, `refund.updated`, `refund.failed`; optionally also
   `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`, which
   are harmless and rare with card payments); paste its signing secret into the settings. Without a webhook, payments are still recorded within about 5 minutes, and refunds
   made in Stripe are not shown on orders.
5. Open **Otta Core > Setup & health** once: it records your shop's address (checkout refuses
   relative return URLs until then) and shows any setting still to fix.
6. Add the storefront kit to your theme: a buy button or cart page, and a success page. Then make a
   test purchase with a Stripe test key.

## FAQ

**Can customers pay with something other than a card?** Not in the sense of slower methods. Core uses
Stripe Checkout for card payments only. Buyers may see Link, Apple Pay and Google Pay, and Link's
bank and pay-later options, but all of them settle immediately as card payments.

**Where do I see and manage orders?** In the plugin's *Orders* page in the EmDash admin. Payments
and refunds are made in the Stripe dashboard. An AI assistant can do the same through the
plugin's MCP tools, with an API token scoped to them.

**Can two people buy the last item?** No. Stock is held for the buyer while they pay. An abandoned
checkout releases its hold once Stripe reports the session expired, up to about 47 minutes later.

**Does it calculate tax?** No. Stripe Tax is not used. The price you set is the price charged, plus the
flat shipping amount (set in minor units: `500` = $5.00).

**Is the checkout protected from abuse?** Core has six limits: open checkouts, open checkouts per
buyer, checkouts started in the last 10 minutes, units of one product per order, 8 products per
order, and 3 checkout releases per buyer per 10 minutes. A client with many network addresses can
still fill the store-wide limits, and the limits do not throttle requests, so before a public launch add a Cloudflare rate-limiting rule for its
checkout and order routes.

**Can I move to full Otta later?** That is the intention, as an import, but the importer has not
been built yet. There is no promised date.

**Does it work without Workers Paid or on EmDash 1.4?** No. A checkout of 8 products needs more
host calls than earlier EmDash versions allow.
