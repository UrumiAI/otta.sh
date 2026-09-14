/**
 * The seams of this tier, driven from the forbidden side.
 *
 * Every case injects a crash into a REAL storage collection — the write either lands
 * and the continuation is lost (`mode: "after"`), or never happens at all
 * (`mode: "instead"`) — reads the residue back so the state being healed is asserted
 * rather than assumed, and then proves what a later caller sees. Nothing is faked:
 * the document that lands is the one the host would have written.
 *
 * **Both modes are driven, and they ask different questions.** `"instead"` asks what a
 * missing write leaves behind; `"after"` asks what a caller who believed it FAILED is
 * told when it tries again over a write that really landed. The second is the one a
 * retrying webhook, a double-clicked Save and a resubmitted note all take, and an
 * adapter can pass every `"instead"` case while answering it wrongly.
 *
 * Two of the four stores have a multi-document step:
 *
 * - **A grant and its two scope pointers.** The grant is written first and the
 *   pointers are derived from it, so the residue is a grant no pointer names. It
 *   under-serves nothing: the pointer is a cache, and the next `check` on that scope
 *   answers from the declared index and writes the pointer back.
 * - **A settings mutation claim, the settings write, and the result stamp.** The claim
 *   carries the patch and the settings revision it was decided against; the result is
 *   stamped after the write lands. So the residue of either gap is a mutation that was
 *   DECIDED and not recorded, and the next caller with that key completes it — but only
 *   AT that revision. Past it the completion is refused as superseded, because merging
 *   cannot revert a field the patch OMITS and says nothing about the fields it names.
 *
 * `order_notes` and `payment_events` write one document per call, so they have no such
 * gap. Their cases are the other half of that claim: a lost write leaves NOTHING, and
 * a landed one answers the retry correctly.
 */
import { idempotencyKey, orderId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	ENTITLEMENT_LOOKUPS_COLLECTION,
	entitlementLookupId,
	isSettingsMutationSupersededError,
	ORDER_NOTES_COLLECTION,
	PAYMENT_EVENTS_COLLECTION,
	SETTINGS_COLLECTION,
	SETTINGS_DOC_ID,
	SETTINGS_MUTATIONS_COLLECTION,
	SettingsMutationSupersededError,
	type EntitlementLookupDoc,
	type OrderNoteDoc,
	type PaymentEventDoc,
	type SettingsDoc,
	type SettingsMutationDoc,
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
	type CallMatcher,
	type FailMode,
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

/** The seeded settings every settings seam starts from. */
const SEEDED = { holdTtlMinutes: 20, lowStockThreshold: 7 };

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

	/** A harness that crashes on one write of one collection, sharing `twin`'s clock. */
	function crashingOn<T>(
		twin: MiscHarness,
		collection: string,
		match: CallMatcher,
		mode: FailMode,
	): MiscHarness {
		const failing = failCall<T>(bound.collection<T>(collection), match, { mode });
		return crashing(withCollection(bound.storage, collection, failing.collection), twin);
	}

	// -- the grant and its scope pointers --------------------------------------

	test("a crash between recording a grant and pointing its scopes leaves the grant authoritative", async () => {
		const live = healthy();
		const crashed = crashingOn<EntitlementLookupDoc>(
			live,
			ENTITLEMENT_LOOKUPS_COLLECTION,
			isClaimWrite,
			"instead",
		);
		await expect(crashed.entitlementStore.grant(GRANT)).rejects.toBeInstanceOf(InjectedCrashError);

		// The residue, read back before anything heals it: the grant is durable and no
		// scope points at it.
		expect((await live.grants.get("g1"))?.state).toBe("active");
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
		const crashed = crashingOn<EntitlementLookupDoc>(
			live,
			ENTITLEMENT_LOOKUPS_COLLECTION,
			nthCall(2, isClaimWrite),
			"instead",
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
		const crashed = crashingOn<EntitlementLookupDoc>(
			live,
			ENTITLEMENT_LOOKUPS_COLLECTION,
			isClaimWrite,
			"instead",
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

	test("a grant whose own write landed before the crash is not granted twice", async () => {
		// `mode: "after"`: the grant document really lands and the caller sees a failure,
		// which is the state a retrying webhook meets.
		const live = healthy();
		const crashed = crashingOn<EntitlementLookupDoc>(
			live,
			ENTITLEMENT_LOOKUPS_COLLECTION,
			isClaimWrite,
			"after",
		);
		await expect(crashed.entitlementStore.grant(GRANT)).rejects.toBeInstanceOf(InjectedCrashError);
		// One pointer landed with it, the second never ran.
		expect(await live.lookups.count()).toBe(1);

		const replay = await live.entitlementStore.grant(GRANT);
		expect(replay.id).toBe((await live.grants.get("g1"))?.entitlementId);
		expect(await live.grants.count()).toBe(1);
		expect(await live.lookups.count()).toBe(2);
	});

	// -- the settings claim, the write, and the result stamp --------------------

	test("a crash between the mutation claim and the settings write is completed by the replay", async () => {
		const live = healthy();
		await live.settingsStore.update(SEEDED, idempotencyKey("s0"));
		const crashed = crashingOn<SettingsDoc>(live, SETTINGS_COLLECTION, isUpdateWrite, "instead");
		await expect(
			crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(InjectedCrashError);

		// The residue: the INTENT is recorded and no result is, which is exactly what
		// "decided, not landed" looks like. Nothing has been applied.
		const claim = await live.mutations.get("s1");
		expect(claim?.patch).toEqual({ holdTtlMinutes: 30 });
		expect(claim?.result).toBeNull();
		expect(claim?.appliedAt).toBeNull();
		expect(await live.settingsStore.get()).toEqual(SEEDED);

		// The replay completes it: one merge over what is there now, one write, one
		// stamp — and the answer is the value that landed.
		const replay = await live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		expect(replay).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 7 });
		expect(await live.settingsStore.get()).toEqual(replay);
		expect((await live.mutations.get("s1"))?.result).toEqual(replay);
		expect(await live.mutations.count()).toBe(2);
	});

	test("an un-landed mutation overtaken by a newer update never clobbers it and is never double-applied", async () => {
		// The port forbids exactly this: "a stale replay arriving after a newer update
		// never clobbers it back". The claim records the settings revision it was DECIDED
		// against, and a caller that did not decide it may write only at that revision —
		// so once something else has moved the settings, the completion is refused rather
		// than re-merged over a state the patch was never computed from.
		const live = healthy();
		await live.settingsStore.update(SEEDED, idempotencyKey("s0"));
		const crashed = crashingOn<SettingsDoc>(live, SETTINGS_COLLECTION, isUpdateWrite, "instead");
		await expect(
			crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(InjectedCrashError);

		// A DIFFERENT key moves the SAME field forward while s1's decision is unlanded.
		await live.settingsStore.update({ holdTtlMinutes: 99 }, idempotencyKey("s2"));
		const before = await live.settings.getVersioned(SETTINGS_DOC_ID);

		const failure = await live.settingsStore
			.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"))
			.then(
				() => undefined,
				(err: unknown) => err,
			);
		expect(isSettingsMutationSupersededError(failure), String(failure)).toBe(true);
		if (isSettingsMutationSupersededError(failure)) {
			expect(failure.retryable).toBe(false);
			expect(failure.idempotencyKey).toBe("s1");
			expect(failure.decidedRevision).not.toBe(failure.currentRevision);
		}

		// s2's value stands, and NOTHING was written: the revision is the proof, not the
		// value — a write of the same value would move it.
		expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 99, lowStockThreshold: 7 });
		expect((await live.settings.getVersioned(SETTINGS_DOC_ID))?.revision).toBe(before?.revision);
		// And the claim is terminal: a further replay refuses the same way, so the patch
		// cannot be applied later either.
		await expect(
			live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(SettingsMutationSupersededError);
		expect((await live.mutations.get("s1"))?.result).toBeNull();
	});

	test("a settings write that landed before the crash is recorded by the replay, not applied twice", async () => {
		// `mode: "after"`: the settings document really moved and the caller saw a
		// failure, so the residue is an applied value with no recorded result.
		const live = healthy();
		await live.settingsStore.update(SEEDED, idempotencyKey("s0"));
		const crashed = crashingOn<SettingsDoc>(live, SETTINGS_COLLECTION, isUpdateWrite, "after");
		await expect(
			crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(InjectedCrashError);
		expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 7 });
		expect((await live.mutations.get("s1"))?.result).toBeNull();

		// The caller believed it failed. Its retry records the value that is already
		// there — re-merging an absolute patch over its own effect is the same value —
		// and answers with it.
		const before = await live.settings.getVersioned(SETTINGS_DOC_ID);
		const replay = await live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		expect(replay).toEqual({ holdTtlMinutes: 30, lowStockThreshold: 7 });
		expect(await live.settingsStore.get()).toEqual(replay);
		expect((await live.mutations.get("s1"))?.result).toEqual(replay);
		// Not applied twice: the merge changed nothing, so nothing was written.
		expect((await live.settings.getVersioned(SETTINGS_DOC_ID))?.revision).toBe(before?.revision);
	});

	test("a lost result stamp is completed by the next caller, and the value does not move", async () => {
		// The third window: the settings write landed and the stamp that records it did
		// not. The completion re-merges the patch over what is there — which is its own
		// effect, so the merge changes nothing — and a merge that changes nothing writes
		// nothing. The settings revision is what proves it: a write of an identical value
		// would still move it.
		const live = healthy();
		await live.settingsStore.update(SEEDED, idempotencyKey("s0"));
		const crashed = crashingOn<SettingsMutationDoc>(
			live,
			SETTINGS_MUTATIONS_COLLECTION,
			isUpdateWrite,
			"instead",
		);
		await expect(
			crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
		).rejects.toBeInstanceOf(InjectedCrashError);
		const applied = { holdTtlMinutes: 30, lowStockThreshold: 7 };
		expect(await live.settingsStore.get()).toEqual(applied);
		expect((await live.mutations.get("s1"))?.result).toBeNull();
		const before = await live.settings.getVersioned(SETTINGS_DOC_ID);

		const replay = await live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"));
		expect(replay).toEqual(applied);
		expect((await live.mutations.get("s1"))?.result).toEqual(applied);
		expect((await live.mutations.get("s1"))?.appliedRevision).toBeNull();
		expect((await live.settings.getVersioned(SETTINGS_DOC_ID))?.revision).toBe(before?.revision);

		// And the stamp is single-assignment: a third call moves neither document.
		const stamped = await live.mutations.getVersioned("s1");
		expect(await live.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"))).toEqual(
			applied,
		);
		expect((await live.mutations.getVersioned("s1"))?.revision).toBe(stamped?.revision);
		expect((await live.settings.getVersioned(SETTINGS_DOC_ID))?.revision).toBe(before?.revision);
	});

	// -- the two single-document stores ----------------------------------------

	test("a lost dedupe write records nothing, so the redelivery is a first delivery", async () => {
		const live = healthy();
		const crashed = crashingOn<PaymentEventDoc>(
			live,
			PAYMENT_EVENTS_COLLECTION,
			isClaimWrite,
			"instead",
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

	test("a dedupe row that landed before the crash makes the retry a redelivery", async () => {
		// `mode: "after"`: the audit row really landed and the caller saw a failure. Its
		// retry must be told `false` — and settlement does not short-circuit on `false`,
		// so the state-guarded settle steps are re-driven either way. Answering `true`
		// here would be the more dangerous lie: it would report a second first delivery
		// for a row already recorded.
		const live = healthy();
		const crashed = crashingOn<PaymentEventDoc>(
			live,
			PAYMENT_EVENTS_COLLECTION,
			isClaimWrite,
			"after",
		);
		await expect(
			crashed.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", live.now()),
		).rejects.toBeInstanceOf(InjectedCrashError);
		expect(await live.events.count()).toBe(1);

		expect(
			await live.paymentEventStore.dedupe("evt_1", orderId("ord-1"), "stripe", live.now()),
		).toBe(false);
		expect(await live.events.count()).toBe(1);
	});

	test("a lost append writes no note, and the retry appends exactly one", async () => {
		const live = healthy();
		const crashed = crashingOn<OrderNoteDoc>(live, ORDER_NOTES_COLLECTION, isClaimWrite, "instead");
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

	test("a note that landed before the crash is returned to the retry, not appended twice", async () => {
		// `mode: "after"`: the note really landed and the caller saw a failure — a
		// resubmitted form, which is the shape the idempotency key exists for.
		const live = healthy();
		const crashed = crashingOn<OrderNoteDoc>(live, ORDER_NOTES_COLLECTION, isClaimWrite, "after");
		const note = {
			orderId: orderId("ord-1"),
			author: "alice",
			body: "only once",
			idempotencyKey: idempotencyKey("note-key-1"),
		};
		await expect(crashed.orderNotesStore.append(note)).rejects.toBeInstanceOf(InjectedCrashError);
		expect(await live.notes.count()).toBe(1);
		const landed = await live.notes.get("note-key-1");

		const retried = await live.orderNotesStore.append(note);
		expect(retried.appended).toBe(false);
		expect(retried.note.id).toBe(landed?.noteId);
		expect(retried.note.body).toBe("only once");
		expect(await live.notes.count()).toBe(1);
	});
});
