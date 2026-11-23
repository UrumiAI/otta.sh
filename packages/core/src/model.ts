/**
 * OTTA CORE CONTRACT (frozen; only the money-path owner edits this file).
 *
 * Otta Core keeps its own small document set, not full Otta's. An upgrade to
 * full Otta is an IMPORT (products, stock, settings, order history) through
 * full Otta's own stores, so only full Otta's code writes full Otta's
 * invariants. Every document carries `v` (schema version); the future
 * importer's fixtures are generated from the shapes in this file.
 *
 * Money is integer minor units of `currency` (ISO 4217, upper case).
 * Timestamps are ISO-8601 UTC strings.
 *
 * There is NO server cart: the cart lives in the browser and place-order
 * receives the lines and prices them server-side.
 */

export const SCHEMA_VERSION = 1 as const;

/**
 * 8, not 10: place-order is 2n + 9 bridge calls, and at 8 lines that is 25 of
 * the sandbox's 30, which leaves room for two lost CAS rounds under contention.
 * Can rise once a deployed site shows the real headroom.
 */
export const MAX_LINES = 8;
export const MAX_QTY = 99;

// ── Documents ───────────────────────────────────────────────────────────────

/** `products`, id = the EmDash content id. Written only by the product sync hooks. */
export interface ProductDoc {
	v: typeof SCHEMA_VERSION;
	productId: string;
	title: string;
	sku: string | null;
	/** Minor units of `currency`; null when the content has no valid price. */
	price: number | null;
	currency: string;
	/** Published, priced and not deleted. Only active products can be bought. */
	active: boolean;
	/** False when the content has no `stock` field: unlimited, never reserved. */
	trackStock: boolean;
	/**
	 * The content updatedAt of the last event applied (publish, save, unpublish,
	 * delete). Older events lose, so a delayed hook can never roll back a price
	 * or re-activate an unpublished product. Writes are CAS-guarded.
	 */
	contentAt: string | null;
	/**
	 * Taken off sale by resync because its content was not found (deleted, or the
	 * products-collection setting named another collection). The time is NOT moved
	 * forward, and live content at the same or a later time puts it back on sale,
	 * so a resync can undo its own deactivation once the setting is fixed.
	 */
	orphaned?: boolean;
	/** Informational copy of StockDoc.contentStock (the decision lives on the stock document). */
	appliedContentStock: number | null;
	updatedAt: string;
}

/**
 * `stock`, id = productId. Every write is ONE compareAndSet carrying guard,
 * movement and record together (ADR-0019 L1: a decrement is idempotent only
 * because the row records who applied it).
 */
export interface StockDoc {
	v: typeof SCHEMA_VERSION;
	productId: string;
	/**
	 * PHYSICAL units not yet sold, holds INCLUDED. A reserve only adds a hold;
	 * a commit (the sale) takes the units off onHand. So "set stock to 10"
	 * (content `stock` field or MCP set_stock) means 10 physical units, and with
	 * 2 held, 8 are sellable. The content field is compared with `contentStock`
	 * below (same document, same CAS), never with onHand, so editing a title
	 * can never reset live stock.
	 */
	onHand: number;
	/** Live holds by order id. Available = onHand - sum(holds). */
	holds: Record<string, number>;
	/**
	 * UNHELD sales only (a payment that landed after its holds were released),
	 * by order id. Never evicted; normal sales are guarded by their hold.
	 */
	sold: Record<string, number>;
	/** The content `stock` value last applied, and the content updatedAt it came from. */
	contentStock: number | null;
	contentAt: string | null;
	/** Release tombstones (`<order>:x`) and one-off set keys, newest last (bounded ring). */
	applied: string[];
	updatedAt: string;
}

export type OrderStatus =
	/** Stripe Checkout Session open, stock held. */
	| "pending"
	| "paid"
	| "fulfilled"
	/**
	 * Stripe captured money that does not match the order (amount or currency,
	 * L5). Nothing is settled: stock stays held, a person decides.
	 */
	| "review"
	/** Stripe confirmed the session expired; stock released. */
	| "expired"
	/** Checkout could not start (no stock, Stripe refused). Nothing held. */
	| "canceled";

/**
 * Where the order's stock completion stands. Every `*ing` value is a promise
 * the sweep keeps if a request dies half way; `stockPending` indexes them.
 * Completion is deterministic from `status` (L3) and replayable by anyone.
 */
export type StockState =
	| "reserving"
	| "held"
	| "committing"
	| "committed"
	| "releasing"
	| "released";

/**
 * The stock document id for a line: `productId` for a product without
 * variants, `productId:variantId` for a variant. Product ids cannot contain ":"
 * (they are validated as [A-Za-z0-9_-]), so the two can never collide, and
 * adding variants later migrates nothing.
 */
export const stockId = (i: { productId: string; variantId: string | null }): string =>
	i.variantId === null ? i.productId : `${i.productId}:${i.variantId}`;

export interface OrderItem {
	productId: string;
	/**
	 * RESERVED for variants (size, colour): always null in this version. A line is
	 * one product-variant pair; its stock lives at `stockId(item)`.
	 */
	variantId: string | null;
	sku: string | null;
	title: string;
	unitPrice: number;
	qty: number;
	trackStock: boolean;
}

/**
 * `orders`, id = the checkout key the client mints per submission
 * (`ord_` + 32 lowercase hex). Idempotency IS the document id (L2): a replayed
 * place-order reads the same document.
 */
export interface OrderDoc {
	v: typeof SCHEMA_VERSION;
	/** Secret for the buyer's order-status lookup (32 hex). */
	orderKey: string;
	status: OrderStatus;
	stock: StockState;
	/** 1 while `stock` is a `*ing` state, else 0 (an indexed sweep flag). */
	stockPending: 0 | 1;
	items: OrderItem[];
	currency: string;
	subtotal: number;
	shipping: number;
	total: number;
	createdAt: string;
	updatedAt: string;
	/** When the Stripe Checkout Session expires (set at creation). */
	expiresAt: string;
	stripeSessionId: string | null;
	checkoutUrl: string | null;
	paymentIntentId: string | null;
	paidAt: string | null;
	amountPaid: number | null;
	/** Stripe's discount (total_details.amount_discount) once paid; null before. */
	discount: number | null;
	/**
	 * Refunded so far (pending or succeeded refunds), re-read from Stripe on every
	 * refund event; null = never refunded. Recording only: stock is not returned
	 * (the merchant decides, with set_stock).
	 */
	refundedAmount: number | null;
	/**
	 * Each refund Stripe reported, by refund id. A failed or canceled refund is
	 * final (terminal) and never counts again; merging per refund makes the total
	 * independent of the order events and reads arrive in.
	 */
	refunds: Record<string, { amount: number; terminal: boolean }> | null;
	/**
	 * Snapshot of the promotion-codes setting when the order was created: what
	 * Stripe was told, so the amount check (L5) uses the same rules on every path
	 * however the setting changes later.
	 */
	promoCodes: boolean;
	email: string | null;
	shippingAddress: Record<string, unknown> | null;
	/** Needs a person (amount mismatch, oversold, paid on a non-pending order). */
	attention: string | null;
	/** Paid after its holds were released: the sale is taken from on-hand (StockDoc.sold). */
	unheldSale: boolean;
	/** Snapshotted at creation so every Stripe retry sends identical parameters. */
	successUrl: string;
	cancelUrl: string;
	shippingCountries: string[];
	/**
	 * What the key was first used for: the normalised lines and email. A replay
	 * of the key with anything else is refused (KEY_REUSED), never advanced: one
	 * key is one purchase.
	 */
	request: string;
	/**
	 * 1 while the order is pending or still has stock work to finish (it may hold
	 * stock); 0 otherwise. Derived on every write (orders.ts withOpen); the
	 * open-checkouts cap counts it, so a canceled order still releasing counts.
	 */
	open: 0 | 1;
	/**
	 * 1 when the order may be pruned once old enough: expired or canceled, stock
	 * fully released, no payment recorded and no note. Derived on every write
	 * (orders.ts withOpen) and indexed, so the prune query only ever sees orders it
	 * may delete: orders kept forever can never block it.
	 */
	prunable: 0 | 1;
	/**
	 * Who placed it, for the per-buyer cap: HMAC-SHA256 of the buyer's address keyed by
	 * a random per-install salt, 16 hex characters. Never the address itself. null
	 * when the host gave no public address, the install has no salt, or the order
	 * is no longer open (cleared with `open`).
	 */
	ipTag: string | null;
	/** This install's store tag (util.storeTag), fixed at creation; a session must carry it to settle the order. */
	store: string;
	fulfilledAt: string | null;
	tracking: string | null;
	cancelReason: string | null;
}

// ── Storage declaration (manifest `storage`) ───────────────────────────────

export const COLLECTIONS = {
	products: { indexes: ["productId", "active", "sku"] },
	stock: { indexes: [] as string[] },
	orders: {
		indexes: [
			"status",
			"createdAt",
			"stripeSessionId",
			"stockPending",
			"open",
			["open", "ipTag"],
			["prunable", "expiresAt"],
			"paymentIntentId",
			["status", "expiresAt"],
		],
	},
} as const;

// Settings: src/settings.ts (and the manifest's settingsSchema, pinned by
// test/manifest-drift.test.ts). Routes, hooks and the cron: src/plugin.ts, which
// is the one list (each route's header comment gives its input and bridge cost).
//  plugin:install / plugin:activate -> schedule cron "sweep" every 5 minutes
//  cron "sweep" -> finish stockPending orders; expire past-due sessions via Stripe

/** A failure a caller can act on. Routes return it as JSON. */
export interface Fail {
	ok: false;
	code: string;
	message: string;
	/** On OUT_OF_STOCK / PRODUCT_UNAVAILABLE at checkout: which product, so a storefront can name it. */
	productId?: string;
}

/** What the buyer's order lookup returns (no secrets, no internal state). */
export interface PublicOrder {
	id: string;
	status: OrderStatus;
	items: Array<{ title: string; qty: number; unitPrice: number }>;
	currency: string;
	subtotal: number;
	shipping: number;
	total: number;
	/** Stripe's discount, once paid (promotion codes); null before. */
	discount: number | null;
	/** What the buyer paid, once paid. */
	amountPaid: number | null;
	/** Refunded so far, if any. */
	refundedAmount: number | null;
	createdAt: string;
	paidAt: string | null;
}
