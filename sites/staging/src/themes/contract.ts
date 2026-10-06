/**
 * The theme contract — what a page hands a theme, and what a theme must provide.
 *
 * ADR-0003 still holds (the plugin serves view models, the theme owns every
 * byte of markup); this file is the seam INSIDE the site between the page,
 * which owns every decision, and the theme, which owns only presentation.
 *
 * THE RULE THE MODELS ENCODE: a model is the page's finished answer. Every
 * value a view prints is already computed — the BUSY copy, the hold note, the
 * sold-out flag, the return path, the idempotency key. A view never reads
 * `Astro.url`, a cookie, a cart id, `Astro.response` or an error token, and
 * never imports `lib/otta-api`, `origin-guard`, `cart-cookie` or
 * `checkout-cookie`. `themes-boundary.test.ts` sweeps `src/themes/**` for
 * exactly that, so a second theme cannot quietly grow a second copy of the
 * store's logic.
 *
 * Money arrives pre-formatted (docs/theme/TEMPERED.md §7): no model carries an
 * amount a view could format.
 */
import type {
	AvailabilityToken,
	CheckoutAmountView,
	CheckoutSummaryView,
	PublicOrderView,
} from "@otta-sh/plugin";
import type { CountryOption } from "../lib/countries.js";
import type { TapeRow } from "../lib/tape.js";
import type { SumRow } from "../lib/totals.js";
import type { ThemeId } from "./manifest.js";

export type { ThemeId } from "./manifest.js";

// ── Chrome ────────────────────────────────────────────────────────────────

export interface ChromeNavItem {
	label: string;
	url: string;
	/** This item is the cart — the one that carries the count badge. */
	isCart: boolean;
}

/** Everything a theme's Layout renders around a page. Built by Storefront.astro. */
export interface ChromeModel {
	/** The store's name, CMS-owned; "Otta" when unset or unreadable. */
	siteTitle: string;
	/** The document <title>. */
	fullTitle: string;
	description: string | null;
	/** The primary menu, Account link already appended. */
	navItems: readonly ChromeNavItem[];
	/** Units in the cart, or `null` for "no count to draw" — no cart read on this
	 *  page, no cart cookie, or an empty or unreadable cart. */
	cartCount: number | null;
	/** The spoken form of `cartCount` ("3 items"), `null` exactly when it is. */
	cartCountLabel: string | null;
	/** The currency CODE the page quoted, or `null` when it quoted none (§7). */
	currency: string | null;
	/**
	 * `true` only when this request carried a session the plugin still honours
	 * (asked for a theme that opts into `shopperState`); `false` for signed out or
	 * not known. The nav's own Account entry is already relabelled for it ("Your
	 * account"); a theme may also style on it. Never the email.
	 */
	signedIn: boolean;
	themeId: ThemeId;
	/**
	 * The cart's LINES, for a chrome that draws them outside `/cart` (a drawer,
	 * a strip).
	 * `null` unless the active theme opts in ({@link ThemeChromeNeeds}) AND this
	 * page is one the bag is drawn on — never on the checkout flow (`/cart`,
	 * `/checkout`, `/checkout/pay`, `/orders/<id>`), which is its own summary.
	 */
	bag: BagModel | null;
}

/**
 * One line of the chrome's bag. Same honesty rules as the cart page's line
 * ({@link CartLineModel}), whose composition it reuses: money is the live
 * join's `formatted` or honest prose, the name falls back to the SKU.
 */
export interface BagLineModel {
	lineId: string;
	sku: string;
	qty: number;
	/** The display name, or `null` when this store cannot name the line. */
	title: string | null;
	/** What a screen reader calls the line — the title, else the SKU. Never null. */
	name: string;
	image: string | null;
	/** Keys the generated art. */
	artKey: string;
	/** The line total, or its honest prose ("Priced at checkout"). */
	money: string;
	/**
	 * The line's hold as STATIC wall-clock copy — there is no countdown script
	 * outside `/cart` (ADR-0012). `null` when the line took no reservation.
	 */
	hold: { state: "held" | "expiring" | "released"; text: string } | null;
	/**
	 * The wire line's own `expiresAt`, verbatim (as `CartLineModel.line` carries
	 * it) — for a chrome that states ONE hold for the whole bag (a bag
	 * strip: the one that runs out first) and so must compare them. Rendered only
	 * as static wall-clock copy (`lib/hold.ts`'s `wallClock`), never counted.
	 */
	expiresAt: string | null;
	/** One fresh key per rendered form: the update form (both steppers) and remove. */
	updateKey: string;
	removeKey: string;
}

export interface BagModel {
	/**
	 * `lines` — draw them; `empty` — no cart or no lines; `checkedOut` — the cart
	 * became an order (issue #110: its lines are the order's now); `unreadable`
	 * — the read failed or answered BUSY. The chrome FAILS SOFT on the last one:
	 * the page still renders, and the bag offers the way to `/cart` instead.
	 */
	state: "lines" | "empty" | "checkedOut" | "unreadable";
	/** Units — the badge's number. `null` unless `state` is `lines` or `empty`. */
	count: number | null;
	lines: readonly BagLineModel[];
	/** The subtotal (live join) or its prose — never a figure the store did not quote. */
	subtotal: string | null;
	/** Some line carries no figure, so the subtotal is short of it. */
	partial: boolean;
}

// ── Home ──────────────────────────────────────────────────────────────────

export interface HomeModel {
	/** The hero headline (the store's tagline, or its fallback). */
	thesis: string;
	lede: string;
	shopHref: string;
	/** "Shop all 3 items" / "Shop everything" — never a count the page cannot prove. */
	shopLabel: string;
	/** The inventory tape. Empty ⇒ the hero renders thesis-only (the degraded rule). */
	rows: readonly TapeRow[];
	/** The exact catalog size, or `null` when the page cannot state one. */
	count: number | null;
	/**
	 * The fetched window as catalog cards, in catalog order — for a theme whose
	 * home leads with cards rather than a tape (Tempered's home does not read
	 * it). Same shape and same honesty rules as the shop's
	 * cards. Same degraded rule as `rows`: empty exactly when `rows` is (either
	 * read failed, or answered BUSY), so no theme can show a card the tape
	 * would omit; each home then renders its hero alone.
	 */
	cards: readonly ShopCard[];
	/** A one-line notice the page decided on ("You're signed out." after sign-out,
	 *  QA2 A5), or `null`. */
	notice: string | null;
}

// ── Shop ──────────────────────────────────────────────────────────────────

export interface ShopCard {
	href: string;
	/** Keys the coil art — the slug, or the id when there is none. */
	slug: string;
	title: string;
	description: string | null;
	image: string | null;
	/** Pre-formatted price, or `null` for "no figure to show". */
	price: string | null;
	/** What stands where a price would; `undefined` takes the component default. */
	priceNote: string | undefined;
	/**
	 * The compare-at ("was") price, pre-formatted — present only when the
	 * product is on sale (the plugin's `compareAtPrice`, already decided to be
	 * above the price) AND `price` is present. A view strikes it beside `price`.
	 */
	was: string | null;
	availability: AvailabilityToken | null;
}

export interface NoticeCopy {
	lead: string;
}

export interface ShopModel {
	/**
	 * `unavailable` — the CONTENT store could not be read (not the empty shop);
	 * `empty` — the catalog genuinely has no products;
	 * `list` — cards to render.
	 */
	state: "unavailable" | "empty" | "list";
	/** Commerce degraded while content rendered: the notice above the grid. */
	degradedNotice: NoticeCopy | null;
	/** The eyebrow ("3 items"), `null` when the count is not exact. */
	countLabel: string | null;
	cards: readonly ShopCard[];
	/** Where an operator of an empty store goes next. */
	adminHref: string;
}

// ── Product ───────────────────────────────────────────────────────────────

/** The hidden-field contract `/cart/add` reads — see src/forms/AddToCartFields.astro. */
export interface AddToCartModel {
	sku: string;
	productId: string;
	/** The plugin's, minted per rendered PDP. Never minted by a theme. */
	idempotencyKey: string;
	/** Where the cart sends the shopper back to on an error. */
	returnTo: string;
}

export interface ProductPurchase {
	/** Pre-formatted, off `price.formatted`. */
	priceFormatted: string;
	/** The compare-at ("was") price, pre-formatted, when the product is on sale
	 *  — off the view model's `compareAtPrice`, which is null unless it is above
	 *  the price. A view strikes it beside `priceFormatted`. */
	compareAtFormatted: string | null;
	/** Strike the price: not in stock (degraded is never "purchasable"). */
	priceStruck: boolean;
	availability: AvailabilityToken | null;
	sku: string | null;
	/** The add-to-cart form — present only for a product actually in stock. */
	addToCart: AddToCartModel | null;
	/** The effective cart-hold window, in minutes, as the route reported it. */
	cartHoldMinutes: number | undefined;
	/** The sentence stating that window. */
	holdNote: string;
	/** The explicit `out_of_stock` token — offers the way on. */
	soldOut: boolean;
}

export interface ProductContentModel {
	state: "ok";
	title: string;
	description: string | null;
	/** Keys the coil art (the product's own slug or id). */
	art: string;
	image: string | null;
	/** Dims the art: the explicit sold-out token, never `!inStock`. */
	dimmed: boolean;
	/** Commerce degraded — the notice lead (BUSY copy already chosen), else `null`. */
	degradedLead: string | null;
	/** A cart error carried back on the URL, already mapped to shopper copy. */
	errorMessage: string | null;
	/** The way out that error offers (CART_CHECKED_OUT: the cart page), linked
	 *  beside `errorMessage`; `null` when it offers none. The page decides it. */
	errorAction: { href: string; label: string } | null;
	/** Priced and sellable: the ledger and buy row. `null` otherwise. */
	purchase: ProductPurchase | null;
	/** Neither purchasable nor degraded: say so in prose. */
	showNotForSale: boolean;
}

export type ProductModel =
	| ProductContentModel
	/** The address resolves to nothing (404). */
	| { state: "notFound" }
	/** The content store could not be read (503). */
	| { state: "unavailable" };

// ── Commerce views (Phase 3) ──────────────────────────────────────────────
//
// The cart, the checkout, the pay step, the confirmation and the account pages.
// Same rule as above: the PAGE reads the cookie, dispatches the route, maps
// BUSY, sets the status and every error token to copy; the model is its
// finished answer. Where the plugin already serves a view model (ADR-0003 — the
// checkout summary, the public order) the model carries it untouched rather
// than re-shaping it, so a theme reads the same fields the plugin documents.
//
// Money is never formatted here: every figure is the plugin's `formatted`
// string, a `CheckoutAmountView`, or prose the page chose.

/** One row of a receipt/ledger — `components/Ledger.astro`'s `LedgerRow`. */
export interface LedgerLine {
	sku: string;
	qty: number;
	/** The line's name: the purchase-time snapshot on a receipt, the title the
	 *  order will snapshot on the review (`CheckoutLineView.title`, the commerce
	 *  row's copy). `/cart` names lines from its own CMS read instead, so right
	 *  after a rename the two pages can briefly disagree — the review shows what
	 *  the order will record. Absent when the store cannot name it. */
	title?: string;
	/** `lineTotal.formatted`, or the honest prose — never assembled. */
	money: string;
}

/**
 * THE HOLD COUNTDOWN'S MARKUP CONTRACT (ADR-0012's one client script).
 *
 * `/cart` renders `components/HoldClock.astro` — the ONLY script a storefront
 * page may carry besides Stripe's, and a PAGE renders it, never a view (the
 * fence in `checkout-client-js.test.ts` walks the registry, so a scripted
 * component imported by any view would put the script on every page). A cart
 * view draws its own countdown however it likes, from these hooks, and the one
 * script keeps them current:
 *
 *  - `[data-hold]` on the ribbon's root, with `data-expires` (the line's
 *    `expiresAt`, verbatim) and `data-window` (the hold TTL in seconds). The
 *    script rewrites `data-state` (`held` | `expiring` | `released`) on it.
 *  - optional children: `[data-hold-label]` (state words), `[data-hold-clock]`
 *    (`mm:ss`; ship the ABSOLUTE expiry as the no-JS value), `[data-hold-fill]`
 *    (gets `--pct`, the share of the window left), `[data-hold-note]` (unhidden
 *    once released) and `[data-hold-announce]` (a polite live region, written
 *    only on a state change).
 *  - for the time in WORDS rather than a clock: `[data-hold-minutes]` and
 *    `[data-hold-seconds]` get the whole minutes / seconds left (floored), and
 *    a root that ships `data-minutes` has it kept current — opt-in, so a
 *    stylesheet can switch copy at a minute boundary (e.g. under five minutes,
 *    "Check out soon"). Ship the server's first frame in each.
 *
 * `components/HoldRibbon.astro` is Tempered's rendering of exactly this, with
 * the server-side first frame (`lib/hold.ts`'s `holdView`) already in it. Any
 * other page that shows a hold shows STATIC wall-clock copy ("Held for you
 * until 4:52 pm") — there is no script there to count.
 */
export interface CartLineModel {
	/** The wire line's own fields a view may print or post. */
	line: { lineId: string; sku: string; qty: number; expiresAt: string | null };
	/** The display name, or `null` when this store cannot name the line. */
	title: string | null;
	/** What a screen reader calls the line — the title, else the SKU. Never null. */
	name: string;
	image: string | null;
	/** Keys the coil art. */
	artKey: string;
	/**
	 * The product's own page (`lib/products.ts`'s `productPath`), or `null` when
	 * this store cannot name the line — for a view that links a line back to its
	 * object (e.g. a bag whose picture carries the product's view-transition
	 * name back to the product page).
	 */
	href: string | null;
	/** The line total, or its honest prose ("Priced at checkout"). */
	money: string;
	/** "$6.00 each", only when it says something the line total does not. */
	each: string | null;
	/** One fresh idempotency key per rendered form (a double-submit replays). */
	updateKey: string;
	removeKey: string;
}

export interface CartModel {
	/** "3 items" — UNITS, the badge's number. `null` for an empty/unread cart. */
	summary: string | null;
	/** A `?error=` token, already mapped to shopper copy. */
	errorMessage: string | null;
	/** The cart could not be READ (not an empty cart). */
	degraded: boolean;
	/** The degraded banner's lead — the BUSY copy when the read was refused. */
	degradedLead: string;
	/** The live cart's pricing join is down: the "Totals are unavailable" banner. */
	pricingNotice: boolean;
	/** No cart, or a cart with no lines. */
	empty: boolean;
	/** Checked out (issue #110): a record of what left, not a workspace. */
	terminal: boolean;
	/** The order a terminal cart became, when the cart names one. */
	placedOrderId: string | null;
	lineViews: readonly CartLineModel[];
	sumRows: SumRow[];
	totalAmount: CheckoutAmountView;
	/** §7's footnote for a partial total. */
	partialNote: string | null;
}

/** The order a review is locked to (it has already been created). */
export interface CheckoutLockedModel {
	id: string;
	/** The way on for a locked, payable order: the page-owned resume path
	 *  (QA U-2) — a link, never a form re-asking for the email the order keeps. */
	resumeHref: string;
	/** Place found this order already placed — by another tab — with another
	 *  email: the sentence naming its (masked) address, or `null` (QA2 X2). */
	otherEmailNotice: string | null;
}

export interface CheckoutModel {
	/** The plugin's checkout view model, untouched (ADR-0003). */
	summary: CheckoutSummaryView;
	errorMessage: string | null;
	/** `?error=CART_CHECKED_OUT`: the dead-cart trap's exit is offered. */
	checkedOut: boolean;
	/** The cart has become an order: the review is locked to it. */
	locked: CheckoutLockedModel | null;
	/** That order can no longer be paid: no place form at all. */
	ended: boolean;
	/** The coupon field's value (a refused code comes back to be fixed). */
	couponValue: string;
	/** That refused code, when the field holds one — echoed so Enter with it
	 *  unchanged does not apply it again. `null` otherwise. */
	refusedCouponCode: string | null;
	/** Refusal copy, already mapped: coupon, destination, delivery method. */
	couponError: string | null;
	destinationError: string | null;
	shippingError: string | null;
	/** "There are no delivery options for this address." */
	noOptionsCopy: string;
	/** The destination the totals were priced for. */
	destination: { country: string; region: string | null } | null;
	/** `destination.country` in the site locale's words. */
	destinationName: string | null;
	countryValue: string;
	regionValue: string;
	countries: readonly CountryOption[];
	showDelivery: boolean;
	showAddress: boolean;
	/** The method the totals were priced with, stated beside the submit. */
	chosenOption: { label: string; price: string } | null;
	/** Why the place button is not offered yet. */
	notReadyCopy: string;
	/** A publishable key is baked into this build (no key ⇒ no order). */
	paymentConfigured: boolean;
	/** STRIPE_NOT_CONFIGURED's copy, quoted. */
	notConfiguredLead: string;
	/** The email field's initial value: what the buyer typed before a refused
	 *  place (QA U-1), else the signed-in account's address, else "". */
	emailValue: string;
	/** The address fields' initial values — what the buyer typed before a
	 *  refused place, else "" (QA U-1). */
	addressValues: Record<
		"name" | "line1" | "line2" | "city" | "postalCode" | "country" | "region" | "phone",
		string
	>;
	/** Copy for the fields a refused place identified, keyed by field name — a
	 *  view prints each beside its field (QA U-1). */
	fieldErrors: Partial<
		Record<
			"email" | "name" | "line1" | "line2" | "city" | "postalCode" | "country" | "region" | "phone",
			string
		>
	>;
	/** The hint under the email field — the page's copy (`checkoutEmailNote`). */
	emailNote: string;
	ledgerRows: LedgerLine[];
	sumRows: SumRow[];
	/** Why the total is incomplete, when it is. */
	footnote: string | null;
}

/**
 * The pay step's SURROUNDINGS. The Stripe mount, the pay button and the one
 * script stay in `pages/checkout/pay.astro` (ADR-0012 decision 2) and reach the
 * view as the `payment` slot, which a pay view renders exactly once.
 */
export interface PayModel {
	paymentConfigured: boolean;
	notConfiguredLead: string;
	/** Where "View your order" goes. */
	orderPath: string;
	/**
	 * The email the order was placed with, as a hint (`j•••@g•••.com`) — shown
	 * READ-ONLY on a resumed payment (QA U-2), where the order keeps its email
	 * and nothing on this step can change it. `null` when the stash carries none.
	 */
	emailHint: string | null;
	/**
	 * How long the order is still reserved (QA U-14): `lead` ("Your order is
	 * reserved for 12 more minutes") and `until` ("2:32 pm UTC", with its zone)
	 * for a `<time datetime={iso}>`. `null` when the page could not read the
	 * order (it renders the form anyway — pay-guard.ts's fail-open).
	 */
	holdNote: { lead: string; until: string; iso: string } | null;
}

export interface OrderStampCopy {
	/** The largest type on the page. */
	headline: string;
	body: string | null;
}

export interface OrderModel {
	/** The plugin's public order view, or `null` (not found, unreadable, BUSY). */
	order: PublicOrderView | null;
	/** What the page is willing to say about the order's state — `null` ⇔ no order. */
	stamp: OrderStampCopy | null;
	/**
	 * What the order IS, in the shopper's words — its products (`orderLabel`:
	 * "Otta Tee and 2 more"), never its id. `null` ⇔ no order. `order` above
	 * still carries the id (the plugin's view model, untouched — ADR-0003); a
	 * view prints this instead.
	 */
	orderLabel: string | null;
	/** The failure copy for the no-order arm (BUSY / not found / unavailable). */
	failureMessage: string;
	/**
	 * Where the checkout tracker stands (`orderProgress`): Payment is completed
	 * only for an order that was paid; an expired or failed order is `halted` at
	 * Payment; `null` ⇒ draw no tracker (a cancelled order may or may not have
	 * been paid first).
	 */
	progress: { current: "payment" | "order"; halted: boolean } | null;
	/** The bounded poll is running (the page emits the same-URL refresh) — only
	 *  while a change is expected: the buyer just came back from Stripe. */
	shouldPoll: boolean;
	/** Which hop of the poll this render is (1-based), and of how many. */
	pollHop: number;
	pollMax: number;
	/** "Check again"'s href: `""`, this very URL, so a check REPLACES the history
	 *  entry instead of adding one (and the redirect parameters are never echoed). */
	nextPollUrl: string;
	hasActions: boolean;
	canCheckAgain: boolean;
	/**
	 * "Complete payment"'s target — the page-owned resume path
	 * (`/checkout/resume?order=…`, QA U-2), which works on any device. `null` ⇔
	 * the order cannot be resumed (not pending, past its hold, or just back from
	 * Stripe). A view links to this and never invents a path of its own.
	 */
	resumeHref: string | null;
	/** Why the last "Complete payment" did not reach the pay page, when the page
	 *  knows (a payment that could not be started) — copy, already mapped. */
	resumeError: string | null;
	deadEnd: boolean;
	ledgerRows: LedgerLine[];
	sumRows: SumRow[];
	/** "Paid" once the money was captured (refunded included), else "Total". */
	totalLabel: string;
	/** "Refunded $20.00" — what the order's refunds ledger shows returned, as its
	 *  own line under the total (QA2 X3); `null` when the ledger shows none (a
	 *  refund made outside Otta included: the status alone says it). */
	refundedNote: string | null;
	/** The sign-in page. The page owns the path; a theme only links to it. For a
	 *  shopper who is not signed in as this order's owner: the sign-in link joins
	 *  the order to the list of the email it was placed with. */
	accountSignInHref: string;
	/** Your orders — non-null ONLY when the shopper is signed in as this order's
	 *  owner (the page asked the plugin), so the view links straight to the list
	 *  instead of to sign-in. `null` ⇒ use `accountSignInHref`. */
	accountOrdersHref: string | null;
}

export interface AccountLoginModel {
	/** Signed in already: who, where their orders are, and the way to sign in as
	 *  another address (`switchHref`). `null` ⇔ signed out. */
	signedIn: { email: string; ordersHref: string; switchHref: string } | null;
	/** Show the sign-in form: signed out, or signed in and asking to use a
	 *  different email (QA2 A6) — never a bare form under "You're signed in". */
	showForm: boolean;
	/** `?sent=1` or `?sent=many`: a link was asked for. */
	sent: boolean;
	/** The notice's copy, the page's call: the generic sentence, the same for
	 *  every address — or, once THIS BROWSER has asked more often than the
	 *  per-address cap allows, the sentence saying a new link may not have been
	 *  sent. Never decided by the address, so never an account oracle. */
	sentCopy: string;
	errorMessage: string | null;
}

export interface AccountVerifyModel {
	/** Both halves of the link are present: offer the confirm POST. */
	usable: boolean;
	/** Rendered ONLY into the two hidden inputs the confirm form needs. */
	challenge: string;
	token: string;
	invalidMessage: string;
}

/**
 * One order in the signed-in list. It carries NO id: the row is named by its
 * products (`label`) and the id lives only inside `href`, so a view has nothing
 * to print but the label — a shopper is never shown the order UUID.
 */
export interface AccountOrderRow {
	/** The order's products (`orderLabel`), the link text. */
	label: string;
	href: string;
	/** The order's status in words (`accountOrderStatus`) — what the order page
	 *  says about it, list-sized: never "Awaiting payment" for an order that can
	 *  no longer be paid. */
	state: string;
	/** When it was placed ("Oct 2, 2026, 14:05 UTC") and the instant for `<time>`;
	 *  `null` when the date is unreadable. Rows arrive newest first. */
	placed: { text: string; iso: string } | null;
	/** "1 item" / "3 items". */
	items: string;
	total: string;
}

export interface AccountOrdersModel {
	/** Non-null ⇔ the list could not be read (BUSY or unavailable copy). */
	errorMessage: string | null;
	rows: readonly AccountOrderRow[];
	/** The signed-in email, named on the page (it is private); `null` when the
	 *  page could not ask. */
	signedInAs: string | null;
}

export interface AccountOrderModel {
	/** `null` ⇔ not found / unreadable; `errorMessage` then says which. */
	order: {
		/** The order's products (`orderLabel`) — the heading. No id: see `AccountOrderRow`. */
		label: string;
		/** Status in words, as in the list (`accountOrderStatus`). */
		state: string;
		/** What the order page says about this state (`orderStamp`'s body — e.g.
		 *  whether anything was charged on an expired order), or `null`. */
		stateNote: string | null;
		placed: { text: string; iso: string } | null;
		ledgerRows: LedgerLine[];
		/** The order page's own rows (`orderSumRows`): "Not calculated" where the
		 *  order was never priced for shipping or tax, never $0.00. */
		sumRows: SumRow[];
		total: CheckoutAmountView;
		/** "Paid" / "Total" (the domain's `orderTotalLabel`), as on the order page. */
		totalLabel: string;
		/** "Refunded $5.00" — what the order's ledger shows refunded, as its own line
		 *  under the total; `null` when the ledger shows none. */
		refundedNote: string | null;
		/** The plugin's `totalExcludesUncalculated` — the Sum footnote's switch. */
		excludesUncalculated: boolean;
		/** "Complete payment" — the page-owned resume path, for a pending order
		 *  that can still be paid; `null` otherwise (QA2 X1). */
		payHref: string | null;
		/** The order's own public page. */
		orderPageHref: string;
		/** Carrier and tracking once shipped; `trackingUrl` only when it is an
		 *  http(s) address. */
		tracking: { carrier: string; trackingNumber: string; trackingUrl: string | null } | null;
		/** Where it is going, as display lines; `null` when no address was taken. */
		addressLines: string[] | null;
		/** "Delivery address", or "Billing address" for an order that ships nothing. */
		addressLabel: "Delivery address" | "Billing address";
	} | null;
	errorMessage: string;
	/** The signed-in email, named on the page; `null` when unknown. */
	signedInAs: string | null;
}

// ── Theme module ──────────────────────────────────────────────────────────

/**
 * An Astro component as a registry holds it. `.astro` default exports are
 * typed by the Astro toolchain; the registry only needs "callable with these
 * props", so that is all this states.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Astro's own component factory type
export type AstroComponent<P> = (props: P) => any;

export interface ThemeViews {
	home: AstroComponent<{ model: HomeModel }>;
	shop: AstroComponent<{ model: ShopModel }>;
	product: AstroComponent<{ model: ProductModel }>;
	cart: AstroComponent<{ model: CartModel }>;
	checkout: AstroComponent<{ model: CheckoutModel }>;
	/** Renders the page's `payment` slot (the Stripe mount) exactly once. */
	pay: AstroComponent<{ model: PayModel }>;
	order: AstroComponent<{ model: OrderModel }>;
	accountLogin: AstroComponent<{ model: AccountLoginModel }>;
	accountVerify: AstroComponent<{ model: AccountVerifyModel }>;
	accountOrders: AstroComponent<{ model: AccountOrdersModel }>;
	accountOrder: AstroComponent<{ model: AccountOrderModel }>;
}

/**
 * What a theme's CHROME asks the shell for, beyond the defaults — opt-in, so
 * no theme makes every page pay for a read only one theme draws.
 *
 * `cartLines`: this theme's chrome shows the cart's LINES outside `/cart` (a
 * drawer, a strip), not just the count. The shell (`layouts/Storefront.astro`)
 * then makes ONE guarded cart read (`lib/bag.ts`) on the pages that draw the
 * bag, and hands it over as `ChromeModel.bag` — no other theme pays it. It
 * fails soft (an unreadable or BUSY read is `state: "unreadable"`, never an
 * error page or a 503), skips the checkout flow, and states holds as STATIC
 * wall-clock copy — the countdown script is `/cart`'s alone.
 */
export interface ThemeChromeNeeds {
	cartLines?: boolean;
	/**
	 * This theme's chrome shows the SHOPPER'S STATE on every storefront page: the
	 * cart's count beside the cart link, and whether they are signed in (QA U-12,
	 * U-14). The shell then makes ONE dispatch of the lean `storefront/shopper-state`
	 * route (`lib/chrome-state.ts`: at most a cart-document and a session-document
	 * read) for whichever of the cart and session cookies the request carries —
	 * none without either — and hands over `ChromeModel.cartCount` (no badge for an
	 * empty cart, on every page) and `ChromeModel.signedIn`. The middleware keeps every such page private,
	 * no-store and out of the route cache. Both reads fail soft and skip the
	 * pay page (`/checkout/pay`); `/cart` passes its own count.
	 */
	shopperState?: boolean;
}

export interface ThemeModule {
	id: ThemeId;
	/** Owns <html>, <head> (its own fonts + stylesheet) and the chrome. */
	Layout: AstroComponent<{ chrome: ChromeModel }>;
	/** Partial: an unported view falls back to Tempered's, in THIS theme's tokens. */
	views: Partial<ThemeViews>;
	/** Opt-in chrome capabilities — see {@link ThemeChromeNeeds}. */
	chrome?: ThemeChromeNeeds;
}
