/**
 * The seams of this tier, driven from the forbidden side.
 *
 * Every case injects a crash into a REAL storage collection — the write either lands
 * and the continuation is lost, or never happens at all — reads the residue back so
 * the state being healed is asserted rather than assumed, and then proves what a
 * later caller sees. Nothing is faked: the document that lands is the one the host
 * would have written.
 *
 * Only two of these four stores have a seam at all, because only two write more than
 * one document:
 *
 * - **A grant and its two scope pointers.** The grant is written first and the
 *   pointers are derived from it, so the residue is a grant no pointer names. It
 *   under-serves nothing: the pointer is a cache, and the next `check` on that scope
 *   answers from the declared index and writes the pointer back.
 * - **A settings mutation claim and the settings write.** The claim is written first
 *   and carries both the result and the revision it was computed against, so the
 *   residue is a decision that has not landed. The next replay of that key lands it —
 *   and, if a newer update has overtaken it in the meantime, does NOT.
 *
 * `order_notes` and `payment_events` write exactly one document each, so there is no
 * pair for a crash to land between. Their cases below are the other half of that
 * claim: a lost write leaves NOTHING, so the retry is a clean first attempt rather
 * than a repair.
 */
import { idempotencyKey, orderId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	ENTITLEMENT_LOOKUPS_COLLECTION,
	entitlementLookupId,
	ORDER_NOTES_COLLECTION,
	PAYMENT_EVENTS_COLLECTION,
	SETTINGS_COLLECTION,
	type EntitlementLookupDoc,
	type OrderNoteDoc,
	type PaymentEventDoc,
	type SettingsDoc,
	type StorageAccess,
} from "../src/index.js";
import { describeEachDialect } from "./describe-each-dialect.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	isUpdateWrite,
	nthCall,
	withCollection,
} from "./helpers/fault-injection.js";
import { MISC_LAYOUT } from "./misc-collections.js";
import { makeMiscHarness, type MiscHarness } from "./misc-harness.js";

const SKU = sku("DIG-1");
const BUYER = "Buyer@Example.com";
const ORDER_SCOPE = entitlementLookupId("order", "ord-1", "DIG-1");
const BUYER_SCOPE = entitlementLookupId("buyer", "buyer@example.com", "DIG-1");

/** The grant every entitlement seam below crashes in the middle of. */
const GRANT = {
	orderId: orderId("ord-1"),
	productId: null,
	sku: SKU,
	buyerRef: BUYER,
	source: "order_paid",
	grantIdempotencyKey: idempotencyKey("g1"),
} as const;

describeEachDialect("misc crash seams", (ctx) => {
	const bound = ctx.useStorage(MISC_LAYOUT);

	/** A harness whose STORES write through `storage`, sharing one clock with `twin`. */
	const crashing = (storage: StorageAccess, twin: MiscHarness): MiscHarness =>
		makeMiscHarness(bound.storage, {
			storageForStore: storage,
			clock: twin.clock,
			// Its own id space: the crashing caller is a different process, and a replayer
			// that minted the same ids would be adopting its own abandoned work by
			// accident rather than by the rule under test.
			idPrefix: "crashed-",
		});

	const healthy = (): MiscHarness => makeMiscHarness(bound.storage);

	// -- the grant and its scope pointers --------------------------------------

	test("a crash between recording a grant and pointing its scopes leaves the grant authoritative", async () => {
		const live = healthy();
		const failing = failCall(
			bound.collection<EntitlementLookupDoc>(ENTITLEMENT_LOOKUPS_COLLECTION),
			isClaimWrite,
			{ mode: "instead" },
		);
		const crashed = crashing(
			withCollection(bound.storage, ENTITLEMENT_LOOKUPS_COLLECTION, failing.collection),
			live,
		);
		await expect(crashed.entitlementStore.grant(GRANT)).rejects.toBeInstanceOf(InjectedCrashError);

		// The residue, read back before anything heals it: the grant is durable and no
		// scope points at it.
		const grantDoc = await live.grants.get("g1");
		expect(grantDoc?.state).toBe("active");
		expect(await live.lookups.count()).toBe(0);

		// Either scope's own read answers from the declared index, and writes the
		// pointer back as it goes.
		expect(await live.entitlementStore.check({ orderId: orderId("ord-1"), sku: SKU })).toBe(true);
		expect((await live.lookups.get(ORDER_SCOPE))?.grantKey).toBe("g1");
		expect(await live.entitlementStore.check({ buyerRef: BUYER, sku: SKU })).toBe(true);
		expect((await live.lookups.get(BUYER_SCOPE))?.grantKey).toBe("g1");
		expect(await live.lookups.count()).toBe(2);
	});

	test("a crash after the first scope pointer leaves the second healed by its own read", async () => {
		const live = healthy();
		const failing = failCall(
			bound.collection<EntitlementLookupDoc>(ENTITLEMENT_LOOKUPS_COLLECTION),
			nthCall(2, isClaimWrite),
			{ mode: "instead" },
		);
		const crashed = crashing(
			withCollection(bound.storage, ENTITLEMENT_LOOKUPS_COLLECTION, failing.collection),
			live,
		);
		await expect(crashed.entitlementStore.grant(GRANT)).rejects.toBeInstanceOf(InjectedCrashError);

		expect(await live.lookups.count()).toBe(1);
		expect((await live.lookups.get(ORDER_SCOPE))?.grantKey).toBe("g1");
		expect(await live.lookups.get(BUYER_SCOPE)).toBeNull();

		expect(await live.entitlementStore.check({ buyerRef: BUYER, sku: SKU })).toBe(true);
		expect((await live.lookups.get(BUYER_SCOPE))?.grantKey).toBe("g1");
	});

	test("a replayed grant completes the pointers a crash lost, and grants nothing new", async () => {
		const live = healthy();
		const failing = failCall(
			bound.collection<EntitlementLookupDoc>(ENTITLEMENT_LOOKUPS_COLLECTION),
			isClaimWrite,
			{ mode: "instead" },
		);
		const crashed = crashing(
			withCollection(bound.storage, ENTITLEMENT_LOOKUPS_COLLECTION, failing.collection),
			live,
		);
		await expect(crashed.entitlementStore.grant(GRANT)).rejects.toBeInstanceOf(InjectedCrashError);
		const recordedId = (await live.grants.get("g1"))?.entitlementId;

		// The replay is the other route to a healed pair — a webhook retry rather than a
		// delivery attempt — and it re-grants nothing: the entitlement id is the crashed
		// call's, from its own id space.
		const replay = await live.entitlementStore.grant(GRANT);
		expect(replay.id).toBe(recordedId);
		expect(replay.id).toMatch(/^crashed-/);
		expect(await live.grants.count()).toBe(1);
		expect(await live.lookups.count()).toBe(2);
	});

	// -- the settings mutation claim and the settings write ---------------------

	test("a crash between the mutation claim and the settings write is completed by the replay", async () => {
		const live = healthy();
		await live.settingsStore.update(
			{ holdTtlMinutes: 20, lowStockThreshold: 7 },
			idempotencyKey("s0"),
		);
		const failing = failCall(bound.collection<SettingsDoc>(SETTINGS_COLLECTION), isUpdateWrite, {
			mode: "instead",
		});
		const crashed = crashing(
			withCollection(bound.storage, SETTINGS_COLLECTION, failing.collection),
			live,
		);
		await expect(
			crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(InjectedCrashError);

		// The residue: the decision is recorded, with the revision it was computed
		// against, and nothing has been applied.
		const claim = await live.mutations.get("s1");
		expect(claim?.holdTtlMinutes).toBe(30);
		expect(claim?.lowStockThreshold).toBe(7);
		expect(claim?.baseRevision).not.toBeNull();
		expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 20, lowStockThreshold: 7 });

		// The replay lands it — one pinned compare-and-set, no re-merge.
		const replay = await live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		expect(replay).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 7 });
		expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 7 });
		expect(await live.mutations.count()).toBe(2);
	});

	test("a crashed mutation overtaken by a newer update never double-applies", async () => {
		const live = healthy();
		await live.settingsStore.update(
			{ holdTtlMinutes: 20, lowStockThreshold: 7 },
			idempotencyKey("s0"),
		);
		const failing = failCall(bound.collection<SettingsDoc>(SETTINGS_COLLECTION), isUpdateWrite, {
			mode: "instead",
		});
		const crashed = crashing(
			withCollection(bound.storage, SETTINGS_COLLECTION, failing.collection),
			live,
		);
		await expect(
			crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(InjectedCrashError);

		// A DIFFERENT key moves the settings forward while s1's decision is unlanded.
		await live.settingsStore.update({ holdTtlMinutes: 99 }, idempotencyKey("s2"));

		// Replaying s1 returns what it decided and leaves the newer value alone: the
		// completing write is pinned to a revision that has moved, so it applies nothing.
		const replay = await live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		expect(replay).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 7 });
		expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 99, lowStockThreshold: 7 });
	});

	// -- the two single-document stores ----------------------------------------

	test("a lost dedupe write records nothing, so the redelivery is a first delivery", async () => {
		const live = healthy();
		const failing = failCall(
			bound.collection<PaymentEventDoc>(PAYMENT_EVENTS_COLLECTION),
			isClaimWrite,
			{ mode: "instead" },
		);
		const crashed = crashing(
			withCollection(bound.storage, PAYMENT_EVENTS_COLLECTION, failing.collection),
			live,
		);
		await expect(
			crashed.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", live.now()),
		).rejects.toBeInstanceOf(InjectedCrashError);
		expect(await live.events.count()).toBe(0);

		// Nothing half-recorded means the gateway's retry is the FIRST delivery, which
		// is what re-drives the settle steps that crash also lost.
		expect(
			await live.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", live.now()),
		).toBe(true);
	});

	test("a lost append writes no note, and the retry appends exactly one", async () => {
		const live = healthy();
		const failing = failCall(bound.collection<OrderNoteDoc>(ORDER_NOTES_COLLECTION), isClaimWrite, {
			mode: "instead",
		});
		const crashed = crashing(
			withCollection(bound.storage, ORDER_NOTES_COLLECTION, failing.collection),
			live,
		);
		const note = {
			orderId: orderId("ord-1"),
			author: "alice",
			body: "only once",
			idempotencyKey: idempotencyKey("note-key-1"),
		};
		await expect(crashed.orderNotesStore.append(note)).rejects.toBeInstanceOf(InjectedCrashError);
		expect(await live.notes.count()).toBe(0);

		const retried = await live.orderNotesStore.append(note);
		expect(retried.appended).toBe(true);
		expect(await live.orderNotesStore.listForOrder(orderId("ord-1"))).toHaveLength(1);
	});
});
