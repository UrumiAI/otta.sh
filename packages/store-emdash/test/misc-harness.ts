/**
 * The wiring the entitlement, payment-event, settings and order-note suites share:
 * real stores over real plugin-storage repositories, plus the test-surface hooks the
 * domain's harness types ask for.
 *
 * All four share ONE clock, because that is how the adapters are wired in production
 * and because a seam case that advances time has to move every store's idea of "now"
 * together.
 *
 * Nothing here seeds a document behind a store's back: every fixture goes through the
 * store. The ONE write that does not is {@link MiscHarness.revoke}, and it is not a
 * fixture — the `EntitlementStore` port has no revoke method at all, so the domain's
 * contract defines the hook as "the adapter's UPDATE / fake helper", and the SQL
 * harness implements it as a raw `UPDATE entitlements SET state = 'revoked'`. This is
 * that statement, spelled as a compare-and-set over the declared `orderId` index. It
 * is deliberately NOT a method on the production store: a revocation path with no
 * caller belongs on the port when one arrives, not in an adapter as test surface.
 */
import type {
	EntitlementStoreHarness,
	OrderNotesStoreHarness,
	SettingsStoreHarness,
} from "@otta-sh/domain/testing";
import { CountingIdGen, FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	EmdashEntitlementStore,
	EmdashOrderNotesStore,
	EmdashPaymentEventStore,
	EmdashSettingsStore,
	ENTITLEMENT_LOOKUPS_COLLECTION,
	ENTITLEMENTS_COLLECTION,
	ORDER_NOTES_COLLECTION,
	PAYMENT_ANOMALIES_COLLECTION,
	PAYMENT_EVENTS_COLLECTION,
	SETTINGS_COLLECTION,
	SETTINGS_MUTATIONS_COLLECTION,
	type StoredEntitlementDoc,
	type EntitlementLookupDoc,
	type OrderNoteDoc,
	type PaymentAnomalyDoc,
	type PaymentEventDoc,
	type SettingsDoc,
	type SettingsMutationDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";

/** The epoch every suite in this tier starts from. */
export const MISC_EPOCH = new Date("2026-07-10T00:00:00.000Z");

/** One page of the revoke helper's scan. The host clamps `limit` at 100. */
const REVOKE_PAGE_SIZE = 100;

export interface MiscHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Wrap the storage the STORES write through (fault injection). */
	storageForStore?: StorageAccess;
	/** Reuse another harness's clock, so a fault-injected twin shares its time. */
	clock?: FixedClock;
	/** Page ceiling for one order's note list. */
	maxNotePages?: number;
	/**
	 * Prefix the ids this harness mints, so a second harness over the same storage
	 * has its own id space — which is what a second PROCESS would have, and what a
	 * crash seam needs if its replayer is not to collide with the crashed call's ids.
	 */
	idPrefix?: string;
}

/** Everything the four stores expose to a suite. */
export interface MiscHarness {
	readonly clock: FixedClock;
	readonly entitlementStore: EmdashEntitlementStore;
	readonly paymentEventStore: EmdashPaymentEventStore;
	readonly settingsStore: EmdashSettingsStore;
	readonly orderNotesStore: EmdashOrderNotesStore;
	/** The documents, for the assertions the ports cannot express. */
	readonly grants: StorageCollection<StoredEntitlementDoc>;
	readonly lookups: StorageCollection<EntitlementLookupDoc>;
	readonly events: StorageCollection<PaymentEventDoc>;
	readonly anomalies: StorageCollection<PaymentAnomalyDoc>;
	readonly settings: StorageCollection<SettingsDoc>;
	readonly mutations: StorageCollection<SettingsMutationDoc>;
	readonly notes: StorageCollection<OrderNoteDoc>;
	/** The contract's revoke hook — see this file's docblock. */
	revoke(orderId: string): Promise<void>;
	/** Every recorded anomaly, in no particular order. */
	listAnomalies(): Promise<PaymentAnomalyDoc[]>;
	/** Advance the one shared clock. */
	advance(ms: number): void;
	/** The shared clock's current instant (ISO-8601) — what the adapters see. */
	now(): string;
}

/** Build a harness over an already-bound `StorageAccess`. */
export function makeMiscHarness(
	storage: StorageAccess,
	options: MiscHarnessOptions = {},
): MiscHarness {
	const clock = options.clock ?? new FixedClock(new Date(MISC_EPOCH.getTime()));
	const prefix = options.idPrefix ?? "";
	const written = options.storageForStore ?? storage;
	const shared = {
		storage: written,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
	};
	const entitlementStore = new EmdashEntitlementStore({
		...shared,
		idGen: new CountingIdGen(`${prefix}ent`),
	});
	const paymentEventStore = new EmdashPaymentEventStore({
		storage: written,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
	});
	const settingsStore = new EmdashSettingsStore(shared);
	const orderNotesStore = new EmdashOrderNotesStore({
		...shared,
		idGen: new CountingIdGen(`${prefix}note`),
		maxNotePages: options.maxNotePages,
	});

	// The RAW collections, deliberately unwrapped by any fault injection: an
	// observation is not a write, and a test that injected a fault into its own
	// assertions would be reading a state the stores never produce.
	const grants = collectionOf<StoredEntitlementDoc>(storage, ENTITLEMENTS_COLLECTION);
	const lookups = collectionOf<EntitlementLookupDoc>(storage, ENTITLEMENT_LOOKUPS_COLLECTION);
	const events = collectionOf<PaymentEventDoc>(storage, PAYMENT_EVENTS_COLLECTION);
	const anomalies = collectionOf<PaymentAnomalyDoc>(storage, PAYMENT_ANOMALIES_COLLECTION);
	const settings = collectionOf<SettingsDoc>(storage, SETTINGS_COLLECTION);
	const mutations = collectionOf<SettingsMutationDoc>(storage, SETTINGS_MUTATIONS_COLLECTION);
	const notes = collectionOf<OrderNoteDoc>(storage, ORDER_NOTES_COLLECTION);

	return {
		clock,
		entitlementStore,
		paymentEventStore,
		settingsStore,
		orderNotesStore,
		grants,
		lookups,
		events,
		anomalies,
		settings,
		mutations,
		notes,
		advance: (ms) => {
			clock.advance(ms);
		},
		now: () => clock.now().toISOString(),
		async revoke(orderId) {
			let cursor: string | undefined;
			do {
				const page = await grants.query({
					where: { orderId },
					limit: REVOKE_PAGE_SIZE,
					cursor,
				});
				for (const { id } of page.items) {
					const current = await grants.getVersioned(id);
					if (current === null) continue;
					await grants.compareAndSet(id, current.revision, {
						...current.value,
						state: "revoked",
					});
				}
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor !== undefined);
		},
		async listAnomalies() {
			const found: PaymentAnomalyDoc[] = [];
			let cursor: string | undefined;
			do {
				const page = await anomalies.query({ limit: REVOKE_PAGE_SIZE, cursor });
				for (const { data } of page.items) found.push(data);
				cursor = page.hasMore ? page.cursor : undefined;
			} while (cursor !== undefined);
			return found;
		},
	};
}

/** The `entitlementStoreContract` view of the bag. */
export function makeEntitlementHarness(
	storage: StorageAccess,
	options: MiscHarnessOptions = {},
): EntitlementStoreHarness {
	const harness = makeMiscHarness(storage, options);
	return {
		store: harness.entitlementStore,
		revoke: (orderId) => harness.revoke(orderId),
	};
}

/** The `settingsStoreContract` view of the bag. */
export function makeSettingsHarness(
	storage: StorageAccess,
	options: MiscHarnessOptions = {},
): SettingsStoreHarness {
	return { store: makeMiscHarness(storage, options).settingsStore };
}

/** The `orderNotesStoreContract` view of the bag, with its clock hook. */
export function makeOrderNotesHarness(
	storage: StorageAccess,
	options: MiscHarnessOptions = {},
): OrderNotesStoreHarness {
	const harness = makeMiscHarness(storage, options);
	return {
		store: harness.orderNotesStore,
		tick: (ms) => {
			harness.advance(ms);
		},
	};
}
