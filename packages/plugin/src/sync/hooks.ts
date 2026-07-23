import { ALLOWED_HOSTS, COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import type {
	ContentDeleteEvent,
	ContentHookEvent,
	ContentStateChangeEvent,
	HookHandler,
	PluginContext,
} from "../types.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import {
	deriveDeleteIdempotencyKey,
	derivePublishIdempotencyKey,
	deriveSaveIdempotencyKey,
	deriveUnpublishIdempotencyKey,
} from "./derive-idempotency-key.js";
import { normalizeWatermark } from "./normalize-watermark.js";

/** The only EmDash collection this plugin syncs (plan §2). */
export const PRODUCTS_COLLECTION = "products";

/**
 * The EmDash content lifecycle status (`ContentItem.status`, verified against
 * `~/em-dash` `packages/core/src/database/repositories/types.ts` — a `status:
 * string` carried verbatim into every content-hook record by
 * `contentItemToRecord = { ...item }`) that means "currently published". Saving
 * an already-published item preserves this status (`content.ts` save path keeps
 * `status = "published"`), so a `content:afterSave` for a live product reports
 * it here.
 */
const PUBLISHED_STATUS = "published";

/** Async because it awaits the write-gate token from write-only kv (ADR-0007):
 *  every sync write (upsert/activate/deactivate/soft-delete) is a non-GET the
 *  service gate blocks without `X-Service-Token`. Undefined ⇒ no header. */
async function clientFor(ctx: PluginContext): Promise<HttpCommerceClient> {
	const serviceToken = await serviceTokenFromKv(ctx);
	return new HttpCommerceClient({
		fetch: ctx.http.fetch,
		baseUrl: COMMERCE_SERVICE_BASE_URL,
		...(serviceToken !== undefined ? { serviceToken } : {}),
	});
}

/**
 * `content:afterSave` → upsert (plan §1 case 1 / §6 step 7).
 *
 * This is a bare "ensure a row exists, keyed by the CMS id" sync — it does
 * NOT carry commercial fields (those arrive only via the panel's own save
 * route, `admin/product-commerce-route.ts`; a duplicated write path here
 * would let a stale/re-fired afterSave clobber a merchant's in-progress
 * pricing edit). Firing this hook twice with the same `content.updatedAt`
 * yields exactly one applied write (idempotency-key replay dedupe), and the
 * body also carries `contentUpdatedAt` so the SERVICE's ordering guard makes
 * a delayed/out-of-order delivery of an OLDER save a stale no-op (review S1
 * — out-of-order delivery converges, plan §4/Risk 3).
 *
 * Fire-and-forget (plan §4): `afterSave` requires only `content:read` and
 * must never fail the CMS save. A network failure / non-2xx response is
 * logged, not thrown. NOTE the honest guarantee (review N2): there is no
 * reconcile cron yet (plan §6 step 9, deferred) — a failed sync is LOST
 * until the next human save of the same product re-fires this hook (the
 * idempotent upsert makes that later replay safe). Until the cron lands,
 * that next save is the only self-healing path.
 */
export function createAfterSaveHandler(
	allowedHosts: readonly string[] = ALLOWED_HOSTS,
): HookHandler<ContentHookEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const id = event.content["id"];
		if (typeof id !== "string" || id.length === 0) return; // no CMS id yet — nothing to sync.

		const updatedAt = event.content["updatedAt"];
		const key = deriveSaveIdempotencyKey(event.collection, id, updatedAt);
		// The service validates the watermark STRICTLY as Date.toISOString()
		// output (review F1 — it feeds a raw lexicographic SQL comparison), so
		// normalize whatever date shape the CMS hands us through toISOString();
		// an unparseable value omits the watermark (bare upsert, no ordering
		// guard) rather than failing the whole sync on a 400.
		const watermark = normalizeWatermark(updatedAt);
		try {
			const client = await clientFor(ctx);
			await client.upsertProductCommerce(
				id,
				// Ordering watermark only — no commercial fields (see above).
				watermark !== undefined ? { contentUpdatedAt: watermark } : {},
				key,
			);
			// Issue #82: activation is otherwise driven ONLY by
			// `content:afterPublish`. When a product is published BEFORE its
			// commerce row exists (the "publish first, price later" ordering),
			// that publish hook already fired and no-op'd (unknown product_id),
			// leaving a later-created row stranded at `active=false` with no path
			// to active until a manual unpublish→republish. So when THIS save is
			// of a CURRENTLY-PUBLISHED product, activate the row in the same sync
			// — through the DEDICATED, guarded `activate` (NEVER a field on the
			// bare upsert, which must never touch `active`/`deletedAt`). Routing
			// through `activate` preserves the load-bearing invariant that a
			// SOFT-DELETED row is never resurrected (the store no-ops the flip on
			// a tombstone), and the shared publish idempotency key + watermark
			// make it converge with the real `content:afterPublish` (same
			// `updatedAt` ⇒ same key/watermark ⇒ one applied flip). Best-effort,
			// like the rest of this fire-and-forget hook.
			if (event.content["status"] === PUBLISHED_STATUS && watermark !== undefined) {
				await client.activateProductCommerce(
					id,
					derivePublishIdempotencyKey(event.collection, id, updatedAt),
					watermark,
				);
			}
		} catch (err) {
			console.error(
				`[urumi] content:afterSave sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this sync is lost until the product is saved again:`,
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
			await (await clientFor(ctx)).softDeleteProductCommerce(event.id, key);
		} catch (err) {
			console.error(`[urumi] content:afterDelete sync failed for product_id=${event.id}:`, err);
		}
	};
}

/**
 * `content:afterPublish` → activate (the afterPublish→activate follow-up,
 * plan §1/§6 step 7 — deferred at Phase 1, this is that task). Confirmed
 * against `~/em-dash`: sandboxed plugins receive `content:afterPublish` as
 * `{ content, collection }` (`ContentStateChangeEvent`,
 * `packages/core/src/plugins/types.ts:731-734`), dispatched via
 * `EmDashRuntime.runDeferredContentHook` → `plugin.invokeHook("content:afterPublish",
 * { content, collection })` (`emdash-runtime.ts:3496-3510`), requiring only
 * `content:read` to register (`packages/core/src/plugins/hooks.ts`
 * `HOOK_REQUIRED_CAPABILITY` — `["content:afterPublish", "content:read"]`),
 * same as `afterSave`/`afterDelete`: no manifest/capability change needed.
 *
 * Mirrors `createAfterSaveHandler`'s shape (collection guard, missing-id
 * guard, fire-and-forget failure handling — same honest "no reconcile cron
 * yet" caveat) but calls `activateProductCommerce`, never `upsert`: `upsert`
 * deliberately never touches `active`/`deletedAt` (a stale/replayed
 * `content:afterSave` must never reactivate a soft-deleted row), so
 * activation is its own dedicated call — see the port doc / the service
 * route's doc. The service-side `activate` is itself the guard against
 * resurrecting a soft-deleted product; this hook does not duplicate that
 * check.
 */
export function createAfterPublishHandler(
	allowedHosts: readonly string[] = ALLOWED_HOSTS,
): HookHandler<ContentStateChangeEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const id = event.content["id"];
		if (typeof id !== "string" || id.length === 0) return; // no CMS id — nothing to activate.

		const updatedAt = event.content["updatedAt"];
		// The ordering watermark the service gates on so a stale, out-of-order
		// publish is a no-op (activate/deactivate are opposing flips on the same
		// `active` flag — see the port doc). Normalized to strict
		// Date.toISOString() form (the service validates it exactly, review F1).
		// EmDash's publish() always carries a valid `updatedAt`; if it is somehow
		// unparseable there is no watermark to gate the flip, so skip the sync
		// (fire-and-forget, same honest "lost until next publish" caveat) rather
		// than send an ungated flip that could re-latch out of order.
		const watermark = normalizeWatermark(updatedAt);
		if (watermark === undefined) {
			console.error(
				`[urumi] content:afterPublish for product_id=${id} carried no parseable updatedAt watermark — activation skipped (lost until the product is published again).`,
			);
			return;
		}
		const key = derivePublishIdempotencyKey(event.collection, id, updatedAt);
		try {
			await (await clientFor(ctx)).activateProductCommerce(id, key, watermark);
		} catch (err) {
			console.error(
				`[urumi] content:afterPublish sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this activation is lost until the product is saved/published again:`,
				err,
			);
		}
	};
}

/**
 * `content:afterUnpublish` → deactivate (the afterUnpublish→deactivate
 * follow-up, plan §1/§6 step 7) — the exact mirror of
 * `createAfterPublishHandler`, closing the publish gate so an unpublished
 * product stops being purchasable (without it `active` is a one-way latch).
 * Confirmed against `~/em-dash`: `content:afterUnpublish` is a DISTINCT hook
 * from `afterPublish` (separate dispatch case in
 * `EmDashRuntime.runDeferredContentHook`, `emdash-runtime.ts:3477-3479`,
 * fired only by `handleContentUnpublish` → `runAfterUnpublishHooks`,
 * `emdash-runtime.ts:2920-2921/3519-3521`), so this handler can never misfire
 * on a publish. Sandboxed plugins receive it as the SAME `{ content,
 * collection }` shape as `afterPublish` (`ContentStateChangeEvent`,
 * `packages/core/src/plugins/types.ts:731-734`; dispatched via
 * `plugin.invokeHook("content:afterUnpublish", { content, collection })`,
 * `emdash-runtime.ts:3504`), `content` being `contentItemToRecord(unpublished
 * item)` so `content.id`/`content.updatedAt` are present. It requires only
 * `content:read` to register (`packages/core/src/plugins/hooks.ts:285` —
 * `["content:afterUnpublish", "content:read"]`), same as
 * `afterSave`/`afterDelete`/`afterPublish`: no manifest/capability change
 * needed. Same fire-and-forget "no reconcile cron yet" caveat; the
 * service-side `deactivate` is itself the guard against touching a
 * soft-deleted row's tombstone.
 */
export function createAfterUnpublishHandler(
	allowedHosts: readonly string[] = ALLOWED_HOSTS,
): HookHandler<ContentStateChangeEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const id = event.content["id"];
		if (typeof id !== "string" || id.length === 0) return; // no CMS id — nothing to deactivate.

		const updatedAt = event.content["updatedAt"];
		// The ordering watermark (see createAfterPublishHandler): a stale,
		// out-of-order unpublish is a no-op at the service. EmDash's unpublish()
		// always carries a valid `updatedAt`; skip the sync if it is somehow
		// unparseable rather than send an ungated flip.
		const watermark = normalizeWatermark(updatedAt);
		if (watermark === undefined) {
			console.error(
				`[urumi] content:afterUnpublish for product_id=${id} carried no parseable updatedAt watermark — deactivation skipped (lost until the product is unpublished again).`,
			);
			return;
		}
		const key = deriveUnpublishIdempotencyKey(event.collection, id, updatedAt);
		try {
			await (await clientFor(ctx)).deactivateProductCommerce(id, key, watermark);
		} catch (err) {
			console.error(
				`[urumi] content:afterUnpublish sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this deactivation is lost until the product is saved/unpublished again:`,
				err,
			);
		}
	};
}
