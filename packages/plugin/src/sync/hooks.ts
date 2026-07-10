import { ALLOWED_HOSTS, COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import type { ContentDeleteEvent, ContentHookEvent, HookHandler, PluginContext } from "../types.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import { deriveDeleteIdempotencyKey, deriveSaveIdempotencyKey } from "./derive-idempotency-key.js";

/** The only EmDash collection this plugin syncs (plan §2). */
export const PRODUCTS_COLLECTION = "products";

function clientFor(ctx: PluginContext): HttpCommerceClient {
	return new HttpCommerceClient({ fetch: ctx.http.fetch, baseUrl: COMMERCE_SERVICE_BASE_URL });
}

/**
 * `content:afterSave` → upsert (plan §1 case 1 / §6 step 7).
 *
 * This is a bare "ensure a row exists, keyed by the CMS id" sync — it does
 * NOT carry commercial fields (those arrive only via the panel's own save
 * route, `admin/product-commerce-route.ts`; a duplicated write path here
 * would let a stale/re-fired afterSave clobber a merchant's in-progress
 * pricing edit). Firing this hook twice with the same `content.updatedAt`
 * yields exactly one applied write (idempotency-key replay dedupe).
 *
 * Fire-and-forget (plan §4): `afterSave` requires only `content:read` and
 * must never fail the CMS save. A network failure / non-2xx response is
 * logged, not thrown — durable retry is the reconcile cron's job (deferred,
 * plan §6 step 9), and the service's upsert being idempotent makes a later
 * reconcile safe to replay.
 */
export function createAfterSaveHandler(
	allowedHosts: readonly string[] = ALLOWED_HOSTS,
): HookHandler<ContentHookEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const id = event.content["id"];
		if (typeof id !== "string" || id.length === 0) return; // no CMS id yet — nothing to sync.

		const key = deriveSaveIdempotencyKey(event.collection, id, event.content["updatedAt"]);
		try {
			await clientFor(ctx).upsertProductCommerce(id, {}, key);
		} catch (err) {
			console.error(
				`[urumi] content:afterSave sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}); will be healed by reconcile:`,
				err,
			);
		}
	};
}

/**
 * `content:afterDelete` → soft delete (plan §1 case 2 / §6 step 7). Soft-
 * delete on both trash and permanent delete (plan §4/§8 Risk 6) — order
 * history integrity; a hard purge policy is a later retention decision, not
 * built here.
 */
export function createAfterDeleteHandler(): HookHandler<ContentDeleteEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const key = deriveDeleteIdempotencyKey(event.collection, event.id);
		try {
			await clientFor(ctx).softDeleteProductCommerce(event.id, key);
		} catch (err) {
			console.error(`[urumi] content:afterDelete sync failed for product_id=${event.id}:`, err);
		}
	};
}
