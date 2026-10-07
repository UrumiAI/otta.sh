/**
 * The two seams of this tier on **D1**, driven from the forbidden side.
 *
 * Both of them heal on a READ or a REPLAY that writes — the gate's pointer write-back
 * and the settings completion — so both are paths whose SQL is planned by the runtime
 * Otta ships on. That is why they are pinned here as well as on the Node dialects: the
 * healing read is an indexed query and a pinned compare-and-set, and a tier that only
 * verified them on better-sqlite3 would be verifying a different planner.
 *
 * miniflare runs the file in a single `workerd` isolate on one thread, so nothing here
 * races; these are crash seams, which are about ORDERING and residue rather than about
 * concurrency.
 */
import { idempotencyKey, orderId, sku } from "@otta-sh/domain";
import { expect, test } from "vitest";
import {
	ENTITLEMENT_LOOKUPS_COLLECTION,
	entitlementLookupId,
	isSettingsMutationSupersededError,
	SETTINGS_COLLECTION,
	SETTINGS_DOC_ID,
	type EntitlementLookupDoc,
	type SettingsDoc,
} from "../../src/index.js";
import {
	failCall,
	InjectedCrashError,
	isClaimWrite,
	isUpdateWrite,
	withCollection,
} from "../helpers/fault-injection.js";
import { MISC_LAYOUT } from "../misc-collections.js";
import { makeMiscHarness, type MiscHarness } from "../misc-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(MISC_LAYOUT);

const SKU = sku("DIG-1");
const BUYER = "Buyer@Example.com";

const GRANT = {
	orderId: orderId("ord-1"),
	productId: null,
	sku: SKU,
	buyerRef: BUYER,
	source: "order_paid",
	grantIdempotencyKey: idempotencyKey("g1"),
} as const;

const healthy = (): MiscHarness => makeMiscHarness(bound.storage);

test("a grant with no scope pointer is still authorized, and the gate writes the pointer back", async () => {
	const live = healthy();
	const failing = failCall(
		bound.collection<EntitlementLookupDoc>(ENTITLEMENT_LOOKUPS_COLLECTION),
		isClaimWrite,
		{ mode: "instead" },
	);
	const crashed = makeMiscHarness(bound.storage, {
		storageForStore: withCollection(
			bound.storage,
			ENTITLEMENT_LOOKUPS_COLLECTION,
			failing.collection,
		),
		clock: live.clock,
		idPrefix: "crashed-",
	});
	await expect(crashed.entitlementStore.grant(GRANT)).rejects.toBeInstanceOf(InjectedCrashError);
	expect(await live.lookups.count()).toBe(0);

	// The healing read: an indexed query planned by D1, then a pointer write.
	expect(await live.entitlementStore.check({ buyerRef: BUYER, sku: SKU })).toBe(true);
	expect(
		(await live.lookups.get(entitlementLookupId("buyer", "buyer@example.com", "DIG-1")))?.grantKey,
	).toBe("g1");

	// And the replay completes the other scope rather than granting again.
	const replay = await live.entitlementStore.grant(GRANT);
	expect(replay.id).toMatch(/^crashed-/);
	expect(await live.grants.count()).toBe(1);
	expect(await live.lookups.count()).toBe(2);
});

test("a crashed settings mutation never clobbers a newer update and is never double-applied", async () => {
	const live = healthy();
	await live.settingsStore.update(
		{ holdTtlMinutes: 20, lowStockThreshold: 7 },
		idempotencyKey("s0"),
	);
	const failing = failCall(bound.collection<SettingsDoc>(SETTINGS_COLLECTION), isUpdateWrite, {
		mode: "instead",
	});
	const crashed = makeMiscHarness(bound.storage, {
		storageForStore: withCollection(bound.storage, SETTINGS_COLLECTION, failing.collection),
		clock: live.clock,
		idPrefix: "crashed-",
	});
	await expect(
		crashed.settingsStore.update({ holdTtlMinutes: 30 }, idempotencyKey("s1")),
	).rejects.toBeInstanceOf(InjectedCrashError);
	// Decided, not landed: the intent and the revision it was decided against are
	// recorded, and no result is.
	expect((await live.mutations.get("s1"))?.patch).toEqual({ holdTtlMinutes: 30 });
	expect((await live.mutations.get("s1"))?.result).toBeNull();
	expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 20, lowStockThreshold: 7 });

	// A newer key moves the SAME field while s1's decision is unlanded …
	await live.settingsStore.update({ holdTtlMinutes: 99 }, idempotencyKey("s2"));
	const before = await live.settings.getVersioned(SETTINGS_DOC_ID);

	// … so s1's completion is refused rather than merged over a state it was never
	// computed from, on the tier that plans the write.
	const failure = await live.settingsStore
		.update({ holdTtlMinutes: 30 }, idempotencyKey("s1"))
		.then(
			() => undefined,
			(err: unknown) => err,
		);
	expect(isSettingsMutationSupersededError(failure), String(failure)).toBe(true);
	expect(await live.settingsStore.get()).toEqual({ holdTtlMinutes: 99, lowStockThreshold: 7 });
	// Nothing was written: the revision is the proof, not the value.
	expect((await live.settings.getVersioned(SETTINGS_DOC_ID))?.revision).toBe(before?.revision);
	expect((await live.mutations.get("s1"))?.result).toBeNull();
});
