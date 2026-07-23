import { COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import {
	CommerceClientError,
	type UpsertProductCommerceInput,
} from "../product-commerce/commerce-client.js";
import type { RouteHandler } from "../types.js";
import { normalizeWatermark } from "../sync/normalize-watermark.js";

/** The non-public route path the panel's Save action posts to (plan §5). */
export const PRODUCT_COMMERCE_ROUTE = "product-commerce";

/**
 * The posted payload — a Block Kit `form_submit` carries the ENTIRE
 * captured form state keyed by `action_id` (plan §8 Risk 5, confirmed
 * against em-dash: `FormSubmit.values: Record<string, unknown>`; it exposes
 * NO delivery/event id — verified, which is why the idempotency key below
 * must be content-derived). `productId` is threaded in by the host from the
 * current document (or by the panel's own button `value`, em-dash
 * `ButtonElement.value`).
 */
export interface ProductCommerceRouteInput {
	productId?: unknown;
	sku?: unknown;
	price?: unknown;
	currency?: unknown;
	onHand?: unknown;
	productKind?: unknown;
	taxClass?: unknown;
	weightGrams?: unknown;
	lengthMm?: unknown;
	widthMm?: unknown;
	heightMm?: unknown;
	/**
	 * Whether the CMS content this panel is pricing is CURRENTLY PUBLISHED
	 * (issue #82). Threaded from the current document the SAME way `productId`
	 * is — the panel-state route bakes it (plus `contentUpdatedAt`) into the
	 * Save button's `value`, and the host echoes that `value` back into this
	 * route's input on submit (em-dash `ButtonElement.value` → `BlockAction.value`,
	 * the documented alternate to host document-context threading; see the
	 * handler doc / `product-data-widget.ts`).
	 *
	 * WHY it exists: activation is otherwise driven ONLY by
	 * `content:afterPublish` → `activateProductCommerce`. When a product is
	 * published BEFORE it is priced, that hook already fired (and no-op'd —
	 * the row did not exist yet), so a later pricing write would leave the row
	 * `active=false` with no path to active until a manual unpublish→republish
	 * (issue #82). When this flag is `true`, the handler issues an explicit,
	 * guarded `/activate` in the same operation so the PDP becomes purchasable
	 * without a republish.
	 */
	contentPublished?: unknown;
	/** The current CMS content's `updatedAt` — the ORDERING WATERMARK the store
	 *  gates the publish flip on (a stale, out-of-order activate is a no-op).
	 *  Same source/threading as `contentPublished`. */
	contentUpdatedAt?: unknown;
}

export type ProductCommerceRouteResult =
	| { ok: true; productCommerce: unknown }
	| { ok: false; error: "MISSING_PRODUCT_ID" }
	| { ok: false; error: "INVALID_FIELDS"; fields: Record<string, string> }
	// Review F2: a live-SKU conflict (service 409 SKU_TAKEN) surfaces in the
	// same structured per-field shape the panel already renders for
	// INVALID_FIELDS — never an opaque failure.
	| { ok: false; error: "SKU_TAKEN"; fields: Record<string, string> };

/**
 * Stable, content-derived idempotency key for a panel save (review S2).
 *
 * em-dash's `FormSubmit` exposes no delivery/event id, so the key is a hash
 * of the canonicalized submission (productId + every commercial field): a
 * RETRANSMISSION of the same submission (host retry, double-click,
 * duplicate delivery) derives the SAME key and dedupes to one applied
 * write; a genuinely new edit (any field changed) derives a different key
 * and applies. Deliberate edge: intentionally re-submitting IDENTICAL
 * values later also dedupes — acceptable, since applying it would be a
 * content no-op anyway.
 *
 * FNV-1a over the canonical JSON, run twice with independent seeds for ~64
 * bits of key space — dependency-free and sandbox-safe (no `node:crypto`
 * under workerd, and `crypto.subtle` would force this path async for no
 * gain at this collision budget).
 */
export function derivePanelIdempotencyKey(
	productId: string,
	body: UpsertProductCommerceInput,
): string {
	const canonical = JSON.stringify([
		productId,
		body.sku ?? null,
		body.price ?? null,
		body.taxClass ?? null,
		body.weightGrams ?? null,
		body.lengthMm ?? null,
		body.widthMm ?? null,
		body.heightMm ?? null,
		body.productKind ?? null,
		body.initialOnHand ?? null,
	]);
	return `${productId}:panel:${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01234567)}`;
}

function fnv1a(input: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

interface ValidatedFields {
	body: UpsertProductCommerceInput;
	errors: Record<string, string>;
}

/**
 * Boundary validation (review S6): structured, per-field errors for
 * everything the panel can get wrong — not just MISSING_PRODUCT_ID — so a
 * bad price/currency/dimension surfaces as
 * `{ ok:false, error:"INVALID_FIELDS", fields }` instead of an opaque 500.
 * (The service's zod layer + branded `Cents` remain the authoritative money
 * guards; this is shape/UX parity at the plugin boundary.)
 */
function validate(input: ProductCommerceRouteInput): ValidatedFields {
	const body: UpsertProductCommerceInput = {};
	const errors: Record<string, string> = {};

	if (input.sku !== undefined) {
		if (typeof input.sku === "string" && input.sku.length > 0) body.sku = input.sku;
		else errors["sku"] = "sku must be a non-empty string";
	}

	if (input.price !== undefined || input.currency !== undefined) {
		if (typeof input.price !== "number" || !Number.isSafeInteger(input.price) || input.price < 0) {
			errors["price"] = "price must be a non-negative integer in minor units (no floats)";
		} else if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
			errors["currency"] = "currency must be an ISO-4217 alpha code (e.g. USD)";
		} else {
			body.price = { amount: input.price, currency: input.currency };
		}
	}

	if (input.onHand !== undefined) {
		if (
			typeof input.onHand === "number" &&
			Number.isSafeInteger(input.onHand) &&
			input.onHand >= 0
		) {
			body.initialOnHand = input.onHand;
		} else {
			errors["onHand"] = "stock must be a non-negative integer";
		}
	}

	if (input.productKind !== undefined) {
		if (input.productKind === "physical" || input.productKind === "digital") {
			body.productKind = input.productKind;
		} else {
			errors["productKind"] = "productKind must be physical or digital";
		}
	}

	if (input.taxClass !== undefined) {
		if (typeof input.taxClass === "string") body.taxClass = input.taxClass;
		else errors["taxClass"] = "taxClass must be a string";
	}

	const dims = [
		["weightGrams", input.weightGrams],
		["lengthMm", input.lengthMm],
		["widthMm", input.widthMm],
		["heightMm", input.heightMm],
	] as const;
	for (const [name, value] of dims) {
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			body[name] = value;
		} else {
			errors[name] = `${name} must be a non-negative integer`;
		}
	}

	return { body, errors };
}

/**
 * Validates and calls `CommerceClient.upsert` (plan §5). "Create then
 * price", API/domain layer (plan §1 case 3): a missing/empty `productId` is
 * rejected here BEFORE any commercial write is attempted — the
 * server-side counterpart to the widget's disabled UX (which never offers
 * this action for an unsaved product in the first place), so a
 * hand-crafted request can't bypass the UX.
 */
export function createProductCommerceRouteHandler(): RouteHandler<ProductCommerceRouteInput> {
	return async (routeCtx, ctx): Promise<ProductCommerceRouteResult> => {
		const input = routeCtx.input;
		const productId = input.productId;
		if (typeof productId !== "string" || productId.length === 0) {
			return { ok: false, error: "MISSING_PRODUCT_ID" };
		}

		const { body, errors } = validate(input);
		if (Object.keys(errors).length > 0) {
			return { ok: false, error: "INVALID_FIELDS", fields: errors };
		}

		// The panel Save is a PUT (`upsertProductCommerce`), gated by the write gate
		// (X-Service-Token) when the service secret is set — source it from kv.
		const serviceToken = await serviceTokenFromKv(ctx);
		const client = new HttpCommerceClient({
			fetch: ctx.http.fetch,
			baseUrl: COMMERCE_SERVICE_BASE_URL,
			...(serviceToken !== undefined ? { serviceToken } : {}),
		});
		// Stable content-derived key (S2): a retry/double-submit of the SAME
		// submission dedupes to one applied write; a genuinely new edit derives
		// a different key and applies. (The content-sync path derives its key
		// from the CMS revision instead — sync/derive-idempotency-key.ts.)
		const key = derivePanelIdempotencyKey(productId, body);
		try {
			const row = await client.upsertProductCommerce(productId, body, key);
			// Issue #82: a "publish first, price later" product is published BEFORE
			// its row exists, so `content:afterPublish` → activate already no-op'd
			// (unknown product_id) and nothing else flips `active`. When the panel
			// reports the content is CURRENTLY PUBLISHED, activate the just-priced
			// row in the SAME operation via the DEDICATED, guarded `/activate` route
			// — never a field on the blanket upsert. Routing through `activate`
			// preserves the load-bearing invariant that a SOFT-DELETED row is never
			// resurrected (the store's `activate` no-ops on a tombstone; proven by
			// the store-contract "activate of a SOFT-DELETED product does NOT
			// resurrect it"). Best-effort, exactly like the fire-and-forget sync
			// hooks: the row is durably priced regardless, and a failed activation
			// self-heals on the next publish/price — it must never fail the save.
			await activateIfPublished(client, productId, input);
			return { ok: true, productCommerce: row };
		} catch (err) {
			// Review F2: the service's structured 409 SKU_TAKEN becomes a
			// per-field error the panel can render next to the SKU input.
			if (err instanceof CommerceClientError && err.status === 409 && isSkuTaken(err.body)) {
				return {
					ok: false,
					error: "SKU_TAKEN",
					fields: { sku: `SKU "${err.body.sku}" is already used by another live product` },
				};
			}
			throw err;
		}
	};
}

/**
 * Issue #82 activation seam: when the panel reports the content is CURRENTLY
 * PUBLISHED, flip the just-priced row `active=true` via the guarded
 * `/activate` action route so the PDP is purchasable without a republish.
 *
 * Best-effort by design (mirrors the fire-and-forget sync hooks): the row is
 * already durably priced, so a network failure / non-2xx is logged, never
 * thrown — it must not fail the pricing save. A missing/false publish flag or
 * an unparseable watermark skips activation entirely (no ungated flip): an
 * unpublished product's row correctly stays inactive until `content:afterPublish`
 * fires.
 */
async function activateIfPublished(
	client: HttpCommerceClient,
	productId: string,
	input: ProductCommerceRouteInput,
): Promise<void> {
	if (input.contentPublished !== true) return;
	const watermark = normalizeWatermark(input.contentUpdatedAt);
	if (watermark === undefined) return;
	// Stable per-(product, watermark) key: a replay of the SAME pricing
	// submission derives the SAME key, so the store dedupes to one applied flip
	// (and an already-active row is a stable no-op regardless of key).
	const key = `${productId}:panel-activate:${watermark}`;
	try {
		await client.activateProductCommerce(productId, key, watermark);
	} catch (err) {
		console.error(
			`[urumi] product-commerce panel activate failed for product_id=${productId} (row is priced but not yet active — self-heals on the next publish/price):`,
			err,
		);
	}
}

function isSkuTaken(body: unknown): body is { error: "SKU_TAKEN"; sku: string } {
	return (
		typeof body === "object" &&
		body !== null &&
		(body as { error?: unknown }).error === "SKU_TAKEN" &&
		typeof (body as { sku?: unknown }).sku === "string"
	);
}
