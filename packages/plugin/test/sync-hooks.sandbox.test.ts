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
	type ProductVariantDoc,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/**
 * ONE HOME PER FIELD (PR 1b). These hooks used to derive a whole commerce bag
 * (sku, price, currency, stock, kind, tax class, dimensions) out of a
 * `commerce` JSON field on the content document, written by an on-screen
 * "Product data" Block Kit widget. That made the CMS a SECOND writer of
 * `product_commerce` and every publish reverted the admin console's edits.
 *
 * The bag is gone. What remains is LIFECYCLE + TITLE:
 *  - every save/publish of a products document upserts, so the row always
 *    exists and the product is visible in Pricing & inventory;
 *  - the sync carries the content's `data.title` and the ordering watermark,
 *    AND NOTHING ELSE — the real regression guard for that merge;
 *  - activate / deactivate / soft-delete are unchanged.
 *
 * WHAT INC-D3a CHANGED IN THIS SUITE, AND WHY IT GOT STRONGER. The hooks used
 * to reach `@otta-sh/service` over `ctx.http`, so every case here asserted the
 * WIRE: which url each hook hit, which `Idempotency-Key` header it carried, and
 * — the headline guard — the exact key set of the PUT body, against a ban list
 * of commercial field names. That deployment is retired; the hooks now run the
 * same store writes IN PROCESS, so there is no request to record and those
 * assertions describe a transport that no longer exists.
 *
 * They are not weakened into shape checks against a local object. Every one is
 * re-targeted at the STORED DOCUMENT, which is what the wire body was only ever
 * a proxy for, and two of them get strictly stronger in the move:
 *
 *  - THE SECOND-WRITER GUARD. "The body carries no `sku` key" is now "a save of
 *    a PRICED product leaves its sku, price, tax class, kind and dimensions
 *    byte-identical" — the actual ADR-0013 claim, which the key-set check could
 *    only approximate (the store PRESERVES an omitted field, so an absent key
 *    and an unchanged column were two different facts and only one was pinned).
 *  - THE IDEMPOTENCY KEYS. They were asserted as header strings; they are now
 *    read off the row the store stamped them on, AND their effect is asserted —
 *    a delivery that reuses a stored key does not change the title, which is the
 *    thing the key exists to cause.
 *
 * Deleted outright: the "503 from the service" case (there is no service to
 * answer 503; its successor injects a real storage fault at the collection
 * seam), and the request-COUNT assertions, whose in-process successor is the
 * instrumented collection's call log — `listVariants` is the only reader on
 * these paths that uses `get`, so "the drop-set read was never taken" is
 * exactly "this save made no `get` call".
 *
 * NO ALLOWED HOSTS AT ALL on the boot below: a hook that tried to reach a
 * network would throw, and since both hooks are fire-and-forget that would
 * surface as a MISSING row rather than a failure. Every assertion that a row
 * ends up in the right state is therefore also a proof that no egress happened.
 */

/** Every id here is suffixed, because the document store is shared by every
 *  sandbox suite in this process (see `sandbox/storage-bridge.ts`). */
function pid(name: string): string {
	return `${name}-sh`;
}

/** The save/publish watermark every fixture content record carries. */
const WM = "2026-07-10T00:00:00.000Z";

/** A watermark STRICTLY OLDER than `WM`, for rows a case seeds before the hook
 *  runs: the upsert's ordering guard drops a delivery whose watermark is older
 *  than the stored one, and the variant resurrect applies only on a strictly
 *  newer one, so a fixture seeded at `WM` would silently neuter its own case. */
const SEEDED_WM = "2026-07-01T00:00:00.000Z";

/**
 * The product title, which lives at `content.data.title` — NOT at the top
 * level. em-dash's `ContentItem` (`packages/core/src/database/repositories/
 * types.ts`) has no `title` member at all: `mapRow()` puts every column that is
 * not in `SYSTEM_COLUMNS` into `data`, and `title` is an ordinary user-defined
 * collection field (see `sites/staging/seed/seed.json`, which declares it on
 * `products`). `contentItemToRecord = { ...item }` passes that item through
 * verbatim, so a hook payload carries `data.title`, never `content.title`.
 */
const TITLE = "Blue Mug";

/** One operation log for the instrumented collection. */
interface CollectionCalls {
	/** Every method name the plugin invoked, in order. */
	readonly calls: string[];
	/** The id of each `get`. On these paths `get` has exactly ONE caller —
	 *  `listVariants`, the drop-set read — so this IS the read the variant sync's
	 *  conservative branches are required not to take. */
	readonly gets: string[];
	/** While set, every call to this method throws instead of running — a
	 *  database fault injected at the seam the store itself uses. */
	failOn: string | null;
	reset(): void;
}

let sandboxHandle: SandboxHandle;
let storage: StorageAccess;
let productCalls: CollectionCalls;
/** The product collection as it was BEFORE instrumentation. Every assertion
 *  below reads through this rather than through `storage`, because the proxy
 *  cannot tell the plugin's reads from the test's own — and several cases turn
 *  on the plugin having taken no read at all. */
let rawProducts: NonNullable<(typeof storage)[string]>;

/**
 * Replace the product collection on the shared store with a recording proxy.
 * Every method still reaches the real repository — this observes (and, when
 * asked, fails) without replacing the database the suite runs against. The
 * bridge resolves `storage[name]` per request, so the proxy sees every operation
 * the plugin performs inside workerd.
 */
function instrument(name: string): CollectionCalls {
	const target = storage[name];
	if (target === undefined) throw new Error(`no '${name}' collection to instrument`);
	const calls: string[] = [];
	const gets: string[] = [];
	const log: CollectionCalls = {
		calls,
		gets,
		failOn: null,
		reset() {
			calls.length = 0;
			gets.length = 0;
			this.failOn = null;
		},
	};
	storage[name] = new Proxy(target, {
		get(_holder, property) {
			const value = Reflect.get(target, property) as unknown;
			if (typeof value !== "function") return value;
			const bound = (value as (...args: unknown[]) => unknown).bind(target);
			return (...args: unknown[]) => {
				calls.push(String(property));
				if (property === "get") gets.push(String(args[0]));
				if (log.failOn === property) throw new Error("injected storage fault");
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

/** The row a case asserts on — absent is always a failure, never a null check
 *  the assertion then has to carry. */
async function requireDoc(id: string): Promise<ProductCommerceDoc> {
	const doc = await readDoc(id);
	if (doc === null) throw new Error(`no product_commerce row for ${id}`);
	return doc;
}

/** The embedded variants map. Defaulted because a document written by a path
 *  that predates the map may lack it (`normalizeProductDoc`'s own reason). */
function variantsOf(doc: ProductCommerceDoc): Record<string, ProductVariantDoc> {
	return doc.variants ?? {};
}

async function requireVariant(id: string, key: string): Promise<ProductVariantDoc> {
	const variant = variantsOf(await requireDoc(id))[key];
	if (variant === undefined) throw new Error(`no variant '${key}' on ${id}`);
	return variant;
}

/** The variant keys a product's row holds, sorted so a case never pins the
 *  store's map ordering. */
async function variantKeys(id: string): Promise<string[]> {
	const doc = await readDoc(id);
	return doc === null ? [] : Object.keys(variantsOf(doc)).toSorted();
}

/** A pre-existing PRICED row — the state the second-writer guard is about. Seeded
 *  with NO `contentUpdatedAt`, so the hook's own watermark is never "older than
 *  stored" and the ordering guard cannot silently swallow the case. */
async function seedPricedRow(id: string, skuText: string): Promise<void> {
	await commerceStore().upsert(
		{
			productId: toProductId(id),
			sku: toSku(skuText),
			price: { amount: cents(1999), currency: currency("USD") },
			title: "Priced by the admin",
			taxClass: "standard",
			weightGrams: 250,
			lengthMm: 100,
			widthMm: 80,
			heightMm: 90,
			productKind: "physical",
		},
		idempotencyKey(`seed-${id}`),
	);
}

async function seedVariant(id: string, key: string, title: string | null): Promise<void> {
	await commerceStore().upsertVariant(
		{ productId: toProductId(id), variantKey: key, title, contentUpdatedAt: SEEDED_WM },
		idempotencyKey(`seed-${id}-${key}`),
	);
}

async function seedOrphanedVariant(id: string, key: string, title: string | null): Promise<void> {
	await seedVariant(id, key, title);
	await commerceStore().deactivateVariant(
		toProductId(id),
		key,
		idempotencyKey(`seed-orphan-${id}-${key}`),
		SEEDED_WM,
	);
}

/**
 * A saved products content record — the shape `content:afterSave` actually
 * receives (`contentItemToRecord(item)`). Pass `title: null` for a collection
 * entry whose title column is null/absent: `mapRow()` EXCLUDES null values from
 * `data`, so that surfaces to the plugin as a MISSING key, never an explicit
 * `null`.
 *
 * `version` is emitted top-level by em-dash's `mapRow` and passed through by
 * `contentItemToRecord = { ...item }`, so every hook sees it. It defaults to 1;
 * tests modelling successive saves must BUMP IT rather than move `updatedAt`
 * (0.31.1 freezes `updatedAt` on draft-only saves) — see `unpublishedDraft`.
 */
function productContent(
	id: string,
	extra: Record<string, unknown> = {},
	title: string | null = TITLE,
	extraData: Record<string, unknown> = {},
): Record<string, unknown> {
	const data: Record<string, unknown> = { ...extraData };
	if (title !== null) data["title"] = title;
	return {
		id,
		updatedAt: WM,
		version: 1,
		...(Object.keys(data).length > 0 ? { data } : {}),
		...extra,
	};
}

/**
 * A save of an UNPUBLISHED product on a revision-supporting collection — the
 * one shape whose sync `content:afterSave` still pushes immediately (publish
 * atomicity defers everything that is already live).
 *
 * `hasPendingDraft` is false here by clause 2: `draftRevisionId` is set but
 * `liveRevisionId` is null and `status` is not `"published"`.
 *
 * CRITICAL — this models em-dash **0.31.1**, not 0.29.0: since `8d6b20b`
 * ("draft-only saves no longer bump updated_at on published entries", #2143,
 * shipped 0.30.0) a save that resolves to a column no-op leaves `updated_at`
 * UNTOUCHED and bumps `version` only. So successive saves share one
 * `updatedAt` and are distinguished ONLY by `version`.
 */
function unpublishedDraft(
	id: string,
	version: number,
	title: string = TITLE,
): Record<string, unknown> {
	return productContent(
		id,
		{ status: "draft", liveRevisionId: null, draftRevisionId: `rev-${version}`, version },
		title,
	);
}

function afterSave(
	content: Record<string, unknown>,
	collection = "products",
): Promise<{ result: unknown } | { error: string }> {
	return sandboxHandle.invokeHook("content:afterSave", { content, collection, isNew: false });
}

function afterPublish(
	content: Record<string, unknown>,
	collection = "products",
): Promise<{ result: unknown } | { error: string }> {
	return sandboxHandle.invokeHook("content:afterPublish", { content, collection });
}

/** THE SECOND-WRITER GUARD on a row the sync CREATED: every commercial column is
 *  still at its default, so the CMS path invented none of them. The wire-body key
 *  set this replaces could only say "the key was absent"; this says the column is
 *  untouched, which is the fact ADR-0013 is actually about. */
function expectNothingCommercial(doc: ProductCommerceDoc): void {
	expect(doc.sku).toBeNull();
	expect(doc.price).toBeNull();
	expect(doc.taxClass).toBeNull();
	expect(doc.weightGrams).toBeNull();
	expect(doc.lengthMm).toBeNull();
	expect(doc.widthMm).toBeNull();
	expect(doc.heightMm).toBeNull();
	expect(doc.productKind).toBe("physical");
	// EDIT-ONLY columns: not on the sync's input type at all, so a fresh row starts
	// at their defaults and no save can move them.
	expect(doc.compareAtPrice).toBeNull();
	expect(doc.unitCost).toBeNull();
	expect(doc.inventoryPolicy).toBe("deny");
	// The lifecycle flags are the guarded activate/deactivate/softDelete calls'
	// business — the upsert must never carry them.
	expect(doc.deletedAt).toBeNull();
}

beforeAll(async () => {
	({ storage } = await storageBridge());
	const products = storage[PRODUCT_COMMERCE_COLLECTION];
	if (products === undefined) throw new Error("no product_commerce collection");
	rawProducts = products;
	productCalls = instrument(PRODUCT_COMMERCE_COLLECTION);
	// NO allowed hosts — see the module doc's egress note.
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

describe("sync hooks — afterSave keeps product_commerce alive and its title current (PR 1b, workerd sandbox)", () => {
	test("a products save upserts the TITLE and the ordering watermark, and NOTHING commercial", async () => {
		const id = pid("prod-1");

		const outcome = await afterSave(productContent(id));

		expect(outcome).toEqual({ result: null });
		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.contentUpdatedAt).toBe(WM);
		expect(doc.idempotencyKey).toBe(`products:${id}:${WM}:1`);
		expectNothingCommercial(doc);
	});

	test("THE SECOND-WRITER GUARD: a save of a PRICED product leaves every admin-owned column byte-identical", async () => {
		const id = pid("prod-priced");
		await seedPricedRow(id, "SKU-SH-PRICED");
		const before = await requireDoc(id);

		// The case ADR-0013 exists for: the merchant priced the product in Pricing &
		// inventory, then edited its description in the CMS. Before 1b this save
		// re-sent a whole commerce bag derived from a content widget and reverted the
		// console's edit. The row must come back with only the title cache and the
		// watermark moved.
		await afterSave(productContent(id, {}, "Renamed in the CMS"));

		const after = await requireDoc(id);
		expect(after.title).toBe("Renamed in the CMS");
		expect(after.contentUpdatedAt).toBe(WM);
		expect(after.sku).toBe(before.sku);
		expect(after.price).toEqual(before.price);
		expect(after.taxClass).toBe("standard");
		expect(after.weightGrams).toBe(250);
		expect(after.lengthMm).toBe(100);
		expect(after.widthMm).toBe(80);
		expect(after.heightMm).toBe(90);
		expect(after.productKind).toBe("physical");
		expect(after.compareAtPrice).toBeNull();
		expect(after.unitCost).toBeNull();
		expect(after.inventoryPolicy).toBe("deny");
	});

	test("THE INVISIBLE-PRODUCT FIX: a save carrying nothing but a title still upserts — every CMS product gets a row", async () => {
		const id = pid("prod-bare");

		// Before 1b this returned early ("no commerce field" / "no sku"), so the
		// product had NO product_commerce row and was invisible in Pricing &
		// inventory — there was no way to price it from the console at all.
		await afterSave(productContent(id));

		const doc = await requireDoc(id);
		expect(doc.lifecycle).toBe("live"); // readable, and therefore listable.
		expect(doc.title).toBe(TITLE);
		expectNothingCommercial(doc);
	});

	test("a stale `commerce` bag left on an OLD content document is IGNORED — a pre-upgrade site never re-clobbers the console", async () => {
		const id = pid("prod-legacy");
		await seedPricedRow(id, "SKU-SH-LEGACY");

		// em-dash's seed applier never deletes a field the seed stopped declaring, so
		// a site seeded before this release keeps an unbound `commerce` json field
		// holding the old bag (see the upgrade note). Nothing may read it.
		await afterSave(
			productContent(id, {}, TITLE, {
				commerce: { sku: "SKU-OLD", price: 9900, currency: "USD", onHand: 5 },
			}),
		);

		const doc = await requireDoc(id);
		expect(doc.sku).toBe("SKU-SH-LEGACY");
		expect(doc.price).toEqual({ amount: 1999, currency: "USD" });
		expect(doc.title).toBe(TITLE); // only the title cache moved.
	});

	test("REDELIVERY of the same save reuses the idempotency key (the store dedupes it); a genuinely NEWER save mints a fresh one that applies", async () => {
		const id = pid("prod-2");

		// A redelivery is the IDENTICAL record replayed: em-dash captures one
		// `content` object per write and hands that same object to every hook
		// consumer (`runAfterSaveHooks`), with no DB re-read per delivery — so a
		// retry carries the same `updatedAt` AND the same `version`.
		await afterSave(unpublishedDraft(id, 3));
		expect((await requireDoc(id)).idempotencyKey).toBe(`products:${id}:${WM}:3`);

		// The key's EFFECT, which the old header assertion could only imply: a
		// delivery whose (updatedAt, version) is unchanged cannot move the row, even
		// carrying a different payload. That is the store's replay guard, and it is
		// why the key must stay derived from the delivery rather than the payload.
		await afterSave(unpublishedDraft(id, 3, "Smuggled rename"));
		expect((await requireDoc(id)).title).toBe(TITLE);

		// A genuinely newer save. `updatedAt` is deliberately held CONSTANT: on
		// em-dash 0.31.1 a draft-only save is a column no-op and does not stamp
		// `updated_at` (8d6b20b, #2143) — only `version` moves.
		await afterSave(unpublishedDraft(id, 4, "Blue Mug, Large"));
		const doc = await requireDoc(id);
		expect(doc.title).toBe("Blue Mug, Large");
		expect(doc.idempotencyKey).toBe(`products:${id}:${WM}:4`);
	});

	test("0.31.1 FROZEN updatedAt: two successive draft saves with a CHANGED title BOTH apply (emdash 8d6b20b / #2143)", async () => {
		const id = pid("prod-frozen");

		// On em-dash 0.31.1 BOTH saves carry the identical `updatedAt` (the draft
		// save is a column no-op, so `updated_at` is never stamped); only `version`
		// advances.
		await afterSave(unpublishedDraft(id, 2, "Blue Mug"));
		await afterSave(unpublishedDraft(id, 3, "Cobalt Mug"));

		const doc = await requireDoc(id);
		// THE ASSERTION THAT MATTERS: the second save landed. `upsert` no-ops a write
		// whose key equals the stored one, so a key derived from `updatedAt` alone
		// would SILENTLY DROP the merchant's rename on em-dash >= 0.30.0. It is also
		// why the key must NOT become payload-derived: a same-key no-op suppresses
		// the whole DO UPDATE SET, including `contentUpdatedAt`, freezing the
		// ordering watermark.
		expect(doc.title).toBe("Cobalt Mug");
		expect(doc.idempotencyKey).toBe(`products:${id}:${WM}:3`);
		// Both saves carried the SAME watermark — the freeze this test exists for.
		expect(doc.contentUpdatedAt).toBe(WM);
	});

	// -- TITLE SYNC: the order-line snapshot, and now the ONLY synced field ----
	// SINCE PR 1c THIS BLOCK IS LOAD-BEARING FOR ADR-0013. It is the positive
	// statement of the decision: the content sync is the SOLE writer of
	// `product_commerce.title`, so if these cases stop asserting that the save
	// lands `data.title` in the row, nothing writes the column at all and every
	// order line is born untitled. Since INC-D3a they assert the STORED value
	// directly, which is what the old "the PUT body carried it" was standing in
	// for (the stored half then needed a live server + Postgres to reach).
	//
	// Confirmed live: a product created through the CMS was born with
	// `product_commerce.title = NULL`, and `createOrderFromCart` rejects a null
	// title with PRODUCT_NOT_PRICED — the product was PERMANENTLY UNPURCHASABLE
	// and the buyer saw a checkout failure. The title is a user-defined
	// collection field, so it arrives at `content.data.title`.
	test("TITLE SYNC REGRESSION: the save lands data.title on the row (a NULL title makes checkout fail with PRODUCT_NOT_PRICED)", async () => {
		const id = pid("prod-title");

		await afterSave(productContent(id));

		expect((await requireDoc(id)).title).toBe(TITLE);
	});

	test("data.title is the SINGLE source of truth, and it is TRIMMED", async () => {
		const id = pid("prod-trim");

		await afterSave(productContent(id, {}, "  Blue Mug  "));

		expect((await requireDoc(id)).title).toBe("Blue Mug");
	});

	// THE LOAD-BEARING GUARD (review): an unusable title must NEVER block the
	// sync. If a title problem could veto the upsert, then any collection whose
	// title field is missing or named something else would silently lose its
	// product_commerce row entirely — the product would vanish from Pricing &
	// inventory, which is a worse regression than an untitled product.
	test("an EMPTY / whitespace-only / ABSENT data.title never blocks the sync — the row is still created, only `title` is omitted", async () => {
		const cases: Array<readonly [string, string | null]> = [
			[pid("prod-empty-title"), ""],
			[pid("prod-blank-title"), "   \t "],
			// `mapRow` drops null columns from `data`, so a null title column and a
			// collection with no `title` field at all look identical here.
			[pid("prod-absent-title"), null],
		];
		for (const [id, title] of cases) {
			const outcome = await afterSave(productContent(id, {}, title));
			expect(outcome).toEqual({ result: null }); // never fails the CMS save.
		}

		// …and a collection that declares `title` as something other than a string
		// (em-dash field types are the merchant's choice) is the same non-fatal case.
		const numericId = pid("prod-numeric-title");
		const numeric = productContent(numericId, {}, null);
		numeric["data"] = { title: 42 };
		await afterSave(numeric);

		for (const id of [...cases.map(([each]) => each), numericId]) {
			const doc = await requireDoc(id);
			// The row is still created — the watermark rides alone — and no empty or
			// blank title is stored: `""` is not a title, and a row that held one would
			// pass `createOrderFromCart`'s null check while printing nothing on the
			// receipt it snapshots.
			expect(doc.lifecycle).toBe("live");
			expect(doc.title).toBeNull();
			expect(doc.contentUpdatedAt).toBe(WM);
		}
	});

	test("a title longer than the store's 500-char bound is omitted — a data problem never overwrites a good stored name", async () => {
		const okId = pid("prod-title-500");
		const overId = pid("prod-title-501");
		// The over-long case runs against a row that ALREADY HAS a title, because
		// "omitted" only means something against a stored value: an omitted field is
		// preserved, and it is that preservation — not the absence of a wire key —
		// that keeps the merchant's last good name on the column an order line
		// snapshots.
		await seedPricedRow(overId, "SKU-SH-LONGTITLE");

		await afterSave(productContent(okId, {}, "T".repeat(500)));
		await afterSave(productContent(overId, {}, "T".repeat(501)));

		expect((await requireDoc(okId)).title).toBe("T".repeat(500)); // exactly at the bound.
		expect((await requireDoc(overId)).title).toBe("Priced by the admin");
		// …and the row is still refreshed, so the sync is not withheld over it.
		expect((await requireDoc(overId)).contentUpdatedAt).toBe(WM);
	});

	test("HEAL ON RE-SAVE: an existing NULL-title row gets its title on the merchant's next save (a fresh updatedAt ⇒ a fresh key ⇒ the upsert applies)", async () => {
		const id = pid("prod-heal");
		const healedAt = "2026-07-10T03:00:00.000Z";
		// The row already exists, created before title sync — title NULL, and
		// therefore unorderable.
		await commerceStore().upsert(
			{ productId: toProductId(id), sku: toSku("SKU-SH-HEAL") },
			idempotencyKey(`seed-${id}`),
		);
		expect((await requireDoc(id)).title).toBeNull();

		// em-dash bumps `updated_at` on every content write that touches a column, so
		// the merchant's next save carries a strictly newer watermark and a key
		// nothing has stored…
		await afterSave(productContent(id, { updatedAt: healedAt }));

		const healed = await requireDoc(id);
		// …so the store's DO UPDATE SET writes the title (an upsert only PRESERVES it
		// when the field is omitted).
		expect(healed.title).toBe(TITLE);
		expect(healed.idempotencyKey).toBe(`products:${id}:${healedAt}:1`);

		// HONEST LIMIT: a REDELIVERY of the same save derives the same key and the
		// store dedupes it — a redelivery does not heal anything. Only a real
		// save/publish (which bumps `updatedAt`, or at least `version`) does. The row
		// is untouched, down to its `updatedAt` stamp.
		await afterSave(productContent(id, { updatedAt: healedAt }, "Would-be rename"));
		const replayed = await requireDoc(id);
		expect(replayed.title).toBe(TITLE);
		expect(replayed.updatedAt).toBe(healed.updatedAt);
	});

	// -- issue #82: afterSave activates an already-published product ------------
	test("a PUBLISHED product is activated in the same save — through the guarded flip, never an `active` field on the upsert", async () => {
		const id = pid("prod-pub");

		await afterSave(productContent(id, { status: "published" }));

		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.active).toBe(true);
		// The gate's own watermark, which is deliberately NOT the sync watermark: a
		// plain content save advances that one without being a lifecycle event.
		expect(doc.activeUpdatedAt).toBe(WM);
		// The key the flip stamped is the PUBLISH key-space, disjoint from the save
		// key the upsert used a moment earlier — both contend for one per-row
		// `idempotencyKey` column. Its presence is also the ordering proof: `activate`
		// no-ops on an unknown id, so the upsert must have landed first.
		expect(doc.idempotencyKey).toBe(`products:${id}:published:${WM}`);
	});

	test("A SOFT-DELETED row is never resurrected by a published save — the tombstone survives both the upsert and the activate", async () => {
		const id = pid("prod-tombstone");
		await seedPricedRow(id, "SKU-SH-TOMB");
		await commerceStore().softDelete(toProductId(id), idempotencyKey(`seed-del-${id}`));

		await afterSave(productContent(id, { status: "published" }));

		// THE HAZARD THE DEDICATED FLIP CLOSES. Routing activation through `activate`
		// rather than an `active: true` field on the upsert is what makes this a
		// no-op: the store refuses the flip on a tombstone. An upsert carrying the
		// flag would have re-latched a deleted product purchasable.
		const doc = await requireDoc(id);
		expect(doc.lifecycle).toBe("deleted");
		expect(doc.deletedAt).not.toBeNull();
		expect(doc.active).toBe(false);
	});

	// §4.4 — THE STATE 1b CREATES. Before this merge a published, unpriced,
	// sku-less product got no row at all, so the activate had nothing to flip.
	// Now the row is minted first and the activate always lands: the product is
	// `active: true` while being unsellable. That is benign for purchasability
	// (the catalog read filters commerce-incomplete rows — pinned in
	// `product-commerce-store-contract.ts` against a real database) but it IS a
	// new state, and the admin's status column says "active (not priced)".
	test("§4.4 ACTIVATION CHANGE: publishing a product that was never priced now creates a bare row AND activates it", async () => {
		const id = pid("prod-unpriced");

		await afterPublish(productContent(id, { status: "published" }));

		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.active).toBe(true);
		// The row carries NO sku and NO price — it is commerce-incomplete, and the
		// publish gate says nothing about that.
		expect(doc.sku).toBeNull();
		expect(doc.price).toBeNull();
	});

	test("a DRAFT (or status-less) product is NOT activated — the row stays behind the publish gate", async () => {
		const draftId = pid("prod-draft");
		const noStatusId = pid("prod-nostatus");

		await afterSave(productContent(draftId, { status: "draft" }));
		await afterSave(productContent(noStatusId));

		for (const id of [draftId, noStatusId]) {
			const doc = await requireDoc(id);
			expect(doc.active).toBe(false);
			expect(doc.activeUpdatedAt).toBeNull(); // no lifecycle event happened at all.
		}
	});

	test("afterSave's activation and content:afterPublish's CONVERGE on one gate state (they share the publish key)", async () => {
		const id = pid("prod-conv");
		const content = productContent(id, { status: "published" });

		await afterSave(content);
		const first = await requireDoc(id);
		await afterSave(content);
		await afterPublish(content);

		// The same delivery reaching the gate three times leaves exactly the state
		// one delivery does: the flip is a no-op once the row is already in the
		// target state, and the shared `:published:` key means even a store that
		// deduped on the key alone would agree. (That the key IS the publish one is
		// asserted above, on a single delivery, where nothing else could have
		// stamped it.)
		const doc = await requireDoc(id);
		expect(doc.active).toBe(true);
		expect(doc.activeUpdatedAt).toBe(first.activeUpdatedAt);
		expect(doc.activeUpdatedAt).toBe(WM);
	});

	test("a STORAGE FAULT does not throw into the CMS save path — the hook resolves and the sync is simply lost", async () => {
		const id = pid("prod-fault");

		// The successor to the old "the service answered 503" case: there is no
		// service to answer, so the failure is injected where the store actually
		// touches the database. Same posture on the plugin's side — fire-and-forget,
		// logged, never thrown — and the same honest consequence: no reconcile cron
		// exists, so the sync is lost until the product is saved again.
		productCalls.failOn = "getVersioned";
		const outcome = await afterSave(productContent(id));
		productCalls.failOn = null;

		expect(outcome).toEqual({ result: null });
		expect(await readDoc(id)).toBeNull();

		// …and the next save heals it, because the upsert is idempotent and replay-safe.
		await afterSave(productContent(id));
		expect((await requireDoc(id)).title).toBe(TITLE);
	});

	test("content:afterDelete soft-deletes the product_commerce row", async () => {
		const id = pid("prod-3");
		await seedPricedRow(id, "SKU-SH-DELETE");

		const outcome = await sandboxHandle.invokeHook("content:afterDelete", {
			id,
			collection: "products",
			permanent: false,
		});

		expect(outcome).toEqual({ result: null });
		const doc = await requireDoc(id);
		// SOFT delete on both trash and permanent delete: order history integrity
		// (plan §4/§8 Risk 6). The row is retained, with its sku and price.
		expect(doc.lifecycle).toBe("deleted");
		expect(doc.deletedAt).not.toBeNull();
		expect(doc.active).toBe(false);
		expect(doc.sku).toBe("SKU-SH-DELETE");
		// `afterDelete` carries no `updatedAt`, so its key is the stable per-id one —
		// repeated deletes of the same id collapse to one applied write.
		expect(doc.idempotencyKey).toBe(`products:${id}:deleted`);
	});

	test("afterSave/afterDelete for a non-products collection are no-ops — the store is not even read", async () => {
		const id = pid("page-1");

		await afterSave(productContent(id), "pages");
		await sandboxHandle.invokeHook("content:afterDelete", {
			id,
			collection: "pages",
			permanent: false,
		});

		expect(await readDoc(id)).toBeNull();
		// The collection guard is the FIRST statement in both handlers, so a
		// non-products delivery costs not one storage operation.
		expect(productCalls.calls).toEqual([]);
	});
});

/**
 * THE CMS REPEATER IS THE VARIANT NAME (ADR-0016) — the sync half.
 *
 * A product's sizes are declared in ONE content field: a repeater whose rows
 * carry a stable key and a display name, and nothing commercial. This block
 * pins what the sync does with it — that each declared row reaches the store
 * with the save's own watermark, that a row the merchant DELETES deactivates its
 * commerce variant rather than removing it, and above all that a document with
 * no repeater is untouched by any of it.
 *
 * `listVariants` — the drop-set read — is the ONLY caller of the collection's
 * `get` on these paths (every writer uses `getVersioned`). So "the sync must not
 * even look" is asserted exactly, as an empty `productCalls.gets`.
 */
describe("sync hooks — the variant repeater declares presence and the name cache (ADR-0016, workerd sandbox)", () => {
	const VARIANTS = [
		{ key: "small", name: "Small" },
		{ key: "large", name: "Large" },
	];

	test("THE LIVE CATALOGUE'S PATH: a product with NO repeater does exactly what it always did — the drop set is not even read", async () => {
		const id = pid("prod-no-repeater");

		await afterSave(productContent(id));

		// THE REGRESSION GUARD FOR THIS WHOLE INCREMENT. Every product in the live
		// catalogue is in this state, so the claim has to cover the WORK DONE, not
		// merely "no variant was written": a drop-set read fired speculatively here
		// would be a per-save round trip added to every product in the store, and a
		// `[]` repeater read as "delete every size" would be catastrophic.
		expect(variantsOf(await requireDoc(id))).toEqual({});
		expect(productCalls.gets).toEqual([]);
	});

	test("each repeater row is DECLARED — under its key, with the display name and the save's watermark, and nothing commercial", async () => {
		const id = pid("prod-v");

		await afterSave(productContent(id, {}, TITLE, { variants: VARIANTS }));

		expect(await variantKeys(id)).toEqual(["large", "small"]);
		const small = await requireVariant(id, "small");
		expect(small.title).toBe("Small");
		expect(small.contentUpdatedAt).toBe(WM);
		expect(small.orphanedAt).toBeNull();
		// `sku` and `price` are absent from the declare's input type by design
		// (ADR-0016) — the runtime half of that ladder is that a declared size is
		// born unpriced and un-skued: the CMS declares, the admin prices.
		expect(small.sku).toBeNull();
		expect(small.price).toBeNull();
		expect((await requireVariant(id, "large")).title).toBe("Large");
		// Distinct keys per row: the store's replay guard is PER VARIANT, so one key
		// across two sizes would drop the second declare of every save.
		expect(small.idempotencyKey).toBe(`products:${id}:variant:small:${WM}:1`);
		expect((await requireVariant(id, "large")).idempotencyKey).toBe(
			`products:${id}:variant:large:${WM}:1`,
		);
		// The product's own title sync is untouched.
		expect((await requireDoc(id)).title).toBe(TITLE);
	});

	test("DELETING A ROW DEACTIVATES ITS VARIANT ON THE SAME SAVE — never deletes it", async () => {
		const id = pid("prod-drop");
		// The commerce side currently holds three live sizes; this save declares two
		// of them. "medium" is the row the merchant deleted.
		for (const key of ["small", "medium", "large"]) await seedVariant(id, key, key);

		await afterSave(productContent(id, {}, TITLE, { variants: VARIANTS }));

		// DEACTIVATION, NEVER DELETION: the row is still there, still named, and
		// (pinned against a real database in the store's own contract suite) still
		// holding its sku, price and stock — an orphan may still sit on live order
		// lines.
		expect(await variantKeys(id)).toEqual(["large", "medium", "small"]);
		const medium = await requireVariant(id, "medium");
		expect(medium.orphanedAt).not.toBeNull();
		expect(medium.title).toBe("medium");
		// The watermark rides the transition: presence has two opposing transitions
		// arriving independently, and only the watermark orders them.
		expect(medium.contentUpdatedAt).toBe(WM);
		expect(medium.idempotencyKey).toBe(`products:${id}:variant-orphaned:medium:${WM}:1`);
		// …and the two still-declared sizes were re-declared, not dropped.
		expect((await requireVariant(id, "small")).orphanedAt).toBeNull();
		expect((await requireVariant(id, "large")).orphanedAt).toBeNull();
	});

	test("the drop set is read AFTER the declares, so a resurrected key is never dropped by the save that brought it back", async () => {
		const id = pid("prod-order");
		await seedOrphanedVariant(id, "small", "Small");
		productCalls.reset();

		await afterSave(productContent(id, {}, TITLE, { variants: VARIANTS }));

		// The outcome IS the ordering proof: "small" was orphaned, this save declares
		// it again, and it comes back live. Had the live set been read first, "small"
		// would have been absent from it (the read is live rows only) and the
		// resurrect would have been followed by nothing; had it been read first and
		// the drop applied after, the save that restored the size would have orphaned
		// it again in the same breath.
		expect((await requireVariant(id, "small")).orphanedAt).toBeNull();
		// And the mechanism, at the storage seam: the drop-set read (`get`) happens
		// after at least one declare has committed (`compareAndSet`).
		expect(productCalls.gets.length).toBeGreaterThan(0);
		expect(productCalls.calls.indexOf("compareAndSet")).toBeLessThan(
			productCalls.calls.indexOf("get"),
		);
	});

	test("REDELIVERY reuses the declare and orphan keys (the store dedupes); a newer save mints fresh ones — and the two key-spaces never collide", async () => {
		const id = pid("prod-replay");
		await seedVariant(id, "medium", "Medium");

		const delivered = productContent(id, { version: 7 }, TITLE, { variants: VARIANTS });
		await afterSave(delivered);
		await afterSave(delivered);

		const small = await requireVariant(id, "small");
		const medium = await requireVariant(id, "medium");
		expect(small.idempotencyKey).toBe(`products:${id}:variant:small:${WM}:7`);
		expect(medium.idempotencyKey).toBe(`products:${id}:variant-orphaned:medium:${WM}:7`);
		// THE TWO TRANSITIONS NEVER SHARE A KEY-SPACE: they contend for one per-row
		// `idempotencyKey` column, and a collision would make a drop look like an
		// already-applied declare — a redelivered "the row is gone" would then orphan
		// a variant that has since come back.
		expect(medium.idempotencyKey).not.toBe(small.idempotencyKey);
		// The redelivery changed nothing, down to the stamp.
		expect(medium.orphanedAt).not.toBeNull();
		const untouched = await requireVariant(id, "small");
		expect(untouched.updatedAt).toBe(small.updatedAt);

		// A genuinely newer save (only `version` moves on em-dash 0.31.1) mints fresh
		// keys, so the merchant's rename actually applies.
		await afterSave(
			productContent(id, { version: 8 }, TITLE, {
				variants: [{ key: "small", name: "Small (petite)" }, VARIANTS[1]],
			}),
		);
		const renamed = await requireVariant(id, "small");
		expect(renamed.title).toBe("Small (petite)");
		expect(renamed.idempotencyKey).toBe(`products:${id}:variant:small:${WM}:8`);
	});

	test("AN ABSENT name sub-field PRESERVES the stored name — it never clears it", async () => {
		const id = pid("prod-absentname");
		await seedVariant(id, "a", "Kept");
		await seedVariant(id, "b", "Also kept");

		await afterSave(
			productContent(id, {}, TITLE, {
				variants: [{ key: "a" }, { key: "b", name: undefined }],
			}),
		);

		// THE DATA-LOSS GUARD. The name is a cache whose only writer is this channel,
		// so reading "the sub-field isn't there" as "the merchant cleared it" would
		// blank every stored variant name on every save of any document that stopped
		// carrying the sub-field — a renamed sub-field, an importer that never wrote
		// it, a partial API write. Worse, it is irreversible where it matters: every
		// order line placed afterwards freezes the blank, and the snapshot rule
		// forbids rewriting it.
		expect((await requireVariant(id, "a")).title).toBe("Kept");
		expect((await requireVariant(id, "b")).title).toBe("Also kept");
		// The declare itself still landed — an omitted name withholds nothing else.
		expect((await requireVariant(id, "a")).contentUpdatedAt).toBe(WM);
	});

	test("an EXPLICIT null or an emptied name sub-field CLEARS the cache — a statement, not an absence", async () => {
		const id = pid("prod-clearname");
		for (const key of ["a", "b", "c"]) await seedVariant(id, key, "Named");

		await afterSave(
			productContent(id, {}, TITLE, {
				variants: [
					{ key: "a", name: null },
					{ key: "b", name: "" },
					{ key: "c", name: "   " },
				],
			}),
		);

		// `undefined` PRESERVES and `null` CLEARS — two different facts. `""` is not
		// a name, so an emptied sub-field is applied as the explicit clear it means
		// rather than stored verbatim. The editor cannot reach this branch (the name
		// sub-field is `required`), but an import, a CLI or an API write can, and
		// those must be able to unname a size honestly.
		for (const key of ["a", "b", "c"]) {
			expect((await requireVariant(id, key)).title).toBeNull();
		}
	});

	test("an over-long or non-string name OMITS itself (the stored name is kept) and never blocks the size's declare", async () => {
		const id = pid("prod-badname");
		await seedVariant(id, "long", "Kept");
		await seedVariant(id, "numeric", "Also kept");

		await afterSave(
			productContent(id, {}, TITLE, {
				variants: [
					{ key: "long", name: "L".repeat(501) },
					{ key: "numeric", name: 42 },
					{ key: "ok", name: "Fine" },
				],
			}),
		);

		// Omitted, NOT null: a null would erase a good stored name over a content
		// problem the merchant can still fix.
		expect((await requireVariant(id, "long")).title).toBe("Kept");
		expect((await requireVariant(id, "numeric")).title).toBe("Also kept");
		expect((await requireVariant(id, "ok")).title).toBe("Fine");
		// All three are DECLARED — the name problem never withholds the size, which
		// would hide a sellable unit from the operator who would fix it.
		expect(await variantKeys(id)).toEqual(["long", "numeric", "ok"]);
		for (const key of ["long", "numeric", "ok"]) {
			expect((await requireVariant(id, key)).orphanedAt).toBeNull();
		}
	});

	test("a row with NO USABLE KEY declares nothing, and never blocks its siblings", async () => {
		const id = pid("prod-badkey");

		await afterSave(
			productContent(id, {}, TITLE, {
				variants: [{ key: "  ", name: "Blank" }, { name: "Keyless" }, "not-a-row", VARIANTS[0]],
			}),
		);

		// A key is the variant's identity; a row that cannot be addressed could never
		// be priced, re-declared or orphaned again, so it is skipped and logged
		// rather than minted under an invented key.
		expect(await variantKeys(id)).toEqual(["small"]);
	});

	test("the key is TRIMMED, so a stray keystroke cannot fork a size into two", async () => {
		const id = pid("prod-trimkey");
		await seedVariant(id, "small", "Small");

		await afterSave(
			productContent(id, {}, TITLE, { variants: [{ key: "  small  ", name: "Small" }] }),
		);

		// The normalised key addresses the SAME row the untrimmed one would have
		// orphaned. Without this, saving a document whose key gained a trailing space
		// would orphan the live size and declare a new, unpriced one beside it.
		expect(await variantKeys(id)).toEqual(["small"]);
		expect((await requireVariant(id, "small")).orphanedAt).toBeNull();
	});

	test("A REUSED KEY IS DECLARED ONCE — the first row wins, deterministically", async () => {
		const id = pid("prod-dupe");

		await afterSave(
			productContent(id, {}, TITLE, {
				variants: [
					{ key: "small", name: "Small" },
					{ key: "small", name: "Also small" },
				],
			}),
		);

		// THE RULE, PINNED. The CMS has no uniqueness constraint to put on a repeater
		// sub-field, so two rows can claim one key. They describe ONE sellable unit,
		// twice, with two names, and nothing in the document says which is meant.
		// Declaring both would make the stored name depend on ordering; declaring
		// neither would orphan a live size over a typo. First row wins, and it is
		// logged.
		expect(await variantKeys(id)).toEqual(["small"]);
		expect((await requireVariant(id, "small")).title).toBe("Small");
	});

	// -- the three branches that decide whether a size lives or dies ----------
	// The drop phase is the only destructive half of this channel, and three
	// documents reach it looking superficially alike: a repeater that is absent,
	// one that is present and empty, and one that is present with rows none of
	// which parse. They must resolve differently, and only the first of them was
	// pinned by the inert-path test above.

	test("`variants: []` orphans every live size — the merchant deleted the last row", async () => {
		const id = pid("prod-empty");
		await seedVariant(id, "small", "Small");
		await seedVariant(id, "large", "Large");

		await afterSave(productContent(id, {}, TITLE, { variants: [] }));

		// A present, empty list is the merchant's own statement that this product
		// sells no sizes any more — a DIFFERENT fact from a document that never
		// declared the field, which is why `readVariantRows` distinguishes them.
		// Deactivation, never deletion: both rows are retained.
		expect(await variantKeys(id)).toEqual(["large", "small"]);
		expect((await requireVariant(id, "small")).orphanedAt).not.toBeNull();
		expect((await requireVariant(id, "large")).orphanedAt).not.toBeNull();
	});

	test("PRESENT WITH ROWS THAT ALL FAIL TO PARSE drops NOTHING — a bad import must never retire a range", async () => {
		const id = pid("prod-allbad");
		await seedVariant(id, "small", "Small");
		await seedVariant(id, "large", "Large");
		productCalls.reset();

		await afterSave(
			productContent(id, {}, TITLE, {
				// Every row malformed: a blank key, a keyless row, a non-object.
				variants: [{ key: "   ", name: "Blank" }, { name: "Keyless" }, "not-a-row"],
			}),
		);

		// THE ASYMMETRY THAT MATTERS. "Every row is malformed" and "there are no
		// rows" both yield an empty declared set, but they are not the same claim:
		// the first is a content problem — a renamed sub-field, a broken import — and
		// reading it as the second would orphan the product's entire range, silently,
		// on a document the merchant believes still lists every size.
		expect((await requireVariant(id, "small")).orphanedAt).toBeNull();
		expect((await requireVariant(id, "large")).orphanedAt).toBeNull();
		expect(await variantKeys(id)).toEqual(["large", "small"]);
		// Not even the drop-set read is taken: there is nothing it could be used for.
		expect(productCalls.gets).toEqual([]);
		// The product's own title sync is untouched by any of it.
		expect((await requireDoc(id)).title).toBe(TITLE);
	});

	test("a `variants` member that is not a list declares nothing and drops nothing", async () => {
		const id = pid("prod-notalist");
		await seedVariant(id, "small", "Small");
		productCalls.reset();

		await afterSave(productContent(id, {}, TITLE, { variants: { small: "Small" } }));

		// Same reasoning as the all-malformed case: a value this sync cannot read is
		// not evidence that a size was removed.
		expect(await variantKeys(id)).toEqual(["small"]);
		expect((await requireVariant(id, "small")).orphanedAt).toBeNull();
		expect((await requireVariant(id, "small")).contentUpdatedAt).toBe(SEEDED_WM); // no declare either.
		expect(productCalls.gets).toEqual([]);
	});

	test("NO PARSEABLE WATERMARK ⇒ the whole variant sync is skipped, declares included", async () => {
		const id = pid("prod-nowm");
		await seedVariant(id, "medium", "Medium");
		productCalls.reset();

		await afterSave(productContent(id, { updatedAt: "not-a-date" }, TITLE, { variants: VARIANTS }));

		// The orphan transition REQUIRES a watermark, so half this channel cannot run
		// at all. Running the other half alone would declare sizes while being unable
		// to retire any — a divergence that persists until the next save — so both
		// halves skip together, and the document syncs no variant despite declaring
		// two.
		expect(await variantKeys(id)).toEqual(["medium"]);
		expect((await requireVariant(id, "medium")).orphanedAt).toBeNull();
		expect(productCalls.gets).toEqual([]);
		// The product row is still upserted — the title cache tolerates a missing
		// watermark, presence does not.
		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.contentUpdatedAt).toBeNull();
	});

	test("an ALREADY-ORPHANED row is never re-dropped", async () => {
		const id = pid("prod-orphaned");
		await seedOrphanedVariant(id, "gone", "Gone");
		await seedVariant(id, "medium", "Medium");
		const before = await requireVariant(id, "gone");

		await afterSave(productContent(id, {}, TITLE, { variants: VARIANTS }));

		// "medium" is the size this save actually dropped. "gone" was already an
		// orphan, is absent from the live read the drop set is computed from, and
		// comes back untouched — not merely un-re-orphaned but unwritten, which is
		// what keeps a redelivery from churning `updatedAt` on rows nothing changed.
		expect((await requireVariant(id, "medium")).orphanedAt).not.toBeNull();
		const gone = await requireVariant(id, "gone");
		expect(gone.orphanedAt).toBe(before.orphanedAt);
		expect(gone.idempotencyKey).toBe(before.idempotencyKey);
		expect(gone.updatedAt).toBe(before.updatedAt);
	});

	test("PUBLISH ATOMICITY holds for variants too: a pending-draft save writes nothing at all", async () => {
		const id = pid("prod-draftv");

		await afterSave(
			productContent(
				id,
				{ status: "published", liveRevisionId: "rev-live", draftRevisionId: "rev-draft" },
				TITLE,
				{ variants: VARIANTS },
			),
		);

		// A draft's repeater must not orphan a size the published document still
		// sells, nor put a draft rename on the label a picker renders. The whole sync
		// — product and variants alike — defers to publish, and the guard sits ahead
		// of every store call, so not one operation is spent.
		expect(await readDoc(id)).toBeNull();
		expect(productCalls.calls).toEqual([]);
	});

	test("content:afterPublish carries the repeater too — publish is when a deferred draft's sizes go live", async () => {
		const id = pid("prod-pubv");
		await seedVariant(id, "medium", "Medium");

		await afterPublish(productContent(id, { status: "published" }, TITLE, { variants: VARIANTS }));

		expect(await variantKeys(id)).toEqual(["large", "medium", "small"]);
		expect((await requireVariant(id, "small")).title).toBe("Small");
		expect((await requireVariant(id, "medium")).orphanedAt).not.toBeNull();
		// The variant sync runs AFTER the activate and can never affect the publish
		// gate — the product is live regardless of what the repeater did. The other
		// half of that claim (a FAILING variant sync still leaves the product synced)
		// is the next case.
		expect((await requireDoc(id)).active).toBe(true);
	});

	test("a variant sync that fails MIDWAY never throws into the CMS save path, and never withholds the product's own sync", async () => {
		const id = pid("prod-failv");
		await seedVariant(id, "medium", "Medium");
		productCalls.reset();

		// The fault lands on the drop-set read — the one `get` on this path — so the
		// declares have already committed and the orphan phase never runs. That is
		// the realistic partial failure: the CMS's statement is half-applied.
		productCalls.failOn = "get";
		const outcome = await afterSave(
			productContent(id, { status: "published" }, TITLE, { variants: VARIANTS }),
		);
		productCalls.failOn = null;

		// Fire-and-forget, exactly like the product title's channel: logged, never
		// thrown, and lost until the next save (there is still no reconcile job).
		expect(outcome).toEqual({ result: null });
		const doc = await requireDoc(id);
		expect(doc.title).toBe(TITLE);
		expect(doc.active).toBe(true);
		// Half-applied, honestly: the declares landed, the drop did not. Re-running
		// the save repairs it, because every call on this channel is idempotent under
		// its key and ordered by the watermark.
		expect((await requireVariant(id, "small")).orphanedAt).toBeNull();
		expect((await requireVariant(id, "medium")).orphanedAt).toBeNull();
	});

	test("a repeater on a NON-PRODUCTS collection is ignored, like everything else on that path", async () => {
		const id = pid("page-v");

		await afterSave(productContent(id, {}, TITLE, { variants: VARIANTS }), "pages");

		expect(await readDoc(id)).toBeNull();
		expect(productCalls.calls).toEqual([]);
	});
});
