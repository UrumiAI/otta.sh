import { ALLOWED_HOSTS, COMMERCE_SERVICE_BASE_URL, serviceTokenFromKv } from "../manifest.js";
import type {
	ContentDeleteEvent,
	ContentHookEvent,
	ContentStateChangeEvent,
	HookHandler,
	PluginContext,
} from "../types.js";
import type { UpsertProductCommerceInput } from "../product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../product-commerce/http-commerce-client.js";
import {
	parseCommerceFields,
	parseProductTitle,
} from "../product-commerce/parse-commerce-fields.js";
import {
	deriveDeleteIdempotencyKey,
	derivePublishIdempotencyKey,
	deriveSaveIdempotencyKey,
	deriveUnpublishIdempotencyKey,
} from "./derive-idempotency-key.js";
import { normalizeWatermark } from "./normalize-watermark.js";

/** The content document's `json` field the "Product data" widget persists into
 *  (bound via `widget: "urumi:product-data"`). em-dash stores a field-widget's
 *  value under the content item's `data` bag keyed by the field slug, and the
 *  hook record is `contentItemToRecord(item) = { ...item }`, so the commerce
 *  bag lives at `content.data.commerce`. */
const COMMERCE_FIELD = "commerce";

/** Reads the widget's per-`action_id` commerce bag out of the saved content
 *  record. Returns `undefined` when the product carries no commerce field yet
 *  (create-then-price: nothing to derive). Defensive about the `data` overlay
 *  shape — only an object bag is honored. */
function readCommerceField(content: Record<string, unknown>): Record<string, unknown> | undefined {
	const data = content["data"];
	const bag =
		typeof data === "object" && data !== null
			? (data as Record<string, unknown>)[COMMERCE_FIELD]
			: undefined;
	return typeof bag === "object" && bag !== null ? (bag as Record<string, unknown>) : undefined;
}

/**
 * The content field carrying the product title — the value an ORDER LINE
 * SNAPSHOTS at purchase time, without which the product is unpurchasable
 * (`createOrderFromCart` rejects a null title with `PRODUCT_NOT_PRICED`).
 *
 * `data.title` IS A HARD ASSUMPTION, stated here so it is never a mystery. The
 * title is NOT a top-level hook field: em-dash's `ContentItem`
 * (`packages/core/src/database/repositories/types.ts`) has no `title` member at
 * all. `mapRow()` copies every column NOT in `SYSTEM_COLUMNS` into `data`
 * (`repositories/content.ts`), `title` is an ordinary user-defined collection
 * field (`sites/staging/seed/seed.json` declares it `required` on `products`),
 * and `contentItemToRecord = { ...item }` passes the item through verbatim — so
 * a hook receives the title at `content.data.title`. em-dash's own code reads it
 * that way (`query.ts`: "entries[0].data.title"; `seo/index.ts`: "title from
 * `data.title`"), as does this repo's theme (`sites/staging/src/lib/products.ts`
 * projects `data.title` into `CmsProductContent`).
 *
 * A collection that names its title field something else therefore syncs
 * everything EXCEPT the title and logs a specific line saying so on every save —
 * deliberately legible, and deliberately NOT fatal (see `parseProductTitle`).
 */
const TITLE_FIELD = "title";

/** Reads the product title out of the saved content record's `data` bag — the
 *  same defensive shape-check `readCommerceField` applies, for the same reason.
 *  `undefined` when the field is absent; em-dash's `mapRow` EXCLUDES null
 *  columns from `data`, so a null title arrives as an ABSENT key, never `null`. */
function readContentTitle(content: Record<string, unknown>): unknown {
	const data = content["data"];
	return typeof data === "object" && data !== null
		? (data as Record<string, unknown>)[TITLE_FIELD]
		: undefined;
}

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

/**
 * True when this save staged a PENDING DRAFT over content that is currently
 * LIVE — i.e. the merchant's edit is waiting behind "Publish changes" and
 * NOTHING live-affecting may be pushed for it yet (publish-atomicity, plan
 * §2.2).
 *
 * EmDash models a pending draft as two nullable revision POINTERS, not a
 * data column: `liveRevisionId` / `draftRevisionId`, both emitted as top-level
 * fields on the hook record. Draft state is DERIVED, never stored — the admin's
 * own `getDraftStatus` is `!liveRevisionId ? "unpublished" : (draftRevisionId
 * && draftRevisionId !== liveRevisionId) ? "published_with_changes" :
 * "published"`. Crucially the row's `status` column stays `"published"`
 * throughout `published_with_changes`, which is exactly why a bare
 * `status === "published"` check cannot see a pending draft.
 *
 *  - **Clause 1** is EmDash's own `published_with_changes`: both pointers are
 *    present and they diverge.
 *  - **Clause 2** covers rows that are live BY STATUS but carry no
 *    live-revision pointer. `ContentRepository.create()` accepts `status`
 *    verbatim and its INSERT column list contains no `live_revision_id`, so an
 *    API / CLI / MCP / importer create-with-`status:"published"` yields exactly
 *    that shape; a later save sets `draftRevisionId` while `liveRevisionId`
 *    stays null, and clause 1 alone would let the price leak.
 *
 * Deliberately NOT `status` alone (identical in the clean and pending-draft
 * states) and NOT `liveData` (hydration sets it whenever `draftRevisionId` is
 * non-null, INCLUDING for a never-published draft, which must keep syncing).
 * Pointers also degrade correctly: on a collection WITHOUT `"revisions"` a save
 * writes the live columns directly and `draftRevisionId` is always null, so a
 * save there IS the live change and syncs — one predicate, both site shapes.
 * If the pointer fields are absent entirely (an older/different host) this is
 * `false` and behavior is exactly what it was before publish atomicity.
 *
 * Exported so it can be unit-tested without the workerd sandbox.
 */
export function hasPendingDraft(content: Record<string, unknown>): boolean {
	const draft = content["draftRevisionId"];
	if (typeof draft !== "string" || draft.length === 0) return false; // no pending draft at all.
	const live = content["liveRevisionId"];
	if (typeof live === "string" && live.length > 0) return live !== draft; // clause 1.
	return content["status"] === PUBLISHED_STATUS; // clause 2.
}

/** The outcome of deriving a `product_commerce` upsert body from a content
 *  record's `commerce` bag: something to apply, nothing to apply, or a
 *  boundary-validation rejection the caller logs. */
type DerivedCommerce =
	| {
			kind: "apply";
			body: UpsertProductCommerceInput;
			/** Why the body carries no `title`, when it doesn't — logged by the
			 *  caller, NEVER fatal (see `parseProductTitle`). */
			titleProblem?: string;
	  }
	/** No `commerce` field yet (create-then-price), or no sku (not sellable —
	 *  never mint a partial row). */
	| { kind: "skip" }
	| { kind: "invalid"; errors: Record<string, string> };

/**
 * The single derive: content record → validated `product_commerce` upsert body.
 *
 * Both `content:afterSave` (for content that is NOT live) and
 * `content:afterPublish` (for content that is BECOMING live) go through here,
 * so the money/shape guard, the create-then-price skip, and the no-sku skip are
 * defined once. Anything added to the widget bag is therefore picked up by both
 * hooks at once.
 *
 * MONEY INTEGRITY (CLAUDE.md non-negotiable): a float price, a bad currency, or
 * any invalid field makes the WHOLE upsert a rejection — never a partial or
 * coerced write. The caller decides what a rejection means for its hook.
 *
 * THE TITLE IS THE ONE FIELD THAT NEVER REJECTS. It comes from the CONTENT
 * (`data.title`), not the widget bag, so a merchant cannot fix it from the panel
 * the way they can fix a price; and a collection whose title field is absent or
 * named differently would otherwise lose EVERY commerce sync, not just its
 * title. So an unusable title omits only itself and surfaces as `titleProblem`
 * for the caller to log — the row still gets its sku, price and stock, and the
 * store preserves any title already stored.
 */
function deriveCommerce(content: Record<string, unknown>): DerivedCommerce {
	const bag = readCommerceField(content);
	if (bag === undefined) return { kind: "skip" };
	const { body, errors } = parseCommerceFields(bag);
	if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
	if (body.sku === undefined) return { kind: "skip" };
	// TITLE: read from `content.data.title` — the CONTENT's own field, never a
	// widget input and never a hand-written `commerce.title` (one source of
	// truth, so the storefront heading and the order line's snapshot cannot
	// drift). Done here, in the SHARED derive, so both hooks carry it.
	const parsed = parseProductTitle(readContentTitle(content));
	if ("title" in parsed) return { kind: "apply", body: { ...body, title: parsed.title } };
	return { kind: "apply", body, titleProblem: parsed.problem };
}

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
 * `content:afterSave` → derive `product_commerce` from the widget's `commerce`
 * field JSON (issue #81 rework / #82 activation).
 *
 * The "Product data" field widget has no Save button (em-dash field widgets
 * are `onChange`-only and reject a `button` element — see
 * `admin/product-data-widget.ts`). The merchant edits inline inputs that
 * persist into the content document's `commerce` JSON field, and the editor's
 * NATIVE Save fires THIS hook. So afterSave is now the single write path that
 * turns pricing into a `product_commerce` row (the old button-era
 * `product-commerce-route` is retired).
 *
 * It reads `content.data.commerce`, validates it through the SHARED
 * `parseCommerceFields` guard (the same rules the retired route applied), and:
 *   - MONEY INTEGRITY (CLAUDE.md non-negotiable): any invalid field — notably a
 *     FLOAT price (em-dash's `number_input` can yield a decimal) or a bad
 *     currency — makes the whole upsert a logged no-op. A float NEVER reaches a
 *     money field, and the CMS save still succeeds.
 *   - MISSING SKU: with no sku there is no sellable product, so the upsert is
 *     skipped — no partial row is minted (create-then-price).
 *   - TITLE: taken from the CONTENT field `data.title` (not the widget bag, and
 *     not a top-level field — em-dash's `ContentItem` has none). Without it the
 *     row's title stays NULL and `createOrderFromCart` rejects the buyer's
 *     checkout with `PRODUCT_NOT_PRICED`. Unlike a float price this is NOT a
 *     rejection: an unusable title omits only itself and logs, so the price and
 *     stock still sync.
 *   - The upsert carries ONLY validated commercial fields + the ordering
 *     watermark; it NEVER touches `active`/`deletedAt`. Stock rides as
 *     `initialOnHand`, a create-if-absent seed the service refuses to apply
 *     over an existing/decremented `on_hand` (no re-save clobber — proven by
 *     `@urumi/domain`'s inventory-store contract).
 *
 * Firing twice with the same `content.updatedAt` yields exactly one applied
 * write (idempotency-key replay dedupe); the `contentUpdatedAt` watermark lets
 * the service reject a delayed/out-of-order OLDER save as a stale no-op
 * (review S1).
 *
 * Activation (issue #82): when the saved product is CURRENTLY PUBLISHED, the
 * just-derived row is activated in the same sync through the DEDICATED, guarded
 * `activate` — never an `active` field on the upsert. Routing through
 * `activate` preserves the invariant that a SOFT-DELETED row is never
 * resurrected (the store no-ops the flip on a tombstone), and the shared
 * publish idempotency key + watermark make it converge with the real
 * `content:afterPublish` (same `updatedAt` ⇒ same key/watermark ⇒ one applied
 * flip). Ordering: upsert FIRST, then activate.
 *
 * PUBLISH ATOMICITY (plan §2.1a / §2.5) — the load-bearing guard. When the save
 * staged a PENDING DRAFT over content that is already LIVE (`hasPendingDraft`),
 * this hook sends NOTHING: not the upsert, and not the activate. EmDash hands
 * `afterSave` the hydrated DRAFT data on purpose ("Hydrate draft data BEFORE
 * firing afterSave hooks so the hook sees the same effective data the response
 * surfaces"), so pushing it would put the draft's price live under the old
 * published content — the exact bug this guard closes. The activate is deferred
 * with it because an activate is itself a live-affecting flip: on a
 * pending-draft save of a deactivated row it would re-latch the product
 * purchasable at the stale price with no publish. The commerce for that save
 * lands at `content:afterPublish`, together with the content.
 *
 * Cost, stated plainly: a row stuck content-live-but-unpurchasable (an earlier
 * `activate` lost in transit) no longer heals on the merchant's next save,
 * because a save of live content now sends nothing. THE RECOVERY VERB IS
 * PUBLISH — one click on "Publish changes" re-derives and re-activates. There
 * is still no automatic repair (no reconcile cron).
 *
 * Fire-and-forget (plan §4): `afterSave` requires only `content:read` and must
 * never fail the CMS save. A network failure / non-2xx is logged, not thrown.
 * Honest guarantee (review N2): there is no reconcile cron yet — a failed sync
 * is LOST until the next human save re-fires this hook (the idempotent upsert
 * makes that replay safe).
 */
export function createAfterSaveHandler(
	allowedHosts: readonly string[] = ALLOWED_HOSTS,
): HookHandler<ContentHookEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const id = event.content["id"];
		if (typeof id !== "string" || id.length === 0) return; // no CMS id yet — nothing to sync.

		// PUBLISH ATOMICITY: the save staged a pending draft over LIVE content —
		// send nothing that affects live state. Both the upsert and the activate
		// move to `content:afterPublish`, so content and commerce change together.
		// The log line is the only developer-visible answer to "I saved a new
		// price and the storefront did not change"; the widget carries no
		// merchant-facing copy for it yet (a deliberate follow-up — it would
		// churn localized strings this change does not otherwise touch).
		if (hasPendingDraft(event.content)) {
			console.info(
				`[urumi] content:afterSave: product_id=${id} has PENDING DRAFT changes over live content — commerce sync deferred to publish (no upsert, no activate). The saved values go live when the merchant clicks "Publish changes".`,
			);
			return;
		}

		const derived = deriveCommerce(event.content);
		// Money/shape integrity: a float price, bad currency, or any invalid
		// field skips the WHOLE upsert (atomic — never a partial/float write) and
		// logs, so the CMS save is never failed and no float reaches money.
		if (derived.kind === "invalid") {
			console.warn(
				`[urumi] content:afterSave: invalid commerce fields for product_id=${id}; skipping the product_commerce upsert (the CMS save still succeeds):`,
				derived.errors,
			);
			return;
		}
		// No commerce field (create-then-price) or no sku (not sellable) ⇒ do not
		// mint a partial row.
		if (derived.kind === "skip") return;
		const body = derived.body;
		// NOT fatal — everything else still syncs. Logged because a row with no
		// title is not orderable (`PRODUCT_NOT_PRICED` at checkout), so this is the
		// one line that explains an otherwise baffling checkout failure.
		if (derived.titleProblem !== undefined) {
			console.warn(
				`[urumi] content:afterSave: product_id=${id} synced WITHOUT a title (${derived.titleProblem}). The product cannot be ordered until it has one — checkout rejects an untitled product with PRODUCT_NOT_PRICED. The title is read from the content field \`data.title\`.`,
			);
		}

		const updatedAt = event.content["updatedAt"];
		// `version` is load-bearing since emdash 0.30.0: a draft-only save is a
		// column no-op there, so `updatedAt` FREEZES and only `version` moves
		// (see derive-idempotency-key.ts). Without it every price edit after the
		// first collapses onto one key and the store's replay guard drops it.
		const key = deriveSaveIdempotencyKey(event.collection, id, updatedAt, event.content["version"]);
		// The service validates the watermark STRICTLY as Date.toISOString()
		// output (review F1 — a raw lexicographic SQL comparison), so normalize
		// whatever date shape the CMS hands us; an unparseable value omits the
		// watermark (no ordering guard) rather than failing the sync on a 400.
		const watermark = normalizeWatermark(updatedAt);
		try {
			const client = await clientFor(ctx);
			await client.upsertProductCommerce(
				id,
				// Validated commercial fields + the ordering watermark. NEVER
				// `active`/`deletedAt` — activation is the guarded call below.
				watermark !== undefined ? { ...body, contentUpdatedAt: watermark } : body,
				key,
			);
			// Issue #82: activate an already-published product in the same save.
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
 * yet" caveat). Activation stays its own dedicated call and is never an
 * `active` field on the upsert: `upsert` deliberately never touches
 * `active`/`deletedAt` (a stale/replayed sync must never reactivate a
 * soft-deleted row) — see the port doc / the service route's doc. The
 * service-side `activate` is itself the guard against resurrecting a
 * soft-deleted product; this hook does not duplicate that check.
 *
 * PUBLISH ATOMICITY (plan §2.1b) — this hook now also DERIVES AND UPSERTS the
 * commerce bag, because publish is the moment live content changes and
 * `createAfterSaveHandler` defers a pending-draft save's commerce to here. At
 * `afterPublish` `draftRevisionId` is null (publish clears it) so no draft
 * hydration applies: `content.data` IS the newly-published data, and
 * `content.updatedAt` is strictly newer than any preceding draft save because
 * `publish()` bumps `updated_at` unconditionally. `afterSave` does NOT also
 * fire on a publish (`handleContentPublish` dispatches `afterPublish` only), so
 * there is no double-upsert. ORDERING: upsert FIRST, then activate — a row is
 * never made live ahead of its price.
 *
 * FAILURE POSTURE — two classes, two rules (plan §2.8):
 *
 *  - **Validation failure** (float price, bad currency, missing sku) ⇒ the
 *    content publishes, commerce is left unchanged, and the product STILL
 *    activates. The content is valid and the merchant asked for it to be live;
 *    refusing to activate would let a pricing typo silently unpublish a live
 *    product. Activation is the CONTENT gate and is independent of commerce
 *    validity — with no valid price the row simply is not purchasable
 *    (`joinProduct`: `purchasable ⟺ present && active`). This differs from
 *    `afterSave`, where a validation failure returns before the activate; that
 *    ordering is incidental, this is the considered rule.
 *  - **Transport failure** (non-2xx / network) ⇒ FAIL CLOSED: no activate.
 *    Never make a row live whose commerce we could not write. Logged on its own
 *    distinct line.
 *
 * Honest consequences of failing closed: on a publish-of-pending-changes the
 * row is ALREADY active, so skipping the activate deactivates nothing — the
 * content goes live with the STALE price (the safe direction: an old price, not
 * a wrong new one), logged only. On a FIRST publish the row is inactive, so the
 * product is content-live but unpurchasable until it is published again. Since
 * `afterSave` no longer retries the flip for live content, the recovery verb in
 * both cases is PUBLISH, not save. No automatic repair exists.
 *
 * Both classes stay fire-and-forget — this must never throw into the CMS
 * publish path.
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
		// Derive the commerce the publish makes live. A validation rejection is
		// logged and the activate still runs (posture A); only a TRANSPORT failure
		// on the upsert blocks it (posture B).
		const derived = deriveCommerce(event.content);
		if (derived.kind === "invalid") {
			console.warn(
				`[urumi] content:afterPublish: invalid commerce fields for product_id=${id}; the content still publishes and the product still activates, but product_commerce is left unchanged (not purchasable without a valid price):`,
				derived.errors,
			);
		}
		// NOT fatal (and NOT a reason to skip the activate): the publish proceeds,
		// the row simply is not orderable until it has a title.
		if (derived.kind === "apply" && derived.titleProblem !== undefined) {
			console.warn(
				`[urumi] content:afterPublish: product_id=${id} published WITHOUT a title (${derived.titleProblem}). The product cannot be ordered until it has one — checkout rejects an untitled product with PRODUCT_NOT_PRICED. The title is read from the content field \`data.title\`.`,
			);
		}
		try {
			const client = await clientFor(ctx);
			if (derived.kind === "apply") {
				try {
					await client.upsertProductCommerce(
						id,
						// Validated commercial fields + the PUBLISH watermark (the
						// key is the save key-space keyed on the publish's bumped
						// `updatedAt` + `version`, disjoint from the `:published:`
						// activate key — see §2.9 on the single per-row
						// idempotency_key column). `publish()` does write columns, so
						// `updatedAt` still moves here; `version` is carried for
						// key-space consistency with the afterSave call site.
						{ ...derived.body, contentUpdatedAt: watermark },
						deriveSaveIdempotencyKey(event.collection, id, updatedAt, event.content["version"]),
					);
				} catch (err) {
					// FAIL CLOSED — never flip a row live whose commerce we could
					// not write. Distinct from the generic sync-failed line below so
					// the skipped activation is visible in logs.
					console.error(
						`[urumi] content:afterPublish: commerce upsert FAILED for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}) — activation skipped (fail-closed). No reconcile cron exists yet — this sync is lost until the product is published again:`,
						err,
					);
					return;
				}
			}
			await client.activateProductCommerce(id, key, watermark);
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
