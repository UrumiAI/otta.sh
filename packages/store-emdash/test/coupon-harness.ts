/**
 * The wiring every coupon suite shares: a real `EmdashCouponStore` over real
 * plugin-storage repositories, plus the one test-surface hook the domain's
 * `CouponStoreHarness` asks for.
 *
 * `seedCoupon` writes the SAME two documents `create()` writes — the coupon and its
 * code claim — never a parallel fixture. A seed that skipped the claim would leave a
 * coupon the admin list's code search (and `findByCode`) could not reach, so the
 * list cases would be asserting against a state the store never produces.
 */
import { cents, currency } from "@otta-sh/domain";
import type { CouponStoreHarness, SeedCouponSummaryRow } from "@otta-sh/domain/testing";
import { FixedClock } from "@otta-sh/domain/testing";
import {
	collectionOf,
	COUPON_CODES_COLLECTION,
	COUPON_CUSTOMER_CAPS_COLLECTION,
	COUPON_REDEMPTIONS_COLLECTION,
	COUPONS_COLLECTION,
	EmdashCouponStore,
	foldCouponCode,
	uuidIdGen,
	type CouponCodeDoc,
	type CouponCustomerCapDoc,
	type CouponDoc,
	type CouponRedemptionDoc,
	type StorageAccess,
	type StorageCollection,
} from "../src/index.js";

/** The epoch every coupon suite starts from. */
export const COUPON_EPOCH = new Date("2026-07-10T00:00:00.000Z");

export interface CouponHarness extends CouponStoreHarness {
	readonly clock: FixedClock;
	readonly store: EmdashCouponStore;
	/** The documents, for the assertions the port cannot express. */
	readonly coupons: StorageCollection<CouponDoc>;
	readonly codes: StorageCollection<CouponCodeDoc>;
	readonly redemptions: StorageCollection<CouponRedemptionDoc>;
	readonly caps: StorageCollection<CouponCustomerCapDoc>;
	/** One coupon's counter, or null when it has no document. */
	usesOf(couponId: string): Promise<number | null>;
	/** How many keys hold a per-customer slot, or null when there is no counter. */
	slotsOf(couponId: string, customerId: string): Promise<readonly string[] | null>;
}

export interface CouponHarnessOptions {
	/** Override the compare-and-set ceiling (the race suites measure the depth). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Page ceiling for the bounded scans. */
	maxListPages?: number;
	/** Wrap the storage the STORE writes through (fault injection). */
	storageForStore?: StorageAccess;
	/** Reuse another harness's clock, so a fault-injected twin shares its time. */
	clock?: FixedClock;
}

/** Build a coupon harness over an already-bound `StorageAccess`. */
export function makeCouponHarness(
	storage: StorageAccess,
	options: CouponHarnessOptions = {},
): CouponHarness {
	const clock = options.clock ?? new FixedClock(new Date(COUPON_EPOCH.getTime()));
	const store = new EmdashCouponStore({
		storage: options.storageForStore ?? storage,
		idGen: uuidIdGen,
		clock,
		maxCasAttempts: options.maxCasAttempts,
		onCasAttempts: options.onCasAttempts,
		maxListPages: options.maxListPages,
	});
	// The RAW collections, deliberately unwrapped by any fault injection: a seed is a
	// fixture, and a test that injected a fault into its own setup would be asserting
	// against a state the store never produces.
	const coupons = collectionOf<CouponDoc>(storage, COUPONS_COLLECTION);
	const codes = collectionOf<CouponCodeDoc>(storage, COUPON_CODES_COLLECTION);
	const redemptions = collectionOf<CouponRedemptionDoc>(storage, COUPON_REDEMPTIONS_COLLECTION);
	const caps = collectionOf<CouponCustomerCapDoc>(storage, COUPON_CUSTOMER_CAPS_COLLECTION);

	return {
		clock,
		store,
		coupons,
		codes,
		redemptions,
		caps,
		async usesOf(couponId) {
			const doc = await coupons.get(couponId);
			return doc === null ? null : doc.usesCount;
		},
		async slotsOf(couponId, customerId) {
			const doc = await caps.get(`${couponId}:${customerId}`);
			return doc === null ? null : doc.keys;
		},
		async seedCoupon(row: SeedCouponSummaryRow) {
			const codeKey = foldCouponCode(row.code);
			const doc: CouponDoc = {
				couponId: row.id,
				code: row.code,
				codeKey,
				type: row.type ?? "fixed_amount",
				amountCents:
					row.amountCents === undefined || row.amountCents === null ? null : cents(row.amountCents),
				rateBps: row.rateBps ?? null,
				capCents: row.capCents === undefined || row.capCents === null ? null : cents(row.capCents),
				currency:
					row.currency === undefined || row.currency === null ? null : currency(row.currency),
				minSubtotalCents:
					row.minSubtotalCents === undefined || row.minSubtotalCents === null
						? null
						: cents(row.minSubtotalCents),
				startsAt: row.startsAt ?? null,
				expiresAt: row.expiresAt ?? null,
				maxUses: row.maxUses ?? null,
				maxUsesPerCustomer: row.maxUsesPerCustomer ?? null,
				usesCount: row.usesCount ?? 0,
				lastRedeemedKey: null,
				createdAt: row.createdAt,
			};
			await coupons.put(row.id, doc);
			// A seeded coupon still HOLDS its code: the claim document is how every read
			// by code reaches it, so a fixture that skipped it would hide the row from
			// `findByCode` and from the list's search.
			await codes.put(codeKey, {
				codeKey,
				code: row.code,
				couponId: row.id,
				claimedAt: row.createdAt,
			});
		},
	};
}
