import {
	cents,
	currency,
	idempotencyKey,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashProductCommerceStore,
	PRODUCT_COMMERCE_COLLECTION,
	systemClock,
	type ProductCommerceDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/**
 * PUBLISH ATOMICITY (plan §2): what the CMS sync pushes for content that is
 * currently LIVE is not pushed on save — it is pushed at PUBLISH, in the same
 * operation that makes the content live.
 *
 * Why the existing `sync-hooks.sandbox.test.ts` never caught the bug: every one
 * of its fixtures omits the REVISION POINTER fields (`liveRevisionId` /
 * `draftRevisionId`) EmDash emits on a revision-supporting collection, so all of
 * them are "not a pending draft" and keep the pre-change behavior. That suite's
 * continued green IS the pointers-absent / older-host regression test; the
 * fixtures below are the ones that carry pointers.
 *
 * SINCE PR 1b ("one home per field") the deferred payload is the TITLE, not a
 * commerce bag: the title is what an order line snapshots and what the admin
 * list shows, so a draft rename must not land under the still-published old
 * content. The ordering and failure rules are unchanged; the cases that
 * asserted price/stock deferral are rewritten around the title, and the two
 * that only existed for the bag (T7 stock, T10 validation failure) are gone —
 * there is no stock on this path and no validation arm left to fail.
 *
 * SINCE INC-D3a the hooks run their store writes IN PROCESS — there is no
 * `@otta-sh/service` deployment, so there are no requests to count. Every case
 * below asserts the same claim against the STORED ROW, which is what the
 * request counts were standing in for, and three of them get sharper in the
 * move:
 *
 *  - "NOTHING was pushed" is now "the row does not exist" AND "the storage
 *    collection was not touched at all" (an instrumented collection records
 *    every operation), which also rules out a speculative read the request
 *    count could never have seen.
 *  - "upsert BEFORE activate" is now an OUTCOME: `activate` no-ops on an id
 *    with no row, so `active: true` after one delivery is only reachable if the
 *    upsert landed first. The old index comparison proved the order of two
 *    requests; this proves the order MATTERED.
 *  - T12's §2.9 note about the single `idempotency_key` column — which the wire
 *    test could only describe in a comment, because the column was on the far
 *    side of the service — is now asserted: the column is read back after each
 *    delivery and the key-space it holds flips exactly as described.
 *
 * T11's "TRANSPORT failure" becomes a STORAGE fault injected at the collection
 * seam, and it is injected for ONE call only: storage is healthy again by the
 * time the activate would run, so "no activate" is a real decision by the
 * handler rather than a second casualty of the same outage.
 */

/** Every id here is suffixed, because the document store is shared by every
 *  sandbox suite in this process (see `sandbox/storage-bridge.ts`). */
function pid(name: string): string {
	return `${name}-pa`;
}

/** A draft save. EmDash 0.29.0 bumps `updated_at` unconditionally on every
 *  update (`content.ts` update(): `updated_at: now`), so a draft save DOES
 *  carry a fresh watermark — which is precisely why the pre-change hook leaked
 *  the draft data on every save, not just the first (plan §1.6). */
const T1 = "2026-07-26T10:00:00.000Z";
/** The publish, strictly newer (publish() bumps `updated_at` too, plan §1.5). */
const T2 = "2026-07-26T11:00:00.000Z";

/** The product title, which lives at `content.data.title` — NOT at the top
 *  level. em-dash's `ContentItem` has no `title` member; `mapRow()` puts every
 *  non-`SYSTEM_COLUMNS` column into `data`, and `title` is an ordinary
 *  user-defined collection field (`sites/staging/seed/seed.json` declares it on
 *  `products`). It is the value an order line snapshots at purchase time, its
 *  absence is why a product is unpurchasable (`PRODUCT_NOT_PRICED`), and since
 *  PR 1b it is the ONLY field the CMS sync projects. */
const TITLE = "Blue Mug";
/** The live title, still on the storefront while a rename sits in a draft. */
const OLD_TITLE = "Grey Mug";

/** A save that staged a PENDING DRAFT over live content: EmDash's
 *  `published_with_changes` (status stays "published"; the two revision
 *  pointers diverge), with `content.data` already hydrated FROM THE DRAFT by
 *  `hydrateDraftData` before the hook fires. */
function pendingDraft(id: string, title: string = TITLE): Record<string, unknown> {
	return {
		id,
		updatedAt: T1,
		status: "published",
		liveRevisionId: "rev-live",
		draftRevisionId: "rev-draft",
		data: { title },
		liveData: { title: OLD_TITLE },
	};
}

/** The §2.2 clause-2 hole: `create()` accepts `status` verbatim and its INSERT
 *  never sets `live_revision_id`, so an API/CLI/import create-with-published
 *  yields a row that is live BY STATUS with no live-revision pointer. */
function importedLive(id: string, title: string = TITLE): Record<string, unknown> {
	return {
		id,
		updatedAt: T1,
		status: "published",
		liveRevisionId: null,
		draftRevisionId: "rev-draft",
		data: { title },
	};
}

/** A live product with NO pending draft — the state `publish()` leaves behind
 *  (`draft_revision_id = NULL`), so `content.data` IS the published data. */
function publishedClean(
	id: string,
	updatedAt: string,
	title: string = TITLE,
): Record<string, unknown> {
	return {
		id,
		updatedAt,
		status: "published",
		liveRevisionId: "rev-live",
		draftRevisionId: null,
		data: { title },
	};
}

/** One operation log for the instrumented collection. */
interface CollectionCalls {
	/** Every method name the plugin invoked, in order. */
	readonly calls: string[];
	/** While set, the next `failTimes` calls to this method throw instead of
	 *  running — a database fault injected at the seam the store itself uses. */
	failOn: string | null;
	failTimes: number;
	reset(): void;
}

let sandboxHandle: SandboxHandle;
let storage: StorageAccess;
let productCalls: CollectionCalls;
/** The product collection as it was BEFORE instrumentation. Assertions read
 *  through this, because the proxy cannot tell the plugin's operations from the
 *  test's own — and several cases turn on the plugin having made none. */
let rawProducts: NonNullable<(typeof storage)[string]>;

function instrument(name: string): CollectionCalls {
	const target = storage[name];
	if (target === undefined) throw new Error(`no '${name}' collection to instrument`);
	const calls: string[] = [];
	const log: CollectionCalls = {
		calls,
		failOn: null,
		failTimes: 0,
		reset() {
			calls.length = 0;
			this.failOn = null;
			this.failTimes = 0;
		},
	};
	storage[name] = new Proxy(target, {
		get(_holder, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== "function") return value;
			const bound = (value as (...args: unknown[]) => unknown).bind(target);
			return (...args: unknown[]) => {
				calls.push(String(property));
				if (log.failOn === property && log.failTimes > 0) {
					log.failTimes -= 1;
					throw new Error("injected storage fault");
				}
				return bound(...args);
			};
		},
	}) as (typeof storage)[string];
	return log;
}

function commerceStore(): EmdashProductCommerceStore {
	return new EmdashProductCommerceStore({ storage, clock: systemClock });
}

async function readDoc(id: string): Promise<ProductCommerceDoc | null> {
	return (await rawProducts.get(id)) as ProductCommerceDoc | null;
}

async function requireDoc(id: string): Promise<ProductCommerceDoc> {
	const doc = await readDoc(id);
	if (doc === null) throw new Error(`no product_commerce row for ${id}`);
	return doc;
}

/** A row that already exists when the hook fires. Seeded with NO
 *  `contentUpdatedAt`, so the hook's own watermark is never "older than stored"
 *  and the upsert's ordering guard cannot silently swallow a case. */
async function seedRow(
	id: string,
	options: { readonly priced?: boolean; readonly title?: string; readonly active?: boolean } = {},
): Promise<void> {
	const store = commerceStore();
	await store.upsert(
		{
			productId: toProductId(id),
			title: options.title ?? OLD_TITLE,
			...(options.priced === true
				? {
						sku: toSku(`SKU-PA-${id}`),
						price: { amount: cents(1999), currency: currency("USD") },
					}
				: {}),
		},
		idempotencyKey(`seed-${id}`),
	);
	if (options.active === true) {
		await store.activate(toProductId(id), idempotencyKey(`seed-activate-${id}`), T1);
	}
}

function afterSave(
	content: Record<string, unknown>,
	collection = "products",
	isNew = false,
): Promise<{ result: unknown } | { error: string }> {
	return sandboxHandle.invokeHook("content:afterSave", { content, collection, isNew });
}

function afterPublish(
	content: Record<string, unknown>,
	collection = "products",
): Promise<{ result: unknown } | { error: string }> {
	return sandboxHandle.invokeHook("content:afterPublish", { content, collection });
}

function afterUnpublish(
	content: Record<string, unknown>,
	collection = "products",
): Promise<{ result: unknown } | { error: string }> {
	return sandboxHandle.invokeHook("content:afterUnpublish", { content, collection });
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	const products = storage[PRODUCT_COMMERCE_COLLECTION];
	if (products === undefined) throw new Error("no product_commerce collection");
	rawProducts = products;
	productCalls = instrument(PRODUCT_COMMERCE_COLLECTION);
	// NO allowed hosts: the sync is in-process, and a hook that tried to reach a
	// network would fail silently (fire-and-forget), so every "the row is in the
	// right state" assertion below is also a proof that nothing egressed.
	sandboxHandle = await loadPluginInSandbox({ allowedHosts: [], storage: true });
}, 120_000);

afterAll(async () => {
	await sandboxHandle?.close();
});

beforeEach(() => {
	// Seeding runs through the same instrumented collection, so cases that assert
	// on the log clear it again immediately before the hook they exercise.
	productCalls.reset();
});

describe("publish atomicity — live commerce changes only at publish (workerd sandbox)", () => {
	test("T1 BUG REPRO: a draft save of a PUBLISHED product writes NOTHING", async () => {
		const id = pid("p1");

		const outcome = await afterSave(pendingDraft(id, "Renamed Mug"));

		// The merchant's rename does NOT reach the order pipeline while the live
		// content still shows the old name. The guard sits ahead of every store
		// call, so not one operation is spent — not even a read.
		expect(await readDoc(id)).toBeNull();
		expect(productCalls.calls).toEqual([]);
		expect(outcome).toEqual({ result: null }); // still fire-and-forget.
	});

	test("T2 publish applies content + commerce TOGETHER — upsert BEFORE activate", async () => {
		const id = pid("p2");

		await afterSave(pendingDraft(id, "Renamed Mug"));
		await afterPublish(publishedClean(id, T2, "Renamed Mug"));

		const doc = await requireDoc(id);
		expect(doc.title).toBe("Renamed Mug");
		expect(doc.contentUpdatedAt).toBe(T2);
		// THE ORDERING, AS AN OUTCOME: a row is never made live before it exists —
		// `activate` no-ops on an unknown id, so `active: true` here is reachable
		// only if the upsert ran first. (The old wire test compared two request
		// indices, which showed the order without showing that it mattered.)
		expect(doc.active).toBe(true);
		expect(doc.activeUpdatedAt).toBe(T2);
	});

	test("T3 the publish-time upsert carries the PUBLISH watermark and key, not the draft save's", async () => {
		const id = pid("p3");
		// Seeded ALREADY ACTIVE so the publish's activate is a same-state no-op and
		// leaves the row's single `idempotency_key` column holding the UPSERT's key
		// — otherwise the flip overwrites it (§2.9) and the upsert's key-space is
		// unobservable. The state under test is unaffected: this is "publish the
		// pending changes of a live product", the commonest publish there is.
		await seedRow(id, { active: true });

		await afterPublish(publishedClean(id, T2));

		const doc = await requireDoc(id);
		// A pre-change save at T1 would have keyed and watermarked on T1; both are
		// the publish's own, strictly newer, values.
		expect(doc.contentUpdatedAt).toBe(T2);
		expect(T2 > T1).toBe(true);
		expect(doc.idempotencyKey).toBe(`products:${id}:${T2}`);
		expect(doc.idempotencyKey).not.toBe(`products:${id}:${T1}`);
	});

	test("T4 a NEVER-PUBLISHED draft save still syncs immediately (the row must exist for the console)", async () => {
		const id = pid("p4");

		await afterSave(
			{
				id,
				updatedAt: T1,
				status: "draft",
				liveRevisionId: null,
				draftRevisionId: "rev-1",
				data: { title: TITLE },
			},
			"products",
			true,
		);

		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.active).toBe(false); // nothing live yet.
		expect(doc.activeUpdatedAt).toBeNull(); // the gate was never touched at all.
	});

	test("T5 a collection WITHOUT draft revisions syncs on save even when published", async () => {
		const id = pid("p5");

		// No `"revisions"` in `supports` ⇒ the save writes the live columns
		// directly and `draftRevisionId` is always null. There a save IS the live
		// change, so upsert + activate must still fire on save.
		await afterSave(publishedClean(id, T1));

		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.active).toBe(true);
	});

	test("T6 draftRevisionId === liveRevisionId is NOT a pending draft", async () => {
		const id = pid("p6");

		await afterSave({
			id,
			updatedAt: T1,
			status: "published",
			liveRevisionId: "rev-same",
			draftRevisionId: "rev-same",
			data: { title: TITLE },
		});

		expect((await requireDoc(id)).title).toBe(TITLE);
	});

	test("T8 unpublish deactivates and writes NO upsert", async () => {
		const id = pid("p8");
		await seedRow(id, { active: true });

		await afterUnpublish(publishedClean(id, T2));

		const doc = await requireDoc(id);
		expect(doc.active).toBe(false);
		expect(doc.activeUpdatedAt).toBe(T2);
		// The unpublish key-space, disjoint from both the save and the publish
		// keys — three transitions contending for one per-row column.
		expect(doc.idempotencyKey).toBe(`products:${id}:unpublished:${T2}`);
		// NO UPSERT: unpublishing is a gate flip, not a content projection, so the
		// title cache and the sync watermark are untouched. (The wire test asserted
		// "zero PUTs"; this asserts what a PUT would have changed.)
		expect(doc.title).toBe(OLD_TITLE);
		expect(doc.contentUpdatedAt).toBeNull();
	});

	test("T9 after unpublish a save syncs again; republish re-applies + reactivates", async () => {
		const id = pid("p9");
		await seedRow(id, { active: true });

		await afterUnpublish(publishedClean(id, T1));
		expect((await requireDoc(id)).active).toBe(false);

		// unpublish() clears BOTH the live pointer and the status, so the
		// predicate is false — nothing is live to protect.
		await afterSave({
			id,
			updatedAt: T1,
			status: "draft",
			liveRevisionId: null,
			draftRevisionId: "rev-2",
			data: { title: "Reworked Mug" },
		});
		const drafted = await requireDoc(id);
		expect(drafted.title).toBe("Reworked Mug"); // the save DID sync.
		expect(drafted.active).toBe(false); // …without re-latching the gate.

		await afterPublish(publishedClean(id, T2, "Reworked Mug"));
		const published = await requireDoc(id);
		expect(published.active).toBe(true);
		expect(published.contentUpdatedAt).toBe(T2);
	});

	test("T11 a STORAGE failure at publish FAILS CLOSED: no activate, even once storage recovers", async () => {
		const id = pid("p11");
		await seedRow(id);

		// ONE call fails — the upsert's conditional write — and everything after it
		// runs against healthy storage. So an implementation that merely logged the
		// upsert failure and carried on WOULD activate here, and this case would
		// fail. That is the whole point of the fail-closed arm.
		productCalls.failOn = "compareAndSet";
		productCalls.failTimes = 1;
		const outcome = await afterPublish(publishedClean(id, T2));
		productCalls.failTimes = 0;

		// Never make a row live whose commerce record we could not write. (The
		// handler logs a distinct "commerce upsert FAILED … activation skipped
		// (fail-closed)" line; the workerd child's console is not observable
		// across the sandbox boundary, so the behavior is what is pinned here.)
		const doc = await requireDoc(id);
		expect(doc.active).toBe(false);
		expect(doc.title).toBe(OLD_TITLE); // the upsert really did not land.
		expect(outcome).toEqual({ result: null }); // never throws into the CMS publish path.

		// …and the next publish heals both halves.
		await afterPublish(publishedClean(id, T2));
		const healed = await requireDoc(id);
		expect(healed.title).toBe(TITLE);
		expect(healed.active).toBe(true);
	});

	test("T12 replay: the upsert key and the activate key are distinct, and each delivery is stable", async () => {
		const id = pid("p12");
		const content = publishedClean(id, T2);

		await afterPublish(content);
		const first = await requireDoc(id);
		// §2.9, NOW ASSERTED RATHER THAN DESCRIBED — `product_commerce` carries ONE
		// `idempotency_key` column and the two transitions share it. On a FIRST
		// publish the activate applies last, so the column ends up holding the
		// ACTIVATE's key…
		expect(first.idempotencyKey).toBe(`products:${id}:published:${T2}`);
		expect(first.active).toBe(true);

		await afterPublish(content);
		const second = await requireDoc(id);
		// …which is why a redelivered afterPublish RE-APPLIES the upsert: the stored
		// key is the activate's, not the upsert's, so the replay guard does not
		// recognise it. Nothing the merchant can see changes (same title, same
		// watermark, same gate) — only `updated_at` moves, and the column flips back
		// to the upsert key-space. On a publish-of-pending-changes the row is
		// already active, the flip no-ops, the column keeps the upsert key, and the
		// redelivery dedupes exactly (that is the shape T3 runs against).
		expect(second.idempotencyKey).toBe(`products:${id}:${T2}`);
		expect(second.title).toBe(first.title);
		expect(second.contentUpdatedAt).toBe(first.contentUpdatedAt);
		expect(second.active).toBe(true);
		expect(second.activeUpdatedAt).toBe(first.activeUpdatedAt);
		// The two key-spaces are disjoint — a collision would make a gate flip look
		// like an already-applied content write.
		expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
	});

	test("T13 afterPublish for a non-products collection is a no-op", async () => {
		const id = pid("page-1");

		await afterPublish(publishedClean(id, T2), "pages");

		expect(await readDoc(id)).toBeNull();
		expect(productCalls.calls).toEqual([]);
	});

	test("T14 afterPublish of a product that was NEVER PRICED still upserts a bare row and still activates (§4.4)", async () => {
		const id = pid("p14");

		await afterPublish(publishedClean(id, T2));

		// Before PR 1b there was no commerce field on this document, so the hook
		// upserted NOTHING and the activate hit a nonexistent row (a no-op). Now
		// the row is minted first and the flip lands: the product is active while
		// commerce-incomplete, and therefore still not purchasable (the store's
		// catalog read filters it — pinned in the store contract against a real
		// database).
		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.contentUpdatedAt).toBe(T2);
		expect(doc.sku).toBeNull();
		expect(doc.price).toBeNull();
		expect(doc.active).toBe(true);
	});

	test("T15 a pending-draft save changes NOTHING live-affecting — no upsert AND no activate", async () => {
		const id = pid("p15");
		// The row exists and is DEACTIVATED: the state where a stray activate would
		// do real damage, and the one an "is the row absent?" assertion cannot see.
		await seedRow(id);
		productCalls.reset();

		await afterSave(pendingDraft(id, "Renamed Mug"));

		// An activate is itself a live-affecting flip: on a pending-draft save of
		// a row that was deactivated it would re-latch the product purchasable
		// with no publish.
		const doc = await requireDoc(id);
		expect(doc.active).toBe(false);
		expect(doc.title).toBe(OLD_TITLE);
		expect(productCalls.calls).toEqual([]);
	});

	test("T16 §2.2 hole: an imported / create-with-status LIVE row defers too", async () => {
		const id = pid("p16");

		await afterSave(importedLive(id, "Renamed Mug"));
		expect(await readDoc(id)).toBeNull();
		expect(productCalls.calls).toEqual([]);

		await afterPublish(publishedClean(id, T2, "Renamed Mug"));
		const doc = await requireDoc(id);
		expect(doc.title).toBe("Renamed Mug");
		expect(doc.active).toBe(true);
	});

	test("T17 JOINT QA REGRESSION: nothing changes on save; the rename applies at publish, and the PRICE survives it", async () => {
		const id = pid("qa-1");
		// A product the merchant priced in Pricing & inventory and then edited in
		// the CMS — the reported flow, end to end.
		await seedRow(id, { priced: true, active: true });
		const before = await requireDoc(id);

		await afterSave(pendingDraft(id, "Renamed Mug"));

		// Nothing changed live — the order pipeline keeps the old snapshot source.
		const onSave = await requireDoc(id);
		expect(onSave.title).toBe(OLD_TITLE);
		expect(onSave.updatedAt).toBe(before.updatedAt); // not even a touch.

		// "Publish changes" — content and its order-line snapshot land together.
		await afterPublish(publishedClean(id, T2, "Renamed Mug"));
		const after = await requireDoc(id);
		expect(after.title).toBe("Renamed Mug");
		expect(after.active).toBe(true);
		// AND NOTHING COMMERCIAL: the price the merchant set in Pricing &
		// inventory is untouched by this publish. That reversion is exactly what
		// PR 1b removed — and asserting the stored columns is a stronger statement
		// of it than the old "the PUT body had no `price` key", because a preserved
		// column and an absent wire field were two different facts.
		expect(after.sku).toBe(before.sku);
		expect(after.price).toEqual(before.price);
		expect(after.taxClass).toBe(before.taxClass);
		expect(after.productKind).toBe(before.productKind);
	});

	test("T18 TITLE SYNC: the publish-time upsert stores data.title (the shared derive feeds BOTH hooks)", async () => {
		const id = pid("p18");

		await afterPublish(publishedClean(id, T2));

		// Without this the row is born `title = NULL` and `createOrderFromCart`
		// rejects every checkout with PRODUCT_NOT_PRICED.
		expect((await requireDoc(id)).title).toBe(TITLE);
	});

	test("T19 an ABSENT data.title at publish still upserts the row and still activates — a title problem never blocks a publish", async () => {
		const id = pid("p19");

		const content = publishedClean(id, T2);
		delete (content["data"] as Record<string, unknown>)["title"];
		const outcome = await afterPublish(content);

		// The title is best-effort: it is omitted from the write and logged, and
		// the row is still created/refreshed. Vetoing the upsert here would mean a
		// collection whose title field is missing or named something else never
		// gets a product_commerce row at all — it would vanish from Pricing &
		// inventory, a worse failure than an untitled, unpurchasable product.
		const doc = await requireDoc(id);
		expect(doc.title).toBeNull();
		expect(doc.contentUpdatedAt).toBe(T2);
		expect(doc.active).toBe(true);
		expect(outcome).toEqual({ result: null });
	});
});
