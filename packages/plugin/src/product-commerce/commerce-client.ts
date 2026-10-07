/**
 * The `CommerceClient` port (ADR-0002 §3 / plan §5): storefront routes and the
 * widget's save route depend on this INTERFACE, never on `fetch` directly.
 * `InProcessCommerceClient` (`src/commerce/in-process-commerce-client.ts`) is
 * now its only implementation — work order 02 folded the commerce service into
 * the plugin, and INC-D3a/D3b deleted the `ctx.http` adapter that used to be the
 * other one.
 *
 * ── WHY THE `*Wire` TYPES STAY (the INC-D3b call, to cost out at INC-D4) ──
 *
 * These interfaces, and the matching ones in `src/admin/*-surface.ts`, were
 * written to mirror the commerce service's JSON 1:1. That service is gone, so
 * nothing here mirrors anything over a network any more and the word "wire" is
 * HISTORICAL — it now just names the shape the plugin's own route handlers
 * return and the Block Kit renderers and storefront routes consume.
 *
 * They stay as they are. They are deliberately decoupled from the domain's
 * branded money (`Cents`) and its use-case result unions, and neither belongs in
 * presentation code: a Block Kit renderer that had to unwrap a branded scalar,
 * or a storefront route that had to narrow a domain result union, would be
 * carrying the domain's vocabulary into a layer whose job is to format strings.
 * The plugin's sandbox-cleanliness rule (no `@otta-sh/domain` import from these
 * modules) points the same way.
 *
 * INC-D4 should cost out only the NARROWER question: de-duplicating these
 * `*Wire` interfaces against the domain's READ MODELS, which are the shapes they
 * actually restate field-for-field. That is a real duplication with a real
 * maintenance cost, and it is a separate decision from "use domain types in the
 * plugin", which the paragraph above rejects. Nothing about it is required for
 * correctness today.
 */

export interface CommerceMoney {
	amount: number;
	currency: string;
}

export type CommerceProductKind = "physical" | "digital";

/** Every commercial field is optional — "create then price" (plan §1 case
 *  3): a bare content sync carries only the product_id. */
export interface UpsertProductCommerceInput {
	sku?: string;
	price?: CommerceMoney;
	/** The product title an ORDER LINE SNAPSHOTS at purchase time (service
	 *  schema: non-empty, ≤500 chars). Not a merchant-editable commerce field:
	 *  it is derived from the CMS CONTENT field `data.title` — em-dash's
	 *  `ContentItem` has NO top-level `title`; see `sync/hooks.ts`'s
	 *  `TITLE_FIELD` for the evidence — so the storefront heading and the order
	 *  line can never drift. A row whose title is NULL is UNPURCHASABLE
	 *  (`createOrderFromCart` rejects it with `PRODUCT_NOT_PRICED`). OMITTED —
	 *  never sent as `""` — when the content has no usable title, which the store
	 *  reads as "preserve whatever is already stored". */
	title?: string;
	taxClass?: string | null;
	weightGrams?: number | null;
	lengthMm?: number | null;
	widthMm?: number | null;
	heightMm?: number | null;
	productKind?: CommerceProductKind;
	/** Initial stock — a create-if-absent seed, never a restock path (plan §8
	 *  Risk 4). OPERATIONALLY: it lands ONLY on the save that first carries the
	 *  product's sku. Since PR 1a a sku-bearing save always seeds a row
	 *  (`initialOnHand ?? 0`), so a later save's figure hits `ON CONFLICT (sku)
	 *  DO NOTHING` and is silently discarded — by design, so the seed can never
	 *  clobber a live or already-decremented count. Stock after that first save
	 *  is the restock endpoint's job. */
	initialOnHand?: number;
	/** Sync-ordering watermark (review S1): the CMS content's `updatedAt`,
	 *  sent by `content:afterSave` syncs so the service rejects a
	 *  delayed/out-of-order OLDER save as a stale no-op. Panel saves omit it
	 *  (explicit merchant intent = last-writer-wins, documented). */
	contentUpdatedAt?: string;
}

export interface ProductCommerce {
	productId: string;
	sku: string | null;
	price: CommerceMoney | null;
	taxClass: string | null;
	weightGrams: number | null;
	lengthMm: number | null;
	widthMm: number | null;
	heightMm: number | null;
	productKind: CommerceProductKind;
	active: boolean;
	deletedAt: string | null;
	contentUpdatedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

// ── Phase 2: catalog batch read (plan §6) ────────────────────────────────
// Wire item for `POST /catalog/commerce/batch` — mirrors the service's
// ProductCommerceView DTO 1:1. Only ids that exist come back; missing ids
// are OMITTED, never per-id errors. `inStock` is the service's own
// single intra-DB join (§6 invariant — the plugin never makes a second
// inventory round trip). Branding (Cents/Currency) happens one layer up,
// at `catalog/commerce-view.ts`'s parse boundary.
export interface ProductCommerceBatchItem {
	productId: string;
	sku: string;
	price: CommerceMoney;
	/** The row's title cache — what an order line will snapshot. Null until a
	 *  sync has carried one. */
	title: string | null;
	/** The compare-at / was-price as stored, or null. Display-only; whether it
	 *  reads as a sale is the product view model's call. */
	compareAtPrice: CommerceMoney | null;
	inStock: boolean;
	/** The publish gate: the join derives purchasability from it
	 *  (`purchasable ⟺ present && active`). */
	active: boolean;
}
// ── end Phase 2 catalog batch read ───────────────────────────────────────

// ── Variants wire types ──────────────────────────────────────────────────
// The shape the plugin's own variant serialization returns. Money is an integer
// minor-unit amount + an ISO-4217 string, and ABSENT IS ABSENT: an unpriced size
// is `null`, never `0` and never a zero-amount object.

/** One sellable unit of a product, as the plugin serializes it. */
export interface ProductVariantWire {
	productId: string;
	/** The CMS repeater row's stable, IMMUTABLE key — the variant's identity
	 *  within its product. Never editable: neither write input carries a field
	 *  that could change it, so a re-key does not compile. */
	variantKey: string;
	/** Null until an admin sets one ("declare then price"). */
	sku: string | null;
	/** Null means ABSENT — a different fact from zero, and never rendered as
	 *  `0`, `0.00` or "Free". A resurrect clears a price whose currency the
	 *  product can no longer honour, which is how a live size ends up here. */
	price: CommerceMoney | null;
	/** The display name — a CACHE of the CMS repeater row's name sub-field, with
	 *  a single writer (`upsertProductVariant`). Eventually consistent. */
	title: string | null;
	/** The ORPHAN tombstone: non-null once the CMS stopped declaring this key.
	 *  The row keeps its sku, price and stock — deactivation, never deletion.
	 *
	 *  ALWAYS NULL ON `listProductVariants` as this client calls it: it sends no
	 *  internal token, so it receives the public projection, which is live rows
	 *  only. Rendering an orphan distinctly — it may hold stock and sit on live
	 *  orders — means asking the same route for the operator's projection, which
	 *  this client does not do. */
	orphanedAt: string | null;
	createdAt: string;
	/** The compare-and-set watermark an edit must pass back. */
	updatedAt: string;
}

/** A LIST row: the variant plus the coarse stock signal the same statement
 *  joined. The service deliberately does NOT publish the exact count on this
 *  read (it is storefront-reachable) — `inStock` is a stock signal, so a size
 *  whose stock is unknown reads `false`.
 *
 *  It is NOT purchasability on its own: it knows about the size's units and
 *  nothing about the row above it, so it reads `true` for a stocked size of an
 *  unpublished or soft-deleted product. Offer a size only when its PARENT's
 *  `active` says the product is — the same join the product level already
 *  makes (`purchasable ⟺ commerce !== null && commerce.active`). */
export interface ProductVariantSummaryWire extends ProductVariantWire {
	inStock: boolean;
}

/** The CMS-sync DECLARE's body — presence + the name cache, NOTHING
 *  commercial. `sku` and `price` are absent BY DESIGN (ADR-0016): a sync that
 *  could write them would be a second writer racing the admin. */
export interface UpsertProductVariantInput {
	/** `undefined` PRESERVES the stored cache; an explicit `null` CLEARS it. */
	title?: string | null;
	/** The CMS content's `updatedAt` — one ordering watermark for BOTH presence
	 *  transitions. A resurrect applies only on a STRICTLY NEWER value. */
	contentUpdatedAt?: string;
}

/** The ADMIN edit's body — the commerce-owned fields only. `title` is absent BY
 *  DESIGN: the console renders a variant's name as read-only text. */
export interface UpdateProductVariantFieldsInput {
	/** A DIFFERENT value than the row holds is a RENAME, which carries the sku's
	 *  on-hand count with it or refuses — never a silent stranding. */
	sku?: string;
	price?: CommerceMoney;
}

/**
 * The guarded edit's outcome. Every refusal is a VALUE, not a thrown error, so
 * a console renders all of them without branching on an HTTP status.
 *
 * EVERY OPERAND IS NULLABLE, and none of them has a default. The token is what a
 * caller branches on; the operands only sharpen the sentence it renders, and a
 * missing one means THE SERVICE DID NOT SAY — a different fact from any value
 * this client could invent. Both plausible defaults are actively harmful. A
 * `liveHolds` of `0` states that no holds exist, beside a refusal caused BY
 * holds — the one number the console's own rule forbids rendering there, and a
 * flat contradiction of the message it sits in. A `currentUpdatedAt` of `""`
 * re-submits as a watermark that cannot match, turning one recoverable stale
 * edit into a guaranteed second one. A null renders as "unavailable" and the
 * operator reloads; a fabricated value renders as a fact and the operator acts
 * on it.
 */
export type VariantUpdateResult =
	| { ok: true; variant: ProductVariantWire }
	/** Unknown key, or an ORPHANED row — an edit is neither a create nor a
	 *  resurrection; the way back is the CMS re-declaring the key. */
	| { ok: false; reason: "VARIANT_NOT_FOUND" }
	/** Someone else saved first. `currentUpdatedAt` is the watermark to reload
	 *  from and re-submit against — null when the service did not send one, which
	 *  means RELOAD THE ROW, never "re-submit an empty watermark". */
	| { ok: false; reason: "STALE_EDIT"; currentUpdatedAt: string | null }
	/** The price disagrees with the currency the variant, or its product, is
	 *  anchored to. `currency` is THE VARIANT'S OWN, and null when it has none
	 *  yet — the archetypal case, a first pricing refused against the PRODUCT's
	 *  currency. Null is "nothing yet", never "no conflict". */
	| { ok: false; reason: "CURRENCY_MISMATCH"; currency: string | null }
	/** Price must be > 0 — an absent price is expressed by omitting the field. */
	| { ok: false; reason: "INVALID_FIELD"; field: string | null }
	/** Another LIVE sellable unit — a product OR a variant — already holds it. */
	| { ok: false; reason: "SKU_TAKEN"; sku: string | null }
	/** A rename onto a sku that already has its own inventory row. Stock is never
	 *  merged between skus, so the operator decides. */
	| { ok: false; reason: "SKU_STOCK_CONFLICT"; fromSku: string | null; toSku: string | null }
	/** A rename away from a sku that still has live holds. Short-lived by
	 *  construction — a "try again shortly", not a dead end. `liveHolds` is null
	 *  when the count did not arrive; it is NEVER 0, because a zero beside this
	 *  refusal contradicts the refusal. */
	| { ok: false; reason: "SKU_HELD_STOCK"; sku: string | null; liveHolds: number | null };
// ── end variants wire types ──────────────────────────────────────────────

export interface CommerceClient {
	upsertProductCommerce(
		productId: string,
		input: UpsertProductCommerceInput,
		idempotencyKey: string,
	): Promise<ProductCommerce>;
	getProductCommerce(productId: string): Promise<ProductCommerce | null>;
	softDeleteProductCommerce(productId: string, idempotencyKey: string): Promise<void>;
	/** The afterPublish→activate follow-up (plan §6 step 7): mirrors
	 *  `POST /products/:id/commerce/activate` 1:1. Deliberately separate from
	 *  `upsertProductCommerce` — see the service route's doc for why `active`
	 *  is not an upsert field. `contentUpdatedAt` is the CMS content's
	 *  `updatedAt` at publish time — the ordering watermark the store gates on
	 *  so a stale, out-of-order publish is a no-op (convergence). */
	activateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;
	/** The afterUnpublish→deactivate follow-up (plan §6 step 7): the mirror of
	 *  `activateProductCommerce`, mirrors `POST /products/:id/commerce/deactivate`
	 *  1:1 — closes the publish gate so an unpublished product stops being
	 *  purchasable. `contentUpdatedAt` is the same ordering watermark. */
	deactivateProductCommerce(
		productId: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;

	// ── Phase 2: catalog batch read (plan §6) ─────────────────────────────
	// (A later Phase-3 task adds its cart methods below this block — keep
	// the delimiters so the diff surfaces stay additive.)
	getCommerceBatch(productIds: string[]): Promise<ProductCommerceBatchItem[]>;
	// ── end Phase 2 catalog batch read ────────────────────────────────────

	// ── Variants: one method per WRITER, never one per row ────────────────
	// Mirrors the service's `/products/:id/variants*` routes 1:1, and mirrors
	// the two-writer split those routes enforce (ADR-0016): the sync declares
	// presence + the display name, the admin sets sku + price, and neither
	// input type carries the other's fields — so crossing the line does not
	// compile here either, not merely 400 at the wire.
	/** LIVE variants only. The service serves this read in two projections off
	 *  one route — anonymous callers get live rows, a caller holding
	 *  `X-Internal-Token` gets every row with orphans flagged — and this client
	 *  is the STOREFRONT's, so it never sends that header and never receives a
	 *  tombstone (a discontinued size's name and last price are not public data).
	 *  A console that needs tombstones asks for the operator's projection. */
	listProductVariants(productId: string): Promise<ProductVariantSummaryWire[]>;
	/** The CMS-sync DECLARE. Brings a variant into existence, refreshes its
	 *  name cache, and RESURRECTS an orphan — it never refuses presence, so
	 *  there is no typed-failure envelope to normalize. */
	upsertProductVariant(
		productId: string,
		variantKey: string,
		input: UpsertProductVariantInput,
		idempotencyKey: string,
	): Promise<ProductVariantWire>;
	/** The guarded ADMIN edit. `expectedUpdatedAt` is the compare-and-set
	 *  watermark read off the row; every refusal is a typed result, never a
	 *  thrown transport error. */
	updateProductVariantFields(
		productId: string,
		variantKey: string,
		input: UpdateProductVariantFieldsInput,
		expectedUpdatedAt: string,
		idempotencyKey: string,
	): Promise<VariantUpdateResult>;
	/** The ORPHAN transition — deactivation, never deletion; an unknown key is
	 *  a no-op, so this resolves for a key that was never declared. */
	deactivateProductVariant(
		productId: string,
		variantKey: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;
	// ── end variants ──────────────────────────────────────────────────────

	// ── Phase 3 group E: cart (plan §6) ────────────────────────────────────
	// Hand-rolled like the wire types above: these modules declare no runtime
	// dependency on @otta-sh/domain, which is what keeps them sandbox-clean. ──
	createCart(currency?: string): Promise<{ cartId: string }>;
	/**
	 * The replacement for a SPENT cart — one checked out into an order that is no
	 * longer pending. The caller names only the spent cart; the key that makes this
	 * idempotent is derived server-side (`rotate:<cartId>`), so the same spent cart
	 * always gets the same new cart and racing requests converge. A caller never
	 * chooses a key. Cart ids are bearer secrets: a spent cart's id grants access to
	 * the cart that replaces it. Refused `CART_NOT_FOUND`, `CART_NOT_CHECKED_OUT`, or
	 * `ORDER_NOT_FINISHED` (no order, or one still pending — its payment may still
	 * happen).
	 */
	replaceCart(spentCartId: string): Promise<ReplaceCartResult>;
	/** The effective cart-hold window in whole minutes — the admin's saved
	 *  `holdTtlMinutes` (or its default), which every add/adjust stamps and every
	 *  read measures against (issue #127). For shopper-facing copy. */
	getCartHoldTtlMinutes(): Promise<number>;
	getCart(cartId: string): Promise<CartResult<{ cart: CartWire }>>;
	/**
	 * The storefront header's two facts, as cheaply as they can be known: the
	 * cart's state and unit count (ONE cart-document read — no hold expiry, no
	 * price join) and whether the session is live (ONE session-document read — no
	 * customer read, and never who). Either input absent or unusable ⇒ `null` /
	 * `false` without a read. Read-only.
	 */
	getShopperState(input: { cartId?: string; sessionToken?: string }): Promise<ShopperStateWire>;
	addCartLine(
		cartId: string,
		sku: string,
		/** The CMS content id (the join key to `product_commerce`) so the line can
		 *  be priced/quoted/ordered — issue #80. `null` for a bare (legacy) add that
		 *  has no product reference; the wire OMITS the field when null. */
		productId: string | null,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>>;
	adjustCartLine(
		cartId: string,
		lineId: string,
		qty: number,
		idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>>;
	removeCartLine(
		cartId: string,
		lineId: string,
		idempotencyKey: string,
	): Promise<CartResult<Record<string, never>>>;
	// ── end Phase 3 group E: cart ─────────────────────────────────────────

	// ── Phase 5: storefront customer account (plan §7) ────────────────────
	// The bearer session token is passed through from the plugin's first-party
	// cookie layer, never held by the sandboxed plugin itself. ─────────────
	/**
	 * Issue a login challenge and email the magic link. Always `{ ok: true }` —
	 * the answer must not say whether the account exists or the request was
	 * throttled. `verifyPageUrl` is the operator's configured sign-in page
	 * (`settings:loginLinkUrl`) — never the request's origin and never caller
	 * input (see `storefront/login-link.ts`). Absent ⇒ nothing is issued or sent.
	 */
	requestLoginLink(email: string, options?: { verifyPageUrl?: string }): Promise<{ ok: true }>;
	verifyLogin(challengeId: string, token: string): Promise<LoginVerifyResult>;
	logout(sessionToken: string): Promise<void>;
	listMyOrders(sessionToken: string): Promise<AuthedResult<{ orders: OrderSummaryWire[] }>>;
	getMyOrder(
		sessionToken: string,
		orderId: string,
	): Promise<
		{ ok: true; order: AccountOrderWire } | { ok: false; reason: "UNAUTHENTICATED" | "NOT_FOUND" }
	>;
	listMyAddresses(sessionToken: string): Promise<AuthedResult<{ addresses: AddressWire[] }>>;
	/**
	 * Who the session is: its customer's email, read server-side off the session
	 * (never caller-named). For a storefront that greets a signed-in shopper or
	 * prefills their checkout; an unusable bearer, or one whose customer is gone,
	 * is UNAUTHENTICATED.
	 */
	getMyAccount(sessionToken: string): Promise<AuthedResult<{ email: string }>>;
	// ── end Phase 5 customer account ──────────────────────────────────────

	// ── Delivery authorization (ADR-0011) ─────────────────────────────────
	/**
	 * Two scopes only, by PRESENCE: `scope.orderId` (the download link's
	 * unguessable order id — an open bearer capability, no auth header) or a
	 * logged-in customer's own `opts.sessionToken`. The plugin NEVER sends
	 * `buyerRef`: the raw-email scope is operator-only and its secret is one the
	 * sandbox does not and must not hold.
	 *
	 * NOT THE DOWNLOAD GATE. It answers only "is a grant active". Since issue
	 * #376 `entitlements/download-route.ts` no longer calls it: delivery also
	 * needs the order's state, the product's kind and its file, so that route
	 * reads the stores itself and keeps the whole gate in one place. This stays
	 * the bare entitlement read, pinned by the client contract.
	 */
	checkEntitlement(
		scope: { orderId?: string },
		sku: string,
		opts?: { sessionToken?: string },
	): Promise<AuthedResult<{ active: boolean }>>;
	// ── end delivery authorization ────────────────────────────────────────

	// ── Phase 4: checkout (quote → order → public order read) ─────────────
	// Every typed failure rides the same `{ ok: false, reason }` envelope
	// (adapter rule #2, "no status-code-as-logic"), so callers branch on
	// the token and never on an HTTP code.
	quoteCheckout(input: QuoteRequestWire): Promise<QuoteResult>;
	/** The `idempotencyKey` is the CALLER's — forwarded verbatim as
	 *  `Idempotency-Key`, never invented here (see `checkoutIdempotencyKey`:
	 *  it must be stable per cart, or a reload mints a second order).
	 *
	 *  `opts.sessionToken` — the shopper's session, when they are signed in. It
	 *  is a bearer like every other here: the customer is resolved FROM it, and
	 *  the order is theirs from birth only when `buyerRef` is that customer's own
	 *  email (ADR-0004, amended 2026-10-02). Any other email, or an unusable
	 *  session, places a guest order — a session never refuses a checkout. */
	createOrder(
		input: CheckoutRequestWire,
		idempotencyKey: string,
		opts?: { sessionToken?: string },
	): Promise<CheckoutResult>;
	/**
	 * The delivery options of the zone a quote MATCHED (ADR-0021), each priced
	 * for the cart. `zoneId` and `discountedSubtotalCents` come ONLY from this
	 * server's own `quoteCheckout` reply — never from route input: a caller that
	 * could name a zone could list (and so pick) another zone's options.
	 * Malformed input throws (`CommerceInputError`); an unknown zone is `[]`.
	 */
	listShippingOptions(input: ShippingOptionsRequestWire): Promise<ShippingOptionWire[]>;
	/** The unauthenticated capability read (ADR-0010 §2). Sends NO
	 *  `X-Internal-Token`: that header unlocks the full admin projection
	 *  (`serializeOrder`, incl. `buyerRef`/`shippingAddress`) on a page a guest
	 *  reads. The guest gets `serializePublicOrder`'s whitelist. */
	getPublicOrder(orderId: string): Promise<PublicOrderResult>;
	/**
	 * Resume a PENDING order's payment (QA U-2) — the order page's "Complete
	 * payment" on any device — from the order id PLUS a second factor (the
	 * order's cart, a session owning it, or its email). The id alone, the
	 * capability {@link getPublicOrder} reads with, is `PROOF_REQUIRED`.
	 *
	 * It replays the order's OWN checkout — its cart, its idempotency key, its
	 * buyer — so the reply is the same order and the provider is asked for the
	 * same intent under the same key: never a second order, never a second
	 * intent. Refused `ORDER_NOT_PAYABLE` unless the order is `pending` and
	 * strictly before its hold deadline (the pay page's own rule), and then
	 * nothing is asked of the provider at all.
	 *
	 * SECOND FACTOR (`proof`, see `commerce/resume-proof.ts`): the id alone is
	 * `PROOF_REQUIRED`. The cart the order was made from, a session whose customer
	 * owns it, or the order's email (trimmed, case-folded; a wrong one is
	 * `EMAIL_MISMATCH`, and guesses are `THROTTLED` per device of the order —
	 * `proof.clientKey` — and, at a higher cap, per order) unlocks it.
	 *
	 * The reply carries `buyerRefHint` (`j•••@g•••.com`), never the buyer
	 * reference: the order's email shown read-only, without handing the address
	 * to whoever holds the link.
	 */
	resumeOrderPayment(orderId: string, proof?: ResumeProof): Promise<ResumeOrderPaymentResult>;
	/**
	 * "Start a new cart" (QA2 X4): cancel the order this cart became, if that
	 * order is still UNPAID — so a payment still open for it in another tab can no
	 * longer go through, and its stock goes back on sale now rather than at the
	 * hold deadline. The cart id is the proof (the cookie, the same possession
	 * factor {@link resumeOrderPayment} accepts); nothing else is read from the
	 * caller.
	 *
	 * The plain cancel (`cancelOrder`, reason `customer_request`, by `shopper`):
	 * it releases the held stock and makes the order's PaymentIntent due for
	 * withdrawal at once. A payment that still lands is refunded at settle, like
	 * any payment on a cancelled unpaid order. Idempotent under a key derived from
	 * the order.
	 *
	 * A cart with no order, an unknown cart, or an order that is no longer
	 * `pending` (paid, expired, already cancelled) is a no-op success:
	 * `cancelled: false` — there is nothing in progress to clear.
	 */
	abandonCartOrder(cartId: string): Promise<AbandonCartOrderResult>;
	// ── end Phase 4 checkout ──────────────────────────────────────────────
}

// ── Phase 4: checkout wire types ───────────────────────────────────────────
// The request shapes the plugin's checkout routes accept and the
// quote/checkout/public-order shapes they return. Money is integer minor units
// + an ISO-4217 string, never a float.

export interface QuoteRequestWire {
	cartId: string;
	/**
	 * Where the order ships: an ISO 3166-1 alpha-2 country and an optional ISO
	 * 3166-2 region code (`CA` or `US-CA`). The shipping/tax zone is DERIVED
	 * from it (ADR-0021); there is deliberately no zone field — nobody chooses
	 * their own tax zone.
	 */
	destination?: DestinationRequestWire;
	shippingMethodId?: string;
	couponCode?: string;
}

export interface DestinationRequestWire {
	country: string;
	region?: string;
	/** For a tax calculator that prices by address (ADR-0030); zones ignore it. */
	postalCode?: string;
	city?: string;
}

/** How the quote resolved the zone. `matched` names the zone (an opaque
 *  merchant config id, never buyer data) and the code that matched it. */
export interface QuoteDestinationWire {
	status: "not_required" | "no_zones" | "address_needed" | "matched";
	zoneId: string | null;
	/** `US-CA` or `US` — the code the zone matched on. */
	matchedRegion: string | null;
}

export interface ShippingOptionsRequestWire {
	zoneId: string;
	currency: string;
	discountedSubtotalCents: number;
}

/** One delivery option. `amountCents: null` ⇒ no rate in the cart's
 *  currency: it cannot be chosen. */
export interface ShippingOptionWire {
	methodId: string;
	name: string;
	type: "flat_rate" | "free_shipping";
	amountCents: number | null;
}

export interface QuoteBreakdownWire {
	currency: string;
	subtotalCents: number;
	discountCents: number;
	shippingCents: number;
	taxCents: number;
	totalCents: number;
	appliedCouponCode: string | null;
}

/** The quote rejections: the cart pre-checks run before `computeQuote`, plus
 *  the domain `QuoteFailure`'s own union. */
export type QuoteFailureReason =
	| "CART_NOT_FOUND"
	| "CART_EMPTY"
	| "PRODUCT_NOT_PRICED"
	| "CURRENCY_MISMATCH"
	| "COUPON_NOT_FOUND"
	// ADR-0021: the destination and the zone derived from it.
	| "INVALID_SHIPPING_ADDRESS"
	| "SHIPPING_REGION_CODE_REQUIRED"
	| "SHIPPING_ZONE_NOT_MATCHED"
	| "MISSING_SHIPPING_ADDRESS"
	| "SHIPPING_METHOD_NOT_FOUND"
	| "SHIPPING_METHOD_NOT_IN_ZONE"
	| "SHIPPING_METHOD_NOT_APPLICABLE"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_CURRENCY_MISMATCH"
	/** ADR-0030: the site's outside tax calculator could not answer. */
	| "TAX_UNAVAILABLE";

export type QuoteResult =
	| {
			ok: true;
			breakdown: QuoteBreakdownWire;
			/** Whether any line ships. A digital-only cart needs no address. */
			requiresShipping: boolean;
			destination: QuoteDestinationWire;
			/** `subtotal − discount` — what a delivery option's free-shipping
			 *  threshold is measured against (`listShippingOptions`). */
			discountedSubtotalCents: number;
	  }
	| { ok: false; reason: QuoteFailureReason };

/** ADR-0009's optional ship-to snapshot — bounds mirror `shippingAddressBody`. */
export interface ShippingAddressWire {
	name: string;
	line1: string;
	line2?: string;
	city: string;
	region?: string;
	postalCode: string;
	country: string;
	email?: string;
	phone?: string;
}

export interface CheckoutRequestWire {
	cartId: string;
	paymentMethod: "stripe" | "x402";
	/** Email/session claim token (ADR-0004). Stored VERBATIM by the service —
	 *  the site trims but never lowercases it. */
	buyerRef: string;
	// No zone: it is derived from `shippingAddress` (ADR-0021).
	shippingMethodId?: string;
	couponCode?: string;
	/** Required for a cart that ships, in a store with zones. The country is an
	 *  ISO alpha-2 code and a region an ISO 3166-2 code, on EVERY order. */
	shippingAddress?: ShippingAddressWire;
}

/** The domain's `ClientAction` verbatim — passed through unmodified; the
 *  plugin never inspects a client secret beyond handing it to the theme. */
export type ClientActionWire =
	| { kind: "stripe_client_secret"; clientSecret: string }
	| { kind: "x402_challenge"; accepts: string[]; price: number; payTo: string }
	| { kind: "none" };

export interface PaymentIntentWire {
	gateway: string;
	intentId: string;
	clientAction: ClientActionWire;
}

/** `serializePublicOrder`'s whitelist (`orders.ts`) — deliberately WITHOUT
 *  `buyerRef`/`customerId`/`shippingAddress`/reconciliation fields, which the
 *  service omits entirely (never as null) so a client cannot probe the shape. */
export interface PublicOrderWire {
	id: string;
	state: string;
	currency: string;
	paymentMethod: string | null;
	holdExpiresAt: string;
	createdAt: string;
	/** `shippingZoneId` / `shippingMethodId` are read off the order's shipping
	 *  snapshot: opaque merchant config ids, never buyer data. They are the only
	 *  evidence on the wire of WHAT the totals were priced with — the method
	 *  decides whether shipping was calculated, the zone whether tax was. */
	totals: QuoteBreakdownWire & { shippingZoneId: string | null; shippingMethodId: string | null };
	lines: OrderLineWire[];
	fulfillment: {
		carrier: string;
		trackingNumber: string;
		trackingUrl: string | null;
		shippedAt: string;
	} | null;
	cancellation: { reason: string; cancelledAt: string } | null;
	/**
	 * Money on a DEAD order, for the buyer's own page: `none` (nothing captured, or
	 * the order is live / was paid), `refunded` (a payment arrived after the order
	 * expired or was cancelled, and was refunded in full), `refund_pending`
	 * (captured and not yet refunded). It is what lets the page stop saying
	 * "Nothing was charged" when something was. A derived status only — never an
	 * amount, a provider ref or the reconciliation detail behind it.
	 */
	latePayment: "none" | "refunded" | "refund_pending";
	/**
	 * Money the order's refunds LEDGER shows returned — RECORDED refunds only, in
	 * the order's minor units; `0` when none (QA2 X3). The confirmation page says
	 * "Refunded $X" from it. A refund made outside Otta ("Mark refunded",
	 * ADR-0026) has no ledger row and is not counted: the page then states the
	 * status and invents no amount. Read off the same ledger read as `latePayment`.
	 */
	refundedCents: number;
}

/** `CreateOrderFailure` verbatim (`@otta-sh/domain`'s orders/errors.ts). */
export type CheckoutFailureReason =
	| "CART_NOT_FOUND"
	| "CART_EMPTY"
	| "CART_CHECKED_OUT"
	| "RESERVATION_LOST"
	| "PRODUCT_NOT_PRICED"
	| "CURRENCY_MISMATCH"
	| "INVALID_SHIPPING_ADDRESS"
	| "PAYMENT_INTENT_FAILED"
	/** A same-key intent request is still in flight (a double-submitted
	 *  checkout): not a failure — the place route answers it as BUSY. */
	| "PAYMENT_INTENT_IN_FLIGHT"
	/** The idempotency key already names an order of ANOTHER cart (issue #133):
	 *  a stale/second checkout tab. Nothing was placed; the cart is untouched. */
	| "IDEMPOTENCY_KEY_REUSED"
	| "MISSING_SHIPPING_ADDRESS"
	| "SHIPPING_ZONE_NOT_MATCHED"
	| "SHIPPING_REGION_CODE_REQUIRED"
	| "SHIPPING_METHOD_NOT_FOUND"
	| "SHIPPING_METHOD_NOT_IN_ZONE"
	| "SHIPPING_METHOD_REQUIRED"
	| "SHIPPING_METHOD_NOT_APPLICABLE"
	| "SHIPPING_RATE_NOT_FOUND"
	| "COUPON_NOT_FOUND"
	| "COUPON_NOT_ACTIVE"
	| "COUPON_MIN_SUBTOTAL"
	| "COUPON_EXHAUSTED"
	| "COUPON_MAX_PER_CUSTOMER"
	| "COUPON_CURRENCY_MISMATCH"
	/** ADR-0030: the outside tax calculator could not answer; nothing was placed. */
	| "TAX_UNAVAILABLE";

/**
 * NOTE the asymmetry, deliberate and load-bearing: `POST /checkout/orders`
 * answers with the FULL `serializeOrder` projection (it is a machine-to-machine
 * write behind the service token), which is a SUPERSET of `PublicOrderWire` —
 * it also carries `buyerRef`, `customerId` and the ship-to snapshot. Typing it
 * as the public shape is what keeps those fields un-referenceable here: the
 * checkout route projects only `id`/`state` out of this reply and NEVER
 * forwards the body, so nothing private can reach a storefront page by
 * accident. The guest-facing read (`getPublicOrder`) genuinely receives only
 * the whitelist.
 */
export type CheckoutResult =
	| {
			ok: true;
			order: PublicOrderWire;
			intent: PaymentIntentWire;
			/** The ORDER's email, masked (`j•••@g•••.com`) — never the address. A
			 *  same-key replay (a second checkout tab) answers with the order the
			 *  first tab placed, which keeps the email IT was placed with (QA2 X2). */
			buyerRefHint: string;
			/** Whether that email is the one this request carried (trimmed,
			 *  case-folded). `false` only on a replay placed with another email:
			 *  the site must say so rather than send the shopper on to pay. */
			buyerRefMatches: boolean;
	  }
	| { ok: false; reason: CheckoutFailureReason };

export type PublicOrderResult =
	| { ok: true; order: PublicOrderWire }
	| { ok: false; reason: "ORDER_NOT_FOUND" };

/** The second factor beside an order id for {@link CommerceClient.resumeOrderPayment}
 *  (`commerce/resume-proof.ts`). Any one that holds is enough. */
export interface ResumeProof {
	/** The cart cookie's id — proof when it is the cart the order was made from. */
	cartId?: string;
	/** A session — proof when its customer owns the order. */
	sessionToken?: string;
	/** The order's email, typed again. */
	email?: string;
	/**
	 * Not a proof: the opaque per-browser id the site keeps for resuming (its
	 * resume cookie), so email guesses are throttled per device of an order as
	 * well as per order (issue #364). Absent, the request shares the order's
	 * window for requests that name no device.
	 */
	clientKey?: string;
}

/** {@link CommerceClient.abandonCartOrder}'s reply: did THIS call cancel the
 *  cart's order (and which order the cart names, if any). */
export type AbandonCartOrderResult = { ok: true; cancelled: boolean; orderId: string | null };

/** {@link CommerceClient.resumeOrderPayment}'s reply. */
export type ResumeOrderPaymentResult =
	| { ok: true; order: PublicOrderWire; intent: PaymentIntentWire; buyerRefHint: string }
	| {
			ok: false;
			reason:
				| "ORDER_NOT_FOUND"
				| "ORDER_NOT_PAYABLE"
				| "PROOF_REQUIRED"
				| "EMAIL_MISMATCH"
				| "THROTTLED"
				| CheckoutFailureReason;
	  };
// ── end Phase 4 checkout wire types ────────────────────────────────────────

// ── Phase 5: customer account wire types (plan §7) ─────────────────────────
// The order / customer / address shapes the account routes return. Money is
// integer minor units + ISO-4217 string, never a float.
export interface OrderTotalsWire {
	currency: string;
	subtotalCents: number;
	discountCents: number;
	shippingCents: number;
	taxCents: number;
	totalCents: number;
}

export interface OrderLineWire {
	sku: string;
	title: string;
	unitPriceCents: number;
	currency: string;
	quantity: number;
	fulfillmentKind: string;
}

export interface OrderSummaryWire {
	id: string;
	state: string;
	currency: string;
	paymentMethod: string | null;
	holdExpiresAt: string;
	/** When the order was placed (ISO-8601) — the account list dates its rows by it. */
	createdAt: string;
	/**
	 * The figures, plus the same evidence the public order wire carries of WHAT
	 * they were priced with: the coupon, and the shipping snapshot's zone and
	 * method ids (`orderTotalsFlags` reads these — a method means shipping was
	 * calculated, a zone means tax was). Without them an account page can only
	 * print `$0.00` where the order page honestly says "Not calculated".
	 */
	totals: OrderTotalsWire & {
		appliedCouponCode: string | null;
		shippingZoneId: string | null;
		shippingMethodId: string | null;
	};
	lines: OrderLineWire[];
}

/**
 * One of the customer's orders, read on its own: the summary plus the late-payment
 * status the public order wire carries ({@link PublicOrderWire.latePayment}), so
 * the account's order page says what the public order page says about money on a
 * dead order. Only the single read carries it — deriving it needs the order's
 * ledgers, which the list does not read.
 */
export interface AccountOrderWire extends OrderSummaryWire {
	latePayment: PublicOrderWire["latePayment"];
	/** The tracking, as the public order read trims it (QA2 X1). */
	fulfillment: PublicOrderWire["fulfillment"];
	/** Where the order is going — the ship-to snapshot without its contact
	 *  fields, or `null` when none was taken (QA2 X1). The OWNER's read only: the
	 *  public order read never carries it. */
	shippingAddress: AccountOrderAddressWire | null;
	/** Money the order's ledger shows refunded (RECORDED refunds only), in the
	 *  order's minor units — `0` when none. A refund made outside Otta ("Mark
	 *  refunded", ADR-0026) is not on the ledger and is not counted. */
	refundedCents: number;
}

/** An order's ship-to as its owner's account page shows it. */
export interface AccountOrderAddressWire {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
}

export interface AddressWire {
	id: string;
	kind: string;
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	region: string | null;
	postalCode: string;
	country: string;
	isDefault: boolean;
}

export type LoginVerifyResult =
	| { ok: true; sessionToken: string; expiresAt: string }
	| { ok: false; reason: "EXPIRED" | "INVALID" | "CONSUMED" };

/** A `/me/*` result: the success payload, or an unauthenticated (401) signal the
 *  account route turns into a redirect to the login page. */
export type AuthedResult<T> = ({ ok: true } & T) | { ok: false; reason: "UNAUTHENTICATED" };
// ── end Phase 5 customer account wire types ────────────────────────────────

// ── Phase 3 group E: cart wire types (plan §6) ─────────────────────────────
// The cart serialization: NO price field on a line (a cart line snapshots no
// price — domain `CartStore`'s own
// documented invariant; the live price is read from `product_commerce`
// elsewhere, at display/checkout, never stored on the line).
export interface CartLineWire {
	lineId: string;
	sku: string;
	productId: string | null;
	qty: number;
	reservationId: string | null;
	expiresAt: string | null;
}

/** {@link CommerceClient.getShopperState}'s answer. `cart.count` is the sum of
 *  line quantities as stored (`0` for an empty cart); `cart` is `null` for no
 *  cart id, an unusable one, or a cart that does not exist. */
export interface ShopperStateWire {
	cart: { state: string; count: number } | null;
	signedIn: boolean;
}

/** `replaceCart`'s answer: the new cart, or why the named cart cannot be replaced. */
export type ReplaceCartResult =
	| { ok: true; cartId: string }
	| { ok: false; reason: "CART_NOT_FOUND" | "CART_NOT_CHECKED_OUT" | "ORDER_NOT_FINISHED" };

export interface CartWire {
	cartId: string;
	state: string;
	/**
	 * The order this cart handed off to (issue #132); null while it is `active`.
	 *
	 * REQUIRED, never optional: an optional field would let TypeScript's own
	 * narrowing bless a bare `!== null` on a value that can still arrive
	 * `undefined`. `InProcessCommerceClient`'s `serializeCart` copies the domain
	 * `Cart.orderId`, which is itself `OrderId | null` and never absent, so the
	 * declaration is honest at runtime and not merely by assertion.
	 *
	 * Not a payment signal (it is stamped before the payment intent), and a null
	 * does NOT prove that no order exists for the cart.
	 */
	orderId: string | null;
	currency: string;
	lines: CartLineWire[];
}

/**
 * Typed cart-mutation failures — SEMANTIC TOKENS, never English (matches
 * Phase 2's `AvailabilityToken` pattern): the domain `CartFailure` union
 * verbatim. Adapter-architecture rule #2, "no status-code-as-logic": every one
 * of these rides the same uniform `{ ok: false; reason }` value, so callers
 * branch on the token and there is no status to reach for even where the route
 * layer picks one.
 */
export type CartFailureReason =
	| "OUT_OF_STOCK"
	| "CART_NOT_FOUND"
	| "LINE_NOT_FOUND"
	| "CART_CHECKED_OUT"
	| "LINE_CHECKED_OUT"
	| "HOLD_EXPIRED"
	// A route-level (not domain-`CartFailure`) reject: the add's `sku` and
	// `productId` disagree with the trusted catalog (issue #80 review). The
	// service returns it as a 409 typed envelope; `#cartResult` normalizes it
	// like any other typed cart failure.
	//
	// Since the add endpoint's SKU guard the token covers the whole of "this sku
	// does not name a live sellable unit of that product": an unknown or
	// soft-deleted product, a sku belonging to a different product, and a sku
	// whose variant the CMS has since orphaned. The caller's response is the same
	// in every case — do not re-derive which one it was, the service deliberately
	// does not say.
	| "SKU_MISMATCH"
	// The second route-level reject from the same guard: the sku DOES name a live
	// sellable unit of the product, and nothing has priced it — a variant whose
	// price a resurrect cleared is exactly this state. The same token the quote
	// and checkout paths already use, raised earlier so a shopper is told at the
	// Add button rather than at the last step.
	| "PRODUCT_NOT_PRICED";

export type CartResult<T> = ({ ok: true } & T) | { ok: false; reason: CartFailureReason };
// ── end Phase 3 group E: cart wire types ───────────────────────────────────

/** Structured failure — status + parsed body, so callers can distinguish
 *  e.g. a 400 `MISSING_PRODUCT_ID` reject from a 503/network failure
 *  (afterSave must treat the latter as fire-and-forget, plan §4). */
export class CommerceClientError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(`commerce service request failed with status ${status}`);
		this.name = "CommerceClientError";
		this.status = status;
		this.body = body;
	}
}
