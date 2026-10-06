import {
	InvalidProductFieldError,
	orderId as toOrderId,
	sku as toSku,
	validateDownloadAsset,
	type DownloadAsset,
	type Order,
	type OrderState,
} from "@otta-sh/domain";
import { isRetryableStorageBusy } from "@otta-sh/store-emdash";
import type { DownloadAssetWire } from "../admin/admin-products-surface.js";
import { createInProcessCommerceStores } from "../commerce/in-process-commerce-stores.js";
import type { PluginContext, RouteHandler } from "../types.js";
import { isWellFormedText } from "@otta-sh/domain";

/** The PUBLIC route the site dispatches, in-process, before it streams a
 *  digital download (issue #376). */
export const ENTITLEMENT_DOWNLOAD_ROUTE = "entitlements/download";

/** The `orderId` and `sku` ceiling: the bound the entitlement check has always
 *  put on both. */
const DOWNLOAD_ID_MAX = 200;

export interface EntitlementDownloadInput {
	/** The order whose file is asked for: the guest's bearer capability
	 *  (ADR-0011 scope 2) and the order every gate below is read off. */
	orderId?: unknown;
	/** The line's sku. A LOOKUP VALUE only — never part of a key or a path. */
	sku?: unknown;
	/** A signed-in buyer's session bearer, threaded from the theme's cookie
	 *  layer. Accepted and IGNORED: see "Who may download" below. NEVER an email
	 *  (issue #33). */
	sessionToken?: unknown;
}

export type EntitlementDownloadResult =
	/** `asset` is what the site needs to stream the file, and nothing more: the
	 *  bucket key, the name and type for the response headers, the size, and the
	 *  digest when the merchant's upload recorded one. The same wire shape the
	 *  admin detail reads. */
	| { authorized: true; sku: string; asset: DownloadAssetWire }
	/** One answer for every refusal that depends on stored data: no such order,
	 *  no grant, a revoked grant, an order whose money went back, a physical
	 *  product, no file, a file bound to another product. The site answers 404. */
	| { authorized: false; reason: "NOT_FOUND" }
	/** The input's SHAPE is wrong. Decided before any read, so it says nothing
	 *  about what is stored. */
	| { authorized: false; reason: "INVALID_INPUT" }
	/** The store was too busy to answer (storage contention). NOT a verdict: the
	 *  caller answers 503 and the buyer retries. */
	| { authorized: false; reason: "BUSY"; retryable: true };

const NOT_FOUND = { authorized: false, reason: "NOT_FOUND" } as const;
const INVALID_INPUT = { authorized: false, reason: "INVALID_INPUT" } as const;

/**
 * Which order states may deliver: those whose money was taken and kept.
 * `pending`, `failed` and `expired` never kept it; `cancelled` and `refunded`
 * gave it back. A `Record` over the whole union, so a state added later fails
 * typecheck here until someone decides whether it delivers.
 *
 * A PARTIAL refund leaves the order in its paid-side state and still delivers —
 * the same line increment 1 drew for revocation.
 */
const DELIVERABLE_ORDER_STATES: Readonly<Record<OrderState, boolean>> = {
	paid: true,
	processing: true,
	shipped: true,
	delivered: true,
	completed: true,
	pending: false,
	failed: false,
	expired: false,
	cancelled: false,
	refunded: false,
};

/**
 * Entitlement-gated digital download (issue #376; ADR-0011). The plugin decides
 * WHO may download and WHICH file; the site streams the bytes from its private
 * `DOWNLOADS` bucket, because a plugin route can neither return a byte stream
 * nor read R2 (design note §2). This route touches only `ctx.storage` and makes no
 * request. It is idempotent: it changes nothing a caller can observe, though
 * the entitlement check may repair its own lookup pointer on the way.
 *
 * THE GATE. `{authorized: true, sku, asset}` only when ALL of these hold, read
 * fresh on every call (no token is minted, nothing is cached):
 *  1. an ACTIVE entitlement for this `orderId` and `sku` — not revoked;
 *  2. the order is in a deliverable state ({@link DELIVERABLE_ORDER_STATES}) and
 *     has a line for the sku;
 *  3. that line's product is `digital` NOW;
 *  4. the product carries a `downloadAsset` that still passes
 *     `validateDownloadAsset` for THIS product — the key is `dl/{productId}/…`.
 * Revocation is not trusted to have happened: 2 refuses a refunded or cancelled
 * order whose revoke never ran (a crash with no retry), or whose grant landed
 * after the revoke (settle racing a refund); 3 refuses a product the integrator
 * upsert flipped to physical with its file still attached; 4 refuses a stored
 * key that would read another product's file.
 *
 * ONE NOT_FOUND. Every refusal that depends on stored data is the same answer,
 * so the route cannot be used to learn which orders exist or what state they
 * are in. The reads stop at the first refusal, but a caller without a granted
 * `(orderId, sku)` never gets past the first read, and one with it already holds
 * the order's capability, so how far a refusal got tells nobody anything new.
 *
 * WHO MAY DOWNLOAD. The `orderId` is required: it names the order whose state
 * and line the gate reads, and serving one order's file on another order's
 * grant would detach the gate from the purchase that paid for it. Holding it is
 * the authorization — ADR-0011 scope 2, a 122-bit bearer capability, the link
 * the confirmation email carries. A session riding along is IGNORED, as
 * ADR-0011 rules: the capability must keep working for a guest who later signs
 * in to an unrelated account. That also means a session can never read an order
 * by itself: a session-only request (ADR-0011's scope 3, "any order of mine")
 * has no order to gate on and is refused as INVALID_INPUT, and a session cannot
 * lend its own entitlement to someone else's order id — the old precedence
 * retry (order scope, then session scope) did exactly that and is gone. A
 * signed-in buyer's account page links with the order's own id, so it loses
 * nothing.
 *
 * NEVER FROM THE CALLER: a key, a path, a buyerRef (issue #33). The key comes
 * from plugin storage only; the `sku` is a lookup value, bounded and checked for
 * a storable character set before any read.
 *
 * THE KEY IN A PUBLIC ANSWER. This route is `public: true` (plugin.ts) because
 * it has to be: the site's only in-process dispatcher,
 * `locals.emdash.handlePublicPluginApiRoute`, refuses any route not marked
 * public, and the private mount wants an EmDash admin user a shopper's request
 * does not carry. So a browser can POST to
 * `/_emdash/api/plugins/otta/entitlements/download` itself, and an entitled one
 * gets the key back. That is acceptable, because the key is a NAME, not a
 * credential:
 *  - The bytes live in a private bucket reachable only through the site
 *    Worker's `DOWNLOADS` binding — not the public `MEDIA` bucket EmDash's
 *    media route serves, and with no public URL (increment 3 pins this in
 *    config).
 *  - The site's download endpoint never takes a key from its caller. It
 *    re-runs THIS gate on `(orderId, sku)` on every request and reads only the
 *    key the gate returns.
 *  - The answer goes only to a caller who passes the whole gate for that very
 *    file, at a moment they can download its bytes anyway. After a refund the
 *    key they kept opens nothing.
 *  - What it reveals beyond that is the product id, which is public, and the
 *    upload's ULID time.
 * A secret-carrying channel would need a new shared secret between site and
 * plugin, against the design's "no new secret". If the bucket ever became
 * public, revoked access would leak whatever channel carried the key — so the
 * invariant to guard is the bucket staying private, not the key staying hidden.
 * The descriptor is copied field by field (`validateDownloadAsset` returns a
 * canonical copy), so a field later added to the stored document is not
 * answered by accident.
 */
export function createEntitlementDownloadHandler(): RouteHandler<EntitlementDownloadInput> {
	return async (routeCtx, ctx): Promise<EntitlementDownloadResult> => {
		try {
			return await authorize(routeCtx.input, ctx);
		} catch (err) {
			// Storage pressure is not NOT_FOUND — that would tell a paying buyer they
			// do not own what they bought. Every step here is idempotent (the only
			// write is the entitlement check repairing its own lookup pointer), so a
			// retry is trivially safe. Anything else propagates.
			if (isRetryableStorageBusy(err)) {
				console.warn(`[otta] ${ENTITLEMENT_DOWNLOAD_ROUTE} busy (retryable):`, err);
				return { authorized: false, reason: "BUSY", retryable: true };
			}
			throw err;
		}
	};
}

/** A string the gate may read with: 1–200 characters, well-formed text — no
 *  U+0000, which Postgres `text` cannot hold (a NUL would fail the first read as
 *  a throw there rather than a refusal), and no lone surrogate, which `jsonb`
 *  cannot (review R3-B X1). */
function isLookupValue(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= DOWNLOAD_ID_MAX &&
		isWellFormedText(value)
	);
}

async function authorize(
	input: EntitlementDownloadInput,
	ctx: PluginContext,
): Promise<EntitlementDownloadResult> {
	const { orderId: rawOrderId, sku: rawSku } = input;
	if (!isLookupValue(rawOrderId) || !isLookupValue(rawSku)) return INVALID_INPUT;
	const orderId = toOrderId(rawOrderId);
	const sku = toSku(rawSku);

	// Built over the stores directly, as the settle routes are, so no payment
	// gateway or mail sender is resolved for a check that needs neither.
	const stores = createInProcessCommerceStores(ctx);

	// 1. An active grant for exactly this order and sku.
	if (!(await stores.entitlementStore.check({ orderId, sku }))) return NOT_FOUND;

	// 2. The order kept its money, and bought this sku.
	const order = await stores.orderStore.getById(orderId);
	if (order === null || !DELIVERABLE_ORDER_STATES[order.state]) return NOT_FOUND;
	const line = digitalLineFor(order, rawSku);
	if (line === undefined) return NOT_FOUND;

	// 3. The product is digital now, and 4. its file is this product's.
	const product = await stores.productCommerce.getByProductId(line.productId);
	if (product === null || product.productKind !== "digital") return NOT_FOUND;
	if (product.downloadAsset === null) return NOT_FOUND;
	let asset: DownloadAsset;
	try {
		asset = validateDownloadAsset(line.productId, product.downloadAsset);
	} catch (err) {
		if (!(err instanceof InvalidProductFieldError)) throw err;
		// The edit path refuses such a descriptor, so one on disk was written
		// around it. Never served; logged, because a merchant's file is now
		// unreachable for every buyer.
		console.warn(
			`[otta] ${ENTITLEMENT_DOWNLOAD_ROUTE}: stored downloadAsset on ${line.productId} refused at serve time (${err.field})`,
		);
		return NOT_FOUND;
	}
	return { authorized: true, sku: rawSku, asset };
}

/** The order's digital line for `sku` — the line settle granted on. */
function digitalLineFor(order: Order, sku: string): Order["lines"][number] | undefined {
	return order.lines.find((l) => l.sku === sku && l.fulfillmentKind === "digital");
}
