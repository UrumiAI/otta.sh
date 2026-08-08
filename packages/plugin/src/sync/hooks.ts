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
import { parseProductTitle } from "./parse-product-title.js";
import {
	deriveDeleteIdempotencyKey,
	derivePublishIdempotencyKey,
	deriveSaveIdempotencyKey,
	deriveUnpublishIdempotencyKey,
} from "./derive-idempotency-key.js";
import { normalizeWatermark } from "./normalize-watermark.js";
import { syncVariants } from "./variants.js";

/**
 * ONE HOME PER FIELD (PR 1b) — what this module does, and no longer does.
 *
 * The CMS content document used to carry a `commerce` JSON bag (sku, price,
 * currency, stock, kind, tax class, dimensions) written by an on-screen
 * "Product data" Block Kit field widget, which these hooks validated and
 * projected into `product_commerce`. That made the admin console a SECOND
 * writer of the same columns, and the next CMS publish reverted every console
 * edit it overlapped (pinned for months as the store contract's `KNOWN GAP
 * (F4)` case).
 *
 * The bag, the widget and its validator are gone. Commercial fields now have
 * exactly one home — `product_commerce`, edited only from the admin's Pricing
 * & inventory page.
 *
 * WHAT THE SYNC STILL CARRIES: the product TITLE, and only the title. That is
 * PERMANENT, not transitional. `createOrderFromCart` rejects a null-title line
 * (`packages/domain/src/orders/create-order-from-cart.ts`), so the order
 * pipeline needs a title snapshot source it can read without a cross-database
 * join — which the architecture forbids. So `product_commerce.title` survives
 * as a DERIVED, SINGLE-WRITER CACHE whose only writer is this file. The CMS
 * `products` collection owns the value; this projects it.
 *
 * CONSEQUENCES, both real and both deliberate:
 *
 *  - **Every save of a products document now upserts.** There is no bag to be
 *    absent and no sku to be missing, so the old "create-then-price" and
 *    "no sku" skips are gone. A product saved with nothing but a title gets a
 *    bare `product_commerce` row and therefore APPEARS in Pricing & inventory,
 *    unpriced and ready to be priced — which is the point. It also means a
 *    published, unpriced, sku-less product is now `active: true`, a state that
 *    could not previously occur. It is not purchasable: `listCommerceByIds`
 *    filters commerce-incomplete rows in SQL and `joinProduct` reports
 *    `purchasable: false`. The admin's status column says so ("active (not
 *    priced)").
 *  - **A content-only save churns `product_commerce.updated_at`.** A
 *    description edit or an image swap still mints a fresh idempotency key (see
 *    `derive-idempotency-key.ts`), applies a no-change upsert, and invalidates
 *    the `expectedUpdatedAt` carrier in an open Pricing & inventory form — a
 *    spurious "This product changed since you opened it". Known regression,
 *    tracked as issue #153. **Do NOT fix it by deriving the idempotency key
 *    from the payload**: guard 1 (the replay guard) and guard 2 (the watermark
 *    guard) are ANDed on the same `onConflict().doUpdateSet()`, and
 *    `content_updated_at` sits INSIDE that SET block — so a same-key no-op
 *    freezes the watermark, and a rename-and-rename-back under reordered
 *    delivery would then leave the cache permanently wrong on the value
 *    `order_items` snapshots. The correct seam is making `updated_at`
 *    conditional on an owned column genuinely differing, in the adapter.
 *
 * SINCE VARIANTS, THE SYNC CARRIES ONE MORE CMS-OWNED NAME — a variant's, at
 * variant grain (ADR-0016, which applies ADR-0013 one level down clause for
 * clause). The repeater on the products document declares which sizes exist and
 * what each is called; `sync/variants.ts` projects it through the SAME channel,
 * on the same hooks, the same watermark and the same fire-and-forget posture,
 * and it too can write nothing commercial. A document with no repeater — the
 * entire live catalogue — takes exactly the path it always did, down to the
 * request count.
 *
 * WHAT IS DELIBERATELY NOT HERE: A SAVE-TIME REFUSAL. ADR-0016 asks the sync to
 * refuse a MUTATED or REUSED variant key at save time, "inside the CMS editor,
 * where it can still be explained to the person doing it", because a re-key
 * looks to the commerce side like a new variant plus a dropped one. That guard
 * is NOT implemented, and it is not an oversight — it is not reachable from a
 * sandbox-clean plugin on the pinned em-dash:
 *
 *  1. **THE HOOK HAS NO VETO.** `content:beforeSave` exists, but its handler
 *     contract is `Promise<Record<string, unknown> | void>` — a REPLACEMENT
 *     content bag, or nothing. There is no `{cancel, message}` and no `false`
 *     return; the only way to refuse is to throw. Compare
 *     `content:beforeDelete`, which explicitly honours a `false` return as a
 *     veto — `beforeSave` has no equivalent, in either dispatch path.
 *  2. **A SANDBOXED PLUGIN CANNOT REFUSE AT ALL.** em-dash's sandboxed dispatch
 *     catches every error out of the hook, writes it to a server-side
 *     `console.error`, and lets the save proceed. The abort path
 *     (`errorPolicy: "abort"`) exists on the TRUSTED pipeline alone, so a
 *     refusal built on it would work in-process and be a silent no-op in the
 *     sandbox — exactly the "if it only works trusted, it's broken" case
 *     ADR-0006 forbids.
 *  3. **EVEN TRUSTED, THE MESSAGE NEVER REACHES THE EDITOR.** A throw that does
 *     abort propagates uncaught through the content route; nothing converts it
 *     into em-dash's own `{success:false,error:{code,message}}` envelope, so the
 *     response is a bodyless 500 and the admin's save toast falls back to its
 *     generic "Failed to save" text. The plugin's sentence is discarded. A
 *     refusal the merchant cannot read is the thing ADR-0016 explicitly rules
 *     out: "A refusal that only reaches a log is not a refusal."
 *  4. **THE COMPARISON IS NOT EVEN DECIDABLE THERE.** `ContentHookEvent` is
 *     `{content, collection, isNew}` — no pre-save document and, on an update,
 *     NO ID. So the prior keys cannot be read off the event, and cannot be
 *     fetched either: there is nothing to fetch them by (and this plugin has no
 *     `ctx.content` in any case).
 *  5. **THE EDITOR CANNOT ENFORCE IT NATIVELY.** em-dash's `RepeaterSubField` is
 *     `{slug, type, label, required, options}` — no uniqueness rule, no
 *     immutability rule, no per-sub-field pattern. The server does not even
 *     validate a repeater's shape (the schema generator has no `repeater` case
 *     and falls through to `unknown`), which is why `parseVariantRepeater` is
 *     defensive about every sub-field it reads.
 *
 * Making the refusal legible therefore needs an UPSTREAM change — a sandboxed
 * `beforeSave` veto whose message survives to the editor — which is a decision,
 * not a patch, and is out of scope here.
 *
 * WHAT HOLDS THE LINE INSTEAD, and why this is a degraded UX rather than a data
 * hazard: the model already refuses to lose anything. A mutated key reads as a
 * new variant plus a dropped one, and a drop is DEACTIVATION, NEVER DELETION —
 * the orphaned row keeps its sku, its price and its stock, and a later increment
 * surfaces that state in the console. A reused key is resolved deterministically
 * rather than by request ordering (first row wins) and logged. Nothing is
 * silently destroyed; the operator is told late instead of early.
 */

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

/** Reads the product title out of the saved content record's `data` bag.
 *  Defensive about the `data` overlay shape — a non-object `data` yields
 *  `undefined` rather than throwing, because a hook must never fail a CMS save.
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

/**
 * The ONLY fields the CMS sync may put on the wire — the title, and (added by
 * the callers) the ordering watermark.
 *
 * This is a `Pick`, not the full `UpsertProductCommerceInput`, and that is the
 * structural half of the guard. The wide type declares `sku`, `price`,
 * `initialOnHand`, `productKind`, `taxClass` and the dimensions; against it,
 * re-adding a commercial field to this path would compile and be caught only by
 * a test. Against this type it does not compile. Same enforcement ladder
 * ADR-0013 argues for on the admin-edit side: the type first, the test second,
 * the prose third.
 */
type SyncUpsertBody = Pick<UpsertProductCommerceInput, "title" | "contentUpdatedAt">;

/** The outcome of deriving a `product_commerce` upsert body from a content
 *  record. There is no "skip" and no "invalid" arm any more: the body carries
 *  at most a title, so there is nothing left to reject and no reason to
 *  withhold the row. `titleProblem` is the caller's log line, never fatal. */
interface DerivedContent {
	body: SyncUpsertBody;
	/** Why the body carries no `title`, when it doesn't — logged by the
	 *  caller, NEVER fatal (see `parseProductTitle`). */
	titleProblem?: string;
}

/**
 * The single derive: content record → `product_commerce` upsert body.
 *
 * Both `content:afterSave` (for content that is NOT live) and
 * `content:afterPublish` (for content that is BECOMING live) go through here,
 * so the one projected field is defined once.
 *
 * THE BODY IS TITLE-ONLY, AND IT ALWAYS APPLIES. No commercial field is read
 * from content any more (PR 1b — see the module header), so:
 *
 *  - there is no money on this path at all, hence no float/currency rejection
 *    to make. Money integrity now lives entirely where money is entered: the
 *    service's `int()` zod bounds on the edit/upsert bodies, the admin form's
 *    exact-integer minor-unit parsing, and the branded `Cents` type;
 *  - there is no sku to be missing, so the old "never mint a partial row" skip
 *    is gone. Minting the bare row IS the fix — it is what makes a CMS product
 *    show up in Pricing & inventory waiting to be priced;
 *  - an unusable title omits ONLY itself and surfaces as `titleProblem`. The
 *    row is still upserted (which keeps the "every CMS product has a row"
 *    invariant true for a collection with no `title` field at all), and the
 *    store PRESERVES any title already stored when the field is absent.
 */
function deriveContent(content: Record<string, unknown>): DerivedContent {
	// TITLE: read from `content.data.title` — the CONTENT's own field. One
	// source of truth, so the storefront heading and the order line's snapshot
	// cannot drift. Done here, in the SHARED derive, so both hooks carry it.
	const parsed = parseProductTitle(readContentTitle(content));
	if ("title" in parsed) return { body: { title: parsed.title } };
	return { body: {}, titleProblem: parsed.problem };
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
 * `content:afterSave` → LIFECYCLE + TITLE. This hook is the CMS half of the
 * product's life: it guarantees the `product_commerce` row EXISTS, keeps its
 * title cache current, and activates it when the document is live. It carries
 * no commercial data (PR 1b — see the module header).
 *
 *   - THE ROW ALWAYS EXISTS. Every save of a products document upserts, even
 *     one with nothing but a title. That is how a CMS product becomes visible
 *     in Pricing & inventory, unpriced and ready to be priced. Before 1b a
 *     product with no sku got NO row and was simply invisible there.
 *   - TITLE: taken from the CONTENT field `data.title` (not a top-level field —
 *     em-dash's `ContentItem` has none). Without it the row's title stays NULL
 *     and `createOrderFromCart` rejects the buyer's checkout with
 *     `PRODUCT_NOT_PRICED`. An unusable title is NOT a rejection: it omits only
 *     itself and logs, and the row is still created.
 *   - The upsert carries ONLY the title + the ordering watermark; it NEVER
 *     touches `active`/`deletedAt`. Activation is the guarded call below. It
 *     also never touches sku, price, stock, kind, tax class or dimensions —
 *     those are Pricing & inventory's, and re-sending them here is exactly the
 *     clobber 1b removed.
 *
 * Firing twice with the same `content.updatedAt` AND `version` yields exactly
 * one applied write (idempotency-key replay dedupe); the `contentUpdatedAt`
 * watermark lets the service reject a delayed/out-of-order OLDER save as a
 * stale no-op (review S1). The watermark stays load-bearing precisely BECAUSE
 * the title still flows: an out-of-order delivery must not reinstate an older
 * name on the value `order_items` snapshots.
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
		// The title is live-affecting too: it is what an order line snapshots and
		// what the admin's product list shows, so a draft rename must not land
		// under the still-published old content. The log line is the only
		// developer-visible answer to "I saved and nothing changed".
		if (hasPendingDraft(event.content)) {
			console.info(
				`[otta] content:afterSave: product_id=${id} has PENDING DRAFT changes over live content — commerce sync deferred to publish (no upsert, no activate). The saved values go live when the merchant clicks "Publish changes".`,
			);
			return;
		}

		const derived = deriveContent(event.content);
		const body = derived.body;
		// NOT fatal — the row is still created/refreshed. Logged because a row
		// with no title is not orderable (`PRODUCT_NOT_PRICED` at checkout), so
		// this is the one line that explains an otherwise baffling checkout
		// failure.
		if (derived.titleProblem !== undefined) {
			console.warn(
				`[otta] content:afterSave: product_id=${id} synced WITHOUT a title (${derived.titleProblem}). The product cannot be ordered until it has one — checkout rejects an untitled product with PRODUCT_NOT_PRICED. The title is read from the content field \`data.title\`.`,
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
				// The title (when usable) + the ordering watermark, and nothing
				// else. NEVER `active`/`deletedAt` — activation is the guarded call
				// below — and never a commercial field.
				watermark !== undefined ? { ...body, contentUpdatedAt: watermark } : body,
				key,
			);
			// Issue #82: activate an already-published product in the same save.
			// SINCE 1b this reaches products it previously skipped: a published,
			// unpriced, sku-less product now gets a row and is activated. It is not
			// purchasable — `listCommerceByIds` filters commerce-incomplete rows in
			// SQL, so no commerce data reaches the catalog wire for it and
			// `joinProduct` reports `purchasable: false`. It is still LISTED on
			// `/products` (that grid comes from CMS content), just with no price, no
			// add-to-cart and a "not currently available" note. The admin status
			// column distinguishes it ("active (not priced)").
			if (event.content["status"] === PUBLISHED_STATUS && watermark !== undefined) {
				await client.activateProductCommerce(
					id,
					derivePublishIdempotencyKey(event.collection, id, updatedAt),
					watermark,
				);
			}
			// THE REPEATER'S OWN PROJECTION (ADR-0016) — same client, same watermark,
			// same save. Placed AFTER the activate so it can never affect the publish
			// gate, and it NEVER THROWS: a variant failure logs on its own line and
			// leaves the product's sync alone. A document with no repeater returns
			// immediately, having sent nothing — which is the entire live catalogue.
			await syncVariants({
				client,
				collection: event.collection,
				productId: id,
				content: event.content,
				watermark,
				hook: "content:afterSave",
				allowedHosts,
			});
		} catch (err) {
			console.error(
				`[otta] content:afterSave sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this sync (the title cache, and any variant this save declared or dropped) is lost until the product is saved again:`,
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
 *
 * NO VARIANT TRANSITION, deliberately. `ContentDeleteEvent` carries only
 * `{id, collection, permanent}` — no `content`, so no repeater and no watermark
 * — and orphaning a deleted product's sizes would buy nothing anyway: the
 * product row's own tombstone already withholds the whole product from every
 * catalog and checkout path, and a variant's rows keep their sku, price and
 * stock exactly as an orphan's would. Retaining them is the point.
 */
export function createAfterDeleteHandler(): HookHandler<ContentDeleteEvent> {
	return async (event, ctx) => {
		if (event.collection !== PRODUCTS_COLLECTION) return;
		const key = deriveDeleteIdempotencyKey(event.collection, event.id);
		try {
			await (await clientFor(ctx)).softDeleteProductCommerce(event.id, key);
		} catch (err) {
			console.error(`[otta] content:afterDelete sync failed for product_id=${event.id}:`, err);
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
 * PUBLISH ATOMICITY (plan §2.1b) — this hook also DERIVES AND UPSERTS, because
 * publish is the moment live content changes and `createAfterSaveHandler`
 * defers a pending-draft save to here. At `afterPublish` `draftRevisionId` is
 * null (publish clears it) so no draft hydration applies: `content.data` IS the
 * newly-published data, and `content.updatedAt` is strictly newer than any
 * preceding draft save because `publish()` bumps `updated_at` unconditionally.
 * `afterSave` does NOT also fire on a publish (`handleContentPublish`
 * dispatches `afterPublish` only), so there is no double-upsert. ORDERING:
 * upsert FIRST, then activate — the row must exist before the flip, since
 * `activate` no-ops on an unknown id.
 *
 * FAILURE POSTURE — ONE class since PR 1b. The old plan §2.8 named two: a
 * VALIDATION failure (float price, bad currency, missing sku) and a TRANSPORT
 * failure. The validation class is gone with the commerce bag — the body is a
 * title, and an unusable title omits itself rather than rejecting — so only
 * this rule remains:
 *
 *  - **Transport failure** (non-2xx / network) ⇒ FAIL CLOSED: no activate.
 *    Never make a row live whose commerce record we could not write. Logged on
 *    its own distinct line.
 *
 * Honest consequences of failing closed: on a publish-of-pending-changes the
 * row is ALREADY active, so skipping the activate deactivates nothing — the
 * content goes live against the row as it stands, logged only. On a FIRST
 * publish the row may not exist at all, so the product is content-live and
 * listed but unbuyable — no commerce data joins to it — until it is published
 * again. Since `afterSave` no longer retries the flip for live content, the
 * recovery verb in both cases is PUBLISH, not save. No automatic repair exists.
 *
 * Fire-and-forget throughout — this must never throw into the CMS publish path.
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
				`[otta] content:afterPublish for product_id=${id} carried no parseable updatedAt watermark — activation skipped (lost until the product is published again).`,
			);
			return;
		}
		const key = derivePublishIdempotencyKey(event.collection, id, updatedAt);
		// The title the publish makes live. Always applied — there is no
		// validation arm left to reject it (PR 1b); only a TRANSPORT failure on
		// the upsert blocks the activate.
		const derived = deriveContent(event.content);
		// NOT fatal (and NOT a reason to skip the activate): the publish proceeds,
		// the row simply is not orderable until it has a title.
		if (derived.titleProblem !== undefined) {
			console.warn(
				`[otta] content:afterPublish: product_id=${id} published WITHOUT a title (${derived.titleProblem}). The product cannot be ordered until it has one — checkout rejects an untitled product with PRODUCT_NOT_PRICED. The title is read from the content field \`data.title\`.`,
			);
		}
		try {
			const client = await clientFor(ctx);
			try {
				await client.upsertProductCommerce(
					id,
					// The title (when usable) + the PUBLISH watermark (the key is the
					// save key-space keyed on the publish's bumped `updatedAt` +
					// `version`, disjoint from the `:published:` activate key — see
					// §2.9 on the single per-row idempotency_key column). `publish()`
					// does write columns, so `updatedAt` still moves here; `version`
					// is carried for key-space consistency with the afterSave call
					// site. Unconditional since 1b: the upsert is also what
					// GUARANTEES THE ROW EXISTS before the activate, which no-ops on
					// an unknown id.
					{ ...derived.body, contentUpdatedAt: watermark },
					deriveSaveIdempotencyKey(event.collection, id, updatedAt, event.content["version"]),
				);
			} catch (err) {
				// FAIL CLOSED — never flip a row live whose commerce we could
				// not write. Distinct from the generic sync-failed line below so
				// the skipped activation is visible in logs.
				console.error(
					`[otta] content:afterPublish: commerce upsert FAILED for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}) — activation AND variant sync skipped (fail-closed). No reconcile cron exists yet — this sync is lost until the product is published again:`,
					err,
				);
				return;
			}
			await client.activateProductCommerce(id, key, watermark);
			// The repeater's projection, on the publish's own watermark — the same
			// call `content:afterSave` makes, for the same reason it derives and
			// upserts here: publish is the moment live content changes, and a
			// pending-draft save deferred everything to this hook. It never throws,
			// and a document with no repeater sends nothing.
			await syncVariants({
				client,
				collection: event.collection,
				productId: id,
				content: event.content,
				watermark,
				hook: "content:afterPublish",
				allowedHosts,
			});
		} catch (err) {
			console.error(
				`[otta] content:afterPublish sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this activation (and any variant this publish declared or dropped) is lost until the product is saved/published again:`,
				err,
			);
		}
	};
}

/**
 * `content:afterUnpublish` → deactivate (the afterUnpublish→deactivate
 * follow-up, plan §1/§6 step 7).
 *
 * NO VARIANT TRANSITION HERE EITHER, and for a different reason than
 * `afterDelete`'s: unpublishing does not retract the CMS's statement that these
 * sizes exist — the repeater still declares every one of them — so orphaning
 * them would be this channel inventing a decision the CMS never made, and the
 * next save would resurrect them all. Purchasability is already withheld one
 * level up: a size is offered only when its PARENT's `active` says the product
 * is, which this hook is what clears. The orphan axis is the repeater's alone.
 *
 * Otherwise the exact mirror of
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
				`[otta] content:afterUnpublish for product_id=${id} carried no parseable updatedAt watermark — deactivation skipped (lost until the product is unpublished again).`,
			);
			return;
		}
		const key = deriveUnpublishIdempotencyKey(event.collection, id, updatedAt);
		try {
			await (await clientFor(ctx)).deactivateProductCommerce(id, key, watermark);
		} catch (err) {
			console.error(
				`[otta] content:afterUnpublish sync failed for product_id=${id} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this deactivation is lost until the product is saved/unpublished again:`,
				err,
			);
		}
	};
}
